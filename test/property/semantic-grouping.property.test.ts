import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { toCapabilityName } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import { selectClaimLogicalFile, splitPhysicalBatches } from "../../src/domain/formal/grouping.js";
import { traceSpec } from "../support/spec-trace.js";

const capabilityArbitrary = fc.constantFrom("auth", "catalog", "reporting", "formal");
const logicalFileArbitrary = fc.stringMatching(/^[a-z][a-z0-9/-]{0,14}\.md$/u);
const claimArbitrary = fc
  .record({
    capability: fc.option(capabilityArbitrary, { nil: undefined }),
    file: logicalFileArbitrary,
  })
  .map(({ capability, file }): Pick<Claim, "capability" | "provenance"> => ({
    provenance: { file },
    ...(capability === undefined ? {} : { capability: toCapabilityName(capability) }),
  }));
const logicalFileMapArbitrary = fc.dictionary(capabilityArbitrary, logicalFileArbitrary);

describe("semantic grouping properties", () => {
  it("selects a deterministic semantic key for every claim and map", () => {
    traceSpec("FLA-SEMANTIC-GROUPING");
    fc.assert(
      fc.property(claimArbitrary, logicalFileMapArbitrary, (claim, entries) => {
        const map = new Map<string, string>(Object.entries(entries));
        expect(selectClaimLogicalFile(claim, map)).toBe(selectClaimLogicalFile(claim, map));
      }),
      { numRuns: 100 },
    );
  });

  it("preserves all members, order, semantic key, and positive chunk bounds", () => {
    traceSpec("FLA-SUBBATCH", "FLA-CLAIM-PARTITION");
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { maxLength: 80 }),
        fc.integer({ min: 0, max: 40 }),
        (claims, maxBatchSize) => {
          const group = { logicalFile: "merged/generated.md", claims };
          const batches = splitPhysicalBatches(group, maxBatchSize);

          expect(batches.flatMap((batch) => batch.claims)).toEqual(claims);
          expect(batches.every((batch) => batch.logicalFile === group.logicalFile)).toBe(true);
          expect(batches.map((batch) => batch.ordinal)).toEqual(
            Array.from({ length: batches.length }, (_, index) => index),
          );
          if (claims.length === 0) {
            expect(batches).toEqual([]);
          } else if (maxBatchSize === 0) {
            expect(batches).toHaveLength(1);
          } else {
            expect(batches.every((batch) => batch.claims.length <= maxBatchSize)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
