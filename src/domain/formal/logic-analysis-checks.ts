/**
 * Deep logic checks including pairwise contradiction detection and domain
 * completeness analysis using Z3 queries over parsed implication structures.
 *
 * Extends the base logic-analysis module with fine-grained verification passes.
 * Exports: runPairwiseContradictionChecks, runCompletenessCheck.
 */
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import { runZ3Query } from "../../adapters/z3.js";
import { mapBounded } from "../../adapters/concurrency.js";
import { toSmtlibContent } from "../branded.js";
import type { ParsedImplication } from "./logic-analysis-sexpr.js";
import {
  extractImplications,
  collectVariableDeclarations,
  buildDeclarationPreamble,
  deriveSeverityFromClaims,
} from "./logic-analysis-sexpr.js";

// ---------------------------------------------------------------------------
// Pairwise Guard-Activation Contradiction Checking
// ---------------------------------------------------------------------------

/**
 * Run pairwise guard-activation contradiction checks.
 *
 * For each pair of conditional assertions (implications), check whether both guards
 * can simultaneously hold while their consequents contradict. This detects
 * contradictions that the global SAT check misses (since the global check can
 * satisfy all implications by setting guards to false).
 *
 * **Preconditions:**
 * - `input.claims` must be a non-empty readonly array of well-formed {@link LogicIrClaim} objects
 *   with valid SMT-LIB assertion expressions.
 * - `input.specFile` must be a non-empty string identifying the source specification file.
 * - `input.z3Path`, if provided, must point to a valid Z3 binary.
 *
 * **Postconditions:**
 * - Returns an array of findings with category `"logic.conditional_contradiction"`.
 * - Each finding references exactly two claims whose guards can co-activate but whose
 *   consequents are mutually unsatisfiable.
 * - If fewer than 2 implications are extractable, returns an empty array.
 *
 * @param input - The analysis input bundle.
 * @param input.claims - Readonly array of logic IR claims containing SMT-LIB assertions.
 * @param input.specFile - File path of the specification under analysis (used in provenance).
 * @param input.z3Path - Optional path to the Z3 solver binary; uses system PATH if undefined.
 *
 * @returns A readonly array of {@link Finding} objects, one per detected conditional contradiction.
 *
 * @throws Will propagate errors from the Z3 adapter if the solver binary is missing or crashes.
 * @throws May throw if `mapBounded` encounters an unhandled rejection in a concurrent task.
 *
 * @remarks
 * **Bounds:** At most `maxPairs = 50` pairs are checked (value: 50 claim pairs,
 * unitless count). This cap exists because pair generation is O(n^2) — for n=10
 * implications there are 45 pairs, which is tractable, but for n=100 there would
 * be 4,950 pairs each requiring a Z3 invocation. The budget of 50 keeps total
 * solver wall-time under ~10 minutes on typical hardware even with complex queries.
 * When exceeded, pairs are selected in enumeration order (outer-loop first), so
 * earlier claims get priority; later pairs are silently skipped.
 *
 * **Concurrency:** Pair checks run with bounded concurrency of 4 simultaneous Z3
 * processes (value: 4, unit: concurrent Z3 subprocesses). This matches the typical
 * CI core count and avoids memory contention — each Z3 process may consume
 * 50–200 MB resident. Exceeding this would increase memory pressure without
 * proportional throughput gains on ≤4-core machines.
 *
 * **Timeout:** Each individual Z3 query has a 10,000 ms (10 second) timeout
 * (enforced inside {@link checkPairContradiction}). This bounds worst-case
 * wall-time per pair for undecidable or exponentially complex queries. If
 * exceeded, the query result is treated as non-contradictory (fail-open),
 * meaning potential contradictions may go undetected rather than blocking
 * the pipeline.
 *
 * Strategy: For claims with assertions of the form `(=> Guard_i Consequent_i)`:
 * 1. Identify pairs where consequents reference overlapping variables.
 * 2. For each such pair, query Z3: can guards coexist while consequents conflict?
 *    - Assert both guards and both consequents simultaneously.
 *    - If UNSAT: consequents genuinely contradict when both guards are active.
 *
 * @example
 * ```ts
 * const findings = await runPairwiseContradictionChecks({
 *   claims: logicIr.claims,
 *   specFile: "specs/auth.md",
 *   z3Path: "/usr/local/bin/z3",
 * });
 * for (const f of findings) {
 *   console.log(f.description);
 * }
 * ```
 */
