/** Bounded typed query execution and exact evidence; all effects are explicit inputs. */
import { runZ3Query, type Z3Result } from "../../adapters/z3.js";
import { toSmtlibContent } from "../branded.js";
import type { AnalysisLimits } from "./analysis-config.js";
import type { EvidenceRecorder } from "./evidence.js";
import { FragmentClassifier } from "./fragment.js";
import { SignaturePreparation } from "./signature.js";
import { ExpressionRenderer } from "./expression-render.js";
import type { ExpressionSignature, LogicExpression } from "./expression-types.js";
import { ModelValueDecoder, type DecodedModelValues } from "./model-values.js";

const SOLVER_CONCURRENCY_MAX = 16;
const QUERY_TIMEOUT_DEFAULT_MS = 10_000;
const QUERY_EVIDENCE_MARGIN_BYTES = 65_536;

/** Explicit outcome separates bounded admission from executed solver results. */
export interface QueryOutcome {
  readonly status: "executed" | "skipped";
  readonly result?: Z3Result;
  readonly reason?: string;
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly script?: string;
  readonly decodedValues?: Readonly<Record<string, string>> | null;
  readonly valueDecoding?: DecodedModelValues;
}

/** One executed or unissued check plan; multiplicity counts only aggregate unissued work. */
export interface QueryLedgerEntry {
  readonly scope: string;
  readonly kind: string;
  readonly status: string;
  readonly reason?: string;
  /** One compact entry may represent multiple unissued dependent check plans. */
  readonly count?: number;
}

/** Summarize an executor-owned ledger with separate executed/blocked/skipped counts.
 * @returns Named totals; unestablished explicitly includes all nondefinitive scope.
 * @remarks Entries must have valid statuses and safe nonnegative multiplicities. Pure bounded
 * traversal with no input mutation; arbitrary external ledger construction is not validated here.
 * @example summarizeQueryLedger(executor.ledger);
 */
export function summarizeQueryLedger(ledger: readonly QueryLedgerEntry[]): Readonly<Record<string, number>> {
  const count = (accepts: (status: string) => boolean) => ledger.reduce((sum, entry) => sum + (accepts(entry.status) ? entry.count ?? 1 : 0), 0);
  const skippedQueries = count((status) => status === "skipped");
  const blockedQueries = count((status) => status === "blocked");
  const inconclusiveQueries = count((status) => !["sat", "unsat", "skipped", "blocked"].includes(status));
  return Object.freeze({ plannedQueries: count(() => true), executedQueries: count((status) => status !== "skipped" && status !== "blocked"),
    satQueries: count((status) => status === "sat"), unsatQueries: count((status) => status === "unsat"), skippedQueries, blockedQueries, inconclusiveQueries,
    unestablishedQueries: skippedQueries + blockedQueries + inconclusiveQueries });
}

/** Run-local typed executor; composed analyses share an instance for the same process/script ceiling.
 * @remarks The CLI serializes admission. Direct callers own ordering and bound concurrent submissions;
 * the current waiter queue has no independent pending limit or cancellation API. Do not treat the
 * active-process ceiling as unlimited-submission backpressure. Required evidence errors propagate.
 * @example const executor = new QueryExecutor(limits, recorder, z3Path); await executor.execute(group, "background", signature, background);
 */
export class QueryExecutor {
  private readonly signatures = new SignaturePreparation();
  private readonly fragments = new FragmentClassifier(this.signatures.validation);
  private readonly renderer = new ExpressionRenderer();
  private readonly decoder = new ModelValueDecoder();
  private readonly counts = new Map<string, number>();
  private readonly plans = new Map<string, number>();
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  readonly ledger: QueryLedgerEntry[] = [];
  /** Bind validated positive controls and injected effects for one run.
   * @remarks Limits come from resolveAnalysisConfig; runner must return one terminal result per
   * call (including timeout). No process starts until execute. No ambient/global queue is shared.
   */
  constructor(readonly limits: AnalysisLimits, readonly evidence?: EvidenceRecorder, readonly z3Path?: string, private readonly run: typeof runZ3Query = runZ3Query) {}

  /** Render a validated bounded AST without mutation/I/O; cache cannot authorize mutable reuse.
   * @returns Canonical SMT text. No expected failure for admitted nodes.
   * @example executor.render(guard);
   */
  render(expression: LogicExpression): string { return this.renderer.render(expression); }
  /** Decode complete scalar assignments only; unavailable/partial returns undefined.
   * @remarks Signature must be decoded; stdout remains untouched. No I/O or expected throws.
   * @example executor.decodeValues(stdout, signature);
   */
  decodeValues(stdout: string, signature: ExpressionSignature): Readonly<Record<string, string>> | undefined { return this.decoder.decode(stdout, signature); }

  /** Reserve an executor-owned process slot, including direct concurrent callers. */
  private async acquire(): Promise<void> {
    if (this.active < Math.min(SOLVER_CONCURRENCY_MAX, this.limits.solverConcurrency)) { this.active += 1; return; }
    await new Promise<void>((resolve) => { this.waiters.push(resolve); });
  }

  /** Transfer a slot directly to a waiter so a reentrant caller cannot exceed the ceiling. */
  private releaseSlot(): void { const next = this.waiters.shift(); if (next === undefined) this.active -= 1; else next(); }

  /** Record one dependent blocked plan in admission order, without process/evidence I/O.
   * @example executor.block(group, "activation", "Background is unestablished");
   */
  block(group: string, kind: string, reason: string): void {
    this.unissued(group, kind, "blocked", reason);
  }

