/** Ordered static valuation phases, separate from query/evidence mechanics.
 * @example await analyzeStaticGroup(file, admittedClaims, sharedExecutor, 200);
 */
import type { LogicIrClaim } from "../logic-ir.js";
import type { Finding } from "../findings.js";
import { err, ok, type Result } from "../result.js";
import { negation } from "./predicate-lowering.js";
import type { LogicExpression, StaticRule } from "./expression-types.js";
import { mergeExpressionSignatures } from "./signature.js";
import type { QueryExecutor, QueryOutcome } from "./query-executor.js";
import { dependencyOverlap } from "./dependencies.js";
import { StaticAnalysisContext, staticDiagnostic, encodeRule, type StaticAnalysisResult } from "./static-context.js";

const STATIC_GROUP_CLAIMS_MAX = 1_024;
const STATIC_GROUP_SYMBOLS_MAX = 2_048;
const BASELINE_TIMEOUT_MS = 30_000;

/** Analyze one admitted group in a fixed order; SAT means existence of a valuation.
 * @param pairBudget - Nonnegative candidate-examination allowance, independent of script limits.
 * @returns Ordered findings/report lines, including invalid or unestablished scope.
 * @throws Required executor/evidence failures; no parallel work or retries are hidden here.
 * @remarks The caller supplies validated typed claims and one shared run executor. Helpers
 * append only to this invocation's results and preserve B/C identity for core attribution.
 * @example const { findings } = await analyzeStaticGroup("group", claims, executor, 200);
 */
export async function analyzeStaticGroup(group: string, claims: readonly LogicIrClaim[], executor: QueryExecutor, pairBudget: number): Promise<{ findings: readonly Finding[]; reportLines: readonly string[] }> {
  const results: StaticAnalysisResult = { findings: [], reportLines: [] };
  const prepared = prepareGroup(group, claims, executor, results);
  if (!prepared.ok) {
    staticDiagnostic(results, group, "logic.invalid_group", prepared.error, undefined, [], "error");
    return results;
  }
  const context = prepared.value;
  for (const claim of claims) if (claim.interpretationAssessment !== undefined) results.reportLines.push(`  - ${claim.claimId}: selected sample ${claim.interpretationAssessment.selectedSample} of ${claim.interpretationAssessment.sampleCount}; ${claim.interpretationAssessment.stability}.`);
  if (!await checkBackground(context) || !await checkMandatoryBaseline(context)) return results;
  const guards = await checkRuleResponses(context);
  await checkMandatoryPairs(context, guards, pairBudget);
  await checkScenarios(context);
  await checkCoverage(context);
  await checkAdvisories(context, pairBudget);
  if (context.rules.some((rule) => rule.interpretationDependent)) results.reportLines.push("  - Conclusions depend on recorded model-proposed concept mappings/interpretations.");
  return results;
}

/** Validate compatibility/bounds before creating query services; no solver I/O.
 * @returns A group with a checked shared signature, or the existing invalid-group reason.
 */
function prepareGroup(group: string, claims: readonly LogicIrClaim[], executor: QueryExecutor, results: StaticAnalysisResult): Result<StaticAnalysisContext, string> {
  const signature = mergeExpressionSignatures([...new Set(claims.flatMap((claim) => claim.signature === undefined ? [] : [claim.signature]))]);
  if (claims.length > STATIC_GROUP_CLAIMS_MAX || new Set(claims.map((claim) => claim.claimId)).size !== claims.length || claims.some((claim) => (claim.signature?.symbols.length ?? 0) > STATIC_GROUP_SYMBOLS_MAX)) return err("Compile-group identity or declaration/claim bounds are invalid");
  if (!signature.ok || claims.some((claim) => claim.signature === undefined)) return err(signature.ok ? "Missing typed signature" : signature.error);
  const background = claims[0]?.background ?? [];
  const canonicalBackground = JSON.stringify(background.map((value) => executor.render(value)));
  if (claims.some((claim) => claim.background !== background && JSON.stringify((claim.background ?? []).map((value) => executor.render(value))) !== canonicalBackground)) return err("Incompatible group assumptions");
  return ok(new StaticAnalysisContext(group, claims, signature.value, executor, results));
}

/** Gate all dependent work on B SAT; preserve uncertainty and explicit blocked scope. */
async function checkBackground(context: StaticAnalysisContext): Promise<boolean> {
  const bg = await context.query("background", context.background);
  if (bg.result?.kind === "sat") return true;
  context.blockDependent("Background consistency is unestablished");
  if (bg.result?.kind === "unsat") context.diagnose("logic.inconsistent_assumptions", "Background premises are inconsistent; favorable conclusions blocked", bg, [], "error");
  context.results.reportLines.push(`- ${context.group}: background ${bg.result?.kind ?? "unestablished"}`);
  return false;
}

