/**
 * Provides S-expression parsing utilities for SMT-LIB assertion analysis.
 * Extracts implication structures and variable declarations from compiled claims
 * to enable pairwise contradiction and completeness checks.
 *
 * Internal helper for the logic-analysis subsystem.
 * Exports: extractImplications, collectVariableDeclarations,
 * collectFunctionDeclarations, buildDeclarationPreamble, deriveSeverityFromClaims.
 */
import { assertNever } from "../assert.js";
import type { FindingSeverity } from "../findings.js";
import type { LogicFunctionSymbol, LogicIrClaim, LogicObligation, LogicVariableDeclaration } from "../logic-ir.js";
import { sanitizeAssertionExpr, sanitizeIdentifier } from "./smtlib.js";

/**
 * A parsed implication assertion: antecedent => consequent.
 * Claims whose assertion expressions match `(=> guard consequent)` have
 * a guard that can be activated to check pairwise contradiction.
 *
 * @remarks
 * Invariant: `sanitizedGuard === sanitizeAssertionExpr(guard)` and
 * `sanitizedConsequent === sanitizeAssertionExpr(consequent)`. The **raw**
 * `guard`/`consequent` are used only in human-facing evidence; the **sanitized**
 * forms are the only variants that may enter a solver query, guaranteeing symbol
 * parity with the compiled preamble.
 */
export interface ParsedImplication {
  readonly claim: LogicIrClaim;
  readonly assertionIndex: number;
  readonly guard: string;
  readonly consequent: string;
  readonly sanitizedGuard: string;
  readonly sanitizedConsequent: string;
}

/**
 * Extract implications from claims. Only assertions matching the pattern
 * `(=> <guard> <consequent>)` are considered conditional rules.
 *
 * @param claims - The set of logic IR claims to scan for implication assertions.
 * @returns A list of parsed implications, one per matching assertion across all claims.
 *
 * @remarks
 * Preconditions: Each claim must have a well-formed `assertions` array with `expr` strings.
 *
 * Postconditions:
 * - The returned array contains only implications whose assertions successfully parsed
 *   as `(=> guard consequent)`.
 * - Each result retains a reference to its originating claim and assertion index.
 * - Non-implication assertions (e.g., bare predicates, conjunctions) are silently skipped.
 *
 * Failure modes: none — pure computation.
 *
 * The matched pattern is specifically the SMT-LIB implication form: an S-expression
 * whose operator is `=>` with exactly two operands (guard and consequent).
 *
 * @example
 * ```ts
 * const claims: LogicIrClaim[] = [{
 *   claimId: "c1",
 *   obligation: "mandatory",
 *   variables: [],
 *   assertions: [{ expr: "(=> (> x 0) (< y 10))" }],
 * }];
 * const implications = extractImplications(claims);
 * // implications[0].guard === "(> x 0)"
 * // implications[0].consequent === "(< y 10)"
 * ```
 */
export function extractImplications(claims: readonly LogicIrClaim[]): readonly ParsedImplication[] {
  const results: ParsedImplication[] = [];

  for (const claim of claims) {
    for (let i = 0; i < claim.assertions.length; i++) {
      const expr = claim.assertions[i]!.expr.trim();
      const parsed = parseImplicationExpr(expr);
      if (parsed !== null) {
        results.push({
          claim,
          assertionIndex: i,
          guard: parsed.guard,
          consequent: parsed.consequent,
          sanitizedGuard: sanitizeAssertionExpr(parsed.guard),
          sanitizedConsequent: sanitizeAssertionExpr(parsed.consequent),
        });
      }
    }
  }

  return results;
}

/**
 * Parse an SMT-LIB expression of the form `(=> <guard> <consequent>)`.
 * Returns null if the expression is not a simple implication.
 *
 * @param expr - A trimmed SMT-LIB expression string to attempt parsing.
 * @returns An object with `guard` and `consequent` strings if the expression is a valid
 *   binary implication, or `null` if it does not match.
 *
 * @remarks
 * Preconditions: `expr` must be a valid `=>` S-expression with balanced parentheses.
 * Specifically, the outer form must be `(=> <part1> <part2>)` with exactly two top-level
 * sub-expressions after the `=>` operator.
 *
 * Postconditions:
 * - On success, `guard` and `consequent` are the two top-level operands (which may
 *   themselves be nested S-expressions).
 * - Returns `null` for malformed input including: expressions that don't start with `(=>`,
 *   implications with fewer or more than two operands, or empty strings.
 *
 * Failure modes: none — returns null for unrecognized input rather than throwing.
 */
