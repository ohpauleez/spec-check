/**
 * Z3 solver adapter that invokes the Z3 SMT solver as a subprocess,
 * parses its output, and classifies results into a closed set of outcomes.
 *
 * Adapter layer — bridges domain SMT-LIB content to the Z3 binary.
 * Exports: Z3ResultKind, Z3Result, Z3Options, runZ3.
 */
import type { SmtlibContent } from "../domain/branded.js";
import { runProcess } from "./process.js";

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
