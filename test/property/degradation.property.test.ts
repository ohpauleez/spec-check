import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { PROMPT_ARG_MAX_BYTES } from "../../src/adapters/opencode-limits.js";
import {
  decideBatchDegradation,
  inlinePromptsFitOpencodeLimit,
  type OpencodeErrorKind,
} from "../../src/domain/formal/degradation.js";
import { splitPhysicalBatches } from "../../src/domain/formal/grouping.js";
import { traceSpec } from "../support/spec-trace.js";

const ALL_ERROR_KINDS: readonly OpencodeErrorKind[] = [
  "spawn_error",
  "timeout",
  "invalid_json",
  "invalid_timeout",
  "schema_validation_error",
  "prompt_too_large",
  "invalid_files",
];

const errorKindArbitrary: fc.Arbitrary<OpencodeErrorKind> = fc.constantFrom(...ALL_ERROR_KINDS);

/** Kinds for which per-claim inline retry can never address the failure. */
const NEVER_DEGRADE: ReadonlySet<OpencodeErrorKind> = new Set([
  "spawn_error",
  "invalid_files",
  "invalid_timeout",
]);

/** Kinds that always degrade to per-claim inline retry regardless of fit. */
const ALWAYS_DEGRADE: ReadonlySet<OpencodeErrorKind> = new Set([
  "timeout",
  "invalid_json",
  "schema_validation_error",
]);

describe("batch degradation decision properties", () => {
  it("is deterministic, exhaustive, and depends only on (kind, fit)", () => {
    traceSpec("FLA-DEGRADE-KIND");
    fc.assert(
      fc.property(errorKindArbitrary, fc.boolean(), (kind, fit) => {
        const first = decideBatchDegradation(kind, fit);
        const second = decideBatchDegradation(kind, fit);

        // Determinism: identical inputs yield identical decisions.
        expect(second).toEqual(first);
        // Exhaustiveness: every kind yields one of the two legal decisions.
        expect(first.kind === "degrade_to_per_claim" || first.kind === "emit_claim_errors").toBe(true);

        if (NEVER_DEGRADE.has(kind)) {
          expect(first.kind).toBe("emit_claim_errors");
        } else if (ALWAYS_DEGRADE.has(kind)) {
          expect(first.kind).toBe("degrade_to_per_claim");
        } else {
          // prompt_too_large: fit is the sole deciding factor.
          expect(kind).toBe("prompt_too_large");
          expect(first.kind).toBe(fit ? "degrade_to_per_claim" : "emit_claim_errors");
        }
      }),
      { numRuns: 300 },
    );
  });

  it("covers every adapter error kind exactly once across the decision table", () => {
    traceSpec(
      "FLA-DEGRADE-TIMEOUT",
      "FLA-DEGRADE-JSON",
      "FLA-DEGRADE-SCHEMA",
      "FLA-DEGRADE-SPAWN",
      "FLA-DEGRADE-FILES",
      "FLA-DEGRADE-INVTIMEOUT",
      "FLA-DEGRADE-TOOLARGE",
    );
    for (const kind of ALL_ERROR_KINDS) {
      for (const fit of [true, false]) {
        const decision = decideBatchDegradation(kind, fit);
        if (NEVER_DEGRADE.has(kind)) {
          expect(decision.kind, `${kind} must never degrade`).toBe("emit_claim_errors");
        } else if (ALWAYS_DEGRADE.has(kind)) {
          expect(decision.kind, `${kind} must always degrade`).toBe("degrade_to_per_claim");
        } else {
          expect(decision.kind).toBe(fit ? "degrade_to_per_claim" : "emit_claim_errors");
        }
      }
    }
  });

  it("fit check is bounded by the adapter byte limit and respects the boundary", () => {
    traceSpec("FLA-DEGRADE-TOOLARGE", "FLA-ATTACH-SINGLE");
    fc.assert(
      fc.property(fc.nat({ max: 200 }), (padding) => {
        const atLimit = "x".repeat(PROMPT_ARG_MAX_BYTES);
        const overLimit = "x".repeat(PROMPT_ARG_MAX_BYTES + 1 + padding);
        // Exactly at the limit fits; one byte over does not.
        expect(inlinePromptsFitOpencodeLimit([atLimit])).toBe(true);
        expect(inlinePromptsFitOpencodeLimit([overLimit])).toBe(false);
        // Empty input fits by universal quantification.
        expect(inlinePromptsFitOpencodeLimit([])).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it("maxBatchSize = MAX_SAFE_INTEGER and zero both yield a single chunk", () => {
    traceSpec("FLA-SUBBATCH", "FLA-SUBBATCH-CHUNKS", "FLA-SUBBATCH-ZERO");
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 100 }), (claims) => {
        const group = { logicalFile: "merged/generated.md", claims };
        for (const maxBatchSize of [0, Number.MAX_SAFE_INTEGER]) {
          const batches = splitPhysicalBatches(group, maxBatchSize);
          expect(batches).toHaveLength(1);
          expect(batches[0]?.claims).toEqual(claims);
          expect(batches[0]?.ordinal).toBe(0);
        }
      }),
      { numRuns: 150 },
    );
  });
});
