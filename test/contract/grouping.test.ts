import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  activeMergedSpecsForGrouping,
  buildLogicalFileByCapability,
  groupBySemanticKey,
  selectClaimLogicalFile,
  splitPhysicalBatches,
  validateFormalizationControls,
} from "../../src/domain/formal/grouping.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import type { MergedCapabilitySpec } from "../../src/domain/model.js";
import type { Claim } from "../../src/domain/claim-graph.js";

function mergedSpec(
  capability: string,
  logicalFile: string,
  requirementCount: number,
  scenarioCount: number,
): MergedCapabilitySpec {
  return {
    capability: toCapabilityName(capability),
    sourceFiles: [`specs/${capability}/spec.md`],
    logicalFile,
    requirements: Array.from({ length: requirementCount }).map((_, index) => ({
      title: `R${String(index + 1)}`,
      identifier: `${capability.toUpperCase()}-REQ-${String(index + 1)}`,
      body: "WHEN input arrives, THE system SHALL process it.",
      earsType: "event-driven" as const,
      deltaOperation: "base" as const,
      references: [],
      provenance: { file: `specs/${capability}/spec.md`, line: index + 1 },
    })),
    scenarios: Array.from({ length: scenarioCount }).map((_, index) => ({
      title: `S${String(index + 1)}`,
      identifier: `${capability.toUpperCase()}-SCE-${String(index + 1)}`,
      body: "GIVEN a, WHEN b, THEN c.",
      deltaOperation: "base" as const,
      provenance: { file: `specs/${capability}/spec.md`, line: index + 1 },
    })),
    findings: [],
  };
}

function makeClaim(overrides?: Partial<Claim>): Claim {
  return {
    kind: "requirement",
    text: "WHEN x, THE system SHALL y.",
    obligation: "mandatory",
    provenance: { file: "spec.md", heading: "R1" },
    references: [],
    id: toClaimId("R1"),
    ...overrides,
  };
}