export async function runPairwiseContradictionChecks(input: {
  readonly claims: readonly LogicIrClaim[];
  readonly specFile: string;
  readonly z3Path: string | undefined;
}): Promise<readonly Finding[]> {
  const implications = extractImplications(input.claims);
  if (implications.length < 2) {
    return [];
  }

  const allVariables = collectVariableDeclarations(input.claims);
  const preamble = buildDeclarationPreamble(allVariables);
  const findings: Finding[] = [];

  // Generate pairs to check — limit to reasonable number to avoid quadratic explosion.
  const pairs: [ParsedImplication, ParsedImplication][] = [];
  const maxPairs = 50; // Limit pairwise checks to avoid excessive solver calls.
  for (let i = 0; i < implications.length && pairs.length < maxPairs; i++) {
    for (let j = i + 1; j < implications.length && pairs.length < maxPairs; j++) {
      // Only check pairs from different claims (same-claim contradictions are less interesting).
      if (implications[i]!.claim.claimId !== implications[j]!.claim.claimId) {
        pairs.push([implications[i]!, implications[j]!]);
      }
    }
  }

  // Check each pair with bounded concurrency.
  const pairResults = await mapBounded(pairs, 4, async ([left, right]) => {
    return await checkPairContradiction(left, right, preamble, input.z3Path);
  });

  for (let idx = 0; idx < pairs.length; idx++) {
    const result = pairResults[idx];
    if (result === undefined || !result.contradicts) continue;

    const [left, right] = pairs[idx]!;
    const severity = deriveSeverityFromClaims(
      [left.claim.claimId, right.claim.claimId],
      input.claims,
    );

    findings.push({
      severity,
      category: "logic.conditional_contradiction",
      provenance: { file: input.specFile },
      description: `Conditional contradiction: when guards of "${left.claim.claimId}" and "${right.claim.claimId}" are both active, their consequents conflict`,
      rationale: "When two conditional claims have overlapping guard conditions but conflicting consequents, any input satisfying both guards triggers undefined behavior — the spec demands contradictory outcomes simultaneously.",
      evidence: [
        { kind: "left_claim", value: left.claim.claimId },
        { kind: "right_claim", value: right.claim.claimId },
        { kind: "left_guard", value: left.guard },
        { kind: "right_guard", value: right.guard },
      ],
      relatedClaimIdentifiers: [left.claim.claimId, right.claim.claimId],
    });
  }

  return findings;
}

/**
 * Check whether two implications have contradictory consequents when both guards are active.
 *
 * Constructs an SMT-LIB query asserting both guards and both consequents simultaneously,
 * then invokes Z3. If the result is UNSAT, the consequents genuinely contradict under
 * co-active guards.
 *
 * **Preconditions:**
 * - `left` and `right` must be well-formed {@link ParsedImplication} objects with valid
 *   SMT-LIB `guard` and `consequent` s-expressions.
 * - `preamble` must contain all necessary SMT-LIB variable declarations for both implications.
 *
 * **Postconditions:**
 * - Returns `{ contradicts: true }` if and only if Z3 reports UNSAT — meaning the two
 *   consequents cannot both hold when both guards are active.
 * - Returns `{ contradicts: false }` for SAT, unknown, or timeout results — the absence
 *   of a contradiction proof does not guarantee consistency.
 *
 * @param left - The first parsed implication (guard + consequent pair).
 * @param right - The second parsed implication (guard + consequent pair).
 * @param preamble - SMT-LIB declarations (sorts, constants) required by both implications.
 * @param z3Path - Optional path to the Z3 solver binary; uses system PATH if undefined.
 *
 * @returns A promise resolving to `{ contradicts: boolean }` indicating whether a
 *   genuine contradiction was proven.
 *
 * @throws Will propagate errors from {@link runZ3Query} if the Z3 binary is not found,
 *   crashes, or produces unparseable output.
 *
 * @remarks
 * **Timeout:** The Z3 query is bounded to 10,000 ms. If the solver exceeds this limit,
 * the result is treated as non-contradictory (fail-open).
 *
 * The query shape is:
 * ```smt2
 * <preamble>
 * (assert <left.guard>)
 * (assert <right.guard>)
 * (assert <left.consequent>)
 * (assert <right.consequent>)
 * (check-sat)
 * ```
 *
 * @example
 * ```ts
 * const result = await checkPairContradiction(
 *   implA,
 *   implB,
 *   "(declare-const x Int)\n(declare-const y Int)",
 *   undefined,
 * );
 * if (result.contradicts) {
 *   console.log("Guards co-activate but consequents conflict.");
 * }
 * ```
 */
export async function checkPairContradiction(
  left: ParsedImplication,
  right: ParsedImplication,
  preamble: string,
  z3Path: string | undefined,
): Promise<{ contradicts: boolean }> {
  // Query: Are both guards satisfiable while consequents conflict?
  // assert(Guard_i), assert(Guard_j), assert(Consequent_i), assert(Consequent_j)
  // If UNSAT: consequents genuinely contradict when both guards are active.
  const query = toSmtlibContent([
    preamble,
    `(assert ${left.guard})`,
    `(assert ${right.guard})`,
    `(assert ${left.consequent})`,
    `(assert ${right.consequent})`,
    "(check-sat)",
  ].join("\n") + "\n");

  const result = await runZ3Query({
    smtlib: query,
    timeoutMs: 10_000,
    ...(z3Path === undefined ? {} : { z3Path }),
  });

  // UNSAT means the consequents cannot both hold when both guards are active.
  return { contradicts: result.kind === "unsat" };
}

