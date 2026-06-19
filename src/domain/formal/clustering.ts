/**
 * Clusters formalization samples using pairwise Z3 implication checks.
 * Groups logically equivalent samples so downstream analysis uses a single
 * representative per semantic cluster.
 *
 * Part of the formal verification layer — sits between formalization and logic analysis.
 * Exports: clusterFormalizationSamples, ImplicationResult.
 */
import { runZ3Query } from "../../adapters/z3.js";
import { mapBounded } from "../../adapters/concurrency.js";
import { precondition } from "../assert.js";
import { toSmtlibContent, type SmtlibContent } from "../branded.js";
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import { compileSmtlib } from "./smtlib.js";

/**
 * Result of a bidirectional Z3 implication check between two formalization samples.
 *
 * @remarks
 * Invariant: `leftIndex` < `rightIndex` (deterministic pair enumeration order).
 * Invariant: `evidence` preserves the raw SMT-LIB queries and solver outputs for audit.
 */
export interface PairwiseImplicationResult {
  readonly leftIndex: number;
  readonly rightIndex: number;
  readonly leftImpliesRight: "yes" | "no" | "inconclusive";
  readonly rightImpliesLeft: "yes" | "no" | "inconclusive";
  readonly evidence: {
    readonly leftToRightQuery: string;
    readonly rightToLeftQuery: string;
    readonly leftToRightResult: string;
    readonly rightToLeftResult: string;
  };
}

/**
 * Clustering result for a single claim's formalization samples.
 *
 * @remarks
 * Invariant: `representative` is a member of the largest stable cluster, or
 * the first sample if no cluster meets the stability threshold.
 * Invariant: `clusters` is sorted descending by member count.
 * Invariant: `ambiguous` is true when no cluster reaches the stability threshold.
 */
export interface ClusteredClaim {
  readonly representative: LogicIrClaim;
  readonly clusters: readonly { readonly members: readonly number[] }[];
  readonly pairwise: readonly PairwiseImplicationResult[];
  readonly ambiguous: boolean;
}

/**
 * Maximum concurrent Z3 subprocesses for pairwise implication checks.
 *
 * @remarks
 * **Value:** 4 concurrent Z3 solver processes.
 *
 * **Rationale:** Matches the cross-implication concurrency default. Each Z3
 * subprocess consumes ~50–200 MB resident memory and a full CPU core. At 4
 * concurrent processes the clustering phase saturates a typical 4-core CI
 * runner without triggering swap pressure. Higher values risk degraded
 * throughput from memory contention on resource-constrained environments.
 *
 * **Exceeded behavior:** This is a default — callers may override via the
 * `concurrency` parameter. If overridden higher, memory usage scales linearly
 * with the concurrency factor.
 */
const PAIRWISE_CONCURRENCY_DEFAULT = 4;

/**
 * Cluster formalization samples by logical equivalence using pairwise Z3 implication checks.
 *
 * @param input - claim identifier, samples to cluster, Z3 path, stability threshold, and concurrency
 * @returns clustered claim with representative and accumulated findings
 *
 * @remarks
 * Precondition: `input.samples` is non-empty.
 * Postcondition: returns a representative from the largest stable cluster if one meets threshold.
 * Invariant: an ambiguity finding is emitted when no cluster reaches `stabilityThreshold`.
 *
 * Failure modes:
 * - Throws (via `precondition`) if `input.samples` is empty.
 * - Propagates Z3 subprocess errors from pairwise implication queries.
 *
 * @example
 * ```ts
 * const { clustered, findings } = await clusterFormalizationSamples({
 *   claimId: "AUTH-SESSION-001",
 *   samples: [sample1, sample2, sample3],
 *   stabilityThreshold: 0.6,
 *   concurrency: 4,
 * });
 * console.log(`Representative chosen, ambiguous: ${clustered.ambiguous}`);
 * ```
 */
