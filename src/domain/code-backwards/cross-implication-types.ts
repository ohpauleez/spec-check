/**
 * Type definitions for cross-implication analysis between spec and code formalizations.
 * Defines the classification domain and result structures used throughout the pipeline.
 *
 * Shared type module for cross-implication-related modules.
 * Exports: CrossClassification, CrossImplicationPairResult, CrossImplicationConfig.
 */
import type { Finding } from "../findings.js";

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

/**
 * Output from the capability-level aggregate comparison pass.
 */
export interface CapabilityAggregateOutput {
  readonly findings: readonly Finding[];
}

/**
 * Maximum concurrent Z3 cross-implication checks.
 *
 * @remarks
 * **Value:** 4 concurrent Z3 solver processes.
 *
 * **Rationale:** Balances parallelism against system resource pressure. Each Z3
 * subprocess consumes ~50–200 MB of resident memory and a full CPU core during
 * solving. At 4 concurrent processes the pipeline saturates a typical 4-core CI
 * runner without triggering swap pressure or OOM kills. Higher values risk
 * degraded throughput from context-switching and memory contention; lower values
 * leave solver-bound phases unnecessarily sequential.
 *
 * **Exceeded behavior:** This constant is a default — callers may override via
 * configuration. If overridden to a higher value, expect increased memory usage
 * proportional to the concurrency factor.
 */
export const CROSS_IMPLICATION_CONCURRENCY_DEFAULT = 4;
