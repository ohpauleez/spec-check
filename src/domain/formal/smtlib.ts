/**
 * Compiles Logic IR claims into SMT-LIB text suitable for Z3 execution.
 *
 * Central compilation layer between the Logic IR and the Z3 solver adapter.
 * Exports: compileSmtlib, compileSpecSmtlib, sanitizeIdentifier,
 * sanitizeAssertionExpr, parseSmtlibContent, parseUnsatCore, the size bounds
 * CLAIMS_PER_GROUP_MAX / DECLARATIONS_PER_CLAIM_MAX, and the result/conflict
 * types CompiledSmtlib, CompiledSpecSmtlib, and SpecMergeConflict.
 */
import { invariant, postcondition, precondition } from "../assert.js";
import {
  toSanitizedClaimId,
  toSmtlibContent,
  type SanitizedClaimId,
  type SmtlibContent,
} from "../branded.js";
import type { LogicFunctionSymbol, LogicIrClaim, LogicSort } from "../logic-ir.js";
import { sanitizeIdentifier as sanitizeIdentifierImpl } from "./identifiers.js";

/** Maximum claims accepted per compile group. */
export const CLAIMS_PER_GROUP_MAX = 1024;

/** Maximum declarations accepted per claim (variables + functions). */
export const DECLARATIONS_PER_CLAIM_MAX = 2048;

/**
 * Identifier-like token pattern shared by every assertion-sanitization path.
 *
 * @remarks
 * A token is a leading `[A-Za-z_]` followed by any run of
 * `[A-Za-z0-9_\-.:]`. This matches SMT-LIB word keywords (`and`, `or`, `not`,
 * `ite`) and escaping-requiring identifiers (`user_id`, `a.b`, `is-valid`,
 * `ns:x`), while non-letter operators (`=>`, `=`, `<`, `+`), whitespace, and
 * parentheses do not match. The `g` flag drives `String.prototype.replace`,
 * which resets `lastIndex` to 0 on completion; because every consumer runs the
 * replacement synchronously, sharing this single constant is safe.
 */
const ASSERTION_TOKEN_REGEX = /[A-Za-z_][A-Za-z0-9_\-.:]*/gu;

/**
 * Result of compiling a single Logic IR claim into SMT-LIB text.
 *
 * @remarks
 * Invariants (established by {@link compileSmtlib}):
 * - `sanitizedClaimId` is the {@link sanitizeIdentifier} image of `claimId` and
 *   is therefore a valid, escaping-free SMT-LIB identifier.
 * - `smtlib` contains only declarations, id-map comments, and `(assert ...)`
 *   forms — never a `(check-sat)` or other solver command. Callers append those
 *   when assembling a query.
 * - `assertionExprs[i]` is the sanitized inner expression of the i-th assertion
 *   (no `(assert ...)` wrapper), sharing the same identifier map as `smtlib`.
 */
export interface CompiledSmtlib {
  readonly claimId: string;
  readonly sanitizedClaimId: SanitizedClaimId;
  readonly smtlib: SmtlibContent;
  readonly assertionExprs: readonly string[];
}

/**
 * A merge conflict detected while combining several claims into one SMT-LIB
 * program by {@link compileSpecSmtlib}.
 *
 * @remarks
 * Each variant names the same sanitized symbol reached from two directions and
 * records both the surviving (`existingClaimId`) and the rejected
 * (`excludedClaimId`) claim. Invariant: `claimIds` lists exactly
 * `[existingClaimId, excludedClaimId]`, and the excluded claim is omitted from
 * the compiled output. The `kind` discriminant selects the conflict class:
 * - `"function_signature_mismatch"` — same sanitized name, incompatible
 *   argument/return signatures.
 * - `"variable_sort_mismatch"` — same sanitized name, different sorts
 *   (`expectedSort` vs `conflictingSort`).
 * - `"symbol_kind_collision"` — same sanitized name declared once as a variable
 *   and once as a function (`existingSymbolKind` vs `conflictingSymbolKind`).
 */
