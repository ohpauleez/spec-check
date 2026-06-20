import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { traceSpec } from "../support/spec-trace.js";
import { callOpencode, extractJsonPayload } from "../../src/adapters/opencode.js";

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
    expect(args).toEqual(["run", "hello world", "--model", "test-model", "--format", "json"]);
  });

  it("emits repeated --file flags after prompt", async () => {
    traceSpec("CAT-DEPS-OPENCODE", "STC-SOURCE-FILE-CTX");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "spec-check-opencode-files-"));
    const fileA = join(root, "a.md");
    const fileB = join(root, "b.md");
    await writeFile(fileA, "a", "utf8");
    await writeFile(fileB, "b", "utf8");

    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ type: "text", part: { text: "{}" } }),
      stderr: "",
      timedOut: false,
    });

    await callOpencode({
      model: "test-model",
      phase: "qualitative-review",
      prompt: "hello world",
      files: [fileA, fileB],
      retries: 1,
    });

    const [, args] = mocked.mock.calls[0] as [string, readonly string[], unknown];
    expect(args).toEqual(["run", "hello world", "--model", "test-model", "--format", "json", "--file", fileA, "--file", fileB]);
  });

  it("rejects oversized instruction prompt before spawn", async () => {
    traceSpec("CAT-DEPS-OPENCODE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    const result = await callOpencode({
      model: "m",
      phase: "formalization",
      prompt: "x".repeat(40_000),
      retries: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("prompt_too_large");
    expect(mocked).not.toHaveBeenCalled();
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
    traceSpec("CAT-DEPS-OPENCODE", "FLA-JSON-RECOVER");
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

  it("accepts markdown-fenced JSON payloads", async () => {
    traceSpec("FLA-VALIDATE-SAMPLE", "FLA-JSON-FENCE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        type: "text",
        part: { text: "```json\n{\"findings\":[]}\n```" },
      }),
      stderr: "",
      timedOut: false,
    });

    const result = await callOpencode({ model: "m", phase: "formalization", prompt: "test", retries: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ findings: [] });
  });

  it("accepts wrapped prefixed/suffixed JSON payloads", async () => {
    traceSpec("FLA-VALIDATE-SAMPLE", "FLA-JSON-WRAP");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({
        type: "text",
        part: { text: "analysis follows\n{\"findings\":[]}\nthanks" },
      }),
      stderr: "",
      timedOut: false,
    });

    const result = await callOpencode({ model: "m", phase: "formalization", prompt: "test", retries: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ findings: [] });
  });

  it("property: accepts prefix+json wrappers when prefix excludes braces/brackets", async () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 40 }).filter((value) => {
          return !value.includes("[") && !value.includes("]") && !value.includes("{") && !value.includes("}");
        }),
        async (prefix) => {
          mocked.mockResolvedValueOnce({
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              type: "text",
               part: { text: `${prefix}{"findings":[]}` },
            }),
            stderr: "",
            timedOut: false,
          });

          const result = await callOpencode({ model: "m", phase: "formalization", prompt: "test", retries: 1 });
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value).toEqual({ findings: [] });
          }
        },
      ),
      { numRuns: 20 },
    );
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
    traceSpec("FLA-FORMAL-FAIL", "FLA-FORMAL-TIMEOUT");
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
      timeoutMs: 30000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
    expect(mocked).toHaveBeenCalledTimes(2);
  });
});

describe("extractJsonPayload edge cases", () => {
  it("handles nested braces inside JSON string values", () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const input = '{"message": "use {x} and {y} for templates", "findings": []}';
    const result = extractJsonPayload(input);
    expect(result).toEqual({ message: "use {x} and {y} for templates", findings: [] });
  });

  it("handles escaped quotes inside JSON strings", () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const input = '{"text": "she said \\"hello\\"", "findings": []}';
    const result = extractJsonPayload(input);
    expect(result).toEqual({ text: 'she said "hello"', findings: [] });
  });

  it("handles deeply nested objects with multiple brace levels", () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const input = '{"a": {"b": {"c": [1, 2]}}, "findings": []}';
    const result = extractJsonPayload(input);
    expect(result).toEqual({ a: { b: { c: [1, 2] } }, findings: [] });
  });

  it("extracts JSON from prose containing nested braces in strings", () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const input = 'Here is the analysis:\n{"findings": [{"text": "check {config}"}]}';
    const result = extractJsonPayload(input);
    expect(result).toEqual({ findings: [{ text: "check {config}" }] });
  });

  it("throws on truncated JSON (unbalanced braces)", () => {
    traceSpec("FLA-VALIDATE-SAMPLE", "FLA-JSON-FAIL");
    const input = '{"findings": [{"severity": "info"';
    expect(() => extractJsonPayload(input)).toThrow("unable to recover JSON payload");
  });

  it("throws on input with only prose text", () => {
    traceSpec("FLA-VALIDATE-SAMPLE", "FLA-JSON-FAIL");
    const input = "I cannot provide a JSON response for this query.";
    expect(() => extractJsonPayload(input)).toThrow("unable to recover JSON payload");
  });

  it("extracts first JSON object when multiple exist in prose", () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const input = 'first: {"findings": []} second: {"other": true}';
    const result = extractJsonPayload(input);
    expect(result).toEqual({ findings: [] });
  });
});