export async function clusterFormalizationSamples(input: {
  readonly claimId: string;
  readonly samples: readonly LogicIrClaim[];
  readonly z3Path?: string;
  readonly stabilityThreshold: number;
  readonly concurrency?: number;
}): Promise<{ readonly clustered: ClusteredClaim; readonly findings: readonly Finding[] }> {
  const concurrency = input.concurrency ?? PAIRWISE_CONCURRENCY_DEFAULT;
  const pairwise = await generatePairwiseImplications(input.samples, input.z3Path, concurrency);
  const clusters = buildEquivalenceClusters(input.samples.length, pairwise);

  const bestCluster = selectStableCluster(clusters, input.samples.length, input.stabilityThreshold);
  const ambiguous = bestCluster === undefined;
  const representative = input.samples[(bestCluster?.members[0] ?? 0)] ?? input.samples[0];
  precondition(representative !== undefined, "cannot cluster empty formalization sample set");

  const findings: Finding[] = [];
  if (ambiguous) {
    findings.push({
      severity: "warning",
      category: "formalization.ambiguity",
      provenance: { file: "<formalization>", heading: input.claimId },
      description: "No equivalence cluster met stability threshold",
      rationale: "When no cluster reaches the stability threshold, the chosen formalization is essentially arbitrary — different prompt runs produced semantically divergent outputs, indicating the claim may be ambiguous or under-specified.",
      evidence: [
        { kind: "claim_id", value: input.claimId },
        { kind: "cluster_count", value: String(clusters.length) },
      ],
      relatedClaimIdentifiers: [input.claimId],
    });
  }

  return {
    clustered: {
      representative,
      clusters,
      pairwise,
      ambiguous,
    },
    findings,
  };
}

/**
 * Run pairwise Z3 implication queries with bounded concurrency.
 *
 * @param samples - formalization samples to compare pairwise
 * @param z3Path - optional path to Z3 binary; uses system PATH if undefined
 * @param concurrency - maximum concurrent Z3 subprocesses
 * @returns pairwise implication results in deterministic enumeration order (left < right)
 *
 * @remarks
 * Each pair is independent: no shared mutable state between concurrent invocations.
 * Results are returned in deterministic pair enumeration order (left < right).
 *
 * Failure modes:
 * - Throws (via `precondition`) if pair indices are out of bounds (structurally unreachable).
 * - Propagates Z3 subprocess errors from `runZ3Query` if the solver binary is missing or crashes.
 *
 * **Pair generation bound** (value: n×(n−1)/2 pairs for n samples, no explicit cap):
 * All unique ordered pairs are enumerated exhaustively. For the typical sample
 * count of 3–5, this yields 3–10 pairs — well within budget. The bound is
 * implicitly controlled by the upstream `samplesPerClaim` parameter (usually 3),
 * which keeps n small. If n were unbounded, pair count would grow quadratically;
 * callers are expected to cap `samplesPerClaim` to prevent this.
 *
 * **Concurrency** (value: `concurrency` parameter, default 4, unit: Z3 subprocesses):
 * Concurrent Z3 invocations are bounded by the `concurrency` argument, defaulting
 * to {@link PAIRWISE_CONCURRENCY_DEFAULT} (4). Each invocation spawns a Z3 process
 * that may run for up to 30,000 ms before timeout.
 *
 * **Timeout** (value: 30,000 ms per Z3 query, unit: milliseconds):
 * Each implication query has a 30-second timeout. Clustering queries are more
 * complex than contradiction checks (they involve full assertion-set negation),
 * so they receive 3× the timeout of pairwise contradiction checks. If exceeded,
 * the result is classified as "inconclusive" rather than blocking the pipeline.
 */
async function generatePairwiseImplications(
  samples: readonly LogicIrClaim[],
  z3Path: string | undefined,
  concurrency: number,
): Promise<readonly PairwiseImplicationResult[]> {
  // Enumerate all pairs deterministically up front.
  const pairs: { readonly left: number; readonly right: number }[] = [];
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      pairs.push({ left, right });
    }
  }

  return await mapBounded(pairs, concurrency, async (pair) => {
    const leftSample = samples[pair.left];
    const rightSample = samples[pair.right];
    // Satisfy noUncheckedIndexedAccess — structurally unreachable given bounded pair enumeration above.
    precondition(
      leftSample !== undefined && rightSample !== undefined,
      `pairwise index out of bounds: ${String(pair.left)}, ${String(pair.right)}`,
    );

    const leftToRightQuery = buildImplicationQuery(leftSample, rightSample);
    const rightToLeftQuery = buildImplicationQuery(rightSample, leftSample);

    // Forward and reverse queries are independent; run in parallel within the pair.
    const [leftToRight, rightToLeft] = await Promise.all([
      runZ3Query({
        smtlib: leftToRightQuery,
        timeoutMs: 30_000,
        ...(z3Path === undefined ? {} : { z3Path }),
      }),
      runZ3Query({
        smtlib: rightToLeftQuery,
        timeoutMs: 30_000,
        ...(z3Path === undefined ? {} : { z3Path }),
      }),
    ]);

    return {
      leftIndex: pair.left,
      rightIndex: pair.right,
      leftImpliesRight: classifyImplication(leftToRight.kind),
      rightImpliesLeft: classifyImplication(rightToLeft.kind),
      evidence: {
        leftToRightQuery,
        rightToLeftQuery,
        leftToRightResult: leftToRight.stdout || leftToRight.stderr,
        rightToLeftResult: rightToLeft.stdout || rightToLeft.stderr,
      },
    };
  });
}

