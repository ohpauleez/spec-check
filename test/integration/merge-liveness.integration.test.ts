import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runCli } from "../../src/cli/run-cli.js";
import { toClaimId, toModelName, toOutputDirPath } from "../../src/domain/branded.js";
import type { RunConfig } from "../../src/cli/config.js";

vi.mock("../../src/cli/pipeline-helpers.js", async (importOriginal) => {
  const original = await (importOriginal() as Promise<Record<string, unknown>>);
  return {
    ...original,
    checkDependencies: () => undefined,
    runClusteringPhase: async (
      _config: unknown,
      candidates: readonly { readonly samples: readonly unknown[] }[],
    ) => ({
      representatives: candidates.map((candidate) => candidate.samples[0]).filter((sample): sample is NonNullable<typeof sample> => sample !== undefined),
      findings: [],
    }),
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
  formalizeClaims: vi.fn(async (input: { readonly claims: readonly { readonly id?: string; readonly obligation: "mandatory" | "advisory" | "informational" }[] }) => ({
    ok: true,
    value: {
      candidates: input.claims.map((claim, index) => ({
        claim,
        samples: [{
          claimId: toClaimId(claim.id ?? `AUTO-${String(index)}`),
          obligation: claim.obligation,
          variables: [{ name: "S", sort: "Bool" as const }],
          functions: [],
          assertions: [{ id: "A1", expr: "true" }],
        }],
        invalidSamples: [],
      })),
      findings: [],
      errors: [],
    },
  })),
}));

vi.mock("../../src/domain/formal/logic-analysis.js", () => ({
  runLogicAnalysis: vi.fn(async () => ({
    findings: [],
    reportMarkdown: "# report_1.logic.md\n\n## Solver Findings\n\n",
  })),
}));

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
    allowArchive: false,
  };
}

describe("merge liveness integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes each non-empty merged capability exactly once across downstream phases", async () => {
    traceSpec("CGC-GRAPH-DETERMINISM", "CGC-COVERAGE-DETERMINISM", "FLA-RUN-LOGIC", "MCA-LIVENESS", "MCA-LIVENESS-NONEMPTY", "MCA-MERGE-LOGICAL");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-merge-live-"));
    const outputDir = join(root, "output");
    await mkdir(outputDir, { recursive: true });

    const finalCapA = join(root, "specs", "cap-a");
    const finalCapB = join(root, "specs", "cap-b");
    const finalCapEmpty = join(root, "specs", "cap-empty");
    const deltaCapA = join(root, "openspec", "changes", "live-change", "specs", "cap-a");
    const deltaCapEmpty = join(root, "openspec", "changes", "live-change", "specs", "cap-empty");
    await mkdir(finalCapA, { recursive: true });
    await mkdir(finalCapB, { recursive: true });
    await mkdir(finalCapEmpty, { recursive: true });
    await mkdir(deltaCapA, { recursive: true });
    await mkdir(deltaCapEmpty, { recursive: true });

    await writeFile(
      join(finalCapA, "spec.md"),
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Cap A Base [CAP-A-BASE]",
        "WHEN base input appears, THE system SHALL process base behavior.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(deltaCapA, "spec.md"),
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Cap A Delta [CAP-A-DELTA]",
        "WHEN delta input appears, THE system SHALL process delta behavior.",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(finalCapB, "spec.md"),
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Cap B Base [CAP-B-BASE]",
        "WHEN cap b input appears, THE system SHALL process cap b behavior.",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(finalCapEmpty, "spec.md"),
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Cap Empty Base [CAP-EMPTY-BASE]",
        "WHEN empty base exists, THE system SHALL keep temporary behavior.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(deltaCapEmpty, "spec.md"),
      [
        "## REMOVED Requirements",
        "",
        "### Requirement: Cap Empty Remove [CAP-EMPTY-BASE]",
        "WHEN removed, THE system SHALL remove behavior.",
      ].join("\n"),
      "utf8",
    );

    const claimGraphModule = await import("../../src/domain/claim-graph.js");
    const coverageModule = await import("../../src/domain/spec-forward/coverage.js");
    const buildClaimGraphSpy = vi.spyOn(claimGraphModule, "buildClaimGraph");
    const analyzeCoverageSpy = vi.spyOn(coverageModule, "analyzeCoverage");

    const state = await runCli(makeConfig(root, outputDir));

    const { runLogicAnalysis } = await import("../../src/domain/formal/logic-analysis.js");
    const claimGraphInput = buildClaimGraphSpy.mock.calls[0]?.[0];
    const coverageInput = analyzeCoverageSpy.mock.calls[0]?.[0];
    const logicInput = vi.mocked(runLogicAnalysis).mock.calls[0]?.[0];

    expect(buildClaimGraphSpy).toHaveBeenCalledTimes(1);
    expect(analyzeCoverageSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runLogicAnalysis)).toHaveBeenCalledTimes(1);

    expect(claimGraphInput?.mergedSpecs?.map((spec) => spec.capability)).toEqual(["cap-a", "cap-b"]);
    expect(coverageInput?.mergedSpecs?.map((spec) => spec.capability)).toEqual(["cap-a", "cap-b"]);

    const logicGroupFiles = logicInput?.groups.map((group) => group.specFile) ?? [];
    expect(logicGroupFiles).toEqual(["<merged-spec/cap-a>", "<merged-spec/cap-b>"]);
    expect(new Set(logicGroupFiles).size).toBe(logicGroupFiles.length);

    expect(state.findings.some((finding) => finding.category === "spec_merge.empty_capability_skipped")).toBe(true);
  });

  it("routes only active merged requirements to logic inputs (removed excluded, modified retained)", async () => {
    traceSpec("FLA-FORMALIZE-CLAIMS", "FLA-RUN-LOGIC", "CGC-COVERAGE-REMOVED", "MCA-LIVENESS-ASSERT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-merge-active-"));
    const outputDir = join(root, "output");
    const finalCapA = join(root, "specs", "cap-a");
    const deltaCapA = join(root, "openspec", "changes", "active-change", "specs", "cap-a");
    await mkdir(outputDir, { recursive: true });
    await mkdir(finalCapA, { recursive: true });
    await mkdir(deltaCapA, { recursive: true });

    await writeFile(
      join(finalCapA, "spec.md"),
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Keep Base [CAP-A-KEEP]",
        "WHEN base keep appears, THE system SHALL keep base behavior.",
        "",
        "### Requirement: Remove Base [CAP-A-REMOVE]",
        "WHEN base remove appears, THE system SHALL remove base behavior.",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(deltaCapA, "spec.md"),
      [
        "## MODIFIED Requirements",
        "",
        "### Requirement: Keep Delta [CAP-A-KEEP]",
        "WHEN delta keep appears, THE system SHALL keep delta behavior.",
        "",
        "## REMOVED Requirements",
        "",
        "### Requirement: Remove Delta [CAP-A-REMOVE]",
        "WHEN delta remove appears, THE system SHALL remove delta behavior.",
      ].join("\n"),
      "utf8",
    );

    await runCli(makeConfig(root, outputDir));

    const { formalizeClaims } = await import("../../src/domain/formal/formalize.js");
    const formalizeInput = vi.mocked(formalizeClaims).mock.calls[0]?.[0];
    const claimIds = formalizeInput?.claims
      .map((claim) => (claim.id === undefined ? undefined : String(claim.id)))
      .filter((id): id is string => id !== undefined) ?? [];

    expect(claimIds).toContain("CAP-A-KEEP");
    expect(claimIds).not.toContain("CAP-A-REMOVE");
  });

});
