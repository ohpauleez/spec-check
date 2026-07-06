import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { neutralizeMarkdownInline } from "../../src/domain/reporting/render.js";
import { buildEquivalenceClusters } from "../../src/domain/formal/clustering.js";
import { preflightGroupBounds, preflightGroupClaimIds, runLogicAnalysis } from "../../src/domain/formal/logic-analysis.js";
import { CLAIMS_PER_GROUP_MAX, compileSpecSmtlib, compileSmtlib, DECLARATIONS_PER_CLAIM_MAX, sanitizeIdentifier } from "../../src/domain/formal/smtlib.js";
import { toClaimId, toOutputDirPath } from "../../src/domain/branded.js";
import type { LogicFunctionSymbol, LogicIrClaim, LogicSort } from "../../src/domain/logic-ir.js";

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(),
}));

vi.mock("../../src/adapters/fs.js", () => ({
  writeOutputAtomic: vi.fn(async () => undefined),
  resolveConfinedOutputPath: vi.fn((outputDir: string, rel: string) => `${outputDir}/${rel}`),
}));

type ClaimOperation =
  | { readonly kind: "appendCompatibleClaim" }
  | { readonly kind: "appendVariableSortConflict" }
  | { readonly kind: "appendFunctionSignatureConflict" }
  | { readonly kind: "appendSymbolKindConflict" }
  | { readonly kind: "appendSameClaimSanitizerCollision" }
  | { readonly kind: "appendDuplicateClaimId" }
  | { readonly kind: "removeClaim"; readonly indexSeed: number }
  | { readonly kind: "reorderClaims"; readonly leftSeed: number; readonly rightSeed: number };

interface StatefulClaim {
  readonly claimId: string;
  readonly variables: readonly { name: string; sort: LogicSort }[];
  readonly functions: readonly LogicFunctionSymbol[];
}

interface ReferenceConflict {
  readonly kind: "function_signature_mismatch" | "variable_sort_mismatch" | "symbol_kind_collision";
  readonly existingClaimId: string;
  readonly excludedClaimId: string;
}

interface ReferenceModelResult {
  readonly invalidGroup: boolean;
  readonly includedClaimIds: readonly string[];
  readonly excludedClaimIds: readonly string[];
  readonly conflicts: readonly ReferenceConflict[];
  readonly survivingTable: ReadonlyMap<string, { kind: "variable" | "function"; ownerClaimId: string; sortOrSignature: string }>;
}

interface ClaimState {
  readonly claims: readonly StatefulClaim[];
  readonly nextClaimCounter: number;
  readonly hasReorderedOrRemoved: boolean;
}

const removeClaimArb: fc.Arbitrary<ClaimOperation> = fc
  .record({ indexSeed: fc.integer({ min: 0, max: 1_000_000 }) })
  .map((value) => ({ kind: "removeClaim", indexSeed: value.indexSeed } as const));

