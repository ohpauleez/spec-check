import type { Finding, FindingSeverity } from "../findings.js";
import type { LogicIrClaim, LogicObligation } from "../logic-ir.js";
import { runZ3Query } from "../../adapters/z3.js";
import { mapBounded } from "../../adapters/concurrency.js";
import { compileSpecSmtlib, parseUnsatCore } from "./smtlib.js";
import { writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, toSmtlibContent, type OutputDirPath } from "../branded.js";

/**
 * Output from Z3 logic analysis containing findings and a human-readable report.
 *
 * @remarks
 * Invariant: `findings` includes contradiction, inconclusive, and merge-conflict results.
 * Invariant: `reportMarkdown` is a valid markdown document summarizing all solver outcomes.
 */
export interface LogicAnalysisOutput {
  readonly findings: readonly Finding[];
  readonly reportMarkdown: string;
}

/**
 * A group of claims originating from a single spec file.
 *
 * @remarks
 * Invariant: `specFile` is the provenance file path shared by all claims in the group.
 * Invariant: `claims` is non-empty.
 */
export interface SpecClaimGroup {
  readonly specFile: string;
  readonly claims: readonly LogicIrClaim[];
}

/** Maximum concurrent Z3 solver invocations during logic analysis. */
const LOGIC_ANALYSIS_CONCURRENCY_DEFAULT = 4;

interface SpecAnalysisResult {
  readonly findings: readonly Finding[];
  readonly reportLines: readonly string[];
}

/**
 * Run Z3 satisfiability analysis on per-spec combined SMT-LIB with bounded concurrency.
 *
 * @param input - Claim groups (one per spec file), output directory, and optional Z3 path
 * @returns Findings and a markdown report summarizing solver results
 *
 * @remarks
 * Each spec file's claims are merged into a single .smt2 file with named assertions
 * and unsat-core support. Z3 is invoked once per spec. When `unsat`, the unsat-core
 * is parsed to identify the specific conflicting claims. Finding severity is derived
 * from the highest-obligation claim in the core.
 */
export async function runLogicAnalysis(input: {
  readonly groups: readonly SpecClaimGroup[];
  readonly outputDir: OutputDirPath;
  readonly z3Path?: string;
  readonly concurrency?: number;
}): Promise<LogicAnalysisOutput> {
  const concurrency = input.concurrency ?? LOGIC_ANALYSIS_CONCURRENCY_DEFAULT;
  const reportLines = ["# report_1.logic.md", "", "## Solver Findings", ""];

  const results = await mapBounded(input.groups, concurrency, async (group) => {
    return await analyzeSpecGroup(group, input.outputDir, input.z3Path);
  });

  const findings: Finding[] = [];
  for (const result of results) {
    findings.push(...result.findings);
    reportLines.push(...result.reportLines);
  }

  const reportMarkdown = `${reportLines.join("\n")}\n`;
  return { findings, reportMarkdown };
}

/**
 * Analyze a single spec group: compile combined SMT-LIB, invoke Z3, parse results.
 */
