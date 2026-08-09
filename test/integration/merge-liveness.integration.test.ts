import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runCli } from "../../src/cli/run-cli.js";
import { toClaimId, toModelName, toOutputDirPath } from "../../src/domain/branded.js";
import type { RunConfig } from "../../src/cli/config.js";
import {
  buildBatchContextFile,
  hashBatchContext,
  serializeBatchContextFile,
  type BatchAttemptEvidence,
  type IndexedBatchClaim,
} from "../../src/domain/formal/batch-transport.js";
import { groupFormalizationClaims } from "../../src/domain/formal/grouping.js";
import {
  buildFormalizationAttemptSet,
  writeFormalizationAttemptSet,
} from "../../src/domain/reporting/formalization-evidence.js";

vi.mock("../../src/cli/pipeline-helpers.js", async (importOriginal) => {
  const original = await (importOriginal() as Promise<Record<string, unknown>>);
  const groupRepresentativesBySpec = original.groupRepresentativesBySpec as (...args: readonly unknown[]) => unknown;
  const runCodeBackwardsWork = original.runCodeBackwardsWork as (...args: readonly unknown[]) => unknown;
  return {
    ...original,
    checkDependencies: () => undefined,
    groupRepresentativesBySpec: vi.fn((...args: readonly unknown[]) => groupRepresentativesBySpec(...args)),
    runCodeBackwardsWork: vi.fn((...args: readonly unknown[]) => runCodeBackwardsWork(...args)),
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
      batchAttempts: [],
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

function makeAttachedAttempt(
  batchKey: string,
  claims: readonly IndexedBatchClaim[],
  model = "test-model",
  outcome: BatchAttemptEvidence["outcome"] = { kind: "success" },
): BatchAttemptEvidence {
  const context = serializeBatchContextFile(buildBatchContextFile(batchKey, claims));
  return {
    batchKey,
    claimIndexes: claims.map((claim) => claim.index),
    claimIds: claims.map((entry) => entry.claim.id ?? null),
    provenanceFiles: claims.map((entry) => entry.claim.provenance.file),
    contextSha256: hashBatchContext(context),
    promptVariant: "attached-context-v1",
    model,
    subBatchOrdinal: 0,
    outcome,
    cleanup: "succeeded",
  };
}

describe("merge liveness integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes each non-empty merged capability exactly once across downstream phases", async () => {
    traceSpec("CGC-GRAPH-DETERMINISM", "CGC-COVERAGE-DETERMINISM", "FLA-RUN-LOGIC", "MCA-LIVENESS", "MCA-LIVENESS-NONEMPTY", "MCA-MERGE-LOGICAL", "MCA-SOLVER-SHARED-KEY");
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
    const { formalizeClaims } = await import("../../src/domain/formal/formalize.js");
    const { groupRepresentativesBySpec } = await import("../../src/cli/pipeline-helpers.js");
    const claimGraphInput = buildClaimGraphSpy.mock.calls[0]?.[0];
    const coverageInput = analyzeCoverageSpy.mock.calls[0]?.[0];
    const logicInput = vi.mocked(runLogicAnalysis).mock.calls[0]?.[0];
    const formalizationMap = vi.mocked(formalizeClaims).mock.calls[0]?.[0].logicalFileByCapability;
    const solverGroupingMap = vi.mocked(groupRepresentativesBySpec).mock.calls[0]?.[2];

    expect(buildClaimGraphSpy).toHaveBeenCalledTimes(1);
    expect(analyzeCoverageSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runLogicAnalysis)).toHaveBeenCalledTimes(1);
    expect(formalizationMap).toBeDefined();
    expect(solverGroupingMap).toBe(formalizationMap);

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

  it("keeps partial formalization failures visible in successful output order", async () => {
    traceSpec("FLA-FORMALIZE-CLAIMS", "RAE-FINDINGS-IMMUTABLE");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-partial-formal-"));
    const outputDir = join(root, "output");
    const specDir = join(root, "specs", "partial");
    await mkdir(outputDir, { recursive: true });
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, "spec.md"),
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Successful Claim [PARTIAL-SUCCESS]",
        "WHEN valid input arrives, THE system SHALL process it.",
        "",
        "### Requirement: Failed Claim [PARTIAL-FAILED]",
        "WHEN another input arrives, THE system SHALL record it.",
      ].join("\n"),
      "utf8",
    );

    const { formalizeClaims } = await import("../../src/domain/formal/formalize.js");
    vi.mocked(formalizeClaims).mockImplementationOnce(async (input) => {
      const eligible = input.claims.filter((claim) => claim.kind === "requirement" || claim.kind === "scenario");
      const successfulClaim = eligible[0]!;
      const failedClaim = eligible[1]!;
      return {
        ok: true,
        value: {
          candidates: [{
            claim: successfulClaim,
            eligibleIndex: 0,
            samples: [{
              claimId: toClaimId("PARTIAL-SUCCESS"),
              obligation: successfulClaim.obligation,
              variables: [{ name: "S", sort: "Bool" as const }],
              functions: [],
              assertions: [{ id: "A1", expr: "true" }],
            }],
            invalidSamples: [],
          }],
          findings: [{
            severity: "info" as const,
            category: "formalization.existing",
            provenance: successfulClaim.provenance,
            description: "Existing formalization diagnostic",
            rationale: "Verifies stable append order.",
            evidence: [],
          }],
          errors: [{
            message: "failed to formalize claim PARTIAL-FAILED: invalid model output",
            eligibleIndex: 1,
            ...(failedClaim.id === undefined ? {} : { claimId: failedClaim.id }),
          }],
          batchAttempts: [],
        },
      };
    });

    const state = await runCli(makeConfig(root, outputDir));
    const formalizationFindings = state.findings.filter((finding) => finding.category.startsWith("formalization."));
    expect(formalizationFindings.map((finding) => finding.category)).toEqual([
      "formalization.existing",
      "formalization.claim_failed",
    ]);
    expect(formalizationFindings[1]).toMatchObject({
      severity: "warning",
      provenance: { file: join(specDir, "spec.md"), line: 6 },
      evidence: [
        { kind: "eligible_index", value: "1" },
        { kind: "claim_id", value: "PARTIAL-FAILED" },
      ],
    });

    const summary = await readFile(join(outputDir, "report_summary.md"), "utf8");
    expect(summary).toContain("formalization.claim_failed");
  });

  it("still aborts when every formalization claim fails", async () => {
    traceSpec(
      "FLA-FORMALIZE-CLAIMS",
      "FLA-PARTITION-ABORT",
      "FLA-EVIDENCE-NOT-COMPLETE",
      "RAE-FORMAL-ATTEMPT-FAILED-RUN",
      "RAE-MANIFEST-ATTEMPT-INCOMPLETE",
    );
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-all-formal-errors-"));
    const outputDir = join(root, "output");
    const specDir = join(root, "specs", "failed");
    await mkdir(outputDir, { recursive: true });
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, "spec.md"),
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Failed Claim [ALL-FAILED]",
        "WHEN input arrives, THE system SHALL process it.",
        "",
        "### Requirement: Also Failed Claim [ALSO-FAILED]",
        "WHEN another input arrives, THE system SHALL reject it.",
      ].join("\n"),
      "utf8",
    );

    const { formalizeClaims } = await import("../../src/domain/formal/formalize.js");
    let failedAttempt: BatchAttemptEvidence | undefined;
    vi.mocked(formalizeClaims).mockImplementationOnce(async (input) => {
      const group = groupFormalizationClaims(input.claims, input.logicalFileByCapability)[0];
      if (group === undefined) throw new Error("expected failed attached formalization group");
      failedAttempt = makeAttachedAttempt(
        group.logicalFile,
        group.claims,
        input.model,
        { kind: "model_failure", errorKind: "schema_validation_error" },
      );
      return {
        ok: true,
        value: {
          candidates: [],
          findings: [],
          errors: group.claims.map((claim) => ({
            message: `failed to formalize claim ${claim.claim.id ?? "<unnamed>"}: invalid model output`,
            eligibleIndex: claim.index,
            ...(claim.claim.id === undefined ? {} : { claimId: claim.claim.id }),
          })),
          batchAttempts: [failedAttempt],
        },
      };
    });

    await expect(runCli(makeConfig(root, outputDir))).rejects.toMatchObject({
      name: "PipelineAbortError",
      category: "FormalizationError",
    });

    const evidenceBytes = await readFile(join(outputDir, "formalization_evidence", "specs_forward.json"), "utf8");
    const evidence = JSON.parse(evidenceBytes) as {
      readonly schemaVersion: number;
      readonly claimSet: { readonly kind: string };
      readonly attempts: readonly BatchAttemptEvidence[];
    };
    expect(evidence).toEqual({
      schemaVersion: 1,
      claimSet: { kind: "specs_forward" },
      attempts: [failedAttempt],
    });
    expect(evidence.attempts).toHaveLength(1);
    expect(evidence.attempts[0]?.claimIndexes).toEqual([0, 1]);
    expect(evidence.attempts[0]?.outcome).toEqual({
      kind: "model_failure",
      errorKind: "schema_validation_error",
    });
    expect(evidenceBytes).not.toContain("THE system SHALL process it");
    expect(evidenceBytes).not.toContain("THE system SHALL reject it");
    await expect(access(join(outputDir, "manifest.json"))).rejects.toThrow();
  });

  it("removes stale formalization evidence at run start and checksums the replacement", async () => {
    traceSpec("RAE-MANIFEST-ATTEMPT-EVIDENCE");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-stale-evidence-"));
    const outputDir = join(root, "output");
    const specDir = join(root, "specs", "active");
    const srcDir = join(root, "src");
    await mkdir(join(outputDir, "formalization_evidence", "nested"), { recursive: true });
    await mkdir(specDir, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(outputDir, "manifest.json"), "{\"stale\":true}\n", "utf8");
    await writeFile(join(outputDir, "formalization_evidence", "nested", "stale.json"), "stale\n", "utf8");
    await writeFile(join(srcDir, "active.ts"), "export const active = true;\n", "utf8");
    await writeFile(
      join(specDir, "spec.md"),
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Active Claim [ACTIVE-REQ]",
        "WHEN input arrives, THE system SHALL process manifest-secret-one.",
        "",
        "### Requirement: Second Active Claim [SECOND-ACTIVE-REQ]",
        "WHEN another input arrives, THE system SHALL process manifest-secret-two.",
      ].join("\n"),
      "utf8",
    );

    const { formalizeClaims } = await import("../../src/domain/formal/formalize.js");
    vi.mocked(formalizeClaims).mockImplementationOnce(async (input) => {
      const group = groupFormalizationClaims(input.claims, input.logicalFileByCapability)[0];
      if (group === undefined) throw new Error("expected successful attached formalization group");
      return {
        ok: true,
        value: {
          candidates: group.claims.map((entry) => ({
            claim: entry.claim,
            eligibleIndex: entry.index,
            samples: [{
              claimId: toClaimId(entry.claim.id ?? `AUTO-${String(entry.index)}`),
              obligation: entry.claim.obligation,
              variables: [{ name: "S", sort: "Bool" as const }],
              functions: [],
              assertions: [{ id: "A1", expr: "true" }],
            }],
            invalidSamples: [],
          })),
          findings: [],
          errors: [],
          batchAttempts: [makeAttachedAttempt(group.logicalFile, group.claims, input.model)],
        },
      };
    });
    const generatedClaimTexts = ["generated manifest-secret-one", "generated manifest-secret-two"];
    const generatedClaims = generatedClaimTexts.map((text, index) => ({
      index,
      claim: {
        id: toClaimId(`GENERATED-${String(index + 1)}`),
        obligation: "mandatory" as const,
        provenance: { file: "<gen_specs/generated-capability.md>" },
        text,
      },
    }));
    const { runCodeBackwardsWork } = await import("../../src/cli/pipeline-helpers.js");
    vi.mocked(runCodeBackwardsWork).mockImplementationOnce(async (config) => {
      const first = await writeFormalizationAttemptSet(
        config.output,
        buildFormalizationAttemptSet(
          { kind: "generated_spec", ordinal: 0, capability: "generated-capability" },
          [makeAttachedAttempt("<merged-spec/generated-capability>", generatedClaims)],
        ),
      );
      const second = await writeFormalizationAttemptSet(
        config.output,
        buildFormalizationAttemptSet(
          { kind: "generated_spec", ordinal: 1, capability: "generated-capability" },
          [makeAttachedAttempt("<merged-spec/generated-capability>", generatedClaims)],
        ),
      );
      return {
        allFindings: [],
        logicFindings: [],
        compareFindings: [],
        evidenceFiles: [first, second],
      };
    });

    await runCli({ ...makeConfig(root, outputDir), src: srcDir });

    await expect(access(join(outputDir, "formalization_evidence", "nested"))).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as {
      readonly files: readonly { readonly path: string; readonly checksum: string }[];
      readonly formalizationBatchAttempts?: unknown;
    };
    const { sha256Hex } = await import("../../src/adapters/fs.js");
    const evidenceNames = await readdir(join(outputDir, "formalization_evidence"));
    const evidencePaths = evidenceNames.map((name) => `formalization_evidence/${name}`).sort();
    const evidenceEntries = manifest.files
      .filter((entry) => entry.path.startsWith("formalization_evidence/"))
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(evidencePaths).toEqual([
      "formalization_evidence/generated_spec_000000_67656e6572617465642d6361706162696c697479.json",
      "formalization_evidence/generated_spec_000001_67656e6572617465642d6361706162696c697479.json",
      "formalization_evidence/specs_forward.json",
    ]);
    expect(evidenceEntries.map((entry) => entry.path)).toEqual(evidencePaths);
    for (const entry of evidenceEntries) {
      const evidenceBytes = await readFile(join(outputDir, entry.path), "utf8");
      const envelope = JSON.parse(evidenceBytes) as { readonly attempts: readonly unknown[] };
      expect(envelope.attempts).toHaveLength(1);
      expect(entry.checksum).toBe(sha256Hex(evidenceBytes));
      expect(evidenceBytes).not.toContain("manifest-secret-one");
      expect(evidenceBytes).not.toContain("manifest-secret-two");
    }
    expect(manifest.formalizationBatchAttempts).toBeUndefined();
  });

});
