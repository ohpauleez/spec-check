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

describe("specs-forward integration", () => {
  it("produces phase reports and summary", async () => {
    traceSpec("RAE-EMIT-REPORTS", "RAE-REPORT-PHASES", "RAE-REPORT-SKIP");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-"));
    const output = join(root, "output");

    await writeFile(join(root, "proposal.md"), "## Scope\n- behavior\n", "utf8");
    await writeFile(join(root, "design.md"), "## Goals\n- quality\n", "utf8");
    await writeFile(
      join(root, "spec.md"),
      [
        "## ADDED Requirements",
        "",
        "### Requirement: Basic [CAT-BASIC-REQ]",
        "WHEN input exists, THE system SHALL react.",
        "",
        "**References:**",
        "- proposal.md#Scope",
      ].join("\n"),
      "utf8",
    );

    const parsedProposal = await parseProposal(join(root, "proposal.md"));
    const parsedDesign = await parseDesign(join(root, "design.md"));
    const parsedSpec = await parseSpec(join(root, "spec.md"));

    const claimGraph = buildClaimGraph({
      proposal: parsedProposal,
      design: parsedDesign,
      specs: [parsedSpec],
    });

    const coverageFindings = analyzeCoverage({
      claimGraph: claimGraph.graph,
      proposal: parsedProposal,
      specs: [parsedSpec],
    });

    const phaseFiles = await writePhaseReports({
      outputDir: toOutputDirPath(output),
      report11: [],
      report12: [],
      report13: coverageFindings,
    });
    const summary = await writeSummaryReport({
      outputDir: toOutputDirPath(output),
      allFindings: [...claimGraph.findings, ...coverageFindings],
      skippedPhases: ["source-traceability"],
    });
    await writeManifest(toOutputDirPath(output), buildManifestEntries([...phaseFiles, summary]));

    const report = await readFile(join(output, "report_summary.md"), "utf8");
    expect(report).toContain("Skipped scope");
  });
});
