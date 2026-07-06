import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { neutralizeMarkdownInline } from "../../src/domain/reporting/render.js";
import { buildEquivalenceClusters } from "../../src/domain/formal/clustering.js";
import { sanitizeIdentifier } from "../../src/domain/formal/smtlib.js";
import { preflightGroupClaimIds, runLogicAnalysis, type SpecClaimGroup } from "../../src/domain/formal/logic-analysis.js";
import { toClaimId, toOutputDirPath } from "../../src/domain/branded.js";
import type { LogicIrClaim, LogicSort } from "../../src/domain/logic-ir.js";

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(),
}));

vi.mock("../../src/adapters/fs.js", () => ({
  writeOutputAtomic: vi.fn(async () => undefined),
  resolveConfinedOutputPath: vi.fn((outputDir: string, rel: string) => `${outputDir}/${rel}`),
}));

const obligationArb = fc.constantFrom<"mandatory" | "advisory" | "informational">(
  "mandatory",
  "advisory",
  "informational",
);

const sortArb = fc.constantFrom<LogicSort>("Bool", "Int", "Real", "String");

const claimIdSuffixArb = fc.integer({ min: 1, max: 999_999 });

const sharedDeclNameArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((value) => /^[A-Za-z][A-Za-z0-9]*$/u.test(value));

const rawIdentifierArb = fc.string({ minLength: 0, maxLength: 20 });

function makeClaim(
  claimId: string,
  input: {
    readonly obligation?: "mandatory" | "advisory" | "informational";
    readonly variableName?: string;
    readonly variableSort?: LogicSort;
    readonly functionName?: string;
    readonly functionArgs?: readonly LogicSort[];
    readonly functionReturns?: LogicSort;
    readonly assertionExpr?: string;
  } = {},
): LogicIrClaim {
  const variableName = input.variableName ?? "S";
  const functionName = input.functionName;

  return {
    claimId: toClaimId(claimId),
    obligation: input.obligation ?? "mandatory",
    variables: [{ name: variableName, sort: input.variableSort ?? "Bool" }],
    functions: functionName === undefined
      ? []
      : [{ name: functionName, args: input.functionArgs ?? ["Bool"], returns: input.functionReturns ?? "Bool" }],
    assertions: [{ id: "A1", expr: input.assertionExpr ?? "true" }],
  };
}

function makeGroup(specFile: string, claims: readonly LogicIrClaim[]): SpecClaimGroup {
  return {
    specFile,
    claims,
  };
}

function makeUniqueClaimId(prefix: string, suffix: number): string {
  return `${prefix}-${String(suffix)}`;
}

