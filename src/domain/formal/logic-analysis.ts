/**
 * Runs Z3-based satisfiability analysis on formalized spec claims.
 */
import { mapBounded } from "../../adapters/concurrency.js";
import { writeOutputAtomic } from "../../adapters/fs.js";
import { runZ3Query } from "../../adapters/z3.js";
import { assertNever, postcondition } from "../assert.js";
import {
  toRelativePath,
  toSmtlibContent,
  type OutputDirPath,
  type SanitizedClaimId,
} from "../branded.js";
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import { runCompletenessCheck, runPairwiseContradictionChecks } from "./logic-analysis-checks.js";
import { deriveSeverityFromClaims } from "./logic-analysis-sexpr.js";
import { compileSpecSmtlib, parseUnsatCore, sanitizeIdentifier, type SpecMergeConflict } from "./smtlib.js";

export type { ParsedImplication } from "./logic-analysis-sexpr.js";
export {
  buildDeclarationPreamble,
  collectVariableDeclarations,
  extractImplications,
  obligationToSeverity,
  parseImplicationExpr,
  splitSExprParts,
} from "./logic-analysis-sexpr.js";
export { checkPairContradiction, runCompletenessCheck, runPairwiseContradictionChecks } from "./logic-analysis-checks.js";

/** Maximum concurrent Z3 solver invocations during logic analysis. */
const LOGIC_ANALYSIS_CONCURRENCY_DEFAULT = 4;

/**
 * Output from logic analysis.
 */
export interface LogicAnalysisOutput {
  readonly findings: readonly Finding[];
  readonly reportMarkdown: string;
}

/**
 * Claim group analyzed as one combined SMT-LIB unit.
 */
export interface SpecClaimGroup {
  readonly specFile: string;
  readonly artifactKey?: string;
  readonly claims: readonly LogicIrClaim[];
}

interface SpecAnalysisResult {
  readonly findings: readonly Finding[];
  readonly reportLines: readonly string[];
}

interface ClaimIdPreflightIssue {
  readonly kind: "duplicate_raw_claim_id" | "duplicate_sanitized_claim_id";
  readonly duplicatedRawClaimIds?: readonly string[];
  readonly collidingRawClaimIds?: readonly string[];
  readonly sanitizedClaimId?: SanitizedClaimId;
}

/**
 * Run solver-backed logic analysis across all compile groups.
 *
 * @param input - logic-analysis run configuration
 * @param input.groups - compile groups to analyze; each group is processed independently
 * @param input.outputDir - confined output directory for SMT-LIB and solver artifacts
 * @param input.z3Path - optional Z3 binary path override
 * @param input.concurrency - max concurrent group analyses; defaults to 4
 * @returns findings and consolidated report markdown
 *
 * @throws {Error} Propagates adapter failures from solver execution or artifact writes.
 *
 * @remarks
 * Preconditions:
 * - each group contains a finite ordered claim list;
 * - `outputDir` is writable and confinement-validated upstream.
 *
 * Postconditions:
 * - all groups are analyzed independently with bounded concurrency;
 * - findings preserve per-group provenance;
 * - output report contains one section line per analyzed group outcome.
 *
 * @example
 * ```ts
 * const result = await runLogicAnalysis({
 *   groups,
 *   outputDir,
 *   concurrency: 2,
 * });
 * ```
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
    return analyzeSpecGroup(group, input.outputDir, input.z3Path);
  });

  const findings: Finding[] = [];
  for (const result of results) {
    findings.push(...result.findings);
    reportLines.push(...result.reportLines);
  }

  return {
    findings,
    reportMarkdown: `${reportLines.join("\n")}\n`,
  };
}

/**
 * Check compile-group claim ID uniqueness before compilation or solver work.
 *
 * @param claims - claims in one compile group
 * @param sanitizeClaimId - sanitizer used for defense-in-depth sanitized-ID checks
 * @returns one structural issue when the group is invalid; otherwise `null`
 *
 * @remarks
 * Preconditions:
 * - claims are grouped by one logical compile key.
 *
 * Postconditions:
 * - detects duplicate raw claim IDs;
 * - detects duplicate sanitized claim IDs as defense-in-depth;
 * - returns at most one issue per group (first failing check).
 * - does not mutate `claims`.

 * Failure forms:
 * - `duplicate_raw_claim_id`: at least one raw ID appears more than once.
 * - `duplicate_sanitized_claim_id`: two distinct raw IDs map to one sanitized ID.
 *
 * @example
 * ```ts
 * const issue = preflightGroupClaimIds(claims);
 * if (issue !== null) {
 *   // reject group as logic.invalid_group
 * }
 * ```
 */
