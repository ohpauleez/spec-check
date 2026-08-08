/**
 * Translates natural-language specification claims into SMT-LIB formalizations
 * by prompting an LLM and validating structured output.
 *
 * This module is the public orchestrator: it groups eligible claims by shared
 * semantic key, dispatches first-sample batches (single-claim inline or
 * multi-claim attached), performs additional sampling for clustering, and
 * aggregates results. The per-claim sampler and batch internals live in sibling
 * modules to keep this file focused on orchestration.
 *
 * Exports: formalizeClaims, formalizeClaim, buildFormalizationPrompt,
 *          extractSamplePayload, buildBatchFormalizationPrompt,
 *          BatchAttemptEvidence, BatchAttemptOutcome, BatchCleanupOutcome,
 *          FormalizationCandidate, FormalizationError, FormalizationOutput,
 *          IndexedClaim.
 */

import { mapBounded } from "../../adapters/concurrency.js";
import type { Claim } from "../claim-graph.js";
import type { LogicIrClaim } from "../logic-ir.js";
import type { Finding } from "../findings.js";
import { err, ok, type Result } from "../result.js";
import {
  groupBySemanticKey,
  isFormalizableKind,
  splitPhysicalBatches,
  validateFormalizationControls,
} from "./grouping.js";
import {
  formalizePhysicalBatch,
  type PhysicalBatch,
} from "./batch-formalize.js";
import {
  sampleFormalizationsForClaim,
} from "./sample-formalization.js";

// Re-export public API pieces that historically lived here.
export {
  formalizeClaim,
  buildFormalizationPrompt,
  extractSamplePayload,
  buildBatchFormalizationPrompt,
} from "./sample-formalization.js";

/**
 * A single claim's formalization result: valid Logic IR samples and rejected attempts.
 *
 * @remarks
 * Invariant: `samples` contains only structurally validated Logic IR claims.
 * Invariant: `invalidSamples` preserves the raw payload and rejection reason for diagnostics.
 */
export interface FormalizationCandidate {
  readonly claim: Claim;
  readonly samples: readonly LogicIrClaim[];
  readonly invalidSamples: readonly { readonly raw: unknown; readonly reason: string }[];
}

/**
 * Classification of a terminal attached batch attempt outcome.
 */
import type { OpencodeError } from "../../adapters/opencode.js";

export type BatchAttemptOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "model_failure"; readonly errorKind: OpencodeError["kind"] }
  | { readonly kind: "infrastructure_failure"; readonly errorKind: OpencodeError["kind"] }
  | { readonly kind: "transport_failure"; readonly detail: string };

/**
 * Cleanup outcome recorded for an attached batch attempt.
 */
export type BatchCleanupOutcome = "succeeded" | "failed" | "not_attempted";

/**
 * Durable evidence record for one attached batch attempt.
 *
 * @remarks
 * Invariant: claim text is never duplicated; `claimIndexes` resolve against
 * preserved source artifacts.
 */
export interface BatchAttemptEvidence {
  readonly schemaVersion: 1;
  readonly batchKey: string;
  readonly claimIndexes: readonly number[];
  readonly claimIds: readonly (string | null)[];
  readonly provenanceFiles: readonly string[];
  readonly contextSha256: string;
  readonly promptVariant: string;
  readonly model: string;
  readonly subBatchOrdinal: number;
  readonly outcome: BatchAttemptOutcome;
  readonly cleanup: BatchCleanupOutcome;
}

/**
 * Successful output from the formalization pipeline across all eligible claims.
 *
 * @remarks
 * Invariant: `candidates` preserves eligible input order for successfully formalized claims.
 * Invariant: `findings` aggregates warnings from invalid sample rejections and cleanup failures.
 * Invariant: `errors` contains failures for claims that could not be formalized.
 * Invariant: `batchAttempts` records one entry per attached attempt, including failures.
 */
export interface FormalizationOutput {
  readonly candidates: readonly FormalizationCandidate[];
  readonly findings: readonly Finding[];
  readonly errors: readonly FormalizationError[];
  readonly batchAttempts: readonly BatchAttemptEvidence[];
}

/**
 * Error produced when formalization of a claim fails entirely.
 *
 * @remarks
 * Invariant: `message` identifies the affected claim and the failure cause.
 */
export interface FormalizationError {
  readonly message: string;
}

/**
 * A claim paired with its authoritative original eligible index.
 */
export interface IndexedClaim {
  readonly claim: Claim;
  readonly eligibleIndex: number;
}

/**
 * Maximum concurrent LLM formalization sessions across physical sub-batches.
 */
const FORMALIZATION_CONCURRENCY_DEFAULT = 3;

/**
 * Formalize eligible claims into Logic IR using shared semantic grouping and
 * file-attached transport for multi-claim first-sample batches.
 *
 * @param input - configuration object for the formalization pipeline
 * @returns `ok(output)` on success or `err(errors)` for validation failures
 *
 * @remarks
 * Precondition: `input.logicalFileByCapability` is provided (may be empty).
 * Precondition: `input.samplesPerClaim` is a safe integer `>= 1`.
 * Precondition: `input.concurrency`, when supplied, is a safe integer `>= 1`.
 * Precondition: `input.maxBatchSize`, when supplied, is a safe integer `>= 0`;
 *   default `0` means unbounded (one physical batch per logical group).
 *
 * Postcondition: every eligible claim reaches exactly one terminal outcome:
 *   candidate or explicit {@link FormalizationError}.
 * Postcondition: candidates and errors are emitted in eligible input order.
 * Postcondition: input claim objects are never mutated.
 *
 * @throws Propagates unhandled errors that are not normalized by the worker-error
 *   boundary. In practice all adapter and filesystem errors are converted to
 *   claim-level outcomes.
 */
