import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { analyzeCoverage } from "../../src/domain/spec-forward/coverage.js";
import { deriveSpecsFromSource } from "../../src/domain/code-backwards/derive.js";
import { classifyDirection, classifyRelationship } from "../../src/domain/code-backwards/cross-implication.js";
import type { SourceTrace } from "../../src/domain/code-backwards/trace.js";
import { toClaimId, toModelName, toOutputDirPath } from "../../src/domain/branded.js";

import type * as FsAdapter from "../../src/adapters/fs.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(async () => ({
    ok: true,
    value: {
      sample: {
        claimId: "DET-REQ",
        obligation: "mandatory",
        variables: [{ name: "S", sort: "Bool" }],
        functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
        assertions: [{ id: "A1", expr: "(f true)" }],
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

vi.mock("../../src/adapters/fs.js", async (importOriginal) => {
  const original = await importOriginal<typeof FsAdapter>();
  return {
    ...original,
    writeOutputAtomic: vi.fn(async () => undefined),
  };
});

function makeTrace(identifier: string): SourceTrace {
  return { identifier, files: [`src/${identifier.toLowerCase()}.ts`], level: "primary" };
}

describe("determinism - extended", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("two runs with same z3 responses produce identical logic analysis output", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-SOLVER-PERSIST");
    const { runLogicAnalysis } = await import("../../src/domain/formal/logic-analysis.js");

    const groups = [{
      specFile: "test/determinism.md",
      claims: [{
        claimId: toClaimId("DET-LOGIC-R1"),
        obligation: "mandatory" as const,
        variables: [{ name: "S", sort: "Bool" as const }],
        functions: [] as const,
        assertions: [{ id: "A1", expr: "true" }],
      }],
    }];

    const outputA = await runLogicAnalysis({ groups, outputDir: toOutputDirPath("/tmp/det-a") });
    const outputB = await runLogicAnalysis({ groups, outputDir: toOutputDirPath("/tmp/det-b") });

    expect(outputA.findings).toEqual(outputB.findings);
    expect(outputA.reportMarkdown).toBe(outputB.reportMarkdown);
  });

  it("parser output is identical across runs for same input", async () => {
    traceSpec("CAT-PARSE-DETERMINISM", "CAT-DETERM-SAME");
    const root = await mkdtemp(join(tmpdir(), "spec-check-det-parser-"));
    const specFile = join(root, "spec.md");
    await writeFile(
      specFile,
      [
        "## ADDED Requirements",
        "### Requirement: Deterministic [DET-PARSE-REQ]",
        "WHEN input is stable, THE system SHALL produce stable output.",
        "**References:**",
        "- proposal.md#Scope",
        "## MODIFIED Requirements",
      ].join("\n"),
      "utf8",
    );

    const { parseSpec } = await import("../../src/domain/parser/spec.js");
    const parsedA = await parseSpec(specFile);
    const parsedB = await parseSpec(specFile);
    expect(parsedA).toEqual(parsedB);
  });

  it("claim graph is identical across runs for same parsed input", () => {
    traceSpec("CGC-GRAPH-DETERMINISM", "CGC-DETERM-SAME");
    const spec = {
      file: "spec.md",
      requirements: [
        { title: "R1", identifier: "DET-GRAPH-R1", body: "WHEN x, THE system SHALL y.", earsType: "event-driven" as const, references: [], provenance: { file: "spec.md", line: 1 } },
        { title: "R2", identifier: "DET-GRAPH-R2", body: "THE system SHOULD log.", earsType: "non-ears" as const, references: [], provenance: { file: "spec.md", line: 2 } },
      ],
      scenarios: [],
      deltaSections: ["ADDED"] as const,
      structuralFindings: [] as { message: string; provenance: { file: string; line: number } }[],
      unparsed: [] as { text: string; provenance: { file: string; line: number } }[],
    };

    const graphA = buildClaimGraph({ specs: [spec] });
    const graphB = buildClaimGraph({ specs: [spec] });
    expect(graphA.graph.claims).toEqual(graphB.graph.claims);
    expect(graphA.findings).toEqual(graphB.findings);
  });

  it("code-derived spec generation produces identical content across runs", async () => {
    traceSpec("STC-GEN-SPECS", "STC-GEN-EARS");
    const traces = [makeTrace("DET-GEN-REQ"), makeTrace("DET-GEN-OPT")];
    const { mkdtemp, mkdir, writeFile: writeF } = await import("node:fs/promises");
    const { join: j } = await import("node:path");
    const { tmpdir: td } = await import("node:os");
    const srcDir = await mkdtemp(j(td(), "spec-check-det-"));
    await mkdir(j(srcDir, "src"), { recursive: true });
    await writeF(j(srcDir, "src/code.ts"), "export const x = 1;\n", "utf8");

    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue({
      ok: true,
      value: {
        capabilities: [{
          name: "det-gen",
          description: "Determinism test capability",
          requirements: [{ id: "DET-GEN-001", text: "THE system SHALL be deterministic.", evidence: [] }],
        }],
      },
    });

    const outputA = await deriveSpecsFromSource({ outputDir: toOutputDirPath("/tmp/det-gen-a"), srcDir, model: "test-model", timeoutMs: 300000, traces });
    const outputB = await deriveSpecsFromSource({ outputDir: toOutputDirPath("/tmp/det-gen-b"), srcDir, model: "test-model", timeoutMs: 300000, traces });

    expect(outputA.specs.length).toBe(outputB.specs.length);
    for (let index = 0; index < outputA.specs.length; index += 1) {
      expect(outputA.specs[index]!.markdown).toBe(outputB.specs[index]!.markdown);
      expect(outputA.specs[index]!.capability).toBe(outputB.specs[index]!.capability);
    }
  });

  it("code-derived formalization produces identical output with cached responses", async () => {
    traceSpec("STC-GEN-FORMAL", "STC-FORMAL-STABLE");
    const { formalizeGeneratedSpecs } = await import("../../src/domain/code-backwards/gen-formal.js");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const { runZ3Query } = await import("../../src/adapters/z3.js");

    // Explicitly set mock for formalization (previous test may have contaminated).
    vi.mocked(callOpencode).mockResolvedValue({
      ok: true,
      value: {
        sample: {
          claimId: "DET-REQ",
          obligation: "mandatory",
          variables: [{ name: "S", sort: "Bool" }],
          functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
          assertions: [{ id: "A1", expr: "(f true)" }],
        },
      },
    });
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    const input = {
      outputDir: toOutputDirPath("/tmp/det-formal"),
      generatedSpecs: [{ capability: "det-cap", requirements: [{ id: "DET-REQ", text: "THE system SHALL be deterministic." }], sourceIdentifiers: ["DET-REQ"] }],
      model: toModelName("test-model"),
      timeoutMs: 300000,
    };

    const outputA = await formalizeGeneratedSpecs(input);
    vi.clearAllMocks();

    // Re-mock with same responses
    vi.mocked(callOpencode).mockResolvedValue({
      ok: true,
      value: {
        sample: {
          claimId: "DET-REQ",
          obligation: "mandatory",
          variables: [{ name: "S", sort: "Bool" }],
          functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
          assertions: [{ id: "A1", expr: "(f true)" }],
        },
      },
    });
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    const outputB = await formalizeGeneratedSpecs(input);

    expect(outputA.claims.length).toBe(outputB.claims.length);
    for (let index = 0; index < outputA.claims.length; index += 1) {
      expect(outputA.claims[index]!.capability).toBe(outputB.claims[index]!.capability);
      expect(outputA.claims[index]!.claimId).toBe(outputB.claims[index]!.claimId);
      expect(outputA.claims[index]!.representative).toEqual(outputB.claims[index]!.representative);
    }
  });

  it("cross-side classification is deterministic with cached z3 responses", () => {
    traceSpec("STC-CROSS-IMPLY");
    // classifyDirection and classifyRelationship are pure functions
    const forwardA = classifyDirection("unsat");
    const reverseA = classifyDirection("sat");
    const classificationA = classifyRelationship(forwardA, reverseA);

    const forwardB = classifyDirection("unsat");
    const reverseB = classifyDirection("sat");
    const classificationB = classifyRelationship(forwardB, reverseB);

    expect(classificationA).toBe(classificationB);
    expect(classificationA).toBe("weaker");
  });

  it("coverage findings are identical across runs for same claim graph", () => {
    traceSpec("CGC-COVERAGE-DETERMINISM", "CGC-COVDET-SAME");

    const spec = {
      file: "spec.md",
      requirements: [
        { title: "R1", identifier: "DET-COV-R1", body: "WHEN x, THE system SHALL y.", earsType: "event-driven" as const, references: ["missing.md#Section"], provenance: { file: "spec.md", line: 1 } },
      ],
      scenarios: [],
      deltaSections: ["ADDED"] as const,
      structuralFindings: [] as { message: string; provenance: { file: string; line: number } }[],
      unparsed: [] as { text: string; provenance: { file: string; line: number } }[],
    };

    const graph = buildClaimGraph({ specs: [spec] });
    const findingsA = analyzeCoverage({ claimGraph: graph.graph, specs: [spec] });
    const findingsB = analyzeCoverage({ claimGraph: graph.graph, specs: [spec] });

    expect(findingsA).toEqual(findingsB);
  });
});
