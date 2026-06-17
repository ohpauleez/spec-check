import { describe, expect, it } from "vitest";

import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { traceSpec } from "../support/spec-trace.js";

describe("claim graph contracts", () => {
  it("assigns obligation levels and keeps provenance", () => {
    traceSpec("CGC-NORMALIZE-CLAIMS", "CGC-CLAIM-PROVEN", "CGC-OBLIGATION-LEVEL", "CGC-OBLIG-MANDATORY", "CGC-OBLIG-ADVISORY");
    const graph = buildClaimGraph({
      specs: [
        {
          file: "spec.md",
          requirements: [
            {
              title: "Mandatory",
              identifier: "REQ-MANDATORY",
              body: "WHEN event arrives, THE system SHALL process it.",
              earsType: "event-driven",
              references: ["proposal.md#Scope"],
              provenance: { file: "spec.md", line: 10 },
            },
            {
              title: "Advisory",
              identifier: "REQ-ADVISORY",
              body: "WHEN event arrives, THE system SHOULD log it.",
              earsType: "event-driven",
              references: ["proposal.md#Scope"],
              provenance: { file: "spec.md", line: 15 },
            },
          ],
          scenarios: [],
          deltaSections: ["ADDED"],
          structuralFindings: [],
          unparsed: [],
        },
      ],
    });

    const mandatory = graph.graph.claims.find((claim) => claim.id === "REQ-MANDATORY");
    const advisory = graph.graph.claims.find((claim) => claim.id === "REQ-ADVISORY");

    expect(mandatory?.obligation).toBe("mandatory");
    expect(advisory?.obligation).toBe("advisory");
    expect(mandatory?.provenance.file).toBe("spec.md");
    expect(graph.findings).toHaveLength(0);
  });

  it("surfaces orphaned claim without provenance", () => {
    traceSpec("CGC-CLAIM-FAIL");
    const graph = buildClaimGraph({
      specs: [
        {
          file: "",
          requirements: [
            {
              title: "Orphaned",
              identifier: "REQ-ORPHAN",
              body: "SHALL do something",
              earsType: "event-driven",
              references: [],
              provenance: { file: "", line: 1 },
            },
          ],
          scenarios: [],
          deltaSections: ["ADDED"],
          structuralFindings: [],
          unparsed: [],
        },
      ],
    });
    expect(graph.findings.some((f) => f.category === "claim_graph.orphaned_claim")).toBe(true);
  });

  it("classifies informational content at informational obligation", () => {
    traceSpec("CGC-OBLIG-INFO");
    const graph = buildClaimGraph({
      proposal: {
        file: "proposal.md",
        sections: new Map([
          ["Scope", { heading: "Scope", lines: ["analysis covers formal methods"], startLine: 1, endLine: 2 }],
        ]),
        unparsed: [],
      },
      specs: [],
    });
    const scopeClaim = graph.graph.claims.find((c) => c.kind === "proposal_property");
    expect(scopeClaim?.obligation).toBe("informational");
  });
});
