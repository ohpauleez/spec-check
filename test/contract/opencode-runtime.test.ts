import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { traceSpec } from "../support/spec-trace.js";
import {
  detectOpencodeRuntime, formatOpencodeVersion, parseOpencodeVersion, resolveOpencodeRuntime,
  runWithOpencodeRuntime, type OpencodeRuntime,
} from "../../src/adapters/opencode-runtime.js";
import { runProcess } from "../../src/adapters/process.js";
import { callOpencode } from "../../src/adapters/opencode.js";
import { normalizeOpencodeModel } from "../../src/domain/opencode-model.js";
import { decideBatchDegradation } from "../../src/domain/formal/degradation.js";

vi.mock("../../src/adapters/process.js", () => ({ runProcess: vi.fn() }));
const completed = { exitCode: 0, signal: null, stdout: "opencode v2.0.15\n", stderr: "", timedOut: false } as const;
const v1: OpencodeRuntime = { binaryPath: "/v1", version: "1.19.3", major: 1 };
const v2: OpencodeRuntime = { binaryPath: "/v2", version: "2.0.15", major: 2 };

describe("OpenCode runtime compatibility", () => {
  beforeEach(() => { vi.mocked(runProcess).mockReset(); });

  it.each(["1.19.3", "v1.19.3", "opencode v2.0.15", "opencode 2.0.15-rc.1+build.07\r\n"])("accepts the complete release grammar: %s", (raw) => {
    traceSpec("CAT-OC-VERSION", "CAT-OC-VERSION-ACCEPT");
    const result = parseOpencodeVersion(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.version).toBe(raw.replace(/^opencode /u, "").replace(/^v/u, "").trim());
  });

  it.each(["banner 2.0.15", "2.0.15 suffix", "2.0.15\n1.19.3", "02.0.15", "2.0.15-01", "2.0.15-a..b", "2.0.15+", "2.9007199254740992.0", "OpenCode v2.0.15"])("rejects invalid release output: %s", (raw) => {
    traceSpec("CAT-OC-VERSION-REJECT");
    expect(parseOpencodeVersion(raw)).toMatchObject({ ok: false, error: { kind: "invalid_version" } });
  });

  it("uses exact dependency bounds and fails closed on unknown majors", async () => {
    traceSpec("CAT-CLI-DEPS", "CAT-OC-VERSION", "CAT-OC-VERSION-REJECT");
    vi.mocked(runProcess).mockResolvedValue({ ...completed, stdout: "3.0.0" });
    expect(await detectOpencodeRuntime("/selected")).toMatchObject({ ok: false, error: { kind: "unsupported_major" } });
    expect(runProcess).toHaveBeenCalledWith("/selected", ["--version"], { timeoutMs: 5000, maxOutputBytes: 16384 });
  });

  it.each([
    [{ timedOut: true, exitCode: null }, "timeout"],
    [{ outputLimitExceeded: true, exitCode: null }, "output_limit"],
    [{ exitCode: 1 }, "spawn_error"],
    [{ signal: "SIGTERM" as const }, "spawn_error"],
    [{ stdoutInvalidUtf8: true }, "invalid_version"],
  ] as const)("classifies failed probe %o", async (fields, kind) => {
    traceSpec("CAT-OC-VERSION-REJECT");
    vi.mocked(runProcess).mockResolvedValue({ ...completed, ...fields });
    expect(await detectOpencodeRuntime()).toMatchObject({ ok: false, error: { kind } });
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it("normalizes spawn failures into inert bounded diagnostics", async () => {
    traceSpec("CAT-OC-VERSION-REJECT");
    vi.mocked(runProcess).mockRejectedValue(new Error(`EACCES\u001b[31m${"x".repeat(1000)}`));
    const result = await detectOpencodeRuntime();
    expect(result).toMatchObject({ ok: false, error: { kind: "spawn_error" } });
    if (!result.ok) {
      expect(result.error.message).not.toContain("\u001b");
      expect(result.error.message.length).toBeLessThan(400);
    }
  });

  it("bounds both displayed version forms while preserving full supported identity", async () => {
    traceSpec("CAT-OC-VERSION-ACCEPT", "CAT-OC-VERSION-REJECT", "CAT-OC-VERSION-PREVIEW");
    const suffix = "a".repeat(15000);
    const supported = `2.0.15+${suffix}`;
    vi.mocked(runProcess).mockResolvedValue({ ...completed, stdout: supported });
    expect(await detectOpencodeRuntime()).toMatchObject({ ok: true, value: { version: supported } });
    expect(formatOpencodeVersion(supported)).toHaveLength(300);
    const unsupported = parseOpencodeVersion(`3.0.0+${suffix}`);
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error.message.length).toBeLessThan(400);
    expect(decideBatchDegradation("output_limit", true)).toEqual({ kind: "emit_claim_errors" });
  });

  it("prioritizes an explicit runtime and rejects selected-binary mismatch before probing", async () => {
    traceSpec("CAT-OC-RUNTIME", "CAT-OC-RUNTIME-DIRECT", "CAT-OC-RUNTIME-MISMATCH");
    await runWithOpencodeRuntime(v1, async () => {
      expect(await resolveOpencodeRuntime({ runtime: v2 })).toEqual({ ok: true, value: v2 });
      expect(await resolveOpencodeRuntime({ binaryPath: "/other" })).toMatchObject({ ok: false, error: { kind: "runtime_mismatch" } });
      expect(await resolveOpencodeRuntime({ runtime: v2, binaryPath: "/v1" })).toMatchObject({ ok: false });
    });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("isolates nested and interleaved scopes under generated schedules", async () => {
    traceSpec("CAT-OC-RUNTIME-ISOLATE", "CAT-OC-RUNTIME-REUSE");
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), async (schedule) => {
      const observe = async (runtime: OpencodeRuntime): Promise<void> => {
        await runWithOpencodeRuntime(runtime, async () => {
          for (const yieldNow of schedule) {
            if (yieldNow) await Promise.resolve();
            expect(await resolveOpencodeRuntime()).toEqual({ ok: true, value: runtime });
          }
          await runWithOpencodeRuntime(runtime === v1 ? v2 : v1, async () => {
            expect(await resolveOpencodeRuntime()).toEqual({ ok: true, value: runtime === v1 ? v2 : v1 });
          });
          expect(await resolveOpencodeRuntime()).toEqual({ ok: true, value: runtime });
        });
      };
      await Promise.all([observe(v1), observe(v2)]);
    }), { numRuns: 30 });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("detects once per direct logical call and retains the protocol across retries", async () => {
    traceSpec("CAT-OC-RUNTIME-DIRECT", "CAT-OC-INVOKE", "CAT-OC-INVOKE-RETRY", "CAT-OC-RUNTIME-REUSE");
    vi.mocked(runProcess)
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce({ ...completed, exitCode: 1 })
      .mockResolvedValueOnce({ ...completed, stdout: '{"type":"text","part":{"text":"{\\"findings\\":[]}"}}' });
    const result = await callOpencode({ model: "github-copilot/gpt-5.6-terra", phase: "qualitative-review", prompt: "p", retries: 2, backoffDelay: async () => {} });
    expect(result.ok).toBe(true);
    expect(vi.mocked(runProcess).mock.calls.map((call) => call[1][0])).toEqual(["--version", "run", "run"]);
    expect(vi.mocked(runProcess).mock.calls[1]?.[1]).toEqual(vi.mocked(runProcess).mock.calls[2]?.[1]);
    expect(vi.mocked(runProcess).mock.calls[1]?.[1]).toContain("github-copilot/gpt-5.6-terra#high");
    vi.mocked(runProcess).mockResolvedValue(completed);
    await resolveOpencodeRuntime();
    expect(runProcess).toHaveBeenCalledTimes(4);
  });

  it("returns terminal runtime failure without response degradation", async () => {
    traceSpec("CAT-OC-RUNTIME-FAIL");
    vi.mocked(runProcess).mockResolvedValue({ ...completed, stdout: "unknown" });
    expect(await callOpencode({ model: "m", phase: "formalization", prompt: "p" })).toMatchObject({ ok: false, error: { kind: "runtime_error", cause: { kind: "invalid_version" } } });
    expect(runProcess).toHaveBeenCalledOnce();
    expect(decideBatchDegradation("runtime_error", true)).toEqual({ kind: "emit_claim_errors" });
  });

  it.each(["provider/model#", "provider/model#a#b", "/model#high", "provider/#high", "p/m# high", "github-copilot/gpt-5.6-terra#max"])("rejects invalid model before any process: %s", async (model) => {
    traceSpec("CAT-OC-MODEL", "CAT-OC-MODEL-INVALID");
    expect(normalizeOpencodeModel(model).ok).toBe(false);
    expect(await callOpencode({ model, phase: "formalization", prompt: "p" })).toMatchObject({ ok: false, error: { kind: "invalid_model" } });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("preserves bare models and round-trips generated explicit selections", () => {
    traceSpec("CAT-OC-MODEL-BARE", "CAT-OC-MODEL-EXPLICIT");
    expect(normalizeOpencodeModel("test-model")).toEqual({ ok: true, value: { model: "test-model" } });
    expect(normalizeOpencodeModel("github-copilot/gpt-5.6-luna")).toEqual({ ok: true, value: { model: "github-copilot/gpt-5.6-luna", variant: "max" } });
    expect(normalizeOpencodeModel("github-copilot/gpt-5.6-terra#high").ok).toBe(true);
    fc.assert(fc.property(fc.array(fc.constantFrom("a", "Z", "0", "-"), { minLength: 1, maxLength: 15 }), (letters) => {
      const variant = letters.join("");
      expect(normalizeOpencodeModel(`provider/family/model#${variant}`)).toEqual({ ok: true, value: { model: "provider/family/model", variant } });
    }));
  });
});