export type SpecMergeConflict =
  | {
    readonly kind: "function_signature_mismatch";
    readonly sanitizedName: SanitizedClaimId;
    readonly existingFunctionName: string;
    readonly conflictingFunctionName: string;
    readonly existingClaimId: string;
    readonly excludedClaimId: string;
    readonly claimIds: readonly [string, string];
  }
  | {
    readonly kind: "variable_sort_mismatch";
    readonly sanitizedName: SanitizedClaimId;
    readonly existingVariableName: string;
    readonly conflictingVariableName: string;
    readonly expectedSort: LogicSort;
    readonly conflictingSort: LogicSort;
    readonly existingClaimId: string;
    readonly excludedClaimId: string;
    readonly claimIds: readonly [string, string];
  }
  | {
    readonly kind: "symbol_kind_collision";
    readonly sanitizedName: SanitizedClaimId;
    readonly existingSymbolName: string;
    readonly existingSymbolKind: "variable" | "function";
    readonly conflictingSymbolName: string;
    readonly conflictingSymbolKind: "variable" | "function";
    readonly existingClaimId: string;
    readonly excludedClaimId: string;
    readonly claimIds: readonly [string, string];
  };

/**
 * Result of compiling every claim from one spec file into a single SMT-LIB text.
 *
 * @remarks
 * Invariants (established by {@link compileSpecSmtlib}):
 * - `claimIds` are the claims that survived merge checks, in input order, and
 *   contain no `excludedClaimId` from any entry in `conflicts`.
 * - `assertionNameMap` maps each `:named` assertion label to the originating
 *   claim id, and every value is a member of `claimIds`.
 * - `smtlib` declares each sanitized symbol at most once and carries no
 *   `(check-sat)` — callers append solver commands.
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
 * Map an arbitrary identifier to a stable, escaping-free SMT-LIB symbol.
 *
 * @remarks
 * Backward-compatible re-export of the canonical implementation in
 * `identifiers.ts`; see {@link sanitizeIdentifierImpl} for the full contract.
 * Key property relied on across the compile path: the mapping is injective —
 * distinct inputs never collide onto the same sanitized symbol — which is what
 * lets separately-sanitized expressions and declarations reference the same
 * symbols without accidental aliasing.
 */
export const sanitizeIdentifier = sanitizeIdentifierImpl;

/**
 * Sanitize every identifier-like token in a standalone SMT-LIB expression.
 *
 * @param expr - Any SMT-LIB expression string (guard, consequent, etc.).
 * @returns The expression with each identifier token replaced by its
 *   {@link sanitizeIdentifier} form; operators, whitespace, and parentheses are
 *   preserved verbatim.
 *
 * @remarks
 * This is the token-parity counterpart of the global compile path: it applies
 * the exact same {@link ASSERTION_TOKEN_REGEX} plus {@link sanitizeIdentifier}
 * mapping used by {@link compileSpecSmtlib}, so an expression sanitized here
 * references the same symbols that the compiled preamble declares.
 *
 * Preconditions: `expr` is any JS string.
 *
 * Postconditions:
 * - Deterministic and pure — equal input yields equal output.
 * - Pure-ASCII-alphanumeric tokens (including SMT-LIB keywords such as `and`,
 *   `or`, `not`, `ite`, `true`, `false`) map to themselves.
 * - Escaping-requiring identifiers (`user_id`, `a.b`, `is-valid`, `ns:x`) map to
 *   the same fixed-width `_HEX6` encoding the global compile emits.
 *
 * Documented limitation: identifier-like tokens inside string literals are also
 * matched, mirroring the pre-existing global-compile behavior, so parity is
 * preserved between the two paths.
 *
 * Failure modes: none — pure computation.
 */
export function sanitizeAssertionExpr(expr: string): string {
  return expr.replace(ASSERTION_TOKEN_REGEX, (token) => sanitizeIdentifierImpl(token));
}

