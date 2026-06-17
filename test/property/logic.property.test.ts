import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { sanitizeIdentifier } from "../../src/domain/formal/smtlib.js";
import { buildEquivalenceClusters } from "../../src/domain/formal/clustering.js";

describe("logic and clustering properties", () => {
  it("sanitized identifiers remain SMT-safe", async () => {
    traceSpec("FLA-SMTLIB-COMPILE");
    await fc.assert(
      fc.asyncProperty(fc.string(), async (value) => {
        const sanitized = sanitizeIdentifier(value);
        expect(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(sanitized)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it("cluster construction is deterministic and symmetric for mutual pairs", async () => {
    traceSpec("FLA-CLUSTER-PROPERTIES", "FLA-CLUSTER-SYMM", "FLA-CLUSTER-DETERM");
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (size) => {
        const pairwise = [] as {
          leftIndex: number;
          rightIndex: number;
          leftImpliesRight: "yes";
          rightImpliesLeft: "yes";
          evidence: {
            leftToRightQuery: string;
            rightToLeftQuery: string;
            leftToRightResult: string;
            rightToLeftResult: string;
          };
        }[];

        for (let left = 0; left < size; left += 1) {
          for (let right = left + 1; right < size; right += 1) {
            pairwise.push({
              leftIndex: left,
              rightIndex: right,
              leftImpliesRight: "yes",
              rightImpliesLeft: "yes",
              evidence: {
                leftToRightQuery: "",
                rightToLeftQuery: "",
                leftToRightResult: "unsat",
                rightToLeftResult: "unsat",
              },
            });
          }
        }

        const clustersA = buildEquivalenceClusters(size, pairwise);
        const clustersB = buildEquivalenceClusters(size, pairwise);
        expect(clustersA).toEqual(clustersB);
        expect(clustersA).toHaveLength(1);
        expect(clustersA[0]?.members).toEqual([...Array.from({ length: size }, (_, index) => index)]);
      }),
      { numRuns: 20 },
    );
  });
});
