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
 * Invariant: `kind` is derived from the first non-empty line of stdout when the process
 * completes normally; it is `"timeout"` when the process exceeds the time budget, and
 * `"error"` when the process fails to spawn or produces unrecognized output.
 * `exitCode` is `null` only when the process could not be spawned.
 */
export interface Z3Result {
  readonly kind: Z3ResultKind;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
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
    };
  }

  if (result.timedOut) {
    return {
      kind: "timeout",
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  const firstLine = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstLine === "sat") {
    return { kind: "sat", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }
  if (firstLine === "unsat") {
    return { kind: "unsat", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }
  if (firstLine === "unknown") {
    return { kind: "unknown", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  return {
    kind: "error",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}