/**
 * Compile one Logic IR claim into standalone SMT-LIB declarations and assertions.
 *
 * @param claim - A structurally valid {@link LogicIrClaim} (already validated
 *   upstream) whose variables, functions, and assertions are emitted in order.
 * @returns A {@link CompiledSmtlib} carrying the original `claimId`, its
 *   sanitized form, the SMT-LIB text, and the sanitized inner assertion
 *   expressions.
 *
 * @remarks
 * Preconditions: `claim` is a validated `LogicIrClaim`.
 *
 * Postconditions (see {@link CompiledSmtlib} invariants):
 * - `smtlib` holds declarations and `(assert ...)` forms but never a
 *   `(check-sat)` — callers append solver commands when building a query.
 * - `assertionExprs[i]` is the sanitized inner form of `claim.assertions[i].expr`
 *   and shares the per-claim identifier map used to emit the declarations, so
 *   every referenced symbol is also declared.
 *
 * Identifier sanitization is memoized per claim, so each raw name maps to one
 * stable sanitized symbol across declarations, assertions, and id-map comments.
 * Every value interpolated into a `;`-comment (claim id, obligation, assertion
 * id, and the id-map pairs) is routed through {@link escapeCommentLine} so an
 * embedded newline cannot smuggle executable SMT-LIB onto a following line.
 *
 * Failure modes: none — pure, deterministic computation over in-memory data.
 */
