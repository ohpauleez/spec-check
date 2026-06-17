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

