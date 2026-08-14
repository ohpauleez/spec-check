/**
 * LLM adapter that interfaces with OpenCode by spawning subprocess invocations
 * for each verification phase and parsing structured JSON responses.
 *
 * Adapter layer — translates domain phase requests into OpenCode CLI calls.
 * Exports: OpencodePhase, OpencodeInvocation, invokeOpencode.
 */
import { lstat, stat } from "node:fs/promises";

import { PROMPT_ARG_MAX_BYTES } from "./opencode-limits.js";
import { runProcess, type ProcessResult } from "./process.js";
import { allocateOpencodeCallId, recordOpencodeAttempt } from "./telemetry.js";
import { postcondition } from "../domain/assert.js";
import { err, ok, type Result } from "../domain/result.js";
import { DEFAULT_TIMEOUT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS } from "../domain/timeout.js";

export { PROMPT_ARG_MAX_BYTES } from "./opencode-limits.js";

/**
 * First backoff delay between adapter retry attempts, in milliseconds.
 *
 * @remarks
 * The base exists so transient backend contention (the dominant cause of
 * `timeout` and `invalid_json` failures) is given time to clear before a
 * respawn; without it, immediate retries amplify an already-degraded backend.
 */
const RETRY_BACKOFF_BASE_MS = 250;

/**
 * Upper bound on the exponential backoff delay between adapter retry attempts,
 * in milliseconds.
 *
 * @remarks
 * The cap exists so a large caller-supplied `retries` budget cannot push the
 * per-attempt delay beyond a few seconds; the shift in {@link retryBackoffMs}
 * is bounded by this constant rather than by the attempt count.
 */
const RETRY_BACKOFF_MAX_MS = 2_000;

/**
 * Closed domain of verification phases supported by the opencode invocation protocol.
 *
 * @remarks
 * Each phase implies a distinct prompt template and expected JSON schema in the response.
 * The set is exhaustive — adding a phase requires updating schema validation logic.
 */
export type OpencodePhase =
  | "qualitative-review"
  | "qualitative-properties"
  | "formalization"
  | "code-derived-generation"
  | "code-derived-formalization"
  | "blind-comparison";

/**
 * Configuration for a single opencode subprocess invocation.
 *
 * @remarks
 * Invariant: `timeoutMs` and `retries` must be positive integers when provided.
 * The caller is responsible for constructing a prompt appropriate to the given phase.
 */
export interface OpencodeCallOptions {
  readonly model: string;
  readonly prompt: string;
  readonly phase: OpencodePhase;
  readonly binaryPath?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly files?: readonly string[];
  /**
   * Delay hook applied between retry attempts; defaults to a real timer.
   *
   * @remarks
   * Injected so tests can advance time deterministically instead of waiting
   * out real backoff delays. Production callers should leave this unset.
   */
  readonly backoffDelay?: (delayMs: number) => Promise<void>;
}

/** Token and cost usage aggregated from OpenCode `step_finish` events. */
export interface OpencodeUsage {
  readonly events: number;
  readonly completeEvents: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
}

/**
 * Discriminated error produced when an opencode invocation fails after exhausting retries.
 *
 * @remarks
 * Invariant: `kind` discriminates the failure mode — spawn failures, timeouts, malformed JSON,
 * and schema validation failures are all represented. The `phase` field ties the error back to
 * the verification step that produced it.
 */
export interface OpencodeError {
  readonly kind: "spawn_error" | "timeout" | "invalid_json" | "invalid_timeout" | "schema_validation_error" | "prompt_too_large" | "invalid_files";
  readonly phase: OpencodePhase;
  readonly message: string;
  readonly stderr?: string;
}

/**
 * Exponential backoff delay before retry attempt `attempt` (1-based), in
 * milliseconds.
 *
 * @param attempt - the attempt that just failed; the returned delay precedes
 *   attempt `attempt + 1`
 * @returns `RETRY_BACKOFF_BASE_MS * 2^(attempt-1)`, capped at
 *   `RETRY_BACKOFF_MAX_MS`
 *
 * @remarks
 * The cap is applied after the shift so a large caller-supplied retry budget
 * cannot overflow the delay into multi-minute territory; for any realistic
 * budget the value stays a safe small integer. Pure and total.
 */