/** Gate later phases on B and mandatory C SAT; auxiliary failure cannot revoke primary UNSAT. */
async function checkMandatoryBaseline(context: StaticAnalysisContext): Promise<boolean> {
  const global = await context.query("global", [...context.background, ...context.constraints], { timeoutMs: BASELINE_TIMEOUT_MS });
  if (global.result?.kind === "unsat") {
    const ids = await context.coreIds("global", [...context.background, ...context.constraints]);
    context.diagnose("logic.contradiction", `Mandatory set has no shared valuation${ids.length ? `: ${ids.join(", ")}` : "; core attribution unavailable"}`, global, ids, "error");
    context.blockDependent("Mandatory baseline is inconsistent");
    context.results.reportLines.push(`- ${context.group}: UNSAT mandatory constraints`);
    return false;
  }
  if (global.result?.kind !== "sat") { context.blockDependent("Mandatory baseline consistency is unestablished"); return false; }
  context.results.reportLines.push(`- ${context.group}: SAT (a shared satisfying valuation exists)`);
  return true;
}

/** Check each source rule in order, preserving modal separation and guard prerequisite outcomes. */
async function checkRuleResponses(context: StaticAnalysisContext): Promise<ReadonlyMap<StaticRule, QueryOutcome>> {
  const guards = new Map<StaticRule, QueryOutcome>();
  for (const rule of context.rules) {
    const guard = await context.query(`guard:${rule.claimId ?? "source"}`, [...context.background, rule.guard]);
    guards.set(rule, guard);
    if (guard.result?.kind === "unsat") context.diagnose("logic.vacuous_guard", "Guard has no satisfying valuation under background premises", guard, rule.claimId ? [rule.claimId] : []);
    if (guard.result?.kind !== "sat") {
      context.executor.block(context.group, `${rule.kind}-response:${rule.claimId ?? "source"}`, "Guard feasibility is unestablished");
      if (rule.kind === "mandatory") context.executor.block(context.group, `activation:${rule.claimId ?? "source"}`, "Guard feasibility is unestablished");
      continue;
    }
    const response = await context.query(`${rule.kind}-response:${rule.claimId ?? "source"}`, [...context.background, rule.guard, rule.response, ...(rule.kind === "mandatory" ? [] : context.constraints)]);
    if (response.result?.kind === "unsat") context.diagnose(rule.kind === "permission" ? "logic.permission_conflict" : rule.kind === "advisory" ? "logic.advisory_conflict" : "logic.self_conflict", "Activated response is infeasible in its modal track", response, rule.claimId ? [rule.claimId] : [], rule.kind === "mandatory" ? "error" : "warning");
    if (rule.kind === "mandatory") {
      const activation = await context.query(`activation:${rule.claimId ?? "source"}`, [...context.background, rule.guard, ...context.constraints]);
      if (activation.result?.kind === "unsat") {
        const ids = await context.coreIds(`activation:${rule.claimId ?? "source"}`, [...context.background, rule.guard, ...context.constraints]);
        context.diagnose("logic.activation_conflict", `Possible guard activation cannot satisfy the full mandatory set${ids.length ? "" : "; sufficient core attribution unavailable"}`, activation, ids, "error");
      }
    }
  }
  return guards;
}

/** Examine the dependency-filtered prefix, including infeasible candidates; aggregate unissued scope. */
async function checkMandatoryPairs(context: StaticAnalysisContext, guards: ReadonlyMap<StaticRule, QueryOutcome>, pairBudget: number): Promise<void> {
  let pairs = 0;
  const plans = new Map<string, { readonly status: "blocked" | "skipped"; count: number }>();
  const deferPair = (status: "blocked" | "skipped", reason: string, count: number): void => { plans.set(reason, { status, count: (plans.get(reason)?.count ?? 0) + count }); };
  const overlaps = dependencyOverlap(context.mandatory, context.background);
  for (let i = 0; i < context.mandatory.length; i += 1) for (let j = i + 1; j < context.mandatory.length; j += 1) {
    // Both indexes are within the bounded admitted mandatory array.
    const left = context.mandatory[i]!; const right = context.mandatory[j]!;
    if (!overlaps(left, right)) continue;
    const ordinal = pairs; pairs += 1;
    if (ordinal >= pairBudget) {
      if (pairs === pairBudget + 1) context.diagnose("logic.pairwise_skipped", "Remaining co-activation pairs exceed pair budget");
      deferPair("skipped", "Candidate pair examination budget exhausted", 2); continue;
    }
    if (guards.get(left)?.result?.kind !== "sat" || guards.get(right)?.result?.kind !== "sat") { deferPair("blocked", "Individual pair guard feasibility is unestablished", 2); continue; }
    const overlap = await context.query(`coactivation:${i}:${j}`, [...context.background, left.guard, right.guard]);
    if (overlap.result?.kind !== "sat") { deferPair("blocked", "Pair co-activation is infeasible or unestablished", 1); continue; }
    const conflict = await context.query(`pair-conflict:${i}:${j}`, [...context.background, left.guard, right.guard, ...context.constraints]);
    if (conflict.result?.kind === "unsat") context.diagnose("logic.conditional_contradiction", "Co-active guards cannot satisfy the full mandatory set", conflict, await context.coreIds(`pair:${i}:${j}`, [...context.background, left.guard, right.guard, ...context.constraints]), "error");
  }
  for (const [reason, plan] of plans) context.executor.unissued(context.group, "mandatory-pair-dependent", plan.status, reason, plan.count);
}

