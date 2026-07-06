import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  compileSmtlib,
  compileSpecSmtlib,
  parseUnsatCore,
  sanitizeIdentifier,
} from "../../src/domain/formal/smtlib.js";
import { toClaimId } from "../../src/domain/branded.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";

function makeClaim(
  claimId: string,
  opts?: {
    obligation?: "mandatory" | "advisory" | "informational";
    variables?: LogicIrClaim["variables"];
    functions?: LogicIrClaim["functions"];
    assertions?: LogicIrClaim["assertions"];
  },
): LogicIrClaim {
  return {
    claimId: toClaimId(claimId),
    obligation: opts?.obligation ?? "mandatory",
    variables: opts?.variables ?? [{ name: "S", sort: "Bool" }],
    functions: opts?.functions ?? [],
    assertions: opts?.assertions ?? [{ id: "A1", expr: "true" }],
  };
}

describe("smtlib compilation", () => {
  it("sanitizes unsafe identifiers", () => {
    traceSpec("FLA-SMTLIB-COMPILE", "FLA-SMTLIB-SANITIZE");
    expect(sanitizeIdentifier("REQ(1)|A")).toMatch(/^REQ_000028/u);
  });

  it("compiles logic IR with mapping comments", () => {
    traceSpec("FLA-SMTLIB-PRESERVE", "FLA-SMTLIB-QUERYSAT", "FLA-SMTLIB-ASSERTEXPRS");
    const compiled = compileSmtlib({
      claimId: toClaimId("REQ(1)"),
      obligation: "mandatory",
      variables: [{ name: "State", sort: "Bool" }],
      functions: [{ name: "ok?", args: ["Bool"], returns: "Bool" }],
      assertions: [{ id: "ASSERT-1", expr: "(ok? true)" }],
    });

    expect(compiled.smtlib).toContain("id-map");
    expect(compiled.sanitizedClaimId).not.toContain("(");
    expect(compiled.smtlib).not.toContain("(check-sat)");
    expect(compiled.assertionExprs.length).toBeGreaterThan(0);
  });
});

