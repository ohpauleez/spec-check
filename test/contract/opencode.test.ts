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
      stdout: JSON.stringify({ type: "text", part: { text: "{\"result\":\"ok\"}" } }),
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
    expect(args).toEqual(["run", "--model", "test-model", "--format", "json", "hello world"]);
  });

  it("returns ok with parsed JSON from a single text event", async () => {
    traceSpec("CAT-DEPS-OPENCODE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        type: "text",
        part: { text: JSON.stringify({ findings: [{ severity: "info" }] }) },
      }),
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

  it("returns ok with parsed JSON from newline-delimited events", async () => {
    traceSpec("CAT-DEPS-OPENCODE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: [
        JSON.stringify({ type: "step_start", part: { id: "1" } }),
        JSON.stringify({ type: "text", part: { text: "{\"findings\": [" } }),
        JSON.stringify({ type: "text", part: { text: "{\"severity\":\"info\"}] }" } }),
        JSON.stringify({ type: "step_finish", part: { id: "1" } }),
      ].join("\n"),
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
      stdout: JSON.stringify({ type: "text", part: { text: JSON.stringify("not-an-object") } }),
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
      stdout: JSON.stringify({ type: "text", part: { text: JSON.stringify({ findings: "not-an-array" }) } }),
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

  it("rejects event streams with no text payload", async () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: [
        JSON.stringify({ type: "step_start", part: { id: "1" } }),
        JSON.stringify({ type: "step_finish", part: { id: "1" } }),
      ].join("\n"),
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
    expect(result.error.kind).toBe("invalid_json");
  });

  it("rejects text payloads that are not JSON", async () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ type: "text", part: { text: "plain text" } }),
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
    expect(result.error.kind).toBe("invalid_json");
  });

  it("rejects opencode error events as invalid_json failures", async () => {
    traceSpec("CAT-DEPS-OPENCODE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        type: "error",
        timestamp: Date.now(),
        sessionID: "test",
        error: { name: "UnknownError", data: { message: "Model not found: bad-model/." } },
      }),
      stderr: "",
      timedOut: false,
    });

    const result = await callOpencode({
      model: "bad-model",
      phase: "formalization",
      prompt: "test",
      retries: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_json");
    expect(result.error.message).toContain("Model not found");
  });

  it("rejects error events embedded in a multi-line event stream", async () => {
    traceSpec("CAT-DEPS-OPENCODE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: [
        JSON.stringify({ type: "step_start", part: { id: "1" } }),
        JSON.stringify({ type: "error", error: { data: { message: "provider timeout" } } }),
      ].join("\n"),
      stderr: "",
      timedOut: false,
    });

    const result = await callOpencode({
      model: "m",
      phase: "qualitative-review",
      prompt: "test",
      retries: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_json");
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
