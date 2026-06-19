/**
 * Implements bidirectional implication checking between original spec formalizations
 * and code-derived formalizations using Z3, classifying each pair as same/stronger/weaker/different.
 *
 * Core verification step in the code-backwards analysis pipeline.
 * Exports: runCrossImplication, CrossImplicationResult.
 */
import { readFile } from "node:fs/promises";

import { runZ3Query } from "../../adapters/z3.js";
import { mapBounded } from "../../adapters/concurrency.js";
import { resolveConfinedOutputPath, writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, type OutputDirPath, type RelativePath } from "../branded.js";
import type { Finding } from "../findings.js";

import {
  CROSS_IMPLICATION_CONCURRENCY_DEFAULT,
  type CrossImplicationResult,
  type CrossImplicationOutput,
  type CapabilityAggregateOutput,
} from "./cross-implication-types.js";
import {
  buildImplicationQuery,
  classifyDirection,
  classifyRelationship,
  classificationScore,
  combineSmtContent,
} from "./cross-implication-smt.js";

// Re-export types, constants, and SMT utilities so existing consumers are unaffected.
export type { CrossClassification, CrossImplicationResult, CrossImplicationOutput, CapabilityAggregateOutput } from "./cross-implication-types.js";
export { CROSS_IMPLICATION_CONCURRENCY_DEFAULT } from "./cross-implication-types.js";
export { buildImplicationQuery, classifyDirection, classifyRelationship, classificationScore, combineSmtContent } from "./cross-implication-smt.js";