const reorderClaimsArb: fc.Arbitrary<ClaimOperation> = fc
  .record({
    leftSeed: fc.integer({ min: 0, max: 1_000_000 }),
    rightSeed: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map((value) => ({
    kind: "reorderClaims",
    leftSeed: value.leftSeed,
    rightSeed: value.rightSeed,
  } as const));

const operationArb: fc.Arbitrary<ClaimOperation> = fc.oneof(
  fc.constant({ kind: "appendCompatibleClaim" } as const),
  fc.constant({ kind: "appendVariableSortConflict" } as const),
  fc.constant({ kind: "appendFunctionSignatureConflict" } as const),
  fc.constant({ kind: "appendSymbolKindConflict" } as const),
  fc.constant({ kind: "appendSameClaimSanitizerCollision" } as const),
  fc.constant({ kind: "appendDuplicateClaimId" } as const),
  removeClaimArb,
  reorderClaimsArb,
);

const markdownPayloadArb = fc.oneof(
  fc.constant("[x](http://evil)"),
  fc.constant("**x**"),
  fc.constant("_x_"),
  fc.constant("`x`"),
  fc.constant("a | b"),
  fc.constant("# heading"),
  fc.constant("> quote"),
  fc.constant("- bullet"),
  fc.constant("1. ordered"),
);

const rawIdentifierArb = fc.string({ minLength: 0, maxLength: 20 });

const initialState: ClaimState = {
  claims: [],
  nextClaimCounter: 1,
  hasReorderedOrRemoved: false,
};

function makeClaimId(counter: number): string {
  return `R-${String(counter)}`;
}

function buildLogicClaim(stateful: StatefulClaim): LogicIrClaim {
  return {
    claimId: toClaimId(stateful.claimId),
    obligation: "mandatory",
    variables: stateful.variables,
    functions: stateful.functions,
    assertions: [{ id: "A1", expr: "true" }],
  };
}

function signatureKey(fn: LogicFunctionSymbol): string {
  return `${fn.args.join(",")}=>${fn.returns}`;
}

function firstVariableSymbol(claims: readonly StatefulClaim[]): string | undefined {
  for (const claim of claims) {
    for (const variable of claim.variables) {
      return variable.name;
    }
  }
  return undefined;
}

function firstFunctionSymbol(claims: readonly StatefulClaim[]): string | undefined {
  for (const claim of claims) {
    for (const fn of claim.functions) {
      return fn.name;
    }
  }
  return undefined;
}

function appendClaim(state: ClaimState, claim: StatefulClaim): ClaimState {
  return {
    ...state,
    claims: [...state.claims, claim],
    nextClaimCounter: state.nextClaimCounter + 1,
  };
}

function applyOperation(state: ClaimState, operation: ClaimOperation): ClaimState {
  switch (operation.kind) {
    case "appendCompatibleClaim": {
      const existingVarName = firstVariableSymbol(state.claims) ?? "S";
      const existingFunctionName = firstFunctionSymbol(state.claims);
      const compatibleClaim: StatefulClaim = {
        claimId: makeClaimId(state.nextClaimCounter),
        variables: [{ name: existingVarName, sort: "Bool" }],
        functions: existingFunctionName === undefined ? [] : [{ name: existingFunctionName, args: ["Bool"], returns: "Bool" }],
      };
      return appendClaim(state, compatibleClaim);
    }
    case "appendVariableSortConflict": {
      const targetName = firstVariableSymbol(state.claims) ?? "V";
      const sortInUse = "Bool" as const;
      const conflictSort = "Int" as const;
      const baseState = state.claims.length === 0
        ? appendClaim(state, {
          claimId: makeClaimId(state.nextClaimCounter),
          variables: [{ name: targetName, sort: sortInUse }],
          functions: [],
        })
        : state;
      return appendClaim(baseState, {
        claimId: makeClaimId(baseState.nextClaimCounter),
        variables: [{ name: targetName, sort: conflictSort }],
        functions: [],
      });
    }
    case "appendFunctionSignatureConflict": {
      const targetName = firstFunctionSymbol(state.claims) ?? "f";
      const baseState = state.claims.some((claim) => claim.functions.length > 0)
        ? state
        : appendClaim(state, {
          claimId: makeClaimId(state.nextClaimCounter),
          variables: [],
          functions: [{ name: targetName, args: ["Bool"], returns: "Bool" }],
        });
      return appendClaim(baseState, {
        claimId: makeClaimId(baseState.nextClaimCounter),
        variables: [],
        functions: [{ name: targetName, args: ["Int"], returns: "Int" }],
      });
    }
    case "appendSymbolKindConflict": {
      const variableName = firstVariableSymbol(state.claims) ?? "shared";
      const baseState = state.claims.some((claim) => claim.variables.length > 0)
        ? state
        : appendClaim(state, {
          claimId: makeClaimId(state.nextClaimCounter),
          variables: [{ name: variableName, sort: "Bool" }],
          functions: [],
        });
      return appendClaim(baseState, {
        claimId: makeClaimId(baseState.nextClaimCounter),
        variables: [],
        functions: [{ name: variableName, args: ["Bool"], returns: "Bool" }],
      });
    }
    case "appendSameClaimSanitizerCollision": {
      return appendClaim(state, {
        claimId: makeClaimId(state.nextClaimCounter),
        variables: [{ name: "REQ(1)", sort: "Bool" }],
        functions: [{ name: "REQ_281_29", args: ["Bool"], returns: "Bool" }],
      });
    }
    case "appendDuplicateClaimId": {
      const duplicateTarget = state.claims[0]?.claimId ?? makeClaimId(state.nextClaimCounter);
      const nextCounter = state.claims.length === 0 ? state.nextClaimCounter + 1 : state.nextClaimCounter;
      return {
        ...state,
        claims: [...state.claims, {
          claimId: duplicateTarget,
          variables: [{ name: `dup_${String(state.claims.length)}`, sort: "Bool" }],
          functions: [],
        }],
        nextClaimCounter: nextCounter,
      };
    }
    case "removeClaim": {
      if (state.claims.length === 0) {
        return state;
      }
      const index = operation.indexSeed % state.claims.length;
      return {
        ...state,
        claims: state.claims.filter((_, claimIndex) => claimIndex !== index),
        hasReorderedOrRemoved: true,
      };
    }
    case "reorderClaims": {
      if (state.claims.length < 2) {
        return state;
      }
      const leftIndex = operation.leftSeed % state.claims.length;
      const rightIndex = operation.rightSeed % state.claims.length;
      if (leftIndex === rightIndex) {
        return state;
      }
      const nextClaims = [...state.claims];
      const left = nextClaims[leftIndex]!;
      nextClaims[leftIndex] = nextClaims[rightIndex]!;
      nextClaims[rightIndex] = left;
      return {
        ...state,
        claims: nextClaims,
        hasReorderedOrRemoved: true,
      };
    }
  }
}

function compileFromState(state: ClaimState): ReturnType<typeof compileSpecSmtlib> {
  const claims = state.claims.map(buildLogicClaim);
  return compileSpecSmtlib("specs/property/spec.md", claims);
}

function runReferenceModel(state: ClaimState): ReferenceModelResult {
  const seenRaw = new Set<string>();
  for (const claim of state.claims) {
    if (seenRaw.has(claim.claimId)) {
      return {
        invalidGroup: true,
        includedClaimIds: [],
        excludedClaimIds: [],
        conflicts: [],
        survivingTable: new Map(),
      };
    }
    seenRaw.add(claim.claimId);
  }

  const variableRegistry = new Map<string, { claimId: string; sort: LogicSort }>();
  const functionRegistry = new Map<string, { claimId: string; signature: string }>();
  const conflicts: ReferenceConflict[] = [];
  const excludedClaimIds = new Set<string>();
  const includedClaimIds: string[] = [];

  for (const claim of state.claims) {
    let conflict: ReferenceConflict | null = null;

    for (const variable of claim.variables) {
      const sanitizedName = sanitizeIdentifier(variable.name);
      const existing = variableRegistry.get(sanitizedName);
      if (existing !== undefined && existing.sort !== variable.sort) {
        conflict = {
          kind: "variable_sort_mismatch",
          existingClaimId: existing.claimId,
          excludedClaimId: claim.claimId,
        };
        break;
      }
    }

    if (conflict === null) {
      for (const fn of claim.functions) {
        const sanitizedName = sanitizeIdentifier(fn.name);
        const existing = functionRegistry.get(sanitizedName);
        if (existing !== undefined && existing.signature !== signatureKey(fn)) {
          conflict = {
            kind: "function_signature_mismatch",
            existingClaimId: existing.claimId,
            excludedClaimId: claim.claimId,
          };
          break;
        }
      }
    }

    if (conflict === null) {
      const claimVariableSymbols = new Map<string, string>();
      const claimFunctionSymbols = new Map<string, string>();

      for (const variable of claim.variables) {
        claimVariableSymbols.set(sanitizeIdentifier(variable.name), variable.name);
      }
      for (const fn of claim.functions) {
        claimFunctionSymbols.set(sanitizeIdentifier(fn.name), fn.name);
      }

      for (const [sanitizedName] of claimVariableSymbols) {
        if (functionRegistry.has(sanitizedName)) {
          const existing = functionRegistry.get(sanitizedName)!;
          conflict = {
            kind: "symbol_kind_collision",
            existingClaimId: existing.claimId,
            excludedClaimId: claim.claimId,
          };
          break;
        }

        if (claimFunctionSymbols.has(sanitizedName)) {
          conflict = {
            kind: "symbol_kind_collision",
            existingClaimId: claim.claimId,
            excludedClaimId: claim.claimId,
          };
          break;
        }
      }

      if (conflict === null) {
        for (const [sanitizedName] of claimFunctionSymbols) {
          if (variableRegistry.has(sanitizedName)) {
            const existing = variableRegistry.get(sanitizedName)!;
            conflict = {
              kind: "symbol_kind_collision",
              existingClaimId: existing.claimId,
              excludedClaimId: claim.claimId,
            };
            break;
          }
        }
      }
    }

    if (conflict !== null) {
      conflicts.push(conflict);
      excludedClaimIds.add(claim.claimId);
      continue;
    }

    includedClaimIds.push(claim.claimId);

    for (const variable of claim.variables) {
      const sanitizedName = sanitizeIdentifier(variable.name);
      if (!variableRegistry.has(sanitizedName)) {
        variableRegistry.set(sanitizedName, { claimId: claim.claimId, sort: variable.sort });
      }
    }
    for (const fn of claim.functions) {
      const sanitizedName = sanitizeIdentifier(fn.name);
      if (!functionRegistry.has(sanitizedName)) {
        functionRegistry.set(sanitizedName, { claimId: claim.claimId, signature: signatureKey(fn) });
      }
    }
  }

  const survivingTable = new Map<string, { kind: "variable" | "function"; ownerClaimId: string; sortOrSignature: string }>();
  for (const [symbol, entry] of variableRegistry) {
    survivingTable.set(symbol, { kind: "variable", ownerClaimId: entry.claimId, sortOrSignature: entry.sort });
  }
  for (const [symbol, entry] of functionRegistry) {
    survivingTable.set(symbol, { kind: "function", ownerClaimId: entry.claimId, sortOrSignature: entry.signature });
  }

  return {
    invalidGroup: false,
    includedClaimIds,
    excludedClaimIds: [...excludedClaimIds],
    conflicts,
    survivingTable,
  };
}

function buildHistory(operations: readonly ClaimOperation[]): ClaimState {
  let state = initialState;
  for (const operation of operations) {
    state = applyOperation(state, operation);
  }
  return state;
}

describe("logic and clustering properties", () => {
  it("sanitized identifiers remain SMT-safe", async () => {
    traceSpec("FLA-SMTLIB-COMPILE");
    await fc.assert(
      fc.asyncProperty(fc.string(), async (value) => {
        const sanitized = sanitizeIdentifier(value);
        expect(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(sanitized)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it("sanitizer is injective for generated distinct raw identifiers", async () => {
    traceSpec("FLA-SPEC-LABEL-ENCODE", "FLA-SPEC-NAMED");
    await fc.assert(
      fc.asyncProperty(rawIdentifierArb, rawIdentifierArb, async (left, right) => {
        fc.pre(left !== right);
        expect(sanitizeIdentifier(left)).not.toBe(sanitizeIdentifier(right));
      }),
      { numRuns: 120 },
    );
  });

  it("cluster construction is deterministic and symmetric for mutual pairs", async () => {
    traceSpec("FLA-CLUSTER-PROPERTIES", "FLA-CLUSTER-SYMM", "FLA-CLUSTER-DETERM");
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (size) => {
        const pairwise = [] as {
          leftIndex: number;
          rightIndex: number;
          leftImpliesRight: "yes";
          rightImpliesLeft: "yes";
          evidence: {
            leftToRightQuery: string;
            rightToLeftQuery: string;
            leftToRightResult: string;
            rightToLeftResult: string;
          };
        }[];

        for (let left = 0; left < size; left += 1) {
          for (let right = left + 1; right < size; right += 1) {
            pairwise.push({
              leftIndex: left,
              rightIndex: right,
              leftImpliesRight: "yes",
              rightImpliesLeft: "yes",
              evidence: {
                leftToRightQuery: "",
                rightToLeftQuery: "",
                leftToRightResult: "unsat",
                rightToLeftResult: "unsat",
              },
            });
          }
        }

        const clustersA = buildEquivalenceClusters(size, pairwise);
        const clustersB = buildEquivalenceClusters(size, pairwise);
        expect(clustersA).toEqual(clustersB);
      }),
      { numRuns: 20 },
    );
  });

  it("stateful command histories agree between reference model and compiler", async () => {
    traceSpec(
      "FLA-SPEC-COMBINE",
      "FLA-SPEC-CLAIMIDS",
      "FLA-SPEC-CONFLICT-ORDER",
      "FLA-SPEC-VARSORT-CONFLICT",
      "FLA-SPEC-CONFLICT",
      "FLA-SPEC-SYMKIND-CONFLICT",
    );

    await fc.assert(
      fc.asyncProperty(fc.array(operationArb, { minLength: 1, maxLength: 24 }), async (operations) => {
        const state = buildHistory(operations);
        const reference = runReferenceModel(state);

        if (reference.invalidGroup) {
          const preflightIssue = preflightGroupClaimIds(state.claims.map(buildLogicClaim));
          expect(preflightIssue).not.toBeNull();
          return;
        }

        const compiled = compileFromState(state);

        const compiledIncluded = [...compiled.claimIds];
        const referenceIncluded = [...reference.includedClaimIds];
        expect(compiledIncluded).toEqual(referenceIncluded);

        const compiledExcluded = new Set(compiled.conflicts.map((conflict) => conflict.excludedClaimId));
        const referenceExcluded = new Set(reference.excludedClaimIds);
        expect(compiledExcluded).toEqual(referenceExcluded);

        expect(compiled.conflicts.map((conflict) => conflict.kind)).toEqual(reference.conflicts.map((conflict) => conflict.kind));
        expect(compiled.conflicts.map((conflict) => `${conflict.existingClaimId}->${conflict.excludedClaimId}`)).toEqual(
          reference.conflicts.map((conflict) => `${conflict.existingClaimId}->${conflict.excludedClaimId}`),
        );

        const includedSet = new Set(compiled.claimIds);
        const allClaimIds = state.claims.map((claim) => claim.claimId);

        for (const claimId of allClaimIds) {
          const included = includedSet.has(claimId);
          const excluded = compiled.conflicts.some((conflict) => conflict.excludedClaimId === claimId);
          expect(included && excluded).toBe(false);
          expect(included || excluded).toBe(true);
        }

        const survivingVariableSorts = new Map<string, Set<LogicSort>>();
        const survivingFunctionSignatures = new Map<string, Set<string>>();
        const survivingKinds = new Map<string, Set<"variable" | "function">>();

        for (const claim of state.claims) {
          if (!includedSet.has(claim.claimId)) {
            continue;
          }
          for (const variable of claim.variables) {
            const symbol = sanitizeIdentifier(variable.name);
            const sorts = survivingVariableSorts.get(symbol) ?? new Set<LogicSort>();
            sorts.add(variable.sort);
            survivingVariableSorts.set(symbol, sorts);
            const kinds = survivingKinds.get(symbol) ?? new Set<"variable" | "function">();
            kinds.add("variable");
            survivingKinds.set(symbol, kinds);
          }
          for (const fn of claim.functions) {
            const symbol = sanitizeIdentifier(fn.name);
            const signatures = survivingFunctionSignatures.get(symbol) ?? new Set<string>();
            signatures.add(signatureKey(fn));
            survivingFunctionSignatures.set(symbol, signatures);
            const kinds = survivingKinds.get(symbol) ?? new Set<"variable" | "function">();
            kinds.add("function");
            survivingKinds.set(symbol, kinds);
          }
        }

        for (const sorts of survivingVariableSorts.values()) {
          expect(sorts.size).toBeLessThanOrEqual(1);
        }
        for (const signatures of survivingFunctionSignatures.values()) {
          expect(signatures.size).toBeLessThanOrEqual(1);
        }
        for (const kinds of survivingKinds.values()) {
          expect(kinds.size).toBeLessThanOrEqual(1);
        }

        const tableOwnerBySymbol = new Map<string, string>();
        for (const claim of state.claims) {
          if (!includedSet.has(claim.claimId)) {
            continue;
          }
          for (const variable of claim.variables) {
            const symbol = sanitizeIdentifier(variable.name);
            if (!tableOwnerBySymbol.has(symbol)) {
              tableOwnerBySymbol.set(symbol, claim.claimId);
            }
          }
          for (const fn of claim.functions) {
            const symbol = sanitizeIdentifier(fn.name);
            if (!tableOwnerBySymbol.has(symbol)) {
              tableOwnerBySymbol.set(symbol, claim.claimId);
            }
          }
        }

        for (const conflict of compiled.conflicts) {
          const expectedOwner = tableOwnerBySymbol.get(conflict.sanitizedName);
          const existingClaimSurvives = includedSet.has(conflict.existingClaimId);
          if (expectedOwner !== undefined && existingClaimSurvives) {
            expect(conflict.existingClaimId).toBe(expectedOwner);
          }
        }

        const referenceEntries = [...reference.survivingTable.entries()].sort((left, right) => left[0].localeCompare(right[0]));
        const implementationEntries = [...tableOwnerBySymbol.entries()].sort((left, right) => left[0].localeCompare(right[0]));
        expect(implementationEntries.map(([symbol, owner]) => `${symbol}:${owner}`)).toEqual(
          referenceEntries.map(([symbol, entry]) => `${symbol}:${entry.ownerClaimId}`),
        );
      }),
      { numRuns: 120 },
    );
  });

  it("compile is deterministic for the same generated state", async () => {
    traceSpec("FLA-SPEC-COMBINE", "FLA-SPEC-CLAIMIDS", "FLA-SPEC-CONFLICT-ORDER");
    await fc.assert(
      fc.asyncProperty(fc.array(operationArb, { minLength: 1, maxLength: 24 }), async (operations) => {
        const state = buildHistory(operations);
        const preflightIssue = preflightGroupClaimIds(state.claims.map(buildLogicClaim));
        fc.pre(preflightIssue === null);

        const first = compileFromState(state);
        const second = compileFromState(state);

        expect(first.claimIds).toEqual(second.claimIds);
        expect(first.conflicts).toEqual(second.conflicts);
        expect(first.smtlib).toEqual(second.smtlib);
        expect([...first.assertionNameMap.entries()]).toEqual([...second.assertionNameMap.entries()]);
      }),
      { numRuns: 80 },
    );
  });

  it("append-compatible histories are monotonic when no reorders/removals occur", async () => {
    traceSpec("FLA-SPEC-DEDUP", "FLA-SPEC-CLAIMIDS");
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constant<ClaimOperation>({ kind: "appendCompatibleClaim" }), { minLength: 1, maxLength: 24 }), async (operations) => {
        let state = initialState;
        let previousIncluded = new Set<string>();

        for (const operation of operations) {
          state = applyOperation(state, operation);
          const preflightIssue = preflightGroupClaimIds(state.claims.map(buildLogicClaim));
          expect(preflightIssue).toBeNull();

          const compiled = compileFromState(state);
          const currentIncluded = new Set(compiled.claimIds);
          for (const previousClaimId of previousIncluded) {
            expect(currentIncluded.has(previousClaimId)).toBe(true);
          }
          expect(currentIncluded.size).toBeGreaterThanOrEqual(previousIncluded.size);
          previousIncluded = currentIncluded;
        }
      }),
      { numRuns: 60 },
    );
  });

  it("function-signature conflict histories keep function-conflict-only scope", async () => {
    traceSpec("FLA-SPEC-CONFLICT", "FLA-SPEC-CLAIMIDS");
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constant<ClaimOperation>({ kind: "appendFunctionSignatureConflict" }), { minLength: 1, maxLength: 12 }), async (operations) => {
        const state = buildHistory(operations);
        const preflightIssue = preflightGroupClaimIds(state.claims.map(buildLogicClaim));
        expect(preflightIssue).toBeNull();

        const compiled = compileFromState(state);
        for (const conflict of compiled.conflicts) {
          expect(conflict.kind).toBe("function_signature_mismatch");
        }
      }),
      { numRuns: 50 },
    );
  });

  it("constructed sanitized collisions reject with duplicate_sanitized_claim_id", async () => {
    traceSpec("FLA-SPEC-DUPLICATE-CLAIM-ID");
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 999_999 }), fc.integer({ min: 1, max: 999_999 }), async (left, right) => {
        fc.pre(left !== right);
        const claims = [
          buildLogicClaim({ claimId: `R-A-${String(left)}`, variables: [{ name: "X", sort: "Bool" }], functions: [] }),
          buildLogicClaim({ claimId: `R-B-${String(right)}`, variables: [{ name: "Y", sort: "Bool" }], functions: [] }),
        ];
        const issue = preflightGroupClaimIds(claims, () => "SAME" as never);
        expect(issue?.kind).toBe("duplicate_sanitized_claim_id");
      }),
      { numRuns: 40 },
    );
  });

  it("logic analysis performs zero solver and write work for invalid groups", async () => {
    traceSpec("FLA-SPEC-DUPLICATE-CLAIM-ID");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 999_999 }), async (suffix) => {
        vi.clearAllMocks();
        const duplicateId = `R-DUP-${String(suffix)}`;
        const groupClaims = [
          buildLogicClaim({ claimId: duplicateId, variables: [{ name: "A", sort: "Bool" }], functions: [] }),
          buildLogicClaim({ claimId: duplicateId, variables: [{ name: "B", sort: "Bool" }], functions: [] }),
        ];

        const result = await runLogicAnalysis({
          groups: [{ specFile: "specs/test/spec.md", claims: groupClaims }],
          outputDir: toOutputDirPath("/tmp/spec-check-property"),
        });

        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.category).toBe("logic.invalid_group");
        expect(vi.mocked(runZ3Query)).not.toHaveBeenCalled();
        expect(vi.mocked(writeOutputAtomic)).not.toHaveBeenCalled();
      }),
      { numRuns: 24 },
    );
  });

  it("preflightGroupBounds accepts group cardinality at the limit and flags it one past the limit", () => {
    traceSpec("FLA-SPEC-GROUP-BOUNDS");
    fc.assert(
      fc.property(fc.integer({ min: -3, max: 3 }), (offset) => {
        const count = CLAIMS_PER_GROUP_MAX + offset;
        const claims = Array.from({ length: count }, (_, index) =>
          buildLogicClaim({ claimId: `R-${String(index)}`, variables: [{ name: "S", sort: "Bool" }], functions: [] }));

        const issue = preflightGroupBounds(claims);
        if (count <= CLAIMS_PER_GROUP_MAX) {
          expect(issue).toBeNull();
        } else {
          expect(issue?.kind).toBe("group_too_large");
        }
      }),
      { numRuns: 7 },
    );
  });

  it("preflightGroupBounds counts variables plus functions against the per-claim limit", () => {
    traceSpec("FLA-SPEC-GROUP-BOUNDS");
    fc.assert(
      fc.property(fc.integer({ min: -3, max: 3 }), (offset) => {
        const totalDeclarations = DECLARATIONS_PER_CLAIM_MAX + offset;
        const functionCount = Math.floor(totalDeclarations / 2);
        const variableCount = totalDeclarations - functionCount;
        const variables = Array.from({ length: variableCount }, (_, index) => ({ name: `V${String(index)}`, sort: "Bool" as const }));
        const functions: LogicFunctionSymbol[] = Array.from({ length: functionCount }, (_, index) => ({ name: `F${String(index)}`, args: [], returns: "Bool" }));

        const issue = preflightGroupBounds([buildLogicClaim({ claimId: "R-DECL", variables, functions })]);
        if (totalDeclarations <= DECLARATIONS_PER_CLAIM_MAX) {
          expect(issue).toBeNull();
        } else {
          expect(issue?.kind).toBe("claim_too_many_declarations");
        }
      }),
      { numRuns: 7 },
    );
  });

  it("renderer neutralization keeps markdown payloads inert", async () => {
    traceSpec("RAE-EVID-RENDER-SAFE");
    await fc.assert(
      fc.asyncProperty(markdownPayloadArb, async (payload) => {
        const escaped = neutralizeMarkdownInline(payload);
        expect(escaped).not.toBe(payload);
      }),
      { numRuns: 40 },
    );
  });

  it("compiler comment emission neutralizes newline-based SMT command injection", async () => {
    traceSpec("FLA-SPEC-COMMENT-SAFE");
    const payloadArb = fc.oneof(
      fc.constant("foo\n(check-sat)"),
      fc.constant("foo\r\n(set-option :produce-unsat-cores true)"),
      fc.constant("foo;bar"),
      fc.constant("(get-model)"),
      fc.string({ minLength: 1, maxLength: 30 }),
    );

    await fc.assert(
      fc.asyncProperty(payloadArb, async (payload) => {
        const compiled = compileSmtlib({
          claimId: toClaimId("R-COMMENT-SAFE"),
          obligation: "mandatory",
          variables: [{ name: payload, sort: "Bool" }],
          functions: [],
          assertions: [{ id: payload, expr: "true" }],
        });

        const lines = compiled.smtlib.split("\n");
        const executableLines = lines.filter((line) => line.startsWith("(check-sat)") || line.startsWith("(set-option") || line.startsWith("(get-model)"));
        expect(executableLines).toHaveLength(0);
      }),
      { numRuns: 40 },
    );
  });

  it("declaration names and assertion identifier-like tokens are sanitized before emission", async () => {
    traceSpec("FLA-SMTLIB-SANITIZE", "FLA-SPEC-NAMED");
    const tokenArb = fc
      .string({ minLength: 1, maxLength: 16 })
      .filter((value) => /^[A-Za-z_][A-Za-z0-9_\-.:]*$/u.test(value));

    await fc.assert(
      fc.asyncProperty(tokenArb, async (rawToken) => {
        const sanitizedToken = sanitizeIdentifier(rawToken);
        const compiled = compileSmtlib({
          claimId: toClaimId("R-SAN-ASSERT"),
          obligation: "mandatory",
          variables: [{ name: rawToken, sort: "Bool" }],
          functions: [],
          assertions: [{ id: "A1", expr: rawToken }],
        });

        expect(compiled.smtlib).toContain(`(declare-const ${sanitizedToken} Bool)`);
        expect(compiled.smtlib).toContain(`(assert ${sanitizedToken})`);
      }),
      { numRuns: 60 },
    );
  });

  it("regression FLA-SPEC-CONFLICT-ORDER preserves first claimant after reorder", () => {
    traceSpec("FLA-SPEC-CONFLICT-ORDER", "FLA-SPEC-VARSORT-CONFLICT");
    const claims: LogicIrClaim[] = [
      buildLogicClaim({ claimId: "R-2", variables: [{ name: "State", sort: "Int" }], functions: [] }),
      buildLogicClaim({ claimId: "R-1", variables: [{ name: "State", sort: "Bool" }], functions: [] }),
      buildLogicClaim({ claimId: "R-3", variables: [{ name: "State", sort: "Real" }], functions: [] }),
    ];
    const compiled = compileSpecSmtlib("specs/regression/spec.md", claims);
    expect(compiled.claimIds).toEqual(["R-2"]);
    expect(compiled.conflicts.map((conflict) => conflict.kind)).toEqual(["variable_sort_mismatch", "variable_sort_mismatch"]);
    expect(compiled.conflicts.every((conflict) => conflict.existingClaimId === "R-2")).toBe(true);
  });

  it("regression FLA-SPEC-SYMKIND-CONFLICT same-claim cross-kind collision excludes claim", () => {
    traceSpec("FLA-SPEC-SYMKIND-CONFLICT", "FLA-SPEC-CLAIMIDS");
    const claims: LogicIrClaim[] = [
      buildLogicClaim({
        claimId: "R-COLLIDE",
        variables: [{ name: "shared", sort: "Bool" }],
        functions: [{ name: "shared", args: ["Bool"], returns: "Bool" }],
      }),
    ];
    const compiled = compileSpecSmtlib("specs/regression/spec.md", claims);
    expect(compiled.claimIds).toEqual([]);
    expect(compiled.conflicts).toHaveLength(1);
    expect(compiled.conflicts[0]?.kind).toBe("symbol_kind_collision");
    expect(compiled.conflicts[0]?.existingClaimId).toBe("R-COLLIDE");
    expect(compiled.conflicts[0]?.excludedClaimId).toBe("R-COLLIDE");
  });

  it("regression FLA-SPEC-SYMKIND-CONFLICT same-claim collision can cite excluded existing claim", () => {
    traceSpec("FLA-SPEC-SYMKIND-CONFLICT", "FLA-SPEC-CLAIMIDS");
    const state = buildHistory([
      { kind: "appendSymbolKindConflict" },
      { kind: "appendCompatibleClaim" },
    ]);
    const compiled = compileFromState(state);
    const includedSet = new Set(compiled.claimIds);

    expect(compiled.conflicts.some((conflict) => conflict.existingClaimId === conflict.excludedClaimId)).toBe(true);
    expect(compiled.conflicts.some((conflict) => !includedSet.has(conflict.existingClaimId))).toBe(true);
  });
});
