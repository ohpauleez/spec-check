import { beforeEach, describe, expect, it, vi } from "vitest";
import { callOpencode } from "../support/opencode-runtime.js";
import type { OpencodeEvidenceEvent } from "../../src/adapters/opencode.js";
import { traceSpec } from "../support/spec-trace.js";

vi.mock("../../src/adapters/process.js", () => ({ runProcess: vi.fn() }));

describe("raw model attempt capture precedes validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures rejected JSON, retry and accepted data with exact attempt identity", async () => {
    traceSpec("RAE-ATTEMPT-ALL-PATHS", "RAE-QUERY-EXACT");
    const { runProcess } = await import("../../src/adapters/process.js");
    const process = { exitCode: 0, signal: null, stderr: "", timedOut: false } as const;
    vi.mocked(runProcess).mockResolvedValueOnce({ ...process, stdout: "invalid", stdoutBase64: Buffer.from("invalid").toString("base64") });
    vi.mocked(runProcess).mockResolvedValueOnce({ ...process, stdout: '{"concepts":[]}' });
    const events: OpencodeEvidenceEvent[] = [];
    const result = await callOpencode({ model: "test-model", phase: "concept-discovery", prompt: "p", retries: 2,
      backoffDelay: async () => {}, captureEvidence: (event) => { events.push(event); } });
    expect(result.ok).toBe(true);
    expect(events.map((event) => [event.kind, event.attempt])).toEqual([["captured", 1], ["classified", 1], ["captured", 2], ["classified", 2]]);
    expect(events[0]).toMatchObject({ process: { stdout: "invalid", stdoutBase64: Buffer.from("invalid").toString("base64") } });
    expect(events[1]).toMatchObject({ outcome: "invalid_json" });
    expect(vi.mocked(runProcess).mock.calls[0]?.[2]).toMatchObject({ captureBytes: true });
  });

  it("propagates required evidence failures without a model retry", async () => {
    traceSpec("RAE-EVIDENCE-WRITE");
    const { runProcess } = await import("../../src/adapters/process.js");
    vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: '{"concepts":[]}', stderr: "", timedOut: false });
    const failure = new Error("required persistence failed");
    await expect(callOpencode({ model: "m", phase: "concept-discovery", prompt: "p", retries: 3, captureEvidence: () => { throw failure; } })).rejects.toBe(failure);
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it("records terminal overflow and does not retry captured incomplete bytes", async () => {
    traceSpec("RAE-ATTEMPT-OVERFLOW", "RAE-ATTEMPT-BOUND");
    const { runProcess } = await import("../../src/adapters/process.js");
    vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: null, signal: "SIGKILL", stdout: "partial", stderr: "", timedOut: false, outputLimitExceeded: true });
    const events: OpencodeEvidenceEvent[] = [];
    const result = await callOpencode({ model: "m", phase: "concept-discovery", prompt: "p", retries: 3, captureEvidence: (event) => { events.push(event); } });
    expect(result.ok).toBe(false);
    expect(events[1]).toMatchObject({ kind: "classified", outcome: "output_limit" });
    expect(runProcess).toHaveBeenCalledOnce();
    expect(vi.mocked(runProcess).mock.calls[0]?.[2]?.maxOutputBytes).toBe(8_388_608);
  });
});