export function preflightGroupClaimIds(
  claims: readonly LogicIrClaim[],
  sanitizeClaimId: (claimId: string) => SanitizedClaimId = sanitizeIdentifier,
): ClaimIdPreflightIssue | null {
  const rawCounts = new Map<string, number>();
  for (const claim of claims) {
    rawCounts.set(claim.claimId, (rawCounts.get(claim.claimId) ?? 0) + 1);
  }

  const duplicatedRawClaimIds = [...rawCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([claimId]) => claimId)
    .sort((left, right) => left.localeCompare(right));

  if (duplicatedRawClaimIds.length > 0) {
    return {
      kind: "duplicate_raw_claim_id",
      duplicatedRawClaimIds,
    };
  }

  const sanitizedToRaw = new Map<SanitizedClaimId, string>();
  for (const claim of claims) {
    const sanitized = sanitizeClaimId(claim.claimId);
    const existingRaw = sanitizedToRaw.get(sanitized);
    if (existingRaw !== undefined && existingRaw !== claim.claimId) {
      return {
        kind: "duplicate_sanitized_claim_id",
        collidingRawClaimIds: [existingRaw, claim.claimId],
        sanitizedClaimId: sanitized,
      };
    }

    sanitizedToRaw.set(sanitized, claim.claimId);
  }

  return null;
}

/**
 * Convert one compile-time merge conflict into a `logic.merge_conflict` finding.
 *
 * @param specFile - provenance file for the compile group
 * @param conflict - merge conflict emitted by `compileSpecSmtlib`
 * @returns stable finding shape with severity `error`
 *
 * @remarks
 * Preconditions:
 * - `conflict` is one of the closed `SpecMergeConflict` variants.
 *
 * Postconditions:
 * - output category is always `logic.merge_conflict`;
 * - output severity is always `error`;
 * - per-kind evidence preserves sanitized symbol identity plus both raw sides.
 *
 * Safety:
 * - exhaustive switch uses `assertNever(...)`, so adding a new conflict kind
 *   requires compile-time handling updates.
 *
 * Failure modes: none; pure conversion.
 */
