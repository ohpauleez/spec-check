import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  conflictToFinding,
  FORMAL_PAIR_BUDGET,
  preflightGroupBounds,
  preflightGroupClaimIds,
  runLogicAnalysis,
  runPairwiseContradictionChecks,
  type SpecClaimGroup,
} from "../../src/domain/formal/logic-analysis.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import { CLAIMS_PER_GROUP_MAX, DECLARATIONS_PER_CLAIM_MAX } from "../../src/domain/formal/smtlib.js";
import { toClaimId, toOutputDirPath } from "../../src/domain/branded.js";
import type { Finding } from "../../src/domain/findings.js";
import type { Z3Result } from "../../src/adapters/z3.js";

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

type Z3Kind = "sat" | "unsat" | "unknown" | "timeout" | "error";

/**
 * Install a content-inspecting mock for `runZ3Query`. The classifier decides the
 * verdict from the SMT-LIB text, so tests stay robust to call ordering and the
 * two-phase pairwise check — unlike brittle `mockResolvedValueOnce` chains.
 *
 * Discriminator: the global consistency query is the only one containing
 * `:named` (compiled assertions are emitted as `(assert (! <expr> :named ...))`);
 * every sub-check query (pairwise phase 1/2, completeness) uses plain
 * `(assert ...)` over sanitized expressions.
 */
async function mockZ3ByContent(classify: (smtlib: string) => Z3Kind): Promise<void> {
  const { runZ3Query } = await import("../../src/adapters/z3.js");
  vi.mocked(runZ3Query).mockImplementation(async (query) => {
    const kind = classify(query.smtlib);
    return {
      kind,
      stdout: kind === "unsat" ? "unsat\n(R__a0)\n" : `${kind}\n`,
      stderr: "",
      exitCode: kind === "timeout" ? null : 0,
      ...(kind === "error" ? { errorCount: 1 } : {}),
    };
  });
}

/** Return the SMT-LIB text of every `runZ3Query` invocation recorded so far. */
async function recordedZ3Queries(): Promise<readonly string[]> {
  const { runZ3Query } = await import("../../src/adapters/z3.js");
  return vi.mocked(runZ3Query).mock.calls.map((call) => call[0].smtlib);
}

/** Sub-check queries are every recorded query except the labeled global check. */
async function recordedSubCheckQueries(): Promise<readonly string[]> {
  const queries = await recordedZ3Queries();
  return queries.filter((smtlib) => !smtlib.includes(":named"));
}

/** Build a single-assertion claim with explicit variable/function symbols. */
function implClaim(
  claimId: string,
  assertion: string,
  symbols: {
    readonly variables?: LogicIrClaim["variables"];
    readonly functions?: LogicIrClaim["functions"];
    readonly obligation?: LogicIrClaim["obligation"];
  },
): LogicIrClaim {
  return {
    claimId: toClaimId(claimId),
    obligation: symbols.obligation ?? "mandatory",
    variables: symbols.variables ?? [],
    functions: symbols.functions ?? [],
    assertions: [{ id: "A1", expr: assertion }],
  };
}

/**
 * Select the `logic.inconclusive` findings raised by a specific sub-check.
 *
 * Sub-check inconclusive findings (pairwise / completeness) carry a `check_type`
 * evidence entry; the group-level global-consistency inconclusive finding does
 * not, so filtering on `check_type` cleanly isolates the sub-check diagnostics.
 */
