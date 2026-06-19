/**
 * Builds SMT-LIB queries for cross-implication checks by merging variable
 * declarations from two formalizations and constructing negated implication assertions.
 *
 * Internal query-building helper for the cross-implication module.
 * Exports: buildCrossImplicationQuery, classifyFromScores, scoreClassification.
 */
import { toSmtlibContent, type SmtlibContent } from "../branded.js";
import type { CrossClassification } from "./cross-implication-types.js";
import { parseSmtlibContent } from "../formal/smtlib.js";

/**
 * Score a cross-classification for greedy matching priority.
 *
 * @param classification - The cross-classification result to score
 * @returns An integer score in the range [0, 4]
 *
 * @remarks
 * Precondition: `classification` is a valid member of the `CrossClassification` union.
 * Postcondition: returns a value in {0, 1, 2, 3, 4} with strict ordering
 * same > stronger > uncertain > weaker > different.
 *
 * The ordering is designed so that greedy matching algorithms prefer tighter
 * semantic relationships first: exact matches ("same") are most desirable,
 * followed by one-way implications ("stronger"/"weaker"), with "uncertain"
 * ranked above "weaker" because inconclusive results may still indicate partial
 * semantic overlap that deserves pairing priority over known weakness.
 * Failure modes: none — pure computation.
 *
 * @example
 * ```ts
 * classificationScore("same");       // 4
 * classificationScore("stronger");   // 3
 * classificationScore("different");  // 0
 * ```
 */
export function classificationScore(classification: CrossClassification): number {
  switch (classification) {
    case "same":
      return 4;
    case "stronger":
      return 3;
    case "uncertain":
      return 2;
    case "weaker":
      return 1;
    case "different":
      return 0;
  }
}

/**
 * Combine multiple SMT-LIB file contents into a single synthetic SMT block
 * suitable for aggregate implication queries.
 *
 * @param smtContents - individual SMT-LIB content strings to merge
 * @returns combined content with deduplicated declarations and merged assertions
 *
 * @remarks
 * Precondition: each element of `smtContents` must be parseable by `parseSmtlibContent`.
 * Postcondition: declarations appear at most once (deduplicated by exact string match)
 * to avoid Z3 redeclaration errors. Assertions are preserved verbatim in encounter order.
 * The returned string does not include `(check-sat)` — callers are responsible for
 * appending solver commands.
 * Failure modes: propagates any exception thrown by `parseSmtlibContent` if an element
 * is not valid SMT-LIB syntax.
 *
 * @example
 * ```ts
 * const combined = combineSmtContent([
 *   "(declare-const x Int)\n(assert (> x 0))",
 *   "(declare-const x Int)\n(assert (< x 10))",
 * ]);
 * // combined contains one "(declare-const x Int)" and both assertions
 * ```
 */
export function combineSmtContent(smtContents: readonly string[]): string {
  const seenDeclarations = new Set<string>();
  const allDeclarations: string[] = [];
  const allAssertionExprs: string[] = [];

  for (const content of smtContents) {
    const parts = parseSmtlibContent(content);
    for (const decl of parts.declarations) {
      if (!seenDeclarations.has(decl)) {
        seenDeclarations.add(decl);
        allDeclarations.push(decl);
      }
    }
    allAssertionExprs.push(...parts.assertionExprs);
  }

  // Reassemble into a format compatible with buildImplicationQuery's parseSmtlibContent.
  const lines: string[] = [];
  lines.push(...allDeclarations);
  for (const expr of allAssertionExprs) {
    lines.push(`(assert ${expr})`);
  }
  return lines.join("\n");
}