function retryBackoffMs(attempt: number): number {
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_MS);
}

/**
 * Whether a failure kind can plausibly heal by respawning an identical call.
 *
 * @param kind - the terminal failure kind of the last attempt
 * @returns `true` for transient kinds (`spawn_error`, `timeout`,
 *   `invalid_json`); `false` for kinds that are deterministic for a fixed
 *   request
 *
 * @remarks
 * `prompt_too_large`, `invalid_timeout`, and `invalid_files` are request-shape
 * failures decided before any subprocess work. `schema_validation_error` is
 * deterministic at the adapter layer because the retry loop respawns an
 * identical prompt; recovering from stochastic model disagreement is the
 * domain layer's job (it rebuilds attempts with its own budget). Keeping this
 * classification total over the closed `kind` union forces a deliberate
 * decision when new kinds are added.
 */
function isTransientFailureKind(kind: OpencodeError["kind"]): boolean {
  return kind === "spawn_error" || kind === "timeout" || kind === "invalid_json";
}

/**
 * Default backoff delay implementation backed by a real timer.
 *
 * @param delayMs - delay in milliseconds; expected to be a safe non-negative
 *   integer produced by {@link retryBackoffMs}
 * @returns a promise that resolves after the delay
 *
 * @remarks
 * This is the only timer in the adapter; injecting `options.backoffDelay`
 * replaces it so tests never wait on wall-clock time.
 */
function defaultBackoffDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Call `opencode` with bounded retries and strict JSON validation.
 *
 * @param options - invocation options including model, prompt, phase, and retry/timeout config
 * @returns schema-validated JSON response on success, or a terminal `OpencodeError` on failure
 *
 * @remarks
 * Precondition: `options.model` and `options.prompt` are non-empty strings.
 * Postcondition: on `ok: true`, the value is a non-null object that passed phase schema
 * validation. On `ok: false`, all retry attempts have been exhausted.
 *
 * Failure modes:
 * - Binary not found or not executable → `kind: "spawn_error"` after all retries.
 * - Process exceeds timeout on every attempt → `kind: "timeout"`.
 * - Model returns non-JSON output → `kind: "invalid_json"`.
 * - Model returns JSON that fails phase schema validation → `kind: "schema_validation_error"`.
 *
 * Retry policy: only transient kinds (`spawn_error`, `timeout`, `invalid_json`)
 * are retried, up to `options.retries` (default 3) total attempts. The remaining
 * kinds are deterministic for a fixed request — respawning an identical call
 * cannot heal them — so they return immediately. Between attempts the loop
 * waits {@link retryBackoffMs}, an exponential backoff capped at
 * {@link RETRY_BACKOFF_MAX_MS}, injected via `options.backoffDelay` so time
 * stays at the adapter edge and tests can control it.
 *
 * Safety: spawns up to `retries` sequential subprocess invocations. No concurrent
 * subprocess overlap within a single call. Network failures in the LLM backend
 * surface as process-level errors (non-zero exit or timeout).
 */
/**
 * Resolved and validated invocation controls for one `callOpencode` run.
 *
 * @remarks
 * All defaults are applied and all request-shape validation has already
 * passed, so the retry loop can treat every field as authoritative.
 */
interface ResolvedCallOptions {
  readonly command: string;
  readonly retries: number;
  readonly timeoutMs: number;
  readonly backoffDelay: (delayMs: number) => Promise<void>;
}

/**
 * Validate request shape and resolve defaults before any subprocess work.
 *
 * @param options - raw invocation options from the caller
 * @returns resolved controls on success, or a terminal request-shape error
 *   (`prompt_too_large`, `invalid_timeout`, `invalid_files`) that no retry
 *   could heal
 *
 * @remarks
 * Postcondition on success: `timeoutMs` is a safe integer inside the accepted
 * range and every attached file is a readable regular file at validation
 * time. These failures are returned before the retry loop because respawning
 * an identically-shaped request cannot change them. The files check performs
 * read-only `stat` calls; all other checks are pure.
 */