/**
 * Build an SMT-LIB implication query testing whether the left claim entails the right.
 *
 * @param left - premise claim compiled to SMT-LIB
 * @param right - consequent claim whose assertions form the entailment target
 * @returns SMT-LIB content asserting the negation of the implication for satisfiability check
 *
 * @remarks
 * Strategy: assert left's declarations and assertions as the premise, include right's
 * declarations for shared context, then assert the negation of right's assertions.
 * If Z3 returns "unsat", no model exists where left holds and right does not — i.e.,
 * the implication holds (left entails right).
 * Postcondition: output contains exactly one `(check-sat)` at the end.
 * Failure modes: none — pure computation.
 */
/** @internal Exported for testing. */
export function buildImplicationQuery(left: LogicIrClaim, right: LogicIrClaim): SmtlibContent {
  // Goal: construct an SMT query that checks whether left => right holds.
  // Strategy (negation-for-satisfiability): if A => B is valid, then (A ∧ ¬B)
  // is unsatisfiable. We assert A directly and negate B, then ask Z3 for sat.
  // If Z3 returns "unsat", no counterexample exists — the implication is proved.

  // Compile both sides into SMT-LIB fragments. Left's full assertions form the
  // antecedent; right's declarations provide shared symbol context.
  const leftCompiled = compileSmtlib(left);
  const rightCompiled = compileSmtlib(right);

  // Build the negated consequent from right's assertion expressions.
  // Invariant: negating the conjunction of right's assertions is equivalent to
  // asserting that at least one of right's claims fails under left's assumptions.
  const rightExprs = rightCompiled.assertionExprs;
  const negatedConsequent = rightExprs.length === 0
    ? "(assert (not true))"
    : `(assert (not (and ${rightExprs.join(" ")})))`;

  // Assembly is safe because left's declarations and assertions appear first (the
  // premise), right's declarations add any symbols needed by the negated consequent,
  // and check-sat appears exactly once at the end per the postcondition.
  return toSmtlibContent([
    "; implication query",
    leftCompiled.smtlib.trimEnd(),
    rightCompiled.smtlib.trimEnd().split("\n").filter((line) => {
      const trimmed = line.trim();
      // Include only declarations from right side (constants and functions for shared context).
      // Exclude right's assertions — they only appear in negated form below.
      return trimmed.startsWith("(declare-const") || trimmed.startsWith("(declare-fun") || trimmed.startsWith(";");
    }).join("\n"),
    negatedConsequent,
    "(check-sat)",
  ].join("\n"));
}

/**
 * Classify a Z3 solver result kind into a ternary implication outcome.
 *
 * @param kind - Z3 result kind (sat, unsat, timeout, unknown, error)
 * @returns "yes" if unsat (implication holds), "no" if sat (counterexample exists), "inconclusive" otherwise
 *
 * @remarks
 * Postcondition: mapping is total over the input domain.
 * Failure modes: none — pure computation.
 */
function classifyImplication(kind: "sat" | "unsat" | "timeout" | "unknown" | "error"): "yes" | "no" | "inconclusive" {
  if (kind === "unsat") {
    return "yes";
  }
  if (kind === "sat") {
    return "no";
  }
  return "inconclusive";
}

/**
 * Build equivalence clusters from pairwise mutual implication results using BFS.
 *
 * @param sampleCount - total number of samples to cluster
 * @param pairwise - bidirectional implication results for all sample pairs
 * @returns clusters sorted by descending size, then by first member index
 *
 * @remarks
 * Precondition: `sampleCount` >= 0; pair indices are within [0, sampleCount).
 * Postcondition: every sample index appears in exactly one cluster.
 * Invariant: two samples are in the same cluster iff mutual implication holds transitively.
 * Failure modes: none — pure computation.
 */