export function conflictToFinding(specFile: string, conflict: SpecMergeConflict): Finding {
  switch (conflict.kind) {
    case "function_signature_mismatch":
      return {
        severity: "error",
        category: "logic.merge_conflict",
        provenance: { file: specFile },
        description: `Function signature mismatch on sanitized symbol ${conflict.sanitizedName}`,
        rationale: "Function declarations that share one sanitized symbol must agree on signature to keep merged SMT-LIB well-formed and analyzable.",
        evidence: [
          { kind: "kind", value: conflict.kind },
          { kind: "sanitized_name", value: conflict.sanitizedName },
          { kind: "existing_function_name", value: conflict.existingFunctionName },
          { kind: "conflicting_function_name", value: conflict.conflictingFunctionName },
          { kind: "existing_claim_id", value: conflict.existingClaimId },
          { kind: "excluded_claim_id", value: conflict.excludedClaimId },
          { kind: "claim_ids", value: conflict.claimIds.join(", ") },
        ],
        relatedClaimIdentifiers: [conflict.existingClaimId, conflict.excludedClaimId],
      };
    case "variable_sort_mismatch":
      return {
        severity: "error",
        category: "logic.merge_conflict",
        provenance: { file: specFile },
        description: `Variable sort mismatch on sanitized symbol ${conflict.sanitizedName}`,
        rationale: "Variable declarations that share one sanitized symbol must agree on exact sort to prevent hidden type aliasing in solver input.",
        evidence: [
          { kind: "kind", value: conflict.kind },
          { kind: "sanitized_name", value: conflict.sanitizedName },
          { kind: "existing_variable_name", value: conflict.existingVariableName },
          { kind: "conflicting_variable_name", value: conflict.conflictingVariableName },
          { kind: "expected_sort", value: conflict.expectedSort },
          { kind: "conflicting_sort", value: conflict.conflictingSort },
          { kind: "existing_claim_id", value: conflict.existingClaimId },
          { kind: "excluded_claim_id", value: conflict.excludedClaimId },
          { kind: "claim_ids", value: conflict.claimIds.join(", ") },
        ],
        relatedClaimIdentifiers: [conflict.existingClaimId, conflict.excludedClaimId],
      };
    case "symbol_kind_collision":
      return {
        severity: "error",
        category: "logic.merge_conflict",
        provenance: { file: specFile },
        description: `Symbol kind collision on sanitized symbol ${conflict.sanitizedName}`,
        rationale: "A sanitized symbol cannot be declared as both variable and function in the same combined SMT-LIB namespace.",
        evidence: [
          { kind: "kind", value: conflict.kind },
          { kind: "sanitized_name", value: conflict.sanitizedName },
          { kind: "existing_symbol_name", value: conflict.existingSymbolName },
          { kind: "existing_symbol_kind", value: conflict.existingSymbolKind },
          { kind: "conflicting_symbol_name", value: conflict.conflictingSymbolName },
          { kind: "conflicting_symbol_kind", value: conflict.conflictingSymbolKind },
          { kind: "existing_claim_id", value: conflict.existingClaimId },
          { kind: "excluded_claim_id", value: conflict.excludedClaimId },
          { kind: "claim_ids", value: conflict.claimIds.join(", ") },
        ],
        relatedClaimIdentifiers: [conflict.existingClaimId, conflict.excludedClaimId],
      };
    default:
      return assertNever(conflict);
  }
}