async function validateCallOptions(
  options: OpencodeCallOptions,
): Promise<Result<ResolvedCallOptions, OpencodeError>> {
  const promptBytes = Buffer.byteLength(options.prompt, "utf8");
  if (promptBytes > PROMPT_ARG_MAX_BYTES) {
    return err({
      kind: "prompt_too_large",
      phase: options.phase,
      message: `instruction prompt exceeds ${String(PROMPT_ARG_MAX_BYTES)} UTF-8 bytes`,
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < TIMEOUT_MIN_MS || timeoutMs > TIMEOUT_MAX_MS) {
    return err({
      kind: "invalid_timeout",
      phase: options.phase,
      message: `timeout must be a safe integer in range [${String(TIMEOUT_MIN_MS)}, ${String(TIMEOUT_MAX_MS)}]`,
    });
  }

  const fileValidation = await validateFilesOption(options.files);
  if (!fileValidation.ok) {
    return err({
      kind: "invalid_files",
      phase: options.phase,
      message: fileValidation.error,
    });
  }

  return ok({
    command: options.binaryPath ?? "opencode",
    retries: options.retries ?? 3,
    timeoutMs,
    backoffDelay: options.backoffDelay ?? defaultBackoffDelay,
  });
}

/**
 * Build the argv array for one `opencode run` invocation.
 *
 * @param options - invocation options supplying the prompt, model, and files
 * @returns argument vector with the prompt as the first positional argument
 *
 * @remarks
 * The prompt must be the first positional argument after the "run" subcommand:
 * opencode interprets trailing positional arguments as file paths, not prompt
 * text. Pure and total; no element is mutated after construction.
 */
function buildOpencodeArgs(options: OpencodeCallOptions): string[] {
  const args: string[] = ["run", options.prompt, "--model", options.model, "--format", "json"];
  const variant = variantForModel(options.model);
  if (variant !== undefined) {
    args.push("--variant", variant);
  }
  for (const filePath of options.files ?? []) {
    args.push("--file", filePath);
  }
  return args;
}

/** Resolve provider reasoning variants for the preregistered comparison models. */
export function variantForModel(model: string): string | undefined {
  if (model === "github-copilot/gpt-5.6-luna") {
    return "max";
  }
  if (model === "github-copilot/gpt-5.6-terra") {
    return "high";
  }
  return undefined;
}

/**
 * Classify one completed subprocess result into a success or attempt error.
 *
 * @param processResult - captured stdout/stderr/exit state of one spawn
 * @param options - invocation options supplying phase and resolved timeout
 * @returns the validated payload, or the classified `OpencodeError` for this
 *   attempt; the caller decides whether the kind is worth retrying
 *
 * @remarks
 * Failure classification order is load-bearing: timeout first (stdout is
 * unreliable after a kill), then non-zero exit with unusable stdout (surfaced
 * with a bounded stderr preview), then JSON parse, then phase schema. Pure
 * classification of an already-captured result; performs no I/O.
 */
function classifyProcessResult(
  processResult: ProcessResult,
  options: OpencodeCallOptions,
  timeoutMs: number,
): Result<unknown, OpencodeError> {
  if (processResult.timedOut) {
    return err({
      kind: "timeout",
      phase: options.phase,
      message: `opencode timed out after ${String(timeoutMs)}ms`,
      stderr: processResult.stderr,
    });
  }

  // Process failure is authoritative even when a partial payload was emitted.
  if (processResult.signal !== null || processResult.exitCode !== 0) {
    const stderrPreview = processResult.stderr.trim().slice(0, 300);
    const exitDescription = processResult.signal === null
      ? `code ${String(processResult.exitCode)}`
      : `signal ${processResult.signal}`;
    return err({
      kind: "spawn_error",
      phase: options.phase,
      message: stderrPreview.length > 0
        ? `opencode exited with ${exitDescription}: ${stderrPreview}`
        : processResult.stdout.trim().length === 0
          ? `opencode exited with ${exitDescription} (empty stdout, no stderr)`
          : `opencode exited with ${exitDescription} (no stderr)`,
      stderr: processResult.stderr,
    });
  }

  let parsed: unknown;
  try {
    parsed = parseOpencodePayload(processResult.stdout);
  } catch (parseError: unknown) {
    const baseMessage = parseError instanceof Error ? parseError.message : "opencode returned non-JSON output";
    const stderrHint = processResult.stderr.trim().length > 0
      ? ` [stderr: ${processResult.stderr.trim().slice(0, 200)}]`
      : "";
    return err({
      kind: "invalid_json",
      phase: options.phase,
      message: `${baseMessage}${stderrHint}`,
      stderr: processResult.stderr,
    });
  }

  const validated = validatePhaseSchema(options.phase, parsed);
  if (!validated.ok) {
    return err(validated.error);
  }
  return ok(validated.value);
}

/**
 * Run one spawn-and-classify attempt against the opencode subprocess.
 *
 * @param command - resolved binary path
 * @param args - argv built by {@link buildOpencodeArgs}
 * @param options - invocation options supplying phase and files
 * @param timeoutMs - resolved per-attempt timeout
 * @returns the validated payload, or the classified attempt error; a thrown
 *   spawn is normalized to `spawn_error` so the retry loop stays total
 *
 * @remarks
 * Exactly one subprocess is spawned per call. The function never throws:
 * process-level throws (binary missing, not executable) are expected adapter
 * failures and are returned as data.
 */
async function attemptOpencodeOnce(
  command: string,
  args: readonly string[],
  options: OpencodeCallOptions,
  timeoutMs: number,
): Promise<{ readonly result: Result<unknown, OpencodeError>; readonly processResult?: ProcessResult }> {
  let processResult: ProcessResult;
  try {
    processResult = await runProcess(command, [...args], { timeoutMs });
  } catch (error) {
    return {
      result: err({
        kind: "spawn_error",
        phase: options.phase,
        message: error instanceof Error ? error.message : "opencode spawn failed",
      }),
    };
  }
  return { result: classifyProcessResult(processResult, options, timeoutMs), processResult };
}

/**
 * Call `opencode` with bounded retries and strict JSON validation.
 *
 * @param options - invocation options including model, prompt, phase, and retry/timeout config
 * @returns schema-validated JSON response on success, or a terminal `OpencodeError` on failure
 *
 * @remarks
 * Precondition: `options.model` and `options.prompt` are non-empty strings.
 * Postcondition: on `ok: true`, the value is a non-null object that passed phase schema
 * validation. On `ok: false`, all retry attempts have been exhausted.
 *
 * Failure modes:
 * - Binary not found or not executable → `kind: "spawn_error"` after all retries.
 * - Process exceeds timeout on every attempt → `kind: "timeout"`.
 * - Model returns non-JSON output → `kind: "invalid_json"`.
 * - Model returns JSON that fails phase schema validation → `kind: "schema_validation_error"`.
 *
 * Retry policy: only transient kinds (`spawn_error`, `timeout`, `invalid_json`)
 * are retried, up to `options.retries` (default 3) total attempts. The remaining
 * kinds are deterministic for a fixed request — respawning an identical call
 * cannot heal them — so they return immediately. Between attempts the loop
 * waits {@link retryBackoffMs}, an exponential backoff capped at
 * {@link RETRY_BACKOFF_MAX_MS}, injected via `options.backoffDelay` so time
 * stays at the adapter edge and tests can control it.
 *
 * Safety: spawns up to `retries` sequential subprocess invocations. No concurrent
 * subprocess overlap within a single call. Network failures in the LLM backend
 * surface as process-level errors (non-zero exit or timeout).
 */
export async function callOpencode(
  options: OpencodeCallOptions,
): Promise<Result<unknown, OpencodeError>> {
  const validated = await validateCallOptions(options);
  if (!validated.ok) {
    return validated;
  }
  const { command, retries, timeoutMs, backoffDelay } = validated.value;
  const args = buildOpencodeArgs(options);
  const logicalCallId = allocateOpencodeCallId();

  let lastError: OpencodeError | undefined;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    // Backoff precedes every attempt after the first; attempt 1 runs
    // immediately so the common no-retry path pays no scheduling cost.
    if (attempt > 1) {
      await backoffDelay(retryBackoffMs(attempt - 1));
    }

    const startedAt = new Date().toISOString();
    const startedNs = process.hrtime.bigint();
    const attempted = await attemptOpencodeOnce(command, args, options, timeoutMs);
    const durationMs = Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
    if (logicalCallId !== undefined) {
      const usage = extractOpencodeUsage(attempted.processResult?.stdout ?? "");
      recordOpencodeAttempt({
        logicalCallId,
        attempt,
        opencodePhase: options.phase,
        model: options.model,
        variant: variantForModel(options.model) ?? null,
        startedAt,
        durationMs,
        promptBytes: Buffer.byteLength(options.prompt, "utf8"),
        attachmentCount: options.files?.length ?? 0,
        exitCode: attempted.processResult?.exitCode ?? null,
        timedOut: attempted.processResult?.timedOut ?? false,
        outcome: attempted.result.ok ? "success" : attempted.result.error.kind,
        usageComplete: usage.events > 0 && usage.completeEvents === usage.events,
        usage,
      });
    }
    if (attempted.result.ok) {
      return attempted.result;
    }
    lastError = attempted.result.error;
    // A deterministic failure cannot heal by respawning an identical call;
    // stop here regardless of the remaining retry budget so a schema
    // mismatch costs one spawn instead of the full budget.
    if (!isTransientFailureKind(attempted.result.error.kind)) {
      break;
    }
  }

  return err(
    lastError ?? {
      kind: "spawn_error",
      phase: options.phase,
      message: "opencode failed without diagnostic",
    },
  );
}

/** Aggregate usage from all valid OpenCode `step_finish` NDJSON events. */
export function extractOpencodeUsage(stdout: string): OpencodeUsage {
  const mutable = {
    events: 0,
    completeEvents: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(event);
    const part = asRecord(record?.part);
    const tokens = asRecord(part?.tokens);
    if (record?.type !== "step_finish" || part === undefined || tokens === undefined) {
      continue;
    }
    mutable.events += 1;
    if (isCompleteUsageEvent(tokens)) {
      mutable.completeEvents += 1;
    }
    const inputTokens = finiteNumber(tokens.input);
    const outputTokens = finiteNumber(tokens.output);
    const reasoningTokens = finiteNumber(tokens.reasoning);
    const cache = asRecord(tokens.cache);
    const cacheReadTokens = finiteNumber(cache?.read ?? tokens.cache_read);
    const cacheWriteTokens = finiteNumber(cache?.write ?? tokens.cache_write);
    mutable.inputTokens += inputTokens;
    mutable.outputTokens += outputTokens;
    mutable.reasoningTokens += reasoningTokens;
    mutable.cacheReadTokens += cacheReadTokens;
    mutable.cacheWriteTokens += cacheWriteTokens;
    mutable.totalTokens += typeof tokens.total === "number" && Number.isFinite(tokens.total)
      ? tokens.total
      : inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
    mutable.cost += finiteNumber(part.cost);
  }
  return Object.freeze(mutable);
}

function isCompleteUsageEvent(tokens: Record<string, unknown>): boolean {
  const cache = asRecord(tokens.cache);
  return finiteToken(tokens.total)
    && finiteToken(tokens.input)
    && finiteToken(tokens.output)
    && finiteToken(tokens.reasoning)
    && finiteToken(cache?.read ?? tokens.cache_read)
    && finiteToken(cache?.write ?? tokens.cache_write);
}

function finiteToken(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Validate that all file attachment paths are non-empty strings pointing to readable
 * regular files (not symlinks, directories, or special files).
 *
 * @param files - optional array of file paths to validate for attachment transport
 * @returns `ok` with the validated file list on success; `err` with a diagnostic string
 *   describing the first invalid entry on failure
 *
 * @remarks
 * Precondition: each element in `files` (when provided) is expected to be a string.
 * Postcondition (Ok): every path in the returned array is a readable regular file
 *   that is not a symlink at the time of validation.
 * Postcondition (Err): the error string identifies the first path that failed validation
 *   and the reason (empty string, symlink, not a file, unreadable).
 *
 * Security: rejects symlinks to prevent traversal outside the intended source scope
 * without following the link target. Uses `lstat` before `stat` to detect symlinks.
 *
 * Failure modes (all represented in the Result, never thrown):
 * - Empty or non-string path → `"files must be non-empty path strings"`
 * - Symlink → `"attached file is a symlink (not allowed): <path>"`
 * - Not a regular file → `"attached file is not a regular file: <path>"`
 * - Unreadable (ENOENT, EACCES, etc.) → `"attached file is unreadable: <path>"`
 *
 * Safety: performs filesystem I/O (read-only stat calls). Sequential validation
 * stops on first failure (fail-fast). Does not read file contents.
 */
async function validateFilesOption(files: readonly string[] | undefined): Promise<Result<readonly string[], string>> {
  if (files === undefined) {
    return ok([]);
  }

  for (const filePath of files) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      return err("files must be non-empty path strings");
    }
    try {
      // Use lstat first to reject symlinks — prevents traversal outside the
      // intended source scope without following the link target.
      const linkStats = await lstat(filePath);
      if (linkStats.isSymbolicLink()) {
        return err(`attached file is a symlink (not allowed): ${filePath}`);
      }
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) {
        return err(`attached file is not a regular file: ${filePath}`);
      }
    } catch {
      return err(`attached file is unreadable: ${filePath}`);
    }
  }

  return ok(files);
}

