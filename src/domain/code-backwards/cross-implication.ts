import { readFile } from "node:fs/promises";

import { runZ3Query } from "../../adapters/z3.js";
import { mapBounded } from "../../adapters/concurrency.js";
import { resolveConfinedOutputPath, writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, toSmtlibContent, type OutputDirPath, type RelativePath, type SmtlibContent } from "../branded.js";
import type { Finding } from "../findings.js";
import { parseSmtlibContent } from "../formal/smtlib.js";

/**
 * Closed domain of cross-side relationship classifications between original and generated formalizations.
 *
 * - `"same"`: mutual implication holds (logically equivalent)
 * - `"stronger"`: generated implies original but not vice versa
 * - `"weaker"`: original implies generated but not vice versa
 * - `"different"`: neither direction holds
 * - `"uncertain"`: at least one direction was inconclusive
 */
export type CrossClassification = "same" | "stronger" | "weaker" | "different" | "uncertain";

/**
 * Result of a bidirectional implication check between original and generated formalizations for one claim.
 *
 * @remarks
 * Invariant: `forward` and `reverse` represent the original→generated and generated→original
 * implication directions respectively.
 * Invariant: `evidencePaths` contains paths to all persisted query and output artifacts.
 */
export interface CrossImplicationResult {
  readonly capability: string;
  readonly claimId: string;
  readonly classification: CrossClassification;
  readonly forward: "yes" | "no" | "inconclusive";
  readonly reverse: "yes" | "no" | "inconclusive";
  readonly evidencePaths: readonly string[];
}

/**
 * Output from the cross-implication analysis pass.
 *
 * @remarks
 * Invariant: `results` preserves the ordering of matched pairs from `input.original`.
 * Invariant: `findings` includes per-claim classification findings and per-capability
 * divergence summaries.
 */
export interface CrossImplicationOutput {
  readonly findings: readonly Finding[];
  readonly results: readonly CrossImplicationResult[];
}

/** Maximum concurrent Z3 cross-implication checks. */
const CROSS_IMPLICATION_CONCURRENCY_DEFAULT = 4;

/**
 * Run bidirectional implication checks between original and code-derived formalizations.
 *
 * @param input - Paired original and generated formalizations to compare
 * @returns Classification results and findings for each matched pair
 *
 * @remarks
 * Each claim pair is independent: forward and reverse Z3 queries within a pair
 * run in parallel, and pairs themselves are processed with bounded concurrency.
 * Results preserve the input ordering of `input.original`.
 */
