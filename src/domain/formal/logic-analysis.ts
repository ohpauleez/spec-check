/**
 * Runs Z3-based satisfiability analysis on formalized spec claims to detect
 * contradictions, tautologies, and unsatisfiable constraint sets.
 *
 * Orchestrates the formal verification pipeline's solver stage.
 * Exports: runLogicAnalysis, SpecClaimGroup.
 */
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import { runZ3Query } from "../../adapters/z3.js";
import { mapBounded } from "../../adapters/concurrency.js";
import { compileSpecSmtlib, parseUnsatCore } from "./smtlib.js";
import { writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, toSmtlibContent, type OutputDirPath } from "../branded.js";
import { deriveSeverityFromClaims } from "./logic-analysis-sexpr.js";
import { runPairwiseContradictionChecks, runCompletenessCheck } from "./logic-analysis-checks.js";

export type { ParsedImplication } from "./logic-analysis-sexpr.js";
export {
  extractImplications,
  parseImplicationExpr,
  splitSExprParts,
  collectVariableDeclarations,
  buildDeclarationPreamble,
  deriveSeverityFromClaims,
  obligationToSeverity,
} from "./logic-analysis-sexpr.js";
export { runPairwiseContradictionChecks, checkPairContradiction, runCompletenessCheck } from "./logic-analysis-checks.js";

/**
 * Output from Z3 logic analysis containing findings and a human-readable report.
 *
 * @remarks
 * Invariant: `findings` includes contradiction, conditional contradiction, completeness gap,
 * solver error, inconclusive, and merge-conflict results.
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
 * @param input - analysis configuration bundle
 * @param input.groups - claim groups (one per spec file) to analyze
 * @param input.outputDir - directory for writing SMT-LIB artifact files
 * @param input.z3Path - optional path to Z3 binary; uses system PATH if undefined
 * @param input.concurrency - maximum concurrent Z3 solver invocations (default 4)
 * @returns findings and a markdown report summarizing solver results
 *
 * @remarks
 * Precondition: `input.groups` may be empty (produces empty findings and minimal report).
 * Postcondition: `findings` includes contradiction, conditional contradiction, completeness gap,
 * solver error, inconclusive, and merge-conflict results across all groups.
 * Postcondition: `reportMarkdown` is a valid markdown document summarizing all solver outcomes.
 *
 * Failure modes:
 * - Propagates Z3 subprocess errors from `runZ3Query` if the solver binary is missing or crashes.
 * - Propagates filesystem errors from `writeOutputAtomic` if the output directory is not writable.
 *
 * Each spec file's claims are merged into a single .smt2 file with named assertions
 * and unsat-core support. The global satisfiability check invokes Z3 once per spec.
 * When `unsat`, the unsat-core is parsed to identify the specific conflicting claims.
 * When `sat`, deeper analysis follows: pairwise guard-activation contradiction
 * checks detect conflicts hidden by vacuous truth in conditional assertions, and
 * completeness gap detection identifies states where no conditional rule applies.
 * When Z3 reports errors, a `logic.solver_error` finding is emitted.
 * Finding severity is derived from the highest-obligation claim involved.
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
 *
 * @param group - spec file claim group to analyze
 * @param outputDir - directory for writing SMT-LIB artifact files
 * @param z3Path - optional path to Z3 binary; uses system PATH if undefined
 * @returns findings and report lines for this spec group
 *
 * @remarks
 * Precondition: `group.claims` is non-empty.
 * Postcondition: artifact files (.smt2, .stdout.txt, .stderr.txt) are written atomically.
 * After the global satisfiability check, SAT results trigger pairwise guard-activation
 * contradiction checks and completeness gap detection. Claims excluded by merge
 * conflicts are filtered out of the deeper analysis.
 *
 * Failure modes:
 * - Propagates Z3 subprocess errors from `runZ3Query`.
 * - Propagates filesystem errors from `writeOutputAtomic`.
 */
