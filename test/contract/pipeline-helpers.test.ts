import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import type { FormalizationCandidate } from "../../src/domain/formal/formalize.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import type { MergedCapabilitySpec } from "../../src/domain/model.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import { groupRepresentativesBySpec, runClaimGraphPhase, sanitizeLogicalFileForArtifacts } from "../../src/cli/pipeline-helpers.js";

vi.mock("../../src/domain/claim-graph.js", () => ({
  buildClaimGraph: vi.fn(() => ({ graph: { claims: [] }, findings: [] })),
}));

vi.mock("../../src/domain/spec-forward/coverage.js", () => ({
  analyzeCoverage: vi.fn(() => []),
}));

function mergedCapability(capability: string, requirementCount: number): MergedCapabilitySpec {
  return {
    capability: toCapabilityName(capability),
    sourceFiles: [`specs/${capability}/spec.md`],
    logicalFile: `<merged-spec/${capability}>`,
    requirements: Array.from({ length: requirementCount }).map((_, index) => ({
      title: `Requirement ${String(index + 1)}`,
      identifier: `${capability.toUpperCase()}-REQ-${String(index + 1)}`,
      body: "WHEN input arrives, THE system SHALL process it.",
      earsType: "event-driven" as const,
      deltaOperation: "base" as const,
      references: [],
      provenance: { file: `specs/${capability}/spec.md`, line: index + 1 },
    })),
    scenarios: [],
    findings: [],
  };
}

