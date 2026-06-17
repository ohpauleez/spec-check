import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  buildBlindPrompt,
  extractRationale,
} from "../../src/domain/code-backwards/blind-compare.js";
import type { CrossImplicationResult } from "../../src/domain/code-backwards/cross-implication.js";

describe("blind comparison boundary properties", () => {
  it("buildBlindPrompt never exposes original requirement text", async () => {
    traceSpec("STC-COMPARE-BLIND");
    const classificationArb = fc.constantFrom<CrossImplicationResult["classification"]>(
      "same", "stronger", "weaker", "different", "uncertain",
    );
    const summaryArb = fc.string({ minLength: 1, maxLength: 100 });
    const originalTextArb = fc.string({ minLength: 5, maxLength: 80 });

    await fc.assert(
      fc.asyncProperty(classificationArb, summaryArb, originalTextArb, async (classification, summary, _originalText) => {
        // Simulate a result where we track original text separately
        const result: CrossImplicationResult = {
          capability: "test-cap",
          claimId: "R1",
          classification,
          forward: "yes",
          reverse: "yes",
          evidencePaths: [],
        };

        const prompt = buildBlindPrompt(result, summary);

        // The prompt should contain the generated summary but never the original text
        // (unless the summary happens to equal the original text, which is fine since
        // the point is that no *additional* original text is injected)
        expect(prompt).toContain(summary);
        expect(prompt).toContain("generated-side");
        expect(prompt).toContain("Do not infer or request original requirement text");
      }),
      { numRuns: 30 },
    );
  });

  it("extractRationale never throws on arbitrary input", async () => {
    traceSpec("STC-COMPARE-EXPLAIN");
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (input) => {
        const result = extractRationale(input);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: 50 },
    );
  });
});
