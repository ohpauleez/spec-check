/**
 * Renders findings from analysis passes into structured markdown report files.
 * Formats qualitative, coverage, and optional analysis results for human review.
 *
 * Role: Reporting layer component that transforms raw findings into the final
 * user-facing output artifacts written to the output directory.
 *
 * Key exports: `writePhaseReports`
 */
import type { Finding } from "../findings.js";
import { writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, type OutputDirPath } from "../branded.js";

/**
 * Write phase reports for qualitative and coverage passes.
 *
 * Renders each phase's findings into a Markdown report file and writes it
 * atomically to the output directory. Required phases (qualitative passes
 * 1 and 2, and coverage) are always written; optional phases (logic,
 * source traceability, code-derived logic, code-backwards comparison) are
 * written only when their corresponding findings array is provided.
 *
 * @param input - Configuration object containing the output directory and
 *   per-phase findings arrays.
 * @param input.outputDir - Branded absolute directory path where report
 *   files are written. Must reference an existing, writable directory.
 * @param input.report11 - Findings from qualitative pass 1. Written to
 *   `report_1.1.md`.
 * @param input.report12 - Findings from qualitative pass 2. Written to
 *   `report_1.2.md`.
 * @param input.report13 - Findings from coverage analysis. Written to
 *   `report_1.3.md`.
 * @param input.logicReport - Optional findings from logic analysis.
 *   Written to `report_1.logic.md` when provided.
 * @param input.srcTraceReport - Optional findings from source
 *   traceability analysis. Written to `report_2.trace.md` when provided.
 * @param input.srcLogicReport - Optional findings from code-derived logic
 *   analysis. Written to `report_2.logic.md` when provided.
 * @param input.compareReport - Optional findings from code-backwards
 *   comparison. Written to `report_2.compare.md` when provided.
 *
 * @returns A promise resolving to a readonly array of output descriptors,
 *   one per written report, each containing the relative `path`, the
 *   `phase` identifier, and the rendered Markdown `content`.
 *
 * @throws {Error} If a filesystem write fails (e.g., permission denied,
 *   disk full, or `outputDir` does not exist). Errors propagate from
 *   {@link writeOutputAtomic}.
 *
 * @remarks
 * Preconditions:
 * - `outputDir` must be a valid, writable directory that already exists.
 * - Each findings array must contain well-typed {@link Finding} objects
 *   (structurally incomplete findings are replaced with synthesized error
 *   findings via internal normalization).
 *
 * Postconditions:
 * - Each report file is written atomically (write-to-temp then rename),
 *   so readers never observe a partially written file.
 * - The returned array preserves the order: report_1.1, report_1.2,
 *   report_1.3, then any optional phases in definition order.
 *
 * Failure modes:
 * - Throws if any `writeOutputAtomic` call fails (e.g., permission denied, disk full,
 *   directory missing). On failure, some reports may already have been written.
 *
 * Safety: writes are sequential; no concurrent file mutation within a single call.
 *
 * @example
 * ```ts
 * import { writePhaseReports } from "./render.js";
 * import type { OutputDirPath } from "../branded.js";
 *
 * const results = await writePhaseReports({
 *   outputDir: "/tmp/analysis-output" as OutputDirPath,
 *   report11: qualitativeFindings1,
 *   report12: qualitativeFindings2,
 *   report13: coverageFindings,
 *   srcLogicReport: codeLogicFindings,
 * });
 *
 * for (const { path, phase } of results) {
 *   console.log(`Wrote ${path} for phase "${phase}"`);
 * }
 * ```
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
 * Write a synthesized summary report aggregating all findings with
 * optional-phase skip explanations.
 *
 * Produces a Markdown report containing a category-level findings count
 * and a list of skipped optional phases, then writes it atomically to the
 * output directory as `report_summary.md`.
 *
 * @param input - Configuration object containing findings and metadata.
 * @param input.outputDir - Branded absolute directory path where the
 *   summary report is written. Must reference an existing, writable
 *   directory.
 * @param input.allFindings - Aggregated findings from all executed
 *   phases. Used to compute per-category counts.
 * @param input.skippedPhases - Human-readable names of optional phases
 *   that were not executed. Rendered in the "Skipped scope" section.
 *
 * @returns A promise resolving to an output descriptor containing the
 *   relative `path` (`"report_summary.md"`), the `phase` identifier
 *   (`"summary"`), and the rendered Markdown `content`.
 *
 * @throws {Error} If the filesystem write fails (e.g., permission denied,
 *   disk full, or `outputDir` does not exist). Errors propagate from
 *   {@link writeOutputAtomic}.
 *
 * @remarks
 * Preconditions:
 * - `outputDir` must be a valid, writable directory that already exists.
 * - `allFindings` must contain well-typed {@link Finding} objects
 *   (structurally incomplete findings are replaced with synthesized error
 *   findings via internal normalization before counting).
 *
 * Postconditions:
 * - The summary file is written atomically (write-to-temp then rename),
 *   so readers never observe a partially written file.
 * - Category counts are sorted lexicographically by category name.
 * - If `skippedPhases` is empty, the skipped section reads "None".
 *
 * Failure modes:
 * - Throws if `writeOutputAtomic` fails (e.g., permission denied, disk full,
 *   directory missing).
 *
 * Safety: performs a single atomic filesystem write; no concurrent mutation concerns.
 *
 * @example
 * ```ts
 * import { writeSummaryReport } from "./render.js";
 * import type { OutputDirPath } from "../branded.js";
 *
 * const summary = await writeSummaryReport({
 *   outputDir: "/tmp/analysis-output" as OutputDirPath,
 *   allFindings: [...phase1Findings, ...phase2Findings],
 *   skippedPhases: ["logic", "source-trace"],
 * });
 *
 * console.log(`Summary written to ${summary.path}: ${summary.content}`);
 * ```
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

/**
 * Transforms a findings array by enforcing that every element satisfies
 * the required shape invariants defined by [RAE-FINDING-SHAPE].
 *
 * @param findings - the raw findings array to validate and normalize
 * @returns a new array where malformed findings are replaced with
 *   `unsupported_verdict` error findings preserving the original category
 *
 * @remarks
 * Precondition: `findings` is a well-typed array of {@link Finding} objects
 * (fields may be empty strings or empty arrays, but must exist).
 *
 * Invariant enforcement logic: each finding is validated for non-empty
 * `severity`, `category`, `provenance.file`, `description`, `rationale`,
 * and `evidence`. Findings that satisfy all constraints pass through
 * unchanged. Findings missing any required field are replaced with a
 * synthesized error finding of category `"reporting.unsupported_verdict"`
 * that records the original category as evidence, ensuring downstream
 * consumers never encounter structurally incomplete data.
 *
 * Postcondition: the returned array has the same length as the input, and
 * every element has all required fields populated with non-empty values.
 *
 * Failure modes: none — pure computation.
 */