async function analyzeSpecGroup(
  group: SpecClaimGroup,
  outputDir: OutputDirPath,
  z3Path: string | undefined,
): Promise<SpecAnalysisResult> {
  // --- Decision tree overview ---
  // This function implements a Z3-based satisfiability decision tree:
  //   1. Compile all claims from a spec group into a single SMT-LIB query.
  //   2. Invoke Z3 to check satisfiability of the combined assertion set.
  //   3. Branch on the solver result:
  //      - SAT: The spec is internally consistent (a satisfying model exists).
  //        Proceed to deeper analyses — pairwise contradiction checks on
  //        conditional guards and completeness gap detection — because global
  //        SAT can mask conflicts hidden behind vacuously-true conditionals.
  //      - UNSAT: A contradiction exists among the claims. Re-run with
  //        unsat-core production to extract the minimal conflicting subset,
  //        enabling targeted diagnosis of which claims conflict.
  //      - Error: Z3 rejected the input (malformed SMT-LIB). No logical
  //        conclusion is possible; report as a solver error.
  //      - Timeout/Unknown: The solver exhausted resources without a verdict.
  //        No conclusion is possible; report as inconclusive.
  //
  // Pre-step: Claims involved in merge conflicts (incompatible signatures)
  // are excluded before any solver work — they would make the SMT-LIB
  // unsound if included.

  const compiled = compileSpecSmtlib(group.specFile, group.claims);
  const findings: Finding[] = [];
  const reportLines: string[] = [];
  const excludedClaimIdsSet = new Set(
    compiled.conflicts.flatMap((c) => c.claimIds),
  );

  // Emit findings for any merge conflicts detected during compilation.
  for (const conflict of compiled.conflicts) {
    findings.push({
      severity: "error",
      category: "logic.merge_conflict",
      provenance: { file: group.specFile },
      description: `Function "${conflict.functionName}" has incompatible signatures across claims`,
      rationale: "Claims with incompatible function signatures cannot be jointly analyzed — the spec must be consistent in its declarations before logical properties can be checked.",
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

  // Goal: Determine global satisfiability of the combined claim set.
  // Invariant: compiled.smtlib is a well-formed SMT-LIB string with named
  // assertions (one per surviving claim) but no (check-sat) directive yet.
  // Two-phase Z3 approach:
  // Phase 1: check satisfiability without unsat-core overhead.
  // Phase 2 (only on UNSAT): re-run with (set-option :produce-unsat-cores true)
  //   and (get-unsat-core) to identify which claims conflict.
  // This is safe because Phase 1 is lightweight and Phase 2 is conditional.
  const phase1Query = toSmtlibContent(`${compiled.smtlib}(check-sat)\n`);
  const result = await runZ3Query({
    smtlib: phase1Query,
    timeoutMs: 30_000,
    ...(z3Path === undefined ? {} : { z3Path }),
  });

  const artifactBase = `smt/${compiled.sanitizedSpecId}`;

  if (result.kind === "unsat") {
    // UNSAT branch — Goal: Extract the minimal conflicting claim subset.
    // A contradiction exists in the combined assertions; the spec cannot be
    // simultaneously satisfied. Phase 2 re-runs with unsat-core tracking so
    // we can pinpoint which specific claims are responsible.
    // Invariant: The UNSAT result guarantees at least two claims conflict,
    // so the core extraction in Phase 2 will be non-vacuous.
    // Phase 2: Re-run with unsat-core tracking to identify conflicting claims.
    const phase2Query = toSmtlibContent(
      `(set-option :produce-unsat-cores true)\n${compiled.smtlib}(check-sat)\n(get-unsat-core)\n`,
    );
    const phase2Result = await runZ3Query({
      smtlib: phase2Query,
      timeoutMs: 30_000,
      ...(z3Path === undefined ? {} : { z3Path }),
    });

    // Write artifact files (use phase 2 stdout since it contains the unsat core).
    await Promise.all([
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.smt2`), compiled.smtlib),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stdout.txt`), phase2Result.stdout),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stderr.txt`), phase2Result.stderr),
    ]);

    // Parse unsat core to identify conflicting claims.
    const coreLabels = parseUnsatCore(phase2Result.stdout);
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
      rationale: "A contradiction means the combined spec is logically impossible to satisfy — no implementation can simultaneously fulfill all claims, indicating a specification error that must be resolved.",
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
  } else if (result.kind === "error") {
    // Error branch — Goal: Report that no logical conclusion can be drawn.
    // Z3 rejected the SMT-LIB input, meaning the formalization is malformed.
    // No satisfiability verdict is available, so we cannot confirm or deny
    // consistency. This is a gap in the correctness argument, not a spec defect.
    // Next step (writing artifacts) is safe because the error is deterministic.
    // Write artifact files for error case.
    await Promise.all([
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.smt2`), compiled.smtlib),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stdout.txt`), result.stdout),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stderr.txt`), result.stderr),
    ]);

    // Z3 rejected the input — formalization produced invalid SMT-LIB.
    const errorDetail = (result.errorCount ?? 0) > 0
      ? `Z3 emitted ${String(result.errorCount)} error(s) — formalization produced invalid SMT-LIB`
      : `Z3 rejected the input — formalization may be invalid`;

    findings.push({
      severity: "error",
      category: "logic.solver_error",
      provenance: { file: group.specFile },
      description: errorDetail,
      rationale: "If Z3 rejects the input, the formalization is malformed and no logical guarantees can be derived — the correctness case has a gap until the formalization is fixed.",
      evidence: [
        { kind: "smtlib", value: `${artifactBase}.smt2` },
        { kind: "solver_stdout", value: `${artifactBase}.stdout.txt` },
        { kind: "solver_stderr", value: `${artifactBase}.stderr.txt` },
      ],
      relatedClaimIdentifiers: [...compiled.claimIds],
    });
    reportLines.push(
      `- ${group.specFile}: ERROR (${errorDetail})`,
      `  - evidence: ${artifactBase}.smt2, ${artifactBase}.stdout.txt`,
    );
  } else if (result.kind === "timeout" || result.kind === "unknown") {
    // Timeout/Unknown branch — Goal: Report that no conclusion is possible.
    // The solver could not determine satisfiability within resource limits.
    // Neither consistency nor contradiction is established — the result is
    // genuinely inconclusive. The spec may or may not be consistent.
    // Invariant: We do not promote this to an error; absence of evidence
    // is not evidence of absence.
    // Write artifact files for inconclusive case.
    await Promise.all([
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.smt2`), compiled.smtlib),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stdout.txt`), result.stdout),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stderr.txt`), result.stderr),
    ]);

    findings.push({
      severity: "warning",
      category: "logic.inconclusive",
      provenance: { file: group.specFile },
      description: `Spec analysis inconclusive: ${result.kind}`,
      rationale: "An inconclusive result means the solver could not determine satisfiability within resource limits — the absence of a contradiction is not confirmed, leaving a gap in the correctness argument.",
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
    // SAT branch — Goal: The spec is internally consistent; proceed to find
    // subtle issues that global SAT does not rule out.
    // Invariant: A satisfying model exists for the combined assertions, so the
    // claims are jointly realizable. However, conditional assertions may be
    // vacuously true (their guards never activate together), hiding pairwise
    // conflicts. Completeness gaps (states where no conditional rule fires)
    // are also invisible to the global check.
    // Next steps (pairwise + completeness) are safe because they operate on
    // the surviving (non-excluded) claims independently of the global model.
    // SAT — no global contradiction. Write artifacts and proceed with deeper analysis.
    await Promise.all([
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.smt2`), compiled.smtlib),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stdout.txt`), result.stdout),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stderr.txt`), result.stderr),
    ]);

    reportLines.push(`- ${group.specFile}: SAT (${compiled.claimIds.length} claims globally consistent)`);

    // Run pairwise guard-activation contradiction checks.
    const pairwiseFindings = await runPairwiseContradictionChecks({
      claims: group.claims.filter((c) => !excludedClaimIdsSet.has(c.claimId)),
      specFile: group.specFile,
      z3Path,
    });
    findings.push(...pairwiseFindings);
    if (pairwiseFindings.length > 0) {
      reportLines.push(`  - pairwise contradictions found: ${String(pairwiseFindings.length)}`);
    }

    // Run completeness gap check.
    const gapFindings = await runCompletenessCheck({
      claims: group.claims.filter((c) => !excludedClaimIdsSet.has(c.claimId)),
      specFile: group.specFile,
      z3Path,
    });
    findings.push(...gapFindings);
    if (gapFindings.length > 0) {
      reportLines.push(`  - completeness gaps found: ${String(gapFindings.length)}`);
    }
  }

  return { findings, reportLines };
}

/**
 * Map unsat-core assertion labels back to unique claim IDs.
 *
 * @param coreLabels - assertion labels extracted from Z3 unsat-core output
 * @param assertionNameMap - mapping from assertion labels to their source claim IDs
 * @returns deduplicated array of claim IDs referenced by the unsat core
 *
 * @remarks
 * Precondition: `assertionNameMap` contains all labels emitted during compilation.
 * Postcondition: returned array contains only claim IDs present in `assertionNameMap` values.
 * Postcondition: each claim ID appears at most once (deduplicated via Set).
 * Failure modes: none — pure computation. Unknown labels are silently skipped.
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
