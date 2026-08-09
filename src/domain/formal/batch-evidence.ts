/**
 * Pure builders for immutable attached-batch attempt evidence.
 *
 * @remarks
 * Evidence is assembled in two stages — frozen metadata plus a frozen outcome
 * draft — and finalized only once the temp-context cleanup attempt reaches a
 * terminal state. Every value returned here is deeply frozen so the durable
 * record cannot be altered after construction; claim text is intentionally
 * excluded so evidence stays safe to persist. All functions are pure and
 * perform no I/O.
 *
 * @example
 * ```ts
 * const metadata = buildBatchEvidenceMetadata(context, ordinal, model, sha);
 * const draft = buildBatchEvidenceDraft(metadata, outcome);
 * const evidence = finalizeBatchEvidence(draft, "succeeded");
 * ```
 */

import type { OpencodeError } from "../../adapters/opencode.js";
import type {
  BatchAttemptEvidence,
  BatchContextFile,
} from "./batch-transport.js";

/** Frozen evidence draft lacking only the cleanup classification. */
export type BatchAttemptEvidenceDraft = Readonly<Omit<BatchAttemptEvidence, "cleanup">>;

/** Frozen pointer metadata shared by every draft of one attempt. */
export type BatchAttemptEvidenceMetadata = Readonly<Omit<BatchAttemptEvidenceDraft, "outcome">>;

/**
 * Build the frozen pointer metadata shared by all evidence for one attempt.
 *
 * @param context - built batch context supplying the batch key and claims
 * @param subBatchOrdinal - physical batch ordinal within its semantic group
 * @param model - adapter model identifier recorded for replay
 * @param contextSha256 - hash of the exact serialized context bytes
 * @returns frozen metadata with parallel claim index/id/provenance arrays in
 *   context order; claim text is intentionally excluded
 *
 * @remarks
 * Precondition: `contextSha256` must be computed over the same canonical
 * bytes later written to disk, so post-cleanup reconstruction can be
 * verified. The three claim arrays stay parallel and in context order; this
 * is preserved by mapping the same source array for each. The function is
 * deterministic, performs no I/O, and deep-freezes every array it returns.
 */
export function buildBatchEvidenceMetadata(
  context: BatchContextFile,
  subBatchOrdinal: number,
  model: string,
  contextSha256: string,
): BatchAttemptEvidenceMetadata {
  return Object.freeze({
    batchKey: context.batchKey,
    claimIndexes: Object.freeze(context.claims.map((claim) => claim.index)),
    claimIds: Object.freeze(context.claims.map((claim) => claim.id)),
    provenanceFiles: Object.freeze(context.claims.map((claim) => claim.provenance.file)),
    contextSha256,
    promptVariant: "attached-context-v1",
    model,
    subBatchOrdinal,
  });
}

/**
 * Pair frozen metadata with a frozen outcome before cleanup is known.
 *
 * @param metadata - frozen pointer metadata for the attempt
 * @param outcome - classified attempt outcome to freeze into the draft
 * @returns a frozen evidence draft lacking only the cleanup classification
 *
 * @remarks
 * The draft is a separate stage so evidence cannot be finalized before the
 * cleanup attempt reaches a terminal state; `cleanup: "not_attempted"` is
 * only legal when no directory was created. Neither input is mutated; the
 * outcome object is frozen rather than copied.
 */
export function buildBatchEvidenceDraft(
  metadata: BatchAttemptEvidenceMetadata,
  outcome: BatchAttemptEvidence["outcome"],
): BatchAttemptEvidenceDraft {
  return Object.freeze({
    ...metadata,
    outcome: Object.freeze(outcome),
  });
}

/**
 * Complete an evidence draft with the terminal cleanup classification.
 *
 * @param draft - frozen metadata-plus-outcome assembled before cleanup
 * @param cleanup - terminal cleanup state: `succeeded`, `failed`, or
 *   `not_attempted` (valid only when no directory was ever created)
 * @returns a frozen, complete `BatchAttemptEvidence` record
 *
 * @remarks
 * Postcondition: the returned record is fully frozen and contains no claim
 * text, keeping attempt evidence durable and safe to persist. The function
 * performs no I/O and does not mutate the draft; the spread copies the
 * draft's own references, which are already frozen by construction.
 */
export function finalizeBatchEvidence(
  draft: BatchAttemptEvidenceDraft,
  cleanup: BatchAttemptEvidence["cleanup"],
): BatchAttemptEvidence {
  return Object.freeze({ ...draft, cleanup });
}

/**
 * Classify an adapter error kind into an attempt outcome for evidence.
 *
 * @param kind - the terminal `OpencodeError` kind from the attached call
 * @returns `infrastructure_failure` for local environment defects
 *   (`spawn_error`, `invalid_files`, `invalid_timeout`) and `model_failure`
 *   for model- or payload-attributable defects (`timeout`, `invalid_json`,
 *   `schema_validation_error`, `prompt_too_large`)
 *
 * @remarks
 * The switch is total over the closed `OpencodeError["kind"]` union, so an
 * added adapter error kind becomes a compile error here rather than silent
 * misclassification. The classification feeds degradation and evidence only;
 * it never changes the claim-facing error message. The function is pure.
 */
export function classifyAdapterFailure(kind: OpencodeError["kind"]): BatchAttemptEvidence["outcome"] {
  switch (kind) {
    case "spawn_error":
    case "invalid_files":
    case "invalid_timeout":
      return { kind: "infrastructure_failure", errorKind: kind };
    case "timeout":
    case "invalid_json":
    case "schema_validation_error":
    case "prompt_too_large":
      return { kind: "model_failure", errorKind: kind };
  }
}
