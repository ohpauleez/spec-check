import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { traceSpec } from "../support/spec-trace.js";
import {
  groupBySemanticKey,
  selectClaimLogicalFile,
  splitPhysicalBatches,
} from "../../src/domain/formal/grouping.js";
import { toCapabilityName, toClaimId, type CapabilityName, type ClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";

function arbClaim(options: { capability?: "omit" | "present" | "either" } = {}): fc.Arbitrary<Claim> {
  const capabilityArb: fc.Arbitrary<CapabilityName | undefined> =
    options.capability === "omit"
      ? fc.constant(undefined)
      : options.capability === "present"
        ? fc.string({ minLength: 1 }).map(toCapabilityName)
        : fc.option(fc.string({ minLength: 1 }).map(toCapabilityName), { nil: undefined });
  return fc.record({
    kind: fc.constantFrom("requirement", "scenario"),
    text: fc.string({ minLength: 1 }),
    obligation: fc.constantFrom("mandatory", "advisory", "informational"),
    provenance: fc.record({ file: fc.string({ minLength: 1 }) }),
    references: fc.array(fc.string()),
    id: fc.option(fc.string({ minLength: 1 }).map((s) => toClaimId(s.replace(/[^A-Z0-9-]/gu, "X")) as ClaimId), { nil: undefined }),
    capability: capabilityArb,
  }) as unknown as fc.Arbitrary<Claim>;
}

describe("semantic batching properties", () => {
  it("key determinism: same claim and map always produce same key", () => {
    traceSpec("FLA-SEMANTIC-GROUPING");
    fc.assert(fc.property(arbClaim(), fc.dictionary(fc.string(), fc.string()), (claim, mapRecord) => {
      const map = new Map<string, string>(Object.entries(mapRecord));
      const key1 = selectClaimLogicalFile(claim, map);
      const key2 = selectClaimLogicalFile(claim, map);
      expect(key1).toBe(key2);
    }));
  });

  it("grouping completeness: every eligible claim appears in exactly one group", () => {
    traceSpec("FLA-CLAIM-PARTITION");
    fc.assert(fc.property(
      fc.array(arbClaim()),
      fc.dictionary(fc.string(), fc.string()),
      (claims, mapRecord) => {
        const map = new Map<string, string>(Object.entries(mapRecord));
        const indexed = claims.map((claim, eligibleIndex) => ({ claim, eligibleIndex }));
        const groups = groupBySemanticKey(indexed, (item) => item.claim, map);
        const totalInGroups = groups.reduce((sum, group) => sum + group.items.length, 0);
        expect(totalInGroups).toBe(claims.length);
        const seen = new Set<number>();
        for (const group of groups) {
          for (const item of group.items) {
            expect(seen.has(item.eligibleIndex)).toBe(false);
            seen.add(item.eligibleIndex);
          }
        }
        expect(seen.size).toBe(claims.length);
      },
    ));
  });

  it("sub-batch invariants: bound, sum, order, termination", () => {
    traceSpec("FLA-SUBBATCH");
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: 100 })),
      fc.integer({ min: 0, max: 20 }),
      (items, maxBatchSize) => {
        const chunks = splitPhysicalBatches(items, maxBatchSize);
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        expect(total).toBe(items.length);
        if (maxBatchSize === 0) {
          expect(chunks.length).toBe(items.length === 0 ? 0 : 1);
        } else if (maxBatchSize === 1) {
          expect(chunks.length).toBe(items.length);
        } else {
          for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(maxBatchSize);
          }
        }
        expect(chunks.flat()).toEqual(items);
      },
    ));
  });

  it("provenance immutability: grouping never mutates input claims", () => {
    traceSpec("FLA-CLAIM-PARTITION");
    fc.assert(fc.property(
      fc.array(arbClaim()),
      fc.dictionary(fc.string(), fc.string()),
      (claims, mapRecord) => {
        const map = new Map<string, string>(Object.entries(mapRecord));
        const copied = claims.map((claim) => ({ ...claim, provenance: { ...claim.provenance } }));
        groupBySemanticKey(copied, (item) => item, map);
        expect(copied).toEqual(claims.map((claim) => ({ ...claim, provenance: { ...claim.provenance } })));
      },
    ));
  });

  it("emergent legacy equivalence: file grouping emerges for claims without capabilities", () => {
    traceSpec("FLA-SEMGRP-EMERGENT");
    fc.assert(fc.property(
      fc.array(arbClaim({ capability: "omit" })),
      (claims) => {
        const groups = groupBySemanticKey(claims, (item) => item, new Map());
        const groupLookup = new Map(groups.map((g) => [g.key, g]));
        for (let i = 0; i < claims.length; i++) {
          const file = claims[i]!.provenance.file;
          const group = groupLookup.get(file);
          expect(group).toBeDefined();
          expect(group!.items.some((item) => item === claims[i])).toBe(true);
        }
      },
    ));
  });
});
