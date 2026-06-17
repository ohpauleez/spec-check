import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { callOpencode } from "../../src/adapters/opencode.js";

vi.mock("../../src/adapters/process.js", () => ({
  runProcess: vi.fn(),
}));

describe("opencode adapter contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("constructs argv without shell interpolation", async () => {
    traceSpec("CAT-DEPS-OPENCODE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ result: "ok" }),
      stderr: "",
      timedOut: false,
    });

    await callOpencode({
      model: "test-model",
      phase: "qualitative-review",
      prompt: "hello world",
      retries: 1,
    });

    expect(mocked).toHaveBeenCalledOnce();
    const [command, args] = mocked.mock.calls[0] as [string, readonly string[], unknown];
    expect(command).toBe("opencode");
    expect(args).toEqual(["--prompt", "hello world", "--model", "test-model"]);
  });

  it("returns ok with parsed JSON on valid response", async () => {
    traceSpec("CAT-DEPS-OPENCODE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ findings: [{ severity: "info" }] }),
      stderr: "",
      timedOut: false,
    });

    const result = await callOpencode({
      model: "m",
      phase: "formalization",
      prompt: "test",
      retries: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ findings: [{ severity: "info" }] });
  });

  it("rejects non-object payload with schema_validation_error", async () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify("not-an-object"),
      stderr: "",
      timedOut: false,
    });

    const result = await callOpencode({
      model: "m",
      phase: "formalization",
      prompt: "test",
      retries: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema_validation_error");
  });

  it("rejects non-array findings with schema_validation_error", async () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ findings: "not-an-array" }),
      stderr: "",
      timedOut: false,
    });

    const result = await callOpencode({
      model: "m",
      phase: "formalization",
      prompt: "test",
      retries: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema_validation_error");
  });

  it("retries on invalid JSON up to retry limit then fails", async () => {
    traceSpec("FLA-FORMAL-FAIL", "FLA-SAMPLE-EXHAUST");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: "not json at all",
      stderr: "",
      timedOut: false,
    });

    const result = await callOpencode({
      model: "m",
      phase: "formalization",
      prompt: "test",
      retries: 2,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_json");
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("retries on timeout up to retry limit then returns timeout error", async () => {
    traceSpec("FLA-FORMAL-FAIL");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValue({
      exitCode: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      timedOut: true,
    });

    const result = await callOpencode({
      model: "m",
      phase: "formalization",
      prompt: "test",
      retries: 2,
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
    expect(mocked).toHaveBeenCalledTimes(2);
  });
});
