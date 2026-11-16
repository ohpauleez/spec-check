import { describe, expect, it } from "vitest";
import { EvidenceRecorder, EvidencePersistenceError } from "../../src/domain/formal/evidence.js";
import { traceSpec } from "../support/spec-trace.js";

describe("bounded exact semantic evidence", () => {
  it("persists exact raw bytes separately from immutable pointer/status metadata", async () => {
    traceSpec("RAE-SEMANTIC-EVIDENCE", "RAE-ATTEMPT-ALL-PATHS", "RAE-EVIDENCE-IDENTITY");
    const writes = new Map<string, string | Uint8Array>();
    const recorder = new EvidenceRecorder(64 * 1_048_576, async (path, value) => { writes.set(path, value); });
    const hooks = recorder.modelHooks("source:call:0");
    expect(await hooks.beforeAttempt!(1)).toBe(true);
    await hooks.captureEvidence!({ kind: "captured", attempt: 1, phase: "formalization", model: "test", prompt: "p", runtime: "1.19.3",
      process: { exitCode: 0, signal: null, timedOut: false, stdout: "�", stderr: "", stdoutBase64: "/w==", stderrBase64: "", stdoutInvalidUtf8: true } });
    await hooks.captureEvidence!({ kind: "classified", attempt: 1, outcome: "invalid_json" });
    const raw = [...writes].find(([path]) => path.endsWith(".stdout.bin"))?.[1];
    expect(raw instanceof Uint8Array && [...raw]).toEqual([255]);
    expect(recorder.modelAttempts()).toBe(1);
    expect(recorder.filesForScope("source:call:0")).toHaveLength(5);
  });

  it("required write failure is an OutputError and cannot finalize a descriptor", async () => {
    traceSpec("RAE-EVIDENCE-WRITE");
    const recorder = new EvidenceRecorder(1_048_576, async () => { throw new Error("disk failure"); });
    await expect(recorder.json("scope", "registry", {})).rejects.toBeInstanceOf(EvidencePersistenceError);
    expect(recorder.files()).toEqual([]);
  });

  it("in-flight bytes remain charged before asynchronous write completion", async () => {
    traceSpec("RAE-EVIDENCE-BUDGET", "RAE-EVIDENCE-ADMISSION");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const recorder = new EvidenceRecorder(10, async () => { await pending; });
    expect(recorder.reserve("first", 10)).toBe(true);
    const write = recorder.text("scope", "input", "0123456789", "logic", "first");
    expect(recorder.reserve("second", 1)).toBe(false);
    release(); await write;
    expect(recorder.files()).toHaveLength(1);
  });
});
