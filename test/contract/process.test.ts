import type * as childProcess from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

type SpawnSyncResult = ReturnType<typeof childProcess.spawnSync>;

function mockSpawnSyncResult(result: SpawnSyncResult): SpawnSyncResult {
  return result;
}

describe("process adapter — isCommandAvailable", () => {
  it("returns true when command spawns successfully with exit code 0", async () => {
    traceSpec("CAT-CLI-ARGS");
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockReturnValue(mockSpawnSyncResult({
      status: 0,
      signal: null,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 123,
      output: [],
    }));

    const { isCommandAvailable } = await import("../../src/adapters/process.js");
    expect(isCommandAvailable("z3")).toBe(true);
  });

  it("returns false when command spawns but exits non-zero", async () => {
    traceSpec("CAT-CLI-ARGS");
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockReturnValue(mockSpawnSyncResult({
      status: 1,
      signal: null,
      stdout: Buffer.from(""),
      stderr: Buffer.from("Error: unknown option"),
      pid: 123,
      output: [],
    }));

    const { isCommandAvailable } = await import("../../src/adapters/process.js");
    expect(isCommandAvailable("bad-binary")).toBe(false);
  });

  it("returns false when command is not found (ENOENT)", async () => {
    traceSpec("CAT-CLI-ARGS");
    const { spawnSync } = await import("node:child_process");
    const enoentError = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    vi.mocked(spawnSync).mockReturnValue(mockSpawnSyncResult({
      error: enoentError,
      status: null,
      signal: null,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 0,
      output: [],
    }));
  
    const { isCommandAvailable } = await import("../../src/adapters/process.js");
    expect(isCommandAvailable("nonexistent")).toBe(false);
  });
});
