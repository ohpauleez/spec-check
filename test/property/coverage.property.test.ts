import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { analyzeCoverage } from "../../src/domain/spec-forward/coverage.js";
import type { ParsedProposal, ParsedSpec } from "../../src/domain/model.js";

describe("coverage analysis properties", () => {
  it("same claim graph always produces the same coverage findings", async () => {
    traceSpec("CGC-COVERAGE-DETERMINISM", "CGC-COVDET-SAME");
    const reqBodyArb = fc.constantFrom(
      "WHEN x, THE system SHALL y.",
      "THE system SHALL NOT timeout.",
      "IF active, THEN THE system SHALL respond.",
    );

    await fc.assert(
      fc.asyncProperty(reqBodyArb, async (body) => {
        const proposal: ParsedProposal = {
          file: "proposal.md",
          sections: new Map([
            ["Scope", { heading: "Scope", lines: ["system processes events"], startLine: 1, endLine: 2 }],
          ]),
          unparsed: [],
        };
        const spec: ParsedSpec = {
          file: "spec.md",
          requirements: [
            { title: "R1", identifier: "R1", body, earsType: "event-driven", deltaOperation: "base", references: [], provenance: { file: "spec.md", line: 1 } },
          ],
          scenarios: [],
          deltaSections: ["ADDED"],
          structuralFindings: [],
          unparsed: [],
        };

        const graphA = buildClaimGraph({ proposal, specs: [spec] });
        const graphB = buildClaimGraph({ proposal, specs: [spec] });
        const findingsA = analyzeCoverage({ claimGraph: graphA.graph, proposal, specs: [spec] });
        const findingsB = analyzeCoverage({ claimGraph: graphB.graph, proposal, specs: [spec] });

        expect(findingsA).toEqual(findingsB);
      }),
      { numRuns: 20 },
    );
  });
});