export function compileSmtlib(claim: LogicIrClaim): CompiledSmtlib {
  const identifierMap = new Map<string, SanitizedClaimId>();

  const sanitize = (value: string): SanitizedClaimId => {
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

  lines.push(`; claim ${escapeCommentLine(claim.claimId)}`);
  lines.push(`; obligation ${escapeCommentLine(claim.obligation)}`);

  for (const [original, sanitized] of identifierMap) {
    lines.push(`; id-map ${escapeCommentLine(original)} -> ${escapeCommentLine(sanitized)}`);
  }

  for (const variable of claim.variables) {
    lines.push(`(declare-const ${sanitize(variable.name)} ${variable.sort})`);
  }

  for (const fn of claim.functions) {
    lines.push(`(declare-fun ${sanitize(fn.name)} (${fn.args.join(" ")}) ${fn.returns})`);
  }

  const assertionExprs: string[] = [];
  for (const assertion of claim.assertions) {
    const sanitizedExpr = sanitizeAssertion(assertion.expr, sanitize);
    assertionExprs.push(sanitizedExpr);
    lines.push(`; assertion ${escapeCommentLine(sanitize(assertion.id))}`);
    lines.push(`(assert ${sanitizedExpr})`);
  }

  return {
    claimId: claim.claimId,
    sanitizedClaimId,
    smtlib: toSmtlibContent(`${lines.join("\n")}\n`),
    assertionExprs,
  };
}

/**
 * Compile all claims from one spec group into one SMT-LIB program.
 *
 * @param specFile - provenance file for the compile group
 * @param claims - claims in one compile group, already grouped by compile key
 * @returns combined SMT-LIB text, surviving claim IDs, label map, and merge conflicts
 *
 * @throws {Error} When a size precondition is violated (see below).
 *
 * @remarks
 * Preconditions (caller contract):
 * - `claims.length` is a safe integer within {@link CLAIMS_PER_GROUP_MAX};
 * - every claim's `variables.length + functions.length` is within
 *   {@link DECLARATIONS_PER_CLAIM_MAX}.
 *
 * These bounds are enforced upstream by `preflightGroupBounds` in
 * `logic-analysis.ts`, which converts oversized groups into graceful
 * `logic.invalid_group` findings before this function is reached. The
 * `precondition(...)` checks here are therefore unreachable backstops that
 * defend the caller contract for any future direct caller; they are not the
 * primary size-rejection path.
 *
 * Postconditions:
 * - output is a single SMT-LIB program without solver commands (callers append them);
 * - conflicting claims are excluded and reported in `conflicts`.
 */
export function compileSpecSmtlib(specFile: string, claims: readonly LogicIrClaim[]): CompiledSpecSmtlib {
  precondition(Number.isSafeInteger(claims.length), "claims length must be a safe integer");
  precondition(claims.length <= CLAIMS_PER_GROUP_MAX, `claim count ${String(claims.length)} exceeds CLAIMS_PER_GROUP_MAX ${String(CLAIMS_PER_GROUP_MAX)}`);

  for (const claim of claims) {
    const declarationCount = claim.variables.length + claim.functions.length;
    precondition(
      Number.isSafeInteger(declarationCount),
      `declaration count must be a safe integer for claim ${claim.claimId}`,
    );
    precondition(
      declarationCount <= DECLARATIONS_PER_CLAIM_MAX,
      `claim ${claim.claimId} has ${String(declarationCount)} declarations; exceeds DECLARATIONS_PER_CLAIM_MAX ${String(DECLARATIONS_PER_CLAIM_MAX)}`,
    );
  }

  const globalIdentifierMap = new Map<string, SanitizedClaimId>();
  const sanitize = (value: string): SanitizedClaimId => {
    const existing = globalIdentifierMap.get(value);
    if (existing !== undefined) {
      return existing;
    }

    const next = sanitizeIdentifier(value);
    globalIdentifierMap.set(value, next);
    return next;
  };

  const sanitizedSpecId = sanitize(specFile);

  const declaredVariables = new Map<SanitizedClaimId, { variableName: string; sort: LogicSort; claimId: string }>();
  const declaredFunctions = new Map<SanitizedClaimId, { functionName: string; fn: LogicFunctionSymbol; claimId: string }>();

  const conflicts: SpecMergeConflict[] = [];
  const excludedClaimIds = new Set<string>();
  const includedClaimIds: string[] = [];
  const assertionNameMap = new Map<string, string>();

  const variableLines: string[] = [];
  const functionLines: string[] = [];
  const assertionLines: string[] = [];
  const emittedVariableSymbols = new Set<SanitizedClaimId>();
  const emittedFunctionSymbols = new Set<SanitizedClaimId>();

  for (const claim of claims) {
    let conflictForClaim: SpecMergeConflict | null = null;

    for (const variable of claim.variables) {
      const sanitizedName = sanitize(variable.name);
      const existingVariable = declaredVariables.get(sanitizedName);
      if (existingVariable !== undefined && existingVariable.sort !== variable.sort) {
        conflictForClaim = {
          kind: "variable_sort_mismatch",
          sanitizedName,
          existingVariableName: existingVariable.variableName,
          conflictingVariableName: variable.name,
          expectedSort: existingVariable.sort,
          conflictingSort: variable.sort,
          existingClaimId: existingVariable.claimId,
          excludedClaimId: claim.claimId,
          claimIds: [existingVariable.claimId, claim.claimId],
        };
        break;
      }
    }

    if (conflictForClaim === null) {
      for (const fn of claim.functions) {
        const sanitizedName = sanitize(fn.name);
        const existingFunction = declaredFunctions.get(sanitizedName);
        if (existingFunction !== undefined && !signaturesMatch(existingFunction.fn, fn)) {
          conflictForClaim = {
            kind: "function_signature_mismatch",
            sanitizedName,
            existingFunctionName: existingFunction.functionName,
            conflictingFunctionName: fn.name,
            existingClaimId: existingFunction.claimId,
            excludedClaimId: claim.claimId,
            claimIds: [existingFunction.claimId, claim.claimId],
          };
          break;
        }
      }
    }

    if (conflictForClaim === null) {
      const claimVariableSymbols = new Map<SanitizedClaimId, string>();
      const claimFunctionSymbols = new Map<SanitizedClaimId, string>();

      for (const variable of claim.variables) {
        claimVariableSymbols.set(sanitize(variable.name), variable.name);
      }
      for (const fn of claim.functions) {
        claimFunctionSymbols.set(sanitize(fn.name), fn.name);
      }

      for (const [sanitizedName, variableName] of claimVariableSymbols) {
        const existingFunction = declaredFunctions.get(sanitizedName);
        if (existingFunction !== undefined) {
          conflictForClaim = {
            kind: "symbol_kind_collision",
            sanitizedName,
            existingSymbolName: existingFunction.functionName,
            existingSymbolKind: "function",
            conflictingSymbolName: variableName,
            conflictingSymbolKind: "variable",
            existingClaimId: existingFunction.claimId,
            excludedClaimId: claim.claimId,
            claimIds: [existingFunction.claimId, claim.claimId],
          };
          break;
        }

        const sameClaimFunctionName = claimFunctionSymbols.get(sanitizedName);
        if (sameClaimFunctionName !== undefined) {
          conflictForClaim = {
            kind: "symbol_kind_collision",
            sanitizedName,
            existingSymbolName: sameClaimFunctionName,
            existingSymbolKind: "function",
            conflictingSymbolName: variableName,
            conflictingSymbolKind: "variable",
            existingClaimId: claim.claimId,
            excludedClaimId: claim.claimId,
            claimIds: [claim.claimId, claim.claimId],
          };
          break;
        }
      }

      if (conflictForClaim === null) {
        for (const [sanitizedName, functionName] of claimFunctionSymbols) {
          const existingVariable = declaredVariables.get(sanitizedName);
          if (existingVariable !== undefined) {
            conflictForClaim = {
              kind: "symbol_kind_collision",
              sanitizedName,
              existingSymbolName: existingVariable.variableName,
              existingSymbolKind: "variable",
              conflictingSymbolName: functionName,
              conflictingSymbolKind: "function",
              existingClaimId: existingVariable.claimId,
              excludedClaimId: claim.claimId,
              claimIds: [existingVariable.claimId, claim.claimId],
            };
            break;
          }
        }
      }
    }

    if (conflictForClaim !== null) {
      conflicts.push(conflictForClaim);
      excludedClaimIds.add(claim.claimId);
      continue;
    }

    for (const variable of claim.variables) {
      const sanitizedName = sanitize(variable.name);
      if (!declaredVariables.has(sanitizedName)) {
        declaredVariables.set(sanitizedName, {
          variableName: variable.name,
          sort: variable.sort,
          claimId: claim.claimId,
        });
      }
    }

    for (const fn of claim.functions) {
      const sanitizedName = sanitize(fn.name);
      if (!declaredFunctions.has(sanitizedName)) {
        declaredFunctions.set(sanitizedName, {
          functionName: fn.name,
          fn,
          claimId: claim.claimId,
        });
      }
    }
  }

  invariant(
    everyIn(declaredVariables.values(), (entry) => entry.sort === "Bool" || entry.sort === "Int" || entry.sort === "Real" || entry.sort === "String"),
    "every declared variable sort must remain inside LogicSort",
  );
  invariant(
    everyIn(declaredVariables.keys(), (symbol) => !declaredFunctions.has(symbol)),
    "one sanitized symbol must not map to both variable and function declarations",
  );

  for (const claim of claims) {
    if (excludedClaimIds.has(claim.claimId)) {
      continue;
    }

    includedClaimIds.push(claim.claimId);

    for (const variable of claim.variables) {
      const sanitizedName = sanitize(variable.name);
      if (!emittedVariableSymbols.has(sanitizedName)) {
        emittedVariableSymbols.add(sanitizedName);
        variableLines.push(`(declare-const ${sanitizedName} ${variable.sort})`);
      }
    }

    for (const fn of claim.functions) {
      const sanitizedName = sanitize(fn.name);
      if (!emittedFunctionSymbols.has(sanitizedName)) {
        emittedFunctionSymbols.add(sanitizedName);
        functionLines.push(`(declare-fun ${sanitizedName} (${fn.args.join(" ")}) ${fn.returns})`);
      }
    }

    const sanitizedClaimId = sanitize(claim.claimId);
    for (let assertionIndex = 0; assertionIndex < claim.assertions.length; assertionIndex += 1) {
      const assertion = claim.assertions[assertionIndex]!;
      const label = `${sanitizedClaimId}__a${String(assertionIndex)}`;
      assertionNameMap.set(label, claim.claimId);
      assertionLines.push(`; claim ${escapeCommentLine(claim.claimId)} assertion ${escapeCommentLine(assertion.id)}`);
      assertionLines.push(`(assert (! ${sanitizeAssertion(assertion.expr, sanitize)} :named ${label}))`);
    }
  }

  const includedSet = new Set(includedClaimIds);
  let nextInputIndex = 0;
  for (const includedClaimId of includedClaimIds) {
    while (nextInputIndex < claims.length && claims[nextInputIndex]!.claimId !== includedClaimId) {
      nextInputIndex += 1;
    }

    postcondition(nextInputIndex < claims.length, `included claim ${includedClaimId} must appear in input order`);
    nextInputIndex += 1;
  }

  postcondition(
    conflicts.every((conflict) => !includedSet.has(conflict.excludedClaimId)),
    "excludedClaimId must not appear in compiled.claimIds",
  );

  postcondition(
    everyIn(assertionNameMap.values(), (claimId) => includedSet.has(claimId)),
    "assertionNameMap values must reference included claims only",
  );

  const lines: string[] = [];
  lines.push(`; spec ${escapeCommentLine(specFile)}`);
  lines.push(`; claims ${String(includedClaimIds.length)} (${String(excludedClaimIds.size)} excluded due to conflicts)`);
  lines.push("");
  lines.push("; --- variable declarations ---");
  lines.push(...variableLines);
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
 * Parse emitted SMT-LIB text back into its declaration and assertion lines.
 *
 * @param content - SMT-LIB text, typically the `smtlib` field produced by
 *   {@link compileSmtlib} (single-line assertions).
 * @returns `{ declarations, assertionExprs }` where `declarations` are the raw
 *   `(declare-const|declare-sort|declare-fun ...)` lines (trimmed, verbatim) and
 *   `assertionExprs` are the inner bodies of `(assert ...)` lines with the
 *   leading `(assert ` and trailing `)` removed.
 *
 * @remarks
 * Line-oriented inverse of the compile emitter, used by the code-backwards
 * cross-implication builder to recover declared symbols and assertion bodies.
 *
 * Preconditions: `content` is any string.
 *
 * Postconditions:
 * - Only top-level, single-line forms are recognized; the parser does not
 *   balance parentheses across newlines, matching the one-line-per-assertion
 *   shape {@link compileSmtlib} emits. Multi-line or `:named`-wrapped assertions
 *   are not un-wrapped beyond the outer `(assert ... )` slice.
 * - Lines that match no recognized prefix (comments, blanks, solver commands)
 *   are skipped.
 *
 * Failure modes: none — pure computation; unexpected lines are ignored rather
 * than throwing.
 */
export function parseSmtlibContent(content: string): {
  readonly declarations: readonly string[];
  readonly assertionExprs: readonly string[];
} {
  const declarations: string[] = [];
  const assertionExprs: string[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("(declare-const") || line.startsWith("(declare-sort") || line.startsWith("(declare-fun")) {
      declarations.push(line);
    } else if (line.startsWith("(assert ")) {
      assertionExprs.push(line.slice("(assert ".length, -1));
    }
  }

  return { declarations, assertionExprs };
}

/**
 * Parse Z3 `(get-unsat-core)` output into the list of assertion labels.
 *
 * @param stdout - Raw solver stdout following an `unsat` verdict; the core is
 *   emitted as a single parenthesized, whitespace-separated list of labels.
 * @returns The assertion labels naming the unsat core, in solver-reported order;
 *   an empty array when the core is `()` or no parenthesized line is present.
 *
 * @remarks
 * Consumed by `logic-analysis.ts`, which resolves the returned labels back to
 * claim ids via `CompiledSpecSmtlib.assertionNameMap`.
 *
 * Preconditions: `stdout` is any string.
 *
 * Postconditions:
 * - Scans lines in order and returns the first that both starts with `(` and
 *   ends with `)`; inner tokens are split on runs of whitespace.
 * - Returns `[]` (not an error) when the solver produced no core line, so an
 *   absent or unavailable core degrades gracefully.
 *
 * Failure modes: none — pure computation; never throws.
 */
export function parseUnsatCore(stdout: string): readonly string[] {
  const lines = stdout.trim().split("\n");
  for (const candidate of lines) {
    const line = candidate.trim();
    if (line.startsWith("(") && line.endsWith(")")) {
      const inner = line.slice(1, -1).trim();
      return inner.length === 0 ? [] : inner.split(/\s+/u);
    }
  }

  return [];
}

/**
 * Sanitize identifier-like tokens inside an assertion expression, reusing a
 * caller-provided memoized sanitizer so symbols match the surrounding
 * declarations.
 *
 * @param expr - An assertion expression body (no `(assert ...)` wrapper).
 * @param sanitize - The compile scope's memoized identifier mapper; sharing it
 *   guarantees a token maps to the same sanitized symbol here as where the
 *   declaration was emitted.
 * @returns `expr` with every {@link ASSERTION_TOKEN_REGEX} token replaced by its
 *   sanitized form; operators, parentheses, and whitespace are preserved.
 *
 * @remarks
 * Preconditions: `sanitize` is the same mapper used for the enclosing claim's
 * declarations. Postconditions: deterministic and pure for a fixed `sanitize`.
 * Failure modes: none beyond any thrown by `sanitize` (the default mappers do
 * not throw).
 */
function sanitizeAssertion(expr: string, sanitize: (value: string) => SanitizedClaimId): string {
  return expr.replace(ASSERTION_TOKEN_REGEX, (token) => sanitize(token));
}

/**
 * Collapse CR/LF runs in untrusted text to single spaces so it stays on one
 * SMT-LIB comment line.
 *
 * @param value - Arbitrary text destined for a `;`-prefixed comment (claim id,
 *   obligation, assertion id, etc.).
 * @returns `value` with every run of `\r`/`\n` replaced by a single space.
 *
 * @remarks
 * Security-relevant: comments are emitted as `; <value>`, so an embedded newline
 * would end the comment and let following text be parsed as executable SMT-LIB.
 * Flattening line breaks removes that injection vector.
 *
 * Preconditions: `value` is any string. Postconditions: the result contains no
 * `\r` or `\n`. Failure modes: none — pure computation.
 */
function escapeCommentLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}

