import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import type { ParsedProposal, ParsedSpec } from "../../src/domain/model.js";

describe("claim graph properties", () => {
  it("every claim has provenance with a file, and no claim exists without a traceable source", async () => {
    traceSpec("CGC-NORMALIZE-CLAIMS");
    const headingArb = fc.constantFrom("Scope", "Capabilities", "Context", "Preconditions, Postconditions, and Invariants", "Failure Modes");
    const lineArb = fc.string({ minLength: 1, maxLength: 80 });
    const sectionArb = fc.tuple(headingArb, fc.array(lineArb, { minLength: 1, maxLength: 3 }));

    await fc.assert(
      fc.asyncProperty(fc.array(sectionArb, { minLength: 1, maxLength: 4 }), async (sections) => {
        const proposal: ParsedProposal = {
          file: "proposal.md",
          sections: new Map(
            sections.map(([heading, lines]) => [
              heading,
              { heading, lines, startLine: 1, endLine: lines.length + 1 },
            ]),
          ),
          unparsed: [],
        };

        const { graph } = buildClaimGraph({ proposal, specs: [] });

        for (const claim of graph.claims) {
          expect(claim.provenance).toBeDefined();
          expect(claim.provenance.file).toBeTruthy();
        }
      }),
      { numRuns: 20 },
    );
  });

  it("obligation assignment is consistent across EARS patterns", async () => {
    traceSpec("CGC-OBLIGATION-LEVEL", "CGC-OBLIG-MANDATORY", "CGC-OBLIG-ADVISORY", "CGC-OBLIG-INFO");
    const shallArb = fc.constantFrom(
      "WHEN x, THE system SHALL y.",
      "IF condition THEN THE system SHALL respond.",
      "WHILE active THE system SHALL monitor.",
    );
    const shouldArb = fc.constantFrom(
      "WHEN x, THE system SHOULD y.",
      "THE system SHOULD log events.",
    );
    const infoArb = fc.constantFrom(
      "The system provides metrics.",
      "Metrics are collected.",
    );

    await fc.assert(
      fc.asyncProperty(shallArb, shouldArb, infoArb, async (mandatory, advisory, informational) => {
        const spec: ParsedSpec = {
          file: "spec.md",
          requirements: [
            { title: "R1", identifier: "R1", body: mandatory, earsType: "event-driven", deltaOperation: "base", references: [], provenance: { file: "spec.md", line: 1 } },
            { title: "R2", identifier: "R2", body: advisory, earsType: "event-driven", deltaOperation: "base", references: [], provenance: { file: "spec.md", line: 2 } },
            { title: "R3", identifier: "R3", body: informational, earsType: "non-ears", deltaOperation: "base", references: [], provenance: { file: "spec.md", line: 3 } },
          ],
          scenarios: [],
          deltaSections: ["ADDED"],
          structuralFindings: [],
          unparsed: [],
        };

        const { graph } = buildClaimGraph({ specs: [spec] });
        const r1 = graph.claims.find((c) => c.id === "R1");
        const r2 = graph.claims.find((c) => c.id === "R2");
        const r3 = graph.claims.find((c) => c.id === "R3");

        expect(r1?.obligation).toBe("mandatory");
        expect(r2?.obligation).toBe("advisory");
        expect(r3?.obligation).toBe("informational");
      }),
      { numRuns: 10 },
    );
  });
});