/**
 * Run bidirectional implication checks between original and code-derived formalizations.
 *
 * @param input - Paired original and generated formalizations to compare
 * @returns Classification results and findings for each matched pair
 *
 * @remarks
 * Precondition: all `smtlibPath` entries in `input.original` and `input.generated`
 * must be confined within `input.outputDir` (directory traversal is checked at resolve time).
 * Each claim pair is independent: forward and reverse Z3 queries within a pair
 * run in parallel, and pairs themselves are processed with bounded concurrency.
 * Results preserve the input ordering of `input.original`.
 * Postcondition: returned `results` has one entry per matched pair; `findings` includes
 * per-pair classification findings and per-capability divergence summaries.
 * Failure modes: propagates filesystem errors from `readFile` if SMT files are missing
 * or unreadable. Z3 subprocess failures are captured as "inconclusive" directions
 * (not thrown). Path confinement violations throw.
 * Safety: spawns up to `concurrency` Z3 subprocesses in parallel. Each subprocess is
 * independent with no shared mutable state between concurrent units.
 *
 * @example
 * ```typescript
 * const output = await runCrossImplication({
 *   outputDir: toOutputDirPath("/tmp/output"),
 *   original: [{ capability: "auth", claimId: "auth_01", smtlibPath: toRelativePath("formal/auth_01.smt2") }],
 *   generated: [{ capability: "auth", claimId: "auth_01", smtlibPath: toRelativePath("generated/auth_01.smt2") }],
 * });
 * // output.results[0].classification is "same" | "stronger" | "weaker" | "different" | "uncertain"
 * // output.findings contains per-pair and per-capability divergence findings
 * ```
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
      rationale: "Cross-side classification reveals whether the code-derived formalization preserves, weakens, strengthens, or contradicts the spec-derived semantics for this claim, directly indicating implementation fidelity at the individual requirement level.",
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
 * Precondition: all `smtlibPath` entries in both maps must be confined within `input.outputDir`.
 * Cost: 2 Z3 calls per matched capability.
 * Postcondition: findings include `capability_aggregate`, `novel_capability`, and
 * `unimplemented_capability` categories.
 * Failure modes: propagates filesystem errors from `readFile` if SMT files are missing
 * or unreadable. Z3 subprocess failures are captured as "inconclusive" directions.
 * Path confinement violations throw.
 * Safety: spawns 2 Z3 subprocesses per matched capability (forward + reverse) in parallel.
 * No shared mutable state between Z3 invocations.
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
        rationale: "A capability present only in the code-derived formalization may indicate undocumented behavior that lacks spec coverage, creating a verification blind spot where the code could diverge from intent without detection.",
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
        rationale: "A spec-defined capability with no code-derived counterpart suggests the implementation may be missing required behavior, or that source context limitations prevented the code analyzer from observing it.",
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
      rationale: "Aggregate capability-level comparison detects systemic divergence patterns that individual claim checks may miss, revealing whether an entire functional area has drifted from its specification.",
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
 * Precondition: all `smtlibPath` entries in both maps must be confined within `input.outputDir`.
 * For each matched capability:
 * - If N×M ≤ pairBudget: runs all bidirectional pairs, assigns greedily by classification score.
 * - If N×M > pairBudget: emits a `pairwise_skipped` finding and skips detailed comparison.
 *
 * Postcondition: returned results are compatible with `runBlindComparison` input.
 * Postcondition: greedy matching is deterministic given the same inputs.
 * Failure modes: propagates filesystem errors from `readFile` if SMT files are missing
 * or unreadable. Z3 subprocess failures are captured as "inconclusive" directions.
 * Path confinement violations throw.
 * Safety: spawns up to `concurrency` Z3 subprocesses in parallel per capability. Each
 * subprocess is independent with no shared mutable state between concurrent units.
 *
 * @example
 * ```typescript
 * const output = await runBoundedPairwiseComparison({
 *   outputDir: toOutputDirPath("/tmp/output"),
 *   originalByCapability: new Map([["auth", [{ claimId: "auth_01", smtlibPath: toRelativePath("formal/auth_01.smt2") }]]]),
 *   generatedByCapability: new Map([["auth", [{ claimId: "auth_01", smtlibPath: toRelativePath("generated/auth_01.smt2") }]]]),
 *   pairBudget: 50,
 * });
 * // output.results contains greedy-matched pairs with classifications
 * // output.findings includes per-pair, unmatched, and divergence findings
 * ```
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
        rationale: "Skipping pairwise comparison due to combinatorial explosion prevents excessive Z3 solver costs, but means fine-grained claim alignment within this capability remains unverified.",
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

    // Goal: pair each original claim with at most one generated claim, preferring
    // the strongest semantic relationship. Greedy matching is sufficient here
    // because we seek approximate alignment — identifying the best available
    // pairing for diagnostic purposes — rather than an optimal assignment that
    // would require Hungarian/Kuhn-Munkres. The downstream consumer only needs
    // a plausible 1:1 correspondence, not a provably minimal-cost matching.

    // Scoring: rank all N×M pair results by classification strength (highest
    // first). Tie-breaking by origClaimId via localeCompare ensures deterministic
    // output across runs — localeCompare is a total order on strings within a
    // single locale, so pairs with equal scores always resolve in the same
    // sequence regardless of the JS engine's sort stability characteristics.
    const scored = pairResults
      .map((pr) => ({ ...pr, score: classificationScore(pr.classification) }))
      .sort((a, b) => b.score - a.score || a.origClaimId.localeCompare(b.origClaimId));

    // Invariant: assignedOrig and assignedGen each contain exactly the set of
    // claim IDs that have already been matched. Because we only add to these
    // sets (never remove), and skip any entry whose ID appears in either set,
    // each claim is matched at most once — preserving the bipartite 1:1 property.
    const assignedOrig = new Set<string>();
    const assignedGen = new Set<string>();
    const matchedResults: typeof scored = [];

    // Iteration is safe because `scored` is sorted strongest-first: every
    // accepted pair is at least as strong as any pair that could replace it
    // later in the iteration. Skipped pairs cannot improve the overall quality.
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
        rationale: "The greedy-matched pair classification indicates whether the best-aligned code-derived claim preserves the semantics of its spec-derived counterpart, revealing per-requirement implementation fidelity after optimal pairing.",
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
          rationale: "An original spec claim that could not be paired to any generated claim may indicate a gap in code coverage—the specified behavior has no observable counterpart in the code-derived formalization.",
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
          rationale: "A generated claim without an original counterpart suggests the code implements behavior beyond the spec's scope, which may be intentional extension or an indicator of specification incompleteness.",
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
 * Summarize cross-implication results per capability, emitting divergence findings.
 *
 * @param results - all cross-implication results to summarize
 * @returns per-capability divergence summary findings
 *
 * @remarks
 * Precondition: none — handles empty `results` gracefully (returns empty findings).
 * Postcondition: emits error-severity "high_divergence" if >50% of a capability's claims
 * are "different" or "weaker"; info-severity "low_divergence" otherwise.
 * Failure modes: none — pure computation.
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
      rationale: "Capability-level divergence rate quantifies systematic implementation drift; high divergence signals that the majority of a capability's claims do not align with their spec-derived counterparts, indicating a likely structural mismatch.",
      evidence: entries.map((entry) => ({ kind: entry.claimId, value: entry.classification })),
    });
  }

  return findings;
}
