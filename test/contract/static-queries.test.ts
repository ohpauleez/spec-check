import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { toClaimId } from "../../src/domain/branded.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import type { ExpressionSignature, StaticRule } from "../../src/domain/formal/expression-types.js";
import { validateExpression } from "../../src/domain/formal/expressions.js";
import { QueryExecutor, summarizeQueryLedger } from "../../src/domain/formal/query-executor.js";
import { analyzeStaticGroup } from "../../src/domain/formal/static-analysis.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import { EvidenceRecorder } from "../../src/domain/formal/evidence.js";
import { runZ3Query } from "../../src/adapters/z3.js";
import { traceSpec } from "../support/spec-trace.js";
import { finiteValuations, evaluateFinite } from "../support/static-evaluator.js";

const available = spawnSync("z3", ["--version"], { timeout: 5_000 }).status === 0;
const signature: ExpressionSignature = { symbols: ["g", "x", "y"].map((name) => ({ name, sort: "Bool" })), enums: [], units: [] };
function expr(text: string) {
  const value = validateExpression(text, signature);
  if (!value.ok) throw new Error(value.error.message);
  return value.value;
}
function rule(index: number, kind: StaticRule["kind"], guard: string, response: string): LogicIrClaim {
  return { claimId: toClaimId(`RULE-${index}`), obligation: kind === "mandatory" ? "mandatory" : kind === "advisory" ? "advisory" : "informational", variables: [], functions: [], assertions: [], signature, background: [],
    staticRule: { source: { file: "spec.md", ordinal: index }, claimId: `RULE-${index}`, kind, guard: expr(guard), response: expr(response), interpretationDependent: false } };
}

