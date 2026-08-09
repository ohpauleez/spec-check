import { describe, expect, it } from "vitest";

import { toCapabilityName } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import {
  activeMergedSpecsForGrouping,
  buildLogicalFileByCapability,
  selectClaimLogicalFile,
  splitPhysicalBatches,
} from "../../src/domain/formal/grouping.js";
import type { MergedCapabilitySpec, ParsedRequirement, ParsedScenario } from "../../src/domain/model.js";
import { traceSpec } from "../support/spec-trace.js";

/** Build one valid requirement for grouping-map contract fixtures. */
function requirement(capability: string): ParsedRequirement {
  return {
    title: "Requirement",
    identifier: `${capability.toUpperCase()}-REQ-1`,
    body: "WHEN input arrives, THE system SHALL respond.",
    earsType: "event-driven",
    deltaOperation: "base",
    references: [],
    provenance: { file: `specs/${capability}/spec.md`, line: 1 },
  };
}

/** Build one valid scenario for the defensive scenario-only fixture. */
function scenario(capability: string): ParsedScenario {
  return {
    title: "Scenario",
    identifier: `${capability.toUpperCase()}-SCEN-1`,
    body: "Given input, when it arrives, then the system responds.",
    deltaOperation: "base",
    provenance: { file: `specs/${capability}/spec.md`, line: 2 },
  };
}

/** Build a merged spec with explicitly controlled claim activity. */
function mergedSpec(
  capability: string,
  logicalFile: string,
  requirements: readonly ParsedRequirement[] = [],
  scenarios: readonly ParsedScenario[] = [],
): MergedCapabilitySpec {
  return {
    capability: toCapabilityName(capability),
    sourceFiles: [`specs/${capability}/spec.md`],
    logicalFile,
    requirements,
    scenarios,
    findings: [],
  };
}

describe("semantic grouping contracts", () => {
  it("selects requirement and defensive scenario-only specs in input order", () => {
    traceSpec("MCA-ACTIVE-REQ", "MCA-ACTIVE-SCEN", "MCA-ACTIVE-EMPTY");
    const requirementSpec = mergedSpec("auth", "merged/auth.md", [requirement("auth")]);
    const scenarioSpec = mergedSpec("reporting", "merged/reporting.md", [], [scenario("reporting")]);
    const emptySpec = mergedSpec("empty", "merged/empty.md");

    expect(activeMergedSpecsForGrouping([requirementSpec, scenarioSpec, emptySpec])).toEqual([
      requirementSpec,
      scenarioSpec,
    ]);
  });

  it("maps every supplied capability without normalizing logical files", () => {
    traceSpec("MCA-GROUP-KEY", "MCA-GROUP-KEY-COMPLETE", "MCA-GROUP-KEY-SCEN");
    const specs = [
      mergedSpec("auth", "opaque/../auth\\spec.md", [requirement("auth")]),
      mergedSpec("reporting", "merged/reporting.md", [], [scenario("reporting")]),
    ];

    const result = buildLogicalFileByCapability(specs);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect([...result.value.entries()]).toEqual([
      ["auth", "opaque/../auth\\spec.md"],
      ["reporting", "merged/reporting.md"],
    ]);
  });

  it("returns every empty logical-file value as validation data", () => {
    traceSpec("MCA-GROUP-KEY-EMPTY");
    const result = buildLogicalFileByCapability([
      mergedSpec("auth", "", [requirement("auth")]),
      mergedSpec("reporting", "", [], [scenario("reporting")]),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toEqual([
      {
        kind: "empty_logical_file",
        capability: "auth",
        message: "logicalFile must be non-empty for capability auth",
      },
      {
        kind: "empty_logical_file",
        capability: "reporting",
        message: "logicalFile must be non-empty for capability reporting",
      },
    ]);
  });

  it("selects mapped, provenance, and synthetic fallback keys exactly", () => {
    traceSpec("FLA-SEMGRP-MAPPED", "FLA-SEMGRP-PROVENANCE", "FLA-SEMGRP-FALLBACK", "FLA-SEMGRP-COVERAGE");
    const mapped: Pick<Claim, "capability" | "provenance"> = {
      capability: toCapabilityName("auth"),
      provenance: { file: "base/auth.md" },
    };
    const capabilityLess: Pick<Claim, "capability" | "provenance"> = {
      provenance: { file: "opaque/../source\\spec.md" },
    };
    const unmapped: Pick<Claim, "capability" | "provenance"> = {
      capability: toCapabilityName("reporting"),
      provenance: { file: "base/reporting.md" },
    };
    const map = new Map<string, string>([["auth", "merged/auth.md"]]);

    expect(selectClaimLogicalFile(mapped, map)).toBe("merged/auth.md");
    expect(selectClaimLogicalFile(capabilityLess, map)).toBe("opaque/../source\\spec.md");
    expect(selectClaimLogicalFile(unmapped, map)).toBe("<merged-spec/reporting>");
    expect(selectClaimLogicalFile(unmapped, new Map())).toBe("<merged-spec/reporting>");
  });
});

describe("physical batching contracts", () => {
  it("stably slices twelve claims into batches of five without changing the key", () => {
    traceSpec("FLA-SUBBATCH", "FLA-SUBBATCH-CHUNKS");
    const claims = Array.from({ length: 12 }, (_, index) => index);
    const batches = splitPhysicalBatches({ logicalFile: "merged/auth.md", claims }, 5);

    expect(batches.map((batch) => batch.claims.length)).toEqual([5, 5, 2]);
    expect(batches.map((batch) => batch.ordinal)).toEqual([0, 1, 2]);
    expect(batches.flatMap((batch) => batch.claims)).toEqual(claims);
    expect(batches.every((batch) => batch.logicalFile === "merged/auth.md")).toBe(true);
  });

  it("treats zero as unbounded, one as single-claim, and empty input as empty", () => {
    traceSpec("FLA-SUBBATCH-ZERO", "FLA-SUBBATCH-ONE");
    const group = { logicalFile: "merged/auth.md", claims: [0, 1, 2, 3] };

    const unbounded = splitPhysicalBatches(group, 0);
    expect(unbounded).toHaveLength(1);
    expect(unbounded[0]?.claims).toBe(group.claims);
    expect(splitPhysicalBatches(group, 1).map((batch) => batch.claims)).toEqual([[0], [1], [2], [3]]);
    expect(splitPhysicalBatches({ logicalFile: "merged/empty.md", claims: [] }, 0)).toEqual([]);
  });

  it("rejects invalid direct-call batch bounds instead of risking non-termination", () => {
    const group = { logicalFile: "merged/auth.md", claims: [0] };

    expect(() => splitPhysicalBatches(group, -1)).toThrow(/greater than or equal to zero/u);
    expect(() => splitPhysicalBatches(group, 1.5)).toThrow(/safe integer/u);
    expect(() => splitPhysicalBatches(group, Number.POSITIVE_INFINITY)).toThrow(/safe integer/u);
  });
});
