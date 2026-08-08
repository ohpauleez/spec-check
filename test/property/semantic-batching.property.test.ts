import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import {
  groupFormalizationClaims,
  selectClaimLogicalFile,
  splitPhysicalBatches,
  type SemanticClaimGroup,
} from "../../src/domain/formal/grouping.js";
import { groupRepresentativesBySpec } from "../../src/cli/pipeline-helpers.js";
import type { FormalizationCandidate } from "../../src/domain/formal/formalize.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";

const capabilityNames = ["auth", "catalog", "reporting", "formal"] as const;

const capabilityArbitrary = fc.constantFrom(...capabilityNames);

const claimKindArbitrary = fc.constantFrom<"requirement" | "scenario">("requirement", "scenario");

const claimArbitrary: fc.Arbitrary<Claim> = fc.record({
  kind: claimKindArbitrary,
  capability: fc.option(capabilityArbitrary, { nil: undefined }),
  id: fc.option(fc.integer({ min: 0, max: 999 }), { nil: undefined }),
  file: fc.stringMatching(/^[a-z][a-z0-9/-]{0,14}\.md$/u),
}).map(({ kind, capability, id, file }) => ({
  ...(id === undefined ? {} : { id: toClaimId(`CLAIM-${String(id)}`) }),
  kind,
  text: `WHEN ${file} changes, THE system SHALL respond.`,
  obligation: "mandatory" as const,
  provenance: { file, line: 1 },
  references: [],
  ...(capability === undefined ? {} : { capability: toCapabilityName(capability) }),
}));

const claimListArbitrary = fc.array(claimArbitrary, { minLength: 0, maxLength: 40 });

const logicalFileMapArbitrary = fc.dictionary(capabilityArbitrary, fc.stringMatching(/^[a-z][a-z0-9/-]{0,14}\.md$/u));

function groupKeys(groups: readonly SemanticClaimGroup[]): readonly string[] {
  return groups.map((group) => group.logicalFile);
}

function eligibleClaims(claims: readonly Claim[]): readonly Claim[] {
  return claims.filter((claim) => claim.kind === "requirement" || claim.kind === "scenario");
}