export async function runCrossImplication(input: {
  readonly outputDir: OutputDirPath;
  readonly original: readonly { readonly capability: string; readonly claimId: string; readonly smtlibPath: RelativePath }[];
  readonly generated: readonly { readonly capability: string; readonly claimId: string; readonly smtlibPath: RelativePath }[];
  readonly z3Path?: string;
  readonly concurrency?: number;
}): Promise<CrossImplicationOutput> {
  const concurrency = input.concurrency ?? CROSS_IMPLICATION_CONCURRENCY_DEFAULT;

  // Filter to only pairs that have a matching generated counterpart.
  const matchedPairs = input.original
    .map((original) => {
      const generated = input.generated.find(
        (candidate) => candidate.capability === original.capability && candidate.claimId === original.claimId,
      );
      return generated !== undefined ? { original, generated } : undefined;
    })
    .filter((pair): pair is NonNullable<typeof pair> => pair !== undefined);

  const pairResults = await mapBounded(matchedPairs, concurrency, async (pair) => {
    // Resolve paths with confinement check to prevent directory traversal.
    const originalSmt = await readFile(resolveConfinedOutputPath(input.outputDir, pair.original.smtlibPath), "utf8");
    const generatedSmt = await readFile(resolveConfinedOutputPath(input.outputDir, pair.generated.smtlibPath), "utf8");

    const forwardQuery = buildImplicationQuery(originalSmt, generatedSmt);
    const reverseQuery = buildImplicationQuery(generatedSmt, originalSmt);

    // Forward and reverse queries are independent; run in parallel.
    const [forwardResult, reverseResult] = await Promise.all([
      runZ3Query({
        smtlib: forwardQuery,
        timeoutMs: 30_000,
        ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
      }),
      runZ3Query({
        smtlib: reverseQuery,
        timeoutMs: 30_000,
        ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
      }),
    ]);

    const forward = classifyDirection(forwardResult.kind);
    const reverse = classifyDirection(reverseResult.kind);
    const classification = classifyRelationship(forward, reverse);

    const basePath = `cross_implication/${pair.original.capability}/${pair.original.claimId}`;
    const forwardQueryPath = toRelativePath(`${basePath}.forward.smt2`);
    const reverseQueryPath = toRelativePath(`${basePath}.reverse.smt2`);
    const forwardOutPath = toRelativePath(`${basePath}.forward.out.txt`);
    const reverseOutPath = toRelativePath(`${basePath}.reverse.out.txt`);

    // File writes are independent; batch them.
    await Promise.all([
      writeOutputAtomic(input.outputDir, forwardQueryPath, forwardQuery),
      writeOutputAtomic(input.outputDir, reverseQueryPath, reverseQuery),
      writeOutputAtomic(input.outputDir, forwardOutPath, `${forwardResult.stdout}\n${forwardResult.stderr}`),
      writeOutputAtomic(input.outputDir, reverseOutPath, `${reverseResult.stdout}\n${reverseResult.stderr}`),
    ]);

    const evidencePaths = [forwardQueryPath, reverseQueryPath, forwardOutPath, reverseOutPath];
    const result: CrossImplicationResult = {
      capability: pair.original.capability,
      claimId: pair.original.claimId,
      classification,
      forward,
      reverse,
      evidencePaths,
    };

    const finding: Finding = {
      severity: classification === "weaker" || classification === "different" ? "error" : classification === "uncertain" ? "warning" : "info",
      category: "code_backwards.cross_implication",
      provenance: { file: pair.original.smtlibPath, heading: pair.original.claimId },
      description: `Cross-side classification for ${pair.original.claimId}: ${classification}`,
      evidence: evidencePaths.map((path) => ({ kind: "artifact", value: path })),
      relatedClaimIdentifiers: [pair.original.claimId],
    };

    return { result, finding };
  });

  // Assemble results in deterministic input order.
  const results = pairResults.map((pr) => pr.result);
  const findings = pairResults.map((pr) => pr.finding);

  findings.push(...summarizePerCapability(results));
  return { findings, results };
}

// ---------------------------------------------------------------------------
// Tier 1: Capability-level aggregate comparison
// ---------------------------------------------------------------------------

/**
 * Output from the capability-level aggregate comparison pass.
 */
export interface CapabilityAggregateOutput {
  readonly findings: readonly Finding[];
}

/**
 * Run capability-level aggregate bidirectional implication checks.
 *
 * For each capability present on both sides, combines all SMT assertions from
 * each side into a single conjunction and runs a bidirectional implication check.
 * Also reports capabilities present on only one side.
 *
 * @param input - grouped original and generated formalizations by capability
 * @returns findings including aggregate classifications and unmatched capability signals
 *
 * @remarks
 * Cost: 2 Z3 calls per matched capability.
 * Postcondition: findings include `capability_aggregate`, `novel_capability`, and
 * `unimplemented_capability` categories.
 */
