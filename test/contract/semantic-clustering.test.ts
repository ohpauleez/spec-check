import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { clusterFormalizationSamples } from "../../src/domain/formal/clustering.js";
import { QueryExecutor } from "../../src/domain/formal/query-executor.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import { validateExpression } from "../../src/domain/formal/expressions.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import type { ExpressionSignature } from "../../src/domain/formal/expression-types.js";
import { toClaimId } from "../../src/domain/branded.js";
import { traceSpec } from "../support/spec-trace.js";
import { clusterWithSelection } from "../../src/domain/formal/selected-clustering.js";
import { EvidenceRecorder, EvidencePersistenceError } from "../../src/domain/formal/evidence.js";

const signature: ExpressionSignature = { symbols: [{ name: "x", sort: "Bool" }], enums: [], units: [] };
function sample(text: string): LogicIrClaim {
  const parsed = validateExpression(text, signature);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return { claimId: toClaimId("CLUSTER-REQ"), obligation: "mandatory", variables: [], functions: [], signature, registryHash: "fixed", background: [], assertions: [{ id: "A", expr: text, node: parsed.value }] };
}
const available = spawnSync("z3", ["--version"], { timeout: 5_000 }).status === 0;

describe.skipIf(!available)("typed nonvacuous interpretation clusters", () => {
  it("selection admission refusal issues no solver work and retains diagnostic scope", async () => {
    traceSpec("RAE-EVIDENCE-BUDGET", "FLA-CLUSTER-DIVERGE");
    let calls = 0;
    const evidence = new EvidenceRecorder(1, async () => undefined);
    const executor = new QueryExecutor(ANALYSIS_LIMITS, evidence, undefined, async () => { calls += 1; return { kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 }; });
    const result = await clusterWithSelection({ claimId: "CLUSTER-REQ", samples: [sample("x"), sample("(not x)")], stabilityThreshold: 0.6, executor });
    expect(calls).toBe(0);
    expect(result.clustered.stability).toBe("unstable");
    expect(result.findings[0]?.category).toBe("formalization.unassessed_selection");
    expect(executor.ledger[0]?.status).toBe("skipped");
  });

  it("required selection persistence failure is not an exposed selected result", async () => {
    traceSpec("RAE-EVIDENCE-WRITE");
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async () => { throw new Error("injected selection write failure"); });
    const executor = new QueryExecutor(ANALYSIS_LIMITS, evidence);
    await expect(clusterWithSelection({ claimId: "CLUSTER-REQ", samples: [sample("x")], stabilityThreshold: 0.6, executor })).rejects.toBeInstanceOf(EvidencePersistenceError);
    expect(executor.ledger).toEqual([]);
  });
  it("stable samples share declarations and preserve equivalence evidence", async () => {
    traceSpec("FLA-CLUSTER-STABLE", "FLA-CLUSTER-QUERY");
    const result = await clusterFormalizationSamples({ claimId: "CLUSTER-REQ", samples: [sample("x"), sample("x")], stabilityThreshold: 0.6 });
    expect(result.clustered.stability).toBe("stable");
    expect(result.clustered.clusters[0]?.members).toEqual([0, 1]);
    expect(result.clustered.pairwise[0]?.evidence.leftToRightQuery.match(/declare-const vx /gu)).toHaveLength(1);
  });

  it("two impossible samples cannot establish stable agreement", async () => {
    traceSpec("FLA-CLUSTER-VACUOUS", "FLA-CLUSTER-DIVERGE");
    const result = await clusterFormalizationSamples({ claimId: "CLUSTER-REQ", samples: [sample("false"), sample("false")], stabilityThreshold: 0.6 });
    expect(result.clustered.ambiguous).toBe(true);
    expect(result.clustered.pairwise).toEqual([]);
    expect(result.findings.some((finding) => finding.category === "formalization.inconsistent_sample")).toBe(true);
  });

  it("a single sample is selected rather than measured stable", async () => {
    traceSpec("FLA-CLUSTER-SINGLE");
    const result = await clusterFormalizationSamples({ claimId: "CLUSTER-REQ", samples: [sample("x")], stabilityThreshold: 0.6 });
    expect(result.clustered.stability).toBe("single");
    expect(result.clustered.pairwise).toEqual([]);
  });

  it("unknown background/premise checks remain inconclusive", async () => {
    traceSpec("FLA-CLUSTER-INCON");
    const executor = new QueryExecutor(ANALYSIS_LIMITS, undefined, undefined, async () => ({ kind: "unknown", stdout: "unknown\n", stderr: "", exitCode: 0 }));
    const result = await clusterFormalizationSamples({ claimId: "CLUSTER-REQ", samples: [sample("x"), sample("x")], stabilityThreshold: 0.6, executor });
    expect(result.clustered.ambiguous).toBe(true);
    expect(result.clustered.pairwise).toEqual([]);
  });

  it.each(["unsat", "unknown", "timeout", "error", "skipped"] as const)("reports %s sample premises without claiming more than the outcome", async (kind) => {
    let calls = 0;
    const executor = new QueryExecutor({ ...ANALYSIS_LIMITS, queryScripts: kind === "skipped" ? 1 : 1000 }, undefined, undefined, async () => {
      calls += 1;
      return { kind: calls === 1 ? "sat" : kind === "skipped" ? "sat" : kind, stdout: calls === 1 ? "sat\n" : `${kind}\n`, stderr: "", exitCode: 0 };
    });
    const result = await clusterFormalizationSamples({ claimId: "CLUSTER-REQ", samples: [sample("x"), sample("x")], stabilityThreshold: 0.6, executor });
    const expected = kind === "unsat" ? "formalization.inconsistent_sample" : kind === "skipped" ? "formalization.unassessed_sample" : "formalization.inconclusive_sample";
    expect(result.findings.filter((finding) => finding.category === expected)).toHaveLength(2);
    if (kind !== "unsat") expect(result.findings.some((finding) => finding.category === "formalization.inconsistent_sample")).toBe(false);
    expect(result.clustered.ambiguous).toBe(true);
  });

  it("selects the largest nonvacuous cluster with deterministic quality tie-breaking", async () => {
    traceSpec("FLA-CLUSTER-STABLE", "FLA-CLUSTER-DIVERGE");
    const samples = [sample("(not x)"), sample("x"), { ...sample("x"), interpretationQuality: { explicit: 1, proposed: 0, slots: 2 } }, sample("x")];
    const first = await clusterFormalizationSamples({ claimId: "CLUSTER-REQ", samples, stabilityThreshold: 0.6 });
    const second = await clusterFormalizationSamples({ claimId: "CLUSTER-REQ", samples, stabilityThreshold: 0.6 });
    expect(first.clustered.representative.interpretationAssessment).toMatchObject({ selectedSample: 2, stability: "stable", sampleCount: 4 });
    expect(first.clustered.representative.assertions).toBe(samples[2]!.assertions);
    expect(first.clustered.clusters).toEqual(second.clustered.clusters);
    expect(first.clustered.pairwise.map((pair) => [pair.leftImpliesRight, pair.rightImpliesLeft])).toEqual(second.clustered.pairwise.map((pair) => [pair.leftImpliesRight, pair.rightImpliesLeft]));
  });
});
