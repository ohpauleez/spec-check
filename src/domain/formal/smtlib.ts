import type { LogicIrClaim, LogicFunctionSymbol } from "../logic-ir.js";
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

// ---------------------------------------------------------------------------
// Per-Spec Combined SMT-LIB Compilation
// ---------------------------------------------------------------------------

/**
 * Conflict detected when merging function declarations from multiple claims.
 *
 * @remarks
 * Invariant: `functionName` is the unsanitized original identifier.
 * Invariant: `claimIds` identifies the two claims with incompatible signatures.
 */
export interface SpecMergeConflict {
  readonly kind: "function_signature_mismatch";
  readonly functionName: string;
  readonly claimIds: readonly [string, string];
}

/**
 * Result of compiling all claims from a single spec file into one SMT-LIB text.
 *
 * @remarks
 * Invariant: `smtlib` contains `(set-option :produce-unsat-cores true)`, all deduplicated
 * declarations, and named assertions — but NOT `(check-sat)` or `(get-unsat-core)`.
 * Invariant: `assertionNameMap` maps each named-assertion label back to its source claimId.
 * Invariant: `conflicts` lists function signature mismatches found during merging.
 * Invariant: claims involved in merge conflicts are excluded from the combined output.
 */
export interface CompiledSpecSmtlib {
  readonly specFile: string;
  readonly sanitizedSpecId: SanitizedClaimId;
  readonly smtlib: SmtlibContent;
  readonly claimIds: readonly string[];
  readonly assertionNameMap: ReadonlyMap<string, string>;
  readonly conflicts: readonly SpecMergeConflict[];
}

/**
 * Compile all claims from a single spec file into one combined SMT-LIB text.
 *
 * @param specFile - the source spec file path (used for comments and ID generation)
 * @param claims - all LogicIrClaims belonging to this spec file
 * @returns combined SMT-LIB with deduplicated declarations, named assertions, and any merge conflicts
 *
 * @remarks
 * Strategy:
 * - Sort declarations are deduplicated by name (first-wins).
 * - Function declarations are deduplicated by name; if a duplicate name has a different
 *   signature, a SpecMergeConflict is recorded and the conflicting claim is excluded.
 * - Each assertion uses `(assert (! expr :named <label>))` where label encodes
 *   both the claim ID and assertion index for unsat-core traceability.
 * - The output includes `(set-option :produce-unsat-cores true)` as the first command.
 * - Callers append `(check-sat)\n(get-unsat-core)\n` at query time.
 */