  /** Aggregate unissued plans without allocating one entry per filtered pair.
   * @throws Error for invalid count (a programmer contract violation).
   * @remarks Zero does nothing; nonzero preserves one stable insertion ordinal. No solver I/O.
   * @example executor.unissued(group, "pair", "skipped", "pair limit", 20);
   */
  unissued(group: string, kind: string, status: "blocked" | "skipped", reason: string, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Unissued plan count must be a nonnegative safe integer");
    if (count === 0) return;
    const ordinal = this.plans.get(group) ?? 0;
    this.plans.set(group, ordinal + 1);
    this.ledger.push({ scope: `${group}:plan:${ordinal}:${kind}`, kind, status, reason, ...(count === 1 ? {} : { count }) });
  }

  /** Admit/check one assembled fragment and persist each executed script/result.
   * @returns Executed solver outcome or a skipped admission reason. Evidence bytes remain exact.
   * @throws Required persistence failures or an unexpected injected-runner failure.
   * @remarks Inputs must be typed, bounds/configuration decoded, and callers coordinate submission
   * order. Reservations precede spawn, slots release in finally, actual executions consume budget.
   * No result reuse/retry or hidden parallel admission is performed here. Timeout units are ms.
   * @example await executor.execute(group, "guard", signature, [guard]);
   */
  async execute(group: string, kind: string, signature: ExpressionSignature, predicates: readonly LogicExpression[], options: {
    readonly labels?: readonly string[]; readonly core?: boolean; readonly values?: readonly string[]; readonly timeoutMs?: number;
  } = {}): Promise<QueryOutcome> {
    const capability = /^<(?:merged-spec|generated|comparison)\/([^/>]+)(?:\/[^>]+)?>$/u.exec(group)?.[1];
    // Standalone/non-capability groups intentionally use their exact key and remain bounded.
    const budgetGroup = capability === undefined ? group : `<capability/${capability}>`;
    const count = this.counts.get(budgetGroup) ?? 0;
    const ordinal = this.plans.get(group) ?? 0;
    this.plans.set(group, ordinal + 1);
    const scope = `${group}:query:${ordinal}:${kind}`;
    const skip = (reason: string): QueryOutcome => { this.ledger.push({ scope, kind, status: "skipped", reason }); return { status: "skipped", reason }; };
    if (count >= this.limits.queryScripts) return skip("solver script count bound");
    if ([...(options.labels ?? []), ...(options.values ?? [])].some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) return skip("Unsafe query label/value identifier");
    const fragment = this.fragments.classify(signature, predicates);
    const declarations = this.signatures.render(signature);
    if (!fragment.ok || !declarations.ok) return skip(!fragment.ok ? fragment.error : !declarations.ok ? declarations.error : "invalid fragment");
    const renderedPredicates = predicates.map((predicate) => this.render(predicate));
    const script = [options.core ? "(set-option :produce-unsat-cores true)" : "", "(get-info :version)", declarations.value.trimEnd(),
      ...renderedPredicates.map((predicate, index) => `(assert ${options.labels?.[index] === undefined ? predicate : `(! ${predicate} :named ${options.labels[index]})`})`),
      "(check-sat)", ...(options.core ? ["(get-unsat-core)"] : []),
      ...(options.values?.length ? [`(get-value (${options.values.join(" ")}))`] : []), "",
    ].filter((line, index, rows) => line !== "" || index === rows.length - 1).join("\n");
    if (Buffer.byteLength(script, "utf8") > this.limits.queryBytes) return skip("compiled query byte bound");
    if (this.evidence !== undefined && !this.evidence.reserve(scope, Buffer.byteLength(script, "utf8") * 2 + this.limits.decodedBytes * 8 + QUERY_EVIDENCE_MARGIN_BYTES)) return skip("evidence admission bound");
    this.counts.set(budgetGroup, count + 1);
    try {
      const input = await this.evidence?.text(scope, "input", script, "logic", scope, "smt2");
      await this.acquire();
      let result: Z3Result;
      try { result = await this.run({ smtlib: toSmtlibContent(script), timeoutMs: options.timeoutMs ?? QUERY_TIMEOUT_DEFAULT_MS, maxOutputBytes: this.limits.decodedBytes,
        ...(this.z3Path === undefined ? {} : { z3Path: this.z3Path }) }); }
      finally { this.releaseSlot(); }
      const valueDecoding = options.values === undefined ? undefined : result.kind === "sat"
        ? this.decoder.decodeResult(result.stdout, signature, options.values)
        : { status: "unavailable" as const, assignments: null, missing: [] };
      const decodedValues = valueDecoding?.status === "complete" ? valueDecoding.assignments : null;
      const output = await this.evidence?.json(scope, "output", { scope, kind, fragment: fragment.value, predicates: renderedPredicates,
        signatureHash: this.signatures.fingerprint(signature), solverOptions: options,
        solverVersion: /\(:version "([^"]+)"\)/u.exec(result.stdout)?.[1] ?? "unavailable", result,
        decodedValues,
        ...(valueDecoding === undefined ? {} : { valueDecoding }),
        decodedCore: !options.core || result.kind !== "unsat" ? null : /\(([A-Za-z0-9_\s]*)\)\s*$/u.exec(result.stdout)?.[1]?.trim().split(/\s+/u) ?? null,
        attributionStrength: options.core ? "sufficient-not-minimized" : null,
      }, "logic", scope);
      this.ledger.push({ scope, kind, status: result.kind });
      return { status: "executed", result, script, ...(valueDecoding === undefined ? {} : { decodedValues, valueDecoding }), ...(input === undefined ? {} : { inputPath: input.path }), ...(output === undefined ? {} : { outputPath: output.path }) };
    } finally { this.evidence?.release(scope); }
  }
}
