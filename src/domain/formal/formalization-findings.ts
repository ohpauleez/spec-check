/**
 * Pure finding, error, and response-matching builders for formalization.
 *
 * @remarks
 * Every function in this module is deterministic, total, and side-effect
 * free: untrusted model response shapes enter as `unknown` and are narrowed
 * explicitly; claim-facing findings and errors are constructed as data so
 * callers can join them by eligible index. Nothing here performs I/O,
 * touches the adapter, or mutates its inputs.
 */

import { precondition } from "../assert.js";
import type { Claim } from "../claim-graph.js";
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import { err, ok, type Result } from "../result.js";
import type {
  BatchResult,
  FormalizationCandidate,
  FormalizationError,
} from "./formalization-types.js";
import type { PhysicalBatch } from "./grouping.js";
import { validateFormalizationSample } from "./validate.js";

/**
 * Validate an untrusted sample and pin it to its source claim identity.
 *
 * @param sample - arbitrary parsed value from a model response
 * @param claim - the source claim the sample must belong to
 * @returns the validated `LogicIrClaim`, or a validation error describing
 *   either the schema failure or the claim-identity mismatch
 *
 * @remarks
 * Postcondition on success: the sample is schema-valid and, when the claim
 * is named, `sample.claimId === claim.id`. The identity check is skipped for
 * unnamed claims because there is no stable identifier to compare against;
 * positional matching (index in batch, single-claim prompt inline) is the
 * only trust anchor in that case. The function is total and side-effect
 * free; all failures are returned as data.
 */
export function validateSampleForClaim(
  sample: unknown,
  claim: Claim,
): ReturnType<typeof validateFormalizationSample> {
  const validated = validateFormalizationSample(sample);
  if (!validated.ok || claim.id === undefined || validated.value.claimId === claim.id) {
    return validated;
  }
  return err({
    message: `sample claimId ${validated.value.claimId} does not match source claim id ${claim.id}`,
  });
}

/**
 * Extract a single formalization payload from an untrusted response envelope.
 *
 * @param response - arbitrary parsed model response
 * @returns `sample`, `formalization`, a sole `formalizations` entry, or the
 *   original value when no supported envelope is present
 *
 * @remarks
 * Envelope fields are checked in the documented return order. The function is
 * total, side-effect free, and deliberately does not validate the payload.
 *
 * @example
 * ```ts
 * const sample = extractSamplePayload({ sample: rawSample });
 * ```
 */
export function extractSamplePayload(response: unknown): unknown {
  if (typeof response !== "object" || response === null) {
    return response;
  }
  const record = response as {
    readonly sample?: unknown;
    readonly formalization?: unknown;
    readonly formalizations?: unknown;
  };
  if (record.sample !== undefined) {
    return record.sample;
  }
  if (record.formalization !== undefined) {
    return record.formalization;
  }
  if (Array.isArray(record.formalizations) && record.formalizations.length === 1) {
    return record.formalizations[0];
  }
  return response;
}

/**
 * Extract indexed formalization entries from an untrusted batch response.
 *
 * @param response - arbitrary parsed model response
 * @returns the `formalizations` array, a direct response array, or an empty
 *   array when neither supported shape is present
 *
 * @remarks
 * The returned entries remain untrusted and require index, schema, and source
 * identity validation. The function is total, side-effect free, and does not
 * mutate the response.
 *
 * @example
 * ```ts
 * const entries = extractBatchPayload({ formalizations: rawEntries });
 * ```
 */
export function extractBatchPayload(response: unknown): readonly unknown[] {
  if (typeof response !== "object" || response === null) {
    return [];
  }
  const formalizations = (response as { readonly formalizations?: unknown }).formalizations;
  if (Array.isArray(formalizations)) {
    return formalizations;
  }
  return Array.isArray(response) ? response : [];
}

