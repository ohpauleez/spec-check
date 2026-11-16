/** Scoped typed comparison with nonvacuity and separate permission-set verdicts. */
import type { LogicIrClaim } from "../logic-ir.js";
import type { FrozenRegistry } from "../formal/concepts.js";
import type { Finding } from "../findings.js";
import { alignRegistries, renameExpression, AlignmentPreparation, type RegistryAlignment } from "./alignment.js";
import { conjunction, negation } from "../formal/predicate-lowering.js";
import type { LogicExpression, StaticRule } from "../formal/expression-types.js";
import type { QueryExecutor } from "../formal/query-executor.js";
import { expressionSymbolName } from "../formal/signature.js";
import { comparisonQualifications, qualificationText, unstableComparison, type ComparisonQualification } from "./comparison-qualification.js";

/** Cover path/status additions after the bounded contributing-artifact metadata is measured. */
const COMPARISON_RECORD_MARGIN_BYTES = 65_536;

/** Formal relations never borrow guarantee-strength polarity for permissions. */
export type SemanticRelation = "same" | "stronger" | "weaker" | "different" | "uncertain" | "unmapped" | "incompatible"
  | "permission-equivalent" | "permission-broader" | "permission-narrower" | "permission-different";

/** Preserve scoped relation separately from partial or conditional whole-capability assessment. */
export interface SemanticComparison {
  readonly relation: SemanticRelation;
  readonly scope: "complete" | "partial";
  readonly evidencePaths: readonly string[];
  readonly qualifications?: readonly ComparisonQualification[];
}

/** Compare independently derived artifacts under compatible aligned nonvacuous premises.
 * @returns A scoped obligation/permission relation and ordered query evidence; unsupported
 * identity/assumptions stay unmapped/incompatible rather than becoming semantic differences.
 * @throws Required query/evidence failures or a malformed joint-name invariant.
 * @remarks The caller shares executor/preparation across a run and sequences admission.
 * Inputs are bounded typed artifacts and checked alignment; source registries never mutate.
 * @example compareSemanticClaims(group, original, generated, alignment, executor);
 */
export async function compareSemanticClaims(group: string, original: readonly LogicIrClaim[], generated: readonly LogicIrClaim[], alignment: RegistryAlignment, executor: QueryExecutor,
  baselines: { readonly original: readonly LogicIrClaim[]; readonly generated: readonly LogicIrClaim[] } = { original: [], generated: [] }, preparation = new AlignmentPreparation()): Promise<SemanticComparison> {
  const recordScope = executor.evidence?.nextRecordScope(`${group}:assessment`);
  const permissions = [...original, ...generated].some((claim) => claim.staticRule?.kind === "permission");
  const qualifications = comparisonQualifications(permissions ? [...original, ...baselines.original] : original, permissions ? [...generated, ...baselines.generated] : generated);
  const attribution = { qualifications, original: original.map((claim) => claim.claimId), generated: generated.map((claim) => claim.claimId) };
  if (recordScope !== undefined && !executor.evidence?.reserve(recordScope, Buffer.byteLength(JSON.stringify(attribution), "utf8") + COMPARISON_RECORD_MARGIN_BYTES)) {
    executor.unissued(group, "comparison", "skipped", "Required comparison assessment evidence capacity");
    return { relation: "uncertain", scope: "partial", evidencePaths: [], qualifications };
  }
  try {
    const result = await compareAlignedClaims(group, original, generated, alignment, executor, baselines, preparation);
    const file = recordScope === undefined ? undefined : await executor.evidence?.json(recordScope, "comparison", { ...result, ...attribution }, "code-backwards", recordScope);
    return { ...result, qualifications, evidencePaths: file === undefined ? result.evidencePaths : [...result.evidencePaths, file.path] };
  } finally { if (recordScope !== undefined) executor.evidence?.release(recordScope); }
}

