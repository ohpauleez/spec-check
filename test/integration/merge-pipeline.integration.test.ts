import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runCli } from "../../src/cli/run-cli.js";
import { toModelName, toOutputDirPath } from "../../src/domain/branded.js";
import { toRelativePath } from "../../src/domain/branded.js";
import type { RunConfig } from "../../src/cli/config.js";

vi.mock("../../src/cli/pipeline-helpers.js", async (importOriginal) => {
  const original = await (importOriginal() as Promise<Record<string, unknown>>);
  return {
    ...original,
    checkDependencies: () => undefined,
  };
});

vi.mock("../../src/domain/spec-forward/qualitative.js", () => ({
  runQualitativePasses: vi.fn(async () => ({
    ok: true,
    value: {
      pass1Findings: [],
      pass2Findings: [],
      rawResponses: [],
    },
  })),
}));

vi.mock("../../src/domain/formal/formalize.js", () => ({
  formalizeClaims: vi.fn(async () => ({
    ok: true,
    value: {
      candidates: [],
      findings: [],
      errors: [],
      batchAttempts: [],
    },
  })),
}));

vi.mock("../../src/domain/reporting/final-report.js", async (importOriginal) => {
  const original = await (importOriginal() as Promise<Record<string, unknown>>);
  const removeFinalReport = original.removeFinalReport as (output: unknown) => Promise<void>;
  return {
    ...original,
    removeFinalReport: vi.fn(async (output: unknown) => await removeFinalReport(output)),
    generateFinalReport: vi.fn(async () => ({
      ok: true,
      value: { path: "report.md", content: "# Final\n" },
    })),
  };
});

vi.mock("../../src/domain/reporting/render.js", async (importOriginal) => {
  const original = await (importOriginal() as Promise<Record<string, unknown>>);
  const writeSummaryReport = original.writeSummaryReport as (...args: readonly unknown[]) => Promise<unknown>;
  return {
    ...original,
    writeSummaryReport: vi.fn(async (...args: readonly unknown[]) => await writeSummaryReport(...args)),
  };
});

vi.mock("../../src/domain/reporting/manifest.js", async (importOriginal) => {
  const original = await (importOriginal() as Promise<Record<string, unknown>>);
  const writeManifest = original.writeManifest as (...args: readonly unknown[]) => Promise<void>;
  return {
    ...original,
    writeManifest: vi.fn(async (...args: readonly unknown[]) => await writeManifest(...args)),
  };
});

function makeConfig(inputRoot: string, output: string): RunConfig {
  return {
    inputs: [inputRoot],
    output: toOutputDirPath(output),
    src: undefined,
    caps: undefined,
    z3: undefined,
    model: toModelName("test-model"),
    pairBudget: 100,
    timeoutMs: 300_000,
    maxBatchSize: 32,
    allowArchive: false,
  };
}

