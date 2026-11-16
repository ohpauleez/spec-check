/** Group-local query/attribution services. Phase order belongs to static-analysis.ts.
 * @example const result = await analyzeStaticGroup(file, claims, sharedExecutor, 200);
 */
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import type { ExpressionSignature, LogicExpression, StaticRule } from "./expression-types.js";
import type { QueryExecutor, QueryOutcome } from "./query-executor.js";
import { expressionSymbolName } from "./signature.js";
import { EvidenceBudgetError } from "./evidence.js";
import { dependencyOverlap } from "./dependencies.js";
import { interpretationNotes } from "./interpretation-assessment.js";

/** One analysis invocation owns these append-only arrays; helpers never share them across runs. */
export interface StaticAnalysisResult {
  readonly findings: Finding[];
  readonly reportLines: string[];
}

/** Project a source-owned mandatory/advisory rule without reparsing text.
 * @returns Immutable Boolean implication retaining the original guard/response identities.
 * @remarks Inputs must be validated Bool predicates. No I/O, failure or mutation.
 */
export function encodeRule(rule: StaticRule): LogicExpression {
  return Object.freeze({ kind: "operator", op: "=>", args: Object.freeze([rule.guard, rule.response]), sort: "Bool" });
}

/** Build first-occurrence provenance indexes; identical formulas from different nodes remain distinct.
 * @remarks Linear in the admitted array length. Never mutates input or throws expected errors.
 */
function firstIndexes(values: readonly LogicExpression[]): ReadonlyMap<LogicExpression, number> {
  const indexes = new Map<LogicExpression, number>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined && !indexes.has(value)) indexes.set(value, index);
  }
  return indexes;
}

/** Append a source-linked diagnostic without promoting valuation evidence to reachability.
 * @remarks The caller exclusively owns results. No I/O; optional artifact paths remain evidence.
 */
export function staticDiagnostic(results: StaticAnalysisResult, group: string, category: string, message: string, query?: QueryOutcome, ids: readonly string[] = [], severity: Finding["severity"] = "warning"): void {
  results.findings.push({ severity, category, provenance: { file: group }, description: message,
    rationale: "Result concerns satisfying valuations under explicit premises and recorded interpretations; it does not establish reachability or all-input realizability.",
    evidence: [{ kind: "scope", value: group }, ...(query?.inputPath ? [{ kind: "query", value: query.inputPath }] : []), ...(query?.outputPath ? [{ kind: "result", value: query.outputPath }] : [])],
    ...(ids.length === 0 ? {} : { relatedClaimIdentifiers: [...ids] }) });
}

/** Immutable group inputs plus query services; mutable publication state is separately owned.
 * @remarks Construct only after signature/background compatibility and group bounds checks.
 * All calls are sequenced by the parent; required executor/persistence failures propagate.
 * @example context.query("background", context.background);
 */
export class StaticAnalysisContext {
  readonly background: readonly LogicExpression[];
  readonly rules: readonly StaticRule[];
  readonly mandatory: readonly StaticRule[];
  readonly constraints: readonly LogicExpression[];
  private readonly mandatoryIndexes: ReadonlyMap<LogicExpression, number>;
  private readonly backgroundIndexes: ReadonlyMap<LogicExpression, number>;

  /** Retain B/C identities for every later core; inputs/results belong to one admitted group. */
  constructor(readonly group: string, readonly claims: readonly LogicIrClaim[], readonly signature: ExpressionSignature,
    readonly executor: QueryExecutor, readonly results: StaticAnalysisResult) {
    this.background = claims[0]?.background ?? [];
    this.rules = claims.flatMap((claim) => claim.staticRule === undefined ? [] : [claim.staticRule]);
    this.mandatory = this.rules.filter((rule) => rule.kind === "mandatory");
    this.constraints = this.mandatory.map(encodeRule);
    this.mandatoryIndexes = firstIndexes(this.constraints);
    this.backgroundIndexes = firstIndexes(this.background);
  }

  /** Append one diagnostic in phase order. No I/O; source IDs and evidence paths are retained. */
  diagnose(category: string, message: string, query?: QueryOutcome, ids: readonly string[] = [], severity: Finding["severity"] = "warning"): void {
    const notes = interpretationNotes(this.claims);
    staticDiagnostic(this.results, this.group, category, `${message}${notes ? ` (${notes})` : ""}`, query, ids, severity);
  }

