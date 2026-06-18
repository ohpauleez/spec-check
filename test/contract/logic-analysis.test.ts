import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runLogicAnalysis, type SpecClaimGroup } from "../../src/domain/formal/logic-analysis.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import { toClaimId, toOutputDirPath } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(),
}));

vi.mock("../../src/adapters/fs.js", () => ({
  writeOutputAtomic: vi.fn(async () => undefined),
  resolveConfinedOutputPath: vi.fn((outputDir: string, rel: string) => `${outputDir}/${rel}`),
}));

function makeClaim(claimId: string, obligation: "mandatory" | "advisory" | "informational"): LogicIrClaim {
  return {
    claimId: toClaimId(claimId),
    obligation,
    sorts: [{ name: "S", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

function makeGroup(specFile: string, claims: LogicIrClaim[]): SpecClaimGroup {
  return { specFile, claims };
}

describe("logic-analysis contract (per-spec combined)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mandatory contradiction (unsat) reported at severity error", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-LOGIC-CORE");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n(R1__a0)\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [makeClaim("R1", "mandatory")])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.severity).toBe("error");
    expect(output.findings[0]!.category).toBe("logic.contradiction");
  });

  it("advisory-only contradiction (unsat) reported at severity warning", async () => {
    traceSpec("FLA-LOGIC-ADVISORY");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n(R2__a0)\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [makeClaim("R2", "advisory")])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.severity).toBe("warning");
    expect(output.findings[0]!.category).toBe("logic.contradiction");
  });

  it("timeout/unknown result preserved as inconclusive finding", async () => {
    traceSpec("FLA-LOGIC-TIMEOUT");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "timeout",
      stdout: "",
      stderr: "",
      exitCode: null,
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [makeClaim("R3", "mandatory")])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.category).toBe("logic.inconclusive");
    expect(output.findings[0]!.severity).toBe("warning");
  });

  it("persists SMT-LIB input, stdout, stderr for each spec group", async () => {
    traceSpec("FLA-SOLVER-PERSIST", "FLA-PERSIST-SAT", "FLA-PERSIST-UNSAT");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [makeClaim("R4", "mandatory")])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const writeCall = vi.mocked(writeOutputAtomic);
    // 3 writes per spec group: .smt2, .stdout.txt, .stderr.txt
    expect(writeCall).toHaveBeenCalledTimes(3);
    const paths = writeCall.mock.calls.map((call) => call[1]);
    expect(paths.some((p) => p.endsWith(".smt2"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".stdout.txt"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".stderr.txt"))).toBe(true);
  });

  it("report markdown includes spec file and solver result", async () => {
    traceSpec("FLA-RUN-LOGIC");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [makeClaim("R5", "mandatory")])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.reportMarkdown).toContain("specs/test/spec.md");
    expect(output.reportMarkdown).toContain("SAT");
  });

  it("sat result does not generate contradiction finding", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-LOGIC-SAT");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [makeClaim("R6", "mandatory")])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(0);
  });

  it("multiple claims from same spec combined into one Z3 call", async () => {
    traceSpec("FLA-RUN-LOGIC");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [
        makeClaim("R7", "mandatory"),
        makeClaim("R8", "advisory"),
        makeClaim("R9", "informational"),
      ])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    // Only 1 Z3 call despite 3 claims (all in same spec).
    expect(vi.mocked(runZ3Query)).toHaveBeenCalledTimes(1);
  });

  it("unsat core identifies specific conflicting claims", async () => {
    traceSpec("FLA-LOGIC-CORE");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n(R10__a0 R11__a0)\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [
        makeClaim("R10", "mandatory"),
        makeClaim("R11", "advisory"),
        makeClaim("R12", "informational"),
      ])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(1);
    const finding = output.findings[0]!;
    expect(finding.category).toBe("logic.contradiction");
    // Severity derived from highest-obligation in core (R10 is mandatory → error).
    expect(finding.severity).toBe("error");
    expect(finding.relatedClaimIdentifiers).toContain("R10");
    expect(finding.relatedClaimIdentifiers).toContain("R11");
    // R12 is NOT in the core.
    expect(finding.relatedClaimIdentifiers).not.toContain("R12");
  });

  it("severity derived from highest-obligation in core (advisory when no mandatory in core)", async () => {
    traceSpec("FLA-LOGIC-ADVISORY");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n(R13__a0 R14__a0)\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [
        makeClaim("R13", "advisory"),
        makeClaim("R14", "advisory"),
      ])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings[0]!.severity).toBe("warning");
  });
});
