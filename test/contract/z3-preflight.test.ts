import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runProcess } from "../../src/adapters/process.js";
import { probeZ3Dependency } from "../../src/adapters/z3.js";
import { allocateOpencodeCallId, createTelemetryCollector, runWithTelemetryCollector, snapshotCurrentTelemetry } from "../../src/adapters/telemetry.js";

vi.mock("../../src/adapters/process.js", () => ({ runProcess: vi.fn() }));
const completed = { exitCode: 0, signal: null, stdout: "Z3 version 4.13.0\n", stderr: "", timedOut: false } as const;

describe("Z3 dependency preflight", () => {
  beforeEach(() => { vi.mocked(runProcess).mockReset(); });

  it("uses one bounded version command without allocating model work or imposing a version policy", async () => {
    traceSpec("CAT-CLI-DEPS", "CAT-DEPS-Z3", "RAE-OC-METRICS-PROBE");
    vi.mocked(runProcess).mockResolvedValue({ ...completed, stdout: "wrapper version output" });
    await runWithTelemetryCollector(createTelemetryCollector(), async () => {
      expect(await probeZ3Dependency("/custom path/z3")).toEqual({ ok: true, value: undefined });
      expect(snapshotCurrentTelemetry()?.attempts).toEqual([]);
      expect(allocateOpencodeCallId()).toBe(1);
    });
    expect(runProcess).toHaveBeenCalledExactlyOnceWith("/custom path/z3", ["--version"], { timeoutMs: 5000, maxOutputBytes: 16384 });
  });

  it.each([
    ["ENOENT", "not_found"], ["ENOTDIR", "not_found"],
    ["EACCES", "not_executable"], ["EPERM", "not_executable"], ["EIO", "spawn_error"],
  ] as const)("classifies %s without accepting a merely existing file", async (code, kind) => {
    traceSpec("CAT-DEPS-Z3");
    vi.mocked(runProcess).mockRejectedValue(Object.assign(new Error("untrusted output"), { code }));
    const result = await probeZ3Dependency("/selected/z3");
    expect(result).toMatchObject({ ok: false, error: { kind } });
    if (!result.ok) {
      expect(result.error.message).toContain("/selected/z3");
      expect(result.error.message).toContain("Check --z3/PATH");
      if (kind !== "spawn_error") expect(result.error.message).toContain(code);
      expect(result.error.message).not.toContain("untrusted output");
    }
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it.each([
    [{ timedOut: true, exitCode: null }, "timeout"],
    [{ outputLimitExceeded: true, timedOut: true }, "output_limit"],
    [{ exitCode: 7 }, "exit_error"],
    [{ signal: "SIGTERM" as const }, "exit_error"],
    [{ exitCode: null }, "exit_error"],
  ] as const)("fails closed for process result %o", async (fields, kind) => {
    traceSpec("CAT-DEPS-Z3");
    vi.mocked(runProcess).mockResolvedValue({ ...completed, ...fields });
    expect(await probeZ3Dependency()).toMatchObject({ ok: false, error: { kind } });
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it("bounds and escapes the configured path, and never prints hostile process output or exceptions", async () => {
    traceSpec("CAT-DEPS-Z3");
    const command = `/z3\n\u001b\u0085\u2028${"x".repeat(10_000)}`;
    for (const failure of [new Error("\u001b secret"), "\u001b secret"]) {
      vi.mocked(runProcess).mockRejectedValueOnce(failure);
      const result = await probeZ3Dependency(command);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(Array.from(result.error.message).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
        })).toBe(false);
        expect(result.error.message.length).toBeLessThan(500);
        expect(result.error.message).not.toContain("secret");
      }
    }
    vi.mocked(runProcess).mockResolvedValueOnce({ ...completed, exitCode: 1, stderr: "\u001b secret" });
    const result = await probeZ3Dependency();
    if (result.ok) throw new Error("Unexpected preflight success");
    expect(result.error.message).toContain("exit 1");
    expect(result.error.message).not.toContain("secret");
  });
});
