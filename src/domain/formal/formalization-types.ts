/**
 * Shared types for the claim formalization pipeline.
 *
 * @remarks
 * These types are the public contract of `formalize.ts` and the internal
 * result shapes threaded through its worker pool. They live in their own
 * module so the orchestration module and the pure finding/evidence builder
 * modules can both import them without a circular dependency.
 */

import type { Claim } from "../claim-graph.js";
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import type { BatchAttemptEvidence } from "./batch-transport.js";

/** A claim and all structurally valid and rejected formalization samples. */
export interface FormalizationCandidate {
  readonly claim: Claim;
  /** Stable position among eligible input claims. */
  readonly eligibleIndex: number;
  readonly samples: readonly LogicIrClaim[];
  readonly invalidSamples: readonly { readonly raw: unknown; readonly reason: string }[];
}

/** A terminal claim-level formalization failure. */
export interface FormalizationError {
  readonly message: string;
  /** Stable position among eligible input claims. */
  readonly eligibleIndex?: number;
  /** Informational claim identifier; eligible index remains authoritative. */
  readonly claimId?: string;
}

/** Successful, partial, and diagnostic outputs from formalization. */
export interface FormalizationOutput {
  readonly candidates: readonly FormalizationCandidate[];
  readonly findings: readonly Finding[];
  readonly errors: readonly FormalizationError[];
  readonly batchAttempts: readonly BatchAttemptEvidence[];
}

/** Per-physical-batch result threaded through the bounded worker pool. */
export interface BatchResult {
  readonly candidates: readonly FormalizationCandidate[];
  readonly findings: readonly Finding[];
  readonly errors: readonly FormalizationError[];
  readonly batchAttempts: readonly BatchAttemptEvidence[];
}

/** Attached-path result carrying the classified attempt outcome for evidence. */
export interface AttachedAssembly extends BatchResult {
  readonly outcome: BatchAttemptEvidence["outcome"];
}

/** A successfully sampled claim together with its non-fatal findings. */
export interface SampleSuccess {
  readonly candidate: FormalizationCandidate;
  readonly findings: readonly Finding[];
}
