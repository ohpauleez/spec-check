import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { formalizeGeneratedSpecs } from "../../src/domain/code-backwards/gen-formal.js";
import { toModelName, toOutputDirPath } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(),
}));

vi.mock("../../src/adapters/fs.js", () => ({
  writeOutputAtomic: vi.fn(async () => undefined),
  resolveConfinedOutputPath: vi.fn((outputDir: string, rel: string) => `${outputDir}/${rel}`),
}));

function makeValidSample(claimId: string) {
  return {
    ok: true as const,
    value: {
      sample: {
        claimId,
        obligation: "mandatory",
        sorts: [{ name: "S", sort: "Bool" }],
        functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
        assertions: [{ id: "A1", expr: "(f true)" }],
      },
    },
  };
}

describe("gen-formal contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies formalizeClaims with schema validation (same pipeline as specs-forward)", async () => {
    traceSpec("STC-GEN-FORMAL", "STC-FORMAL-STABLE");
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
    });

    expect(output.claims.length).toBe(1);
    expect(output.claims[0]!.capability).toBe("cat-pipeline");
    expect(output.claims[0]!.representative).toBeDefined();
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
    });

    // Graceful degradation: error finding recorded instead of throwing.
    expect(output.findings.some((f) => f.category === "code_derived.formalization_failure")).toBe(true);
    expect(output.claims.length).toBe(0);
  });
});