export function parseImplicationExpr(expr: string): { guard: string; consequent: string } | null {
  // Goal: extract the guard and consequent from a binary implication of the
  // form `(=> <guard> <consequent>)`. This is the only conditional pattern
  // we recognize for pairwise contradiction analysis.

  // First, reject anything that doesn't even begin with the implication
  // operator. This fast-path avoids allocating substrings for the vast
  // majority of non-implication assertions.
  if (!expr.startsWith("(=>")) {
    return null;
  }

  // Goal: peel off the outermost parentheses and the `=>` operator to expose
  // the two operand expressions. After slicing, `inner` looks like
  // `=> <guard> <consequent>` (no outer parens).
  // This is safe because we already confirmed the string starts with `(=>`,
  // so the first char is `(` and (assuming balanced input) the last is `)`.
  const inner = expr.slice(1, -1).trim(); // Remove outer ( and )
  if (!inner.startsWith("=>")) {
    return null;
  }

  // Strip the `=>` operator itself, leaving just `<guard> <consequent>`.
  // Trimming ensures we don't trip on variable whitespace after the arrow.
  const afterArrow = inner.slice(2).trim();

  // Goal: split the remainder into exactly two balanced top-level parts.
  // The guard and consequent may each be atoms (`x`) or nested
  // S-expressions (`(> x 0)`), so we rely on balanced-paren boundary
  // detection via `splitSExprParts` rather than naive whitespace splitting.
  //
  // Well-formed input yields exactly 2 parts. Anything else (0, 1, or 3+
  // parts) means this is either a malformed implication or a higher-arity
  // connective — reject it.
  const parts = splitSExprParts(afterArrow);
  if (parts.length !== 2) {
    return null;
  }

  return { guard: parts[0]!, consequent: parts[1]! };
}

/**
 * Split an S-expression string into its top-level parts.
 * Handles both atomic identifiers and parenthesized sub-expressions.
 *
 * @param expr - The S-expression body to split (without an enclosing outer pair of parentheses).
 * @returns An array of top-level tokens, each being either an atomic identifier or a
 *   complete parenthesized sub-expression.
 *
 * @remarks
 * Invariants:
 * - Parentheses are tracked via a depth counter; a parenthesized part is captured from
 *   the opening `(` through its balanced closing `)`.
 * - Atomic identifiers are delimited by whitespace or parentheses.
 * - Leading/trailing whitespace between parts is consumed and not included in results.
 *
 * Behavior on malformed input:
 * - Unbalanced parentheses (more opens than closes) will cause the parser to consume
 *   through the end of the string, treating the remainder as a single (malformed) part.
 * - An empty or whitespace-only input returns an empty array.
 *
 * Failure modes: none — pure computation. Malformed input produces best-effort output.
 *
 * @example
 * ```ts
 * splitSExprParts("(> x 0) (< y 10)")
 * // => ["(> x 0)", "(< y 10)"]
 *
 * splitSExprParts("x (and a b) z")
 * // => ["x", "(and a b)", "z"]
 * ```
 */
export function splitSExprParts(expr: string): string[] {
  // Strategy: Walk the string left-to-right, splitting at top-level boundaries.
  // A "top-level" boundary is whitespace at paren depth 0. Parenthesized
  // sub-expressions are consumed whole by tracking depth; atomic tokens are
  // delimited by whitespace or the start of a parenthesized group.

  const parts: string[] = [];
  let i = 0;
  const len = expr.length;

  // Invariant: at the top of each iteration, `i` points to either:
  //   (a) the start of the next token (atom or paren-group), or
  //   (b) leading whitespace that will be consumed before (a).
  // No partial token is in progress — each iteration captures exactly one part.
  while (i < len) {
    // Goal: advance past inter-token whitespace so `i` sits on a token start.
    // This preserves the invariant that we never emit empty strings.
    while (i < len && isSExprWhitespace(expr.charCodeAt(i))) i++;
    if (i >= len) break;

    if (expr[i] === "(") {
      // Goal: capture a complete parenthesized sub-expression as one part.
      // We use a depth counter to find the matching close-paren.
      let depth = 0;
      const start = i;

      // Invariant: `depth` is always non-negative inside this loop.
      // It increments on `(` and decrements on `)`. Because we entered on a
      // `(`, depth starts at 1 after the first character and can only return
      // to 0 when the matching `)` is found.
      while (i < len) {
        if (expr[i] === "(") depth++;
        else if (expr[i] === ")") {
          depth--;
          // When depth returns to 0, we've found the balanced close-paren.
          // Advance past it and break — the slice [start, i) is complete.
          if (depth === 0) { i++; break; }
        }
        i++;
      }
      // If the input is malformed (more opens than closes), the inner loop
      // exhausts the string with depth > 0. We still emit whatever was
      // captured — the caller receives a truncated, unbalanced fragment.
      parts.push(expr.slice(start, i));
    } else {
      // Goal: capture an atomic identifier (a non-paren, non-whitespace run).
      // Atoms are bounded by whitespace or the start of a sub-expression,
      // so we consume until we hit a delimiter. This is safe because we
      // already know `expr[i]` is neither whitespace nor `(`.
      const start = i;
      while (i < len && !isSExprDelimiter(expr.charCodeAt(i))) i++;
      parts.push(expr.slice(start, i));
    }
  }

  // Postcondition: every part is either a balanced paren-group or an atom.
  // If the input was well-formed (balanced parens), the concatenation of
  // parts separated by single spaces reconstructs the semantic content.
  return parts;
}

