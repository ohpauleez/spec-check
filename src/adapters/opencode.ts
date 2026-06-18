import { runProcess } from "./process.js";
import { err, ok, type Result } from "../domain/result.js";

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
  readonly kind: "spawn_error" | "timeout" | "invalid_json" | "schema_validation_error";
  readonly phase: OpencodePhase;
  readonly message: string;
  readonly stderr?: string;
}

/**
 * Call `opencode` with bounded retries and strict JSON validation.
 *
 * @param options - invocation options
 * @returns schema-validated JSON response or terminal error
 */
export async function callOpencode(
  options: OpencodeCallOptions,
): Promise<Result<unknown, OpencodeError>> {
  const command = options.binaryPath ?? "opencode";
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 120_000;

  let lastError: OpencodeError | undefined;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let processResult;
    try {
      processResult = await runProcess(command, ["run", "--model", options.model, "--format", "json", options.prompt], {
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

    let parsed: unknown;
    try {
      parsed = parseOpencodePayload(processResult.stdout);
    } catch (parseError: unknown) {
      lastError = {
        kind: "invalid_json",
        phase: options.phase,
        message: parseError instanceof Error ? parseError.message : "opencode returned non-JSON output",
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
 * Extract the final JSON payload from `opencode run --format json` stdout.
 *
 * @param stdout - raw stdout captured from the opencode subprocess
 * @returns decoded JSON payload emitted by the model response
 *
 * @remarks
 * The current opencode CLI emits newline-delimited JSON events. The model's
 * actual response text is carried by `type: "text"` events in `part.text`.
 * We concatenate those text fragments and then parse the result as the phase
 * payload JSON expected by spec-check.
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
      return eventPayload;
    }
    return direct.value;
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
  return payload;
}

/**
 * Throw if any event in the stream is an opencode error event.
 *
 * @param events - parsed JSON events from opencode stdout
 *
 * @remarks
 * Precondition: each element in `events` is a decoded JSON value.
 * Postcondition: throws if any event has `type: "error"`, propagating the
 * error message from the event payload when available.
 * Invariant: non-error events are ignored.
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

function extractPayloadFromEvents(events: readonly unknown[]): unknown {
  const textParts = events
    .map(extractTextPart)
    .filter((value): value is string => value !== undefined);

  if (textParts.length === 0) {
    return undefined;
  }

  return JSON.parse(textParts.join(""));
}

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
