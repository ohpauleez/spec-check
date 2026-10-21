/**
 * Process execution adapter that spawns subprocesses with timeout support
 * and captures stdout, stderr, exit codes, and termination signals.
 *
 * Adapter layer — provides a uniform subprocess interface to other adapters.
 * Exports: ProcessResult, RunProcessOptions, runProcess, isCommandAvailable.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isUtf8 } from "node:buffer";

/** Maximum pipe-cleanup wait after requesting timeout/overflow termination. */
export const PROCESS_CLEANUP_ALLOWANCE_MS = 250;

/**
 * Captured result of a completed subprocess execution.
 *
 * @remarks
 * Invariant: `timedOut` records timeout-triggered termination, independently of
 * whether Node has observed the exit signal before bounded pipe cleanup settles.
 * `exitCode` is `null` when the process was terminated by a signal rather than exiting normally.
 * `stdout` and `stderr` contain all data captured up to process termination.
 */
export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputLimitExceeded?: boolean;
  readonly stdoutInvalidUtf8?: boolean;
  readonly stderrInvalidUtf8?: boolean;
  /** Present when an owned-tree termination request fails; never implies success. */
  readonly terminationError?: string;
}

/** Explicit argv-only execution controls, with units at the boundary. */
export interface RunProcessOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly stdinText?: string;
  readonly envOverrides?: Readonly<NodeJS.ProcessEnv>;
  readonly maxOutputBytes?: number;
}

/** Single-writer capture/termination state owned by one process invocation. */
interface ProcessSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly options: RunProcessOptions;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  readonly resolve: (value: ProcessResult) => void;
  readonly reject: (error: Error) => void;
  bytes: number;
  settled: boolean;
  reason: "timeout" | "output_limit" | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  terminationError: string | undefined;
}

/**
 * Check whether a command is executable in the current process environment.
 *
 * @param command - binary name or absolute path
 * @returns true when process spawns successfully and exits with code 0
 *
 * @remarks
 * Precondition: `command` is a non-empty string.
 * Postcondition: returns `true` if and only if `command --version` spawns
 * without error and exits with code 0 without a termination signal.
 *
 * Failure modes: none — spawn errors are caught and mapped to boolean result.
 * This function never throws.
 *
 * Safety: synchronous subprocess spawn; blocks the event loop for the duration
 * of `command --version`. Avoid calling in hot paths or tight loops.
 */
export function isCommandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
  });

  return result.error === undefined && result.status === 0 && result.signal === null;
}

/**
 * Execute a subprocess using explicit argv and bounded timeout.
 *
 * @param command - binary name or absolute path
 * @param args - argv arguments without shell interpolation
 * @param options - execution options
 * @param options.timeoutMs - maximum execution time in milliseconds; no timeout if omitted
 * @param options.cwd - working directory for the child process
 * @param options.stdinText - text to write to the child's stdin before closing it
 * @returns captured process result including stdout, stderr, exit code, and timeout flag
 *
 * @remarks
 * Precondition: `command` is a non-empty string referencing an executable binary.
 * Postcondition: resolution includes captured output and observed exit metadata.
 * Timeout/overflow requests owned-tree termination and settles no later than a
 * 250 ms cleanup allowance after that request, subject to event-loop scheduling.
 *
 * Failure modes:
 * - Binary not found or not executable → rejects with an Error (ENOENT/EACCES).
 * - Process exceeds `timeoutMs` → resolves with `timedOut: true`, process killed via SIGKILL.
 * - Process exits with non-zero code → resolves normally with the exit code captured.
 *
 * Safety: POSIX calls own a fresh process group, not an existing shared service.
 * Escaped process groups are not contained, but cannot retain our pipes forever.
 * Windows uses bounded best-effort taskkill. Timers and streams are finalized
 * exactly once. No shell interpolation occurs. Callers bound concurrency.
 * @example await runProcess("opencode", ["--version"], { timeoutMs: 5000, maxOutputBytes: 16384 });
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildProcessEnvironment(options.envOverrides),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: ProcessSession = {
      child, options, resolve, reject, stdout: [], stderr: [], bytes: 0,
      settled: false, reason: undefined, timer: undefined, cleanupTimer: undefined,
      terminationError: undefined,
    };
    child.stdout.on("data", (chunk: Buffer) => captureChunk(session, session.stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => captureChunk(session, session.stderr, chunk));
    child.on("error", (error) => settleProcess(session, error));
    child.once("close", () => settleProcess(session));
    child.stdout.on("error", (error) => settleProcess(session, error));
    child.stderr.on("error", (error) => settleProcess(session, error));
    // A child can close stdin before accepting the supplied input. EPIPE is an
    // ordinary early-exit condition; other stream errors terminate owned work.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") settleProcess(session, error);
    });
    if (options.timeoutMs !== undefined) {
      session.timer = setTimeout(() => stopProcess(session, "timeout"), options.timeoutMs);
    }
    if (options.stdinText !== undefined) child.stdin.write(options.stdinText);
    child.stdin.end();
  });
}

/** Append one bounded chunk while running; the first termination cause wins. */
function captureChunk(session: ProcessSession, target: Buffer[], chunk: Buffer): void {
  if (session.settled || session.reason !== undefined) return;
  session.bytes += chunk.byteLength;
  if (session.options.maxOutputBytes !== undefined && session.bytes > session.options.maxOutputBytes) {
    stopProcess(session, "output_limit");
  } else {
    target.push(chunk);
  }
}

