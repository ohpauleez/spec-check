import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { traceClaimsToSource } from "../../src/domain/code-backwards/trace.js";
import { deriveSpecsFromSource } from "../../src/domain/code-backwards/derive.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { toModelName, toOutputDirPath } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(async () => ({
    ok: true,
    value: {
      sample: {
        claimId: "CAT-PIPELINE-REQ",
        obligation: "mandatory",
        sorts: [{ name: "State", sort: "Bool" }],
        functions: [{ name: "supports", args: ["Bool"], returns: "Bool" }],
        assertions: [{ id: "ASSERT_1", expr: "(supports true)" }],
      },
    },
  })),
}));

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(async () => ({
    kind: "unsat",
    stdout: "unsat\n",
    stderr: "",
    exitCode: 0,
  })),
}));

describe("code-backwards pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates gen_specs and gen_specs_smt artifacts", async () => {
    traceSpec("RAE-REPORT-GENSPECS");
    const root = await mkdtemp(join(tmpdir(), "spec-check-cb-"));
    const output = join(root, "output");
    await writeFile(join(root, "src-file.ts"), "// [CAT-PIPELINE-REQ]\nexport const x = 1;\n", "utf8");

    const graph = buildClaimGraph({
      specs: [
        {
          file: "spec.md",
          requirements: [
            {
              title: "Pipeline",
              identifier: "CAT-PIPELINE-REQ",
              body: "WHEN source runs, THE system SHALL behave.",
              earsType: "event-driven",
              references: ["proposal.md#Scope"],
              provenance: { file: "spec.md", line: 1 },
            },
          ],
          scenarios: [],
          deltaSections: ["ADDED"],
          structuralFindings: [],
          unparsed: [],
        },
      ],
    });

    const trace = await traceClaimsToSource({
      srcDir: root,
      claimGraph: graph.graph,
    });
    const derived = await deriveSpecsFromSource({
      outputDir: toOutputDirPath(output),
      traces: trace.traces,
    });

    expect(derived.specs.length).toBeGreaterThan(0);
    const { formalizeGeneratedSpecs } = await import("../../src/domain/code-backwards/gen-formal.js");
    const generatedFormal = await formalizeGeneratedSpecs({
      outputDir: toOutputDirPath(output),
      generatedSpecs: derived.specs,
      model: toModelName("gpt-5.3-codex"),
    });

    expect(generatedFormal.claims.length).toBeGreaterThan(0);
    const genSpecPath = join(output, "gen_specs", `${derived.specs[0]?.capability}.md`);
    const genSpecContent = await readFile(genSpecPath, "utf8");
    expect(genSpecContent).toContain("## ADDED Requirements");
  });
});
