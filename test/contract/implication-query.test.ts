import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { buildImplicationQuery as clusteringBuildImplicationQuery } from "../../src/domain/formal/clustering.js";
import { buildImplicationQuery as crossBuildImplicationQuery } from "../../src/domain/code-backwards/cross-implication.js";
import { toClaimId } from "../../src/domain/branded.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";

function makeClaim(id: string, assertionExprs: string[]): LogicIrClaim {
  return {
    claimId: toClaimId(id),
    obligation: "mandatory",
    sorts: [{ name: "X", sort: "Bool" }],
    functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
    assertions: assertionExprs.map((expr, index) => ({ id: `A${index}`, expr })),
  };
}

describe("implication query construction — clustering", () => {
  it("contains exactly one (check-sat) command", () => {
    traceSpec("FLA-CLUSTER-STABLE", "FLA-CLUSTER-QUERY");
    const left = makeClaim("L", ["(f true)"]);
    const right = makeClaim("R", ["(f false)"]);

    const query = clusteringBuildImplicationQuery(left, right);
    const checkSatCount = (query.match(/\(check-sat\)/gu) ?? []).length;

    expect(checkSatCount).toBe(1);
  });

  it("does not directly assert right-side claim expressions", () => {
    traceSpec("FLA-CLUSTER-STABLE", "FLA-CLUSTER-QUERY");
    const left = makeClaim("L", ["(f true)"]);
    const right = makeClaim("R", ["(f false)"]);

    const query = clusteringBuildImplicationQuery(left, right);

    // The right assertion expr "(f false)" should ONLY appear inside a negation,
    // never as a bare (assert (f false)) line.
    const lines = query.split("\n");
    const bareRightAssertions = lines.filter(
      (line) => line.trim().startsWith("(assert") && line.includes("f false") && !line.includes("not"),
    );

    expect(bareRightAssertions).toEqual([]);
  });

  it("encodes implication as assert-left + negate-right", () => {
    traceSpec("FLA-CLUSTER-STABLE", "FLA-CLUSTER-QUERY");
    const left = makeClaim("L", ["(f true)"]);
    const right = makeClaim("R", ["(f false)"]);

    const query = clusteringBuildImplicationQuery(left, right);

    // Left assertions should be directly asserted
    expect(query).toContain("(assert (f true))");
    // Right assertions should appear only in negated form
    expect(query).toMatch(/\(assert\s+\(not/u);
  });
});

describe("implication query construction — cross-implication", () => {
  const leftSmt = [
    "; claim L",
    "(declare-sort X 0)",
    "(declare-fun f (Bool) Bool)",
    "(assert (f true))",
    "(check-sat)",
  ].join("\n");

  const rightSmt = [
    "; claim R",
    "(declare-sort X 0)",
    "(declare-fun g (Bool) Bool)",
    "(assert (g false))",
    "(check-sat)",
  ].join("\n");

  it("contains exactly one (check-sat) command", () => {
    traceSpec("STC-CROSS-IMPLY", "STC-IMPLY-QUERY");
    const query = crossBuildImplicationQuery(leftSmt, rightSmt);
    const checkSatCount = (query.match(/\(check-sat\)/gu) ?? []).length;

    expect(checkSatCount).toBe(1);
  });

  it("negates the consequent (right-side) assertions", () => {
    traceSpec("STC-CROSS-IMPLY", "STC-IMPLY-QUERY");
    const query = crossBuildImplicationQuery(leftSmt, rightSmt);

    // The right assertion should appear in negated form
    expect(query).toMatch(/\(assert\s+\(not/u);
  });

  it("preserves left-side assertions directly", () => {
    traceSpec("STC-CROSS-IMPLY", "STC-IMPLY-QUERY");
    const query = crossBuildImplicationQuery(leftSmt, rightSmt);

    // Left assertion should be present as-is
    expect(query).toContain("(assert (f true))");
  });
});
