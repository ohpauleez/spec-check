/**
 * Deep logic checks including pairwise contradiction detection and domain
 * completeness analysis using Z3 queries over parsed implication structures.
 *
 * Extends the base logic-analysis module with fine-grained verification passes.
 * Exports: buildSharedCheckInputs, runPairwiseContradictionChecks,
 * checkPairContradiction, runCompletenessCheck, FORMAL_PAIR_BUDGET.
 *
 * @remarks
 * Known detection deltas (documented as future work):
 * - Self-inconsistency: the pairwise pass only compares *cross-claim* implications
 *   that share a declared symbol, so a single implication whose own guard and
 *   consequent are jointly unsatisfiable (e.g. `(=> zz (not zz))`) is not reported
 *   when it shares no symbol with any other claim. A dedicated self-consistency
 *   pass is out of scope here.
 * - Undecided sub-checks: a `timeout`/`unknown` verdict from any pairwise or
 *   completeness query is surfaced as an aggregated `logic.inconclusive` finding
 *   rather than being silently treated as "no contradiction / no gap", so a green
 *   result never masks a solver that never reached a verdict.
 */
import { mapBounded } from "../../adapters/concurrency.js";
import { runZ3Query } from "../../adapters/z3.js";
import { precondition } from "../assert.js";
import { toSmtlibContent } from "../branded.js";
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import type { ParsedImplication } from "./logic-analysis-sexpr.js";
import {
  buildDeclarationPreamble,
  collectFunctionDeclarations,
  collectVariableDeclarations,
  deriveSeverityFromClaims,
  extractImplications,
} from "./logic-analysis-sexpr.js";
import { sanitizeIdentifier } from "./smtlib.js";

/**
 * Maximum number of overlap-filtered candidate pairs checked per group.
 *
 * @remarks
 * Bound value: 50 candidate pairs (unitless count), applied **after** the
 * different-claim + symbol-overlap filter, so it caps genuine Z3 candidates
 * rather than raw enumeration. Worst-case spawns are
 * `2 × FORMAL_PAIR_BUDGET (+1 completeness)`.
 */
export const FORMAL_PAIR_BUDGET = 50;

/**
 * Maximum simultaneous Z3 subprocesses during pairwise checking.
 *
 * @remarks
 * Held at 3 (not 4) because the pairwise pass runs concurrently with the single
 * completeness query under the `Promise.all` in `analyzeSpecGroup`. Capping the
 * pairwise fan-out at 3 keeps the per-group sub-check peak at `3 + 1 = 4`
 * in-flight Z3 processes, so the group-level fan-out (`mapBounded(groups, 4)`)
 * tops out at `4 × 4 = 16` concurrent solvers rather than 20.
 */
const PAIRWISE_SOLVER_CONCURRENCY = 3;

/** Per-subquery Z3 timeout in milliseconds. */
const SUBCHECK_TIMEOUT_MS = 10_000;

/** Maximum sampled claim IDs embedded in a `logic.check_error` / `logic.inconclusive` finding. */
const CHECK_DIAGNOSTIC_SAMPLE_MAX = 5;

/** Maximum guard descriptions embedded in a completeness-gap finding. */
const GUARD_EVIDENCE_SAMPLE_MAX = 5;

/**
 * Identifier-token pattern for a **sanitized** SMT-LIB expression. After
 * {@link sanitizeIdentifier}, every symbol is pure `[A-Za-z_][A-Za-z0-9_]*`
 * (escapes such as `_00005F` fall inside this class), so this narrower pattern
 * is sufficient to recover referenced symbols.
 */
const SANITIZED_TOKEN_REGEX = /[A-Za-z_][A-Za-z0-9_]*/gu;

/**
 * Precomputed inputs shared by the pairwise and completeness checks for one
 * SAT-consistent claim group.
 *
 * @remarks
 * Invariant: `preamble` declares exactly the symbols named in `declaredSymbols`,
 * and every implication's `sanitizedGuard`/`sanitizedConsequent` references only
 * symbols drawn from that set. Building this once avoids recomputing extraction,
 * declarations, and the symbol index for each check.
 */
export interface SharedCheckInputs {
  readonly implications: readonly ParsedImplication[];
  readonly preamble: string;
  readonly declaredSymbols: ReadonlySet<string>;
}