export async function runCapabilityAggregateComparison(input: {
  readonly outputDir: OutputDirPath;
  readonly originalByCapability: ReadonlyMap<string, readonly { readonly claimId: string; readonly smtlibPath: RelativePath }[]>;
  readonly generatedByCapability: ReadonlyMap<string, readonly { readonly claimId: string; readonly smtlibPath: RelativePath }[]>;
  readonly z3Path?: string;
}): Promise<CapabilityAggregateOutput> {
  const findings: Finding[] = [];

  const originalCaps = new Set(input.originalByCapability.keys());
  const generatedCaps = new Set(input.generatedByCapability.keys());

  // Capabilities only on generated side — code does more than spec says.
  for (const cap of generatedCaps) {
    if (!originalCaps.has(cap)) {
      const genClaims = input.generatedByCapability.get(cap)!;
      findings.push({
        severity: "info",
        category: "code_backwards.novel_capability",
        provenance: { file: "<cross-implication>", heading: cap },
        description: `Generated capability "${cap}" has no original spec counterpart (${genClaims.length} claims). Possible causes: code covers behavior not in spec, context budget excluded relevant source, or LLM used non-suggested name.`,
        evidence: [{ kind: "claim_count", value: String(genClaims.length) }],
      });
    }
  }

  // Capabilities only on original side — spec has no generated counterpart.
  for (const cap of originalCaps) {
    if (!generatedCaps.has(cap)) {
      const origClaims = input.originalByCapability.get(cap)!;
      findings.push({
        severity: "warning",
        category: "code_backwards.unimplemented_capability",
        provenance: { file: "<cross-implication>", heading: cap },
        description: `Original capability "${cap}" has no generated counterpart (${origClaims.length} claims). Possible causes: code gap, source context budget limitation, or LLM omission.`,
        evidence: [{ kind: "claim_count", value: String(origClaims.length) }],
        relatedClaimIdentifiers: origClaims.map((c) => c.claimId),
      });
    }
  }

  // Matched capabilities — run aggregate bidirectional implication.
  const matchedCaps = [...originalCaps].filter((cap) => generatedCaps.has(cap));

  for (const cap of matchedCaps) {
    const origClaims = input.originalByCapability.get(cap)!;
    const genClaims = input.generatedByCapability.get(cap)!;

    // Read and combine all SMT content for each side.
    const origSmtParts = await Promise.all(
      origClaims.map((c) => readFile(resolveConfinedOutputPath(input.outputDir, c.smtlibPath), "utf8")),
    );
    const genSmtParts = await Promise.all(
      genClaims.map((c) => readFile(resolveConfinedOutputPath(input.outputDir, c.smtlibPath), "utf8")),
    );

    const combinedOrigSmt = combineSmtContent(origSmtParts);
    const combinedGenSmt = combineSmtContent(genSmtParts);

    const forwardQuery = buildImplicationQuery(combinedOrigSmt, combinedGenSmt);
    const reverseQuery = buildImplicationQuery(combinedGenSmt, combinedOrigSmt);

    const [forwardResult, reverseResult] = await Promise.all([
      runZ3Query({
        smtlib: forwardQuery,
        timeoutMs: 30_000,
        ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
      }),
      runZ3Query({
        smtlib: reverseQuery,
        timeoutMs: 30_000,
        ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
      }),
    ]);

    const forward = classifyDirection(forwardResult.kind);
    const reverse = classifyDirection(reverseResult.kind);
    const classification = classifyRelationship(forward, reverse);

    // Persist aggregate evidence.
    const basePath = `cross_implication_aggregate/${cap}`;
    const forwardQueryPath = toRelativePath(`${basePath}.forward.smt2`);
    const reverseQueryPath = toRelativePath(`${basePath}.reverse.smt2`);
    const forwardOutPath = toRelativePath(`${basePath}.forward.out.txt`);
    const reverseOutPath = toRelativePath(`${basePath}.reverse.out.txt`);

    await Promise.all([
      writeOutputAtomic(input.outputDir, forwardQueryPath, forwardQuery),
      writeOutputAtomic(input.outputDir, reverseQueryPath, reverseQuery),
      writeOutputAtomic(input.outputDir, forwardOutPath, `${forwardResult.stdout}\n${forwardResult.stderr}`),
      writeOutputAtomic(input.outputDir, reverseOutPath, `${reverseResult.stdout}\n${reverseResult.stderr}`),
    ]);

    findings.push({
      severity: classification === "weaker" || classification === "different" ? "error" : classification === "uncertain" ? "warning" : "info",
      category: "code_backwards.capability_aggregate",
      provenance: { file: "<cross-implication>", heading: cap },
      description: `Capability "${cap}" aggregate comparison: ${classification} (original: ${origClaims.length} claims, generated: ${genClaims.length} claims)`,
      evidence: [
        { kind: "classification", value: classification },
        { kind: "forward", value: forward },
        { kind: "reverse", value: reverse },
        { kind: "artifact", value: forwardQueryPath },
        { kind: "artifact", value: reverseQueryPath },
      ],
      relatedClaimIdentifiers: origClaims.map((c) => c.claimId),
    });
  }

  return { findings };
}

// ---------------------------------------------------------------------------
// Tier 2: Bounded pairwise cross-implication with greedy matching
// ---------------------------------------------------------------------------

/**
 * Run bounded pairwise bidirectional implication checks within each matched capability,
 * then apply greedy bipartite matching to assign best pairs.
 *
 * @param input - grouped claims by capability, pair budget, and Z3 configuration
 * @returns cross-implication results (for blind comparison) and detailed findings
 *
 * @remarks
 * For each matched capability:
 * - If N×M ≤ pairBudget: runs all bidirectional pairs, assigns greedily by classification score.
 * - If N×M > pairBudget: emits a `pairwise_skipped` finding and skips detailed comparison.
 *
 * Postcondition: returned results are compatible with `runBlindComparison` input.
 * Postcondition: greedy matching is deterministic given the same inputs.
 */
