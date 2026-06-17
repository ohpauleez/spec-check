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
  const timeoutMs = options.timeoutMs ?? 30_000;

  let lastError: OpencodeError | undefined;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let processResult;
    try {
      processResult = await runProcess(command, ["--prompt", options.prompt, "--model", options.model], {
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
      parsed = JSON.parse(processResult.stdout);
    } catch {
      lastError = {
        kind: "invalid_json",
        phase: options.phase,
        message: "opencode returned non-JSON output",
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