/** Pure scope prerequisites followed by bounded shared-executor entailment queries. */
async function compareAlignedClaims(group: string, original: readonly LogicIrClaim[], generated: readonly LogicIrClaim[], alignment: RegistryAlignment, executor: QueryExecutor,
  baselines: { readonly original: readonly LogicIrClaim[]; readonly generated: readonly LogicIrClaim[] }, preparation: AlignmentPreparation): Promise<SemanticComparison> {
  const paths: string[] = [];
  if (alignment.status === "incompatible") return { relation: "incompatible", scope: "partial", evidencePaths: [] };
  const rebind = (expression: LogicExpression, side: "original" | "generated") => renameExpression(expression, side === "original" ? alignment.originalNames : alignment.generatedNames, original[0]?.signature ?? alignment.signature, alignment.signature, preparation);
  const originalB = collectExpressions(original[0]?.background ?? [], (value) => rebind(value, "original"));
  const generatedB = collectExpressions(generated[0]?.background ?? [], (value) => rebind(value, "generated"));
  if (originalB === undefined || generatedB === undefined) return { relation: "unmapped", scope: "partial", evidencePaths: [] };
  if (JSON.stringify(originalB.map((value) => executor.render(value)).sort()) !== JSON.stringify(generatedB.map((value) => executor.render(value)).sort())) return { relation: "incompatible", scope: "partial", evidencePaths: [] };
  const B = originalB;
  const ruleFormula = (claim: LogicIrClaim, side: "original" | "generated"): LogicExpression | undefined => {
    if (claim.staticRule === undefined) return undefined;
    const guard = rebind(claim.staticRule.guard, side); const response = rebind(claim.staticRule.response, side);
    if (guard === undefined || response === undefined) return undefined;
    return Object.freeze({ kind: "operator", op: "=>", args: Object.freeze([guard, response]), sort: "Bool" });
  };
  const permissions = original.some((claim) => claim.staticRule?.kind === "permission") || generated.some((claim) => claim.staticRule?.kind === "permission");
  if (permissions && (original.some((claim) => claim.staticRule?.kind !== "permission") || generated.some((claim) => claim.staticRule?.kind !== "permission"))) return { relation: "incompatible", scope: "partial", evidencePaths: [] };
  if (permissions && (original.length === 0 || generated.length === 0)) return { relation: "unmapped", scope: "partial", evidencePaths: [] };
  const make = (claims: readonly LogicIrClaim[], side: "original" | "generated"): LogicExpression | undefined => {
    const expressions = collectExpressions(claims, (claim) => {
      const rule = claim.staticRule;
      if (!permissions || rule === undefined) return ruleFormula(claim, side);
      const guard = rebind(rule.guard, side); const response = rebind(rule.response, side);
      return guard !== undefined && response !== undefined ? conjunction([guard, response]) : undefined;
    });
    if (expressions === undefined) return undefined;
    if (permissions) {
      const baseline = collectExpressions(baselines[side], (claim) => ruleFormula(claim, side));
      if (baseline === undefined) return undefined;
      return conjunction([...baseline, Object.freeze({ kind: "operator", op: "or", args: Object.freeze(expressions), sort: "Bool" })]);
    }
    return conjunction(expressions);
  };
  const A = make(original, "original"); const D = make(generated, "generated");
  if (A === undefined || D === undefined) return { relation: "unmapped", scope: "partial", evidencePaths: [] };
  const query = async (kind: string, predicates: readonly LogicExpression[]) => {
    const outcome = await executor.execute(group, kind, alignment.signature, predicates, { timeoutMs: 30_000 });
    if (outcome.inputPath) paths.push(outcome.inputPath); if (outcome.outputPath) paths.push(outcome.outputPath);
    return outcome.result?.kind;
  };
  if (await query("comparison-background", B) !== "sat" || await query("comparison-original-premise", [...B, A]) !== "sat" || await query("comparison-generated-premise", [...B, D]) !== "sat") return { relation: "uncertain", scope: "partial", evidencePaths: paths };
  for (const [side, claims] of [["original", original], ["generated", generated]] as const) for (const claim of claims) {
    if (claim.staticRule === undefined) continue;
    const guard = rebind(claim.staticRule.guard, side);
    if (guard === undefined || await query(`comparison-${side}-guard:${claim.claimId}`, [...B, guard]) !== "sat") return { relation: "uncertain", scope: "partial", evidencePaths: paths };
  }
  const forward = await query("comparison-forward", [...B, A, negation(D)]);
  const reverse = await query("comparison-reverse", [...B, D, negation(A)]);
  if (!["sat", "unsat"].includes(forward ?? "") || !["sat", "unsat"].includes(reverse ?? "")) return { relation: "uncertain", scope: "partial", evidencePaths: paths };
  const relation: SemanticRelation = permissions
    ? forward === "unsat" && reverse === "unsat" ? "permission-equivalent" : forward === "unsat" ? "permission-broader" : reverse === "unsat" ? "permission-narrower" : "permission-different"
    : forward === "unsat" && reverse === "unsat" ? "same" : forward === "unsat" ? "weaker" : reverse === "unsat" ? "stronger" : "different";
  for (const [kind, result, predicates] of [["forward", forward, [...B, A, negation(D)]], ["reverse", reverse, [...B, D, negation(A)]]] as const) {
    if (result !== "sat") continue;
    const values = alignment.signature.symbols.filter((symbol) => symbol.args === undefined || symbol.args.length === 0).map((symbol) => expressionSymbolName(symbol.name));
    if (values.length === 0) continue;
    const witness = await executor.execute(group, `comparison-${kind}-witness`, alignment.signature, predicates, { values });
    if (witness.inputPath) paths.push(witness.inputPath); if (witness.outputPath) paths.push(witness.outputPath);
  }
  return { relation, scope: alignment.status === "aligned" ? "complete" : "partial", evidencePaths: paths };
}

