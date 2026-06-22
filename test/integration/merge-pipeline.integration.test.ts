import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runCli } from "../../src/cli/run-cli.js";
import { toModelName, toOutputDirPath } from "../../src/domain/branded.js";
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
    },
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

describe("merge pipeline integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });
});
