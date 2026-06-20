/**
 * LLM adapter that interfaces with OpenCode by spawning subprocess invocations
 * for each verification phase and parsing structured JSON responses.
 *
 * Adapter layer — translates domain phase requests into OpenCode CLI calls.
 * Exports: OpencodePhase, OpencodeInvocation, invokeOpencode.
 */
import { lstat, stat } from "node:fs/promises";

import { runProcess } from "./process.js";
import { postcondition } from "../domain/assert.js";
import { err, ok, type Result } from "../domain/result.js";
import { DEFAULT_TIMEOUT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS } from "../domain/timeout.js";

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

const PROMPT_ARG_MAX_BYTES = 32_768;

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
 * - All failures are retried up to `options.retries` (default 3) before returning error.
 *
 * Safety: spawns up to `retries` sequential subprocess invocations. No concurrent
 * subprocess overlap within a single call. Network failures in the LLM backend
 * surface as process-level errors (non-zero exit or timeout).
 */
export async function callOpencode(
  options: OpencodeCallOptions,
): Promise<Result<unknown, OpencodeError>> {
  const command = options.binaryPath ?? "opencode";
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const promptBytes = Buffer.byteLength(options.prompt, "utf8");
  if (promptBytes > PROMPT_ARG_MAX_BYTES) {
    return err({
      kind: "prompt_too_large",
      phase: options.phase,
      message: `instruction prompt exceeds ${String(PROMPT_ARG_MAX_BYTES)} UTF-8 bytes`,
    });
  }

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

  // The prompt must be the first positional argument after the "run" subcommand.
  // opencode interprets trailing positional arguments as file paths, not prompt text.
  const args: string[] = ["run", options.prompt, "--model", options.model, "--format", "json"];
  for (const filePath of options.files ?? []) {
    args.push("--file", filePath);
  }

  let lastError: OpencodeError | undefined;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let processResult;
    try {
      processResult = await runProcess(command, args, {
        timeoutMs,
      });
    } catch (error) {
      lastError = {
        kind: "spawn_error",
        phase: options.phase,
        message: error instanceof Error ? error.message : "opencode spawn failed",
      };
      continue;
    }

    if (processResult.timedOut) {
      lastError = {
        kind: "timeout",
        phase: options.phase,
        message: `opencode timed out after ${String(timeoutMs)}ms`,
        stderr: processResult.stderr,
      };
      continue;
    }

    // Surface non-zero exit codes and stderr content when stdout is unusable.
    // This prevents opaque "empty stdout" errors when the subprocess reports
    // a clear failure via stderr (e.g., argument parsing errors, missing files).
    if (processResult.exitCode !== null && processResult.exitCode !== 0 && processResult.stdout.trim().length === 0) {
      const stderrPreview = processResult.stderr.trim().slice(0, 300);
      lastError = {
        kind: "spawn_error",
        phase: options.phase,
        message: stderrPreview.length > 0
          ? `opencode exited with code ${String(processResult.exitCode)}: ${stderrPreview}`
          : `opencode exited with code ${String(processResult.exitCode)} (empty stdout, no stderr)`,
        stderr: processResult.stderr,
      };
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseOpencodePayload(processResult.stdout);
    } catch (parseError: unknown) {
      const baseMessage = parseError instanceof Error ? parseError.message : "opencode returned non-JSON output";
      const stderrHint = processResult.stderr.trim().length > 0
        ? ` [stderr: ${processResult.stderr.trim().slice(0, 200)}]`
        : "";
      lastError = {
        kind: "invalid_json",
        phase: options.phase,
        message: `${baseMessage}${stderrHint}`,
        stderr: processResult.stderr,
      };
      continue;
    }

    const validated = validatePhaseSchema(options.phase, parsed);
    if (!validated.ok) {
      lastError = validated.error;
      continue;
    }

    return ok(validated.value);
  }

  return err(
    lastError ?? {
      kind: "spawn_error",
      phase: options.phase,
      message: "opencode failed without diagnostic",
    },
  );
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
    if (typeof event !== "object" || event === null) {
      continue;
    }
    const record = event as { readonly type?: unknown; readonly error?: unknown };
    if (record.type !== "error") {
      continue;
    }
    let message = "opencode returned an error event";
    if (typeof record.error === "object" && record.error !== null) {
      const errorObj = record.error as { readonly data?: unknown; readonly message?: unknown };
      if (typeof errorObj.message === "string") {
        message = errorObj.message;
      } else if (typeof errorObj.data === "object" && errorObj.data !== null) {
        const data = errorObj.data as { readonly message?: unknown };
        if (typeof data.message === "string") {
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
  if (typeof event !== "object" || event === null) {
    return undefined;
  }

  const record = event as { readonly type?: unknown; readonly part?: unknown };
  if (record.type !== "text" || typeof record.part !== "object" || record.part === null) {
    return undefined;
  }

  const part = record.part as { readonly text?: unknown };
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
 * Validate that a parsed JSON payload conforms to the expected structure for the given phase.
 *
 * @param phase - verification phase determining the expected schema shape
 * @param payload - parsed JSON value to validate
 * @returns the validated payload on success, or a schema_validation_error on structural mismatch
 *
 * @remarks
 * Precondition: `payload` is the result of a successful `JSON.parse` call.
 * Postcondition: on success, `payload` is a non-null object and any `findings` field is an array.
 * Invariant: does not mutate `payload`.
 *
 * Failure modes: none — validation failures are captured in the Result error branch.
 * This function never throws.
 */
function validatePhaseSchema(
  phase: OpencodePhase,
  payload: unknown,
): Result<unknown, OpencodeError> {
  if (typeof payload !== "object" || payload === null) {
    return err({
      kind: "schema_validation_error",
      phase,
      message: "expected top-level JSON object",
    });
  }

  const maybeRecord = payload as Record<string, unknown>;
  const findings = maybeRecord.findings;
  if (findings !== undefined && !Array.isArray(findings)) {
    return err({
      kind: "schema_validation_error",
      phase,
      message: "expected findings to be an array when present",
    });
  }

  return ok(payload);
}
