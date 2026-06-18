import { describe, expect, it } from "vitest";
import { traceSpec } from "../support/spec-trace.js";
import { analyzeCoverage } from "../../src/domain/spec-forward/coverage.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import type { ParsedProposal, ParsedSpec } from "../../src/domain/model.js";

const makeProposal = (capabilities: string[]): ParsedProposal => ({
  file: "proposal.md",
  sections: new Map([
    ["Capabilities", { heading: "Capabilities", lines: capabilities.map((c) => `- ${c}`), startLine: 1, endLine: 5 }],
    ["Scope", { heading: "Scope", lines: ["deterministic analysis"], startLine: 10, endLine: 11 }],
  ]),
  unparsed: [],
});

const makeSpec = (capability: string, requirements: { title: string; id: string; body: string; refs: string[] }[]): ParsedSpec => ({
  file: `specs/${capability}/spec.md`,
  requirements: requirements.map((r, i) => ({
    title: r.title,
    identifier: r.id,
    body: r.body,
    earsType: "event-driven" as const,
    references: r.refs,
    provenance: { file: `specs/${capability}/spec.md`, line: i * 5 + 3 },
  })),
  scenarios: [],
  deltaSections: ["ADDED"],
  structuralFindings: [],
  unparsed: [],
});

describe("coverage analysis contracts", () => {
  it("detects missing spec files for declared capabilities", () => {
    traceSpec("CGC-FIND-MISSING", "CGC-REF-MISSFILE");
    const proposal = makeProposal(["existing-cap", "missing-cap"]);
    const spec = makeSpec("existing-cap", [
      { title: "R1", id: "R1", body: "WHEN x, THE system SHALL y.", refs: ["proposal.md#Scope"] },
    ]);
    const graph = buildClaimGraph({ proposal, specs: [spec] });
    const findings = analyzeCoverage({ claimGraph: graph.graph, proposal, specs: [spec] });
    expect(findings.some((f) => f.category === "coverage.missing_spec_file")).toBe(true);
  });

  it("detects uncovered upstream claims", () => {
    traceSpec("CGC-COVER-MISS");
    const proposal = makeProposal(["cap"]);
    const graph = buildClaimGraph({ proposal, specs: [] });
    const findings = analyzeCoverage({ claimGraph: graph.graph, proposal, specs: [] });
    expect(findings.some((f) => f.category === "coverage.uncovered_upstream_claim")).toBe(true);
  });

  it("detects contradictions between upstream and downstream", () => {
    traceSpec("CGC-COVER-CONFLICT");
    const proposal: ParsedProposal = {
      file: "proposal.md",
      sections: new Map([
        ["Scope", { heading: "Scope", lines: ["the system should never timeout during analysis"], startLine: 1, endLine: 2 }],
      ]),
      unparsed: [],
    };
    const spec = makeSpec("cap", [
      { title: "R1", id: "R1", body: "WHEN analysis runs, THE system SHALL timeout after 30 seconds.", refs: [] },
    ]);
    const graph = buildClaimGraph({ proposal, specs: [spec] });
    const findings = analyzeCoverage({ claimGraph: graph.graph, proposal, specs: [spec] });
    expect(findings.some((f) => f.category === "coverage.contradiction")).toBe(true);
  });

  it("detects unsupported requirement references", () => {
    traceSpec("CGC-VALIDATE-REFS", "CGC-REF-BADLINK");
    const spec = makeSpec("cap", [
      { title: "R1", id: "R1", body: "WHEN x, THE system SHALL y.", refs: ["nonexistent.md#Section"] },
    ]);
    const graph = buildClaimGraph({ specs: [spec] });
    const findings = analyzeCoverage({ claimGraph: graph.graph, specs: [spec] });
    expect(findings.some((f) => f.category === "coverage.unsupported_reference")).toBe(true);
  });

  it("accepts archived change references as valid provenance", () => {
    traceSpec("CGC-VALIDATE-REFS");
    const spec = makeSpec("cap", [
      { title: "R1", id: "R1", body: "WHEN x, THE system SHALL y.", refs: ["openspec/changes/archive/2026-01-01-feature/proposal.md#Scope"] },
    ]);
    const graph = buildClaimGraph({ specs: [spec] });
    const findings = analyzeCoverage({ claimGraph: graph.graph, specs: [spec] });
    expect(findings.some((f) => f.category === "coverage.unsupported_reference")).toBe(false);
  });

  it("detects semantic drift for failure modes", () => {
    traceSpec("CGC-COVER-DRIFT");
    const proposal: ParsedProposal = {
      file: "proposal.md",
      sections: new Map([
        ["Failure Modes", { heading: "Failure Modes", lines: ["analysis timeout causes abort"], startLine: 1, endLine: 2 }],
      ]),
      unparsed: [],
    };
    const spec = makeSpec("cap", [
      { title: "R1", id: "R1", body: "WHEN analysis completes, THE system SHALL report.", refs: [] },
    ]);
    const graph = buildClaimGraph({ proposal, specs: [spec] });
    const findings = analyzeCoverage({ claimGraph: graph.graph, proposal, specs: [spec] });
    expect(findings.some((f) => f.category === "coverage.semantic_drift")).toBe(true);
  });
});