export function compileSpecSmtlib(specFile: string, claims: readonly LogicIrClaim[]): CompiledSpecSmtlib {
  const globalIdentifierMap = new Map<string, string>();
  const sanitize = (value: string): string => {
    const existing = globalIdentifierMap.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const next = sanitizeIdentifier(value);
    globalIdentifierMap.set(value, next);
    return next;
  };

  const sanitizedSpecId = sanitize(specFile);

  // Track declared functions for conflict detection.
  const declaredFunctions = new Map<string, { fn: LogicFunctionSymbol; claimId: string }>();

  const conflicts: SpecMergeConflict[] = [];
  const excludedClaimIds = new Set<string>();
  const includedClaimIds: string[] = [];
  const assertionNameMap = new Map<string, string>(); // label → claimId

  const sortLines: string[] = [];
  const functionLines: string[] = [];
  const assertionLines: string[] = [];

  // First pass: collect declarations and detect conflicts.
  for (const claim of claims) {
    let hasConflict = false;

    for (const fn of claim.functions) {
      const sanName = sanitize(fn.name);
      const existing = declaredFunctions.get(sanName);
      if (existing !== undefined) {
        // Check signature compatibility.
        if (!signaturesMatch(existing.fn, fn)) {
          conflicts.push({
            kind: "function_signature_mismatch",
            functionName: fn.name,
            claimIds: [existing.claimId, claim.claimId],
          });
          hasConflict = true;
          break;
        }
      }
    }

    if (hasConflict) {
      excludedClaimIds.add(claim.claimId);
    } else {
      // Register this claim's functions for future conflict detection.
      for (const fn of claim.functions) {
        const sanName = sanitize(fn.name);
        if (!declaredFunctions.has(sanName)) {
          declaredFunctions.set(sanName, { fn, claimId: claim.claimId });
        }
      }
    }
  }

  // Second pass: emit declarations and assertions for non-excluded claims.
  const emittedSorts = new Set<string>();
  const emittedFunctions = new Set<string>();
  for (const claim of claims) {
    if (excludedClaimIds.has(claim.claimId)) {
      continue;
    }
    includedClaimIds.push(claim.claimId);

    // Sorts.
    for (const sort of claim.sorts) {
      const sanName = sanitize(sort.name);
      if (!emittedSorts.has(sanName)) {
        emittedSorts.add(sanName);
        sortLines.push(`(declare-sort ${sanName} 0)`);
      }
    }

    // Functions.
    for (const fn of claim.functions) {
      const sanName = sanitize(fn.name);
      if (!emittedFunctions.has(sanName)) {
        emittedFunctions.add(sanName);
        functionLines.push(`(declare-fun ${sanName} (${fn.args.join(" ")}) ${fn.returns})`);
      }
    }

    // Named assertions.
    const sanClaimId = sanitize(claim.claimId);
    for (let i = 0; i < claim.assertions.length; i++) {
      const assertion = claim.assertions[i]!;
      const label = `${sanClaimId}__a${i}`;
      const sanitizedExpr = sanitizeAssertion(assertion.expr, sanitize);
      assertionNameMap.set(label, claim.claimId);
      assertionLines.push(`; claim ${claim.claimId} assertion ${assertion.id}`);
      assertionLines.push(`(assert (! ${sanitizedExpr} :named ${label}))`);
    }
  }

  // Assemble final SMT-LIB text.
  const lines: string[] = [];
  lines.push(`; spec ${specFile}`);
  lines.push(`; claims ${includedClaimIds.length} (${excludedClaimIds.size} excluded due to conflicts)`);
  lines.push(`(set-option :produce-unsat-cores true)`);
  lines.push("");
  lines.push("; --- sort declarations ---");
  lines.push(...sortLines);
  lines.push("");
  lines.push("; --- function declarations ---");
  lines.push(...functionLines);
  lines.push("");
  lines.push("; --- assertions ---");
  lines.push(...assertionLines);

  return {
    specFile,
    sanitizedSpecId: toSanitizedClaimId(sanitizedSpecId),
    smtlib: toSmtlibContent(`${lines.join("\n")}\n`),
    claimIds: includedClaimIds,
    assertionNameMap,
    conflicts,
  };
}

/**
 * Parse Z3 unsat-core output into a list of named assertion labels.
 *
 * @param stdout - Z3 stdout content (expected: line 1 = "unsat", line 2 = "(label1 label2 ...)")
 * @returns array of named assertion labels from the unsat core, or empty if parsing fails
 *
 * @remarks
 * Postcondition: returned labels are the raw strings from Z3 output.
 * Callers map these back to claim IDs via `CompiledSpecSmtlib.assertionNameMap`.
 */
export function parseUnsatCore(stdout: string): readonly string[] {
  const lines = stdout.trim().split("\n");
  // Find the line containing the unsat core (parenthesized list after "unsat").
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("(") && line.endsWith(")")) {
      const inner = line.slice(1, -1).trim();
      if (inner.length === 0) {
        return [];
      }
      return inner.split(/\s+/);
    }
  }
  return [];
}

/** Check whether two function symbols have identical signatures. */
function signaturesMatch(a: LogicFunctionSymbol, b: LogicFunctionSymbol): boolean {
  if (a.returns !== b.returns) return false;
  if (a.args.length !== b.args.length) return false;
  for (let i = 0; i < a.args.length; i++) {
    if (a.args[i] !== b.args[i]) return false;
  }
  return true;
}


