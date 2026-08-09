import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { formalizeGeneratedSpecs } from "../../src/domain/code-backwards/gen-formal.js";
import { toClaimId, toModelName, toOutputDirPath } from "../../src/domain/branded.js";
import {
  buildBatchContextFile,
  hashBatchContext,
  serializeBatchContextFile,
} from "../../src/domain/formal/batch-transport.js";

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

function makeValidSample(claimId: string) {
  return {
    ok: true as const,
    value: {
      sample: {
        claimId,
        obligation: "mandatory",
        variables: [{ name: "S", sort: "Bool" }],
        functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
        assertions: [{ id: "A1", expr: "(f true)" }],
      },
    },
  };
}

function makeValidBatch(claimIds: readonly string[]) {
  return {
    ok: true as const,
    value: {
      formalizations: claimIds.map((claimId, index) => ({
        index,
        ...makeValidSample(claimId).value.sample,
      })),
    },
  };
}

describe("gen-formal contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies formalizeClaims with schema validation (same pipeline as specs-forward)", async () => {
    traceSpec("STC-GEN-FORMAL", "STC-FORMAL-STABLE", "STC-FORMAL-TIMEOUT");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(callOpencode).mockResolvedValue(makeValidSample("SRC-R1"));
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
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(callOpencode).mockResolvedValue(makeValidSample("SRC-R1"));
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
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    vi.mocked(callOpencode).mockResolvedValue(makeValidSample("SRC-R1"));
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
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(callOpencode).mockResolvedValue(makeValidSample("SRC-R1"));
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

  it("writes collision-free generated-spec attempt sets and reconstructs each attached context", async () => {
    traceSpec("RAE-FORMAL-ATTEMPT-SETS");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode)
      .mockResolvedValueOnce(makeValidBatch(["SRC-R1", "SRC-R2"]))
      .mockResolvedValueOnce(makeValidBatch(["SRC-R3", "SRC-R4"]));

    const generatedSpecs = [
      {
        capability: "same-capability",
        requirements: [
          { id: "SRC-R1", text: "First durable-secret claim text" },
          { id: "SRC-R2", text: "Second durable-secret claim text" },
        ],
        sourceIdentifiers: [],
      },
      {
        capability: "same-capability",
        requirements: [
          { id: "SRC-R3", text: "Third durable-secret claim text" },
          { id: "SRC-R4", text: "Fourth durable-secret claim text" },
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
    const envelopes = evidenceWrites.map((call) => JSON.parse(call[2]) as {
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
      const reconstructedClaims = attempt.claimIndexes.map((index) => {
        const requirement = spec.requirements[index];
        if (requirement === undefined) throw new Error(`missing generated claim at local index ${String(index)}`);
        return {
          index,
          claim: {
            id: toClaimId(requirement.id),
            obligation: "mandatory" as const,
            provenance: { file: `<gen_specs/${spec.capability}.md>` },
            text: requirement.text,
          },
        };
      });
      const reconstructed = serializeBatchContextFile(
        buildBatchContextFile(attempt.batchKey, reconstructedClaims),
      );
      expect(attempt.claimIndexes).toEqual([0, 1]);
      expect(attempt.claimIds).toEqual(spec.requirements.map((requirement) => requirement.id));
      expect(hashBatchContext(reconstructed)).toBe(attempt.contextSha256);
    }

    const durableBytes = evidenceWrites.map((call) => call[2]).join("\n");
    for (const spec of generatedSpecs) {
      for (const requirement of spec.requirements) {
        expect(durableBytes).not.toContain(requirement.text);
      }
    }
  });
});
