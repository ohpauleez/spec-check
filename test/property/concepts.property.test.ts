import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpecText } from "../../src/domain/parser/spec.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { freezeRegistry, type AuthoredModel } from "../../src/domain/formal/concepts.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import { traceSpec } from "../support/spec-trace.js";

const authored: AuthoredModel = { concepts: [], enums: [], units: [], background: [], coverage: [] };

describe("concept reconciliation determinism and isolation", () => {
  it("physical completion permutations do not change registry bytes or IDs", () => {
    traceSpec("FLA-CONCEPT-ORDER", "FLA-CONCEPT-SHARED");
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 1, maxLength: 20 }), (priorities) => {
      const raw = priorities.map((_, index) => `### Requirement: ${index} [CONCEPT-R-${index}]\nWHEN request arrives, THE engine SHALL respond.\n`).join("\n");
      const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", raw)] }).graph.claims;
      const proposals = priorities.map((priority, index) => ({ priority, value: {
        name: `Concept${index}`, definition: "Response emitted", role: "output", sort: "Bool", source: { file: "spec.md", ordinal: index }, term: "respond",
      } }));
      const first = freezeRegistry("group", "specs_forward", claims, authored, proposals.map((entry) => entry.value), [], ANALYSIS_LIMITS);
      const reordered = freezeRegistry("group", "specs_forward", claims, authored, [...proposals].sort((a, b) => a.priority - b.priority).map((entry) => entry.value), [], ANALYSIS_LIMITS);
      expect(reordered).toEqual(first);
      expect(first.concepts).toHaveLength(priorities.length);
      expect(freezeRegistry("group", "generated_spec", claims, authored, proposals.map((entry) => entry.value), [], ANALYSIS_LIMITS).hash).not.toBe(first.hash);
    }), { numRuns: 30 });
  });
});