/**
 * Test whether a UTF-16 code unit is ASCII whitespace that delimits S-expression
 * tokens (space, tab, LF, CR, VT, FF).
 *
 * @param code - A UTF-16 code unit, typically from `String.prototype.charCodeAt`.
 * @returns `true` for ` `, `\t`, `\n`, `\r`, `\v`, `\f`; otherwise `false`.
 *
 * @remarks
 * Hot-path replacement for `/\s/.test(...)` in {@link splitSExprParts}. Scoped to
 * ASCII whitespace, which is the only whitespace the compile path emits into
 * SMT-LIB assertion text. Failure modes: none — pure computation.
 */
function isSExprWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c;
}

/**
 * Test whether a UTF-16 code unit terminates an atomic S-expression token —
 * ASCII whitespace or a parenthesis.
 *
 * @param code - A UTF-16 code unit, typically from `String.prototype.charCodeAt`.
 * @returns `true` for whitespace, `(` (0x28), or `)` (0x29); otherwise `false`.
 *
 * @remarks
 * Hot-path replacement for `/[\s()]/.test(...)` in {@link splitSExprParts}.
 * Failure modes: none — pure computation.
 */
function isSExprDelimiter(code: number): boolean {
  return isSExprWhitespace(code) || code === 0x28 || code === 0x29;
}

/**
 * Collect all variable declarations across a set of claims (deduplicated by name).
 *
 * @param claims - The set of logic IR claims whose variable declarations should be merged.
 * @returns A deduplicated array of variable declarations preserving encounter order.
 *
 * @remarks
 * Deduplication strategy: **first-wins**. When multiple claims declare variables with the
 * same name, the declaration from the earliest claim (in iteration order) is kept and
 * subsequent duplicates are discarded. This means the sort/type of the first occurrence
 * is authoritative.
 *
 * Postconditions:
 * - Every unique variable name appears exactly once in the result.
 * - The result order follows the first-encounter order across claims and their variable lists.
 *
 * Failure modes: none — pure computation.
 */
export function collectVariableDeclarations(claims: readonly LogicIrClaim[]): readonly LogicVariableDeclaration[] {
  const seen = new Map<string, LogicVariableDeclaration>();
  for (const claim of claims) {
    for (const variable of claim.variables) {
      if (!seen.has(variable.name)) {
        seen.set(variable.name, variable);
      }
    }
  }
  return [...seen.values()];
}

/**
 * Collect all function-symbol declarations across a set of claims (deduplicated
 * by name).
 *
 * @param claims - The set of logic IR claims whose function declarations should be merged.
 * @returns A deduplicated array of function symbols preserving encounter order.
 *
 * @remarks
 * Deduplication strategy: **first-wins**, mirroring {@link collectVariableDeclarations}.
 * When multiple claims declare functions with the same name, the declaration from
 * the earliest claim (in iteration order) is authoritative; later duplicates are
 * discarded. For `survivingClaims` (post-compile, conflict-free) all same-named
 * functions share one signature, so first-wins is loss-free.
 *
 * Postconditions:
 * - Every unique function name appears exactly once in the result.
 * - The result order follows first-encounter order across claims and their function lists.
 *
 * Failure modes: none — pure computation.
 */
