import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { parseSpec } from "../../src/domain/parser/spec.js";

describe("parser properties", () => {
  it("is deterministic and preserves unmatched lines", async () => {
    traceSpec("CAT-PARSE-DETERMINISM", "CAT-DETERM-SAME", "CAT-PRESERVE-FAIL");
    await fc.assert(
      fc.asyncProperty(fc.string(), async (payload) => {
        const root = await mkdtemp(join(tmpdir(), "spec-check-prop-parser-"));
        const file = join(root, "spec.md");
        const markdown = [
          "## ADDED Requirements",
          "### Requirement: Example [CAT-EXAMPLE]",
          "WHEN trigger exists, THE system SHALL respond.",
          "**References:**",
          "- proposal.md#Scope",
          payload,
        ].join("\n");

        await writeFile(file, markdown, "utf8");
        const parsedA = await parseSpec(file);
        const parsedB = await parseSpec(file);

        expect(parsedA).toEqual(parsedB);

        const trimmedPayload = payload.trimEnd();
        if (trimmedPayload.length > 0) {
          expect(parsedA.unparsed.some((line) => line.text === trimmedPayload)).toBe(true);
        }
      }),
      { numRuns: 20 },
    );
  });
});
