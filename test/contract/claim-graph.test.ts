import { describe, expect, it } from "vitest";

import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { traceSpec } from "../support/spec-trace.js";
import { toCapabilityName } from "../../src/domain/branded.js";

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
              deltaOperation: "base",
              references: ["proposal.md#Scope"],
              provenance: { file: "spec.md", line: 10 },
            },
            {
              title: "Advisory",
              identifier: "REQ-ADVISORY",
              body: "WHEN event arrives, THE system SHOULD log it.",
              earsType: "event-driven",
              deltaOperation: "base",
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
              deltaOperation: "base",
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

  it("classifies MAY requirement as informational obligation", () => {
    traceSpec("CGC-OBLIG-OPTIONAL");
    const graph = buildClaimGraph({
      specs: [
        {
          file: "spec.md",
          requirements: [
            {
              title: "Optional",
              identifier: "REQ-OPTIONAL",
              body: "WHEN output is rendered, THE system MAY include color formatting.",
              earsType: "event-driven",
              deltaOperation: "base",
              references: [],
              provenance: { file: "spec.md", line: 20 },
            },
          ],
          scenarios: [],
          deltaSections: ["ADDED"],
          structuralFindings: [],
          unparsed: [],
        },
      ],
    });

    const optional = graph.graph.claims.find((claim) => claim.id === "REQ-OPTIONAL");
    expect(optional?.obligation).toBe("informational");
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

  it("populates Claim.capability for merged spec-derived claims", () => {
    const graph = buildClaimGraph({
      specs: [],
      mergedSpecs: [
        {
          capability: toCapabilityName("claim-graph-and-coverage"),
          sourceFiles: ["specs/claim-graph-and-coverage/spec.md"],
          logicalFile: "<merged-spec/claim-graph-and-coverage>",
          requirements: [
            {
              title: "Merged req",
              identifier: "CGC-MERGED-REQ",
              body: "WHEN merged input exists, THE system SHALL assign capability.",
              earsType: "event-driven",
              deltaOperation: "base",
              references: [],
              provenance: { file: "specs/claim-graph-and-coverage/spec.md", line: 1 },
            },
          ],
          scenarios: [],
          findings: [],
        },
      ],
    });

    const requirementClaim = graph.graph.claims.find((claim) => claim.id === "CGC-MERGED-REQ");
    expect(requirementClaim?.capability).toBe("claim-graph-and-coverage");
  });

  it("warns when a raw spec is not covered by any merged capability", () => {
    const graph = buildClaimGraph({
      specs: [
        {
          file: "specs/uncovered/spec.md",
          requirements: [
            {
              title: "Uncovered",
              identifier: "REQ-UNCOVERED",
              body: "WHEN uncovered, THE system SHALL warn.",
              earsType: "event-driven",
              deltaOperation: "base",
              references: [],
              provenance: { file: "specs/uncovered/spec.md", line: 1 },
            },
          ],
          scenarios: [],
          deltaSections: [],
          structuralFindings: [],
          unparsed: [],
        },
      ],
      mergedSpecs: [
        {
          capability: toCapabilityName("other-cap"),
          sourceFiles: ["specs/other-cap/spec.md"],
          logicalFile: "<merged-spec/other-cap>",
          requirements: [
            {
              title: "Covered",
              identifier: "REQ-COVERED",
              body: "WHEN covered, THE system SHALL proceed.",
              earsType: "event-driven",
              deltaOperation: "base",
              references: [],
              provenance: { file: "specs/other-cap/spec.md", line: 1 },
            },
          ],
          scenarios: [],
          findings: [],
        },
      ],
    });

    // The uncovered spec file is not in any mergedSpec.sourceFiles
    expect(graph.findings.some((f) => f.category === "claim_graph.unmerged_spec_ignored")).toBe(true);
    const warning = graph.findings.find((f) => f.category === "claim_graph.unmerged_spec_ignored")!;
    expect(warning.severity).toBe("warning");
    expect(warning.provenance.file).toBe("specs/uncovered/spec.md");
  });

  it("does not warn when all raw specs are covered by merged capabilities", () => {
    const graph = buildClaimGraph({
      specs: [
        {
          file: "specs/covered/spec.md",
          requirements: [
            {
              title: "Covered",
              identifier: "REQ-COVERED-2",
              body: "WHEN covered, THE system SHALL proceed.",
              earsType: "event-driven",
              deltaOperation: "base",
              references: [],
              provenance: { file: "specs/covered/spec.md", line: 1 },
            },
          ],
          scenarios: [],
          deltaSections: [],
          structuralFindings: [],
          unparsed: [],
        },
      ],
      mergedSpecs: [
        {
          capability: toCapabilityName("covered-cap"),
          sourceFiles: ["specs/covered/spec.md"],
          logicalFile: "<merged-spec/covered-cap>",
          requirements: [
            {
              title: "Merged",
              identifier: "REQ-COVERED-2",
              body: "WHEN covered, THE system SHALL proceed.",
              earsType: "event-driven",
              deltaOperation: "base",
              references: [],
              provenance: { file: "specs/covered/spec.md", line: 1 },
            },
          ],
          scenarios: [],
          findings: [],
        },
      ],
    });

    expect(graph.findings.some((f) => f.category === "claim_graph.unmerged_spec_ignored")).toBe(false);
  });
});