describe("semantic grouping properties", () => {
  it("selects a deterministic key for every generated claim and map", () => {
    traceSpec("FLA-SEMANTIC-GROUPING");
    fc.assert(
      fc.property(claimArbitrary, logicalFileMapArbitrary, (claim, entries) => {
        const map = new Map(Object.entries(entries));
        expect(selectClaimLogicalFile(claim, map)).toBe(selectClaimLogicalFile(claim, map));
      }),
      { numRuns: 200 },
    );
  });

  it("partitions every eligible claim exactly once and preserves order", () => {
    traceSpec("FLA-CLAIM-PARTITION");
    fc.assert(
      fc.property(claimListArbitrary, logicalFileMapArbitrary, (claims, entries) => {
        const map = new Map(Object.entries(entries));
        const groups = groupFormalizationClaims(claims, map);
        const eligible = eligibleClaims(claims);
        const flattened = groups.flatMap((group) => group.claims);

        expect(flattened).toHaveLength(eligible.length);
        expect(new Set(flattened.map((entry) => entry.eligibleIndex)).size).toBe(eligible.length);
        expect(new Set(flattened.map((entry) => entry.claim))).toEqual(new Set(eligible));
        expect(groups.every((group) => {
          const indexes = group.claims.map((entry) => entry.eligibleIndex);
          return indexes.every((index, position) => position === 0 || index > indexes[position - 1]!);
        })).toBe(true);
        expect(flattened.every((entry) => entry.logicalFile === selectClaimLogicalFile(entry.claim, map))).toBe(true);
        expect(new Set(groupKeys(groups)).size).toBe(groups.length);
      }),
      { numRuns: 200 },
    );
  });

  it("matches the solver's shared-key grouping after capability filtering", () => {
    traceSpec("FLA-CLAIM-PARTITION", "FLA-SEMGRP-PARITY");
    fc.assert(
      fc.property(claimListArbitrary, logicalFileMapArbitrary, (claims, entries) => {
        const map = new Map(Object.entries(entries));
        const filtered = claims.filter(
          (claim) => (claim.kind === "requirement" || claim.kind === "scenario") && claim.capability !== undefined,
        );
        const groups = groupFormalizationClaims(filtered, map);
        const candidates: FormalizationCandidate[] = filtered.map((claim) => ({
          claim,
          samples: [makePropertySample(claim.id ?? `UNNAMED-${claim.provenance.file}`)],
          invalidSamples: [],
        }));
        const representatives = candidates.map((candidate) => candidate.samples[0]!);
        const solverGroups = groupRepresentativesBySpec(candidates, representatives, map);
        expect(groups.map((group) => [group.logicalFile, group.claims.map((entry) => entry.claim.id ?? `UNNAMED-${entry.claim.provenance.file}`)])).toEqual(
          solverGroups.map((group) => [group.specFile, group.claims.map((entry) => entry.claimId)]),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("is equivalent to historical file grouping when every semantic key is its provenance file", () => {
    traceSpec("FLA-SEMGRP-EMERGENT");
    fc.assert(
      fc.property(claimListArbitrary, (claims) => {
        const semanticClaims: Claim[] = claims.map((claim) => {
          const { capability: _capability, ...withoutCapability } = claim;
          return withoutCapability;
        });
        const expected = new Map<string, string[]>();
        for (const claim of eligibleClaims(semanticClaims)) {
          const ids = expected.get(claim.provenance.file);
          const id = claim.id ?? `UNNAMED-${claim.provenance.file}`;
          if (ids === undefined) {
            expected.set(claim.provenance.file, [id]);
          } else {
            ids.push(id);
          }
        }

        const actual = groupFormalizationClaims(semanticClaims, new Map()).map((group) => [
          group.logicalFile,
          group.claims.map((entry) => entry.claim.id ?? `UNNAMED-${entry.claim.provenance.file}`),
        ]);
        expect(actual).toEqual([...expected.entries()]);
      }),
      { numRuns: 200 },
    );
  });
});

describe("physical sub-batching properties", () => {
  it("preserves group membership, order, sums, and bounds for every valid size", () => {
    traceSpec("FLA-SUBBATCH", "FLA-CLAIM-PARTITION");
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        (claimCount, maxBatchSize) => {
          const claims = Array.from({ length: claimCount }, (_, index) => ({
            claim: {
              kind: "requirement" as const,
              id: toClaimId(`AUTH-REQ-${String(index + 1)}`),
              text: `Claim ${String(index)}`,
              obligation: "mandatory" as const,
              provenance: { file: `auth-${String(index)}.md`, line: index + 1 },
              references: [],
              capability: toCapabilityName("auth"),
            },
            eligibleIndex: index,
            logicalFile: "logical/auth.md",
          }));
          const group: SemanticClaimGroup = { logicalFile: "logical/auth.md", claims };
          const batches = splitPhysicalBatches(group, maxBatchSize);
          const indexes = batches.flatMap((batch) => batch.claims.map((claim) => claim.eligibleIndex));

          expect(indexes).toEqual(Array.from({ length: claimCount }, (_, index) => index));
          expect(batches.reduce((sum, batch) => sum + batch.claims.length, 0)).toBe(claimCount);
          expect(batches.every((batch) => batch.logicalFile === group.logicalFile)).toBe(true);
          if (claimCount === 0) {
            expect(batches).toEqual([]);
          } else if (maxBatchSize === 0) {
            expect(batches).toHaveLength(1);
          } else {
            expect(batches.every((batch) => batch.claims.length <= maxBatchSize)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("does not mutate claims or provenance while grouping and splitting", () => {
    traceSpec("FLA-SUBBATCH", "FLA-CLAIM-PARTITION");
    fc.assert(
      fc.property(claimListArbitrary, logicalFileMapArbitrary, fc.integer({ min: 0, max: 20 }), (claims, entries, maxBatchSize) => {
        const map = new Map(Object.entries(entries));
        const before = structuredClone(claims);
        const groups = groupFormalizationClaims(claims, map);
        for (const group of groups) {
          splitPhysicalBatches(group, maxBatchSize);
        }
        expect(claims).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });

  it("keeps duplicate and missing claim IDs distinct under generated histories", () => {
    traceSpec("FLA-IDENTITY-DUP", "FLA-IDENTITY-MISSING");
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), (claimCount) => {
        const claims: Claim[] = Array.from({ length: claimCount }, (_, index) => ({
          kind: "requirement",
          text: `Claim ${String(index)}`,
          obligation: "mandatory",
          provenance: { file: `identity-${String(index)}.md`, line: index + 1 },
          references: [],
          ...(index % 2 === 0 ? { id: toClaimId("DUPLICATE") } : {}),
          capability: toCapabilityName("auth"),
        }));
        const groups = groupFormalizationClaims(claims, new Map([["auth", "merged/auth.md"]]));
        const indexed = groups.flatMap((group) => group.claims.map((entry) => entry.eligibleIndex));
        expect(indexed).toEqual(Array.from({ length: claimCount }, (_, index) => index));
        expect(new Set(indexed).size).toBe(claimCount);
      }),
      { numRuns: 100 },
    );
  });
});

function makePropertySample(claimId: string): LogicIrClaim {
  return {
    claimId: toClaimId(claimId),
    obligation: "mandatory",
    variables: [{ name: "State", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}