export function buildEquivalenceClusters(
  sampleCount: number,
  pairwise: readonly PairwiseImplicationResult[],
): readonly { readonly members: readonly number[] }[] {
  // Goal: partition sample indices into equivalence classes where membership
  // means mutual (bidirectional) implication holds transitively between all
  // members of the class.

  // Step 1: Initialize the adjacency graph with self-edges.
  // Invariant: every node is trivially equivalent to itself, so the minimal
  // cluster for any node always contains at least that node. Self-edges ensure
  // that even isolated nodes (no pairwise relation with anyone) form singleton
  // clusters and appear in the final output.
  const adjacency = new Map<number, Set<number>>();
  for (let index = 0; index < sampleCount; index += 1) {
    adjacency.set(index, new Set<number>([index]));
  }

  // Step 2: Add edges for confirmed mutual implications.
  // Only pairs where both directions are "yes" produce an edge. This ensures
  // the graph is symmetric — if (A, B) has an edge, (B, A) does too — which is
  // required for BFS to discover the full equivalence class.
  // The next step (BFS) is safe because adjacency is now a complete undirected
  // graph over the equivalence relation.
  for (const relation of pairwise) {
    if (relation.leftImpliesRight === "yes" && relation.rightImpliesLeft === "yes") {
      adjacency.get(relation.leftIndex)?.add(relation.rightIndex);
      adjacency.get(relation.rightIndex)?.add(relation.leftIndex);
    }
  }

  // Step 3: BFS to discover connected components (equivalence clusters).
  // BFS invariant: every node reachable from the seed via any chain of mutual
  // implication edges will be visited exactly once and placed into the same
  // cluster. The `visited` set prevents re-processing and guarantees that each
  // node appears in exactly one cluster (the postcondition).
  const visited = new Set<number>();
  const clusters: { members: number[] }[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    if (visited.has(index)) {
      continue;
    }

    // Seed a new cluster from the first unvisited node.
    const queue = [index];
    const members: number[] = [];
    visited.add(index);

    // Use index pointer for O(1) dequeue instead of Array.shift() which is O(n).
    // Completeness: BFS explores all nodes in the connected component because
    // every neighbor of a visited node is enqueued before queueHead advances
    // past it. Since adjacency is symmetric, no reachable node is missed.
    let queueHead = 0;
    while (queueHead < queue.length) {
      const current = queue[queueHead];
      queueHead += 1;
      if (current === undefined) {
        continue;
      }
      members.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) {
          continue;
        }
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    // Step 4: Sort members within the cluster.
    // Sorting produces a canonical ordering so that cluster identity is
    // independent of BFS traversal order — two runs with the same pairwise
    // results always yield the same cluster contents.
    clusters.push({ members: members.sort((left, right) => left - right) });
  }

  // Step 5: Sort clusters for deterministic, specification-compliant output.
  // Primary key: descending size (largest cluster = most-agreed-upon formalization).
  // Secondary key: ascending first-member index (tiebreaker for reproducibility).
  // Representative selection: the first cluster in the returned array is the
  // representative — it contains the largest group of mutually-equivalent
  // formalizations and its first member serves as the canonical sample index.
  return clusters.sort((left, right) => (right.members.length - left.members.length) || (left.members[0] ?? 0) - (right.members[0] ?? 0));
}

/**
 * Select the largest cluster if it meets the stability threshold fraction.
 *
 * @param clusters - equivalence clusters sorted by descending size
 * @param totalSamples - total number of formalization samples
 * @param threshold - minimum fraction of totalSamples required for stability
 * @returns the largest cluster if stable, or undefined if none qualifies
 *
 * @remarks
 * Precondition: `threshold` is in [0, 1].
 * Postcondition: returns undefined if clusters is empty, totalSamples is 0, or
 * the largest cluster's size / totalSamples < threshold.
 * Failure modes: none — pure computation.
 */
function selectStableCluster(
  clusters: readonly { readonly members: readonly number[] }[],
  totalSamples: number,
  threshold: number,
): { readonly members: readonly number[] } | undefined {
  if (clusters.length === 0 || totalSamples === 0) {
    return undefined;
  }

  const [largest] = clusters;
  if (largest === undefined) {
    return undefined;
  }

  return largest.members.length / totalSamples >= threshold ? largest : undefined;
}