async function analyzeSpecGroup(
  group: SpecClaimGroup,
  outputDir: OutputDirPath,
  z3Path: string | undefined,
): Promise<SpecAnalysisResult> {
  const findings: Finding[] = [];
  const reportLines: string[] = [];

  let compileInvoked = false;
  let artifactWriteInvoked = false;
  let solverInvoked = false;

  const preflightIssue = preflightGroupClaimIds(group.claims);
  if (preflightIssue !== null) {
    const invalidGroupFinding = buildInvalidGroupFinding(group.specFile, group.claims, preflightIssue);
    findings.push(invalidGroupFinding);
    reportLines.push(`- ${group.specFile}: invalid compile group (${preflightIssue.kind})`);

    postcondition(compileInvoked === false, "invalid group must not invoke compileSpecSmtlib");
    postcondition(artifactWriteInvoked === false, "invalid group must not write solver artifacts");
    postcondition(solverInvoked === false, "invalid group must not invoke runZ3Query");
    return { findings, reportLines };
  }

  compileInvoked = true;
  const compiled = compileSpecSmtlib(group.specFile, group.claims);

  for (const conflict of compiled.conflicts) {
    const finding = conflictToFinding(group.specFile, conflict);
    findings.push(finding);
    reportLines.push(`- ${group.specFile}: merge conflict (${conflict.kind}) between ${conflict.claimIds.join(", ")}`);
  }

  if (compiled.claimIds.length === 0) {
    reportLines.push(`- ${group.specFile}: no claims to analyze (all excluded due to conflicts)`);
    postcondition(compileInvoked === true, "no-claims exit must have invoked compileSpecSmtlib");
    postcondition(solverInvoked === false, "no-claims exit must not invoke runZ3Query");
    postcondition(artifactWriteInvoked === false, "no-claims exit must not write solver artifacts");
    return { findings, reportLines };
  }

  const artifactBase = `smt/${group.artifactKey ?? compiled.sanitizedSpecId}`;

  solverInvoked = true;
  const phase1Result = await runZ3Query({
    smtlib: toSmtlibContent(`${compiled.smtlib}(check-sat)\n`),
    timeoutMs: 30_000,
    ...(z3Path === undefined ? {} : { z3Path }),
  });

  if (phase1Result.kind === "unsat") {
    solverInvoked = true;
    const phase2Result = await runZ3Query({
      smtlib: toSmtlibContent(`(set-option :produce-unsat-cores true)\n${compiled.smtlib}(check-sat)\n(get-unsat-core)\n`),
      timeoutMs: 30_000,
      ...(z3Path === undefined ? {} : { z3Path }),
    });

    artifactWriteInvoked = true;
    await Promise.all([
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.smt2`), compiled.smtlib),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stdout.txt`), phase2Result.stdout),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stderr.txt`), phase2Result.stderr),
    ]);

    const coreLabels = parseUnsatCore(phase2Result.stdout);
    const conflictingClaimIds = resolveCoreToClaims(coreLabels, compiled.assertionNameMap);
    const severity = deriveSeverityFromClaims(conflictingClaimIds, group.claims);
    const claimList = conflictingClaimIds.length > 0 ? conflictingClaimIds.join(", ") : "(core not available)";

    findings.push({
      severity,
      category: "logic.contradiction",
      provenance: { file: group.specFile },
      description: `Mutual contradiction among claims: ${claimList}`,
      rationale: "A contradiction means no model can satisfy the surviving claim set simultaneously.",
      evidence: [
        { kind: "smtlib", value: `${artifactBase}.smt2` },
        { kind: "unsat_core", value: claimList },
        { kind: "solver_stdout", value: `${artifactBase}.stdout.txt` },
      ],
      ...(conflictingClaimIds.length > 0 ? { relatedClaimIdentifiers: conflictingClaimIds } : {}),
    });

    reportLines.push(`- ${group.specFile}: UNSAT (contradiction) — core: ${claimList}`);
    postcondition(compileInvoked === true, "unsat exit must have invoked compileSpecSmtlib");
    postcondition(solverInvoked === true, "unsat exit must have invoked runZ3Query");
    postcondition(artifactWriteInvoked === true, "unsat exit must have written solver artifacts");
    return { findings, reportLines };
  }

  if (phase1Result.kind === "error") {
    artifactWriteInvoked = true;
    await Promise.all([
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.smt2`), compiled.smtlib),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stdout.txt`), phase1Result.stdout),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stderr.txt`), phase1Result.stderr),
    ]);

    const errorDetail = (phase1Result.errorCount ?? 0) > 0
      ? `Z3 emitted ${String(phase1Result.errorCount)} error(s)`
      : "Z3 rejected the input";

    findings.push({
      severity: "error",
      category: "logic.solver_error",
      provenance: { file: group.specFile },
      description: `${errorDetail} — formalization produced invalid SMT-LIB`,
      rationale: "Solver rejection means the formal model is malformed and cannot support a correctness conclusion.",
      evidence: [
        { kind: "smtlib", value: `${artifactBase}.smt2` },
        { kind: "solver_stdout", value: `${artifactBase}.stdout.txt` },
        { kind: "solver_stderr", value: `${artifactBase}.stderr.txt` },
      ],
      relatedClaimIdentifiers: [...compiled.claimIds],
    });

    reportLines.push(`- ${group.specFile}: ERROR (${errorDetail})`);
    postcondition(compileInvoked === true, "error exit must have invoked compileSpecSmtlib");
    postcondition(solverInvoked === true, "error exit must have invoked runZ3Query");
    postcondition(artifactWriteInvoked === true, "error exit must have written solver artifacts");
    return { findings, reportLines };
  }

  if (phase1Result.kind === "timeout" || phase1Result.kind === "unknown") {
    artifactWriteInvoked = true;
    await Promise.all([
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.smt2`), compiled.smtlib),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stdout.txt`), phase1Result.stdout),
      writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stderr.txt`), phase1Result.stderr),
    ]);

    findings.push({
      severity: "warning",
      category: "logic.inconclusive",
      provenance: { file: group.specFile },
      description: `Spec analysis inconclusive: ${phase1Result.kind}`,
      rationale: "Solver resource limits prevented a satisfiability verdict.",
      evidence: [
        { kind: "smtlib", value: `${artifactBase}.smt2` },
        { kind: "solver_stdout", value: `${artifactBase}.stdout.txt` },
        { kind: "solver_stderr", value: `${artifactBase}.stderr.txt` },
      ],
      relatedClaimIdentifiers: [...compiled.claimIds],
    });

    reportLines.push(`- ${group.specFile}: ${phase1Result.kind} (inconclusive)`);
    postcondition(compileInvoked === true, "inconclusive exit must have invoked compileSpecSmtlib");
    postcondition(solverInvoked === true, "inconclusive exit must have invoked runZ3Query");
    postcondition(artifactWriteInvoked === true, "inconclusive exit must have written solver artifacts");
    return { findings, reportLines };
  }

  artifactWriteInvoked = true;
  await Promise.all([
    writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.smt2`), compiled.smtlib),
    writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stdout.txt`), phase1Result.stdout),
    writeOutputAtomic(outputDir, toRelativePath(`${artifactBase}.stderr.txt`), phase1Result.stderr),
  ]);

  reportLines.push(`- ${group.specFile}: SAT (${String(compiled.claimIds.length)} claims globally consistent)`);

  const includedClaimIds = new Set(compiled.claimIds);
  const survivingClaims = group.claims.filter((claim) => includedClaimIds.has(claim.claimId));

  const pairwiseFindings = await runPairwiseContradictionChecks({
    claims: survivingClaims,
    specFile: group.specFile,
    z3Path,
  });
  findings.push(...pairwiseFindings);
  if (pairwiseFindings.length > 0) {
    reportLines.push(`  - pairwise contradictions found: ${String(pairwiseFindings.length)}`);
  }

  const completenessFindings = await runCompletenessCheck({
    claims: survivingClaims,
    specFile: group.specFile,
    z3Path,
  });
  findings.push(...completenessFindings);
  if (completenessFindings.length > 0) {
    reportLines.push(`  - completeness gaps found: ${String(completenessFindings.length)}`);
  }

  postcondition(compileInvoked === true, "SAT exit must have invoked compileSpecSmtlib");
  postcondition(solverInvoked === true, "SAT exit must have invoked runZ3Query");
  postcondition(artifactWriteInvoked === true, "SAT exit must have written solver artifacts");
  return { findings, reportLines };
}

function buildInvalidGroupFinding(
  specFile: string,
  claims: readonly LogicIrClaim[],
  issue: ClaimIdPreflightIssue,
): Finding {
  if (issue.kind === "duplicate_raw_claim_id") {
    const duplicatedIds = issue.duplicatedRawClaimIds ?? [];
    const affected = claims
      .filter((claim) => duplicatedIds.includes(claim.claimId))
      .map((claim) => claim.claimId);

    return {
      severity: "error",
      category: "logic.invalid_group",
      provenance: { file: specFile },
      description: `Compile group has duplicate raw claim IDs: ${duplicatedIds.join(", ")}`,
      rationale: "Claim IDs must be unique within one compile group so inclusion, assertion labels, and evidence mapping remain unambiguous.",
      evidence: [
        { kind: "reason", value: issue.kind },
        { kind: "duplicated_raw_ids", value: duplicatedIds.join(", ") },
        { kind: "affected_claims", value: affected.join(", ") },
      ],
      relatedClaimIdentifiers: affected,
    };
  }

  const collidingRawIds = issue.collidingRawClaimIds ?? [];
  return {
    severity: "error",
    category: "logic.invalid_group",
    provenance: { file: specFile },
    description: `Compile group has colliding sanitized claim IDs: ${collidingRawIds.join(", ")}`,
    rationale: "Even with injective sanitization, compile-group safety enforces sanitized claim-ID uniqueness before any compile or solver work.",
    evidence: [
      { kind: "reason", value: issue.kind },
      { kind: "colliding_raw_ids", value: collidingRawIds.join(", ") },
      { kind: "sanitized_claim_id", value: issue.sanitizedClaimId ?? "" },
    ],
    relatedClaimIdentifiers: collidingRawIds,
  };
}

function resolveCoreToClaims(coreLabels: readonly string[], assertionNameMap: ReadonlyMap<string, string>): string[] {
  const claimIds = new Set<string>();
  for (const label of coreLabels) {
    const claimId = assertionNameMap.get(label);
    if (claimId !== undefined) {
      claimIds.add(claimId);
    }
  }
  return [...claimIds];
}