/**
 * Outcome of one two-phase pairwise contradiction query.
 *
 * @remarks
 * Invariant: at most one of `contradicts` / `errored` / `inconclusive` is `true`
 * for a given result (the fourth state — all `false` — means the pair was checked
 * cleanly with no contradiction). `errored` reflects a Z3 `error` verdict on an
 * executed phase; `inconclusive` reflects a `timeout`/`unknown` verdict, so an
 * undecided pair is reported rather than silently treated as contradiction-free.
 */
interface PairCheckResult {
  readonly contradicts: boolean;
  readonly errored: boolean;
  readonly inconclusive: boolean;
}

/** A candidate implication pair that survived the overlap + budget filter. */
interface CandidatePair {
  readonly left: ParsedImplication;
  readonly right: ParsedImplication;
}

/**
 * Build the {@link SharedCheckInputs} for a group of claims.
 *
 * @param claims - Compile-surviving, conflict-free claims (the post-compile
 *   `survivingClaims`).
 * @returns Extracted implications, the vars+funs SMT-LIB preamble, and the set of
 *   sanitized declared symbols.
 *
 * @throws {Error} When the conflict-free precondition is violated — i.e. a
 *   sanitized symbol name is declared as **both** a variable and a function.
 *
 * @remarks
 * Precondition (caller contract): `claims` are compile-surviving and
 * conflict-free. The compile stage (`compileSpecSmtlib`) guarantees no sanitized
 * name maps to both a variable and a function; this function asserts that
 * lightweight invariant rather than re-running full merge validation.
 *
 * Postconditions:
 * - `declaredSymbols` = sanitized variable names ∪ sanitized function names.
 * - `preamble` declares those symbols (vars then funs), matching the global
 *   compile encoding.
 *
 * Failure modes: throws only on precondition violation; otherwise pure.
 */
export function buildSharedCheckInputs(claims: readonly LogicIrClaim[]): SharedCheckInputs {
  const variables = collectVariableDeclarations(claims);
  const functions = collectFunctionDeclarations(claims);

  const variableSymbols = new Set<string>();
  for (const variable of variables) {
    variableSymbols.add(sanitizeIdentifier(variable.name));
  }
  const functionSymbols = new Set<string>();
  for (const fn of functions) {
    functionSymbols.add(sanitizeIdentifier(fn.name));
  }

  const declaredSymbols = new Set<string>(variableSymbols);
  for (const symbol of functionSymbols) {
    precondition(
      !variableSymbols.has(symbol),
      `sanitized symbol ${symbol} is declared as both variable and function; claims must be compile-surviving and conflict-free`,
    );
    declaredSymbols.add(symbol);
  }

  return {
    implications: extractImplications(claims),
    preamble: buildDeclarationPreamble(variables, functions),
    declaredSymbols,
  };
}

/**
 * Run pairwise guard-activation contradiction checks.
 *
 * For each cross-claim pair of implications sharing at least one declared symbol,
 * a two-phase check asks whether both guards are jointly satisfiable **and** their
 * consequents conflict under those co-active guards. This detects contradictions
 * the global SAT check misses (the global check can satisfy every implication by
 * falsifying its guard).
 *
 * **Preconditions:**
 * - `input.claims` are compile-surviving, conflict-free {@link LogicIrClaim}s.
 * - `input.specFile` is a non-empty provenance string.
 * - `input.pairBudget`, if provided, is a positive safe integer.
 *
 * **Postconditions:**
 * - Returns findings of category `"logic.conditional_contradiction"`, followed by
 *   at most one aggregated `"logic.check_error"` (when any query errored) and then
 *   at most one aggregated `"logic.inconclusive"` (when any query timed out or
 *   returned `unknown`). Aggregated diagnostics always follow the contradictions
 *   and are emitted in this fixed order for deterministic output.
 * - Every reported contradiction implies Phase 1 was `sat` (guards co-activate).
 * - Fewer than 2 implications, or no symbol-overlapping cross-claim pair, yields
 *   an empty array.
 *
 * @param input - Analysis input bundle.
 * @param input.claims - Readonly array of logic IR claims (used for severity).
 * @param input.specFile - Specification file path (used in provenance).
 * @param input.z3Path - Optional Z3 binary path; uses system PATH if undefined.
 * @param input.precomputed - Optional {@link SharedCheckInputs}; recomputed from
 *   `claims` when absent (preserving standalone/test callers).
 * @param input.pairBudget - Optional post-filter candidate cap; defaults to
 *   {@link FORMAL_PAIR_BUDGET}.
 * @returns A readonly array of findings.
 *
 * @throws {Error} Propagates the conflict-free precondition (via
 *   {@link buildSharedCheckInputs}) and any unhandled Z3 adapter rejection.
 *
 * @remarks
 * **Bounds:** at most `pairBudget` candidate pairs are checked (default
 * {@link FORMAL_PAIR_BUDGET}), applied after the overlap filter so budget is never
 * spent on skipped pairs.
 * **Concurrency:** pair checks run with bounded concurrency
 * {@link PAIRWISE_SOLVER_CONCURRENCY}; the two phases of a pair issue
 * **sequentially**, so per-pair in-flight solver processes stay at 1.
 * **Timeout:** each Z3 query is bounded to {@link SUBCHECK_TIMEOUT_MS}; a non-`sat`
 * Phase 1 or non-`unsat` Phase 2 is not treated as a contradiction. A `timeout`/
 * `unknown` verdict on either phase is aggregated into a `logic.inconclusive`
 * finding rather than silently ignored, so an undecided solver never masquerades
 * as a clean result.
 */