/**
 * Extract the final JSON payload from `opencode run --format json` stdout.
 *
 * @param stdout - raw stdout captured from the opencode subprocess
 * @returns decoded JSON payload emitted by the model response
 *
 * @throws Error if stdout is empty, contains no parseable JSON, contains an error event,
 *   or lacks a text event with the payload content
 *
 * @remarks
 * The current opencode CLI emits newline-delimited JSON events. The model's
 * actual response text is carried by `type: "text"` events in `part.text`.
 * We concatenate those text fragments and then parse the result as the phase
 * payload JSON expected by spec-check.
 *
 * Precondition: `stdout` is the raw string output from `opencode run --format json`.
 * Postcondition: on success, returns a fully parsed JSON value representing the model payload.
 *
 * Failure modes:
 * - Empty stdout → throws Error("empty stdout").
 * - Malformed JSON lines → throws Error("invalid event json").
 * - Error event present in stream → throws with the error event's message.
 * - No text events found → throws Error("missing payload text event").
 */
function parseOpencodePayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error("empty stdout");
  }

  const direct = tryParseJson(trimmed);
  if (direct.ok) {
    const singleEvents = Array.isArray(direct.value) ? direct.value : [direct.value];
    throwOnErrorEvent(singleEvents);
    const eventPayload = extractPayloadFromEvents(singleEvents);
    if (eventPayload !== undefined) {
      return extractJsonPayload(eventPayload);
    }
    return extractJsonPayload(trimmed);
  }

  const events = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = tryParseJson(line);
      if (!parsed.ok) {
        throw new Error("invalid event json");
      }
      return parsed.value;
    });

  throwOnErrorEvent(events);

  const payload = extractPayloadFromEvents(events);
  if (payload === undefined) {
    throw new Error("missing payload text event");
  }
  return extractJsonPayload(payload);
}

