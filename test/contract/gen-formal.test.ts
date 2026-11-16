import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { formalizeGeneratedSpecs } from "../../src/domain/code-backwards/gen-formal.js";
import { toModelName, toOutputDirPath } from "../../src/domain/branded.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { EvidenceRecorder } from "../../src/domain/formal/evidence.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(),
}));

vi.mock("../../src/adapters/fs.js", () => ({
  writeOutputAtomic: vi.fn(async () => undefined),
  resolveConfinedOutputPath: vi.fn((outputDir: string, rel: string) => `${outputDir}/${rel}`),
  sha256Hex: vi.fn(() => "a".repeat(64)),
}));

const capturedContexts: string[] = [];

/** Mock the new provider wire protocol, independently of source lowering. */
async function installPredicateMock(): Promise<void> {
  const { callOpencode } = await import("../../src/adapters/opencode.js");
  vi.mocked(callOpencode).mockImplementation(async (options) => {
    const text = await readFile(options.files![0]!, "utf8");
    const context = JSON.parse(text);
    if (options.phase === "concept-discovery") return { ok: true, value: { concepts: context.claims.flatMap((claim: { source: { file: string; ordinal: number; namespace?: string }; clauses: Record<string, string> }) => Object.entries(claim.clauses).filter(([slot]) => slot === "trigger" || slot === "response").map(([slot, term]) => ({
      name: `${slot === "trigger" ? "Trigger" : "Response"}${claim.source.ordinal}`, definition: `${slot} ${claim.source.ordinal}`, role: slot === "trigger" ? "event" : "output", sort: "Bool", source: claim.source, term,
    }))) } };
    capturedContexts.push(text);
    return { ok: true, value: { formalizations: context.claims.map((claim: { index: number; source: { ordinal: number }; predicates: Record<string, string> }) => ({ index: claim.index, registryHash: context.registry.hash,
      predicates: Object.fromEntries(Object.keys(claim.predicates).map((slot) => [slot, `${slot === "trigger" ? "Trigger" : "Response"}${claim.source.ordinal}`])),
    })) } };
  });
}

