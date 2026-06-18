import type { OutputDirPath } from "../branded.js";
import type { Finding } from "../findings.js";
import { runLogicAnalysis, type SpecClaimGroup } from "../formal/logic-analysis.js";
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
 * @param input - formalized claims (with capability) to analyze, output directory, and optional Z3 path
 * @returns findings and markdown report from the logic analysis pass
 *
 * @remarks
 * Precondition: `input.claims` contains valid Logic IR claims with capability metadata.
 * Postcondition: claims are grouped by capability into SpecClaimGroups for per-spec
 * combined analysis (one .smt2 per capability).
 */
export async function analyzeGeneratedLogic(input: {
  readonly claims: readonly { readonly capability: string; readonly representative: LogicIrClaim }[];
  readonly outputDir: OutputDirPath;
  readonly z3Path?: string;
}): Promise<GeneratedLogicOutput> {
  // Group claims by capability for per-spec combined SMT-LIB.
  const groups = groupByCapability(input.claims);

  const logic = await runLogicAnalysis({
    groups,
    outputDir: input.outputDir,
    ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
  });

  return {
    findings: logic.findings,
    reportMarkdown: logic.reportMarkdown,
  };
}

/**
 * Group generated claims by capability into SpecClaimGroups.
 * Uses synthetic file paths: `<gen_specs/{capability}.md>` for provenance.
 */
function groupByCapability(
  claims: readonly { readonly capability: string; readonly representative: LogicIrClaim }[],
): SpecClaimGroup[] {
  const groups = new Map<string, LogicIrClaim[]>();
  const order: string[] = [];

  for (const claim of claims) {
    const key = `<gen_specs/${claim.capability}.md>`;
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(claim.representative);
  }

  return order.map((specFile) => ({ specFile, claims: groups.get(specFile)! }));
}
