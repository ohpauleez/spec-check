import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  runCrossImplication,
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
});