export async function runPairwiseContradictionChecks(input: {
  readonly claims: readonly LogicIrClaim[];
  readonly specFile: string;
  readonly z3Path: string | undefined;
  readonly precomputed?: SharedCheckInputs;
  readonly pairBudget?: number;
}): Promise<readonly Finding[]> {
  const pairBudget = input.pairBudget ?? FORMAL_PAIR_BUDGET;
  precondition(
    Number.isSafeInteger(pairBudget) && pairBudget > 0,
    `pairBudget must be a positive safe integer; got ${String(pairBudget)}`,
  );

  const shared = input.precomputed ?? buildSharedCheckInputs(input.claims);
  if (shared.implications.length < 2) {
    return [];
  }

  const candidatePairs = selectCandidatePairs(shared.implications, shared.declaredSymbols, pairBudget);
  if (candidatePairs.length === 0) {
    return [];
  }

  const results = await mapBounded(candidatePairs, PAIRWISE_SOLVER_CONCURRENCY, async (pair) =>
    checkPairContradiction(pair.left, pair.right, shared.preamble, input.z3Path),
  );

  return collectPairwiseFindings(candidatePairs, results, input.claims, input.specFile);
}

/**
 * Select cross-claim implication pairs that share a declared symbol, capped at
 * `pairBudget` **survivors**.
 *
 * @param implications - All parsed implications for the group.
 * @param declaredSymbols - Sanitized symbols declared in the preamble.
 * @param pairBudget - Maximum number of surviving pairs to gather.
 * @returns Candidate pairs in input-enumeration order (outer loop first).
 *
 * @remarks
 * Same-claim pairs (self-inconsistency, out of scope) and symbol-disjoint pairs
 * (cannot conflict over shared state) are skipped. Budget counts only pushed
 * survivors, so skipped pairs never consume it. Failure modes: none — pure.
 */
function selectCandidatePairs(
  implications: readonly ParsedImplication[],
  declaredSymbols: ReadonlySet<string>,
  pairBudget: number,
): readonly CandidatePair[] {
  const symbolSets = implications.map((impl) => referencedSymbols(impl, declaredSymbols));

  const pairs: CandidatePair[] = [];
  for (let i = 0; i < implications.length && pairs.length < pairBudget; i++) {
    for (let j = i + 1; j < implications.length && pairs.length < pairBudget; j++) {
      const left = implications[i]!;
      const right = implications[j]!;
      if (left.claim.claimId === right.claim.claimId) {
        continue;
      }
      if (!symbolSetsOverlap(symbolSets[i]!, symbolSets[j]!)) {
        continue;
      }
      pairs.push({ left, right });
    }
  }
  return pairs;
}

/**
 * Collect the declared symbols referenced by an implication (guard ∪ consequent),
 * computed over its **sanitized** expressions.
 */