export async function runBoundedPairwiseComparison(input: {
  readonly outputDir: OutputDirPath;
  readonly originalByCapability: ReadonlyMap<string, readonly { readonly claimId: string; readonly smtlibPath: RelativePath }[]>;
  readonly generatedByCapability: ReadonlyMap<string, readonly { readonly claimId: string; readonly smtlibPath: RelativePath }[]>;
  readonly pairBudget: number;
  readonly z3Path?: string;
  readonly concurrency?: number;
}): Promise<CrossImplicationOutput> {
  const concurrency = input.concurrency ?? CROSS_IMPLICATION_CONCURRENCY_DEFAULT;
  const allFindings: Finding[] = [];
  const allResults: CrossImplicationResult[] = [];

  const originalCaps = new Set(input.originalByCapability.keys());
  const generatedCaps = new Set(input.generatedByCapability.keys());
  const matchedCaps = [...originalCaps].filter((cap) => generatedCaps.has(cap));

  for (const cap of matchedCaps) {
    const origClaims = input.originalByCapability.get(cap)!;
    const genClaims = input.generatedByCapability.get(cap)!;
    const pairCount = origClaims.length * genClaims.length;

    if (pairCount > input.pairBudget) {
      allFindings.push({
        severity: "info",
        category: "code_backwards.pairwise_skipped",
        provenance: { file: "<cross-implication>", heading: cap },
        description: `Pairwise comparison skipped for "${cap}": ${pairCount} pairs exceeds budget of ${input.pairBudget}`,
        evidence: [
          { kind: "original_count", value: String(origClaims.length) },
          { kind: "generated_count", value: String(genClaims.length) },
          { kind: "pair_count", value: String(pairCount) },
          { kind: "budget", value: String(input.pairBudget) },
        ],
      });
      continue;
    }

    // Build all N×M pairs for this capability.
    const pairs: { orig: typeof origClaims[number]; gen: typeof genClaims[number] }[] = [];
    for (const orig of origClaims) {
      for (const gen of genClaims) {
        pairs.push({ orig, gen });
      }
    }

    // Run bidirectional Z3 for all pairs with bounded concurrency.
    const pairResults = await mapBounded(pairs, concurrency, async (pair) => {
      const originalSmt = await readFile(resolveConfinedOutputPath(input.outputDir, pair.orig.smtlibPath), "utf8");
      const generatedSmt = await readFile(resolveConfinedOutputPath(input.outputDir, pair.gen.smtlibPath), "utf8");

      const forwardQuery = buildImplicationQuery(originalSmt, generatedSmt);
      const reverseQuery = buildImplicationQuery(generatedSmt, originalSmt);

      const [forwardResult, reverseResult] = await Promise.all([
        runZ3Query({
          smtlib: forwardQuery,
          timeoutMs: 30_000,
          ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
        }),
        runZ3Query({
          smtlib: reverseQuery,
          timeoutMs: 30_000,
          ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
        }),
      ]);

      const forward = classifyDirection(forwardResult.kind);
      const reverse = classifyDirection(reverseResult.kind);
      const classification = classifyRelationship(forward, reverse);

      return {
        origClaimId: pair.orig.claimId,
        genClaimId: pair.gen.claimId,
        forward,
        reverse,
        classification,
        forwardQuery,
        reverseQuery,
        forwardOut: `${forwardResult.stdout}\n${forwardResult.stderr}`,
        reverseOut: `${reverseResult.stdout}\n${reverseResult.stderr}`,
      };
    });

    // Greedy bipartite matching: sort by classification score, assign greedily.
    const scored = pairResults
      .map((pr) => ({ ...pr, score: classificationScore(pr.classification) }))
      .sort((a, b) => b.score - a.score || a.origClaimId.localeCompare(b.origClaimId));

    const assignedOrig = new Set<string>();
    const assignedGen = new Set<string>();
    const matchedResults: typeof scored = [];

    for (const entry of scored) {
      if (assignedOrig.has(entry.origClaimId) || assignedGen.has(entry.genClaimId)) {
        continue;
      }
      assignedOrig.add(entry.origClaimId);
      assignedGen.add(entry.genClaimId);
      matchedResults.push(entry);
    }

    // Persist evidence and emit findings for matched pairs.
    for (const match of matchedResults) {
      const basePath = `cross_implication/${cap}/${match.origClaimId}_vs_${match.genClaimId}`;
      const forwardQueryPath = toRelativePath(`${basePath}.forward.smt2`);
      const reverseQueryPath = toRelativePath(`${basePath}.reverse.smt2`);
      const forwardOutPath = toRelativePath(`${basePath}.forward.out.txt`);
      const reverseOutPath = toRelativePath(`${basePath}.reverse.out.txt`);

      await Promise.all([
        writeOutputAtomic(input.outputDir, forwardQueryPath, match.forwardQuery),
        writeOutputAtomic(input.outputDir, reverseQueryPath, match.reverseQuery),
        writeOutputAtomic(input.outputDir, forwardOutPath, match.forwardOut),
        writeOutputAtomic(input.outputDir, reverseOutPath, match.reverseOut),
      ]);

      const evidencePaths = [forwardQueryPath, reverseQueryPath, forwardOutPath, reverseOutPath];
      const result: CrossImplicationResult = {
        capability: cap,
        claimId: match.origClaimId,
        classification: match.classification,
        forward: match.forward,
        reverse: match.reverse,
        evidencePaths,
      };
      allResults.push(result);

      allFindings.push({
        severity: match.classification === "weaker" || match.classification === "different" ? "error" : match.classification === "uncertain" ? "warning" : "info",
        category: "code_backwards.cross_implication",
        provenance: { file: `<cross-implication>`, heading: `${match.origClaimId} vs ${match.genClaimId}` },
        description: `Cross-side classification for ${match.origClaimId} (matched to ${match.genClaimId}): ${match.classification}`,
        evidence: evidencePaths.map((path) => ({ kind: "artifact", value: path })),
        relatedClaimIdentifiers: [match.origClaimId],
      });
    }

    // Report unmatched original claims.
    for (const orig of origClaims) {
      if (!assignedOrig.has(orig.claimId)) {
        allFindings.push({
          severity: "warning",
          category: "code_backwards.unmatched_original",
          provenance: { file: `<cross-implication>`, heading: cap },
          description: `Original claim ${orig.claimId} in capability "${cap}" could not be paired to any generated claim`,
          evidence: [{ kind: "claim_id", value: orig.claimId }],
          relatedClaimIdentifiers: [orig.claimId],
        });
      }
    }

    // Report unmatched generated claims.
    for (const gen of genClaims) {
      if (!assignedGen.has(gen.claimId)) {
        allFindings.push({
          severity: "info",
          category: "code_backwards.unmatched_generated",
          provenance: { file: `<cross-implication>`, heading: cap },
          description: `Generated claim ${gen.claimId} in capability "${cap}" could not be paired to any original claim`,
          evidence: [{ kind: "claim_id", value: gen.claimId }],
          relatedClaimIdentifiers: [gen.claimId],
        });
      }
    }
  }

  // Add divergence summary for paired results.
  allFindings.push(...summarizePerCapability(allResults));

  return { findings: allFindings, results: allResults };
}

