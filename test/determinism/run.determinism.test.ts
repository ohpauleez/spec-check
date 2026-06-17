import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { parseProposal } from "../../src/domain/parser/proposal.js";
import { parseDesign } from "../../src/domain/parser/design.js";
import { parseSpec } from "../../src/domain/parser/spec.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { analyzeCoverage } from "../../src/domain/spec-forward/coverage.js";
import { writePhaseReports, writeSummaryReport } from "../../src/domain/reporting/render.js";
import { buildManifestEntries, writeManifest } from "../../src/domain/reporting/manifest.js";
import { toOutputDirPath } from "../../src/domain/branded.js";

describe("determinism", () => {
  it("produces stable summary output for same deterministic input", async () => {
    traceSpec("CGC-GRAPH-DETERMINISM", "CGC-DETERM-SAME", "CGC-COVERAGE-DETERMINISM", "CGC-COVDET-SAME");
    const root = await mkdtemp(join(tmpdir(), "spec-check-det-"));
    const outA = join(root, "out-a");
    const outB = join(root, "out-b");

    const proposal = join(root, "proposal.md");
    const design = join(root, "design.md");
    const spec = join(root, "spec.md");

    await writeFile(proposal, "## Scope\n- stable\n", "utf8");
    await writeFile(design, "## Goals\n- stable\n", "utf8");
    await writeFile(
      spec,
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Stable [CAT-STABLE-REQ]",
        "WHEN stable input exists, THE system SHALL be stable.",
        "",
        "**References:**",
        "- proposal.md#Scope",
      ].join("\n"),
      "utf8",
    );

    const parsedProposal = await parseProposal(proposal);
    const parsedDesign = await parseDesign(design);
    const parsedSpec = await parseSpec(spec);

    const graph = buildClaimGraph({
      proposal: parsedProposal,
      design: parsedDesign,
      specs: [parsedSpec],
    });

    const coverageFindings = analyzeCoverage({
      claimGraph: graph.graph,
      proposal: parsedProposal,
      specs: [parsedSpec],
    });

    const phaseFilesA = await writePhaseReports({
      outputDir: toOutputDirPath(outA),
      report11: [],
      report12: [],
      report13: coverageFindings,
    });
    const summaryAFile = await writeSummaryReport({
      outputDir: toOutputDirPath(outA),
      allFindings: coverageFindings,
      skippedPhases: ["source-traceability"],
    });
    await writeManifest(toOutputDirPath(outA), buildManifestEntries([...phaseFilesA, summaryAFile]));

    const phaseFilesB = await writePhaseReports({
      outputDir: toOutputDirPath(outB),
      report11: [],
      report12: [],
      report13: coverageFindings,
    });
    const summaryBFile = await writeSummaryReport({
      outputDir: toOutputDirPath(outB),
      allFindings: coverageFindings,
      skippedPhases: ["source-traceability"],
    });
    await writeManifest(toOutputDirPath(outB), buildManifestEntries([...phaseFilesB, summaryBFile]));

    const summaryA = await readFile(join(outA, "report_summary.md"), "utf8");
    const summaryB = await readFile(join(outB, "report_summary.md"), "utf8");
    expect(summaryA).toBe(summaryB);
  });
});
