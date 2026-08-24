/**
 * Process execution adapter that spawns subprocesses with timeout support
 * and captures stdout, stderr, exit codes, and termination signals.
 *
 * Adapter layer — provides a uniform subprocess interface to other adapters.
 * Exports: ProcessResult, RunProcessOptions, runProcess, runProcessSync.
 */
import { spawn, spawnSync } from "node:child_process";

/**
 * Captured result of a completed subprocess execution.
 *
 * @remarks
 * Invariant: `timedOut` is true if and only if the process was killed due to exceeding the
 * configured timeout budget. When `timedOut` is true, `signal` will typically be `"SIGKILL"`.
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
}

/**
 * Check whether a command is executable in the current process environment.
 *
 * @param command - binary name or absolute path
 * @returns true when process spawns successfully and exits with code 0
 *
 * @remarks
 * Precondition: `command` is a non-empty string.
 * Postcondition: returns `true` if and only if `command --version` exits with code 0,
 * or the spawn error is not ENOENT/ENOTDIR (indicating the binary exists but failed).
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

  if (result.error === undefined) {
    return result.status === 0;
  }

  const maybeCode = (result.error as NodeJS.ErrnoException).code;
  return maybeCode !== "ENOENT" && maybeCode !== "ENOTDIR";
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
 * Postcondition: on resolution, all stdout/stderr data has been captured and the child
 * process has terminated. On rejection, the process failed to spawn entirely.
 *
 * Failure modes:
 * - Binary not found or not executable → rejects with an Error (ENOENT/EACCES).
 * - Process exceeds `timeoutMs` → resolves with `timedOut: true`, process killed via SIGKILL.
 * - Process exits with non-zero code → resolves normally with the exit code captured.
 *
 * Safety: spawns exactly one child process per call. The timer is always cleared on
 * completion. No shell interpolation occurs (`shell: false`). Callers must bound
 * concurrent invocations to avoid file descriptor exhaustion.
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  options?: {
    readonly timeoutMs?: number;
    readonly cwd?: string;
    readonly stdinText?: string;
    readonly envOverrides?: Readonly<NodeJS.ProcessEnv>;
    readonly maxOutputBytes?: number;
  },
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: buildProcessEnvironment(options?.envOverrides),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Accumulate chunks in arrays to avoid O(n^2) string concatenation.
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      captureChunk(chunk, stdoutChunks);
    });
    child.stderr.on("data", (chunk: string) => {
      captureChunk(chunk, stderrChunks);
    });

    function captureChunk(chunk: string, target: string[]): void {
      if (outputLimitExceeded) return;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (options?.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    }

    if (options?.stdinText !== undefined) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();

    const timeout = options?.timeoutMs;
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeout);

    child.on("error", (error) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve({
        exitCode,
        signal,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        timedOut,
        outputLimitExceeded,
      });
    });
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