/**
 * Read the `index` field of one untrusted batch entry.
 *
 * @param entry - arbitrary parsed value from the batch `formalizations` array
 * @returns the index when it is a non-negative safe integer; otherwise
 *   `undefined` so the caller can reject the entry without trusting it
 *
 * @remarks
 * Only safe integers in `[0, Number.MAX_SAFE_INTEGER]` are accepted because
 * indexes key into the eligible-claim map and later sort candidates; floats,
 * `NaN`, infinities, and negative numbers are all rejected. The function is
 * total, side-effect free, and performs no allocation beyond the read.
 */
export function readBatchEntryIndex(entry: unknown): number | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const index = (entry as { readonly index?: unknown }).index;
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0
    ? index
    : undefined;
}

/**
 * Match untrusted batch entries to source claims by validated unique index.
 *
 * @param response - untrusted parsed model response from the attached call
 * @param claims - the batch claims whose indexes form the only legal keys
 * @returns a map from eligible claim index to a validated sample or its
 *   rejection reason; or a batch-level error string when the entry count
 *   differs, an index is unsafe/unknown/duplicated, or an index cannot be
 *   resolved to a source claim
 *
 * @remarks
 * Postcondition on success: the map key set is exactly the claim index set,
 * so every claim has precisely one terminal per-entry verdict. Per-entry
 * validation failures are data inside the map so the caller can fall back per
 * claim; envelope-level failures abort the whole batch because no entry can
 * be trusted. The function is total, side-effect free, and never mutates
 * `claims`.
 */
export function matchAttachedBatchResponse<TClaim extends { readonly claim: Claim; readonly index: number }>(
  response: unknown,
  claims: readonly TClaim[],
): Result<ReadonlyMap<number, Result<LogicIrClaim, string>>, string> {
  const entries = extractBatchPayload(response);
  if (entries.length !== claims.length) {
    return err(`expected ${String(claims.length)} indexed formalizations, received ${String(entries.length)}`);
  }

  const claimsByIndex = new Map<number, TClaim>();
  for (const claim of claims) {
    claimsByIndex.set(claim.index, claim);
  }
  const matched = new Map<number, Result<LogicIrClaim, string>>();
  for (const entry of entries) {
    const index = readBatchEntryIndex(entry);
    if (index === undefined || !claimsByIndex.has(index) || matched.has(index)) {
      return err("batch formalization indexes must be unique known safe integers");
    }
    const claim = claimsByIndex.get(index);
    // The `has` check above proves membership; the lookup cannot miss. The
    // assertion converts that proof into executable form.
    precondition(claim !== undefined, "batch claim index must resolve after presence check");
    const sample = validateSampleForClaim(extractSamplePayload(entry), claim.claim);
    matched.set(index, sample.ok ? ok(sample.value) : err(sample.error.message));
  }
  return ok(matched);
}

/**
 * Partition matched batch entries into valid candidates and failed claims.
 *
 * @param claims - physical batch claims in eligible order
 * @param matched - validated per-index results from {@link matchAttachedBatchResponse}
 * @returns one-sample candidates, invalid-entry findings, and the claims that
 *   must fall back to inline sampling
 *
 * @remarks
 * Postconditions: a claim with a missing entry is queued for fallback with no
 * finding; a claim with an invalid entry is queued and gains a
 * `formalization.batch_entry_invalid` finding; a valid entry becomes a
 * one-sample candidate preserving eligible index. Inputs are never mutated and
 * iteration order follows the batch's eligible order.
 */
export function collectMatchedCandidates<TClaim extends { readonly claim: Claim; readonly index: number }>(
  claims: readonly TClaim[],
  matched: ReadonlyMap<number, Result<LogicIrClaim, string>>,
): {
  readonly candidates: readonly FormalizationCandidate[];
  readonly findings: readonly Finding[];
  readonly failedClaims: readonly TClaim[];
} {
  const candidates: FormalizationCandidate[] = [];
  const findings: Finding[] = [];
  const failedClaims: TClaim[] = [];
  for (const indexedClaim of claims) {
    const entry = matched.get(indexedClaim.index);
    if (entry === undefined || !entry.ok) {
      failedClaims.push(indexedClaim);
      if (entry !== undefined) {
        findings.push(buildBatchEntryInvalidFinding(indexedClaim.claim, entry.error));
      }
      continue;
    }
    candidates.push({
      claim: indexedClaim.claim,
      eligibleIndex: indexedClaim.index,
      samples: [entry.value],
      invalidSamples: [],
    });
  }
  return { candidates, findings, failedClaims };
}