export async function formalizeClaims(input: {
  readonly claims: readonly Claim[];
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
  readonly concurrency?: number;
  readonly logicalFileByCapability?: ReadonlyMap<string, string>;
  readonly maxBatchSize?: number;
}): Promise<Result<FormalizationOutput, readonly FormalizationError[]>> {
  const validation = validateFormalizationControls({
    maxBatchSize: input.maxBatchSize,
    samplesPerClaim: input.samplesPerClaim,
    concurrency: input.concurrency,
  });

  if (!validation.ok) {
    return err(validation.error.map((e) => ({ message: e.message })));
  }

  const maxBatchSize = input.maxBatchSize ?? 0;
  const concurrency = input.concurrency ?? FORMALIZATION_CONCURRENCY_DEFAULT;

  const eligibleClaims: IndexedClaim[] = [];
  for (const claim of input.claims) {
    if (isFormalizableKind(claim.kind)) {
      eligibleClaims.push({ claim, eligibleIndex: eligibleClaims.length });
    }
  }

  if (eligibleClaims.length === 0) {
    return ok({ candidates: [], findings: [], errors: [], batchAttempts: [] });
  }

  const groups = groupBySemanticKey(
    eligibleClaims,
    (item) => item.claim,
    input.logicalFileByCapability ?? new Map(),
  );

  const physicalBatches: PhysicalBatch[] = [];
  for (const group of groups) {
    const chunks = splitPhysicalBatches(group.items, maxBatchSize);
    for (let ordinal = 0; ordinal < chunks.length; ordinal += 1) {
      physicalBatches.push({
        batchKey: group.key,
        ordinal,
        claims: chunks[ordinal] ?? [],
      });
    }
  }

  const candidateMap = new Map<number, FormalizationCandidate>();
  const errors: FormalizationError[] = [];
  const findings: Finding[] = [];
  const batchAttempts: BatchAttemptEvidence[] = [];

  try {
    const batchResults = await mapBounded(physicalBatches, concurrency, async (batch) => {
      return await formalizePhysicalBatch({
        batch,
        model: input.model,
        samplesPerClaim: input.samplesPerClaim,
        timeoutMs: input.timeoutMs,
      });
    });

    for (const result of batchResults) {
      if (result.outcome !== undefined) {
        batchAttempts.push(result.outcome);
      }
      for (const candidate of result.candidates) {
        candidateMap.set(candidate.claim.eligibleIndex, {
          claim: candidate.claim.claim,
          samples: candidate.samples,
          invalidSamples: candidate.invalidSamples,
        });
      }
      errors.push(...result.errors);
      findings.push(...result.findings);
    }
  } catch (workerError: unknown) {
    // mapBounded rejects with the first worker error and does not launch remaining
    // items. Convert this into claim-level errors for the affected batches so
    // unstarted claims are never silently dropped.
    const normalized = normalizeThrownError(workerError);
    for (const batch of physicalBatches) {
      errors.push(
        ...batch.claims.map((item) => ({
          message: `formalization worker failure for claim ${item.claim.id ?? "<unnamed>"}: ${normalized.message}`,
        })),
      );
    }
  }

  await collectAdditionalSamples(eligibleClaims, candidateMap, input, findings);

  const candidates: FormalizationCandidate[] = [];
  for (const item of eligibleClaims) {
    const candidate = candidateMap.get(item.eligibleIndex);
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }

  return ok({ candidates, findings, errors, batchAttempts });
}

/**
 * Collect additional samples for claims that already have at least one sample.
 *
 * @remarks
 * Precondition: `candidateMap` contains the first-sample results.
 * Postcondition: every claim with a first sample has up to `samplesPerClaim`
 *   additional samples merged in, preserving original claim identity.
 */
async function collectAdditionalSamples(
  eligibleClaims: readonly IndexedClaim[],
  candidateMap: Map<number, FormalizationCandidate>,
  input: {
    readonly samplesPerClaim: number;
    readonly model: string;
    readonly timeoutMs: number;
  },
  findings: Finding[],
): Promise<void> {
  if (input.samplesPerClaim <= 1) {
    return;
  }

  const needMore = eligibleClaims
    .filter((item) => candidateMap.has(item.eligibleIndex))
    .map((item) => ({
      item,
      candidate: candidateMap.get(item.eligibleIndex)!,
      needed: input.samplesPerClaim - candidateMap.get(item.eligibleIndex)!.samples.length,
    }))
    .filter((entry) => entry.needed > 0);

  if (needMore.length === 0) {
    return;
  }

  const additionalResults = await mapBounded(needMore, 2, async (entry) => {
    return await sampleFormalizationsForClaim({
      claim: entry.item.claim,
      eligibleIndex: entry.item.eligibleIndex,
      model: input.model,
      samplesPerClaim: entry.needed,
      timeoutMs: input.timeoutMs,
    });
  });

  for (const result of additionalResults) {
    if (!result.ok) {
      // Errors in additional sampling are non-fatal: we already have at least one sample.
      continue;
    }
    const current = candidateMap.get(result.value.candidate.eligibleIndex);
    if (current !== undefined) {
      candidateMap.set(result.value.candidate.eligibleIndex, {
        claim: current.claim,
        samples: [...current.samples, ...result.value.samples],
        invalidSamples: [...current.invalidSamples, ...result.value.invalidSamples],
      });
    }
    findings.push(...result.value.findings);
  }
}

/**
 * Normalize an unknown thrown value into a structured error.
 */
function normalizeThrownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
