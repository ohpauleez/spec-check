import type { OutputDirPath } from "../branded.js";
import type { Finding } from "../findings.js";
import { runLogicAnalysis } from "../formal/logic-analysis.js";
import type { LogicIrClaim } from "../logic-ir.js";

/**
 * Output from Z3 logic analysis of code-derived formalized claims.
 *
 * @remarks
 * Invariant: `findings` contains contradiction and inconclusive results from the solver.
 * Invariant: `reportMarkdown` summarizes solver outcomes for all generated claims.
 */
export interface GeneratedLogicOutput {
  readonly findings: readonly Finding[];
  readonly reportMarkdown: string;
}

/**
 * Run Z3 satisfiability analysis on code-derived formalized claims.
 *
 * @param input - formalized claims to analyze, output directory, and optional Z3 path
 * @returns findings and markdown report from the logic analysis pass
 *
 * @remarks
 * Precondition: `input.claims` contains valid Logic IR claims.
 * Postcondition: delegates to `runLogicAnalysis` with the same concurrency and
 * artifact-persistence semantics.
 */
export async function analyzeGeneratedLogic(input: {
  readonly claims: readonly LogicIrClaim[];
  readonly outputDir: OutputDirPath;
  readonly z3Path?: string;
}): Promise<GeneratedLogicOutput> {
  const logic = await runLogicAnalysis({
    claims: input.claims,
    outputDir: input.outputDir,
    ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
  });

  return {
    findings: logic.findings,
    reportMarkdown: logic.reportMarkdown,
  };
}