/**
 * Build the warning finding for one rejected inline formalization sample.
 *
 * @param claim - source claim whose sample was rejected
 * @param attempt - 1-based attempt number within the bounded retry budget
 * @param reason - human-readable validation rejection reason
 * @returns a `formalization.invalid_sample` warning tied to the claim
 *
 * @remarks
 * The attempt number is recorded as evidence so reviewers can tell early
 * flakiness from budget exhaustion. `relatedClaimIdentifiers` is omitted
 * (rather than set to undefined) for unnamed claims to satisfy
 * `exactOptionalPropertyTypes`. The function is pure and never mutates
 * `claim`.
 */
export function buildInvalidSampleFinding(claim: Claim, attempt: number, reason: string): Finding {
  return {
    severity: "warning",
    category: "formalization.invalid_sample",
    provenance: claim.provenance,
    description: `Rejected invalid formalization sample: ${reason}`,
    rationale: "Repeated invalid samples consume bounded retry budget and reduce formalization confidence.",
    evidence: [
      { kind: "claim", value: claim.text },
      { kind: "attempt", value: String(attempt) },
    ],
    ...(claim.id === undefined ? {} : { relatedClaimIdentifiers: [claim.id] }),
  };
}

/**
 * Build the warning finding for a malformed per-claim batch entry.
 *
 * @param claim - source claim whose matched batch entry failed validation
 * @param reason - human-readable rejection reason from entry validation
 * @returns a `formalization.batch_entry_invalid` warning tied to the claim
 *
 * @remarks
 * Emitted only when the envelope matched but this claim's entry was invalid;
 * the caller then retries the claim inline, so the finding explains why one
 * claim took the degraded path. `relatedClaimIdentifiers` is omitted for
 * unnamed claims to satisfy `exactOptionalPropertyTypes`. Pure; `claim` is
 * never mutated.
 */
export function buildBatchEntryInvalidFinding(claim: Claim, reason: string): Finding {
  return {
    severity: "warning",
    category: "formalization.batch_entry_invalid",
    provenance: claim.provenance,
    description: `Batch entry invalid, retrying individually: ${reason}`,
    rationale: "A malformed indexed batch entry is retried individually so one response defect cannot lose the claim.",
    evidence: [{ kind: "claim", value: claim.text }, { kind: "reason", value: reason }],
    ...(claim.id === undefined ? {} : { relatedClaimIdentifiers: [claim.id] }),
  };
}

/**
 * Build the warning finding for a candidate short of the requested samples.
 *
 * @param claim - source claim whose sample set is incomplete
 * @param validSamples - number of valid samples actually collected (>= 1)
 * @param requestedSamples - target valid-sample count (`samplesPerClaim`)
 * @param terminalFailure - adapter failure message that stopped sampling, or
 *   `undefined` when the bounded attempt budget was simply exhausted
 * @returns a `formalization.sample_shortfall` warning tied to the claim
 *
 * @remarks
 * Precondition: `validSamples < requestedSamples` and `validSamples >= 1`;
 * the caller emits this only on the preserved-candidate path, never when the
 * claim has already errored. The description distinguishes adapter-stopped
 * shortfall from budget exhaustion because the remediation differs. Pure;
 * inputs are never mutated.
 */