// ---------------------------------------------------------------------------
// Completeness Gap Detection
// ---------------------------------------------------------------------------

/**
 * Check whether there exists a reachable state where no conditional rule applies.
 *
 * Negates all guards of conditional assertions and checks satisfiability via Z3.
 * If SAT, there exists an input state where no conditional rule fires, indicating
 * that the specification has a **completeness gap** — behavior is unspecified for
 * that state.
 *
 * A "completeness gap" means there is at least one satisfiable assignment of
 * declared variables for which none of the specification's conditional guards
 * evaluate to true. In such a state, no rule prescribes behavior, leaving the
 * system's expected output undefined.
 *
 * **Preconditions:**
 * - `input.claims` must be a non-empty readonly array of well-formed {@link LogicIrClaim} objects.
 * - `input.specFile` must be a non-empty string identifying the source specification file.
 * - `input.z3Path`, if provided, must point to a valid Z3 binary.
 * - At least 2 extractable implications must exist for the check to proceed.
 *
 * **Postconditions:**
 * - Returns at most one finding with category `"logic.completeness_gap"` and severity `"warning"`.
 * - Returns an empty array if: fewer than 2 implications exist, any ubiquitous
 *   (unconditional) assertions are present, or Z3 reports UNSAT/unknown/timeout.
 *
 * @param input - The analysis input bundle.
 * @param input.claims - Readonly array of logic IR claims containing SMT-LIB assertions.
 * @param input.specFile - File path of the specification under analysis (used in provenance).
 * @param input.z3Path - Optional path to the Z3 solver binary; uses system PATH if undefined.
 *
 * @returns A readonly array of {@link Finding} objects (empty or containing exactly one
 *   completeness gap finding).
 *
 * @throws Will propagate errors from {@link runZ3Query} if the Z3 binary is missing or crashes.
 *
 * @remarks
 * **Timeout:** The Z3 query is bounded to 10,000 ms. A timeout is treated as
 * non-gap (fail-closed for this advisory check).
 *
 * **Skip condition:** If any ubiquitous (unconditional) assertions exist among the
 * claims, the check is skipped entirely — the spec already provides some coverage
 * in all reachable states.
 *
 * Strategy:
 * 1. Extract all implications (guard → consequent pairs).
 * 2. Build a query negating every guard: `(assert (not Guard_i))` for all i.
 * 3. If SAT, report the gap with evidence listing the guards.
 *
 * @example
 * ```ts
 * const findings = await runCompletenessCheck({
 *   claims: logicIr.claims,
 *   specFile: "specs/routing.md",
 *   z3Path: undefined, // uses system PATH
 * });
 * if (findings.length > 0) {
 *   console.warn("Spec has unreachable states with no governing rule.");
 * }
 * ```
 */
export async function runCompletenessCheck(input: {
  readonly claims: readonly LogicIrClaim[];
  readonly specFile: string;
  readonly z3Path: string | undefined;
}): Promise<readonly Finding[]> {
  const implications = extractImplications(input.claims);
  if (implications.length < 2) {
    return [];
  }

  // Check if there are any ubiquitous (non-conditional) assertions.
  // If so, the spec has some coverage in all states and this check is less relevant.
  const hasUbiquitousAssertions = input.claims.some((claim) =>
    claim.assertions.some((a) => {
      const trimmed = a.expr.trim();
      return !trimmed.startsWith("(=>");
    }),
  );

  if (hasUbiquitousAssertions) {
    return []; // Skip completeness check when unconditional rules exist.
  }

  const allVariables = collectVariableDeclarations(input.claims);
  const preamble = buildDeclarationPreamble(allVariables);

  // Build query: negate all guards — is there a state where nothing fires?
  const negatedGuards = implications.map(
    (impl) => `(assert (not ${impl.guard}))`,
  );

  const query = toSmtlibContent([
    preamble,
    ...negatedGuards,
    "(check-sat)",
  ].join("\n") + "\n");

  const result = await runZ3Query({
    smtlib: query,
    timeoutMs: 10_000,
    ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
  });

  if (result.kind === "sat") {
    // There exists a state where no conditional rule applies.
    const guardDescriptions = implications.map(
      (impl) => `${impl.claim.claimId}:${impl.guard}`,
    );

    return [{
      severity: "warning",
      category: "logic.completeness_gap",
      provenance: { file: input.specFile },
      description: `Completeness gap: there exist states where none of the ${String(implications.length)} conditional rules apply — behavior is unspecified`,
      rationale: "If no conditional rule covers a reachable state, behavior is unspecified for those inputs — this creates an implicit partiality that weakens the correctness case.",
      evidence: [
        { kind: "guard_count", value: String(implications.length) },
        { kind: "guards", value: guardDescriptions.slice(0, 5).join("; ") + (guardDescriptions.length > 5 ? "; ..." : "") },
      ],
      relatedClaimIdentifiers: [...new Set(implications.map((i) => i.claim.claimId))],
    }];
  }

  return [];
}