/**
 * Score a cross-classification for greedy matching priority.
 * Higher scores are preferred when assigning pairs.
 */
function classificationScore(classification: CrossClassification): number {
  switch (classification) {
    case "same":
      return 4;
    case "stronger":
      return 3;
    case "uncertain":
      return 2;
    case "weaker":
      return 1;
    case "different":
      return 0;
  }
}

/**
 * Combine multiple SMT-LIB file contents into a single synthetic SMT block
 * suitable for aggregate implication queries.
 *
 * @param smtContents - individual SMT-LIB content strings
 * @returns combined content with deduplicated declarations and merged assertions
 *
 * @remarks
 * Declarations are deduplicated by exact string match to avoid Z3 redeclaration errors.
 * Assertions are preserved verbatim.
 */
function combineSmtContent(smtContents: readonly string[]): string {
  const seenDeclarations = new Set<string>();
  const allDeclarations: string[] = [];
  const allAssertionExprs: string[] = [];

  for (const content of smtContents) {
    const parts = parseSmtlibContent(content);
    for (const decl of parts.declarations) {
      if (!seenDeclarations.has(decl)) {
        seenDeclarations.add(decl);
        allDeclarations.push(decl);
      }
    }
    allAssertionExprs.push(...parts.assertionExprs);
  }

  // Reassemble into a format compatible with buildImplicationQuery's parseSmtlibContent.
  const lines: string[] = [];
  lines.push(...allDeclarations);
  for (const expr of allAssertionExprs) {
    lines.push(`(assert ${expr})`);
  }
  return lines.join("\n");
}