describe.skipIf(!available)("typed static query contracts", () => {
  it("detects guarded/unconditional conflict and attributes only the sufficient core", async () => {
    traceSpec("FLA-RULE-ACTIVATION", "FLA-ACTIVATE-UBIQUITOUS", "FLA-PAIRWISE-CONTRA");
    const executor = new QueryExecutor(ANALYSIS_LIMITS);
    const result = await analyzeStaticGroup("group", [rule(0, "mandatory", "g", "x"), rule(1, "mandatory", "true", "(not x)"), rule(2, "mandatory", "true", "y")], executor, 20);
    const conflicts = result.findings.filter((finding) => finding.category === "logic.activation_conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.relatedClaimIdentifiers).toEqual(["RULE-0", "RULE-1"]);
    expect(result.findings.some((finding) => finding.category === "logic.contradiction")).toBe(false);
  });

  it("detects three-rule conflicts through constraint dependency closure", async () => {
    traceSpec("FLA-ACTIVATE-MULTI", "FLA-PAIRWISE");
    const result = await analyzeStaticGroup("group", [rule(0, "mandatory", "g", "x"), rule(1, "mandatory", "g", "y"), rule(2, "mandatory", "g", "(not (and x y))")], new QueryExecutor(ANALYSIS_LIMITS), 20);
    expect(result.findings.find((finding) => finding.category === "logic.activation_conflict")?.relatedClaimIdentifiers).toEqual(["RULE-0", "RULE-1", "RULE-2"]);
    expect(result.findings.some((finding) => finding.category === "logic.conditional_contradiction")).toBe(true);
  });

  it("separates advisory and permission conflicts from mandatory satisfiability", async () => {
    traceSpec("FLA-MODAL-TRACKS", "FLA-MODAL-ADVISORY", "FLA-MODAL-PROHIBITION");
    const result = await analyzeStaticGroup("group", [rule(0, "mandatory", "true", "x"), rule(1, "advisory", "true", "(not x)"), rule(2, "permission", "g", "(not x)")], new QueryExecutor(ANALYSIS_LIMITS), 20);
    expect(result.findings.map((finding) => finding.category)).toContain("logic.advisory_conflict");
    expect(result.findings.map((finding) => finding.category)).toContain("logic.permission_conflict");
    expect(result.findings.some((finding) => finding.category === "logic.contradiction")).toBe(false);
  });

  it("records exact scoped coverage witness despite an unrelated invariant", async () => {
    traceSpec("FLA-COMPLETENESS-UBIQ", "FLA-COMPLETENESS-GAP", "RAE-QUERY-EXACT");
    const writes = new Map<string, string | Uint8Array>();
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async (path, value) => { writes.set(path, value); });
    const a = rule(0, "mandatory", "g", "x");
    const scoped = { ...a, coverage: [{ name: "responses", applicability: expr("true"), sources: [{ file: "spec.md", ordinal: 0 }], explicit: true }] };
    const result = await analyzeStaticGroup("group", [scoped, rule(1, "mandatory", "true", "y")], new QueryExecutor(ANALYSIS_LIMITS, evidence), 20);
    expect(result.findings.some((finding) => finding.category === "logic.completeness_gap")).toBe(true);
    expect([...writes].some(([path, value]) => path.endsWith(".witness.json") && typeof value === "string" && value.includes('"g": "false"'))).toBe(true);
  });

  it("missing coverage expectation yields a potential suggestion, not a completeness defect", async () => {
    traceSpec("FLA-COVERAGE-POTENTIAL");
    const result = await analyzeStaticGroup("potential", [rule(0, "mandatory", "g", "x"), rule(1, "mandatory", "g", "y")], new QueryExecutor(ANALYSIS_LIMITS), 20);
    expect(result.findings.some((finding) => finding.category === "logic.potential_gap")).toBe(true);
    expect(result.findings.some((finding) => finding.category === "logic.completeness_gap")).toBe(false);
  });

  it("preserves original UNSAT when core extraction fails", async () => {
    traceSpec("FLA-LOGIC-CORE-FAIL", "RAE-QUERY-AUX-FAIL");
    const executor = new QueryExecutor(ANALYSIS_LIMITS, undefined, undefined, async (input) => input.smtlib.includes("get-unsat-core")
      ? { kind: "error", stdout: "unsat\n(error core unavailable)\n", stderr: "", exitCode: 1 }
      : await runZ3Query(input));
    const result = await analyzeStaticGroup("group", [rule(0, "mandatory", "true", "x"), rule(1, "mandatory", "true", "(not x)")], executor, 20);
    expect(result.findings.some((finding) => finding.category === "logic.contradiction")).toBe(true);
    expect(result.findings.some((finding) => finding.category === "logic.inconclusive")).toBe(true);
  });

  it("reports script budget exhaustion and static guard vacuity explicitly", async () => {
    traceSpec("FLA-BOUNDS-QUERIES", "FLA-COVERAGE-UNKNOWN", "FLA-ACTIVATE-VACUOUS");
    const limited = new QueryExecutor({ ...ANALYSIS_LIMITS, queryScripts: 2 });
    const result = await analyzeStaticGroup("group", [rule(0, "mandatory", "g", "x")], limited, 20);
    expect(result.findings.some((finding) => finding.category === "logic.inconclusive")).toBe(true);
    const vacuous = await analyzeStaticGroup("group2", [rule(0, "mandatory", "(and g (not g))", "x")], new QueryExecutor(ANALYSIS_LIMITS), 20);
    expect(vacuous.findings.some((finding) => finding.category === "logic.vacuous_guard")).toBe(true);
  });

  it("every production query family agrees with the independent finite evaluator", async () => {
    traceSpec("RAE-VERIFY-ORACLE", "FLA-MODAL-TRACKS", "FLA-SCENARIO-MEANING", "FLA-RULE-ACTIVATION");
    const executor = new QueryExecutor(ANALYSIS_LIMITS);
    const execute = executor.execute.bind(executor);
    vi.spyOn(executor, "execute").mockImplementation(async (group, kind, sig, predicates, options) => {
      const possible = finiteValuations(sig).some((valuation) => predicates.every((predicate) => evaluateFinite(predicate, valuation) === true));
      const result = await execute(group, kind, sig, predicates, options);
      expect(result.result?.kind, kind).toBe(possible ? "sat" : "unsat");
      return result;
    });
    const a = rule(0, "mandatory", "g", "x");
    const scoped = { ...a, coverage: [{ name: "responses", applicability: expr("true"), sources: [{ file: "spec.md", ordinal: 0 }], explicit: true }],
      staticScenario: { source: { file: "spec.md", ordinal: 9 }, kind: "example" as const, input: expr("g"), outcome: expr("x") } };
    await analyzeStaticGroup("oracle", [scoped, rule(1, "advisory", "g", "(not x)"), rule(2, "permission", "g", "x")], executor, 20);
    expect(executor.ledger.length).toBeGreaterThan(8);
  });

  it("shared executor enforces its process ceiling for concurrent callers", async () => {
    traceSpec("FLA-BOUNDS-QUERIES", "FLA-ANALYSIS-BOUNDS");
    let active = 0; let peak = 0;
    const executor = new QueryExecutor({ ...ANALYSIS_LIMITS, solverConcurrency: 2 }, undefined, undefined, async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      active -= 1;
      return { kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 };
    });
    await Promise.all(Array.from({ length: 8 }, (_, index) => executor.execute("concurrent", `query-${index}`, signature, [expr("true")])));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("retains candidate pair examinations, including infeasible guards, and accounts for dependent checks", async () => {
    traceSpec("FLA-PAIRWISE-BOUND", "RAE-SCOPE-LEDGER");
    const executor = new QueryExecutor(ANALYSIS_LIMITS);
    await analyzeStaticGroup("prefix", [rule(0, "mandatory", "false", "x"), rule(1, "mandatory", "g", "x"), rule(2, "mandatory", "g", "x")], executor, 1);
    expect(executor.ledger.some((entry) => entry.kind.startsWith("coactivation:"))).toBe(false);
    expect(executor.ledger.find((entry) => entry.reason === "Individual pair guard feasibility is unestablished")?.count).toBe(2);
    expect(executor.ledger.find((entry) => entry.reason === "Candidate pair examination budget exhausted")?.count).toBe(4);
    const summary = summarizeQueryLedger(executor.ledger);
    expect(summary.inconclusiveQueries).toBe(0);
    expect(summary.plannedQueries).toBe(summary.executedQueries! + summary.skippedQueries! + summary.blockedQueries!);
    const permitted = new QueryExecutor(ANALYSIS_LIMITS);
    await analyzeStaticGroup("full", [rule(0, "mandatory", "false", "x"), rule(1, "mandatory", "g", "x"), rule(2, "mandatory", "g", "x")], permitted, 3);
    expect(permitted.ledger.some((entry) => entry.kind === "pair-conflict:1:2")).toBe(true);
  });

  it("records the unissued conflict when co-activation is excluded or unknown", async () => {
    const excluded = new QueryExecutor(ANALYSIS_LIMITS);
    await analyzeStaticGroup("excluded", [rule(0, "mandatory", "g", "x"), rule(1, "mandatory", "(not g)", "x")], excluded, 1);
    expect(excluded.ledger.find((entry) => entry.reason === "Pair co-activation is infeasible or unestablished")?.status).toBe("blocked");
    const unknown = new QueryExecutor(ANALYSIS_LIMITS);
    const run = unknown.execute.bind(unknown);
    vi.spyOn(unknown, "execute").mockImplementation(async (group, kind, sig, predicates, options) => {
      if (kind.startsWith("coactivation:")) return { status: "skipped", reason: "injected admission limit" };
      return await run(group, kind, sig, predicates, options);
    });
    const analyzed = await analyzeStaticGroup("unknown", [rule(0, "mandatory", "g", "x"), rule(1, "mandatory", "g", "x")], unknown, 1);
    expect(analyzed.findings.some((finding) => finding.category === "logic.inconclusive")).toBe(true);
    expect(unknown.ledger.find((entry) => entry.reason === "Pair co-activation is infeasible or unestablished")?.status).toBe("blocked");
  });
});