/**
 * Throw if any event in the stream is an opencode error event.
 *
 * @param events - parsed JSON events from opencode stdout
 *
 * @throws Error if any event has `type: "error"`, propagating the error message
 *   from the event payload when available
 *
 * @remarks
 * Precondition: each element in `events` is a decoded JSON value.
 * Postcondition: throws if any event has `type: "error"`, propagating the
 * error message from the event payload when available.
 * Invariant: non-error events are ignored; does not mutate `events`.
 *
 * Failure modes:
 * - Error event found with nested message → throws Error with that message.
 * - Error event found without parseable message → throws Error("opencode returned an error event").
 * - No error events → returns normally (cannot fail).
 */
function throwOnErrorEvent(events: readonly unknown[]): void {
  for (const event of events) {
    const record = asRecord(event);
    if (record === undefined || record.type !== "error") {
      continue;
    }
    let message = "opencode returned an error event";
    const errorObj = asRecord(record.error);
    if (errorObj !== undefined) {
      if (typeof errorObj.message === "string") {
        message = errorObj.message;
      } else {
        const data = asRecord(errorObj.data);
        if (data !== undefined && typeof data.message === "string") {
          message = data.message;
        }
      }
    }
    throw new Error(message);
  }
}

/**
 * Concatenate text parts from opencode events and parse as JSON payload.
 *
 * @param events - parsed JSON events from opencode stdout
 * @returns parsed JSON payload from concatenated text parts, or `undefined` if no text events found
 *
 * @throws SyntaxError if text parts concatenate to invalid JSON
 *
 * @remarks
 * Precondition: each element in `events` is a decoded JSON value.
 * Postcondition: on non-undefined return, the value is a parsed JSON object
 * constructed from all `type: "text"` event fragments joined in order.
 * Invariant: does not mutate `events`.
 *
 * Failure modes:
 * - No text events → returns `undefined` (not a failure).
 * - Concatenated text is invalid JSON → throws SyntaxError from `JSON.parse`.
 */