export function buildSampleShortfallFinding(
  claim: Claim,
  validSamples: number,
  requestedSamples: number,
  terminalFailure: string | undefined,
): Finding {
  return {
    severity: "warning",
    category: "formalization.sample_shortfall",
    provenance: claim.provenance,
    description: terminalFailure === undefined
      ? `Only ${String(validSamples)} of ${String(requestedSamples)} requested formalization samples were valid`
      : `Additional formalization sampling stopped after an adapter failure: ${terminalFailure}`,
    rationale: "A valid candidate is preserved, but the bounded sample set is incomplete.",
    evidence: [
      { kind: "valid_samples", value: String(validSamples) },
      { kind: "requested_samples", value: String(requestedSamples) },
    ],
    ...(claim.id === undefined ? {} : { relatedClaimIdentifiers: [claim.id] }),
  };
}

/**
 * Build the warning finding for a failed additional-sample top-up.
 *
 * @param candidate - preserved candidate whose top-up did not complete
 * @param message - normalized failure or thrown-error description
 * @returns a `formalization.additional_sample_failed` warning tied to the
 *   candidate's claim
 *
 * @remarks
 * This is a warning rather than an error because the claim already has at
 * least one valid sample; the top-up failure only weakens the sample set.
 * The eligible index is recorded as evidence so the warning can be joined
 * back to the candidate without relying on claim identity. Pure; the
 * candidate is never mutated.
 */
export function buildAdditionalSampleFailureFinding(candidate: FormalizationCandidate, message: string): Finding {
  return {
    severity: "warning",
    category: "formalization.additional_sample_failed",
    provenance: candidate.claim.provenance,
    description: `Additional formalization samples were not completed: ${message}`,
    rationale: "The first valid sample is preserved, but an incomplete sample set reduces clustering confidence.",
    evidence: [
      { kind: "claim", value: candidate.claim.text },
      { kind: "eligible_index", value: String(candidate.eligibleIndex) },
    ],
    ...(candidate.claim.id === undefined ? {} : { relatedClaimIdentifiers: [candidate.claim.id] }),
  };
}

/**
 * Build the warning finding for a failed temp-context cleanup.
 *
 * @param batch - physical batch whose context directory survived cleanup
 * @param contextSha256 - context hash so leftover artifacts can be matched
 *   to the attempt that created them
 * @param detail - cleanup failure description from the transport layer
 * @returns a `formalization.temp_cleanup_failed` warning with batch-level
 *   provenance
 *
 * @remarks
 * Provenance falls back to the batch logical file when the batch has no
 * first claim (defensive; the caller only emits this for non-empty batches).
 * The batch key, ordinal, and context hash are recorded so orphaned temp
 * directories can be attributed and removed manually. Pure; `batch` is never
 * mutated.
 */
export function buildCleanupWarning<TClaim extends { readonly claim: Claim }>(
  batch: PhysicalBatch<TClaim>,
  contextSha256: string,
  detail: string,
): Finding {
  const firstClaim = batch.claims[0]?.claim;
  return {
    severity: "warning",
    category: "formalization.temp_cleanup_failed",
    provenance: firstClaim?.provenance ?? { file: batch.logicalFile },
    description: `Temporary attached batch cleanup failed for ${batch.logicalFile} batch ${String(batch.ordinal)}`,
    rationale: "Successful candidates are preserved, but ephemeral context may remain on disk.",
    evidence: [
      { kind: "batch_key", value: batch.logicalFile },
      { kind: "sub_batch_ordinal", value: String(batch.ordinal) },
      { kind: "context_sha256", value: contextSha256 },
      { kind: "cleanup_error", value: detail },
    ],
  };
}

/**
 * Convert a thrown physical-batch worker into terminal per-claim errors.
 *
 * @param batch - physical batch whose worker threw before producing a result
 * @param error - caught unknown value from the worker, normalized to a message
 * @returns one claim error per batch claim with a shared normalized message;
 *   candidates, findings, and attempt evidence are empty because the batch
 *   produced no trustworthy partial work
 *
 * @remarks
 * This is the last-resort normalization point in the worker pool: without it
 * a single throwing batch would reject the whole `mapBounded` run and lose
 * every other batch's results. Claim identity and eligible index are
 * preserved on every error so terminal ordering still holds.
 */