function inconclusiveFindingsFor(
  findings: readonly Finding[],
  checkType: "pairwise" | "completeness",
): readonly Finding[] {
  return findings.filter(
    (f) =>
      f.category === "logic.inconclusive" &&
      f.evidence.some((e) => e.kind === "check_type" && e.value === checkType),
  );
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
    traceSpec("FLA-LOGIC-ERROR", "FLA-SPEC-DANGLING-REF");
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

    // Content-inspecting mock (Test plan #13): global check is SAT; the pair's
    // guards co-activate (phase 1 SAT); their consequents conflict (phase 2, the
    // only query mentioning `(not X)`, is UNSAT). Robust to call ordering.
    await mockZ3ByContent((smtlib) => {
      if (smtlib.includes(":named")) return "sat";
      if (smtlib.includes("(not X)")) return "unsat";
      return "sat";
    });

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

    // Content-inspecting mock (Test plan #13): global check is SAT; every
    // sub-check is UNSAT. The pair's guards `A` and `(not A)` cannot co-activate
    // (phase 1 UNSAT → phase 2 skipped), and negating both guards is UNSAT
    // (guards are exhaustive → no completeness gap).
    await mockZ3ByContent((smtlib) => (smtlib.includes(":named") ? "sat" : "unsat"));

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

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const gapFindings = output.findings.filter((f) => f.category === "logic.completeness_gap");
    expect(gapFindings.length).toBe(0);
  });

  it("rejects duplicate raw claim IDs as invalid group before compile and solver work", async () => {
    traceSpec("FLA-SPEC-DUPLICATE-CLAIM-ID");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [
        makeClaim("R-DUP", "mandatory"),
        makeClaim("R-DUP", "advisory"),
      ])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]!.category).toBe("logic.invalid_group");
    expect(vi.mocked(runZ3Query)).not.toHaveBeenCalled();
    expect(vi.mocked(writeOutputAtomic)).not.toHaveBeenCalled();
  });

  it("maps each merge conflict kind to merge_conflict finding with stable evidence", () => {
    traceSpec("FLA-SPEC-CONFLICT", "FLA-SPEC-VARSORT-CONFLICT", "FLA-SPEC-SYMKIND-CONFLICT");

    const functionConflict = conflictToFinding("specs/test/spec.md", {
      kind: "function_signature_mismatch",
      sanitizedName: "f" as never,
      existingFunctionName: "f",
      conflictingFunctionName: "f",
      existingClaimId: "R1",
      excludedClaimId: "R2",
      claimIds: ["R1", "R2"],
    });
    expect(functionConflict.category).toBe("logic.merge_conflict");
    expect(functionConflict.severity).toBe("error");

    const variableConflict = conflictToFinding("specs/test/spec.md", {
      kind: "variable_sort_mismatch",
      sanitizedName: "v" as never,
      existingVariableName: "v",
      conflictingVariableName: "v",
      expectedSort: "Bool",
      conflictingSort: "Int",
      existingClaimId: "R1",
      excludedClaimId: "R2",
      claimIds: ["R1", "R2"],
    });
    expect(variableConflict.category).toBe("logic.merge_conflict");
    expect(variableConflict.evidence.some((item) => item.kind === "expected_sort")).toBe(true);

    const symbolKindConflict = conflictToFinding("specs/test/spec.md", {
      kind: "symbol_kind_collision",
      sanitizedName: "s" as never,
      existingSymbolName: "s",
      existingSymbolKind: "variable",
      conflictingSymbolName: "s",
      conflictingSymbolKind: "function",
      existingClaimId: "R1",
      excludedClaimId: "R2",
      claimIds: ["R1", "R2"],
    });
    expect(symbolKindConflict.category).toBe("logic.merge_conflict");
    expect(symbolKindConflict.evidence.some((item) => item.kind === "existing_symbol_kind")).toBe(true);
  });

  it("detects constructed sanitized-id collision in preflight", () => {
    traceSpec("FLA-SPEC-DUPLICATE-CLAIM-ID");
    const claims = [
      makeClaim("RAW-1", "mandatory"),
      makeClaim("RAW-2", "mandatory"),
    ];

    const issue = preflightGroupClaimIds(claims, () => "SAME" as never);
    expect(issue).not.toBeNull();
    expect(issue?.kind).toBe("duplicate_sanitized_claim_id");
  });

  it("rejects an oversized compile group as invalid group before compile and solver work", async () => {
    traceSpec("FLA-SPEC-GROUP-BOUNDS");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");

    const claims = Array.from({ length: CLAIMS_PER_GROUP_MAX + 1 }, (_, index) =>
      makeClaim(`R-${String(index)}`, "mandatory"));

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", claims)],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]!.category).toBe("logic.invalid_group");
    expect(output.findings[0]!.evidence.some((item) => item.kind === "reason" && item.value === "group_too_large")).toBe(true);
    expect(vi.mocked(runZ3Query)).not.toHaveBeenCalled();
    expect(vi.mocked(writeOutputAtomic)).not.toHaveBeenCalled();
  });

  it("rejects a claim with too many declarations as invalid group scoped to that claim", async () => {
    traceSpec("FLA-SPEC-GROUP-BOUNDS");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");

    const variables = Array.from({ length: DECLARATIONS_PER_CLAIM_MAX + 1 }, (_, index) => ({
      name: `V${String(index)}`,
      sort: "Bool" as const,
    }));
    const oversizedClaim: LogicIrClaim = {
      claimId: toClaimId("R-BIG"),
      obligation: "mandatory",
      variables,
      functions: [],
      assertions: [{ id: "A1", expr: "true" }],
    };

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [oversizedClaim])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]!.category).toBe("logic.invalid_group");
    expect(output.findings[0]!.evidence.some((item) => item.kind === "reason" && item.value === "claim_too_many_declarations")).toBe(true);
    expect(output.findings[0]!.relatedClaimIdentifiers).toContain("R-BIG");
    expect(vi.mocked(runZ3Query)).not.toHaveBeenCalled();
    expect(vi.mocked(writeOutputAtomic)).not.toHaveBeenCalled();
  });

  it("rejects only the oversized group while a valid sibling group still runs", async () => {
    traceSpec("FLA-SPEC-GROUP-BOUNDS");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 });

    const oversizedClaims = Array.from({ length: CLAIMS_PER_GROUP_MAX + 1 }, (_, index) =>
      makeClaim(`BIG-${String(index)}`, "mandatory"));

    const output = await runLogicAnalysis({
      groups: [
        makeGroup("specs/big/spec.md", oversizedClaims),
        makeGroup("specs/ok/spec.md", [makeClaim("OK-1", "mandatory")]),
      ],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const invalidGroupFindings = output.findings.filter((finding) => finding.category === "logic.invalid_group");
    expect(invalidGroupFindings).toHaveLength(1);
    expect(invalidGroupFindings[0]!.provenance.file).toBe("specs/big/spec.md");
    expect(vi.mocked(runZ3Query)).toHaveBeenCalled();
  });

  it("preflightGroupBounds accepts groups at the limits and rejects one past each limit", () => {
    traceSpec("FLA-SPEC-GROUP-BOUNDS");
    const atGroupLimit = Array.from({ length: CLAIMS_PER_GROUP_MAX }, (_, index) =>
      makeClaim(`R-${String(index)}`, "mandatory"));
    expect(preflightGroupBounds(atGroupLimit)).toBeNull();
    expect(preflightGroupBounds([...atGroupLimit, makeClaim("R-EXTRA", "mandatory")])?.kind).toBe("group_too_large");

    const atDeclLimit: LogicIrClaim = {
      claimId: toClaimId("R-DECL"),
      obligation: "mandatory",
      variables: Array.from({ length: DECLARATIONS_PER_CLAIM_MAX }, (_, index) => ({ name: `V${String(index)}`, sort: "Bool" as const })),
      functions: [],
      assertions: [{ id: "A1", expr: "true" }],
    };
    expect(preflightGroupBounds([atDeclLimit])).toBeNull();

    const overDeclLimit: LogicIrClaim = {
      ...atDeclLimit,
      variables: [...atDeclLimit.variables, { name: "V-EXTRA", sort: "Bool" }],
    };
    expect(preflightGroupBounds([overDeclLimit])?.kind).toBe("claim_too_many_declarations");
  });
});

