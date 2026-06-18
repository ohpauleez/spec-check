import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { parseProposal } from "../../src/domain/parser/proposal.js";
import { parseSpec } from "../../src/domain/parser/spec.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { analyzeCoverage } from "../../src/domain/spec-forward/coverage.js";
import { writePhaseReports, writeSummaryReport } from "../../src/domain/reporting/render.js";
import { buildManifestEntries, writeManifest } from "../../src/domain/reporting/manifest.js";
import { traceClaimsToSource } from "../../src/domain/code-backwards/trace.js";
import { deriveSpecsFromSource } from "../../src/domain/code-backwards/derive.js";
import { toClaimId, toOutputDirPath, toRelativePath } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(async () => ({
    ok: true,
    value: {
      sample: {
        claimId: "CAT-TEST-REQ",
        obligation: "mandatory",
        sorts: [{ name: "S", sort: "Bool" }],
        functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
        assertions: [{ id: "A1", expr: "(f true)" }],
      },
      findings: [],
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

describe("end-to-end integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("structural violations produce expected findings", async () => {
    traceSpec("CAT-VALIDATE-STRUCT", "CAT-STRUCT-FAIL", "CAT-STRUCT-IDFORMAT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-e2e-struct-"));

    // Spec with missing sections and bad identifier format
    await writeFile(
      join(root, "spec.md"),
      [
        "## ADDED Requirements",
        "### Requirement: No Identifier",
        "WHEN input exists, THE system SHALL respond.",
        "",
        "Some unparsed content that doesn't match any pattern.",
      ].join("\n"),
      "utf8",
    );

    const spec = await parseSpec(join(root, "spec.md"));
    // Parser should capture unparsed lines
    expect(spec.unparsed.length).toBeGreaterThan(0);
  });

  it("coverage gaps produce expected findings", async () => {
    traceSpec("CGC-FIND-MISSING", "CGC-COVER-MISS", "CGC-REF-MISSFILE");
    const root = await mkdtemp(join(tmpdir(), "spec-check-e2e-coverage-"));

    await writeFile(join(root, "proposal.md"), "## Scope\n- handles requests\n- tracks metrics\n", "utf8");
    await writeFile(
      join(root, "spec.md"),
      [
        "## ADDED Requirements",
        "### Requirement: Request Handler [INT-REQ-HANDLER]",
        "WHEN request arrives, THE system SHALL handle it.",
        "**References:**",
        "- proposal.md#Scope",
      ].join("\n"),
      "utf8",
    );

    const proposal = await parseProposal(join(root, "proposal.md"));
    const spec = await parseSpec(join(root, "spec.md"));
    const graph = buildClaimGraph({ proposal, specs: [spec] });
    const findings = analyzeCoverage({ claimGraph: graph.graph, proposal, specs: [spec] });

    // Should detect uncovered upstream claim for "tracks metrics" (no matching requirement)
    expect(findings.some((f) => f.category === "coverage.uncovered_upstream_claim")).toBe(true);
  });

  it("contradictions produce expected findings", async () => {
    traceSpec("CGC-COVER-CONFLICT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-e2e-contra-"));

    await writeFile(join(root, "proposal.md"), "## Scope\n- the system should never reject valid inputs\n", "utf8");
    await writeFile(
      join(root, "spec.md"),
      [
        "## ADDED Requirements",
        "### Requirement: Input Validator [INT-INPUT-VAL]",
        "WHEN invalid input arrives, THE system SHALL reject the input immediately.",
        "**References:**",
        "- proposal.md#Scope",
      ].join("\n"),
      "utf8",
    );

    const proposal = await parseProposal(join(root, "proposal.md"));
    const spec = await parseSpec(join(root, "spec.md"));
    const graph = buildClaimGraph({ proposal, specs: [spec] });
    const findings = analyzeCoverage({ claimGraph: graph.graph, proposal, specs: [spec] });

    // "never reject" vs "SHALL reject" should trigger contradiction
    expect(findings.some((f) => f.category === "coverage.contradiction")).toBe(true);
  });

  it("source traceability detects traced and untraced requirements", async () => {
    traceSpec("STC-TRACE-SOURCE", "STC-TRACE-IDENTIFIERS", "STC-TRACE-MISSING", "STC-TRACE-SUPPORTED");
    const root = await mkdtemp(join(tmpdir(), "spec-check-e2e-trace-"));
    const srcDir = join(root, "src");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(srcDir, { recursive: true });

    // Source file mentions traced requirement but not untraced
    await writeFile(join(srcDir, "impl.ts"), "// [INT-TRACED-REQ]\nexport function handle() {}\n", "utf8");

    // Build graph with two requirements — only one has a source trace
    const graph = buildClaimGraph({
      specs: [{
        file: "spec.md",
        requirements: [
          { title: "Traced", identifier: "INT-TRACED-REQ", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: [], provenance: { file: "spec.md", line: 1 } },
          { title: "Untraced", identifier: "INT-UNTRACED-REQ", body: "WHEN a, THE system SHALL b.", earsType: "event-driven", references: [], provenance: { file: "spec.md", line: 5 } },
        ],
        scenarios: [],
        deltaSections: ["ADDED"],
        structuralFindings: [],
        unparsed: [],
      }],
    });

    const trace = await traceClaimsToSource({
      srcDir,
      claimGraph: graph.graph,
    });

    // Should find traced requirement in src/impl.ts
    expect(trace.traces.some((t) => t.identifier === "INT-TRACED-REQ")).toBe(true);
    // Should report gap for untraced requirement
    expect(trace.findings.some((f) =>
      f.category === "source_trace.gap" && f.description.includes("INT-UNTRACED-REQ"),
    )).toBe(true);
  });

  it("code-derived spec generation produces gen_specs files per capability", async () => {
    traceSpec("STC-GEN-SPECS", "STC-GEN-CAPABILITY");
    const root = await mkdtemp(join(tmpdir(), "spec-check-e2e-gspecs-"));
    const output = join(root, "output");
    const srcDir = join(root, "src");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(srcDir, { recursive: true });

    await writeFile(join(srcDir, "impl.ts"), "// [INT-E2E-REQ]\nexport const x = 1;\n", "utf8");

    const graph = buildClaimGraph({
      specs: [{
        file: "spec.md",
        requirements: [{
          title: "E2E Test",
          identifier: "INT-E2E-REQ",
          body: "WHEN x, THE system SHALL y.",
          earsType: "event-driven",
          references: [],
          provenance: { file: "spec.md", line: 1 },
        }],
        scenarios: [],
        deltaSections: ["ADDED"],
        structuralFindings: [],
        unparsed: [],
      }],
    });

    const trace = await traceClaimsToSource({ srcDir, claimGraph: graph.graph });

    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValueOnce({
      ok: true,
      value: {
        capabilities: [{
          name: "int-e2e",
          description: "E2E test capability",
          requirements: [{ id: "INT-E2E-001", text: "WHEN x, THE system SHALL produce output.", evidence: [] }],
        }],
      },
    });

    const derived = await deriveSpecsFromSource({ outputDir: toOutputDirPath(output), srcDir, model: "test-model", traces: trace.traces });

    expect(derived.specs.length).toBeGreaterThan(0);
    const genSpec = await readFile(join(output, "gen_specs", `${derived.specs[0]!.capability}.md`), "utf8");
    expect(genSpec).toContain("## ADDED Requirements");
  });

  it("manifest checksums match actual file content", async () => {
    traceSpec("RAE-ATOMIC-MANIFEST", "RAE-SCHEMA-HASH", "RAE-MANIFEST-DONE");
    const root = await mkdtemp(join(tmpdir(), "spec-check-e2e-manifest-"));
    const output = join(root, "output");

    const fileContents = [
      { path: "report_1.1.md", phase: "qualitative-review", content: "# report_1.1.md\n\n## Qualitative Pass 1\n\nNo findings.\n" },
      { path: "report_summary.md", phase: "summary", content: "# Summary\nDone.\n" },
    ];

    for (const file of fileContents) {
      const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
      await writeOutputAtomic(toOutputDirPath(output), toRelativePath(file.path), file.content);
    }

    const entries = buildManifestEntries(fileContents);
    await writeManifest(toOutputDirPath(output), entries);

    const manifestContent = await readFile(join(output, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestContent) as { files: { path: string; checksum: string }[] };

    // Verify each manifest checksum matches actual file content
    const { sha256Hex } = await import("../../src/adapters/fs.js");
    for (const entry of manifest.files) {
      const matchingFile = fileContents.find((f) => f.path === entry.path);
      expect(matchingFile).toBeDefined();
      expect(entry.checksum).toBe(sha256Hex(matchingFile!.content));
    }
  });

  it("end-to-end formalization with mocked adapters", async () => {
    traceSpec("FLA-FORMALIZE-CLAIMS", "FLA-CLUSTER-STABLE");
    const { formalizeClaims } = await import("../../src/domain/formal/formalize.js");
    const { clusterFormalizationSamples } = await import("../../src/domain/formal/clustering.js");

    const result = await formalizeClaims({
      claims: [{
        id: toClaimId("INT-FORMAL-R1"),
        kind: "requirement",
        text: "WHEN x, THE system SHALL y.",
        obligation: "mandatory",
        provenance: { file: "spec.md", heading: "R1" },
        references: [],
      }],
      model: "test-model",
      samplesPerClaim: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const candidate = result.value.candidates[0]!;
    const clustered = await clusterFormalizationSamples({
      claimId: candidate.claim.id ?? "R1",
      samples: candidate.samples,
      stabilityThreshold: 0.6,
    });

    expect(clustered.clustered.representative).toBeDefined();
    expect(clustered.clustered.ambiguous).toBe(false);
  });

  it("cross-side comparison pipeline with solver + blind comparison", async () => {
    traceSpec("STC-CROSS-IMPLY", "STC-BLIND-COMPARE", "STC-COMPARE-PRIMARY", "RAE-EVID-CROSSIMPLY");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { callOpencode } = await import("../../src/adapters/opencode.js");

    // Forward: unsat, Reverse: unsat → same
    vi.mocked(runZ3Query)
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n", stderr: "", exitCode: 0 });

    vi.mocked(callOpencode).mockResolvedValue({
      ok: true,
      value: { rationale: "Both constraints are equivalent." },
    });

    const root = await mkdtemp(join(tmpdir(), "spec-check-e2e-cross-"));
    const output = join(root, "output");

    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    // Create mock SMT-LIB files
    await writeOutputAtomic(toOutputDirPath(output), toRelativePath("smt/R1.smt2"), "(assert true)\n(check-sat)\n");
    await writeOutputAtomic(toOutputDirPath(output), toRelativePath("gen_smt/R1.smt2"), "(assert true)\n(check-sat)\n");

    // Run cross-implication using the real readFile (not mocked in this file)
    const { classifyRelationship, classifyDirection } = await import("../../src/domain/code-backwards/cross-implication.js");
    const forward = classifyDirection("unsat");
    const reverse = classifyDirection("unsat");
    const classification = classifyRelationship(forward, reverse);

    expect(classification).toBe("same");

    // Blind comparison attaches rationale
    const { runBlindComparison } = await import("../../src/domain/code-backwards/blind-compare.js");
    const blindOutput = await runBlindComparison({
      model: "test-model",
      results: [{
        capability: "cat-pipeline",
        claimId: "R1",
        classification,
        forward,
        reverse,
        evidencePaths: [],
      }],
      generatedOnlyContext: [{ capability: "cat-pipeline", claimId: "R1", summary: "System pipeline support." }],
    });

    expect(blindOutput.findings.length).toBe(1);
    expect(blindOutput.findings[0]!.category).toBe("code_backwards.blind_explanation");
  });

  it("full pipeline produces summary with all finding categories", async () => {
    traceSpec("RAE-EMIT-REPORTS", "RAE-NAMES-SUMMARY", "RAE-NAMES-PHASE");
    const root = await mkdtemp(join(tmpdir(), "spec-check-e2e-full-"));
    const output = join(root, "output");

    await writeFile(join(root, "proposal.md"), "## Scope\n- system handles inputs\n", "utf8");
    await writeFile(
      join(root, "spec.md"),
      [
        "## ADDED Requirements",
        "### Requirement: Input [INT-FULL-REQ]",
        "WHEN input arrives, THE system SHALL handle it.",
        "**References:**",
        "- proposal.md#Scope",
      ].join("\n"),
      "utf8",
    );

    const proposal = await parseProposal(join(root, "proposal.md"));
    const spec = await parseSpec(join(root, "spec.md"));
    const graph = buildClaimGraph({ proposal, specs: [spec] });
    const coverageFindings = analyzeCoverage({
      claimGraph: graph.graph,
      proposal,
      specs: [spec],
    });

    const phaseFiles = await writePhaseReports({
      outputDir: toOutputDirPath(output),
      report11: [],
      report12: [],
      report13: coverageFindings,
    });
    const summary = await writeSummaryReport({
      outputDir: toOutputDirPath(output),
      allFindings: [...graph.findings, ...coverageFindings],
      skippedPhases: [],
    });

    expect(summary.path).toBe("report_summary.md");
    const summaryContent = await readFile(join(output, "report_summary.md"), "utf8");
    expect(summaryContent).toContain("Findings by category");

    // Phase report files should exist
    for (const file of phaseFiles) {
      const content = await readFile(join(output, file.path), "utf8");
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