/** Kill the owned POSIX group; Windows taskkill never blocks settlement.
 * @returns An immediate termination failure, otherwise undefined. Deliberately
 * detached descendants are outside ownership; pipe cleanup still stays bounded.
 */
function killOwnedProcess(child: ChildProcessWithoutNullStreams): string | undefined {
  if (child.pid === undefined) return undefined;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGKILL");
    } else {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => killer.kill("SIGKILL"), PROCESS_CLEANUP_ALLOWANCE_MS);
      killer.once("error", () => { clearTimeout(timer); child.kill("SIGKILL"); });
      killer.once("close", () => clearTimeout(timer));
    }
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    child.kill("SIGKILL");
    return error instanceof Error ? error.message : "Owned process termination failed";
  }
  return undefined;
}

/** Request termination once, then bound stream cleanup independently of close. */
function stopProcess(session: ProcessSession, reason: "timeout" | "output_limit"): void {
  if (session.settled || session.reason !== undefined) return;
  session.reason = reason;
  session.terminationError = killOwnedProcess(session.child);
  if (session.settled) return;
  session.cleanupTimer = setTimeout(() => settleProcess(session), PROCESS_CLEANUP_ALLOWANCE_MS);
}

/** Finalize timers, pipes and result exactly once, including late close/errors.
 * Valid UTF-8 is checked without allocating a discarded decoded string; lossy
 * conversion is retained for diagnostics, with explicit invalid-byte flags.
 */
function settleProcess(session: ProcessSession, error?: Error): void {
  if (session.settled) return;
  session.settled = true;
  clearTimeout(session.timer);
  clearTimeout(session.cleanupTimer);
  const failedBeforeTermination = error !== undefined && session.reason === undefined;
  if (failedBeforeTermination) killOwnedProcess(session.child);
  if (error !== undefined && !failedBeforeTermination) session.terminationError ??= error.message;
  // If the OS has not confirmed exit (notably best-effort Windows cleanup),
  // its process handle must not pin the caller after our bounded settlement.
  if (session.reason !== undefined || error !== undefined) session.child.unref();
  session.child.stdin.destroy();
  session.child.stdout.destroy();
  session.child.stderr.destroy();
  if (error !== undefined && failedBeforeTermination) { session.reject(error); return; }
  const stdout = Buffer.concat(session.stdout);
  const stderr = Buffer.concat(session.stderr);
  session.resolve({
    exitCode: session.child.exitCode, signal: session.child.signalCode,
    stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"),
    timedOut: session.reason === "timeout", outputLimitExceeded: session.reason === "output_limit",
    stdoutInvalidUtf8: !isUtf8(stdout), stderrInvalidUtf8: !isUtf8(stderr),
    ...(session.terminationError === undefined ? {} : { terminationError: session.terminationError }),
  });
}

/**
 * Merge child-specific environment values over the inherited process environment.
 *
 * @param overrides - optional variables that take precedence for one child
 * @returns a fresh environment object preserving all inherited variables
 *
 * @remarks
 * Postcondition: every parent variable not named by `overrides` is preserved.
 * The function is pure with respect to the returned object and never mutates
 * `process.env` or `overrides`.
 */
export function buildProcessEnvironment(
  overrides: Readonly<NodeJS.ProcessEnv> | undefined,
): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}
