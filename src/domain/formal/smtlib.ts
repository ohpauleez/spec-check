/**
 * Compiles Logic IR claims into SMT-LIB text suitable for Z3 execution.
 *
 * Central compilation layer between the Logic IR and the Z3 solver adapter.
 * Exports: compileSmtlib, compileSpecSmtlib, parseUnsatCore, sanitizeIdentifier.
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
 * Result of compiling a Logic IR claim into SMT-LIB text.
 */
export interface CompiledSmtlib {
  readonly claimId: string;
  readonly sanitizedClaimId: SanitizedClaimId;
  readonly smtlib: SmtlibContent;
  readonly assertionExprs: readonly string[];
}

/**
 * Merge conflict detected while combining claims into one SMT-LIB program.
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
 * Result of compiling all claims from a single spec file into one SMT-LIB text.
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
 * Backward-compatible re-export. Identifier sanitization is implemented in
 * `identifiers.ts`.
 */
export const sanitizeIdentifier = sanitizeIdentifierImpl;

/**
 * Compile one claim to SMT-LIB declarations and assertions.
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
    [...declaredVariables.values()].every((entry) => entry.sort === "Bool" || entry.sort === "Int" || entry.sort === "Real" || entry.sort === "String"),
    "every declared variable sort must remain inside LogicSort",
  );
  invariant(
    [...declaredVariables.keys()].every((symbol) => !declaredFunctions.has(symbol)),
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
    [...assertionNameMap.values()].every((claimId) => includedSet.has(claimId)),
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
 * Parse SMT-LIB content back into declarations and assertion expressions.
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
 * Parse Z3 unsat-core output into assertion labels.
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
 * Sanitize identifier-like assertion tokens.
 */
function sanitizeAssertion(expr: string, sanitize: (value: string) => SanitizedClaimId): string {
  return expr.replace(/[A-Za-z_][A-Za-z0-9_\-.:]*/gu, (token) => sanitize(token));
}

/**
 * Escape untrusted comment text so line breaks cannot inject SMT-LIB commands.
 */
function escapeCommentLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}

/**
 * Compare function signatures for exact compatibility.
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