function referencedSymbols(impl: ParsedImplication, declaredSymbols: ReadonlySet<string>): ReadonlySet<string> {
  const symbols = new Set<string>();
  collectDeclaredTokens(impl.sanitizedGuard, declaredSymbols, symbols);
  collectDeclaredTokens(impl.sanitizedConsequent, declaredSymbols, symbols);
  return symbols;
}

/**
 * Add every `declaredSymbols` token appearing in `sanitizedExpr` to `out`.
 *
 * @remarks
 * Uses `String.prototype.match` with a global regex, which resets `lastIndex` to
 * 0 on completion, so sharing {@link SANITIZED_TOKEN_REGEX} across synchronous
 * calls is safe. Failure modes: none — pure.
 */
function collectDeclaredTokens(sanitizedExpr: string, declaredSymbols: ReadonlySet<string>, out: Set<string>): void {
  const tokens = sanitizedExpr.match(SANITIZED_TOKEN_REGEX);
  if (tokens === null) {
    return;
  }
  for (const token of tokens) {
    if (declaredSymbols.has(token)) {
      out.add(token);
    }
  }
}

/** Return `true` when two symbol sets intersect (iterating the smaller set). */
function symbolSetsOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const symbol of small) {
    if (large.has(symbol)) {
      return true;
    }
  }
  return false;
}

/**
 * Two-phase pairwise contradiction check for a single implication pair.
 *
 * **Phase 1 (guard co-activation):** `sat(sanitizedGuard_l ∧ sanitizedGuard_r)`.
 * If the result is **not** `sat`, the guards cannot (or cannot be proven to)
 * co-activate, so no reachable state triggers the pair — return
 * `{ contradicts: false }` and **skip Phase 2**.
 * **Phase 2 (consequent conflict):** assert both guards and both consequents;
 * `unsat` means the consequents genuinely contradict under co-active guards.
 *
 * **Preconditions:** `left`/`right` are well-formed {@link ParsedImplication}s;
 * `preamble` declares every symbol their sanitized expressions reference.
 *
 * **Postconditions:**
 * - `contradicts` is `true` iff Phase 1 was `sat` **and** Phase 2 was `unsat`.
 * - `errored` is `true` iff an executed phase returned `kind:"error"`.
 * - `inconclusive` is `true` iff an executed phase returned `kind:"timeout"` or
 *   `kind:"unknown"` (guard co-activation or consequent conflict left undecided).
 * - Only **sanitized** guard/consequent forms enter the query (symbol parity).
 *
 * @param left - First implication.
 * @param right - Second implication.
 * @param preamble - SMT-LIB declarations (vars + funs) covering both.
 * @param z3Path - Optional Z3 binary path; uses system PATH if undefined.
 * @returns `{ contradicts, errored, inconclusive }`.
 *
 * @throws {Error} Propagates an unhandled rejection from {@link runZ3Query}.
 *
 * @remarks
 * Each phase is bounded to {@link SUBCHECK_TIMEOUT_MS}. A surviving pair costs 1
 * spawn when Phase 1 is non-`sat` and 2 spawns when Phase 1 is `sat`; the spawns
 * are sequential, so in-flight concurrency per pair stays 1.
 */
export async function checkPairContradiction(
  left: ParsedImplication,
  right: ParsedImplication,
  preamble: string,
  z3Path: string | undefined,
): Promise<PairCheckResult> {
  const phase1 = await runZ3Query({
    smtlib: toSmtlibContent([
      preamble,
      `(assert ${left.sanitizedGuard})`,
      `(assert ${right.sanitizedGuard})`,
      "(check-sat)",
    ].join("\n") + "\n"),
    timeoutMs: SUBCHECK_TIMEOUT_MS,
    ...(z3Path === undefined ? {} : { z3Path }),
  });

  if (phase1.kind !== "sat") {
    // Guards cannot be proven to co-activate, so Phase 2 is skipped. Distinguish a
    // hard solver error from a timeout/unknown: the latter must surface as an
    // inconclusive diagnostic rather than be silently treated as "no contradiction".
    return {
      contradicts: false,
      errored: phase1.kind === "error",
      inconclusive: phase1.kind === "timeout" || phase1.kind === "unknown",
    };
  }

  const phase2 = await runZ3Query({
    smtlib: toSmtlibContent([
      preamble,
      `(assert ${left.sanitizedGuard})`,
      `(assert ${right.sanitizedGuard})`,
      `(assert ${left.sanitizedConsequent})`,
      `(assert ${right.sanitizedConsequent})`,
      "(check-sat)",
    ].join("\n") + "\n"),
    timeoutMs: SUBCHECK_TIMEOUT_MS,
    ...(z3Path === undefined ? {} : { z3Path }),
  });

  return {
    contradicts: phase2.kind === "unsat",
    errored: phase2.kind === "error",
    inconclusive: phase2.kind === "timeout" || phase2.kind === "unknown",
  };
}

