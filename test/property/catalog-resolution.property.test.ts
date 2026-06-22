/**
 * Differential property test for resolveActiveCapabilities.
 *
 * Compares the production implementation against a simplified reference model
 * to verify the critical resolution invariants hold for arbitrary document sets.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { resolveActiveCapabilities } from "../../src/domain/parser/catalog.js";
import { toCapabilityName } from "../../src/domain/branded.js";
import type { CatalogDocument } from "../../src/domain/model.js";

// ---------------------------------------------------------------------------
// Reference model — simplified, easy to trust
// ---------------------------------------------------------------------------

/**
 * Reference implementation of capability resolution logic.
 *
 * Critical properties encoded:
 * 1. Non-spec documents always pass through.
 * 2. Final specs always pass through.
 * 3. For each capability, only the first delta (by sorted path) is kept.
 * 4. Result is sorted by path.
 * 5. Skipped deltas produce exactly one warning finding each.
 */
function referenceResolve(documents: readonly CatalogDocument[]): {
  readonly activePaths: readonly string[];
  readonly findingCount: number;
} {
  // Non-specs pass through unconditionally.
  const nonSpecs = documents.filter((d) => d.type !== "spec");

  const specs = documents.filter((d) => d.type === "spec");

  // Group specs by capability.
  const finalByCapability = new Map<string, CatalogDocument>();
  const deltasByCapability = new Map<string, CatalogDocument[]>();

  for (const spec of specs) {
    if (spec.capability === undefined) {
      // Specs without capability — not grouped, not selected by this logic.
      continue;
    }

    const key = spec.capability;
    if (spec.source === "final") {
      // Last-write-wins for finals (though in practice there should be one per capability).
      finalByCapability.set(key, spec);
    } else {
      const arr = deltasByCapability.get(key);
      if (arr !== undefined) {
        arr.push(spec);
      } else {
        deltasByCapability.set(key, [spec]);
      }
    }
  }

  const selectedSpecs: CatalogDocument[] = [];
  let findingCount = 0;

  const allCapabilities = new Set([...finalByCapability.keys(), ...deltasByCapability.keys()]);
  for (const capability of [...allCapabilities].sort()) {
    const fin = finalByCapability.get(capability);
    if (fin !== undefined) {
      selectedSpecs.push(fin);
    }

    const deltas = (deltasByCapability.get(capability) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    if (deltas.length > 0) {
      selectedSpecs.push(deltas[0]!);
      // Each skipped delta produces one finding.
      findingCount += deltas.length - 1;
    }
  }

  const activePaths = [...nonSpecs, ...selectedSpecs]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((d) => d.path);

  return { activePaths, findingCount };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const capabilityArb = fc.constantFrom("auth", "catalog", "reporting", "formal");
const sourceArb = fc.constantFrom<"final" | "delta">("final", "delta");
const typeArb = fc.constantFrom<"proposal" | "design" | "spec" | "task">("proposal", "design", "spec", "task");

/**
 * Generate a list of CatalogDocuments with unique paths.
 * Unique paths prevent false counterexamples from duplicate-path edge cases
 * that would not occur in real catalog construction (paths come from stat'd files).
 */
const documentsArb = (minLength: number, maxLength: number): fc.Arbitrary<CatalogDocument[]> =>
  fc.array(
    fc.tuple(typeArb, fc.option(capabilityArb, { nil: undefined }), sourceArb),
    { minLength, maxLength },
  ).map((entries) =>
    entries.map(([type, capability, source], index) => {
      const base: { path: string; type: typeof type; source: typeof source; capability?: ReturnType<typeof toCapabilityName> } = {
        path: `/project/cap-${String(index)}/spec.md`,
        type,
        source,
      };
      if (capability !== undefined) {
        base.capability = toCapabilityName(capability);
      }
      return base as CatalogDocument;
    }),
  );

// ---------------------------------------------------------------------------
// Differential test
// ---------------------------------------------------------------------------

describe("resolveActiveCapabilities differential test", () => {
  it("matches reference model for arbitrary document sets", () => {
    traceSpec("CAT-DISCOVER-ACTIVE", "CAT-DETERM-SAME");
    fc.assert(
      fc.property(documentsArb(0, 20), (documents) => {
        const production = resolveActiveCapabilities(documents);
        const reference = referenceResolve(documents);

        const productionPaths = production.activeDocuments.map((d) => d.path);

        expect(productionPaths).toEqual(reference.activePaths);
        expect(production.findings.length).toBe(reference.findingCount);
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic across input orderings (no duplicate finals per capability)", () => {
    traceSpec("CAT-DETERM-SAME");
    fc.assert(
      fc.property(documentsArb(2, 10), (documents) => {
        // Filter to at most one final per capability — matches production precondition.
        // The catalog builder never produces multiple finals for the same capability.
        const seenFinalCaps = new Set<string>();
        const filtered = documents.filter((d) => {
          if (d.type === "spec" && d.source === "final" && d.capability !== undefined) {
            if (seenFinalCaps.has(d.capability)) {
              return false;
            }
            seenFinalCaps.add(d.capability);
          }
          return true;
        });

        const resultA = resolveActiveCapabilities(filtered);
        // Reverse input order.
        const resultB = resolveActiveCapabilities([...filtered].reverse());

        const pathsA = resultA.activeDocuments.map((d) => d.path);
        const pathsB = resultB.activeDocuments.map((d) => d.path);

        expect(pathsA).toEqual(pathsB);
        expect(resultA.findings.length).toBe(resultB.findings.length);
      }),
      { numRuns: 100 },
    );
  });

  it("non-spec documents always pass through regardless of capability conflicts", () => {
    traceSpec("CAT-DISCOVER-ACTIVE");
    fc.assert(
      fc.property(documentsArb(1, 15), (documents) => {
        const result = resolveActiveCapabilities(documents);
        const nonSpecPaths = documents
          .filter((d) => d.type !== "spec")
          .map((d) => d.path)
          .sort((a, b) => a.localeCompare(b));

        const resultNonSpecPaths = result.activeDocuments
          .filter((d) => d.type !== "spec")
          .map((d) => d.path);

        expect(resultNonSpecPaths).toEqual(nonSpecPaths);
      }),
      { numRuns: 100 },
    );
  });
});