describe("gen-formal contract", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capturedContexts.length = 0;
    await installPredicateMock();
  });

  it("generated multi-sample publication retains unstable assessment in selection evidence and SMT", async () => {
    traceSpec("STC-FORMAL-AMBIG", "FLA-CLUSTER-DIVERGE");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    const normal = vi.mocked(callOpencode).getMockImplementation()!;
    let samples = 0;
    vi.mocked(callOpencode).mockImplementation(async (options) => {
      const result = await normal(options);
      if (options.phase !== "concept-discovery" && result.ok && ++samples === 2) {
        const context = JSON.parse(await readFile(options.files![0]!, "utf8"));
        return { ok: true, value: { formalizations: context.claims.map((claim: { index: number; source: { ordinal: number } }) => ({ index: claim.index, registryHash: context.registry.hash,
          predicates: { response: `(not Response${claim.source.ordinal})` } })) } };
      }
      return result;
    });
    vi.mocked(runZ3Query).mockResolvedValue({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 });
    const writes = new Map<string, string | Uint8Array>();
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async (path, content) => { writes.set(path, content); });
    const output = await formalizeGeneratedSpecs({ outputDir: toOutputDirPath("/tmp/test-output"), generatedSpecs: [{ capability: "surface", requirements: [{ id: "SRC-R1", text: "THE engine SHALL respond." }], sourceIdentifiers: [] }],
      model: toModelName("fixture"), timeoutMs: 30_000, samplesPerClaim: 2, evidence });
    expect(output.claims[0]?.representative.interpretationAssessment).toMatchObject({ stability: "unstable", selectedSample: 0, sampleCount: 2 });
    expect(output.claims[0]?.representative.staticRule?.interpretationDependent).toBe(true);
    expect([...writes.entries()].find(([path]) => path.endsWith(".selection.json"))?.[1]).toContain('"unstable"');
    expect(vi.mocked(writeOutputAtomic).mock.calls.find((call) => call[1].endsWith(".smt2"))?.[2]).toContain('"stability":"unstable"');
  });

  it("applies formalizeClaims with schema validation (same pipeline as specs-forward)", async () => {
    traceSpec("STC-GEN-FORMAL", "STC-FORMAL-STABLE", "STC-FORMAL-TIMEOUT");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await formalizeGeneratedSpecs({
      outputDir: toOutputDirPath("/tmp/test-output"),
      generatedSpecs: [{ capability: "cat-pipeline", requirements: [{ id: "SRC-R1", text: "WHEN pipeline runs, THE system SHALL produce output." }], sourceIdentifiers: ["SRC-R1"] }],
      model: toModelName("test-model"),
      timeoutMs: 123456,
    });

    expect(output.claims.length).toBe(1);
    expect(output.claims[0]!.capability).toBe("cat-pipeline");
    expect(output.claims[0]!.representative).toBeDefined();
    expect(vi.mocked(callOpencode).mock.calls[0]?.[0].timeoutMs).toBe(123456);
  });

  it("applies clustering with stability threshold 0.6", async () => {
    traceSpec("STC-GEN-FORMAL", "STC-FORMAL-STABLE");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    // All unsat → single stable cluster
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await formalizeGeneratedSpecs({
      outputDir: toOutputDirPath("/tmp/test-output"),
      generatedSpecs: [{ capability: "cat-pipeline", requirements: [{ id: "SRC-R1", text: "WHEN pipeline runs, THE system SHALL produce output." }], sourceIdentifiers: ["SRC-R1"] }],
      model: toModelName("test-model"),
      timeoutMs: 300000,
    });

    // Should succeed with no ambiguity findings
    expect(output.findings.every((f) => f.category !== "formalization.ambiguity")).toBe(true);
  });

  it("persists SMT-LIB to gen_specs_smt/{capability}/{claimId}.smt2", async () => {
    traceSpec("STC-GEN-FORMAL");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    await formalizeGeneratedSpecs({
      outputDir: toOutputDirPath("/tmp/test-output"),
      generatedSpecs: [{ capability: "cat-pipeline", requirements: [{ id: "SRC-R1", text: "WHEN pipeline runs, THE system SHALL produce output." }], sourceIdentifiers: ["SRC-R1"] }],
      model: toModelName("test-model"),
      timeoutMs: 300000,
    });

    const writeMock = vi.mocked(writeOutputAtomic);
    const smtPaths = writeMock.mock.calls.map((call) => call[1]).filter((p) => p.includes("gen_specs_smt"));
    expect(smtPaths.length).toBeGreaterThan(0);
    expect(smtPaths[0]).toMatch(/^gen_specs_smt\/cat-pipeline\/.+\.smt2$/u);
  });

  it("with single sample clustering never produces ambiguity finding", async () => {
    traceSpec("STC-FORMAL-AMBIG");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    // With samplesPerClaim: 1, clustering is trivial — no pairwise checks needed.
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await formalizeGeneratedSpecs({
      outputDir: toOutputDirPath("/tmp/test-output"),
      generatedSpecs: [{ capability: "cat-pipeline", requirements: [{ id: "SRC-R1", text: "WHEN pipeline runs, THE system SHALL produce output." }], sourceIdentifiers: ["SRC-R1"] }],
      model: toModelName("test-model"),
      timeoutMs: 300000,
    });

    expect(output.findings.some((f) => f.category === "formalization.ambiguity")).toBe(false);
  });

  it("records error finding on formalization failure (all samples invalid)", async () => {
    traceSpec("STC-FORMAL-FAIL");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    // Return invalid samples (missing required fields)
    vi.mocked(callOpencode).mockResolvedValue({
      ok: true as const,
      value: { sample: { claimId: "SRC-R1" } },
    });

    const output = await formalizeGeneratedSpecs({
      outputDir: toOutputDirPath("/tmp/test-output"),
      generatedSpecs: [{ capability: "cat-pipeline", requirements: [{ id: "SRC-R1", text: "WHEN pipeline runs, THE system SHALL produce output." }], sourceIdentifiers: ["SRC-R1"] }],
      model: toModelName("test-model"),
      timeoutMs: 300000,
    });

    // Graceful degradation: error finding recorded instead of throwing.
    expect(output.findings.some((f) => f.category === "code_derived.formalization_failure")).toBe(true);
    expect(output.claims.length).toBe(0);
  });

  it("retains unsupported generated prose as excluded source scope", async () => {
    traceSpec("STC-FORMAL-ELIGIBILITY");
    const output = await formalizeGeneratedSpecs({ outputDir: toOutputDirPath("/tmp/gen-formal-test"), generatedSpecs: [{ capability: "unsupported", requirements: [{ id: "SRC-R1", text: "Unsupported prose about a deadline." }], sourceIdentifiers: [] }], model: toModelName("test-model"), timeoutMs: 300000 });
    expect(output.claims).toEqual([]);
    expect(output.findings.some((finding) => finding.category === "code_derived.formalization_ineligible")).toBe(true);
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    expect(callOpencode).not.toHaveBeenCalled();
  });

  it("writes collision-free generated-spec attempt sets and reconstructs each attached context", async () => {
    traceSpec("RAE-FORMAL-ATTEMPT-SETS");

    const generatedSpecs = [
      {
        capability: "same-capability",
        requirements: [
          { id: "SRC-R1", text: "WHEN first, THE engine SHALL retain first durable-secret claim text." },
          { id: "SRC-R2", text: "WHEN second, THE engine SHALL retain second durable-secret claim text." },
        ],
        sourceIdentifiers: [],
      },
      {
        capability: "same-capability",
        requirements: [
          { id: "SRC-R3", text: "WHEN third, THE engine SHALL retain third durable-secret claim text." },
          { id: "SRC-R4", text: "WHEN fourth, THE engine SHALL retain fourth durable-secret claim text." },
        ],
        sourceIdentifiers: [],
      },
    ];

    const output = await formalizeGeneratedSpecs({
      outputDir: toOutputDirPath("/tmp/test-output"),
      generatedSpecs,
      model: toModelName("test-model"),
      timeoutMs: 300000,
    });

    expect(output.evidenceFiles).toHaveLength(2);
    expect(output.evidenceFiles[0]?.path).not.toBe(output.evidenceFiles[1]?.path);
    expect(output.evidenceFiles.map((file) => file.path)).toEqual([
      "formalization_evidence/generated_spec_000000_73616d652d6361706162696c697479.json",
      "formalization_evidence/generated_spec_000001_73616d652d6361706162696c697479.json",
    ]);
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    const evidenceWrites = vi.mocked(writeOutputAtomic).mock.calls.filter((call) => {
      return call[1].startsWith("formalization_evidence/");
    });
    const envelopes = evidenceWrites.map((call) => JSON.parse(typeof call[2] === "string" ? call[2] : Buffer.from(call[2]).toString("utf8")) as {
      readonly schemaVersion: number;
      readonly claimSet: { readonly kind: string; readonly ordinal: number; readonly capability: string };
      readonly attempts: readonly {
        readonly batchKey: string;
        readonly claimIndexes: readonly number[];
        readonly claimIds: readonly (string | null)[];
        readonly contextSha256: string;
      }[];
    });
    expect(envelopes.map((envelope) => envelope.claimSet)).toEqual([
      { kind: "generated_spec", ordinal: 0, capability: "same-capability" },
      { kind: "generated_spec", ordinal: 1, capability: "same-capability" },
    ]);
    expect(envelopes.every((envelope) => envelope.schemaVersion === 1)).toBe(true);
    expect(envelopes.every((envelope) => envelope.attempts.length === 1)).toBe(true);

    for (const envelope of envelopes) {
      const spec = generatedSpecs[envelope.claimSet.ordinal];
      const attempt = envelope.attempts[0];
      expect(spec).toBeDefined();
      expect(attempt).toBeDefined();
      if (spec === undefined || attempt === undefined) continue;
      const reconstructed = capturedContexts[envelope.claimSet.ordinal];
      expect(reconstructed).toBeDefined();
      const context = JSON.parse(reconstructed!) as { claims: { source: { namespace: string }; predicates: { response: string } }[] };
      expect(context.claims.every((claim) => claim.source.namespace === `generated_spec:${envelope.claimSet.ordinal}:${spec.capability}`)).toBe(true);
      expect(attempt.claimIndexes).toEqual([0, 1]);
      expect(attempt.claimIds).toEqual(spec.requirements.map((requirement) => requirement.id));
      expect(createHash("sha256").update(reconstructed!).digest("hex")).toBe(attempt.contextSha256);
    }

    const durableBytes = evidenceWrites.map((call) => call[2]).join("\n");
    for (const spec of generatedSpecs) {
      for (const requirement of spec.requirements) {
        expect(durableBytes).not.toContain(requirement.text);
      }
    }
  });
});
