import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  runCrossImplication,
  runCapabilityAggregateComparison,
  runBoundedPairwiseComparison,
} from "../../src/domain/code-backwards/cross-implication.js";
import { toOutputDirPath, toRelativePath } from "../../src/domain/branded.js";

import type FsPromises from "node:fs/promises";

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(),
}));

vi.mock("../../src/adapters/fs.js", () => ({
  writeOutputAtomic: vi.fn(async () => undefined),
  resolveConfinedOutputPath: vi.fn((outputDir: string, rel: string) => `${outputDir}/${rel}`),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return {
    ...original,
    readFile: vi.fn(async () => "(assert true)\n(check-sat)"),
  };
});

function makeEntry(capability: string, claimId: string, prefix: string) {
  return { capability, claimId, smtlibPath: toRelativePath(`${prefix}/${capability}/${claimId}.smt2`) };
}

describe("cross-implication contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mutual unsat classifies as same", async () => {
    traceSpec("STC-CROSS-IMPLY", "STC-IMPLY-SAME");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runCrossImplication({
      outputDir: toOutputDirPath("/tmp/test-output"),
      original: [makeEntry("cat", "R1", "smt")],
      generated: [makeEntry("cat", "R1", "gen_smt")],
    });

    expect(output.results.length).toBe(1);
    expect(output.results[0]!.classification).toBe("same");
  });

  it("forward-sat + reverse-unsat classifies as stronger", async () => {
    traceSpec("STC-IMPLY-STRONGER");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const mocked = vi.mocked(runZ3Query);
    // Forward: sat (no), Reverse: unsat (yes) → code-derived is stronger
    mocked
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 });

    const output = await runCrossImplication({
      outputDir: toOutputDirPath("/tmp/test-output"),
      original: [makeEntry("cat", "R1", "smt")],
      generated: [makeEntry("cat", "R1", "gen_smt")],
    });

    expect(output.results[0]!.classification).toBe("stronger");
  });

  it("forward-unsat + reverse-sat classifies as weaker", async () => {
    traceSpec("STC-IMPLY-WEAKER");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const mocked = vi.mocked(runZ3Query);
    // Forward: unsat (yes), Reverse: sat (no) → code-derived is weaker
    mocked
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 });

    const output = await runCrossImplication({
      outputDir: toOutputDirPath("/tmp/test-output"),
      original: [makeEntry("cat", "R1", "smt")],
      generated: [makeEntry("cat", "R1", "gen_smt")],
    });

    expect(output.results[0]!.classification).toBe("weaker");
  });

  it("both sat classifies as different", async () => {
    traceSpec("STC-IMPLY-DIFFERENT");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runCrossImplication({
      outputDir: toOutputDirPath("/tmp/test-output"),
      original: [makeEntry("cat", "R1", "smt")],
      generated: [makeEntry("cat", "R1", "gen_smt")],
    });

    expect(output.results[0]!.classification).toBe("different");
  });

  it("timeout in either direction classifies as uncertain", async () => {
    traceSpec("STC-IMPLY-UNCERTAIN");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const mocked = vi.mocked(runZ3Query);
    mocked
      .mockResolvedValueOnce({ kind: "timeout", stdout: "", stderr: "", exitCode: null })
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 });

    const output = await runCrossImplication({
      outputDir: toOutputDirPath("/tmp/test-output"),
      original: [makeEntry("cat", "R1", "smt")],
      generated: [makeEntry("cat", "R1", "gen_smt")],
    });

    expect(output.results[0]!.classification).toBe("uncertain");
  });

  it("persists forward/reverse queries and outputs", async () => {
    traceSpec("STC-IMPLY-PERSIST");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    await runCrossImplication({
      outputDir: toOutputDirPath("/tmp/test-output"),
      original: [makeEntry("cat", "R1", "smt")],
      generated: [makeEntry("cat", "R1", "gen_smt")],
    });

    const writeMock = vi.mocked(writeOutputAtomic);
    // 4 writes: forward.smt2, reverse.smt2, forward.out.txt, reverse.out.txt
    expect(writeMock).toHaveBeenCalledTimes(4);
    const paths = writeMock.mock.calls.map((call) => call[1]);
    expect(paths.some((p) => p.includes("forward.smt2"))).toBe(true);
    expect(paths.some((p) => p.includes("reverse.smt2"))).toBe(true);
    expect(paths.some((p) => p.includes("forward.out.txt"))).toBe(true);
    expect(paths.some((p) => p.includes("reverse.out.txt"))).toBe(true);
  });

  it("high divergence at error severity when majority weaker/different", async () => {
    traceSpec("STC-DIVERGE-EVIDENCE", "STC-DIVERGE-HIGH");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    // Three claims in same capability: 2 "different" + 1 "same" → majority divergent
    vi.mocked(runZ3Query)
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 });

    const output = await runCrossImplication({
      outputDir: toOutputDirPath("/tmp/test-output"),
      original: [
        makeEntry("cat", "R1", "smt"),
        makeEntry("cat", "R2", "smt"),
        makeEntry("cat", "R3", "smt"),
      ],
      generated: [
        makeEntry("cat", "R1", "gen_smt"),
        makeEntry("cat", "R2", "gen_smt"),
        makeEntry("cat", "R3", "gen_smt"),
      ],
    });

    const divergenceFinding = output.findings.find((f) => f.category === "code_backwards.capability_divergence");
    expect(divergenceFinding).toBeDefined();
    expect(divergenceFinding!.severity).toBe("error");
    expect(divergenceFinding!.description).toContain("high_divergence");
  });

  it("low divergence at info severity when all same/stronger", async () => {
    traceSpec("STC-DIVERGE-LOW");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    // All unsat (mutual) → same classification
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runCrossImplication({
      outputDir: toOutputDirPath("/tmp/test-output"),
      original: [makeEntry("cat", "R1", "smt")],
      generated: [makeEntry("cat", "R1", "gen_smt")],
    });

    const divergenceFinding = output.findings.find((f) => f.category === "code_backwards.capability_divergence");
    expect(divergenceFinding).toBeDefined();
    expect(divergenceFinding!.severity).toBe("info");
    expect(divergenceFinding!.description).toContain("low_divergence");
  });

  it("aggregate comparison combines per-capability assertions", async () => {
    traceSpec("STC-IMPLY-AGGREGATE");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runCapabilityAggregateComparison({
      outputDir: toOutputDirPath("/tmp/test-output"),
      originalByCapability: new Map([["cat", [{ claimId: "R1", smtlibPath: toRelativePath("smt/cat/R1.smt2") }]]]),
      generatedByCapability: new Map([["cat", [{ claimId: "G1", smtlibPath: toRelativePath("gen_smt/cat/G1.smt2") }]]]),
    });

    const agg = output.findings.find((f) => f.category === "code_backwards.capability_aggregate");
    expect(agg).toBeDefined();
    expect(agg!.description).toContain("same");
  });

  it("aggregate reports unmatched capabilities on each side", async () => {
    traceSpec("STC-IMPLY-UNMATCHED-CAP");
    const output = await runCapabilityAggregateComparison({
      outputDir: toOutputDirPath("/tmp/test-output"),
      originalByCapability: new Map([["only-orig", [{ claimId: "R1", smtlibPath: toRelativePath("smt/only-orig/R1.smt2") }]]]),
      generatedByCapability: new Map([["only-gen", [{ claimId: "G1", smtlibPath: toRelativePath("gen_smt/only-gen/G1.smt2") }]]]),
    });

    const novel = output.findings.find((f) => f.category === "code_backwards.novel_capability");
    const unimpl = output.findings.find((f) => f.category === "code_backwards.unimplemented_capability");
    expect(novel).toBeDefined();
    expect(novel!.description).toContain("only-gen");
    expect(unimpl).toBeDefined();
    expect(unimpl!.description).toContain("only-orig");
  });

  it("pairwise skips when pair count exceeds budget", async () => {
    traceSpec("STC-IMPLY-BUDGET");
    const output = await runBoundedPairwiseComparison({
      outputDir: toOutputDirPath("/tmp/test-output"),
      originalByCapability: new Map([["cat", [
        { claimId: "R1", smtlibPath: toRelativePath("smt/cat/R1.smt2") },
        { claimId: "R2", smtlibPath: toRelativePath("smt/cat/R2.smt2") },
        { claimId: "R3", smtlibPath: toRelativePath("smt/cat/R3.smt2") },
      ]]]),
      generatedByCapability: new Map([["cat", [
        { claimId: "G1", smtlibPath: toRelativePath("gen_smt/cat/G1.smt2") },
        { claimId: "G2", smtlibPath: toRelativePath("gen_smt/cat/G2.smt2") },
        { claimId: "G3", smtlibPath: toRelativePath("gen_smt/cat/G3.smt2") },
      ]]]),
      pairBudget: 2, // 3×3=9 exceeds budget of 2
    });

    const skipped = output.findings.find((f) => f.category === "code_backwards.pairwise_skipped");
    expect(skipped).toBeDefined();
    expect(skipped!.description).toContain("exceeds budget");
    expect(output.results.length).toBe(0);
  });

  it("pairwise uses greedy matching to assign best pairs", async () => {
    traceSpec("STC-IMPLY-GREEDY");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const mocked = vi.mocked(runZ3Query);
    // 2 original × 1 generated: R1 vs G1 and R2 vs G1
    // Make R1 vs G1 = same (both unsat), R2 vs G1 = different (both sat)
    // Greedy should pick R1-G1 (score 4) leaving R2 unmatched
    mocked
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 }) // R1→G1 forward
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 }) // R1→G1 reverse
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 })     // R2→G1 forward
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 });    // R2→G1 reverse

    const output = await runBoundedPairwiseComparison({
      outputDir: toOutputDirPath("/tmp/test-output"),
      originalByCapability: new Map([["cat", [
        { claimId: "R1", smtlibPath: toRelativePath("smt/cat/R1.smt2") },
        { claimId: "R2", smtlibPath: toRelativePath("smt/cat/R2.smt2") },
      ]]]),
      generatedByCapability: new Map([["cat", [
        { claimId: "G1", smtlibPath: toRelativePath("gen_smt/cat/G1.smt2") },
      ]]]),
      pairBudget: 200,
    });

    // R1 should be matched (same), R2 should be unmatched
    expect(output.results.length).toBe(1);
    expect(output.results[0]!.claimId).toBe("R1");
    expect(output.results[0]!.classification).toBe("same");

    const unmatched = output.findings.find((f) => f.category === "code_backwards.unmatched_original");
    expect(unmatched).toBeDefined();
    expect(unmatched!.description).toContain("R2");
  });

  it("pairwise reports unmatched claims on both sides", async () => {
    traceSpec("STC-IMPLY-UNMATCHED-CLAIM");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    // 1 original, 2 generated — after matching, 1 generated is unmatched
    const output = await runBoundedPairwiseComparison({
      outputDir: toOutputDirPath("/tmp/test-output"),
      originalByCapability: new Map([["cat", [
        { claimId: "R1", smtlibPath: toRelativePath("smt/cat/R1.smt2") },
      ]]]),
      generatedByCapability: new Map([["cat", [
        { claimId: "G1", smtlibPath: toRelativePath("gen_smt/cat/G1.smt2") },
        { claimId: "G2", smtlibPath: toRelativePath("gen_smt/cat/G2.smt2") },
      ]]]),
      pairBudget: 200,
    });

    // R1 matched to G1 (both "same", greedy picks first alphabetically)
    expect(output.results.length).toBe(1);
    const unmatchedGen = output.findings.find((f) => f.category === "code_backwards.unmatched_generated");
    expect(unmatchedGen).toBeDefined();
  });
});
