import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { classifyRelationship } from "../../src/domain/code-backwards/cross-implication.js";

describe("cross-side implication properties", () => {
  it("classification is deterministic and symmetric by inverse strength labels", async () => {
    traceSpec("STC-CROSS-IMPLY");
    const directionArb = fc.constantFrom<"yes" | "no" | "inconclusive">("yes", "no", "inconclusive");

    await fc.assert(
      fc.asyncProperty(directionArb, directionArb, async (forward, reverse) => {
        const classificationA = classifyRelationship(forward, reverse);
        const classificationB = classifyRelationship(forward, reverse);
        expect(classificationA).toBe(classificationB);

        const inverted = classifyRelationship(reverse, forward);
        if (classificationA === "stronger") {
          expect(inverted).toBe("weaker");
        } else if (classificationA === "weaker") {
          expect(inverted).toBe("stronger");
        } else {
          expect(inverted).toBe(classificationA);
        }
      }),
      { numRuns: 40 },
    );
  });
});
