import type { Finding, FindingSeverity } from "../findings.js";
import type { LogicIrClaim, LogicObligation, LogicVariableDeclaration } from "../logic-ir.js";
import { runZ3Query } from "../../adapters/z3.js";
import { mapBounded } from "../../adapters/concurrency.js";
import { compileSpecSmtlib, parseUnsatCore } from "./smtlib.js";
import { writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, toSmtlibContent, type OutputDirPath } from "../branded.js";
import { sanitizeIdentifier } from "./smtlib.js";

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
 * @param input - Claim groups (one per spec file), output directory, and optional Z3 path
 * @returns Findings and a markdown report summarizing solver results
 *
 * @remarks
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
 * @remarks
 * After the global satisfiability check, SAT results trigger pairwise guard-activation
 * contradiction checks and completeness gap detection. Claims excluded by merge
 * conflicts are filtered out of the deeper analysis.
 */
async function analyzeSpecGroup(
  group: SpecClaimGroup,
  outputDir: OutputDirPath,
  z3Path: string | undefined,
): Promise<SpecAnalysisResult> {
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

  // Two-phase Z3 approach:
  // Phase 1: check satisfiability without unsat-core overhead.
  // Phase 2 (only on UNSAT): re-run with (set-option :produce-unsat-cores true)
  //   and (get-unsat-core) to identify which claims conflict.
  const phase1Query = toSmtlibContent(`${compiled.smtlib}(check-sat)\n`);
  const result = await runZ3Query({
    smtlib: phase1Query,
    timeoutMs: 30_000,
    ...(z3Path === undefined ? {} : { z3Path }),
  });

  const artifactBase = `smt/${compiled.sanitizedSpecId}`;

  if (result.kind === "unsat") {
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

// ---------------------------------------------------------------------------
// Pairwise Guard-Activation Contradiction Checking
// ---------------------------------------------------------------------------

/**
 * A parsed implication assertion: antecedent => consequent.
 * Claims whose assertion expressions match `(=> guard consequent)` have
 * a guard that can be activated to check pairwise contradiction.
 */
interface ParsedImplication {
  readonly claim: LogicIrClaim;
  readonly assertionIndex: number;
  readonly guard: string;
  readonly consequent: string;
}

/**
 * Extract implications from claims. Only assertions matching the pattern
 * `(=> <guard> <consequent>)` are considered conditional rules.
 */
function extractImplications(claims: readonly LogicIrClaim[]): readonly ParsedImplication[] {
  const results: ParsedImplication[] = [];

  for (const claim of claims) {
    for (let i = 0; i < claim.assertions.length; i++) {
      const expr = claim.assertions[i]!.expr.trim();
      const parsed = parseImplicationExpr(expr);
      if (parsed !== null) {
        results.push({
          claim,
          assertionIndex: i,
          guard: parsed.guard,
          consequent: parsed.consequent,
        });
      }
    }
  }

  return results;
}

/**
 * Parse an SMT-LIB expression of the form `(=> <guard> <consequent>)`.
 * Returns null if the expression is not a simple implication.
 */
function parseImplicationExpr(expr: string): { guard: string; consequent: string } | null {
  if (!expr.startsWith("(=>")) {
    return null;
  }

  // Strip outer parens and "=>"
  const inner = expr.slice(1, -1).trim(); // Remove outer ( and )
  if (!inner.startsWith("=>")) {
    return null;
  }

  const afterArrow = inner.slice(2).trim();

  // Split into guard and consequent by balanced parentheses parsing.
  const parts = splitSExprParts(afterArrow);
  if (parts.length !== 2) {
    return null;
  }

  return { guard: parts[0]!, consequent: parts[1]! };
}

/**
 * Split an S-expression string into its top-level parts.
 * Handles both atomic identifiers and parenthesized sub-expressions.
 */
function splitSExprParts(expr: string): string[] {
  const parts: string[] = [];
  let i = 0;
  const len = expr.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(expr[i]!)) i++;
    if (i >= len) break;

    if (expr[i] === "(") {
      // Parenthesized expression — find matching close paren
      let depth = 0;
      const start = i;
      while (i < len) {
        if (expr[i] === "(") depth++;
        else if (expr[i] === ")") {
          depth--;
          if (depth === 0) { i++; break; }
        }
        i++;
      }
      parts.push(expr.slice(start, i));
    } else {
      // Atomic identifier
      const start = i;
      while (i < len && !/[\s()]/.test(expr[i]!)) i++;
      parts.push(expr.slice(start, i));
    }
  }

  return parts;
}

