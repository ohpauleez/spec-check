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
}

/**
 * Check whether a command is executable in the current process environment.
 *
 * @param command - binary name or absolute path
 * @returns true when process spawns successfully and exits with code 0
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
 * @returns captured process result
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  options?: {
    readonly timeoutMs?: number;
    readonly cwd?: string;
    readonly stdinText?: string;
  },
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Accumulate chunks in arrays to avoid O(n^2) string concatenation.
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
    });

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
      });
    });
  });
}
