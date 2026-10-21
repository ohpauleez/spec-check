/**
 * Z3 solver adapter that invokes the Z3 SMT solver as a subprocess,
 * parses its output, and classifies results into a closed set of outcomes.
 *
 * Adapter layer — bridges domain SMT-LIB content to the Z3 binary.
 * Exports: solver query execution and bounded dependency preflight.
 */
import type { SmtlibContent } from "../domain/branded.js";
import { runProcess } from "./process.js";
import { err, ok, type Result } from "../domain/result.js";

/** Independent preflight execution budget, in milliseconds. */
export const Z3_PREFLIGHT_TIMEOUT_MS = 5_000;
/** Combined stdout/stderr preflight capture budget, in bytes. */
export const Z3_PREFLIGHT_MAX_BYTES = 16_384;

/** Closed failure causes for a single local Z3 readiness probe. */
export interface Z3DependencyError {
  readonly kind: "not_found" | "not_executable" | "spawn_error" | "timeout" | "output_limit" | "exit_error";
  readonly message: string;
}

/** Build an actionable diagnostic without including untrusted process output.
 * @param command - Configured command or path, escaped and bounded for display.
 * @param kind - Classified local dependency failure.
 * @param reason - Trusted failure description, never raw stdout/stderr.
 * @returns Structured failure; no I/O or mutation.
 */
function preflightFailure(command: string, kind: Z3DependencyError["kind"], reason: string): Result<never, Z3DependencyError> {
  const label = JSON.stringify(command.slice(0, 300))
    .replace(/[\u007f-\u009f\u2028\u2029]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .slice(0, 300);
  return err({ kind, message: `Z3 pre-flight failed at ${label}: ${reason}. Check --z3/PATH, execute permissions, and filesystem restrictions.` });
}

/** Verify Z3 can execute before any paid analysis begins.
 * @param command - Selected executable, defaulting to z3 on PATH.
 * @returns Success only for one signal-free, zero-exit version probe; otherwise
 * an actionable, bounded dependency error. Expected process failures never throw.
 * @remarks Argv-only, no retries, solver query, version policy, or model telemetry.
 * Uses owned-process termination and the process adapter's 250-ms cleanup allowance.
 * @example await probeZ3Dependency("/opt/z3/bin/z3");
 */
export async function probeZ3Dependency(command = "z3"): Promise<Result<void, Z3DependencyError>> {
  try {
    const result = await runProcess(command, ["--version"], {
      timeoutMs: Z3_PREFLIGHT_TIMEOUT_MS,
      maxOutputBytes: Z3_PREFLIGHT_MAX_BYTES,
    });
    if (result.outputLimitExceeded === true) return preflightFailure(command, "output_limit", "version check exceeded 16384 captured bytes");
    if (result.timedOut) return preflightFailure(command, "timeout", "version check timed out after 5000ms");
    if (result.signal !== null || result.exitCode !== 0) {
      return preflightFailure(command, "exit_error", `version check failed (${result.signal ?? `exit ${String(result.exitCode)}`})`);
    }
    return ok(undefined);
  } catch (error: unknown) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return preflightFailure(command, "not_found", `binary not found (${code})`);
    if (code === "EACCES" || code === "EPERM") return preflightFailure(command, "not_executable", `cannot execute the binary (${code})`);
    return preflightFailure(command, "spawn_error", "could not execute the binary");
  }
}

/**
 * Closed domain of possible Z3 solver outcomes.
 *
 * @remarks
 * `"sat"` and `"unsat"` are definitive verdicts. `"unknown"` means the solver could not
 * decide within its resource limits. `"timeout"` indicates the process exceeded the
 * configured time budget. `"error"` covers spawn failures and unrecognized output.
 */
export type Z3ResultKind = "sat" | "unsat" | "timeout" | "unknown" | "error";

/**
 * Captured outcome of a Z3 solver invocation including raw process output.
 *
 * @remarks
 * Invariant: `kind` is derived from the first verdict line of stdout when the process
 * completes normally; it is `"timeout"` when the process exceeds the time budget, and
 * `"error"` when the process fails to spawn, produces unrecognized output, or emits
 * error diagnostics before the verdict.
 * `exitCode` is `null` only when the process could not be spawned.
 * `errorCount` reports how many `(error ...)` lines were emitted by Z3 (defaults to 0).
 */
export interface Z3Result {
  readonly kind: Z3ResultKind;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly errorCount?: number;
}

/**
 * Execute an SMT-LIB query against the Z3 solver and classify the result.
 *
 * @param input - query configuration containing the SMT-LIB content, optional binary path, and timeout
 * @param input.smtlib - SMT-LIB content to pass to Z3 via stdin
 * @param input.z3Path - path to the Z3 binary; defaults to `"z3"` on PATH
 * @param input.timeoutMs - maximum execution time in milliseconds; defaults to 30000
 * @returns classified solver result with captured stdout and stderr
 *
 * @remarks
 * Precondition: `input.smtlib` is syntactically valid SMT-LIB content (branded type).
 * Postcondition: always resolves (never rejects) — spawn failures are captured as `kind: "error"`.
 * The timeout bound is enforced via SIGKILL on the child process.
 * When Z3 emits `(error ...)` diagnostic lines, the result is classified as `"error"`
 * regardless of any subsequent verdict line, since the verdict is unreliable when
 * assertions failed to parse.
 *
 * Failure modes:
 * - Z3 binary not found or not executable → `kind: "error"`, `exitCode: null`.
 * - Process exceeds timeout → `kind: "timeout"`, process killed via SIGKILL.
 * - Z3 emits `(error ...)` diagnostics → `kind: "error"`, `errorCount > 0`.
 * - Z3 produces unrecognized output (no verdict line) → `kind: "error"`, `errorCount: 0`.
 * - Network/filesystem unavailability does not apply (Z3 is a local subprocess).
 *
 * Safety: spawns a child process; at most one Z3 process per call. Caller is
 * responsible for bounding concurrent invocations to avoid resource exhaustion.
 */
export async function runZ3Query(input: {
  readonly smtlib: SmtlibContent;
  readonly z3Path?: string;
  readonly timeoutMs?: number;
}): Promise<Z3Result> {
  let result;
  try {
    result = await runProcess(input.z3Path ?? "z3", ["-in"], {
      timeoutMs: input.timeoutMs ?? 30_000,
      stdinText: input.smtlib,
    });
  } catch (error) {
    return {
      kind: "error",
      stdout: "",
      stderr: error instanceof Error ? error.message : "z3 process execution failed",
      exitCode: null,
      errorCount: 0,
    };
  }

  if (result.timedOut) {
    return {
      kind: "timeout",
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      errorCount: 0,
    };
  }

  const lines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Count Z3 error diagnostics — these indicate malformed input.
  const errorCount = lines.filter((line) => line.startsWith("(error")).length;

  // Find the actual verdict line (skip error diagnostics).
  const verdictLine = lines.find(
    (line) => line === "sat" || line === "unsat" || line === "unknown",
  );

  // If Z3 emitted any errors, classify as "error" regardless of eventual verdict.
  // A verdict after errors is unreliable (e.g., vacuously "sat" when all assertions failed).
  if (errorCount > 0) {
    return {
      kind: "error",
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      errorCount,
    };
  }

  if (verdictLine === "sat") {
    return { kind: "sat", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, errorCount: 0 };
  }
  if (verdictLine === "unsat") {
    return { kind: "unsat", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, errorCount: 0 };
  }
  if (verdictLine === "unknown") {
    return { kind: "unknown", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, errorCount: 0 };
  }

  return {
    kind: "error",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    errorCount: 0,
  };
}