/**
 * Collect all variable declarations across a set of claims (deduplicated by name).
 */
function collectVariableDeclarations(claims: readonly LogicIrClaim[]): readonly LogicVariableDeclaration[] {
  const seen = new Map<string, LogicVariableDeclaration>();
  for (const claim of claims) {
    for (const variable of claim.variables) {
      if (!seen.has(variable.name)) {
        seen.set(variable.name, variable);
      }
    }
  }
  return [...seen.values()];
}

/**
 * Build SMT-LIB preamble declaring all variables from a set of claims.
 */
function buildDeclarationPreamble(variables: readonly LogicVariableDeclaration[]): string {
  return variables
    .map((v) => `(declare-const ${sanitizeIdentifier(v.name)} ${v.sort})`)
    .join("\n");
}

/**
 * Run pairwise guard-activation contradiction checks.
 *
 * For each pair of conditional assertions (implications), check whether both guards
 * can simultaneously hold while their consequents contradict. This detects
 * contradictions that the global SAT check misses (since the global check can
 * satisfy all implications by setting guards to false).
 *
 * @remarks
 * Strategy: For claims with assertions of the form `(=> Guard_i Consequent_i)`:
 * 1. Identify pairs where consequents reference overlapping variables
 * 2. For each such pair, query Z3: can guards coexist while consequents conflict?
 *    Query: assert(Guard_i), assert(Guard_j), assert(not (and Consequent_i Consequent_j))
 *    If SAT: guards can coexist with conflicting outputs (potential issue)
 *    Then verify: assert(Guard_i), assert(Guard_j), assert(Consequent_i), assert(Consequent_j)
 *    If UNSAT: consequents genuinely contradict when both guards are active.
 */
async function runPairwiseContradictionChecks(input: {
  readonly claims: readonly LogicIrClaim[];
  readonly specFile: string;
  readonly z3Path: string | undefined;
}): Promise<readonly Finding[]> {
  const implications = extractImplications(input.claims);
  if (implications.length < 2) {
    return [];
  }

  const allVariables = collectVariableDeclarations(input.claims);
  const preamble = buildDeclarationPreamble(allVariables);
  const findings: Finding[] = [];

  // Generate pairs to check — limit to reasonable number to avoid quadratic explosion.
  const pairs: [ParsedImplication, ParsedImplication][] = [];
  const maxPairs = 50; // Limit pairwise checks to avoid excessive solver calls.
  for (let i = 0; i < implications.length && pairs.length < maxPairs; i++) {
    for (let j = i + 1; j < implications.length && pairs.length < maxPairs; j++) {
      // Only check pairs from different claims (same-claim contradictions are less interesting).
      if (implications[i]!.claim.claimId !== implications[j]!.claim.claimId) {
        pairs.push([implications[i]!, implications[j]!]);
      }
    }
  }

  // Check each pair with bounded concurrency.
  const pairResults = await mapBounded(pairs, 4, async ([left, right]) => {
    return await checkPairContradiction(left, right, preamble, input.z3Path);
  });

  for (let idx = 0; idx < pairs.length; idx++) {
    const result = pairResults[idx];
    if (result === undefined || !result.contradicts) continue;

    const [left, right] = pairs[idx]!;
    const severity = deriveSeverityFromClaims(
      [left.claim.claimId, right.claim.claimId],
      input.claims,
    );

    findings.push({
      severity,
      category: "logic.conditional_contradiction",
      provenance: { file: input.specFile },
      description: `Conditional contradiction: when guards of "${left.claim.claimId}" and "${right.claim.claimId}" are both active, their consequents conflict`,
      evidence: [
        { kind: "left_claim", value: left.claim.claimId },
        { kind: "right_claim", value: right.claim.claimId },
        { kind: "left_guard", value: left.guard },
        { kind: "right_guard", value: right.guard },
      ],
      relatedClaimIdentifiers: [left.claim.claimId, right.claim.claimId],
    });
  }

  return findings;
}