async function analyzeSpecGroup(
  group: SpecClaimGroup,
  outputDir: OutputDirPath,
  z3Path: string | undefined,
): Promise<SpecAnalysisResult> {
  const compiled = compileSpecSmtlib(group.specFile, group.claims);
  const findings: Finding[] = [];
  const reportLines: string[] = [];

  // Emit findings for any merge conflicts detected during compilation.
  for (const conflict of compiled.conflicts) {
    findings.push({
      severity: "error",
      category: "logic.merge_conflict",
      provenance: { file: group.specFile },
      description: `Function "${conflict.functionName}" has incompatible signatures across claims`,
      evidence: [
        { kind: "claim_ids", value: conflict.claimIds.join(", ") },
      ],
      relatedClaimIdentifiers: [...conflict.claimIds],
    });
    reportLines.push(
      `- ${group.specFile}: merge conflict on "${conflict.functionName}" between ${conflict.claimIds.join(", ")}`,
    );
  }

  // Skip Z3 if no claims survived merging.
  if (compiled.claimIds.length === 0) {
    reportLines.push(`- ${group.specFile}: no claims to analyze (all excluded due to conflicts)`);
    return { findings, reportLines };
  }

  // Build query: compiled SMT-LIB + (check-sat) + (get-unsat-core).
  const querySmtlib = toSmtlibContent(`${compiled.smtlib}(check-sat)\n(get-unsat-core)\n`);
  const result = await runZ3Query({
    smtlib: querySmtlib,
    timeoutMs: 30_000,
    ...(z3Path === undefined ? {} : { z3Path }),
  });

  const artifactBase = `smt/${compiled.sanitizedSpecId}`;

  // Write artifact files.
  await Promise.all([
    writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.smt2`), compiled.smtlib),
    writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stdout.txt`), result.stdout),
    writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stderr.txt`), result.stderr),
  ]);

  if (result.kind === "unsat") {
    // Parse unsat core to identify conflicting claims.
    const coreLabels = parseUnsatCore(result.stdout);
    const conflictingClaimIds = resolveCoreToClaims(coreLabels, compiled.assertionNameMap);
    const severity = deriveSeverityFromClaims(conflictingClaimIds, group.claims);

    const claimList = conflictingClaimIds.length > 0
      ? conflictingClaimIds.join(", ")
      : "(core not available)";

    findings.push({
      severity,
      category: "logic.contradiction",
      provenance: { file: group.specFile },
      description: `Mutual contradiction among claims: ${claimList}`,
      evidence: [
        { kind: "smtlib", value: `${artifactBase}.smt2` },
        { kind: "unsat_core", value: claimList },
        { kind: "solver_stdout", value: `${artifactBase}.stdout.txt` },
      ],
      ...(conflictingClaimIds.length > 0 ? { relatedClaimIdentifiers: conflictingClaimIds } : {}),
    });
    reportLines.push(
      `- ${group.specFile}: UNSAT (contradiction) — core: ${claimList}`,
      `  - evidence: ${artifactBase}.smt2, ${artifactBase}.stdout.txt`,
    );
  } else if (result.kind === "timeout" || result.kind === "unknown") {
    findings.push({
      severity: "warning",
      category: "logic.inconclusive",
      provenance: { file: group.specFile },
      description: `Spec analysis inconclusive: ${result.kind}`,
      evidence: [
        { kind: "smtlib", value: `${artifactBase}.smt2` },
        { kind: "solver_stdout", value: `${artifactBase}.stdout.txt` },
        { kind: "solver_stderr", value: `${artifactBase}.stderr.txt` },
      ],
      relatedClaimIdentifiers: [...compiled.claimIds],
    });
    reportLines.push(
      `- ${group.specFile}: ${result.kind} (inconclusive)`,
      `  - evidence: ${artifactBase}.smt2, ${artifactBase}.stdout.txt`,
    );
  } else {
    // SAT — no contradiction, all claims are mutually satisfiable.
    reportLines.push(`- ${group.specFile}: SAT (${compiled.claimIds.length} claims consistent)`);
  }

  return { findings, reportLines };
}

/**
 * Map unsat-core assertion labels back to unique claim IDs.
 */
function resolveCoreToClaims(
  coreLabels: readonly string[],
  assertionNameMap: ReadonlyMap<string, string>,
): string[] {
  const claimIds = new Set<string>();
  for (const label of coreLabels) {
    const claimId = assertionNameMap.get(label);
    if (claimId !== undefined) {
      claimIds.add(claimId);
    }
  }
  return [...claimIds];
}

/**
 * Derive finding severity from the highest-obligation claim in the unsat core.
 * mandatory → error, advisory → warning, informational → info.
 * Falls back to "error" if no core claims are identified.
 */
function deriveSeverityFromClaims(
  coreClaimIds: readonly string[],
  allClaims: readonly LogicIrClaim[],
): FindingSeverity {
  if (coreClaimIds.length === 0) {
    return "error"; // Conservative fallback when core is not parseable.
  }

  const coreSet = new Set(coreClaimIds);
  let highestObligation: LogicObligation = "informational";

  for (const claim of allClaims) {
    if (!coreSet.has(claim.claimId)) continue;
    if (claim.obligation === "mandatory") return "error"; // Short-circuit.
    if (claim.obligation === "advisory") highestObligation = "advisory";
  }

  return obligationToSeverity(highestObligation);
}

function obligationToSeverity(obligation: LogicObligation): FindingSeverity {
  switch (obligation) {
    case "mandatory": return "error";
    case "advisory": return "warning";
    case "informational": return "info";
  }
}