/**
 * Test a predicate against every element of an iterable without materializing
 * an intermediate array.
 *
 * @param iterable - The source iterable (e.g. `Map.values()`, `Map.keys()`).
 * @param predicate - Returns `true` when an element satisfies the check.
 * @returns `true` when every element satisfies `predicate`; `false` on the first
 *   failure (short-circuiting).
 *
 * @remarks
 * Allocation-free replacement for `[...iterable].every(...)`. Iteration is
 * bounded by the caller's collection, which is itself bounded by
 * {@link CLAIMS_PER_GROUP_MAX} and {@link DECLARATIONS_PER_CLAIM_MAX}.
 *
 * Failure modes: none — pure computation.
 */
function everyIn<T>(iterable: Iterable<T>, predicate: (item: T) => boolean): boolean {
  for (const item of iterable) {
    if (!predicate(item)) {
      return false;
    }
  }
  return true;
}

/**
 * Decide whether two function symbols share an identical SMT-LIB signature.
 *
 * @param a - First function symbol.
 * @param b - Second function symbol.
 * @returns `true` iff the return sorts are equal and the argument sort lists are
 *   equal element-for-element (same arity, same order).
 *
 * @remarks
 * Used by {@link compileSpecSmtlib} to detect `function_signature_mismatch`
 * conflicts when two claims declare the same sanitized function name. Exact
 * structural equality — no sort widening or coercion.
 *
 * Preconditions: both arguments are well-formed `LogicFunctionSymbol`s.
 * Postconditions: pure and symmetric — `signaturesMatch(a, b) === signaturesMatch(b, a)`.
 * Failure modes: none — pure computation.
 */
function signaturesMatch(a: LogicFunctionSymbol, b: LogicFunctionSymbol): boolean {
  if (a.returns !== b.returns) {
    return false;
  }
  if (a.args.length !== b.args.length) {
    return false;
  }
  for (let index = 0; index < a.args.length; index += 1) {
    if (a.args[index] !== b.args[index]) {
      return false;
    }
  }
  return true;
}
