import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeSourceGeneration } from "../../src/adapters/source-generation.js";
import { EvidenceRecorder, EvidencePersistenceError } from "../../src/domain/formal/evidence.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import { traceSpec } from "../support/spec-trace.js";
import type * as ProcessModule from "../../src/adapters/process.js";

const provider = vi.hoisted(() => ({ attempts: 0, fail: "none", files: [] as string[], read: [] as string[], original: "" }));
vi.mock("../../src/adapters/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessModule>();
  return { ...actual, runProcess: vi.fn(async (command, args, options) => {
    if (command !== "opencode") return await actual.runProcess(command, args, options);
    if (args[0] === "--version") return { exitCode: 0, signal: null, timedOut: false, stdout: "1.19.3\n", stderr: "" };
    provider.attempts += 1;
    if (provider.original) await writeFile(provider.original, "changed after capture\n");
    const index = args.indexOf("--file"); const path = args[index + 1]!;
    provider.files.push(path); provider.read.push(await readFile(path, "utf8"));
    const rejected = provider.fail === "all" || (provider.fail === "first" && provider.attempts === 1);
    const stdout = rejected ? "invalid response\n" : JSON.stringify({ type: "text", part: { text: JSON.stringify({ capabilities: [] }) } }) + "\n";
    return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", stdoutBase64: Buffer.from(stdout).toString("base64"), stderrBase64: "" };
  }) };
});

async function inputs(bytes = "export const enabled = true;\n") {
  const root = await mkdtemp("/tmp/opencode/generation-evidence-");
  const absolutePath = join(root, "engine.ts"); await writeFile(absolutePath, bytes);
  return { model: "fixture", timeoutMs: 30_000, prompt: "Use only attached independent source data.", suggestedCapabilities: ["surface"],
    attachments: [{ relativePath: "engine.ts", absolutePath, bytes: Buffer.from(bytes) }] };
}

describe("independent immutable generation evidence", () => {
  beforeEach(() => { vi.clearAllMocks(); provider.attempts = 0; provider.fail = "none"; provider.files = []; provider.read = []; provider.original = ""; });

  it("records selected byte identity and uses the same private bytes across retries despite source mutation", async () => {
    traceSpec("STC-ALIGN-BLIND", "RAE-EVIDENCE-IDENTITY", "RAE-ATTEMPT-ALL-PATHS");
    const input = await inputs(); provider.original = input.attachments[0]!.absolutePath; provider.fail = "first";
    const expected = Buffer.from(input.attachments[0]!.bytes);
    const writes = new Map<string, string | Uint8Array>();
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async (path, content) => {
      writes.set(path, content);
      if (path.endsWith(".source.bin")) input.attachments[0]!.bytes.fill(0);
    });
    const result = await invokeSourceGeneration({ ...input, evidence });
    expect(result.result.ok).toBe(true); expect(provider.attempts).toBe(2);
    expect(provider.read).toEqual([expected.toString("utf8"), expected.toString("utf8")]);
    expect(provider.files[0]).not.toBe(provider.original);
    expect(await readFile(provider.original, "utf8")).toBe("changed after capture\n");
    await expect(access(provider.files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    const request = JSON.parse(String([...writes.entries()].find(([path]) => path.endsWith(".request.json"))![1]));
    expect(request.sources[0].originalPath).toBe(provider.original);
    expect(Buffer.from(writes.get(request.sources[0].artifact) as Uint8Array)).toEqual(expected);
    expect(request.inputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect([...writes.keys()].filter((path) => path.endsWith(".stdout.bin"))).toHaveLength(2);
    expect([...writes.values()].map(String).join("\n")).not.toContain("original requirement secret");
  });

  it("source-only changes alter request identity under identical normalized model output", async () => {
    traceSpec("STC-ALIGN-BLIND", "RAE-EVIDENCE-IDENTITY");
    const input = await inputs(); const hashes: string[] = [];
    for (const code of ["export const n = 1;", "export const n = 2;"]) {
      const writes = new Map<string, string | Uint8Array>();
      const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async (path, content) => { writes.set(path, content); });
      const result = await invokeSourceGeneration({ ...input, attachments: [{ ...input.attachments[0]!, bytes: Buffer.from(code) }], evidence });
      expect(result.result).toEqual({ ok: true, value: { capabilities: [] } });
      hashes.push(JSON.parse(String([...writes.entries()].find(([path]) => path.endsWith(".request.json"))![1])).inputSha256);
    }
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it.each([1, 1_048_576])("evidence budget %i prevents an unrecordable model attempt", async (maxBytes) => {
    traceSpec("RAE-EVIDENCE-BUDGET");
    const evidence = new EvidenceRecorder(maxBytes, async () => undefined);
    const result = await invokeSourceGeneration({ ...await inputs(), evidence });
    expect(result.result.ok).toBe(false); expect(provider.attempts).toBe(0);
    expect(evidence.skipped.length).toBeGreaterThan(0);
  });

  it("required input persistence failure propagates before any attempt", async () => {
    traceSpec("RAE-EVIDENCE-WRITE");
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async () => { throw new Error("injected write failure"); });
    await expect(invokeSourceGeneration({ ...await inputs(), evidence })).rejects.toBeInstanceOf(EvidencePersistenceError);
    expect(provider.attempts).toBe(0);
  });

  it("all rejected attempts retain raw/status evidence and private attachments are cleaned", async () => {
    traceSpec("RAE-ATTEMPT-ALL-PATHS");
    provider.fail = "all";
    const writes = new Map<string, string | Uint8Array>();
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async (path, content) => { writes.set(path, content); });
    const result = await invokeSourceGeneration({ ...await inputs(), evidence });
    expect(result.result.ok).toBe(false); expect(provider.attempts).toBe(2);
    expect([...writes.keys()].filter((path) => path.endsWith(".stdout.bin"))).toHaveLength(2);
    expect([...writes.keys()].filter((path) => path.endsWith(".classified.json"))).toHaveLength(2);
    await expect(access(provider.files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
