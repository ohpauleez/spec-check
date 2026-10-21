import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type * as childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { runProcess, PROCESS_CLEANUP_ALLOWANCE_MS } from "../../src/adapters/process.js";
import { traceSpec } from "../support/spec-trace.js";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof childProcess>(), spawn: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** Construct a deliberately controllable process-boundary fake, never a real PID. */
function fakeChild(): ChildProcessWithoutNullStreams {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234567, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true), unref: vi.fn(),
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

it.skipIf(process.platform === "win32").each([false, true])("settles overflow once despite competing stream errors (%s)", async (cleanupError) => {
  traceSpec("CAT-PROCESS-BOUND", "RAE-OC-OUTPUT-ONCE");
  vi.useFakeTimers();
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child);
  const pending = runProcess("fixture", [], { timeoutMs: 100, maxOutputBytes: 1 });
  child.stdout.emit("data", Buffer.from("overflow"));
  if (cleanupError) child.emit("error", new Error("cleanup race"));
  child.emit("close", null, "SIGKILL");
  expect(await pending).toMatchObject({ timedOut: false, outputLimitExceeded: true });
  child.emit("error", new Error("late error"));
  child.emit("error", new Error("another late error"));
  child.emit("close", 0, null);
  expect(kill).toHaveBeenCalledExactlyOnceWith(-1234567, "SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
});

it.skipIf(process.platform === "win32")("retains the first termination cause and releases pipes when close never arrives", async () => {
  traceSpec("CAT-PROCESS-PIPE-CLEANUP");
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockReturnValue(true);
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child);
  const pending = runProcess("fixture", [], { timeoutMs: 100, maxOutputBytes: 1 });
  await vi.advanceTimersByTimeAsync(100);
  child.stdout.emit("data", Buffer.from("late overflow"));
  await vi.advanceTimersByTimeAsync(PROCESS_CLEANUP_ALLOWANCE_MS);
  expect(await pending).toMatchObject({ timedOut: true, outputLimitExceeded: false, stdout: "" });
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
  expect(child.unref).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