describe("compileSpecSmtlib", () => {
  it("produces a single smt2 without solver commands (callers append them)", () => {
    traceSpec("FLA-SPEC-COMBINE", "FLA-SMTLIB-QUERYSAT");
    const claims = [makeClaim("R1"), makeClaim("R2")];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    expect(result.smtlib).not.toContain("(set-option :produce-unsat-cores true)");
    expect(result.smtlib).not.toContain("(check-sat)");
    expect(result.claimIds).toEqual(["R1", "R2"]);
    expect(result.conflicts).toHaveLength(0);
  });

  it("uses named assertions with :named labels", () => {
    traceSpec("FLA-SPEC-NAMED");
    const claims = [makeClaim("R1", { assertions: [{ id: "A1", expr: "true" }, { id: "A2", expr: "false" }] })];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    expect(result.smtlib).toContain(":named R1__a0");
    expect(result.smtlib).toContain(":named R1__a1");
    expect(result.assertionNameMap.get("R1__a0")).toBe("R1");
    expect(result.assertionNameMap.get("R1__a1")).toBe("R1");
  });

  it("deduplicates identical variable declarations", () => {
    traceSpec("FLA-SPEC-DEDUP");
    const claims = [
      makeClaim("R1", { variables: [{ name: "State", sort: "Bool" }] }),
      makeClaim("R2", { variables: [{ name: "State", sort: "Bool" }] }),
    ];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    const constDecls = result.smtlib.split("\n").filter((line) => line.startsWith("(declare-const"));
    expect(constDecls).toHaveLength(1);
  });

  it("deduplicates identical function declarations", () => {
    traceSpec("FLA-SPEC-DEDUP");
    const fn = { name: "is_valid", args: ["Bool"] as const, returns: "Bool" as const };
    const claims = [
      makeClaim("R1", { functions: [fn] }),
      makeClaim("R2", { functions: [fn] }),
    ];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    const funDecls = result.smtlib.split("\n").filter((line) => line.startsWith("(declare-fun"));
    expect(funDecls).toHaveLength(1);
  });

  it("detects function signature conflicts and excludes conflicting claims", () => {
    traceSpec("FLA-SPEC-CONFLICT", "FLA-SPEC-CLAIMIDS");
    const claims = [
      makeClaim("R1", { functions: [{ name: "f", args: ["Bool"], returns: "Bool" }] }),
      makeClaim("R2", { functions: [{ name: "f", args: ["Int"], returns: "Int" }] }),
    ];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe("function_signature_mismatch");
    if (conflict.kind === "function_signature_mismatch") {
      expect(conflict.existingFunctionName).toBe("f");
      expect(conflict.conflictingFunctionName).toBe("f");
      expect(conflict.existingClaimId).toBe("R1");
      expect(conflict.excludedClaimId).toBe("R2");
    }
    expect(result.claimIds).toEqual(["R1"]);
  });

  it("detects variable sort mismatch and excludes later claim", () => {
    traceSpec("FLA-SPEC-VARSORT-CONFLICT");
    const claims = [
      makeClaim("R1", { variables: [{ name: "State", sort: "Bool" }] }),
      makeClaim("R2", { variables: [{ name: "State", sort: "Int" }] }),
    ];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe("variable_sort_mismatch");
    if (conflict.kind === "variable_sort_mismatch") {
      expect(conflict.expectedSort).toBe("Bool");
      expect(conflict.conflictingSort).toBe("Int");
      expect(conflict.existingClaimId).toBe("R1");
      expect(conflict.excludedClaimId).toBe("R2");
    }
    expect(result.claimIds).toEqual(["R1"]);
  });

  it("detects symbol kind collision across claims", () => {
    traceSpec("FLA-SPEC-SYMKIND-CONFLICT");
    const claims = [
      makeClaim("R1", { variables: [{ name: "sym", sort: "Bool" }] }),
      makeClaim("R2", { functions: [{ name: "sym", args: ["Bool"], returns: "Bool" }] }),
    ];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe("symbol_kind_collision");
    if (conflict.kind === "symbol_kind_collision") {
      expect(conflict.existingSymbolKind).toBe("variable");
      expect(conflict.conflictingSymbolKind).toBe("function");
      expect(conflict.existingClaimId).toBe("R1");
      expect(conflict.excludedClaimId).toBe("R2");
    }
    expect(result.claimIds).toEqual(["R1"]);
  });

  it("detects same-claim symbol kind collision", () => {
    traceSpec("FLA-SPEC-SYMKIND-CONFLICT");
    const claims = [
      makeClaim("R1", {
        variables: [{ name: "shared", sort: "Bool" }],
        functions: [{ name: "shared", args: ["Bool"], returns: "Bool" }],
      }),
    ];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe("symbol_kind_collision");
    if (conflict.kind === "symbol_kind_collision") {
      expect(conflict.existingClaimId).toBe("R1");
      expect(conflict.excludedClaimId).toBe("R1");
      expect(conflict.claimIds).toEqual(["R1", "R1"]);
    }
    expect(result.claimIds).toEqual([]);
  });

  it("uses conflict precedence variable before function before symbol-kind", () => {
    traceSpec("FLA-SPEC-CONFLICT-ORDER");
    const claims = [
      makeClaim("R1", {
        variables: [{ name: "v", sort: "Bool" }],
        functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
      }),
      makeClaim("R2", {
        variables: [{ name: "v", sort: "Int" }],
        functions: [{ name: "f", args: ["Int"], returns: "Int" }],
      }),
    ];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.kind).toBe("variable_sort_mismatch");
  });

  it("maps assertion labels back to claim IDs", () => {
    traceSpec("FLA-SPEC-NAMED");
    const claims = [
      makeClaim("R1", { assertions: [{ id: "A1", expr: "(> x 0)" }] }),
      makeClaim("R2", { assertions: [{ id: "B1", expr: "(< y 10)" }] }),
    ];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    expect(result.assertionNameMap.get("R1__a0")).toBe("R1");
    expect(result.assertionNameMap.get("R2__a0")).toBe("R2");
  });

  it("keeps assertion labels distinct for formerly colliding identifiers", () => {
    traceSpec("FLA-SPEC-LABEL-ENCODE", "FLA-SPEC-NAMED");
    const claims = [
      makeClaim("REQ(1)", { assertions: [{ id: "A1", expr: "true" }] }),
      makeClaim("REQ_281_29", { assertions: [{ id: "A1", expr: "true" }] }),
    ];
    const result = compileSpecSmtlib("specs/foo/spec.md", claims);

    const labels = [...result.assertionNameMap.keys()];
    expect(labels).toHaveLength(2);
    expect(labels[0]).not.toBe(labels[1]);
  });
});

describe("parseUnsatCore", () => {
  it("parses standard Z3 unsat-core output", () => {
    const stdout = "unsat\n(R1__a0 R2__a0 R3__a1)\n";
    const labels = parseUnsatCore(stdout);
    expect(labels).toEqual(["R1__a0", "R2__a0", "R3__a1"]);
  });

  it("returns empty array for empty core", () => {
    const stdout = "unsat\n()\n";
    const labels = parseUnsatCore(stdout);
    expect(labels).toEqual([]);
  });

  it("returns empty array when no parenthesized line found", () => {
    const stdout = "unsat\n";
    const labels = parseUnsatCore(stdout);
    expect(labels).toEqual([]);
  });

  it("handles extra whitespace in core output", () => {
    const stdout = "unsat\n(  R1__a0   R2__a0  )\n";
    const labels = parseUnsatCore(stdout);
    expect(labels).toEqual(["R1__a0", "R2__a0"]);
  });
});