function extractPayloadFromEvents(events: readonly unknown[]): string | undefined {
  const textParts = events
    .map(extractTextPart)
    .filter((value): value is string => value !== undefined);

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join("");
}

/**
 * Extract and parse a JSON value from a wrapped model response string.
 *
 * @param raw - model response text that may contain direct JSON, fenced JSON, or wrapped JSON
 * @returns parsed JSON value
 *
 * @throws Error when no recoverable JSON value can be extracted
 *
 * @remarks
 * Deterministic extraction cascade:
 * 1) direct parse
 * 2) strip outer markdown fences and parse
 * 3) extract first balanced object/array and parse
 * 4) throw including the original parse failure and raw preview
 */
export function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  const direct = tryParseJson(trimmed);
  if (direct.ok) {
    postcondition(direct.value !== undefined, "direct parse must not produce undefined");
    return direct.value;
  }

  const withoutFence = stripMarkdownFences(trimmed);
  const fencedAttempt = tryParseJson(withoutFence);
  if (fencedAttempt.ok) {
    postcondition(fencedAttempt.value !== undefined, "fence parse must not produce undefined");
    return fencedAttempt.value;
  }

  const extracted = extractFirstJsonValue(trimmed);
  if (extracted !== undefined) {
    const wrappedAttempt = tryParseJson(extracted);
    if (wrappedAttempt.ok) {
      postcondition(wrappedAttempt.value !== undefined, "wrapped parse must not produce undefined");
      return wrappedAttempt.value;
    }
  }

  const preview = trimmed.slice(0, 240);
  throw new Error(`unable to recover JSON payload (${direct.error.message}); preview=${JSON.stringify(preview)}`);
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  if (match === null) {
    return text;
  }
  return match[1] ?? "";
}