/**
 * Build an SMT-LIB implication query combining two SMT content blocks.
 *
 * @param leftSmt - SMT-LIB content for the premise side
 * @param rightSmt - SMT-LIB content for the consequent side
 * @returns combined SMT-LIB content encoding the implication check
 *
 * @remarks
 * Strategy: include declarations from both sides for shared context, assert left's
 * assertions as the premise, then assert the negation of right's assertions.
 * If Z3 returns "unsat", the left implies the right.
 *
 * Precondition: both `leftSmt` and `rightSmt` must be parseable by `parseSmtlibContent`.
 * Postcondition: output contains exactly one `(check-sat)` at the end and is a valid
 * `SmtlibContent` branded string.
 * Failure modes: propagates any exception thrown by `parseSmtlibContent` if inputs
 * are not valid SMT-LIB syntax.
 *
 * @example
 * ```ts
 * const query = buildImplicationQuery(
 *   "(declare-const x Int)\n(assert (> x 5))",
 *   "(declare-const x Int)\n(assert (> x 0))",
 * );
 * // query encodes: does (x > 5) imply (x > 0)?
 * ```
 */
/** @internal Exported for testing. */
export function buildImplicationQuery(leftSmt: string, rightSmt: string): SmtlibContent {
  const leftParts = parseSmtlibContent(leftSmt);
  const rightParts = parseSmtlibContent(rightSmt);

  const declarations = [...leftParts.declarations, ...rightParts.declarations];
  const leftAssertions = leftParts.assertionExprs.map((expr) => `(assert ${expr})`);

  // Negate the consequent: if unsat, left entails right.
  const negatedConsequent = rightParts.assertionExprs.length === 0
    ? "(assert (not true))"
    : `(assert (not (and ${rightParts.assertionExprs.join(" ")})))`;

  return toSmtlibContent([
    "; cross-side implication query",
    ...declarations,
    ...leftAssertions,
    negatedConsequent,
    "(check-sat)",
  ].join("\n"));
}

/**
 * Classify a Z3 solver result into a ternary implication direction.
 *
 * @param kind - Z3 result kind (sat, unsat, timeout, unknown, error)
 * @returns "yes" if unsat (implication holds), "no" if sat (counterexample), "inconclusive" otherwise
 *
 * @remarks
 * Precondition: `kind` is one of the five recognized Z3 result literals.
 * Postcondition: mapping is total over the input domain — every valid `kind` produces
 * a deterministic output with no exceptions thrown.
 * Failure modes: none — pure computation.
 *
 * @example
 * ```ts
 * classifyDirection("unsat");   // "yes"   — implication holds
 * classifyDirection("sat");     // "no"    — counterexample exists
 * classifyDirection("timeout"); // "inconclusive"
 * ```
 */
export function classifyDirection(kind: "sat" | "unsat" | "timeout" | "unknown" | "error"): "yes" | "no" | "inconclusive" {
  if (kind === "unsat") {
    return "yes";
  }
  if (kind === "sat") {
    return "no";
  }
  return "inconclusive";
}

/**
 * Classify the cross-side relationship from forward and reverse implication results.
 *
 * @param forward - result of original→generated implication check
 * @param reverse - result of generated→original implication check
 * @returns cross-classification from the closed `CrossClassification` domain
 *
 * @remarks
 * Precondition: `forward` and `reverse` are each one of "yes", "no", or "inconclusive".
 * Postcondition: returns "uncertain" if either direction is inconclusive;
 * "same" for mutual implication; "weaker"/"stronger"/"different" based on
 * which direction holds. The mapping covers all 9 input combinations exhaustively.
 * Failure modes: none — pure computation.
 *
 * @example
 * ```ts
 * classifyRelationship("yes", "yes");          // "same"
 * classifyRelationship("yes", "no");           // "weaker"
 * classifyRelationship("no", "yes");           // "stronger"
 * classifyRelationship("no", "no");            // "different"
 * classifyRelationship("yes", "inconclusive"); // "uncertain"
 * ```
 */
export function classifyRelationship(
  forward: "yes" | "no" | "inconclusive",
  reverse: "yes" | "no" | "inconclusive",
): CrossClassification {
  if (forward === "inconclusive" || reverse === "inconclusive") {
    return "uncertain";
  }
  if (forward === "yes" && reverse === "yes") {
    return "same";
  }
  if (forward === "yes" && reverse === "no") {
    return "weaker";
  }
  if (forward === "no" && reverse === "yes") {
    return "stronger";
  }
  return "different";
}
