import { describe, expect, it } from "vitest";
import { parseSpecText } from "../../src/domain/parser/spec.js";
import { mergeSpecsByCapability } from "../../src/domain/parser/merge.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { groupFormalizationClaims } from "../../src/domain/formal/grouping.js";
import { toCapabilityName } from "../../src/domain/branded.js";
import { traceSpec } from "../support/spec-trace.js";

/** Minimal authored fixture with separate reference metadata. */
function requirement(id: string, text: string): string {
  return `### Requirement: ${id} [${id}]\n${text}\n\n**References:**\n- proposal.md#Scope\n`;
}

describe("source structure survives merge and claim admission", () => {
  it("modified payload replaces the original without rewriting provenance", () => {
    traceSpec("MCA-MERGE-SOURCE", "MCA-MERGE-ORDER", "MCA-CONCEPT-REMOVED", "MCA-MERGE-GROUP-KEY");
    const base = parseSpecText("base.md", requirement("SURFACE-REQ", "WHEN old, THE engine SHALL respond."));
    const delta = parseSpecText("delta.md", "## MODIFIED Requirements\n" + requirement("SURFACE-REQ", "WHEN new, THE engine MUST respond."), "delta");
    const capability = toCapabilityName("surface");
    const merged = mergeSpecsByCapability([
      { path: "base.md", type: "spec", source: "final", capability },
      { path: "delta.md", type: "spec", source: "delta", capability },
    ], [base, delta])[0]!;
    expect(merged.requirements).toHaveLength(1);
    expect(merged.requirements[0]?.surface).toBe(delta.requirements[0]?.surface);
    expect(merged.requirements[0]?.surface?.clauses?.trigger?.text).toBe("new");
    expect(merged.requirements[0]?.surface?.span.file).toBe("delta.md");
    const graph = buildClaimGraph({ specs: [base, delta], mergedSpecs: [merged] }).graph;
    expect(graph.claims[0]?.surface).toBe(delta.requirements[0]?.surface);
    expect(graph.claims[0]?.capability).toBe(capability);
    expect(graph.claims[0]?.obligation).toBe("mandatory");
  });

  it("retains excluded source claims but assigns indexes after admission", () => {
    traceSpec("CGC-FORMAL-SCOPE", "CGC-SCOPE-EXCLUDED", "CGC-SCOPE-PARTITION", "CGC-SCOPE-IDENTITY", "CGC-CLAIM-CLAUSES");
    const parsed = parseSpecText("spec.md", [
      requirement("SURFACE-REQ", "Not EARS."),
      requirement("SURFACE-REQ", "THE engine SHOULD respond."),
      requirement("SURFACE-OTHER", "THE engine MAY stop."),
    ].join("\n"));
    const claims = buildClaimGraph({ specs: [parsed] }).graph.claims;
    expect(claims).toHaveLength(3);
    expect(claims[0]?.surface?.disposition.kind).toBe("excluded");
    expect(claims.map((claim) => claim.surface?.source.ordinal)).toEqual([0, 1, 2]);
    const groups = groupFormalizationClaims(claims, new Map());
    expect(groups.flatMap((group) => group.claims.map((item) => item.index))).toEqual([0, 1]);
    expect(groups[0]?.claims[0]?.claim).toBe(claims[1]);
    expect(claims.map((claim) => claim.obligation)).toEqual(["informational", "advisory", "informational"]);
  });

  it("derives MUST and scoped modal negation from parser-owned slots", () => {
    traceSpec("CGC-OBLIG-MANDATORY", "CGC-OBLIG-ADVISORY", "CGC-OBLIG-OPTIONAL", "CGC-OBLIG-INFO");
    const parsed = parseSpecText("spec.md", [
      requirement("SURFACE-MUST", "THE engine MUST NOT stop."),
      requirement("SURFACE-SHOULD", "THE engine SHOULD respond."),
      requirement("SURFACE-MAY", "THE engine MAY stop."),
      requirement("SURFACE-PROSE", 'A note about "SHALL".'),
    ].join("\n"));
    const claims = buildClaimGraph({ specs: [parsed] }).graph.claims;
    expect(claims.map((claim) => claim.obligation)).toEqual(["mandatory", "advisory", "informational", "informational"]);
    expect(claims[0]?.surface?.clauses?.negatedResponse).toBe(true);
  });

  it("ineligible content remains selected but removed blocks do not", () => {
    traceSpec("MCA-CONCEPT-INELIGIBLE", "MCA-CONCEPT-ACTIVE", "MCA-MERGE-PROVEN");
    const base = parseSpecText("base.md", requirement("SURFACE-REQ", "Unsupported prose."));
    const delta = parseSpecText("delta.md", "## REMOVED Requirements\n### Requirement: Remove [SURFACE-REQ]\n**Reason:** obsolete\n", "delta");
    const capability = toCapabilityName("surface");
    const documents = [{ path: "base.md", type: "spec" as const, source: "final" as const, capability }];
    expect(mergeSpecsByCapability(documents, [base])[0]?.requirements).toHaveLength(1);
    expect(mergeSpecsByCapability([...documents, { path: "delta.md", type: "spec", source: "delta", capability }], [base, delta])[0]?.requirements).toHaveLength(0);
  });
});