/**
 * Fold pairwise results into findings: one `logic.conditional_contradiction` per
 * proven pair (input order), then at most one aggregated `logic.check_error`, then
 * at most one aggregated `logic.inconclusive`.
 *
 * @remarks
 * The aggregated diagnostics are appended **after** the contradictions and in a
 * fixed order (error before inconclusive) so mixed success/error/inconclusive
 * output is deterministic. Failure modes: none — pure.
 */
function collectPairwiseFindings(
  pairs: readonly CandidatePair[],
  results: readonly PairCheckResult[],
  claims: readonly LogicIrClaim[],
  specFile: string,
): readonly Finding[] {
  const findings: Finding[] = [];
  const erroredClaimIds: string[] = [];
  const inconclusiveClaimIds: string[] = [];
  let erroredQueryCount = 0;
  let inconclusiveQueryCount = 0;

  for (let idx = 0; idx < pairs.length; idx++) {
    const result = results[idx];
    if (result === undefined) {
      continue;
    }
    const pair = pairs[idx]!;
    if (result.errored) {
      erroredQueryCount += 1;
      erroredClaimIds.push(pair.left.claim.claimId, pair.right.claim.claimId);
    }
    if (result.inconclusive) {
      inconclusiveQueryCount += 1;
      inconclusiveClaimIds.push(pair.left.claim.claimId, pair.right.claim.claimId);
    }
    if (result.contradicts) {
      findings.push(buildContradictionFinding(pair, claims, specFile));
    }
  }

  // Aggregated diagnostics follow the real contradictions in a fixed order so the
  // finding list is deterministic regardless of which solver settled first.
  if (erroredQueryCount > 0) {
    findings.push(buildCheckErrorFinding("pairwise", erroredQueryCount, pairs.length, erroredClaimIds, specFile));
  }
  if (inconclusiveQueryCount > 0) {
    findings.push(buildCheckInconclusiveFinding("pairwise", inconclusiveQueryCount, pairs.length, inconclusiveClaimIds, specFile));
  }

  return findings;
}

/** Build one `logic.conditional_contradiction` finding (raw guards in evidence). */
function buildContradictionFinding(pair: CandidatePair, claims: readonly LogicIrClaim[], specFile: string): Finding {
  const { left, right } = pair;
  const severity = deriveSeverityFromClaims([left.claim.claimId, right.claim.claimId], claims);

  return {
    severity,
    category: "logic.conditional_contradiction",
    provenance: { file: specFile },
    description: `Conditional contradiction: guards of "${left.claim.claimId}" and "${right.claim.claimId}" are jointly satisfiable, yet their consequents conflict when both are active`,
    rationale: "When two conditional claims have guards that can hold simultaneously but consequents that cannot, any input satisfying both guards forces the spec to demand contradictory outcomes at once.",
    evidence: [
      { kind: "left_claim", value: left.claim.claimId },
      { kind: "right_claim", value: right.claim.claimId },
      { kind: "left_guard", value: left.guard },
      { kind: "right_guard", value: right.guard },
    ],
    relatedClaimIdentifiers: [left.claim.claimId, right.claim.claimId],
  };
}

