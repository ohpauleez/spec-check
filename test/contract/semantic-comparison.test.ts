import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { decodeAuthoredModel, freezeRegistry } from "../../src/domain/formal/concepts.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import { alignRegistries, renameExpression } from "../../src/domain/code-backwards/alignment.js";
import { compareSemanticClaims, compareSemanticCapability } from "../../src/domain/code-backwards/semantic-comparison.js";
import { QueryExecutor } from "../../src/domain/formal/query-executor.js";
import { validateExpression } from "../../src/domain/formal/expressions.js";
import { toClaimId } from "../../src/domain/branded.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import type { FrozenRegistry } from "../../src/domain/formal/concepts.js";
import { traceSpec } from "../support/spec-trace.js";
import { clusterFormalizationSamples } from "../../src/domain/formal/clustering.js";
import { EvidenceRecorder } from "../../src/domain/formal/evidence.js";
import { unstableComparison } from "../../src/domain/code-backwards/comparison-qualification.js";

const hasZ3 = spawnSync("z3", ["--version"], { timeout: 5_000 }).status === 0;
function registry(side: "specs_forward" | "generated_spec", prefix: string): FrozenRegistry {
  const authored = decodeAuthoredModel({ concepts: [
    { name: `${prefix}G`, definition: "Guard", role: "input", sort: "Bool" },
    { name: `${prefix}X`, definition: "Response A", role: "output", sort: "Bool" },
    { name: `${prefix}Y`, definition: "Response B", role: "output", sort: "Bool" },
  ] }, ANALYSIS_LIMITS);
  if (!authored.ok) throw new Error(authored.error);
  return freezeRegistry("group", side, [], authored.value, [], [], ANALYSIS_LIMITS);
}
function claim(registry: FrozenRegistry, prefix: string, response: string, permission = false): LogicIrClaim {
  const g = validateExpression(`${prefix}G`, registry.signature);
  const r = validateExpression(response, registry.signature);
  const assertion = validateExpression(`(=> ${prefix}G ${response})`, registry.signature);
  if (!g.ok || !r.ok || !assertion.ok) throw new Error("Invalid test predicate");
  return { claimId: toClaimId(`${prefix}-CLAIM`), obligation: permission ? "informational" : "mandatory", variables: [], functions: [], assertions: [{ id: "A", expr: `(=> ${prefix}G ${response})`, node: assertion.value }], signature: registry.signature, registryHash: registry.hash, registry, background: [],
    staticRule: { source: { file: `${prefix}.md`, ordinal: 0 }, claimId: `${prefix}-CLAIM`, kind: permission ? "permission" : "mandatory", guard: g.value, response: r.value, interpretationDependent: false } };
}