function representative(id: string): LogicIrClaim {
  return {
    claimId: toClaimId(id),
    obligation: "mandatory",
    variables: [{ name: "S", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

describe("pipeline helper contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits every non-empty merged capability to claim extraction and coverage exactly once", async () => {
    traceSpec("CGC-GRAPH-DETERMINISM", "CGC-COVERAGE-DETERMINISM", "CGC-MERGED-COVERAGE", "CGC-COVERAGE-EMPTY");
    const mergedSpecs = [
      mergedCapability("cap-a", 1),
      mergedCapability("cap-b", 2),
      mergedCapability("cap-empty", 0),
    ];

    const result = runClaimGraphPhase({
      specs: [],
      mergedSpecs,
    });

    const { buildClaimGraph } = await import("../../src/domain/claim-graph.js");
    const { analyzeCoverage } = await import("../../src/domain/spec-forward/coverage.js");
    const claimGraphCall = vi.mocked(buildClaimGraph).mock.calls[0]?.[0];
    const coverageCall = vi.mocked(analyzeCoverage).mock.calls[0]?.[0];

    expect(vi.mocked(buildClaimGraph)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeCoverage)).toHaveBeenCalledTimes(1);
    expect(claimGraphCall?.mergedSpecs?.map((spec) => spec.capability)).toEqual(["cap-a", "cap-b"]);
    expect(coverageCall?.mergedSpecs?.map((spec) => spec.capability)).toEqual(["cap-a", "cap-b"]);
    expect(result.graph.claims).toEqual([]);
  });

  it("produces one logic group per non-empty merged capability with no omissions", () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-CLUSTER-STABLE", "FLA-GROUP-MERGED", "FLA-GROUP-ONE");
    const nonEmptyMergedSpecs = [
      mergedCapability("cap-a", 1),
      mergedCapability("cap-b", 1),
    ];

    const candidates: FormalizationCandidate[] = [
      {
        claim: {
          id: toClaimId("CAP-A-REQ-1"),
          kind: "requirement",
          text: "WHEN a, THE system SHALL process a.",
          obligation: "mandatory",
          provenance: { file: "specs/cap-a/spec.md", line: 1 },
          references: [],
          capability: toCapabilityName("cap-a"),
        },
        samples: [representative("CAP-A-REQ-1")],
        invalidSamples: [],
      },
      {
        claim: {
          id: toClaimId("CAP-B-REQ-1"),
          kind: "requirement",
          text: "WHEN b, THE system SHALL process b.",
          obligation: "mandatory",
          provenance: { file: "specs/cap-b/spec.md", line: 1 },
          references: [],
          capability: toCapabilityName("cap-b"),
        },
        samples: [representative("CAP-B-REQ-1")],
        invalidSamples: [],
      },
    ];

    const groups = groupRepresentativesBySpec(
      candidates,
      [representative("CAP-A-REQ-1"), representative("CAP-B-REQ-1")],
      nonEmptyMergedSpecs,
    );

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.specFile)).toEqual([
      "<merged-spec/cap-a>",
      "<merged-spec/cap-b>",
    ]);
  });

  it("groups by Claim.capability instead of provenance.file", () => {
    traceSpec("FLA-RUN-LOGIC", "CGC-NORMALIZE-CLAIMS", "FLA-GROUP-LOGICAL", "CGC-CLAIM-CAP");
    const mergedSpecs = [mergedCapability("cap-a", 1)];
    const candidates: FormalizationCandidate[] = [
      {
        claim: {
          id: toClaimId("CAP-A-REQ-1"),
          kind: "requirement",
          text: "WHEN shared capability exists, THE system SHALL group by capability.",
          obligation: "mandatory",
          provenance: { file: "specs/some-other-file/spec.md", line: 12 },
          references: [],
          capability: toCapabilityName("cap-a"),
        },
        samples: [representative("CAP-A-REQ-1")],
        invalidSamples: [],
      },
    ];

    const groups = groupRepresentativesBySpec(candidates, [representative("CAP-A-REQ-1")], mergedSpecs);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.specFile).toBe("<merged-spec/cap-a>");
  });

  it("fails on sanitized logicalFile collisions", () => {
    traceSpec("RAE-OUTPUT-CONFINE", "FLA-RUN-LOGIC", "FLA-GROUP-COLLISION");
    expect(sanitizeLogicalFileForArtifacts("<cap/a>")).toBe("cap-a");
    expect(sanitizeLogicalFileForArtifacts("cap-a")).toBe("cap-a");

    const mergedSpecs: MergedCapabilitySpec[] = [
      {
        ...mergedCapability("cap-a", 1),
        logicalFile: "<cap/a>",
      },
      {
        ...mergedCapability("cap-b", 1),
        logicalFile: "cap-a",
      },
    ];

    const candidates: FormalizationCandidate[] = [
      {
        claim: {
          id: toClaimId("CAP-A-REQ-1"),
          kind: "requirement",
          text: "WHEN a exists, THE system SHALL process a.",
          obligation: "mandatory",
          provenance: { file: "specs/cap-a/spec.md", line: 1 },
          references: [],
          capability: toCapabilityName("cap-a"),
        },
        samples: [representative("CAP-A-REQ-1")],
        invalidSamples: [],
      },
      {
        claim: {
          id: toClaimId("CAP-B-REQ-1"),
          kind: "requirement",
          text: "WHEN b exists, THE system SHALL process b.",
          obligation: "mandatory",
          provenance: { file: "specs/cap-b/spec.md", line: 1 },
          references: [],
          capability: toCapabilityName("cap-b"),
        },
        samples: [representative("CAP-B-REQ-1")],
        invalidSamples: [],
      },
    ];

    expect(() =>
      groupRepresentativesBySpec(
        candidates,
        [representative("CAP-A-REQ-1"), representative("CAP-B-REQ-1")],
        mergedSpecs,
      )
    ).toThrow(/duplicate sanitized logicalFile key/u);
  });

  it("excludes non-spec claims from capability-grouped logic path", () => {
    traceSpec("FLA-RUN-LOGIC", "CGC-NORMALIZE-CLAIMS");
    const mergedSpecs = [mergedCapability("cap-a", 1)];
    const candidates: FormalizationCandidate[] = [
      {
        claim: {
          id: toClaimId("CAP-A-REQ-1"),
          kind: "requirement",
          text: "WHEN spec claim exists, THE system SHALL include it.",
          obligation: "mandatory",
          provenance: { file: "specs/cap-a/spec.md", line: 1 },
          references: [],
          capability: toCapabilityName("cap-a"),
        },
        samples: [representative("CAP-A-REQ-1")],
        invalidSamples: [],
      },
      {
        claim: {
          kind: "proposal_property",
          text: "This is a proposal-only statement.",
          obligation: "informational",
          provenance: { file: "proposal.md", line: 1 },
          references: [],
        },
        samples: [representative("PROPOSAL-1")],
        invalidSamples: [],
      },
    ];

    const groups = groupRepresentativesBySpec(
      candidates,
      [representative("CAP-A-REQ-1"), representative("PROPOSAL-1")],
      mergedSpecs,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.specFile).toBe("<merged-spec/cap-a>");
    expect(groups[0]?.claims).toHaveLength(1);
  });
});