/**
 * Check whether there exists a reachable state where no conditional rule applies.
 *
 * Negates every guard and asks Z3 for satisfiability. `sat` means some assignment
 * of declared symbols leaves all guards false — a **completeness gap** where
 * behavior is unspecified.
 *
 * **Preconditions:**
 * - `input.claims` are compile-surviving, conflict-free {@link LogicIrClaim}s.
 * - `input.specFile` is a non-empty provenance string.
 *
 * **Postconditions:**
 * - Returns at most one finding: `logic.completeness_gap` (severity `warning`) on
 *   `sat`, `logic.check_error` on `kind:"error"`, or `logic.inconclusive` on
 *   `kind:"timeout"`/`kind:"unknown"`.
 * - Returns empty for: fewer than 2 implications, a group-wide unconditional
 *   assertion present, or `unsat`.
 *
 * @param input - Analysis input bundle.
 * @param input.claims - Readonly array of logic IR claims.
 * @param input.specFile - Specification file path (used in provenance).
 * @param input.z3Path - Optional Z3 binary path; uses system PATH if undefined.
 * @param input.precomputed - Optional {@link SharedCheckInputs}; recomputed from
 *   `claims` when absent.
 * @returns A readonly array of findings (empty or exactly one).
 *
 * @throws {Error} Propagates the conflict-free precondition (via
 *   {@link buildSharedCheckInputs}) and any unhandled Z3 adapter rejection.
 *
 * @remarks
 * The single Z3 query is bounded to {@link SUBCHECK_TIMEOUT_MS}. Only **sanitized**
 * guards enter the query, and the vars+funs preamble declares every symbol they
 * reference. The group-wide unconditional-assertion skip is a pre-existing
 * heuristic (out of scope for change).
 */
export async function runCompletenessCheck(input: {
  readonly claims: readonly LogicIrClaim[];
  readonly specFile: string;
  readonly z3Path: string | undefined;
  readonly precomputed?: SharedCheckInputs;
}): Promise<readonly Finding[]> {
  const shared = input.precomputed ?? buildSharedCheckInputs(input.claims);
  if (shared.implications.length < 2) {
    return [];
  }

  // Group-wide coarseness (pre-existing heuristic, out of scope to change): a
  // SINGLE unconditional (non-`(=>`) assertion anywhere in the group suppresses
  // the completeness check for the ENTIRE group. An unconditional assertion
  // already constrains every state, so a "no rule fires" gap is not meaningful;
  // the coarse part is that one such assertion also masks gaps among the group's
  // remaining conditional rules.
  const hasGroupWideUnconditionalAssertion = input.claims.some((claim) =>
    claim.assertions.some((assertion) => !assertion.expr.trim().startsWith("(=>")),
  );
  if (hasGroupWideUnconditionalAssertion) {
    return [];
  }

  const negatedGuards = shared.implications.map((impl) => `(assert (not ${impl.sanitizedGuard}))`);
  const query = toSmtlibContent([shared.preamble, ...negatedGuards, "(check-sat)"].join("\n") + "\n");

  const result = await runZ3Query({
    smtlib: query,
    timeoutMs: SUBCHECK_TIMEOUT_MS,
    ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
  });

  if (result.kind === "error") {
    const erroredClaimIds = shared.implications.map((impl) => impl.claim.claimId);
    return [buildCheckErrorFinding("completeness", 1, 1, erroredClaimIds, input.specFile)];
  }

  if (result.kind === "timeout" || result.kind === "unknown") {
    // Undecided within the resource budget: absence of a gap is not proof of
    // totality, so surface it rather than returning an empty (clean) result.
    const inconclusiveClaimIds = shared.implications.map((impl) => impl.claim.claimId);
    return [buildCheckInconclusiveFinding("completeness", 1, 1, inconclusiveClaimIds, input.specFile)];
  }

  if (result.kind === "sat") {
    return [buildCompletenessGapFinding(shared.implications, input.specFile)];
  }

  return [];
}

/** Build the single `logic.completeness_gap` finding (raw guards in evidence). */
function buildCompletenessGapFinding(implications: readonly ParsedImplication[], specFile: string): Finding {
  const guardDescriptions = implications.map((impl) => `${impl.claim.claimId}:${impl.guard}`);
  const guardSample = guardDescriptions.slice(0, GUARD_EVIDENCE_SAMPLE_MAX).join("; ")
    + (guardDescriptions.length > GUARD_EVIDENCE_SAMPLE_MAX ? "; ..." : "");

  return {
    severity: "warning",
    category: "logic.completeness_gap",
    provenance: { file: specFile },
    description: `Completeness gap: there exist states where none of the ${String(implications.length)} conditional rules apply — behavior is unspecified`,
    rationale: "If no conditional rule covers a reachable state, behavior is unspecified for those inputs — this creates an implicit partiality that weakens the correctness case.",
    evidence: [
      { kind: "guard_count", value: String(implications.length) },
      { kind: "guards", value: guardSample },
    ],
    relatedClaimIdentifiers: [...new Set(implications.map((i) => i.claim.claimId))],
  };
}