describe("logic and clustering properties", () => {
  it("sanitized identifiers remain SMT-safe", async () => {
    traceSpec("FLA-SMTLIB-COMPILE");
    await fc.assert(
      fc.asyncProperty(fc.string(), async (value) => {
        const sanitized = sanitizeIdentifier(value);
        expect(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(sanitized)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it("sanitizer is injective for generated distinct raw identifiers", async () => {
    traceSpec("FLA-SPEC-LABEL-ENCODE", "FLA-SPEC-NAMED");
    await fc.assert(
      fc.asyncProperty(rawIdentifierArb, rawIdentifierArb, async (left, right) => {
        fc.pre(left !== right);
        const leftSanitized = sanitizeIdentifier(left);
        const rightSanitized = sanitizeIdentifier(right);
        expect(leftSanitized).not.toBe(rightSanitized);
      }),
      { numRuns: 100 },
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
        expect(clustersA).toHaveLength(1);
        expect(clustersA[0]?.members).toEqual([...Array.from({ length: size }, (_, index) => index)]);
      }),
      { numRuns: 20 },
    );
  });

  it("raw duplicate claim IDs always reject in preflight", async () => {
    traceSpec("FLA-SPEC-DUPLICATE-CLAIM-ID");
    await fc.assert(
      fc.asyncProperty(claimIdSuffixArb, obligationArb, obligationArb, async (suffix, leftObligation, rightObligation) => {
        const duplicatedClaimId = makeUniqueClaimId("R-DUP", suffix);
        const claims = [
          makeClaim(duplicatedClaimId, { obligation: leftObligation, variableName: "A" }),
          makeClaim(duplicatedClaimId, { obligation: rightObligation, variableName: "B" }),
        ];

        const issue = preflightGroupClaimIds(claims);
        expect(issue).not.toBeNull();
        expect(issue?.kind).toBe("duplicate_raw_claim_id");
      }),
      { numRuns: 50 },
    );
  });

  it("constructed sanitized collisions reject with duplicate_sanitized_claim_id", async () => {
    traceSpec("FLA-SPEC-DUPLICATE-CLAIM-ID");
    await fc.assert(
      fc.asyncProperty(claimIdSuffixArb, claimIdSuffixArb, async (leftSuffix, rightSuffix) => {
        fc.pre(leftSuffix !== rightSuffix);
        const claims = [
          makeClaim(makeUniqueClaimId("R-A", leftSuffix), { variableName: "X" }),
          makeClaim(makeUniqueClaimId("R-B", rightSuffix), { variableName: "Y" }),
        ];

        const issue = preflightGroupClaimIds(claims, () => "SAME" as never);
        expect(issue).not.toBeNull();
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
      fc.asyncProperty(claimIdSuffixArb, async (suffix) => {
        vi.clearAllMocks();
        const duplicate = makeUniqueClaimId("R-DUP", suffix);
        const group = makeGroup("specs/test/spec.md", [
          makeClaim(duplicate, { variableName: "A" }),
          makeClaim(duplicate, { variableName: "B" }),
        ]);

        const result = await runLogicAnalysis({
          groups: [group],
          outputDir: toOutputDirPath("/tmp/spec-check-property"),
        });

        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.category).toBe("logic.invalid_group");
        expect(vi.mocked(runZ3Query)).not.toHaveBeenCalled();
        expect(vi.mocked(writeOutputAtomic)).not.toHaveBeenCalled();
      }),
      { numRuns: 20 },
    );
  });

  it("conflict precedence is variable sort before function signature", async () => {
    traceSpec("FLA-SPEC-CONFLICT-ORDER", "FLA-SPEC-VARSORT-CONFLICT", "FLA-SPEC-CONFLICT");
    const { compileSpecSmtlib } = await import("../../src/domain/formal/smtlib.js");

    await fc.assert(
      fc.asyncProperty(sharedDeclNameArb, sortArb, sortArb, async (name, leftSort, rightSort) => {
        fc.pre(leftSort !== rightSort);

        const claims = [
          makeClaim("R-FIRST", {
            variableName: name,
            variableSort: leftSort,
            functionName: `${name}Fn`,
            functionArgs: ["Bool"],
            functionReturns: "Bool",
          }),
          makeClaim("R-SECOND", {
            variableName: name,
            variableSort: rightSort,
            functionName: `${name}Fn`,
            functionArgs: ["Int"],
            functionReturns: "Int",
          }),
        ];

        const compiled = compileSpecSmtlib("specs/precedence/spec.md", claims);
        expect(compiled.conflicts).toHaveLength(1);
        expect(compiled.conflicts[0]?.kind).toBe("variable_sort_mismatch");
      }),
      { numRuns: 40 },
    );
  });

  it("symbol-kind collisions exclude later claims under first-wins", async () => {
    traceSpec("FLA-SPEC-SYMKIND-CONFLICT");
    const { compileSpecSmtlib } = await import("../../src/domain/formal/smtlib.js");

    await fc.assert(
      fc.asyncProperty(sharedDeclNameArb, async (name) => {
        const claims = [
          makeClaim("R-FIRST", { variableName: name, variableSort: "Bool" }),
          makeClaim("R-LATER", { variableName: "X", functionName: name, functionArgs: ["Bool"], functionReturns: "Bool" }),
        ];

        const compiled = compileSpecSmtlib("specs/symbol-kind/spec.md", claims);
        expect(compiled.conflicts).toHaveLength(1);
        expect(compiled.conflicts[0]?.kind).toBe("symbol_kind_collision");
        expect(compiled.claimIds).toEqual(["R-FIRST"]);
      }),
      { numRuns: 30 },
    );
  });

  it("renderer neutralization keeps markdown payloads inert", async () => {
    traceSpec("RAE-EVID-RENDER-SAFE");
    const payloadArb = fc.oneof(
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

    await fc.assert(
      fc.asyncProperty(payloadArb, async (payload) => {
        const escaped = neutralizeMarkdownInline(payload);
        expect(escaped).not.toBe(payload);

        if (payload === "[x](http://evil)") {
          expect(escaped).toContain("\\[x\\]\\(http://evil\\)");
        }
        if (payload === "a | b") {
          expect(escaped).toContain("\\|");
        }
        if (payload.startsWith("#") || payload.startsWith(">") || payload.startsWith("-") || payload.startsWith("1.")) {
          expect(escaped.startsWith("\\") || escaped.includes("\\.")).toBe(true);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("compiler comment emission neutralizes newline-based SMT command injection", async () => {
    traceSpec("FLA-SPEC-COMMENT-SAFE");
    const { compileSmtlib } = await import("../../src/domain/formal/smtlib.js");

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
        const commentLines = lines.filter((line) => line.startsWith(";"));
        const executableLines = lines.filter((line) => line.startsWith("(check-sat)") || line.startsWith("(set-option") || line.startsWith("(get-model)"));

        expect(commentLines.length).toBeGreaterThan(0);
        expect(executableLines).toHaveLength(0);
      }),
      { numRuns: 40 },
    );
  });

  it("declaration names and assertion identifier-like tokens are sanitized before emission", async () => {
    traceSpec("FLA-SMTLIB-SANITIZE", "FLA-SPEC-NAMED");
    const { compileSmtlib } = await import("../../src/domain/formal/smtlib.js");

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
});