describe.skipIf(!hasZ3)("semantic alignment and modal comparison", () => {
  it.each(["original", "generated"] as const)("preserves %s unstable selection through aggregate evidence and matching", async (side) => {
    traceSpec("FLA-CLUSTER-DIVERGE", "STC-FORMAL-AMBIG", "STC-IMPLY-AGGREGATE", "RAE-STRENGTH-PARTIAL");
    const O = registry("specs_forward", "O"); const G = registry("generated_spec", "G");
    const writes = new Map<string, string | Uint8Array>();
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async (path, content) => { writes.set(path, content); });
    const executor = new QueryExecutor(ANALYSIS_LIMITS, evidence);
    const context = side === "original" ? O : G; const prefix = side === "original" ? "O" : "G";
    const unstable = await clusterFormalizationSamples({ claimId: "UNSTABLE", samples: [claim(context, prefix, `${prefix}X`), claim(context, prefix, `(not ${prefix}X)`)], stabilityThreshold: 0.6, executor });
    const original = side === "original" ? unstable.clustered.representative : claim(O, "O", "OX");
    const generated = side === "generated" ? unstable.clustered.representative : claim(G, "G", "GX");
    const findings = await compareSemanticCapability({ capability: "unstable", original: [original], generated: [generated], originalRegistry: O, generatedRegistry: G, executor, pairBudget: 20 });
    expect(findings.find((finding) => finding.category === "code_backwards.capability_aggregate")).toMatchObject({ severity: "warning", description: expect.stringContaining("unstable interpretation") });
    expect(findings.some((finding) => finding.category === "code_backwards.cross_implication")).toBe(false);
    expect(findings.filter((finding) => finding.category.startsWith("code_backwards.unmatched_"))).toHaveLength(2);
    const records = [...writes.entries()].filter(([path]) => path.endsWith(".comparison.json")).map(([, content]) => JSON.parse(String(content)));
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.scope === "complete" && unstableComparison(record))).toBe(true);
  });

  it("permission comparisons retain an unstable mandatory baseline independently of identity and mapping scope", async () => {
    traceSpec("STC-IMPLY-AGGREGATE", "RAE-STRENGTH-PARTIAL");
    const O = registry("specs_forward", "O"); const G = registry("generated_spec", "G");
    const baseline = { ...claim(O, "O", "OX"), interpretationAssessment: { stability: "unstable" as const, sampleCount: 2, selectedSample: 0, clusters: [[0], [1]] } };
    const result = await compareSemanticClaims("permission-baseline", [claim(O, "O", "OX", true)], [claim(G, "G", "GX", true)], alignRegistries(O, G), new QueryExecutor(ANALYSIS_LIMITS), { original: [baseline], generated: [claim(G, "G", "GX")] });
    expect(result.relation).toBe("permission-equivalent");
    expect(result.scope).toBe("complete");
    expect(unstableComparison(result)).toBe(true);
  });

  it("unissued incompatible pairs retain separate metadata records without invented solver executions", async () => {
    traceSpec("STC-IMPLY-PERSIST", "RAE-SCOPE-LEDGER");
    const O = registry("specs_forward", "O"); const G = registry("generated_spec", "G");
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async () => undefined);
    const executor = new QueryExecutor(ANALYSIS_LIMITS, evidence);
    const alignment = { ...alignRegistries(O, G), status: "incompatible" as const };
    await compareSemanticClaims("rejected", [claim(O, "O", "OX")], [claim(G, "G", "GX")], alignment, executor);
    await compareSemanticClaims("rejected", [claim(O, "O", "OY")], [claim(G, "G", "GY")], alignment, executor);
    expect(executor.ledger).toEqual([]);
    expect(evidence.files().filter((file) => file.path.endsWith(".comparison.json"))).toHaveLength(2);
  });

  it.each(["single", "stable"] as const)("retains %s sample assessment and proposed-identity dependence without inventing instability", async (stability) => {
    traceSpec("FLA-CLUSTER-SINGLE", "FLA-PREMISE-CONDITIONAL");
    const O = registry("specs_forward", "O"); const G = registry("generated_spec", "G");
    const original = { ...claim(O, "O", "OX"), interpretationQuality: { explicit: 0, proposed: 1, slots: 2 }, interpretationAssessment: { stability, sampleCount: stability === "single" ? 1 : 2, selectedSample: 0, clusters: [[0]] } };
    const result = await compareSemanticClaims("assessed", [original], [claim(G, "G", "GX")], alignRegistries(O, G), new QueryExecutor(ANALYSIS_LIMITS));
    expect(result.qualifications?.[0]).toMatchObject({ identityDependent: true, assessment: { stability } });
    expect(unstableComparison(result)).toBe(false);
  });
  it("rejects a broken joint-name invariant rather than treating an incomplete map as supported", () => {
    const original = registry("specs_forward", "O");
    const parsed = validateExpression("OG", original.signature);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(() => renameExpression(parsed.value, new Map([["OG", "MissingJoint"]]), original.signature, original.signature)).toThrow("Joint signature contains every aligned name");
  });
  it("aligns independently named exact meanings into one checked signature", async () => {
    traceSpec("STC-ALIGN-ALIASES", "STC-CONCEPT-ALIGNMENT", "STC-IMPLY-SAME", "STC-IMPLY-QUERY");
    const original = registry("specs_forward", "O"); const generated = registry("generated_spec", "G");
    const alignment = alignRegistries(original, generated);
    expect(alignment.status).toBe("aligned");
    expect(alignment.signature.symbols).toHaveLength(3);
    const result = await compareSemanticClaims("group", [claim(original, "O", "OX")], [claim(generated, "G", "GX")], alignment, new QueryExecutor(ANALYSIS_LIMITS));
    expect(result.relation).toBe("same");
  });

  it("reports permission inclusion separately from guarantee strength", async () => {
    traceSpec("STC-PERMISSION-RELATION", "STC-PERMISSION-BROADER", "STC-PERMISSION-NARROWER", "STC-PERMISSION-EQUIVALENT", "STC-PERMISSION-DIFFERENT");
    const original = registry("specs_forward", "O"); const generated = registry("generated_spec", "G");
    const alignment = alignRegistries(original, generated);
    const executor = new QueryExecutor(ANALYSIS_LIMITS);
    const narrow = claim(original, "O", "OX", true); const broad = claim(generated, "G", "(or GX GY)", true);
    expect((await compareSemanticClaims("broader", [narrow], [broad], alignment, executor)).relation).toBe("permission-broader");
    expect((await compareSemanticClaims("narrower", [claim(original, "O", "(or OX OY)", true)], [claim(generated, "G", "GX", true)], alignment, executor)).relation).toBe("permission-narrower");
    expect((await compareSemanticClaims("equal", [narrow], [claim(generated, "G", "GX", true)], alignment, executor)).relation).toBe("permission-equivalent");
    expect((await compareSemanticClaims("different", [narrow], [claim(generated, "G", "GY", true)], alignment, executor)).relation).toBe("permission-different");
  });

  it("does not treat absent permission as prohibition or equivalence", async () => {
    traceSpec("STC-PERMISSION-ABSENT", "STC-ALIGN-UNRESOLVED");
    const original = registry("specs_forward", "O"); const generated = registry("generated_spec", "G");
    const result = await compareSemanticClaims("missing", [claim(original, "O", "OX", true)], [], alignRegistries(original, generated), new QueryExecutor(ANALYSIS_LIMITS));
    expect(result.relation).toBe("unmapped");
  });

  it("inconsistent premises cannot earn same or stronger", async () => {
    traceSpec("STC-IMPLY-VACUOUS", "STC-IMPLY-UNCERTAIN");
    const original = registry("specs_forward", "O"); const generated = registry("generated_spec", "G");
    const bad = claim(generated, "G", "(and GX (not GX))", true);
    const result = await compareSemanticClaims("bad", [claim(original, "O", "OX", true)], [bad], alignRegistries(original, generated), new QueryExecutor(ANALYSIS_LIMITS));
    expect(result.relation).toBe("uncertain");
  });

  it("vacuous obligation guards cannot establish favorable alignment", async () => {
    traceSpec("STC-IMPLY-VACUOUS");
    const original = registry("specs_forward", "O"); const generated = registry("generated_spec", "G");
    const a = claim(original, "O", "OX"); const b = claim(generated, "G", "GX");
    const impossible = validateExpression("false", original.signature);
    if (!impossible.ok) throw new Error(impossible.error.message);
    const result = await compareSemanticClaims("vacuous-guards", [{ ...a, staticRule: { ...a.staticRule!, guard: impossible.value } }], [{ ...b, staticRule: { ...b.staticRule!, guard: impossible.value } }], alignRegistries(original, generated), new QueryExecutor(ANALYSIS_LIMITS));
    expect(result.relation).toBe("uncertain");
  });

  it("same names with different meaning remain unmapped", () => {
    traceSpec("STC-ALIGN-UNRESOLVED");
    const original = registry("specs_forward", "O");
    const model = decodeAuthoredModel({ concepts: [{ name: "OG", definition: "Unrelated meaning", role: "input", sort: "Bool" }] }, ANALYSIS_LIMITS);
    if (!model.ok) throw new Error(model.error);
    const generated = freezeRegistry("group", "generated_spec", [], model.value, [], [], ANALYSIS_LIMITS);
    expect(alignRegistries(original, generated).status).toBe("unmapped");
  });

  it("assumption differences are incompatible rather than silently conjoined", async () => {
    traceSpec("STC-IMPLY-ASSUMPTIONS", "STC-ALIGN-UNRESOLVED");
    const original = registry("specs_forward", "O"); const generated = registry("generated_spec", "G");
    const left = claim(original, "O", "OX"); const right = claim(generated, "G", "GX");
    const assumption = validateExpression("OG", original.signature);
    if (!assumption.ok) throw new Error(assumption.error.message);
    const result = await compareSemanticClaims("assumptions", [{ ...left, background: [assumption.value] }], [right], alignRegistries(original, generated), new QueryExecutor(ANALYSIS_LIMITS));
    expect(result.relation).toBe("incompatible");
  });

  it("type and unit mismatches remain incompatible before solver work", () => {
    traceSpec("STC-ALIGN-UNRESOLVED");
    const make = (side: "specs_forward" | "generated_spec", scale: string) => {
      const authored = decodeAuthoredModel({ concepts: [{ name: "Latency", definition: "Latency measurement", role: "output", sort: "Int", unit: "time" }],
        units: [{ name: "time", dimension: "time", scale: { numerator: "1", denominator: scale } }] }, ANALYSIS_LIMITS);
      if (!authored.ok) throw new Error(authored.error);
      return freezeRegistry("group", side, [], authored.value, [], [], ANALYSIS_LIMITS);
    };
    expect(alignRegistries(make("specs_forward", "1000"), make("generated_spec", "1")).status).toBe("incompatible");
  });

  it("aggregate runs before pairwise and pair limits leave explicit unmatched scope", async () => {
    traceSpec("STC-IMPLY-AGGREGATE", "STC-IMPLY-BUDGET", "STC-IMPLY-UNMATCHED-CLAIM", "STC-IMPLY-GREEDY");
    const original = registry("specs_forward", "O"); const generated = registry("generated_spec", "G");
    const executor = new QueryExecutor(ANALYSIS_LIMITS);
    const findings = await compareSemanticCapability({ capability: "budget", original: [claim(original, "O", "OX")], generated: [claim(generated, "G", "GX")], originalRegistry: original, generatedRegistry: generated, executor, pairBudget: 0 });
    expect(findings[0]?.category).toBe("code_backwards.capability_aggregate");
    expect(findings[1]?.category).toBe("code_backwards.pairwise_skipped");
    expect(executor.ledger[0]?.kind).toBe("comparison-background");
  });

  it("partially mapped relations cannot count as whole-capability alignment or win matching", async () => {
    traceSpec("STC-ALIGN-UNRESOLVED", "STC-IMPLY-AGGREGATE");
    const original = registry("specs_forward", "O"); const generated = registry("generated_spec", "G");
    const partial = { ...original, sourceScope: { extracted: 2, eligible: 1, excluded: 1 } };
    const findings = await compareSemanticCapability({ capability: "partial", original: [claim(original, "O", "OX")], generated: [claim(generated, "G", "GX")], originalRegistry: partial, generatedRegistry: generated, executor: new QueryExecutor(ANALYSIS_LIMITS), pairBudget: 4 });
    expect(findings[0]?.description).toContain("partial");
    expect(findings.some((finding) => finding.category === "code_backwards.cross_implication")).toBe(false);
    expect(findings.some((finding) => finding.category === "code_backwards.unmatched_original")).toBe(true);
  });
});