/**
 * Build one aggregated `logic.check_error` finding for a check type.
 *
 * @remarks
 * Security: evidence carries **only** counts and claim IDs — never raw SMT-LIB,
 * stdout, or stderr — so untrusted solver text cannot leak into reports. Claim IDs
 * are deduped and lexicographically sorted for deterministic output; the sample is
 * capped at {@link CHECK_DIAGNOSTIC_SAMPLE_MAX}. Failure modes: none — pure.
 */
function buildCheckErrorFinding(
  checkType: "pairwise" | "completeness",
  erroredQueryCount: number,
  totalQueryCount: number,
  erroredClaimIds: readonly string[],
  specFile: string,
): Finding {
  const sortedUnique = [...new Set(erroredClaimIds)].sort((a, b) => a.localeCompare(b));
  const sample = sortedUnique.slice(0, CHECK_DIAGNOSTIC_SAMPLE_MAX);

  return {
    severity: "warning",
    category: "logic.check_error",
    provenance: { file: specFile },
    description: `${checkType} inconclusive: ${String(erroredQueryCount)} of ${String(totalQueryCount)} solver queries errored`,
    rationale: "Solver errors mean this check could not run cleanly, so the absence of contradiction or gap findings is not evidence of correctness.",
    evidence: [
      { kind: "check_type", value: checkType },
      { kind: "errored_query_count", value: String(erroredQueryCount) },
      { kind: "total_query_count", value: String(totalQueryCount) },
      { kind: "sample_claim_ids", value: sample.join("; ") },
    ],
    relatedClaimIdentifiers: sortedUnique,
  };
}

/**
 * Build one aggregated `logic.inconclusive` finding for a check type.
 *
 * @param checkType - Which sub-check produced the undecided queries.
 * @param inconclusiveQueryCount - Count of queries that returned `timeout`/`unknown`.
 * @param totalQueryCount - Total queries attempted by the check (for context).
 * @param inconclusiveClaimIds - Claim IDs implicated by the undecided queries.
 * @param specFile - Provenance file for the finding.
 * @returns One `logic.inconclusive` finding (severity `warning`).
 *
 * @remarks
 * Surfaces sub-check queries the solver could not decide within its resource
 * limits (`timeout`/`unknown`). Emitting this keeps "no contradiction / no gap
 * found" from being mistaken for "proven clean" when the underlying solver never
 * reached a verdict; it mirrors the group-level `logic.inconclusive` finding
 * raised by the global consistency check in `analyzeSpecGroup`.
 *
 * Security: evidence carries **only** counts and claim IDs — never raw SMT-LIB,
 * stdout, or stderr — so untrusted solver text cannot leak into reports. Claim IDs
 * are deduped and lexicographically sorted for deterministic output; the sample is
 * capped at {@link CHECK_DIAGNOSTIC_SAMPLE_MAX}. Failure modes: none — pure.
 */
function buildCheckInconclusiveFinding(
  checkType: "pairwise" | "completeness",
  inconclusiveQueryCount: number,
  totalQueryCount: number,
  inconclusiveClaimIds: readonly string[],
  specFile: string,
): Finding {
  const sortedUnique = [...new Set(inconclusiveClaimIds)].sort((a, b) => a.localeCompare(b));
  const sample = sortedUnique.slice(0, CHECK_DIAGNOSTIC_SAMPLE_MAX);

  return {
    severity: "warning",
    category: "logic.inconclusive",
    provenance: { file: specFile },
    description: `${checkType} inconclusive: ${String(inconclusiveQueryCount)} of ${String(totalQueryCount)} solver queries returned timeout/unknown`,
    rationale: "Solver timeouts or unknown verdicts mean this check never reached a decision, so the absence of contradiction or gap findings is not evidence of correctness.",
    evidence: [
      { kind: "check_type", value: checkType },
      { kind: "inconclusive_query_count", value: String(inconclusiveQueryCount) },
      { kind: "total_query_count", value: String(totalQueryCount) },
      { kind: "sample_claim_ids", value: sample.join("; ") },
    ],
    relatedClaimIdentifiers: sortedUnique,
  };
}