/**
 * Extract the first balanced JSON object or array from wrapped text.
 *
 * @param text - raw model output text that may contain a JSON value embedded in prose
 * @returns the substring containing the first balanced JSON object/array, or `undefined`
 *   if no opening `{` or `[` is found or the structure is unbalanced
 *
 * @remarks
 * Known limitation (by design): only the first `{` or `[` character encountered
 * during a forward scan is considered as the candidate start position. If the
 * actual JSON value is preceded by unrelated brace/bracket characters (e.g., in
 * prose explanations), this function will return an incorrect or unbalanced
 * substring and the caller's subsequent parse will fail, falling through to the
 * terminal error path.
 *
 * Precondition: `text` is a non-empty string (caller ensures this).
 * Postcondition: when non-undefined, the returned string starts with `{` or `[`
 * and ends with the matching `}` or `]` at depth zero.
 * Invariant: respects JSON string escaping — brace/bracket characters inside
 * quoted strings do not affect depth tracking.
 *
 * Failure modes: returns `undefined` when no opening delimiter exists or when
 * the structure never reaches balanced depth zero. Never throws.
 */
function extractFirstJsonValue(text: string): string | undefined {
  // Bound justification: this function scans at most `text.length` characters.
  // The input is always subprocess stdout bounded by the process timeout (timeoutMs)
  // and the PROMPT_ARG_MAX_BYTES limit on the request side. Typical LLM responses
  // are <100KB; worst case is bounded by available memory for the child process.
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "{" || ch === "[") {
      start = index;
      break;
    }
  }

  if (start < 0) {
    return undefined;
  }

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth += 1;
      continue;
    }
    if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

/**
 * Extract the text content from a single opencode event if it is a text event.
 *
 * @param event - a single parsed JSON event value
 * @returns the text string from the event's `part.text` field, or `undefined` if not a text event
 *
 * @remarks
 * Precondition: `event` is a decoded JSON value (may be any type).
 * Postcondition: returns a string only if `event` is an object with `type: "text"` and
 * a nested `part.text` string field; returns `undefined` otherwise.
 *
 * Failure modes: none — pure computation. Never throws.
 */