export function collectFunctionDeclarations(claims: readonly LogicIrClaim[]): readonly LogicFunctionSymbol[] {
  const seen = new Map<string, LogicFunctionSymbol>();
  for (const claim of claims) {
    for (const fn of claim.functions) {
      if (!seen.has(fn.name)) {
        seen.set(fn.name, fn);
      }
    }
  }
  return [...seen.values()];
}

/**
 * Build an SMT-LIB preamble declaring all variables and functions from a set of
 * claims.
 *
 * @param variables - The deduplicated variable declarations to emit.
 * @param functions - The deduplicated function-symbol declarations to emit.
 * @returns A newline-separated string of SMT-LIB declarations: one
 *   `(declare-const ...)` per variable followed by one `(declare-fun ...)` per
 *   function.
 *
 * @remarks
 * Output format mirrors the global compile path
 * (`smtlib.ts` `compileSpecSmtlib`): variables become
 * `(declare-const <sanitized-name> <sort>)` and functions become
 * `(declare-fun <sanitized-name> (<arg-sorts>) <returns>)`. Names are sanitized
 * via {@link sanitizeIdentifier} so the preamble declares exactly the symbols the
 * sanitized guard/consequent queries reference.
 *
 * Postconditions:
 * - The result contains exactly `variables.length + functions.length` lines
 *   (empty string when both are empty).
 * - Variable lines precede function lines; lines are joined by `\n` with no
 *   trailing newline.
 *
 * Failure modes: none — pure computation.
 */
export function buildDeclarationPreamble(
  variables: readonly LogicVariableDeclaration[],
  functions: readonly LogicFunctionSymbol[],
): string {
  const lines: string[] = [];
  for (const v of variables) {
    lines.push(`(declare-const ${sanitizeIdentifier(v.name)} ${v.sort})`);
  }
  for (const fn of functions) {
    lines.push(`(declare-fun ${sanitizeIdentifier(fn.name)} (${fn.args.join(" ")}) ${fn.returns})`);
  }
  return lines.join("\n");
}

/**
 * Derive finding severity from the highest-obligation claim in the unsat core.
 * mandatory → error, advisory → warning, informational → info.
 * Falls back to "error" if no core claims are identified.
 *
 * @param coreClaimIds - Claim IDs extracted from the solver's unsat core.
 * @param allClaims - The full set of claims used in the analysis (superset of core).
 * @returns The highest-severity finding level implied by the core claims.
 *
 * @remarks
 * Fallback behavior: If `coreClaimIds` is empty (e.g., the solver did not produce a
 * parseable unsat core), the function conservatively returns `"error"` to avoid
 * under-reporting.
 *
 * Postconditions:
 * - If any core claim has obligation `"mandatory"`, the result is `"error"` (short-circuit).
 * - Otherwise the highest obligation among matched core claims determines severity.
 * - Claims in `allClaims` that are not in the core set are ignored.
 *
 * Failure modes: none — pure computation.
 */
export function deriveSeverityFromClaims(
  coreClaimIds: readonly string[],
  allClaims: readonly LogicIrClaim[],
): FindingSeverity {
  if (coreClaimIds.length === 0) {
    return "error"; // Conservative fallback when core is not parseable.
  }

  const coreSet = new Set(coreClaimIds);
  let highestObligation: LogicObligation = "informational";

  for (const claim of allClaims) {
    if (!coreSet.has(claim.claimId)) continue;
    if (claim.obligation === "mandatory") return "error"; // Short-circuit.
    if (claim.obligation === "advisory") highestObligation = "advisory";
  }

  return obligationToSeverity(highestObligation);
}

/**
 * Map a logic obligation level to the corresponding finding severity.
 *
 * @param obligation - The obligation level from a logic IR claim.
 * @returns The corresponding finding severity.
 *
 * @remarks
 * This is a total mapping — every possible `LogicObligation` value is handled:
 * - `"mandatory"` → `"error"`
 * - `"advisory"` → `"warning"`
 * - `"informational"` → `"info"`
 *
 * Because the switch is exhaustive over the `LogicObligation` union, TypeScript
 * will report a compile error if a new obligation level is added without updating
 * this function. The `default` branch delegates to `assertNever`, which both
 * enforces that compile-time exhaustiveness and throws if an out-of-union value
 * is ever passed at runtime.
 *
 * Failure modes: throws `Error` only if called with a value outside the
 * `LogicObligation` union (unreachable given well-typed callers).
 */
export function obligationToSeverity(obligation: LogicObligation): FindingSeverity {
  switch (obligation) {
    case "mandatory": return "error";
    case "advisory": return "warning";
    case "informational": return "info";
    default: return assertNever(obligation);
  }
}
