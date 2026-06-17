import type { Finding } from "../findings.js";
import { writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, type OutputDirPath } from "../branded.js";

/**
 * Write phase reports for qualitative and coverage passes.
 */
export async function writePhaseReports(input: {
  readonly outputDir: OutputDirPath;
  readonly report11: readonly Finding[];
  readonly report12: readonly Finding[];
  readonly report13: readonly Finding[];
  readonly logicReport?: readonly Finding[];
  readonly srcTraceReport?: readonly Finding[];
  readonly srcLogicReport?: readonly Finding[];
  readonly compareReport?: readonly Finding[];
}): Promise<readonly { readonly path: string; readonly phase: string; readonly content: string }[]> {
  const outputs: { path: string; phase: string; content: string }[] = [];

  const report11 = renderFindingsReport("report_1.1.md", "Qualitative Pass 1", enforceFindingSupport(input.report11));
  await writeOutputAtomic(input.outputDir, toRelativePath("report_1.1.md"), report11);
  outputs.push({ path: "report_1.1.md", phase: "qualitative-review", content: report11 });

  const report12 = renderFindingsReport("report_1.2.md", "Qualitative Pass 2", enforceFindingSupport(input.report12));
  await writeOutputAtomic(input.outputDir, toRelativePath("report_1.2.md"), report12);
  outputs.push({ path: "report_1.2.md", phase: "qualitative-properties", content: report12 });

  const report13 = renderFindingsReport("report_1.3.md", "Coverage Analysis", enforceFindingSupport(input.report13));
  await writeOutputAtomic(input.outputDir, toRelativePath("report_1.3.md"), report13);
  outputs.push({ path: "report_1.3.md", phase: "coverage", content: report13 });

  if (input.logicReport !== undefined) {
    const report = renderFindingsReport("report_1.logic.md", "Logic Analysis", enforceFindingSupport(input.logicReport));
    await writeOutputAtomic(input.outputDir, toRelativePath("report_1.logic.md"), report);
    outputs.push({ path: "report_1.logic.md", phase: "logic", content: report });
  }

  if (input.srcTraceReport !== undefined) {
    const report = renderFindingsReport("report_2.trace.md", "Source Traceability", enforceFindingSupport(input.srcTraceReport));
    await writeOutputAtomic(input.outputDir, toRelativePath("report_2.trace.md"), report);
    outputs.push({ path: "report_2.trace.md", phase: "source-trace", content: report });
  }

  if (input.srcLogicReport !== undefined) {
    const report = renderFindingsReport("report_2.logic.md", "Code-Derived Logic", enforceFindingSupport(input.srcLogicReport));
    await writeOutputAtomic(input.outputDir, toRelativePath("report_2.logic.md"), report);
    outputs.push({ path: "report_2.logic.md", phase: "code-derived-logic", content: report });
  }

  if (input.compareReport !== undefined) {
    const report = renderFindingsReport("report_2.compare.md", "Code-Backwards Comparison", enforceFindingSupport(input.compareReport));
    await writeOutputAtomic(input.outputDir, toRelativePath("report_2.compare.md"), report);
    outputs.push({ path: "report_2.compare.md", phase: "code-backwards-compare", content: report });
  }

  return outputs;
}

/**
 * Write synthesized summary report with optional-phase skip explanations.
 */
export async function writeSummaryReport(input: {
  readonly outputDir: OutputDirPath;
  readonly allFindings: readonly Finding[];
  readonly skippedPhases: readonly string[];
}): Promise<{ readonly path: string; readonly phase: string; readonly content: string }> {
  const supportedFindings = enforceFindingSupport(input.allFindings);
  const grouped = new Map<string, number>();
  for (const finding of supportedFindings) {
    grouped.set(finding.category, (grouped.get(finding.category) ?? 0) + 1);
  }

  const lines = ["# report_summary", "", "## Findings by category", ""];
  for (const [category, count] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    lines.push(`- ${category}: ${String(count)}`);
  }

  lines.push("", "## Skipped scope", "");
  if (input.skippedPhases.length === 0) {
    lines.push("- None");
  } else {
    for (const skipped of input.skippedPhases) {
      lines.push(`- ${skipped} (optional phase not enabled)`);
    }
  }

  const content = `${lines.join("\n")}\n`;
  await writeOutputAtomic(input.outputDir, toRelativePath("report_summary.md"), content);
  return { path: "report_summary.md", phase: "summary", content };
}

function enforceFindingSupport(findings: readonly Finding[]): readonly Finding[] {
  const output: Finding[] = [];

  for (const finding of findings) {
    const hasRequiredShape =
      finding.severity.length > 0
      && finding.category.length > 0
      && finding.provenance.file.length > 0
      && finding.description.length > 0
      && finding.evidence.length > 0;

    if (hasRequiredShape) {
      output.push(finding);
      continue;
    }

    output.push({
      severity: "error",
      category: "reporting.unsupported_verdict",
      provenance: { file: finding.provenance.file.length > 0 ? finding.provenance.file : "<reporting>" },
      description: "Suppressed finding without required provenance or evidence",
      evidence: [{ kind: "original_category", value: finding.category }],
    });
  }

  return output;
}

function renderFindingsReport(filename: string, title: string, findings: readonly Finding[]): string {
  const lines = [`# ${filename}`, "", `## ${title}`, ""];
  if (findings.length === 0) {
    lines.push("No findings.");
    return `${lines.join("\n")}\n`;
  }

  for (const finding of findings) {
    lines.push(`- [${finding.severity}] ${finding.category}: ${finding.description}`);
    lines.push(`  - provenance: ${finding.provenance.file}${finding.provenance.heading === undefined ? "" : `#${finding.provenance.heading}`}`);
    lines.push(`  - evidence: ${finding.evidence.map((item) => `${item.kind}=${item.value}`).join("; ")}`);
    if (finding.relatedClaimIdentifiers !== undefined && finding.relatedClaimIdentifiers.length > 0) {
      lines.push(`  - related: ${finding.relatedClaimIdentifiers.join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