function enforceFindingSupport(findings: readonly Finding[]): readonly Finding[] {
  const output: Finding[] = [];

  for (const finding of findings) {
    const hasRequiredShape =
      finding.severity.length > 0
      && finding.category.length > 0
      && finding.provenance.file.length > 0
      && finding.description.length > 0
      && finding.rationale.length > 0
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
      rationale: "Findings missing required fields (category, provenance file, description, or evidence) cannot be rendered or acted upon and indicate an upstream defect",
      evidence: [{ kind: "original_category", value: finding.category }],
    });
  }

  return output;
}

/**
 * Renders a list of findings into a structured Markdown report string.
 *
 * @param filename - the report filename used as the H1 heading
 * @param title - a human-readable phase title used as the H2 heading
 * @param findings - the validated findings to render
 * @returns a Markdown-formatted report string ending with a trailing newline
 *
 * @remarks
 * This is a pure function with no side effects. It formats each finding
 * as a Markdown list item containing severity, category, description,
 * provenance location, evidence entries, and optionally related claim
 * identifiers.
 *
 * Precondition: `findings` elements must satisfy the required shape
 * invariants (non-empty severity, category, provenance.file, description,
 * rationale, and evidence). Use {@link enforceFindingSupport} upstream to
 * guarantee this.
 *
 * Postcondition: the returned string is valid Markdown terminated by a
 * newline character, containing an H1 header with the filename, an H2
 * header with the title, and either "No findings." or a bullet list of
 * formatted findings.
 *
 * Failure modes: none — pure computation.
 */
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
