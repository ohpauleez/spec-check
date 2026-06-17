import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { compileSmtlib, sanitizeIdentifier } from "../../src/domain/formal/smtlib.js";
import { toClaimId } from "../../src/domain/branded.js";

describe("smtlib compilation", () => {
  it("sanitizes unsafe identifiers", () => {
    traceSpec("FLA-SMTLIB-COMPILE", "FLA-SMTLIB-SANITIZE");
    expect(sanitizeIdentifier("REQ(1)|A")).toMatch(/^REQ_28/u);
  });

  it("compiles logic IR with mapping comments", () => {
    traceSpec("FLA-SMTLIB-PRESERVE", "FLA-SMTLIB-QUERYSAT", "FLA-SMTLIB-ASSERTEXPRS");
    const compiled = compileSmtlib({
      claimId: toClaimId("REQ(1)"),
      obligation: "mandatory",
      sorts: [{ name: "State", sort: "Bool" }],
      functions: [{ name: "ok?", args: ["Bool"], returns: "Bool" }],
      assertions: [{ id: "ASSERT-1", expr: "(ok? true)" }],
    });

    expect(compiled.smtlib).toContain("id-map");
    expect(compiled.sanitizedClaimId).not.toContain("(");
    expect(compiled.smtlib).not.toContain("(check-sat)");
    expect(compiled.assertionExprs.length).toBeGreaterThan(0);
  });
});