/** Collect every mapped predicate or fail as unmapped; filtering would silently narrow scope.
 * @remarks Bounded by admitted items. Pure transformation; no input mutation or expected throws.
 */
function collectExpressions<T>(items: readonly T[], transform: (item: T) => LogicExpression | undefined): readonly LogicExpression[] | undefined {
  const result: LogicExpression[] = [];
  for (const item of items) {
    const expression = transform(item);
    if (expression === undefined) return undefined;
    result.push(expression);
  }
  return result;
}

/** Run modal aggregates before deterministic bounded pairwise matching.
 * @returns Ordered scoped findings, retaining unmatched/incompatible/partial source scope.
 * @throws Required evidence/query failures; expected semantic limitations remain findings.
 * @remarks Both registries must already be independently frozen. Pair allowance gates each
 * modal product; all executed scripts also consume the shared executor budget. No hidden retries.
 * @example compareSemanticCapability({ capability, original, generated, originalRegistry, generatedRegistry, executor, pairBudget: 200 });
 */
export async function compareSemanticCapability(input: {
  readonly capability: string; readonly original: readonly LogicIrClaim[]; readonly generated: readonly LogicIrClaim[];
  readonly originalRegistry: FrozenRegistry; readonly generatedRegistry: FrozenRegistry; readonly executor: QueryExecutor; readonly pairBudget: number;
}): Promise<readonly Finding[]> {
  const mixed = input.original.some((claim) => claim.registryHash !== input.originalRegistry.hash) || input.generated.some((claim) => claim.registryHash !== input.generatedRegistry.hash);
  const incomplete = input.original.length < input.originalRegistry.sourceScope.eligible || input.generated.length < input.generatedRegistry.sourceScope.eligible;
  const checked = alignRegistries(input.originalRegistry, input.generatedRegistry);
  const alignment: RegistryAlignment = mixed ? { ...checked, status: "incompatible", issues: [...checked.issues, "Artifact registry identities do not match the supplied frozen contexts"] }
    : incomplete ? { ...checked, status: checked.status === "incompatible" ? "incompatible" : "unmapped", issues: [...checked.issues, "Not every eligible source produced a compared artifact"] } : checked;
  const file = await input.executor.evidence?.json(`comparison:${input.capability}`, "alignment", { status: alignment.status, pairs: alignment.pairs, issues: alignment.issues,
    originalRegistryHash: input.originalRegistry.hash, generatedRegistryHash: input.generatedRegistry.hash }, "code-backwards");
  const findings: Finding[] = [];
  const preparation = new AlignmentPreparation();
  const report = (kind: string, result: SemanticComparison, ids: readonly string[]) => findings.push({ severity: result.scope === "partial" || unstableComparison(result) || !["same", "stronger", "permission-equivalent"].includes(result.relation) ? "warning" as const : "info" as const,
    category: `code_backwards.${kind}`, provenance: { file: `<comparison/${input.capability}>` }, description: `${input.capability}: ${result.relation} (${result.scope} mapped scope${qualificationText(result)})`,
    rationale: "Formal relation depends on independent recorded interpretations and checked identity alignment; it does not prove implementation conformance to natural-language intent.",
    evidence: [...(file ? [{ kind: "alignment", value: file.path }] : []), ...result.evidencePaths.map((path) => ({ kind: "solver", value: path }))], relatedClaimIdentifiers: [...ids] });
  for (const modal of ["mandatory", "advisory", "permission"] as const satisfies readonly StaticRule["kind"][]) {
    const original = input.original.filter((claim) => claim.staticRule?.kind === modal);
    const generated = input.generated.filter((claim) => claim.staticRule?.kind === modal);
    if (original.length + generated.length === 0) continue;
    const group = `<comparison/${input.capability}/${modal}>`;
    const baselines = { original: input.original.filter((claim) => claim.staticRule?.kind === "mandatory"), generated: input.generated.filter((claim) => claim.staticRule?.kind === "mandatory") };
    const aggregate = await compareSemanticClaims(group, original, generated, alignment, input.executor, baselines, preparation);
    report("capability_aggregate", aggregate, original.map((claim) => claim.claimId));
    if (original.length * generated.length > input.pairBudget) {
      report("pairwise_skipped", { relation: "uncertain", scope: "partial", evidencePaths: [] }, original.map((claim) => claim.claimId)); continue;
    }
    const choices: { left: number; right: number; result: SemanticComparison }[] = [];
    for (let left = 0; left < original.length; left += 1) for (let right = 0; right < generated.length; right += 1) choices.push({ left, right, result: await compareSemanticClaims(group, [original[left]!], [generated[right]!], alignment, input.executor, baselines, preparation) });
    const score = (result: SemanticComparison): number => result.scope === "partial" || unstableComparison(result) ? -1 : result.relation === "same" || result.relation === "permission-equivalent" ? 4 : result.relation === "stronger" ? 3 : result.relation === "uncertain" ? 2 : result.relation === "weaker" ? 1 : 0;
    choices.sort((a, b) => score(b.result) - score(a.result) || a.left - b.left || a.right - b.right);
    const matchedLeft = new Set<number>(); const matchedRight = new Set<number>();
    for (const choice of choices) {
      if (matchedLeft.has(choice.left) || matchedRight.has(choice.right) || choice.result.scope === "partial" || unstableComparison(choice.result) || ["unmapped", "incompatible"].includes(choice.result.relation)) continue;
      matchedLeft.add(choice.left); matchedRight.add(choice.right);
      report("cross_implication", choice.result, [original[choice.left]!.claimId, generated[choice.right]!.claimId]);
    }
    for (let index = 0; index < original.length; index += 1) if (!matchedLeft.has(index)) report("unmatched_original", { relation: "unmapped", scope: "partial", evidencePaths: [] }, [original[index]!.claimId]);
    for (let index = 0; index < generated.length; index += 1) if (!matchedRight.has(index)) report("unmatched_generated", { relation: "unmapped", scope: "partial", evidencePaths: [] }, [generated[index]!.claimId]);
  }
  return findings;
}