describe("semantic grouping contracts", () => {
  it("selectClaimLogicalFile maps capability to logical file", () => {
    traceSpec("FLA-SEMGRP-MAPPED");
    const map = new Map<string, string>([["auth", "specs/auth.md"]]);
    const claim = makeClaim({ capability: toCapabilityName("auth"), provenance: { file: "other.md" } });
    expect(selectClaimLogicalFile(claim, map)).toBe("specs/auth.md");
  });

  it("selectClaimLogicalFile falls back to provenance file for capability-less claims", () => {
    traceSpec("FLA-SEMGRP-PROVENANCE");
    const claim = makeClaim({ provenance: { file: "legacy/spec.md" } });
    expect(selectClaimLogicalFile(claim, new Map())).toBe("legacy/spec.md");
  });

  it("selectClaimLogicalFile uses synthetic fallback for unmapped capability", () => {
    traceSpec("FLA-SEMGRP-FALLBACK", "FLA-SEMGRP-COVERAGE");
    const claim = makeClaim({ capability: toCapabilityName("unmapped"), provenance: { file: "spec.md" } });
    expect(selectClaimLogicalFile(claim, new Map())).toBe("<merged-spec/unmapped>");
  });

  it("empty map still uses synthetic fallback for capability-bearing claims", () => {
    traceSpec("FLA-SEMGRP-FALLBACK");
    const claim = makeClaim({ capability: toCapabilityName("auth") });
    expect(selectClaimLogicalFile(claim, new Map())).toBe("<merged-spec/auth>");
  });

  it("groupBySemanticKey preserves eligible order and first-key occurrence", () => {
    traceSpec("FLA-SEMGRP-ORDER");
    const claims: Claim[] = [
      makeClaim({ id: toClaimId("A1"), capability: toCapabilityName("cap-a"), provenance: { file: "base.md" } }),
      makeClaim({ id: toClaimId("B1"), capability: toCapabilityName("cap-b"), provenance: { file: "base.md" } }),
      makeClaim({ id: toClaimId("A2"), capability: toCapabilityName("cap-a"), provenance: { file: "delta.md" } }),
    ];
    const map = new Map<string, string>([
      ["cap-a", "specs/cap-a.md"],
      ["cap-b", "specs/cap-b.md"],
    ]);
    const groups = groupBySemanticKey(
      claims.map((claim) => ({ claim, eligibleIndex: 0 })),
      (item) => item.claim,
      map,
    );
    expect(groups.map((g) => g.key)).toEqual(["specs/cap-a.md", "specs/cap-b.md"]);
    expect(groups[0]!.items.map((item) => item.claim.id)).toEqual(["A1", "A2"]);
  });

  it("requirements and scenarios co-group by semantic key", () => {
    traceSpec("FLA-SEMGRP-KINDS");
    const claims: Claim[] = [
      makeClaim({ id: toClaimId("R1"), kind: "requirement", capability: toCapabilityName("auth") }),
      makeClaim({ id: toClaimId("S1"), kind: "scenario", capability: toCapabilityName("auth") }),
    ];
    const map = new Map<string, string>([["auth", "specs/auth.md"]]);
    const groups = groupBySemanticKey(
      claims.map((claim) => ({ claim, eligibleIndex: 0 })),
      (item) => item.claim,
      map,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("activeMergedSpecsForGrouping includes requirement-bearing specs", () => {
    traceSpec("MCA-ACTIVE-REQ");
    const specs = [mergedSpec("active", "specs/active.md", 1, 0), mergedSpec("inactive", "specs/inactive.md", 0, 0)];
    const active = activeMergedSpecsForGrouping(specs);
    expect(active.map((s) => s.capability)).toEqual(["active"]);
  });

  it("activeMergedSpecsForGrouping defensively includes scenario-only specs", () => {
    traceSpec("MCA-ACTIVE-SCEN", "MCA-GROUP-KEY-SCEN");
    const specs = [mergedSpec("scenario-only", "specs/scenario-only.md", 0, 1)];
    const active = activeMergedSpecsForGrouping(specs);
    expect(active).toHaveLength(1);
  });

  it("buildLogicalFileByCapability maps every provided capability", () => {
    traceSpec("MCA-GROUP-KEY-COMPLETE");
    const specs = [
      mergedSpec("cap-a", "specs/cap-a.md", 1, 0),
      mergedSpec("cap-b", "specs/cap-b.md", 1, 0),
    ];
    const result = buildLogicalFileByCapability(specs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.get("cap-a")).toBe("specs/cap-a.md");
    expect(result.value.get("cap-b")).toBe("specs/cap-b.md");
  });

  it("buildLogicalFileByCapability rejects empty logical files", () => {
    traceSpec("MCA-GROUP-KEY-EMPTY");
    const specs = [mergedSpec("bad", "", 1, 0)];
    const result = buildLogicalFileByCapability(specs);
    expect(result.ok).toBe(false);
  });

  it("splitPhysicalBatches is unbounded when maxBatchSize is 0", () => {
    traceSpec("FLA-SUBBATCH-ZERO");
    const items = Array.from({ length: 10 }).map((_, i) => i);
    const chunks = splitPhysicalBatches(items, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!).toHaveLength(10);
  });

  it("splitPhysicalBatches yields single-claim chunks when maxBatchSize is 1", () => {
    traceSpec("FLA-SUBBATCH-ONE");
    const items = [1, 2, 3];
    const chunks = splitPhysicalBatches(items, 1);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.length)).toEqual([1, 1, 1]);
  });

  it("preserves order and key for claims with missing or duplicate IDs", () => {
    traceSpec("FLA-IDENTITY-DUP", "FLA-IDENTITY-MISSING");
    const map = new Map<string, string>([["auth", "<merged-spec/auth>"]]);
    const withMissingId: Claim = {
      kind: "requirement",
      text: "missing",
      obligation: "mandatory",
      provenance: { file: "spec.md" },
      references: [],
      capability: toCapabilityName("auth"),
    };
    const claims = [
      makeClaim({ id: toClaimId("DUP"), capability: toCapabilityName("auth"), text: "first" }),
      makeClaim({ id: toClaimId("DUP"), capability: toCapabilityName("auth"), text: "second" }),
      withMissingId,
    ];
    const indexed = claims.map((c, i) => ({ claim: c, eligibleIndex: i }));
    const groups = groupBySemanticKey(indexed, (item) => item.claim, map);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((item) => item.eligibleIndex)).toEqual([0, 1, 2]);
    expect(groups[0]!.items.map((item) => item.claim.id ?? null)).toEqual(["DUP", "DUP", null]);
  });

  it("splitPhysicalBatches produces [5,5,2] for 12 claims and size 5", () => {
    traceSpec("FLA-SUBBATCH-CHUNKS");
    const items = Array.from({ length: 12 }).map((_, i) => i);
    const chunks = splitPhysicalBatches(items, 5);
    expect(chunks.map((c) => c.length)).toEqual([5, 5, 2]);
  });

  it("validateFormalizationControls rejects invalid control values", () => {
    traceSpec("FLA-SUBBATCH-INVALID");
    expect(validateFormalizationControls({ maxBatchSize: -1, samplesPerClaim: 1, concurrency: undefined }).ok).toBe(false);
    expect(validateFormalizationControls({ maxBatchSize: 0, samplesPerClaim: 0, concurrency: undefined }).ok).toBe(false);
    expect(validateFormalizationControls({ maxBatchSize: 0, samplesPerClaim: 1, concurrency: 0 }).ok).toBe(false);
    expect(validateFormalizationControls({ maxBatchSize: Number.NaN, samplesPerClaim: 1, concurrency: undefined }).ok).toBe(false);
  });

  it("validateFormalizationControls accepts valid defaults", () => {
    const result = validateFormalizationControls({ maxBatchSize: undefined, samplesPerClaim: 1, concurrency: undefined });
    expect(result.ok).toBe(true);
  });
});