describe("logic-analysis pairwise & completeness (content-mocked sub-checks)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Issue 5 regression: escaped-symbol pair produces a contradiction with matching sanitized symbols", async () => {
    traceSpec("FLA-PAIRWISE", "FLA-PAIRWISE-CONTRA");

    // `out_val` sanitizes to `out_00005Fval`. The fix embeds the SANITIZED symbol
    // in the query so it matches the declared preamble symbol. Pre-fix, the query
    // embedded raw `out_val` while the preamble declared `out_00005Fval`, so Z3
    // errored and the finding was silently dropped.
    await mockZ3ByContent((smtlib) => {
      if (smtlib.includes(":named")) return "sat";
      if (smtlib.includes("(not out_00005Fval)")) return "unsat"; // phase 2 conflict
      return "sat";
    });

    const claimA = implClaim("R-U1", "(=> is_ready out_val)", {
      variables: [{ name: "is_ready", sort: "Bool" }, { name: "out_val", sort: "Bool" }],
    });
    const claimB = implClaim("R-U2", "(=> is_set (not out_val))", {
      obligation: "advisory",
      variables: [{ name: "is_set", sort: "Bool" }, { name: "out_val", sort: "Bool" }],
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const contradictions = output.findings.filter((f) => f.category === "logic.conditional_contradiction");
    expect(contradictions.length).toBeGreaterThanOrEqual(1);

    // Safety: the phase-2 query DECLARES and REFERENCES the same sanitized symbol.
    const subChecks = await recordedSubCheckQueries();
    const phase2 = subChecks.find((s) => s.includes("(not out_00005Fval)"));
    expect(phase2).toBeDefined();
    expect(phase2 ?? "").toContain("(declare-const out_00005Fval Bool)");
  });

  it("function support: a function-only-coupled pair is still checked and reported", async () => {
    traceSpec("FLA-PAIRWISE", "FLA-PAIRWISE-CONTRA");

    await mockZ3ByContent((smtlib) => {
      if (smtlib.includes(":named")) return "sat";
      if (smtlib.includes("(not f)")) return "unsat"; // phase 2 conflict
      return "sat";
    });

    // Disjoint variables (guardA vs guardB); the ONLY shared symbol is function f.
    const claimA = implClaim("R-F1", "(=> guardA f)", {
      variables: [{ name: "guardA", sort: "Bool" }],
      functions: [{ name: "f", args: [], returns: "Bool" }],
    });
    const claimB = implClaim("R-F2", "(=> guardB (not f))", {
      variables: [{ name: "guardB", sort: "Bool" }],
      functions: [{ name: "f", args: [], returns: "Bool" }],
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const contradictions = output.findings.filter((f) => f.category === "logic.conditional_contradiction");
    expect(contradictions.length).toBeGreaterThanOrEqual(1);

    // The sub-check preamble declares the coupling function (Workstream B).
    const subChecks = await recordedSubCheckQueries();
    expect(subChecks.some((s) => s.includes("(declare-fun f () Bool)"))).toBe(true);
  });

  it("guard-unsat false-positive prevention: mutually exclusive guards yield no contradiction and skip phase 2", async () => {
    traceSpec("FLA-PAIRWISE", "FLA-PAIRWISE-COMPAT");

    // Every sub-check is UNSAT. Phase 1 (`a ∧ (not a)`) is UNSAT, so phase 2 —
    // the only query that would assert the consequent `(not x)` — must be skipped.
    await mockZ3ByContent((smtlib) => (smtlib.includes(":named") ? "sat" : "unsat"));

    const claimA = implClaim("R-B2-1", "(=> a x)", {
      variables: [{ name: "a", sort: "Bool" }, { name: "x", sort: "Bool" }],
    });
    const claimB = implClaim("R-B2-2", "(=> (not a) (not x))", {
      variables: [{ name: "a", sort: "Bool" }, { name: "x", sort: "Bool" }],
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.filter((f) => f.category === "logic.conditional_contradiction").length).toBe(0);

    const subChecks = await recordedSubCheckQueries();
    expect(subChecks.some((s) => s.includes("(assert (not x))"))).toBe(false);
  });

  it("two-phase happy path: co-activating guards with conflicting consequents cost exactly two spawns", async () => {
    traceSpec("FLA-PAIRWISE", "FLA-PAIRWISE-CONTRA");

    await mockZ3ByContent((smtlib) => {
      if (smtlib.includes(":named")) return "sat";
      if (smtlib.includes("(not gamma)")) return "unsat"; // phase 2 conflict
      return "sat"; // phase 1 guard co-activation (and completeness)
    });

    const claimA = implClaim("R-H1", "(=> alpha gamma)", {
      variables: [{ name: "alpha", sort: "Bool" }, { name: "gamma", sort: "Bool" }],
    });
    const claimB = implClaim("R-H2", "(=> beta (not gamma))", {
      variables: [{ name: "beta", sort: "Bool" }, { name: "gamma", sort: "Bool" }],
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.filter((f) => f.category === "logic.conditional_contradiction").length).toBe(1);

    // Exactly two sub-checks assert BOTH raw guards — phase 1 and phase 2 of the
    // pair. Completeness asserts `(not alpha)`/`(not beta)`, so it is excluded.
    const subChecks = await recordedSubCheckQueries();
    const guardBoth = subChecks.filter((s) => s.includes("(assert alpha)") && s.includes("(assert beta)"));
    expect(guardBoth.length).toBe(2);
  });

  it("error diagnostic: a pairwise sub-query error surfaces exactly one aggregated logic.check_error", async () => {
    traceSpec("FLA-PAIRWISE");

    // Global SAT; completeness UNSAT (negated guards, contains `(not ga)`); the
    // pair's phase 1 (`(assert ga)(assert gb)`) ERRORS.
    await mockZ3ByContent((smtlib) => {
      if (smtlib.includes(":named")) return "sat";
      if (smtlib.includes("(not ga)")) return "unsat"; // completeness
      return "error"; // pairwise phase 1
    });

    const claimA = implClaim("R-E1", "(=> ga xe)", {
      variables: [{ name: "ga", sort: "Bool" }, { name: "xe", sort: "Bool" }],
    });
    const claimB = implClaim("R-E2", "(=> gb xe)", {
      variables: [{ name: "gb", sort: "Bool" }, { name: "xe", sort: "Bool" }],
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const checkErrors = output.findings.filter((f) => f.category === "logic.check_error");
    expect(checkErrors).toHaveLength(1);
    const finding = checkErrors[0]!;
    expect(finding.severity).toBe("warning");

    const evidence = new Map(finding.evidence.map((e) => [e.kind, e.value]));
    expect(evidence.get("check_type")).toBe("pairwise");
    expect(evidence.get("errored_query_count")).toBe("1");
    expect(evidence.get("total_query_count")).toBe("1");
    expect(evidence.get("sample_claim_ids")).toContain("R-E1");
    expect(finding.relatedClaimIdentifiers).toEqual(["R-E1", "R-E2"]);

    // Security: evidence carries only counts + claim IDs, never raw solver text.
    for (const item of finding.evidence) {
      expect(item.value).not.toContain("(assert");
      expect(item.value).not.toContain("declare-");
      expect(item.value).not.toContain("check-sat");
    }
  });

  it("mixed success/error: a contradiction and an aggregated check_error are both emitted, in deterministic order", async () => {
    traceSpec("FLA-PAIRWISE", "FLA-PAIRWISE-CONTRA");

    // 4 claims → 2 symbol-overlapping candidate pairs:
    //   (C1,C2) share `qq` → contradiction (phase 2 UNSAT on `(not qq)`);
    //   (C3,C4) share `tt` → phase 1 ERRORS (`(assert ss)`).
    // Cross pairs are symbol-disjoint and skipped. Completeness negates all
    // guards (contains `(not pp)`) → UNSAT → no gap.
    await mockZ3ByContent((smtlib) => {
      if (smtlib.includes(":named")) return "sat";
      if (smtlib.includes("(not pp)")) return "unsat"; // completeness
      if (smtlib.includes("(not qq)")) return "unsat"; // C1,C2 phase 2 conflict
      if (smtlib.includes("(assert ss)")) return "error"; // C3,C4 phase 1
      return "sat"; // C1,C2 phase 1
    });

    const c1 = implClaim("C1", "(=> pp qq)", { variables: [{ name: "pp", sort: "Bool" }, { name: "qq", sort: "Bool" }] });
    const c2 = implClaim("C2", "(=> rr (not qq))", { variables: [{ name: "rr", sort: "Bool" }, { name: "qq", sort: "Bool" }] });
    const c3 = implClaim("C3", "(=> ss tt)", { variables: [{ name: "ss", sort: "Bool" }, { name: "tt", sort: "Bool" }] });
    const c4 = implClaim("C4", "(=> uu tt)", { variables: [{ name: "uu", sort: "Bool" }, { name: "tt", sort: "Bool" }] });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [c1, c2, c3, c4])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const contradictions = output.findings.filter((f) => f.category === "logic.conditional_contradiction");
    const checkErrors = output.findings.filter((f) => f.category === "logic.check_error");
    expect(contradictions).toHaveLength(1);
    expect(checkErrors).toHaveLength(1);

    const errEvidence = new Map(checkErrors[0]!.evidence.map((e) => [e.kind, e.value]));
    expect(errEvidence.get("total_query_count")).toBe("2"); // two candidate pairs
    expect(errEvidence.get("errored_query_count")).toBe("1");

    // Deterministic ordering: the real finding precedes the aggregated check_error.
    const contradictionIndex = output.findings.indexOf(contradictions[0]!);
    const checkErrorIndex = output.findings.indexOf(checkErrors[0]!);
    expect(contradictionIndex).toBeLessThan(checkErrorIndex);
  });

  it("overlap filter: symbol-disjoint conditional pairs spawn no pairwise sub-check", async () => {
    traceSpec("FLA-PAIRWISE", "FLA-PAIRWISE-BOUND");
    await mockZ3ByContent(() => "sat");

    // Disjoint symbol sets: {ga, xa} vs {gb, yb} — the pair is filtered out.
    const claimA = implClaim("R-D1", "(=> ga xa)", {
      variables: [{ name: "ga", sort: "Bool" }, { name: "xa", sort: "Bool" }],
    });
    const claimB = implClaim("R-D2", "(=> gb yb)", {
      variables: [{ name: "gb", sort: "Bool" }, { name: "yb", sort: "Bool" }],
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.filter((f) => f.category === "logic.conditional_contradiction").length).toBe(0);

    // Only the global check + the single completeness query run; no pairwise spawn.
    const subChecks = await recordedSubCheckQueries();
    expect(subChecks).toHaveLength(1);
    const all = await recordedZ3Queries();
    expect(all).toHaveLength(2);
  });

  it("overlap filter delta: a self-inconsistent implication is not reported against a symbol-disjoint claim", async () => {
    traceSpec("FLA-PAIRWISE");

    // R-SELF's guard∧consequent are jointly unsatisfiable, but it shares no symbol
    // with R-OTHER, so the overlap filter skips the pair (documented accepted
    // delta; a dedicated self-consistency check is future work).
    await mockZ3ByContent((smtlib) => (smtlib.includes(":named") ? "sat" : "unsat"));

    const selfClaim = implClaim("R-SELF", "(=> zz (not zz))", {
      variables: [{ name: "zz", sort: "Bool" }],
    });
    const otherClaim = implClaim("R-OTHER", "(=> ww vv)", {
      variables: [{ name: "ww", sort: "Bool" }, { name: "vv", sort: "Bool" }],
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [selfClaim, otherClaim])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.filter((f) => f.category === "logic.conditional_contradiction").length).toBe(0);
  });

  it("budget after filtering: densely-coupled pairs are capped at 2 × FORMAL_PAIR_BUDGET spawns", async () => {
    traceSpec("FLA-PAIRWISE-BOUND");
    await mockZ3ByContent(() => "sat"); // phase 1 SAT everywhere → phase 2 runs

    // 20 claims all share consequent `yy` → C(20,2)=190 overlapping pairs, capped
    // at FORMAL_PAIR_BUDGET survivors; each surviving pair spawns 2 (phase 1+2).
    const claims = Array.from({ length: 20 }, (_, i) =>
      implClaim(`R-CAP-${String(i)}`, `(=> guard${String(i)} yy)`, {
        variables: [{ name: `guard${String(i)}`, sort: "Bool" }, { name: "yy", sort: "Bool" }],
      }),
    );

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", claims)],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.reportMarkdown).toContain("SAT");
    const all = await recordedZ3Queries();
    // global(1) + pairwise(≤ 2 × budget) + completeness(1).
    expect(all.length).toBeLessThanOrEqual(2 * FORMAL_PAIR_BUDGET + 2);
    // Budget is genuinely engaged — far more than a trivial handful of spawns.
    expect(all.length).toBeGreaterThan(FORMAL_PAIR_BUDGET);
  });

  it("budget after filtering: symbol-disjoint pairs never consume the budget", async () => {
    traceSpec("FLA-PAIRWISE-BOUND");
    await mockZ3ByContent(() => "sat");

    // 20 claims each with unique symbols → 0 overlapping candidate pairs.
    const claims = Array.from({ length: 20 }, (_, i) =>
      implClaim(`R-UNIQ-${String(i)}`, `(=> guard${String(i)} out${String(i)})`, {
        variables: [{ name: `guard${String(i)}`, sort: "Bool" }, { name: `out${String(i)}`, sort: "Bool" }],
      }),
    );

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", claims)],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    // No pairwise spawn at all: only global + completeness.
    const all = await recordedZ3Queries();
    expect(all).toHaveLength(2);
    expect(output.findings.filter((f) => f.category === "logic.conditional_contradiction").length).toBe(0);
  });

  it("liveness: unknown Phase 1 and timeout Phase 2 each surface an inconclusive diagnostic rather than a false contradiction", async () => {
    traceSpec("FLA-PAIRWISE");

    // A pair whose consequents WOULD conflict (`q` vs `(not q)`) if Phase 2 ever
    // returned UNSAT. Non-`sat` Phase 1 and non-`unsat` Phase 2 are both fail-open
    // for contradiction detection, but the undecided pair is surfaced as an
    // aggregated pairwise `logic.inconclusive` so "no contradiction" is never
    // mistaken for "proven compatible".
    const claimA = implClaim("R-L1", "(=> p q)", {
      variables: [{ name: "p", sort: "Bool" }, { name: "q", sort: "Bool" }],
    });
    const claimB = implClaim("R-L2", "(=> r (not q))", {
      variables: [{ name: "r", sort: "Bool" }, { name: "q", sort: "Bool" }],
    });
    const group = makeGroup("specs/test/spec.md", [claimA, claimB]);
    const outputDir = toOutputDirPath("/tmp/test-output");

    // Phase 1 UNKNOWN → guard co-activation unproven → Phase 2 skipped. The pair is
    // undecided, so it surfaces one aggregated pairwise inconclusive, no contradiction.
    await mockZ3ByContent((smtlib) => (smtlib.includes(":named") ? "sat" : "unknown"));
    const unknownRun = await runLogicAnalysis({ groups: [group], outputDir });
    expect(unknownRun.findings.filter((f) => f.category === "logic.conditional_contradiction").length).toBe(0);
    const unknownInconclusive = inconclusiveFindingsFor(unknownRun.findings, "pairwise");
    expect(unknownInconclusive).toHaveLength(1);
    expect(unknownInconclusive[0]!.severity).toBe("warning");

    // Phase 2 TIMEOUT → consequent co-assertion undecided → aggregated pairwise
    // inconclusive, not a contradiction (Phase 1 co-activation was sat).
    await mockZ3ByContent((smtlib) => {
      if (smtlib.includes(":named")) return "sat";
      if (smtlib.includes("(not q)")) return "timeout";
      return "sat";
    });
    const timeoutRun = await runLogicAnalysis({ groups: [group], outputDir });
    expect(timeoutRun.findings.filter((f) => f.category === "logic.conditional_contradiction").length).toBe(0);
    expect(inconclusiveFindingsFor(timeoutRun.findings, "pairwise")).toHaveLength(1);
  });

  it("completeness inconclusive: a timeout on the completeness query surfaces one aggregated logic.inconclusive", async () => {
    traceSpec("FLA-COMPLETENESS");

    // Symbol-disjoint conditional claims → the overlap filter spawns no pairwise
    // sub-check, so the negated-guards completeness query is the only sub-check.
    // Global SAT; completeness TIMEOUT → totality is undecided, which is surfaced
    // as inconclusive rather than a (false) clean "no gap" result.
    await mockZ3ByContent((smtlib) => (smtlib.includes(":named") ? "sat" : "timeout"));

    const claimA = implClaim("R-CI-1", "(=> ga xa)", {
      variables: [{ name: "ga", sort: "Bool" }, { name: "xa", sort: "Bool" }],
    });
    const claimB = implClaim("R-CI-2", "(=> gb yb)", {
      variables: [{ name: "gb", sort: "Bool" }, { name: "yb", sort: "Bool" }],
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    // Exactly one completeness inconclusive; no gap is claimed on an undecided query.
    const inconclusive = inconclusiveFindingsFor(output.findings, "completeness");
    expect(inconclusive).toHaveLength(1);
    expect(output.findings.filter((f) => f.category === "logic.completeness_gap")).toHaveLength(0);

    const finding = inconclusive[0]!;
    expect(finding.severity).toBe("warning");
    const evidence = new Map(finding.evidence.map((e) => [e.kind, e.value]));
    expect(evidence.get("check_type")).toBe("completeness");
    expect(evidence.get("inconclusive_query_count")).toBe("1");
    expect(evidence.get("total_query_count")).toBe("1");
    expect(finding.relatedClaimIdentifiers).toEqual(["R-CI-1", "R-CI-2"]);

    // Security: evidence carries only counts + claim IDs, never raw solver text.
    for (const item of finding.evidence) {
      expect(item.value).not.toContain("(assert");
      expect(item.value).not.toContain("check-sat");
      expect(item.value).not.toContain(":named");
    }

    // Only the global check + the single completeness query ran; no pairwise spawn.
    expect(await recordedSubCheckQueries()).toHaveLength(1);
  });

  it("concurrency bound: per-group solver sub-checks never exceed the pairwise + completeness peak of four", async () => {
    traceSpec("FLA-PAIRWISE-BOUND");
    const { runZ3Query } = await import("../../src/adapters/z3.js");

    // Probe peak in-flight solver concurrency. Each query resolves on a *macrotask*
    // (`setTimeout(…, 0)`), so the entire synchronous dispatch wave — which is what
    // establishes peak concurrency — completes before any query settles, making the
    // measured peak deterministic (no timing-dependent polling).
    let inFlight = 0;
    let peak = 0;
    vi.mocked(runZ3Query).mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 } satisfies Z3Result);
          }, 0);
        }),
    );

    // 4 claims sharing consequent `yy` → C(4,2)=6 overlapping candidate pairs. With
    // pairwise solver concurrency capped at 3 and exactly one concurrent completeness
    // query, the per-group in-flight peak is 3 + 1 = 4 regardless of pair count.
    const claims = Array.from({ length: 4 }, (_, i) =>
      implClaim(`R-CB-${String(i)}`, `(=> gate${String(i)} yy)`, {
        variables: [{ name: `gate${String(i)}`, sort: "Bool" }, { name: "yy", sort: "Bool" }],
      }),
    );

    await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", claims)],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    // The cap holds (never exceeds 4) and is non-vacuous (real concurrency observed).
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("direct-caller precondition: a claim declaring one name as both variable and function rejects", async () => {
    traceSpec("FLA-PAIRWISE");

    // `compileSpecSmtlib` excludes such symbol-kind collisions, so surviving claims
    // never carry one — but the exported helper defends its contract directly.
    const conflicting = implClaim("R-CONFLICT", "(=> sym other)", {
      variables: [{ name: "sym", sort: "Bool" }, { name: "other", sort: "Bool" }],
      functions: [{ name: "sym", args: [], returns: "Bool" }],
    });

    await expect(
      runPairwiseContradictionChecks({
        claims: [conflicting],
        specFile: "specs/test/spec.md",
        z3Path: undefined,
      }),
    ).rejects.toThrow(/both variable and function/);

    // The precondition trips before any solver work.
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    expect(vi.mocked(runZ3Query)).not.toHaveBeenCalled();
  });

  it("append order: pairwise contradictions precede the completeness gap in the finding list", async () => {
    traceSpec("FLA-PAIRWISE", "FLA-COMPLETENESS");

    // Pair (R-ORD-1,R-ORD-2) contradicts (Phase 2 `(not q)` UNSAT); the completeness
    // query negates both guards (`(not p)`,`(not r)`, no `(not q)`) and is SAT → gap.
    await mockZ3ByContent((smtlib) => {
      if (smtlib.includes(":named")) return "sat";
      if (smtlib.includes("(not q)")) return "unsat";
      return "sat";
    });

    const claimA = implClaim("R-ORD-1", "(=> p q)", {
      variables: [{ name: "p", sort: "Bool" }, { name: "q", sort: "Bool" }],
    });
    const claimB = implClaim("R-ORD-2", "(=> r (not q))", {
      variables: [{ name: "r", sort: "Bool" }, { name: "q", sort: "Bool" }],
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const contradictions = output.findings.filter((f) => f.category === "logic.conditional_contradiction");
    const gaps = output.findings.filter((f) => f.category === "logic.completeness_gap");
    expect(contradictions).toHaveLength(1);
    expect(gaps).toHaveLength(1);
    expect(output.findings.indexOf(contradictions[0]!)).toBeLessThan(output.findings.indexOf(gaps[0]!));
  });

  it("Unicode scope: a global-stage solver error surfaces logic.solver_error and spawns no sub-checks", async () => {
    traceSpec("FLA-LOGIC-ERROR");

    // A Unicode variable name is out of scope for the sub-check parity fix: per the
    // encoding spec it fails the *global* compile stage, surfacing as
    // `logic.solver_error` with an early return. These two shared-symbol
    // implications would otherwise trigger pairwise + completeness sub-checks; the
    // global error (simulated here) proves they are never reached.
    await mockZ3ByContent((smtlib) => (smtlib.includes(":named") ? "error" : "sat"));

    const claimA = implClaim("R-UNI-1", "(=> café shared)", {
      variables: [{ name: "café", sort: "Bool" }, { name: "shared", sort: "Bool" }],
    });
    const claimB = implClaim("R-UNI-2", "(=> other (not shared))", {
      variables: [{ name: "other", sort: "Bool" }, { name: "shared", sort: "Bool" }],
    });

    const output = await runLogicAnalysis({
      groups: [makeGroup("specs/test/spec.md", [claimA, claimB])],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const solverErrors = output.findings.filter((f) => f.category === "logic.solver_error");
    expect(solverErrors).toHaveLength(1);
    expect(solverErrors[0]!.severity).toBe("error");

    // Early return after the single global check — no pairwise/completeness spawns.
    expect(await recordedZ3Queries()).toHaveLength(1);
  });
});
