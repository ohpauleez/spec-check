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
});
