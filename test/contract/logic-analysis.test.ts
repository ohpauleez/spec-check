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
    variables: [{ name: "S", sort: "Bool" }],
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

  it("solver error produces logic.solver_error finding", async () => {
    traceSpec("FLA-LOGIC-ERROR");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "error",
      stdout: "(error \"line 1: unknown sort\")\nsat\n",
      stderr: "",
      exitCode: 0,
      errorCount: 1,
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [makeClaim("R-ERR", "mandatory")])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.category).toBe("logic.solver_error");
    expect(output.findings[0]!.severity).toBe("error");
  });

  it("sat with conditional assertions from different claims triggers pairwise checks", async () => {
    traceSpec("FLA-PAIRWISE", "FLA-PAIRWISE-CONTRA", "FLA-PAIRWISE-SEV");
    const { runZ3Query } = await import("../../src/adapters/z3.js");

    // First call: global SAT. Subsequent calls: pairwise UNSAT (contradiction).
    vi.mocked(runZ3Query)
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 })
      .mockResolvedValue({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 });

    const claimA: LogicIrClaim = {
      claimId: toClaimId("R-A"),
      obligation: "mandatory",
      variables: [
        { name: "GuardA", sort: "Bool" },
        { name: "X", sort: "Bool" },
      ],
      functions: [],
      assertions: [{ id: "A1", expr: "(=> GuardA X)" }],
    };
    const claimB: LogicIrClaim = {
      claimId: toClaimId("R-B"),
      obligation: "advisory",
      variables: [
        { name: "GuardB", sort: "Bool" },
        { name: "X", sort: "Bool" },
      ],
      functions: [],
      assertions: [{ id: "B1", expr: "(=> GuardB (not X))" }],
    };

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const pairwiseFindings = output.findings.filter((f) => f.category === "logic.conditional_contradiction");
    expect(pairwiseFindings.length).toBeGreaterThanOrEqual(1);
    // Severity derived from highest obligation: R-A is mandatory → error.
    expect(pairwiseFindings[0]!.severity).toBe("error");
  });

  it("compatible conditional assertions produce no pairwise finding", async () => {
    traceSpec("FLA-PAIRWISE-COMPAT");
    const { runZ3Query } = await import("../../src/adapters/z3.js");

    // Global SAT, pairwise also SAT (compatible consequents).
    vi.mocked(runZ3Query).mockResolvedValue({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 });

    const claimA: LogicIrClaim = {
      claimId: toClaimId("R-C1"),
      obligation: "mandatory",
      variables: [
        { name: "GuardA", sort: "Bool" },
        { name: "X", sort: "Bool" },
      ],
      functions: [],
      assertions: [{ id: "A1", expr: "(=> GuardA X)" }],
    };
    const claimB: LogicIrClaim = {
      claimId: toClaimId("R-C2"),
      obligation: "mandatory",
      variables: [
        { name: "GuardB", sort: "Bool" },
        { name: "X", sort: "Bool" },
      ],
      functions: [],
      assertions: [{ id: "B1", expr: "(=> GuardB X)" }], // Same consequent — no contradiction.
    };

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const pairwiseFindings = output.findings.filter((f) => f.category === "logic.conditional_contradiction");
    expect(pairwiseFindings.length).toBe(0);
  });

  it("pairwise checks bounded by pair count limit", async () => {
    traceSpec("FLA-PAIRWISE-BOUND");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 });

    // Create many claims — the pairwise check should not explode quadratically.
    const claims: LogicIrClaim[] = Array.from({ length: 20 }, (_, i) => ({
      claimId: toClaimId(`R-BOUND-${i}`),
      obligation: "mandatory" as const,
      variables: [
        { name: `Guard${i}`, sort: "Bool" as const },
        { name: "Y", sort: "Bool" as const },
      ],
      functions: [],
      assertions: [{ id: `A${i}`, expr: `(=> Guard${i} Y)` }],
    }));

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", claims)],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    // Should complete without error — bounded check ensures termination.
    expect(output.reportMarkdown).toContain("SAT");
  });

  it("completeness gap detected when all assertions are conditional", async () => {
    traceSpec("FLA-COMPLETENESS", "FLA-COMPLETENESS-GAP");
    const { runZ3Query } = await import("../../src/adapters/z3.js");

    // Global SAT, pairwise SAT (no contradiction), completeness SAT (gap exists).
    vi.mocked(runZ3Query).mockResolvedValue({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 });

    const claimA: LogicIrClaim = {
      claimId: toClaimId("R-GAP-1"),
      obligation: "mandatory",
      variables: [
        { name: "GuardA", sort: "Bool" },
        { name: "X", sort: "Bool" },
      ],
      functions: [],
      assertions: [{ id: "A1", expr: "(=> GuardA X)" }],
    };
    const claimB: LogicIrClaim = {
      claimId: toClaimId("R-GAP-2"),
      obligation: "mandatory",
      variables: [
        { name: "GuardB", sort: "Bool" },
        { name: "Y", sort: "Bool" },
      ],
      functions: [],
      assertions: [{ id: "B1", expr: "(=> GuardB Y)" }],
    };

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const gapFindings = output.findings.filter((f) => f.category === "logic.completeness_gap");
    expect(gapFindings.length).toBe(1);
    expect(gapFindings[0]!.severity).toBe("warning");
  });

  it("completeness check skipped when ubiquitous assertions exist", async () => {
    traceSpec("FLA-COMPLETENESS-UBIQ");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 });

    const conditionalClaim: LogicIrClaim = {
      claimId: toClaimId("R-UBIQ-COND"),
      obligation: "mandatory",
      variables: [
        { name: "Guard", sort: "Bool" },
        { name: "X", sort: "Bool" },
      ],
      functions: [],
      assertions: [{ id: "A1", expr: "(=> Guard X)" }],
    };
    const ubiquitousClaim: LogicIrClaim = {
      claimId: toClaimId("R-UBIQ-ALWAYS"),
      obligation: "mandatory",
      variables: [{ name: "Y", sort: "Bool" }],
      functions: [],
      assertions: [{ id: "B1", expr: "Y" }], // Unconditional — not an implication.
    };

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [conditionalClaim, ubiquitousClaim])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const gapFindings = output.findings.filter((f) => f.category === "logic.completeness_gap");
    expect(gapFindings.length).toBe(0);
  });

  it("exhaustive guards produce no completeness gap finding", async () => {
    traceSpec("FLA-COMPLETENESS-EXHAUST");
    const { runZ3Query } = await import("../../src/adapters/z3.js");

    // Global SAT, pairwise SAT, completeness UNSAT (guards are exhaustive).
    let callCount = 0;
    vi.mocked(runZ3Query).mockImplementation(async () => {
      callCount++;
      // First call is global check (SAT), pairwise calls are SAT,
      // last call is completeness (UNSAT — guards cover all states).
      if (callCount === 1) {
        return { kind: "sat" as const, stdout: "sat\n", stderr: "", exitCode: 0 };
      }
      // For pairwise: SAT (no contradiction). For completeness: UNSAT (exhaustive).
      // We need to distinguish — pairwise comes before completeness.
      // Since the completeness check is the last query, we can return UNSAT for it.
      // But we don't know the exact call count. Instead, use a simpler approach:
      // return SAT for pairwise, UNSAT for completeness by tracking call purpose.
      // The simplest approach: make all pairwise SAT, then completeness UNSAT.
      return { kind: "sat" as const, stdout: "sat\n", stderr: "", exitCode: 0 };
    });

    // Two claims with guards A and (not A) — exhaustive.
    const claimA: LogicIrClaim = {
      claimId: toClaimId("R-EXHAUST-1"),
      obligation: "mandatory",
      variables: [
        { name: "A", sort: "Bool" },
        { name: "X", sort: "Bool" },
      ],
      functions: [],
      assertions: [{ id: "A1", expr: "(=> A X)" }],
    };
    const claimB: LogicIrClaim = {
      claimId: toClaimId("R-EXHAUST-2"),
      obligation: "mandatory",
      variables: [
        { name: "A", sort: "Bool" },
        { name: "Y", sort: "Bool" },
      ],
      functions: [],
      assertions: [{ id: "B1", expr: "(=> (not A) Y)" }],
    };

    // Reset and set up: global SAT, pairwise SAT, completeness UNSAT (exhaustive).
    vi.mocked(runZ3Query).mockReset();
    vi.mocked(runZ3Query)
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 })  // global
      .mockResolvedValueOnce({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 })  // pairwise
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 }); // completeness

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const gapFindings = output.findings.filter((f) => f.category === "logic.completeness_gap");
    expect(gapFindings.length).toBe(0);
  });
});