function extractTextPart(event: unknown): string | undefined {
  const record = asRecord(event);
  if (record === undefined || record.type !== "text") {
    return undefined;
  }

  const part = asRecord(record.part);
  if (part === undefined) {
    return undefined;
  }

  return typeof part.text === "string" ? part.text : undefined;
}

/**
 * Attempt to parse a string as JSON, returning a Result instead of throwing.
 *
 * @param input - raw string to parse as JSON
 * @returns `ok` with the parsed value on success, or `err` with an Error on parse failure
 *
 * @remarks
 * Precondition: `input` is a string (no type narrowing performed).
 * Postcondition: on `ok: true`, `value` is the result of `JSON.parse(input)`.
 * On `ok: false`, `error` is an Error describing the parse failure.
 *
 * Failure modes: none — all parse failures are captured in the Result error branch.
 * This function never throws.
 */
function tryParseJson(input: string): Result<unknown, Error> {
  try {
    return ok(JSON.parse(input));
  } catch (error) {
    return err(error instanceof Error ? error : new Error("invalid json"));
  }
}

/**
 * Narrow an `unknown` value to a record if it is a non-null object.
 *
 * @param value - untrusted value to narrow
 * @returns the value as `Record<string, unknown>` if it is a non-null object, or `undefined` otherwise
 *
 * @remarks
 * Localizes the single `as` cast required for working with parsed JSON objects.
 * Precondition: none.
 * Postcondition: when non-undefined, `value` satisfies `typeof value === "object" && value !== null`.
 * Safety: the cast is sound because the typeof + null check guarantees the value is an object.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Validate that a parsed JSON payload conforms to the expected structure for the given phase.
 *
 * @param phase - verification phase determining the expected schema shape
 * @param payload - parsed JSON value to validate
 * @returns the validated payload on success, or a schema_validation_error on structural mismatch
 *
 * @remarks
 * Precondition: `payload` is the result of a successful `JSON.parse` call.
 * Postcondition: on success, `payload` is a non-null object and any `findings` field is an array.
 * For the `formalization` phase, an optional `formalizations` field is an array of objects whose
 * `index` fields are safe integers. Omitting `formalizations` preserves single-response forms.
 * Invariant: does not mutate `payload`.
 *
 * Failure modes (all represented by `schema_validation_error`, never thrown):
 * - Non-object top-level payload.
 * - A present `findings` field that is not an array.
 * - For `formalization`, a present `formalizations` field that is not an array.
 * - For `formalization`, a batch entry that is not an object or lacks a safe-integer `index`.
 *
 * Safety: validation is pure. Entry validation is bounded by the returned `formalizations` array.
 */
function validatePhaseSchema(
  phase: OpencodePhase,
  payload: unknown,
): Result<unknown, OpencodeError> {
  const record = asRecord(payload);
  if (record === undefined) {
    return err({
      kind: "schema_validation_error",
      phase,
      message: "expected top-level JSON object",
    });
  }

  const findings = record.findings;
  if (findings !== undefined && !Array.isArray(findings)) {
    return err({
      kind: "schema_validation_error",
      phase,
      message: "expected findings to be an array when present",
    });
  }

  const formalizations = record.formalizations;
  if (phase === "formalization" && formalizations !== undefined) {
    if (!Array.isArray(formalizations)) {
      return err({
        kind: "schema_validation_error",
        phase,
        message: "expected formalizations to be an array when present",
      });
    }
    for (const entry of formalizations) {
      const entryRecord = asRecord(entry);
      if (entryRecord === undefined || Array.isArray(entry) || !Number.isSafeInteger(entryRecord.index)) {
        return err({
          kind: "schema_validation_error",
          phase,
          message: "expected every formalizations entry to be an object with a safe integer index",
        });
      }
      const index = entryRecord.index;
      if (typeof index === "number" && index < 0) {
        return err({
          kind: "schema_validation_error",
          phase,
          message: "expected every formalizations entry index to be a non-negative safe integer",
        });
      }
    }
  }

  return ok(payload);
}
