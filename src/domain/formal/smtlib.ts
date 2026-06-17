import type { LogicIrClaim } from "../logic-ir.js";
import { toSanitizedClaimId, toSmtlibContent, type SanitizedClaimId, type SmtlibContent } from "../branded.js";

/**
 * Result of compiling a Logic IR claim into SMT-LIB text.
 *
 * @remarks
 * Invariant: `sanitizedClaimId` is a valid SMT-LIB identifier derived from `claimId`.
 * Invariant: `smtlib` contains declarations and assertions but NOT `(check-sat)`.
 * Callers append `(check-sat)` at query execution time.
 */
export interface CompiledSmtlib {
  readonly claimId: string;
  readonly sanitizedClaimId: SanitizedClaimId;
  readonly smtlib: SmtlibContent;
  /** Sanitized assertion expressions (inner expr, without the `(assert ...)` wrapper). */
  readonly assertionExprs: readonly string[];
}

/**
 * Compile logic IR into SMT-LIB with identifier sanitization and mapping comments.
 *
 * @remarks
 * The output `smtlib` contains declarations and assertions but does NOT include
 * `(check-sat)`. Callers are responsible for appending `(check-sat)` when building
 * a complete query for the solver.
 */
export function compileSmtlib(claim: LogicIrClaim): CompiledSmtlib {
  const identifierMap = new Map<string, string>();
  const sanitize = (value: string): string => {
    const existing = identifierMap.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const next = sanitizeIdentifier(value);
    identifierMap.set(value, next);
    return next;
  };

  const sanitizedClaimId = sanitize(claim.claimId);

  const lines: string[] = [];
  lines.push(`; claim ${claim.claimId}`);
  lines.push(`; obligation ${claim.obligation}`);
  for (const [original, sanitized] of identifierMap) {
    lines.push(`; id-map ${original} -> ${sanitized}`);
  }
  for (const sort of claim.sorts) {
    lines.push(`(declare-sort ${sanitize(sort.name)} 0)`);
  }
  for (const fn of claim.functions) {
    lines.push(`(declare-fun ${sanitize(fn.name)} (${fn.args.join(" ")}) ${fn.returns})`);
  }

  const assertionExprs: string[] = [];
  for (const assertion of claim.assertions) {
    const sanitizedExpr = sanitizeAssertion(assertion.expr, sanitize);
    assertionExprs.push(sanitizedExpr);
    lines.push(`; assertion ${sanitize(assertion.id)}`);
    lines.push(`(assert ${sanitizedExpr})`);
  }

  return {
    claimId: claim.claimId,
    sanitizedClaimId: toSanitizedClaimId(sanitizedClaimId),
    smtlib: toSmtlibContent(`${lines.join("\n")}\n`),
    assertionExprs,
  };
}

/**
 * Check whether a code point is valid in SMT-LIB identifiers without escaping.
 * Valid characters: A-Z (65-90), a-z (97-122), 0-9 (48-57), _ (95).
 */
function isSmtlibSafeCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 65 && codePoint <= 90) ||
    (codePoint >= 97 && codePoint <= 122) ||
    (codePoint >= 48 && codePoint <= 57) ||
    codePoint === 95
  );
}

/**
 * Check whether a code point is valid as the first character of an SMT-LIB identifier.
 * Valid leading characters: A-Z (65-90), a-z (97-122), _ (95).
 */
function isSmtlibLeadingCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 65 && codePoint <= 90) ||
    (codePoint >= 97 && codePoint <= 122) ||
    codePoint === 95
  );
}

/**
 * Sanitize an arbitrary string into a valid SMT-LIB simple symbol.
 *
 * @param value - raw identifier string to sanitize
 * @returns branded `SanitizedClaimId` containing only valid SMT-LIB characters
 *
 * @remarks
 * Precondition: `value` may be any string including empty.
 * Postcondition: returned identifier is non-empty, starts with a letter or underscore,
 * and contains only [A-Za-z0-9_]. Illegal characters are hex-escaped as `_XX`.
 * Invariant: the empty string maps to `"_"`.
 */
export function sanitizeIdentifier(value: string): SanitizedClaimId {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isSmtlibSafeCodePoint(codePoint)) {
      output += character;
      continue;
    }

    const suffix = (codePoint ?? 0).toString(16).toUpperCase().padStart(2, "0");
    output += `_${suffix}`;
  }

  if (output.length === 0) {
    return toSanitizedClaimId("_");
  }

  const firstCodePoint = output.codePointAt(0) ?? 0;
  return toSanitizedClaimId(isSmtlibLeadingCodePoint(firstCodePoint) ? output : `_${output}`);
}

/**
 * Sanitize all identifier-like tokens within an SMT-LIB assertion expression.
 *
 * @param expr - raw assertion expression string containing identifiers
 * @param sanitize - sanitization function applied to each matched identifier token
 * @returns expression with all identifier tokens replaced by their sanitized forms
 *
 * @remarks
 * Postcondition: identifiers matching `[A-Za-z_][A-Za-z0-9_\-.:]∗` are sanitized;
 * non-identifier content (parentheses, whitespace, operators) is preserved verbatim.
 */
function sanitizeAssertion(expr: string, sanitize: (value: string) => string): string {
  return expr.replace(/[A-Za-z_][A-Za-z0-9_\-.:]*/gu, (token) => sanitize(token));
}

/**
 * Parse SMT-LIB content back into declarations and assertion expressions.
 *
 * @param content - SMT-LIB text as written by `compileSmtlib` (or legacy format with `(check-sat)`)
 * @returns separated declarations and assertion expressions extracted from `(assert ...)` lines
 *
 * @remarks
 * Precondition: `content` follows the format produced by `compileSmtlib` (one command per line).
 * Postcondition: `declarations` contains `(declare-sort ...)` and `(declare-fun ...)` lines.
 * Postcondition: `assertionExprs` contains the inner expressions from `(assert expr)` lines.
 * Lines that are comments, `(check-sat)`, or empty are ignored.
 */
export function parseSmtlibContent(content: string): {
  readonly declarations: readonly string[];
  readonly assertionExprs: readonly string[];
} {
  const declarations: string[] = [];
  const assertionExprs: string[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("(declare-sort") || line.startsWith("(declare-fun")) {
      declarations.push(line);
    } else if (line.startsWith("(assert ")) {
      // Extract inner expression from (assert expr)
      const inner = line.slice("(assert ".length, -1);
      assertionExprs.push(inner);
    }
  }

  return { declarations, assertionExprs };
}