/**
 * Build an SMT-LIB implication query combining two SMT content blocks.
 *
 * @param leftSmt - SMT-LIB content for the premise side
 * @param rightSmt - SMT-LIB content for the consequent side
 * @returns combined SMT-LIB content encoding the implication check
 *
 * @remarks
 * Strategy: include declarations from both sides for shared context, assert left's
 * assertions as the premise, then assert the negation of right's assertions.
 * If Z3 returns "unsat", the left implies the right.
 * Postcondition: output contains exactly one `(check-sat)` at the end.
 */
/** @internal Exported for testing. */
export function buildImplicationQuery(leftSmt: string, rightSmt: string): SmtlibContent {
  const leftParts = parseSmtlibContent(leftSmt);
  const rightParts = parseSmtlibContent(rightSmt);

  const declarations = [...leftParts.declarations, ...rightParts.declarations];
  const leftAssertions = leftParts.assertionExprs.map((expr) => `(assert ${expr})`);

  // Negate the consequent: if unsat, left entails right.
  const negatedConsequent = rightParts.assertionExprs.length === 0
    ? "(assert (not true))"
    : `(assert (not (and ${rightParts.assertionExprs.join(" ")})))`;

  return toSmtlibContent([
    "; cross-side implication query",
    ...declarations,
    ...leftAssertions,
    negatedConsequent,
    "(check-sat)",
  ].join("\n"));
}

/**
 * Classify a Z3 solver result into a ternary implication direction.
 *
 * @param kind - Z3 result kind (sat, unsat, timeout, unknown, error)
 * @returns "yes" if unsat (implication holds), "no" if sat (counterexample), "inconclusive" otherwise
 *
 * @remarks
 * Postcondition: mapping is total over the input domain.
 */
export function classifyDirection(kind: "sat" | "unsat" | "timeout" | "unknown" | "error"): "yes" | "no" | "inconclusive" {
  if (kind === "unsat") {
    return "yes";
  }
  if (kind === "sat") {
    return "no";
  }
  return "inconclusive";
}

/**
 * Classify the cross-side relationship from forward and reverse implication results.
 *
 * @param forward - result of original→generated implication check
 * @param reverse - result of generated→original implication check
 * @returns cross-classification from the closed `CrossClassification` domain
 *
 * @remarks
 * Postcondition: returns "uncertain" if either direction is inconclusive;
 * "same" for mutual implication; "weaker"/"stronger"/"different" based on
 * which direction holds.
 */
export function classifyRelationship(
  forward: "yes" | "no" | "inconclusive",
  reverse: "yes" | "no" | "inconclusive",
): CrossClassification {
  if (forward === "inconclusive" || reverse === "inconclusive") {
    return "uncertain";
  }
  if (forward === "yes" && reverse === "yes") {
    return "same";
  }
  if (forward === "yes" && reverse === "no") {
    return "weaker";
  }
  if (forward === "no" && reverse === "yes") {
    return "stronger";
  }
  return "different";
}

/**
 * Summarize cross-implication results per capability, emitting divergence findings.
 *
 * @param results - all cross-implication results to summarize
 * @returns per-capability divergence summary findings
 *
 * @remarks
 * Postcondition: emits error-severity "high_divergence" if >50% of a capability's claims
 * are "different" or "weaker"; info-severity "low_divergence" otherwise.
 */
function summarizePerCapability(results: readonly CrossImplicationResult[]): readonly Finding[] {
  const byCapability = new Map<string, CrossImplicationResult[]>();
  for (const result of results) {
    // Ownership: arrays are local to this Map; mutation avoids O(n^2) spread copies.
    const existing = byCapability.get(result.capability);
    if (existing !== undefined) {
      existing.push(result);
    } else {
      byCapability.set(result.capability, [result]);
    }
  }

  const findings: Finding[] = [];
  for (const [capability, entries] of byCapability) {
    const divergent = entries.filter((entry) => entry.classification === "different" || entry.classification === "weaker");
    const category = divergent.length > entries.length / 2 ? "high_divergence" : "low_divergence";
    findings.push({
      severity: category === "high_divergence" ? "error" : "info",
      category: "code_backwards.capability_divergence",
      provenance: { file: "<cross-implication>", heading: capability },
      description: `Capability ${capability} divergence summary: ${category}`,
      evidence: entries.map((entry) => ({ kind: entry.claimId, value: entry.classification })),
    });
  }

  return findings;
}

