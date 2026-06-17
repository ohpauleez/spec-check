import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import { runZ3Query } from "../../adapters/z3.js";
import { mapBounded } from "../../adapters/concurrency.js";
import { compileSmtlib } from "./smtlib.js";
import { writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, toSmtlibContent, type OutputDirPath } from "../branded.js";

/**
 * Output from Z3 logic analysis containing findings and a human-readable report.
 *
 * @remarks
 * Invariant: `findings` includes contradiction and inconclusive results from the solver.
 * Invariant: `reportMarkdown` is a valid markdown document summarizing all solver outcomes.
 */
export interface LogicAnalysisOutput {
  readonly findings: readonly Finding[];
  readonly reportMarkdown: string;
}

/** Maximum concurrent Z3 solver invocations during logic analysis. */
const LOGIC_ANALYSIS_CONCURRENCY_DEFAULT = 4;

interface ClaimAnalysisResult {
  readonly findings: readonly Finding[];
  readonly reportLines: readonly string[];
}

/**
 * Run Z3 satisfiability analysis on formalized claims with bounded concurrency.
 *
 * @param input - Claims to analyze, output directory, and optional Z3 path
 * @returns Findings and a markdown report summarizing solver results
 *
 * @remarks
 * Mandatory claims are analyzed before advisory claims to preserve report ordering.
 * Within each pass, claims are processed in parallel with bounded concurrency.
 * File writes for each claim are independent and batched with Promise.all.
 */
export async function runLogicAnalysis(input: {
  readonly claims: readonly LogicIrClaim[];
  readonly outputDir: OutputDirPath;
  readonly z3Path?: string;
  readonly concurrency?: number;
}): Promise<LogicAnalysisOutput> {
  const concurrency = input.concurrency ?? LOGIC_ANALYSIS_CONCURRENCY_DEFAULT;
  const reportLines = ["# report_1.logic.md", "", "## Solver Findings", ""];

  const mandatory = input.claims.filter((claim) => claim.obligation === "mandatory");
  const advisory = input.claims.filter((claim) => claim.obligation !== "mandatory");

  // Mandatory pass runs first, then advisory; ordering within each pass is deterministic.
  const mandatoryResults = await analyzeClaimSet(mandatory, "mandatory", input.outputDir, input.z3Path, concurrency);
  const advisoryResults = await analyzeClaimSet(advisory, "advisory", input.outputDir, input.z3Path, concurrency);

  const findings: Finding[] = [];
  for (const result of [...mandatoryResults, ...advisoryResults]) {
    findings.push(...result.findings);
    reportLines.push(...result.reportLines);
  }

  const reportMarkdown = `${reportLines.join("\n")}\n`;
  return { findings, reportMarkdown };
}

/**
 * Analyze a set of claims in parallel with bounded concurrency.
 * Each claim is independent: Z3 query + file writes share no mutable state.
 */
async function analyzeClaimSet(
  claims: readonly LogicIrClaim[],
  pass: "mandatory" | "advisory",
  outputDir: OutputDirPath,
  z3Path: string | undefined,
  concurrency: number,
): Promise<readonly ClaimAnalysisResult[]> {
  return await mapBounded(claims, concurrency, async (claim) => {
    const compiled = compileSmtlib(claim);
    const querySmtlib = toSmtlibContent(`${compiled.smtlib}(check-sat)\n`);
    const result = await runZ3Query({
      smtlib: querySmtlib,
      timeoutMs: 30_000,
      ...(z3Path === undefined ? {} : { z3Path }),
    });

    const artifactBase = `smt/${pass}/${compiled.sanitizedClaimId}`;

    // File writes within a single claim are independent; batch them.
    await Promise.all([
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.smt2`), compiled.smtlib),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stdout.txt`), result.stdout),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stderr.txt`), result.stderr),
    ]);

    const findings: Finding[] = [];
    const severity = pass === "mandatory" ? "error" : "warning";
    if (result.kind === "unsat") {
      findings.push({
        severity,
        category: "logic.contradiction",
        provenance: { file: "<logic>", heading: claim.claimId },
        description: `${pass} claim is contradictory (unsat)`,
        evidence: [
          { kind: "smtlib", value: `${artifactBase}.smt2` },
          { kind: "solver_stdout", value: `${artifactBase}.stdout.txt` },
          { kind: "solver_stderr", value: `${artifactBase}.stderr.txt` },
        ],
        relatedClaimIdentifiers: [claim.claimId],
      });
    } else if (result.kind === "timeout" || result.kind === "unknown") {
      findings.push({
        severity: "warning",
        category: "logic.inconclusive",
        provenance: { file: "<logic>", heading: claim.claimId },
        description: `${pass} claim analysis inconclusive: ${result.kind}`,
        evidence: [
          { kind: "smtlib", value: `${artifactBase}.smt2` },
          { kind: "solver_stdout", value: `${artifactBase}.stdout.txt` },
          { kind: "solver_stderr", value: `${artifactBase}.stderr.txt` },
        ],
        relatedClaimIdentifiers: [claim.claimId],
      });
    }

    const reportLines = [
      `- ${claim.claimId}: ${result.kind} (${pass})`,
      `  - evidence: ${artifactBase}.smt2, ${artifactBase}.stdout.txt, ${artifactBase}.stderr.txt`,
    ];

    return { findings, reportLines };
  });
}