describe("merge pipeline integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SPEC_CHECK_TELEMETRY;
  });

  afterEach(() => {
    delete process.env.SPEC_CHECK_TELEMETRY;
  });

  it("keeps merge findings visible and ordered before downstream findings", async () => {
    traceSpec("RAE-FINDINGS-IMMUTABLE", "CGC-FIND-MISSING");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-merge-"));
    const outputDir = join(root, "output");
    const finalSpecDir = join(root, "specs", "cap-merge");
    const deltaSpecDir = join(root, "openspec", "changes", "merge-change", "specs", "cap-merge");
    await mkdir(outputDir, { recursive: true });
    await mkdir(finalSpecDir, { recursive: true });
    await mkdir(deltaSpecDir, { recursive: true });

    await writeFile(join(root, "proposal.md"), "## Scope\n- tracks telemetry metrics\n", "utf8");

    await writeFile(
      join(finalSpecDir, "spec.md"),
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Base Requirement [CAP-MERGE-BASE]",
        "WHEN request arrives, THE system SHALL process input.",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(deltaSpecDir, "spec.md"),
      [
        "### Requirement: Pre Section [CAP-MERGE-PRE]",
        "WHEN presection appears, THE system SHALL record a warning.",
        "",
        "## ADDED Requirements",
        "",
        "### Requirement: Delta Requirement [CAP-MERGE-DELTA]",
        "WHEN delta input appears, THE system SHALL include delta behavior.",
      ].join("\n"),
      "utf8",
    );

    const state = await runCli(makeConfig(root, outputDir));
    const categories = state.findings.map((finding) => finding.category);
    const mergeFindingIndex = categories.indexOf("spec_merge.pre_section_content");
    const coverageFindingIndex = categories.indexOf("coverage.uncovered_upstream_claim");

    expect(mergeFindingIndex).toBeGreaterThanOrEqual(0);
    expect(coverageFindingIndex).toBeGreaterThan(mergeFindingIndex);

    const summary = await readFile(join(outputDir, "report_summary.md"), "utf8");
    expect(summary).toContain("spec_merge.pre_section_content");
    const { generateFinalReport } = await import("../../src/domain/reporting/final-report.js");
    expect(generateFinalReport).toHaveBeenCalledWith(expect.objectContaining({
      additionalReadPaths: expect.arrayContaining([resolve(root)]),
    }));
  });

  it("writes and manifests opt-in run metrics", async () => {
    traceSpec("RAE-RUN-METRICS", "RAE-METRICS-MANIFEST");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-metrics-"));
    const outputDir = join(root, "output");
    const specDir = join(root, "specs", "metrics");
    await mkdir(outputDir, { recursive: true });
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, "spec.md"),
      "## ADDED Requirements\n\n### Requirement: Metrics [METRICS-REQ]\nTHE system SHALL record metrics.\n",
      "utf8",
    );
    process.env.SPEC_CHECK_TELEMETRY = "1";

    await runCli(makeConfig(root, outputDir));

    const metrics = JSON.parse(await readFile(join(outputDir, "metrics.json"), "utf8")) as {
      readonly phases: readonly { readonly phase: string }[];
    };
    const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as {
      readonly files: readonly { readonly path: string; readonly phase: string }[];
    };
    expect(metrics.phases.some((phase) => phase.phase === "reporting")).toBe(true);
    expect(manifest.files).toContainEqual(expect.objectContaining({ path: "metrics.json", phase: "metrics" }));
  });

  it("persists a nonfatal final-report warning and refreshes the summary checksum", async () => {
    traceSpec(
      "RAE-FINAL-REPORT", "RAE-FINAL-AFTER-CORE", "RAE-FINAL-OPTIONAL",
      "RAE-FINAL-WARNING", "RAE-FINAL-WARN-KIND", "RAE-FINAL-WARN-HASH",
      "RAE-FINAL-WARN-COMPLETE", "RAE-MANIFEST-NO-FINAL",
    );
    const { generateFinalReport } = await import("../../src/domain/reporting/final-report.js");
    vi.mocked(generateFinalReport).mockResolvedValueOnce({
      ok: false,
      error: { kind: "report_missing", message: "final report was not created" },
    });
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-final-warning-"));
    const outputDir = join(root, "output");
    const specDir = join(root, "specs", "warning");
    await mkdir(outputDir, { recursive: true });
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, "spec.md"),
      "## ADDED Requirements\n\n### Requirement: Warning [WARNING-REQ]\nTHE system SHALL continue.\n",
      "utf8",
    );

    const state = await runCli(makeConfig(root, outputDir));
    expect(state.findings).toContainEqual(expect.objectContaining({
      severity: "warning",
      category: "reporting.final_report_failed",
      evidence: [{ kind: "failure_kind", value: "report_missing" }],
    }));
    const summary = await readFile(join(outputDir, "report_summary.md"), "utf8");
    expect(summary).toContain("reporting.final\\_report\\_failed");
    expect(summary).toContain("failure\\_kind=report\\_missing");
    const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as {
      readonly files: readonly { readonly path: string; readonly checksum: string }[];
    };
    expect(manifest.files.some((entry) => entry.path === "report.md")).toBe(false);
    const summaryEntry = manifest.files.find((entry) => entry.path === "report_summary.md");
    const { sha256Hex } = await import("../../src/adapters/fs.js");
    expect(summaryEntry?.checksum).toBe(sha256Hex(summary));
  });

  it.each([
    "agent_failed", "acknowledgment_invalid", "path_unsupported", "path_mismatch",
    "report_missing", "report_symlink", "report_not_regular", "report_empty",
    "report_structure_invalid", "report_too_large", "report_unreadable",
  ] as const)("persists warning for final-report %s degradation", async (kind) => {
    traceSpec("RAE-FINAL-OPTIONAL", "RAE-FINAL-WARN-KIND");
    const { generateFinalReport } = await import("../../src/domain/reporting/final-report.js");
    vi.mocked(generateFinalReport).mockResolvedValueOnce({ ok: false, error: { kind, message: kind } });
    const { root, outputDir } = await minimalPipelineFixture(`degrade-${kind.replaceAll("_", "-")}`);
    const state = await runCli(makeConfig(root, outputDir));
    expect(state.findings).toContainEqual(expect.objectContaining({
      category: "reporting.final_report_failed",
      evidence: [{ kind: "failure_kind", value: kind }],
    }));
  });

  it("removes stale report output before the current final-report attempt", async () => {
    traceSpec("RAE-FINAL-CLEAN-STALE", "RAE-FINAL-CLEAN-MANAGED", "RAE-FINAL-SAVE", "RAE-MANIFEST-NO-FINAL");
    const { generateFinalReport } = await import("../../src/domain/reporting/final-report.js");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-final-stale-"));
    const outputDir = join(root, "output");
    const specDir = join(root, "specs", "stale");
    await mkdir(outputDir, { recursive: true });
    await mkdir(specDir, { recursive: true });
    await writeFile(join(outputDir, "report.md"), "stale", "utf8");
    await writeFile(join(outputDir, "report_summary.md.tmp-123-abcd"), "partial", "utf8");
    await writeFile(join(outputDir, "report_2.trace.md"), "stale", "utf8");
    await mkdir(join(outputDir, "cross_implication"));
    await writeFile(join(outputDir, "cross_implication", "stale.smt2"), "stale", "utf8");
    await writeFile(
      join(specDir, "spec.md"),
      "## ADDED Requirements\n\n### Requirement: Stale [STALE-REQ]\nTHE system SHALL continue.\n",
      "utf8",
    );
    vi.mocked(generateFinalReport).mockImplementationOnce(async () => {
      await expect(readFile(join(outputDir, "report.md"), "utf8")).rejects.toThrow();
      await expect(readFile(join(outputDir, "report_2.trace.md"), "utf8")).rejects.toThrow();
      await expect(readFile(join(outputDir, "report_summary.md.tmp-123-abcd"), "utf8")).rejects.toThrow();
      await expect(access(join(outputDir, "cross_implication"))).rejects.toThrow();
      await writeFile(join(outputDir, "report.md"), "# Current\n", "utf8");
      return { ok: true, value: { path: toRelativePath("report.md"), content: "# Current\n" } };
    });
    await runCli(makeConfig(root, outputDir));
    expect(await readFile(join(outputDir, "report.md"), "utf8")).toBe("# Current\n");
    const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as {
      readonly files: readonly { readonly path: string }[];
    };
    expect(manifest.files.some((entry) => entry.path === "report.md")).toBe(false);
  });

  it("surfaces run-start managed-output cleanup failure before ingestion", async () => {
    traceSpec("RAE-FINAL-CLEAN-START-ERROR");
    const { generateFinalReport, removeFinalReport } = await import("../../src/domain/reporting/final-report.js");
    vi.mocked(removeFinalReport).mockRejectedValueOnce(new Error("startup cleanup denied"));
    const { root, outputDir } = await minimalPipelineFixture("startup-cleanup-failure");
    await writeFile(join(outputDir, "manifest.json"), "{\"stale\":true}\n", "utf8");
    await expect(runCli(makeConfig(root, outputDir))).rejects.toMatchObject({
      category: "OutputError", message: expect.stringContaining("startup cleanup denied"),
    });
    await expect(access(join(outputDir, "manifest.json"))).rejects.toThrow();
    expect(generateFinalReport).not.toHaveBeenCalled();
  });

  it("supports consecutive runs against the same output directory", async () => {
    traceSpec("RAE-FINAL-CLEAN-MANAGED", "RAE-MANIFEST-STALE");
    const { root, outputDir } = await minimalPipelineFixture("same-output-rerun");
    const config = makeConfig(root, outputDir);
    await runCli(config);
    await runCli(config);
    const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as {
      readonly files: readonly { readonly path: string }[];
    };
    expect(manifest.files).toContainEqual(expect.objectContaining({
      path: "formalization_evidence/specs_forward.json",
    }));
  });

  it("surfaces cleanup failure instead of claiming warning-without-report", async () => {
    traceSpec("RAE-FINAL-CLEAN-ERROR", "RAE-FINAL-OUTPUT-ERROR");
    const { generateFinalReport, removeFinalReport } = await import("../../src/domain/reporting/final-report.js");
    vi.mocked(generateFinalReport).mockResolvedValueOnce({
      ok: false,
      error: { kind: "report_empty", message: "invalid partial report" },
    });
    vi.mocked(removeFinalReport)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cleanup denied"));
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-final-cleanup-"));
    const outputDir = join(root, "output");
    const specDir = join(root, "specs", "cleanup");
    await mkdir(outputDir, { recursive: true });
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, "spec.md"),
      "## ADDED Requirements\n\n### Requirement: Cleanup [CLEANUP-REQ]\nTHE system SHALL continue.\n",
      "utf8",
    );
    await expect(runCli(makeConfig(root, outputDir))).rejects.toMatchObject({
      category: "OutputError",
      message: expect.stringContaining("cleanup denied"),
    });
  });

  it("surfaces warning-summary persistence failure as OutputError", async () => {
    traceSpec("RAE-FINAL-CLEAN-ERROR", "RAE-FINAL-OUTPUT-ERROR", "RAE-FINAL-WARN-HASH");
    const { generateFinalReport } = await import("../../src/domain/reporting/final-report.js");
    const { writeSummaryReport } = await import("../../src/domain/reporting/render.js");
    vi.mocked(generateFinalReport).mockResolvedValueOnce({
      ok: false, error: { kind: "report_missing", message: "missing" },
    });
    const defaultSummary = vi.mocked(writeSummaryReport).getMockImplementation();
    expect(defaultSummary).toBeDefined();
    vi.mocked(writeSummaryReport)
      .mockImplementationOnce(defaultSummary!)
      .mockRejectedValueOnce(new Error("summary denied"));
    const { root, outputDir } = await minimalPipelineFixture("summary-failure");
    await expect(runCli(makeConfig(root, outputDir))).rejects.toMatchObject({
      category: "OutputError", message: expect.stringContaining("summary denied"),
    });
    await expect(access(join(outputDir, "manifest.json"))).rejects.toThrow();
  });

  it("surfaces refreshed-manifest failure as OutputError", async () => {
    traceSpec("RAE-FINAL-WARN-HASH");
    const { generateFinalReport } = await import("../../src/domain/reporting/final-report.js");
    const { writeManifest } = await import("../../src/domain/reporting/manifest.js");
    vi.mocked(generateFinalReport).mockResolvedValueOnce({
      ok: false, error: { kind: "report_missing", message: "missing" },
    });
    const defaultManifest = vi.mocked(writeManifest).getMockImplementation();
    expect(defaultManifest).toBeDefined();
    vi.mocked(writeManifest)
      .mockImplementationOnce(defaultManifest!)
      .mockRejectedValueOnce(new Error("manifest denied"));
    const { root, outputDir } = await minimalPipelineFixture("manifest-failure");
    await expect(runCli(makeConfig(root, outputDir))).rejects.toMatchObject({
      category: "OutputError", message: expect.stringContaining("manifest denied"),
    });
    await expect(access(join(outputDir, "manifest.json"))).rejects.toThrow();
  });
});

async function minimalPipelineFixture(name: string): Promise<{ readonly root: string; readonly outputDir: string }> {
  const root = await mkdtemp(join(tmpdir(), `spec-check-int-${name}-`));
  const outputDir = join(root, "output");
  const specDir = join(root, "specs", name);
  await mkdir(outputDir, { recursive: true });
  await mkdir(specDir, { recursive: true });
  await writeFile(
    join(specDir, "spec.md"),
    `## ADDED Requirements\n\n### Requirement: Fixture [FIXTURE-${name.toUpperCase()}]\nTHE system SHALL continue.\n`,
    "utf8",
  );
  return { root, outputDir };
}
