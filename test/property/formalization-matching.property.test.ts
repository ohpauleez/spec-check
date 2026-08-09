import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import {
  matchAttachedBatchResponse,
} from "../../src/domain/formal/formalization-findings.js";
import type { IndexedFormalizationClaim } from "../../src/domain/formal/grouping.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import { traceSpec } from "../support/spec-trace.js";

/** Build a named requirement claim with a stable per-index identifier. */
function makeClaim(index: number): Claim {
  return {
    kind: "requirement",
    text: `Matching claim ${String(index)}`,
    obligation: "mandatory",
    provenance: { file: "matching.md", line: index + 1 },
    references: [],
    capability: toCapabilityName("auth"),
    id: toClaimId(`MATCH-${String(index)}`),
  };
}

/** A batch of indexed claims whose eligible indexes are `0..length-1`. */
function makeIndexedClaims(length: number): IndexedFormalizationClaim[] {
  return Array.from({ length: length }, (_, index): IndexedFormalizationClaim => ({
    index,
    logicalFile: "merged/auth.md",
    claim: makeClaim(index),
  }));
}

/** A schema-valid sample payload pinned to the claim's own identifier. */
function validSample(index: number): LogicIrClaim & { readonly index: number } {
  return {
    index,
    claimId: toClaimId(`MATCH-${String(index)}`),
    obligation: "mandatory",
    variables: [{ name: "State", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

/** Mutation applied to a well-formed entry list to probe matching robustness. */
type Mutation =
  | { readonly kind: "none" }
  | { readonly kind: "drop" }
  | { readonly kind: "duplicate"; readonly source: number }
  | { readonly kind: "extra_entry" }
  | { readonly kind: "unsafe_index" }
  | { readonly kind: "unknown_index" }
  | { readonly kind: "invalid_sample"; readonly at: number }
  | { readonly kind: "extra_fields"; readonly at: number };

const mutationArbitrary = (claimCount: number): fc.Arbitrary<Mutation> => {
  const at = fc.integer({ min: 0, max: Math.max(0, claimCount - 1) });
  return fc.oneof(
    fc.constant({ kind: "none" } as const),
    fc.constant({ kind: "drop" } as const),
    at.map((source) => ({ kind: "duplicate" as const, source })),
    fc.constant({ kind: "extra_entry" } as const),
    fc.constant({ kind: "unsafe_index" } as const),
    fc.constant({ kind: "unknown_index" } as const),
    at.map((position) => ({ kind: "invalid_sample" as const, at: position })),
    at.map((position) => ({ kind: "extra_fields" as const, at: position })),
  );
};

/**
 * Apply one mutation to a valid entry list.
 *
 * @remarks
 * `unknown_index` rewrites the first entry's index to a value outside the
 * claim index set; `unsafe_index` rewrites it to a non-integer; `extra_fields`
 * adds model-hallucinated properties the contract must tolerate; the others
 * reshape the list length or one entry's sample validity.
 */
function applyMutation(
  entries: Record<string, unknown>[],
  claims: readonly IndexedFormalizationClaim[],
  mutation: Mutation,
): Record<string, unknown>[] {
  const legalIndexes = new Set(claims.map((claim) => claim.index));
  switch (mutation.kind) {
    case "none":
      return entries;
    case "drop":
      return entries.slice(1);
    case "duplicate": {
      const source = entries[mutation.source];
      if (source === undefined) return entries;
      return [...entries, source];
    }
    case "extra_entry": {
      const extraIndex = entries.length;
      return [...entries, { ...validSample(extraIndex) } as Record<string, unknown>];
    }
    case "unsafe_index": {
      const first = entries[0];
      if (first === undefined) return entries;
      return [{ ...first, index: 1.5 }, ...entries.slice(1)];
    }
    case "unknown_index": {
      const first = entries[0];
      if (first === undefined) return entries;
      let candidate = entries.length + 1;
      while (legalIndexes.has(candidate)) candidate += 1;
      return [{ ...first, index: candidate }, ...entries.slice(1)];
    }
    case "invalid_sample": {
      const target = entries[mutation.at];
      if (target === undefined) return entries;
      return entries.map((entry, position) => position === mutation.at
        ? { index: entry["index"], claimId: "" }
        : entry);
    }
    case "extra_fields": {
      const target = entries[mutation.at];
      if (target === undefined) return entries;
      return entries.map((entry, position) => position === mutation.at
        ? { ...entry, hallucinated: "ignored", another: { nested: true } }
        : entry);
    }
  }
}

describe("attached batch response matching", () => {
  const claimCountArbitrary = fc.integer({ min: 1, max: 8 });

  it("envelope fails iff the entry count differs or an index is unsafe/unknown/duplicated", () => {
    traceSpec("FLA-ATTACHP-INDEX-VALID", "FLA-ATTACHP-MATCHING", "FLA-IDENTITY-DUP", "FLA-IDENTITY-INDEX");
    fc.assert(
      fc.property(
        claimCountArbitrary.chain((count) => fc.tuple(fc.constant(count), mutationArbitrary(count))),
        ([count, mutation]) => {
          const claims = makeIndexedClaims(count);
          const base = claims.map((claim) => ({ ...validSample(claim.index) }) as Record<string, unknown>);
          const entries = applyMutation(base, claims, mutation);
          const result = matchAttachedBatchResponse({ formalizations: entries }, claims);

          const envelopeBreaking =
            mutation.kind === "drop"
            || mutation.kind === "duplicate"
            || mutation.kind === "extra_entry"
            || mutation.kind === "unsafe_index"
            || mutation.kind === "unknown_index";

          // These mutations break the whole envelope; per-entry mutations
          // (invalid_sample, extra_fields, none) keep the envelope intact.
          expect(result.ok).toBe(!envelopeBreaking);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("on success the matched key set is exactly the claim index set", () => {
    traceSpec("FLA-ATTACHP-MATCHING", "FLA-IDENTITY-INDEX");
    fc.assert(
      fc.property(claimCountArbitrary, (count) => {
        const claims = makeIndexedClaims(count);
        const entries = claims.map((claim) => ({ ...validSample(claim.index) }) as Record<string, unknown>);
        const result = matchAttachedBatchResponse({ formalizations: entries }, claims);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect([...result.value.keys()].sort((a, b) => a - b)).toEqual(
          claims.map((claim) => claim.index),
        );
        for (const verdict of result.value.values()) {
          expect(verdict.ok).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("tolerates extra model-hallucinated fields on a valid entry", () => {
    traceSpec("FLA-ATTACHP-UNTRUSTED", "FLA-ATTACHP-MATCHING");
    fc.assert(
      fc.property(claimCountArbitrary, (count) => {
        const claims = makeIndexedClaims(count);
        const entries = claims.map((claim) => ({ ...validSample(claim.index) }) as Record<string, unknown>);
        const decorated = entries.map((entry, position) => position === 0
          ? { ...entry, extra: "tolerated", nested: { noise: [1, 2, 3] } }
          : entry);
        const result = matchAttachedBatchResponse({ formalizations: decorated }, claims);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.get(0)?.ok).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  it("rejects a zero-entry response for a non-empty batch with a count-mismatch error", () => {
    traceSpec("FLA-ATTACHP-MATCHING", "FLA-ATTACHP-INDEX-VALID");
    fc.assert(
      fc.property(claimCountArbitrary, (count) => {
        const claims = makeIndexedClaims(count);
        const result = matchAttachedBatchResponse({ formalizations: [] }, claims);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain(`expected ${String(count)}`);
        expect(result.error).toContain("received 0");
      }),
      { numRuns: 100 },
    );
  });

  it("keeps a per-entry invalid sample as data so the claim can fall back", () => {
    traceSpec("FLA-ATTACHP-MATCHING", "FLA-FORMAL-PARTIAL");
    fc.assert(
      fc.property(
        claimCountArbitrary.chain((count) =>
          fc.tuple(fc.constant(count), fc.integer({ min: 0, max: Math.max(0, count - 1) }))),
        ([count, at]) => {
          const claims = makeIndexedClaims(count);
          const entries = claims.map((claim, position) => position === at
            ? ({ index: claim.index, claimId: "" } as Record<string, unknown>)
            : ({ ...validSample(claim.index) }) as Record<string, unknown>);
          const result = matchAttachedBatchResponse({ formalizations: entries }, claims);

          // Envelope stays intact; only the one entry is a rejection.
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.get(at)?.ok).toBe(false);
          for (const claim of claims) {
            if (claim.index !== at) {
              expect(result.value.get(claim.index)?.ok).toBe(true);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