/**
 * Check whether two implications have contradictory consequents when both guards are active.
 */
async function checkPairContradiction(
  left: ParsedImplication,
  right: ParsedImplication,
  preamble: string,
  z3Path: string | undefined,
): Promise<{ contradicts: boolean }> {
  // Query: Are both guards satisfiable while consequents conflict?
  // assert(Guard_i), assert(Guard_j), assert(Consequent_i), assert(Consequent_j)
  // If UNSAT: consequents genuinely contradict when both guards are active.
  const query = toSmtlibContent([
    preamble,
    `(assert ${left.guard})`,
    `(assert ${right.guard})`,
    `(assert ${left.consequent})`,
    `(assert ${right.consequent})`,
    "(check-sat)",
  ].join("\n") + "\n");

  const result = await runZ3Query({
    smtlib: query,
    timeoutMs: 10_000,
    ...(z3Path === undefined ? {} : { z3Path }),
  });

  // UNSAT means the consequents cannot both hold when both guards are active.
  return { contradicts: result.kind === "unsat" };
}

// ---------------------------------------------------------------------------
// Completeness Gap Detection
// ---------------------------------------------------------------------------

/**
 * Check whether there exists a reachable state where no conditional rule applies.
 *
 * @remarks
 * Strategy: Negate all guards of conditional assertions and check satisfiability.
 * If SAT, there exists a state where no conditional rule fires, meaning the
 * specification has a completeness gap — behavior is unspecified for that state.
 *
 * Only reports a gap when all requirements are conditional (implications).
 * If any ubiquitous (unconditional) assertions exist, the spec has some
 * coverage in all states and this check is less meaningful.
 */
async function runCompletenessCheck(input: {
  readonly claims: readonly LogicIrClaim[];
  readonly specFile: string;
  readonly z3Path: string | undefined;
}): Promise<readonly Finding[]> {
  const implications = extractImplications(input.claims);
  if (implications.length < 2) {
    return [];
  }

  // Check if there are any ubiquitous (non-conditional) assertions.
  // If so, the spec has some coverage in all states and this check is less relevant.
  const hasUbiquitousAssertions = input.claims.some((claim) =>
    claim.assertions.some((a) => {
      const trimmed = a.expr.trim();
      return !trimmed.startsWith("(=>");
    }),
  );

  if (hasUbiquitousAssertions) {
    return []; // Skip completeness check when unconditional rules exist.
  }

  const allVariables = collectVariableDeclarations(input.claims);
  const preamble = buildDeclarationPreamble(allVariables);

  // Build query: negate all guards — is there a state where nothing fires?
  const negatedGuards = implications.map(
    (impl) => `(assert (not ${impl.guard}))`,
  );

  const query = toSmtlibContent([
    preamble,
    ...negatedGuards,
    "(check-sat)",
  ].join("\n") + "\n");

  const result = await runZ3Query({
    smtlib: query,
    timeoutMs: 10_000,
    ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
  });

  if (result.kind === "sat") {
    // There exists a state where no conditional rule applies.
    const guardDescriptions = implications.map(
      (impl) => `${impl.claim.claimId}:${impl.guard}`,
    );

    return [{
      severity: "warning",
      category: "logic.completeness_gap",
      provenance: { file: input.specFile },
      description: `Completeness gap: there exist states where none of the ${String(implications.length)} conditional rules apply — behavior is unspecified`,
      evidence: [
        { kind: "guard_count", value: String(implications.length) },
        { kind: "guards", value: guardDescriptions.slice(0, 5).join("; ") + (guardDescriptions.length > 5 ? "; ..." : "") },
      ],
      relatedClaimIdentifiers: [...new Set(implications.map((i) => i.claim.claimId))],
    }];
  }

  return [];
}