export function workerFailureResult<TClaim extends { readonly claim: Claim; readonly index: number }>(
  batch: PhysicalBatch<TClaim>,
  error: unknown,
): BatchResult {
  const message = describeUnknownError(error, "formalization physical batch worker failed");
  return {
    candidates: [],
    findings: [],
    errors: batch.claims.map((claim) => makeClaimError(claim, message)),
    batchAttempts: [],
  };
}

/**
 * Build one terminal claim-level formalization error.
 *
 * @param claim - indexed claim; `index` is the authoritative eligible
 *   position, while `claim.id` is recorded only as informational context
 * @param message - already-normalized failure description appended after the
 *   claim prefix
 * @returns an error carrying the eligible index for stable ordering, with
 *   `claimId` omitted (not undefined) for unnamed claims
 *
 * @remarks
 * The eligible index is the ordering and join key everywhere downstream;
 * `claimId` is never trusted for identity because claim identifiers are
 * model-visible text. The function is pure and never mutates its input.
 */
export function makeClaimError(
  claim: { readonly claim: Claim; readonly index: number },
  message: string,
): FormalizationError {
  return {
    message: `failed to formalize claim ${claim.claim.id ?? "<unnamed>"}: ${message}`,
    eligibleIndex: claim.index,
    ...(claim.claim.id === undefined ? {} : { claimId: claim.claim.id }),
  };
}

/**
 * Order candidates by ascending eligible index.
 *
 * @param left - first candidate
 * @param right - second candidate
 * @returns negative, zero, or positive as `left.eligibleIndex` compares to
 *   `right.eligibleIndex`
 *
 * @remarks
 * Eligible indexes are unique across the run by construction, so this is a
 * total order and the sort is deterministic. Indexes are validated safe
 * integers, so the subtraction cannot overflow into `NaN`.
 */
export function compareCandidates(left: FormalizationCandidate, right: FormalizationCandidate): number {
  return left.eligibleIndex - right.eligibleIndex;
}

/**
 * Order errors by eligible index, sinking index-less errors to the end.
 *
 * @param left - first error
 * @param right - second error
 * @returns negative, zero, or positive as the effective indexes compare,
 *   where a missing `eligibleIndex` sorts as `Number.MAX_SAFE_INTEGER`
 *
 * @remarks
 * Claim-level errors always carry an eligible index; only boundary
 * (pre-effects) validation errors omit it, and those must sort after every
 * claim outcome so terminal ordering by eligible input position is preserved.
 * Pure and deterministic for the validated safe-integer indexes in use.
 */
export function compareErrors(left: FormalizationError, right: FormalizationError): number {
  return (left.eligibleIndex ?? Number.MAX_SAFE_INTEGER) - (right.eligibleIndex ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Normalize a caught unknown value into a human-readable failure message.
 *
 * @param error - value caught as `unknown` at a trust boundary
 * @param fallback - context-specific message used when the value is not a
 *   non-empty `Error`
 * @returns `error.message` when it is a non-empty string; otherwise the
 *   fallback, so the returned message is never empty
 *
 * @remarks
 * Non-`Error` throws (strings, objects, `undefined`) deliberately collapse
 * to the fallback rather than being stringified, because arbitrary thrown
 * values carry no trustworthy shape and could leak uncontrolled text into
 * claim-facing errors. The function is total and pure.
 */
export function describeUnknownError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * Produce the terminal result for a physical batch with no claims.
 *
 * @returns a result with every channel empty, preserving the invariant that
 *   each batch returns exactly one `BatchResult`
 *
 * @remarks
 * An empty batch is a degenerate-but-legal input from generic physical
 * splitting; returning an empty result keeps downstream flattening total
 * without special cases and triggers no adapter or filesystem work. The
 * function is pure and allocates one fresh frozen-shape result per call.
 */
export function emptyBatchResult(): BatchResult {
  return { candidates: [], findings: [], errors: [], batchAttempts: [] };
}