  /** Execute one typed plan through the shared budget/pool; record nondefinitive scope.
   * @returns The unmodified executor outcome, including skipped/unknown/error statuses.
   * @throws Required evidence failures. No retry or semantic fallback is introduced here.
   */
  async query(kind: string, expressions: readonly LogicExpression[], options: Parameters<QueryExecutor["execute"]>[4] = {}): Promise<QueryOutcome> {
    const result = await this.executor.execute(this.group, kind, this.signature, expressions, options);
    if (result.status === "skipped" || !["sat", "unsat"].includes(result.result?.kind ?? "")) this.diagnose("logic.inconclusive", `${kind}: ${result.reason ?? result.result?.kind ?? "unknown"}`, result);
    return result;
  }

  /** Extract a sufficient, not minimized core without revoking a previous primary verdict.
   * @remarks Expressions must contain the identical B/C nodes. Rendered-text equality
   * cannot identify source origins. Failed extraction yields no attributed IDs.
   */
  async coreIds(kind: string, expressions: readonly LogicExpression[]): Promise<readonly string[]> {
    const labels = expressions.map((value, index) => this.mandatoryIndexes.has(value) ? `rule__${this.mandatoryIndexes.get(value)}` : this.backgroundIndexes.has(value) ? `bg__${this.backgroundIndexes.get(value)}` : `context__${index}`);
    const core = await this.query(`${kind}:core`, expressions, { labels, core: true });
    if (core.result?.kind !== "unsat") return [];
    const tokens = new Set(/\(([A-Za-z0-9_\s]*)\)\s*$/u.exec(core.result.stdout)?.[1]?.trim().split(/\s+/u) ?? []);
    return this.mandatory.filter((_, index) => tokens.has(`rule__${index}`)).flatMap((rule) => rule.claimId ? [rule.claimId] : []);
  }

  /** Persist a separately executed witness with truthful completeness status.
   * @remarks Scalar names come from the checked signature. Capacity refusal is diagnostic;
   * actual required-write failure propagates. Primary caller outcomes remain unchanged.
   */
  async witness(kind: string, expressions: readonly LogicExpression[]): Promise<QueryOutcome> {
    const names = this.signature.symbols.filter((symbol) => symbol.args === undefined || symbol.args.length === 0).map((symbol) => expressionSymbolName(symbol.name));
    const result = await this.query(`${kind}:witness`, expressions, { values: names });
    if (result.result?.kind === "sat") {
      const decoded = result.decodedValues ?? undefined;
      try { await this.executor.evidence?.json(`${this.group}:${kind}`, "witness", { assignments: decoded ?? null, decoding: result.valueDecoding?.status ?? "unavailable", missing: result.valueDecoding?.missing ?? [] }, "logic"); }
      catch (error: unknown) { if (error instanceof EvidenceBudgetError) this.diagnose("logic.inconclusive", "Decoded witness artifact skipped by evidence capacity; exact solver output remains recorded", result); else throw error; }
    }
    return result;
  }

  /** Record unissued dependent plans after an unestablished baseline.
   * @remarks At most the admitted group bound is traversed; pair omissions are aggregated.
   * No solver/evidence I/O. Plan insertion order is part of characterization coverage.
   */
  blockDependent(reason: string): void {
    for (const rule of this.rules) {
      this.executor.block(this.group, `guard:${rule.claimId ?? "source"}`, reason);
      this.executor.block(this.group, `${rule.kind}-response:${rule.claimId ?? "source"}`, reason);
      if (rule.kind === "mandatory") this.executor.block(this.group, `activation:${rule.claimId ?? "source"}`, reason);
    }
    for (const scope of this.claims[0]?.coverage ?? []) this.executor.block(this.group, `coverage:${scope.name}`, reason);
    for (const claim of this.claims) if (claim.staticScenario !== undefined) this.executor.block(this.group, `scenario:${claim.staticScenario.source.ordinal}`, reason);
    const overlaps = dependencyOverlap(this.mandatory, this.background);
    let pairs = 0;
    for (let i = 0; i < this.mandatory.length; i += 1) for (let j = i + 1; j < this.mandatory.length; j += 1) if (overlaps(this.mandatory[i]!, this.mandatory[j]!)) pairs += 1;
    this.executor.unissued(this.group, "mandatory-pair-dependent", "blocked", reason, pairs * 2);
    const advisories = this.rules.filter((rule) => rule.kind === "advisory").length;
    if (advisories > 1) this.executor.unissued(this.group, "advisory-dependent", "blocked", reason, 1 + advisories * (advisories - 1));
    if ((this.claims[0]?.coverage?.length ?? 0) === 0 && this.mandatory.length > 1) this.executor.block(this.group, "potential-coverage", reason);
  }
}
