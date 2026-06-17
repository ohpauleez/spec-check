import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { buildManifestEntries } from "../../src/domain/reporting/manifest.js";
import { sha256Hex } from "../../src/adapters/fs.js";

describe("manifest properties", () => {
  it("every manifest entry has correct checksum for its content", async () => {
    traceSpec("RAE-MANIFEST-SCHEMA", "RAE-SCHEMA-HASH");
    const fileArb = fc.record({
      path: fc.string({ minLength: 1, maxLength: 40 }).map((s) => `output/${s.replace(/[/\\]/gu, "_")}.txt`),
      phase: fc.constantFrom("qualitative", "formalization", "logic", "cross-implication"),
      content: fc.string({ minLength: 0, maxLength: 200 }),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(fileArb, { minLength: 1, maxLength: 5 }), async (files) => {
        const entries = buildManifestEntries(files);

        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]!;
          const entry = entries[index]!;
          expect(entry.path).toBe(file.path);
          expect(entry.checksum).toBe(sha256Hex(file.content));
          expect(entry.phase).toBe(file.phase);
        }
      }),
      { numRuns: 30 },
    );
  });
});