/** Concrete example inputs remain local query conjuncts, never background assertions. */
async function checkScenarios(context: StaticAnalysisContext): Promise<void> {
  for (const scenario of context.claims.flatMap((claim) => claim.staticScenario === undefined ? [] : [claim.staticScenario])) {
    const example = await context.query(`${scenario.kind}:${scenario.source.ordinal}`, [...context.background, ...context.constraints, scenario.input, scenario.outcome]);
    if ((scenario.kind === "example" && example.result?.kind === "unsat") || (scenario.kind === "prohibited-example" && example.result?.kind === "sat")) context.diagnose("logic.scenario_conflict", `${scenario.kind} disagrees with admitted mandatory behavior`, example);
  }
}

/** Coverage is explicit-family scoped; missing expectations yield only potential-gap suggestions. */
async function checkCoverage(context: StaticAnalysisContext): Promise<void> {
  const coverage = [...new Map(context.claims.flatMap((claim) => claim.coverage ?? []).map((scope) => [scope.name, scope])).values()];
  for (const scope of coverage) {
    const selected = context.rules.filter((rule) => scope.sources.some((source) => source.file === rule.source.file && source.ordinal === rule.source.ordinal));
    if (selected.length !== scope.sources.length) { context.diagnose("logic.inconclusive", `Coverage ${scope.name} has unresolved source scope`); continue; }
    const disjunction: LogicExpression = Object.freeze({ kind: "operator", op: "or", args: Object.freeze(selected.map((rule) => rule.guard)), sort: "Bool" });
    const gap = await context.query(`coverage:${scope.name}`, [...context.background, scope.applicability, negation(disjunction)]);
    if (gap.result?.kind === "sat") {
      const model = await context.witness(`coverage:${scope.name}`, [...context.background, scope.applicability, negation(disjunction)]);
      context.diagnose("logic.completeness_gap", `Uncovered valuation exists for explicit behavior family ${scope.name}`, model.result?.kind === "sat" ? model : gap, selected.flatMap((rule) => rule.claimId ? [rule.claimId] : []));
    }
  }
  if (coverage.length === 0 && context.mandatory.length > 1) {
    const disjunction: LogicExpression = Object.freeze({ kind: "operator", op: "or", args: Object.freeze(context.mandatory.map((rule) => rule.guard)), sort: "Bool" });
    const gap = await context.query("potential-coverage", [...context.background, negation(disjunction)]);
    if (gap.result?.kind === "sat") context.diagnose("logic.potential_gap", "A valuation has no active mandatory guard; no explicit coverage expectation establishes a defect", gap);
  }
}

/** Advisory extensions warn independently; pair/script budgets and publication order are unchanged. */
async function checkAdvisories(context: StaticAnalysisContext, pairBudget: number): Promise<void> {
  const advisories = context.rules.filter((rule) => rule.kind === "advisory");
  if (advisories.length <= 1) return;
  const advisory = await context.query("advisory-combination", [...context.background, ...context.constraints, ...advisories.map(encodeRule)]);
  if (advisory.result?.kind === "unsat") context.diagnose("logic.advisory_conflict", "Advisory extensions conflict; mandatory baseline remains satisfiable", advisory);
  let checked = 0; let skipped = 0; let blocked = 0;
  for (let i = 0; i < advisories.length; i += 1) for (let j = i + 1; j < advisories.length; j += 1) {
    if (checked >= pairBudget) { skipped += 2; continue; }
    checked += 1;
    const enabled = [...context.background, ...context.constraints, advisories[i]!.guard, advisories[j]!.guard];
    const baseline = await context.query(`advisory-coactivation:${i}:${j}`, enabled);
    if (baseline.result?.kind !== "sat") { blocked += 1; continue; }
    const conflict = await context.query(`advisory-pair:${i}:${j}`, [...enabled, ...advisories.map(encodeRule)]);
    if (conflict.result?.kind === "unsat") context.diagnose("logic.advisory_conflict", "Co-active advisory extensions conflict without invalidating the mandatory baseline", conflict);
  }
  context.executor.unissued(context.group, "advisory-pair-dependent", "blocked", "Advisory co-activation is infeasible or unestablished", blocked);
  context.executor.unissued(context.group, "advisory-pair-dependent", "skipped", "Advisory candidate pair examination budget exhausted", skipped);
  if (skipped > 0) context.diagnose("logic.pairwise_skipped", "Remaining advisory co-activation pairs exceed pair budget");
}
