import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { traceClaimsToSource } from "../../src/domain/code-backwards/trace.js";

describe("traceability contracts", () => {
  it("links canonical identifiers and reports unknown identifier", async () => {
    traceSpec("STC-TRACE-IDENTIFIERS", "STC-ID-UNKNOWN");
    const root = await mkdtemp(join(tmpdir(), "spec-check-trace-"));
    await writeFile(
      join(root, "module.ts"),
      "// [CAT-TRACE-REQ]\n// [CAT-UNKNOWN-REF]\nexport const run = true;\n",
      "utf8",
    );

    const graph = buildClaimGraph({
      specs: [
        {
          file: "spec.md",
          requirements: [
            {
              title: "Trace",
              identifier: "CAT-TRACE-REQ",
              body: "WHEN trace exists, THE system SHALL link it.",
              earsType: "event-driven",
              deltaOperation: "base",
              references: ["proposal.md#Scope"],
              provenance: { file: "spec.md", line: 3 },
            },
          ],
          scenarios: [],
          deltaSections: ["ADDED"],
          structuralFindings: [],
          unparsed: [],
        },
      ],
    });

    const trace = await traceClaimsToSource({ srcDir: root, claimGraph: graph.graph });
    expect(trace.findings.some((finding) => finding.category === "source_trace.supported")).toBe(true);
    expect(trace.findings.some((finding) => finding.category === "source_trace.unknown_identifier")).toBe(true);
  });

  it("ignores regex character-class fragments like [A-Z] and [A-Z0-9]", async () => {
    traceSpec("STC-TRACE-IDENTIFIERS");
    const root = await mkdtemp(join(tmpdir(), "spec-check-trace-fp-"));
    // File contains bracketed patterns that look like identifiers but are
    // actually regex character classes (single-char prefix before first hyphen).
    await writeFile(
      join(root, "regex.ts"),
      [
        "const UPPER = /[A-Z]/;",
        "const ALNUM = /[A-Z0-9]+/;",
        "// Real identifier: [CAT-TRACE-REQ]",
        "export {};",
      ].join("\n"),
      "utf8",
    );

    const graph = buildClaimGraph({
      specs: [
        {
          file: "spec.md",
          requirements: [
            {
              title: "Trace",
              identifier: "CAT-TRACE-REQ",
              body: "WHEN trace exists, THE system SHALL link it.",
              earsType: "event-driven",
              deltaOperation: "base",
              references: [],
              provenance: { file: "spec.md", line: 3 },
            },
          ],
          scenarios: [],
          deltaSections: ["ADDED"],
          structuralFindings: [],
          unparsed: [],
        },
      ],
    });

    const trace = await traceClaimsToSource({ srcDir: root, claimGraph: graph.graph });

    // The real identifier should be found.
    expect(trace.findings.some((f) => f.category === "source_trace.supported")).toBe(true);

    // The regex fragments should NOT appear as unknown identifiers.
    const unknownDescriptions = trace.findings
      .filter((f) => f.category === "source_trace.unknown_identifier")
      .map((f) => f.description);
    expect(unknownDescriptions.some((d) => d.includes("A-Z"))).toBe(false);
  });
});
