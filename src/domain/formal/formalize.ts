/**
 * Translate requirement and scenario claims into validated Logic IR samples.
 *
 * Semantic grouping and physical batching are deterministic. Single-claim
 * batches use inline prompts; multi-claim batches use an attached JSON context.
 */
import { mapBounded } from "../../adapters/concurrency.js";
import { callOpencode, type OpencodeError } from "../../adapters/opencode.js";
import { precondition } from "../assert.js";
import type { Claim } from "../claim-graph.js";
import { sanitizeForCodeFence } from "../fence.js";
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import {
  ATTACHED_BATCH_FORMALIZATION_PROMPT,
  FORMALIZATION_INSTRUCTIONS,
  FORMALIZATION_SANDBOXING,
} from "../prompts/formalization.js";
import { err, ok, type Result } from "../result.js";
import {
  buildBatchContextFile,
  cleanupBatchContext,
  createBatchContextDirectory,
  prepareBatchContextData,
  writeBatchContextFile,
  type BatchAttemptEvidence,
  type BatchContextCleanup,
  type BatchContextDirectory,
  type BatchContextFile,
  type WrittenBatchContext,
} from "./batch-transport.js";
import { decideBatchDegradation, inlinePromptsFitOpencodeLimit } from "./degradation.js";
import {
  groupFormalizationClaims,
  splitPhysicalBatches,
  type IndexedFormalizationClaim,
  type PhysicalBatch,
} from "./grouping.js";
import { validateFormalizationSample } from "./validate.js";

const FORMALIZATION_CONCURRENCY_DEFAULT = 3;
// Fallback workers execute inside worker slots of the outer
// `mapBounded(batches, concurrency)` pool. A degraded batch can therefore run
// up to INLINE_FALLBACK_CONCURRENCY adapter calls within a single outer slot,
// so the worst-case in-flight bound is concurrency * INLINE_FALLBACK_CONCURRENCY
// on the degradation path and `concurrency` otherwise. The value 2 pipelines
// one claim's retry with the next claim's first attempt while keeping the
// multiplier a fixed constant, never the batch size.
const INLINE_FALLBACK_CONCURRENCY = 2;
const ADAPTER_RETRIES = 3;
const MAX_BATCH_SIZE_DEFAULT = 0;

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

interface BatchResult {
  readonly candidates: readonly FormalizationCandidate[];
  readonly findings: readonly Finding[];
  readonly errors: readonly FormalizationError[];
  readonly batchAttempts: readonly BatchAttemptEvidence[];
}

interface AttachedAssembly extends BatchResult {
  readonly outcome: BatchAttemptEvidence["outcome"];
}

interface SampleSuccess {
  readonly candidate: FormalizationCandidate;
  readonly findings: readonly Finding[];
}

/**
 * Formalize all eligible claims using stable semantic groups and bounded batches.
 *
 * @param input - claims, adapter controls, and the required shared grouping map
 * @returns output data, or all boundary-validation errors before effects begin
 *
 * @remarks
 * Preconditions are validated for `samplesPerClaim`, `concurrency`,
 * `maxBatchSize`, and every logical-file map value before filesystem or adapter
 * work. Requirement and scenario claims are eligible; all other kinds are
 * ignored. Every eligible claim has exactly one terminal candidate/error
 * outcome, ordered by eligible input index. Attached batches retain immutable,
 * claim-text-free attempt evidence and always attempt cleanup after directory
 * creation. Expected adapter, model, filesystem, and thrown worker failures are
 * normalized into returned data rather than thrown. Inputs are not mutated and
 * independent batches may execute concurrently up to the configured bound.
 *
 * @example
 * ```ts
 * const result = await formalizeClaims({
 *   claims,
 *   model: "openai/gpt-4.1",
 *   samplesPerClaim: 2,
 *   timeoutMs: 300_000,
 *   logicalFileByCapability,
 * });
 * ```
 */
export async function formalizeClaims(input: {
  readonly claims: readonly Claim[];
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
  readonly logicalFileByCapability: ReadonlyMap<string, string>;
  readonly concurrency?: number;
  readonly maxBatchSize?: number;
}): Promise<Result<FormalizationOutput, readonly FormalizationError[]>> {
  const concurrency = input.concurrency ?? FORMALIZATION_CONCURRENCY_DEFAULT;
  const maxBatchSize = input.maxBatchSize ?? MAX_BATCH_SIZE_DEFAULT;
  const validated = validateControls({
    samplesPerClaim: input.samplesPerClaim,
    concurrency,
    maxBatchSize,
    logicalFileByCapability: input.logicalFileByCapability,
  });
  if (!validated.ok) {
    return validated;
  }

  const batches = groupFormalizationClaims(input.claims, input.logicalFileByCapability)
    .flatMap((group) => splitPhysicalBatches(group, maxBatchSize));
  if (batches.length === 0) {
    return ok({ candidates: [], findings: [], errors: [], batchAttempts: [] });
  }

  let results: readonly BatchResult[];
  try {
    results = await mapBounded(batches, concurrency, async (batch) => {
      try {
        return await formalizePhysicalBatch({
          batch,
          model: input.model,
          samplesPerClaim: input.samplesPerClaim,
          timeoutMs: input.timeoutMs,
        });
      } catch (error: unknown) {
        return workerFailureResult(batch, error);
      }
    });
  } catch (error: unknown) {
    const message = describeUnknownError(error, "formalization worker pool failed");
    return ok({
      candidates: [],
      findings: [],
      errors: batches.flatMap((batch) => batch.claims.map((claim) => makeClaimError(claim, message))),
      batchAttempts: [],
    });
  }

  return ok({
    candidates: results.flatMap((result) => result.candidates).sort(compareCandidates),
    findings: results.flatMap((result) => result.findings),
    errors: results.flatMap((result) => result.errors).sort(compareErrors),
    batchAttempts: results.flatMap((result) => result.batchAttempts),
  });
}

/**
 * Validate adapter and batching controls before any filesystem or adapter work.
 *
 * @param input - resolved numeric controls and the shared grouping map
 * @returns `ok` when every control is in range; otherwise all collected
 *   validation errors, in field check order, with no eligible indexes attached
 *
 * @remarks
 * Precondition (checked here): `samplesPerClaim` and `concurrency` must be
 * safe integers >= 1, `maxBatchSize` must be a safe integer >= 0, and every
 * `logicalFileByCapability` value must be a non-empty string. Errors carry no
 * `eligibleIndex`, so the exported comparator sinks them to the end. The
 * function is total, side-effect free, and mutates only its local error list.
 */
function validateControls(input: {
  readonly samplesPerClaim: number;
  readonly concurrency: number;
  readonly maxBatchSize: number;
  readonly logicalFileByCapability: ReadonlyMap<string, string>;
}): Result<void, readonly FormalizationError[]> {
  const errors: FormalizationError[] = [];
  if (!Number.isSafeInteger(input.samplesPerClaim) || input.samplesPerClaim < 1) {
    errors.push({ message: "samplesPerClaim must be a safe integer >= 1" });
  }
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) {
    errors.push({ message: "concurrency must be a safe integer >= 1" });
  }
  if (!Number.isSafeInteger(input.maxBatchSize) || input.maxBatchSize < 0) {
    errors.push({ message: "maxBatchSize must be a safe integer >= 0" });
  }
  for (const [capability, logicalFile] of input.logicalFileByCapability) {
    if (typeof logicalFile !== "string" || logicalFile.length === 0) {
      errors.push({ message: `logicalFile must be non-empty for capability ${capability}` });
    }
  }
  return errors.length === 0 ? ok(undefined) : err(errors);
}

/**
 * Dispatch one physical batch to its inline or attached formalization path.
 *
 * @param input - physical batch and adapter controls shared by both paths
 * @returns terminal claim outcomes and attempt evidence for this batch; an
 *   empty batch yields an all-empty result without any adapter call
 *
 * @remarks
 * Postcondition: every claim in the batch has exactly one terminal candidate
 * or error outcome in the returned result. A single-claim batch always uses
 * the inline path; multi-claim batches always use the attached context path.
 * No concurrency occurs inside this function; per-claim parallelism lives in
 * the fallback and additional-sample helpers. The caller is responsible for
 * catching unexpected throws (see the worker boundary in `formalizeClaims`).
 */
async function formalizePhysicalBatch(input: {
  readonly batch: PhysicalBatch<IndexedFormalizationClaim>;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}): Promise<BatchResult> {
  const firstClaim = input.batch.claims[0];
  if (firstClaim === undefined) {
    return emptyBatchResult();
  }
  if (input.batch.claims.length === 1) {
    return await formalizeSingleClaim(firstClaim, input.model, input.samplesPerClaim, input.timeoutMs);
  }
  return await formalizeAttachedBatch(input);
}

/**
 * Formalize a single-claim batch through the inline prompt path.
 *
 * @param indexedClaim - the sole claim with its authoritative eligible index
 * @param model - adapter model identifier
 * @param samplesPerClaim - target valid-sample count (safe integer >= 1)
 * @param timeoutMs - per-call adapter timeout
 * @returns the candidate and findings, or exactly one claim-level error when
 *   no valid sample is obtained; attempt evidence stays empty because the
 *   inline path has no temp context to account for
 *
 * @remarks
 * Expected failures (adapter errors, all-invalid samples, thrown adapter
 * calls) are normalized by {@link sampleFormalizationsForClaim} into the
 * returned error rather than thrown. Inputs are never mutated.
 */
async function formalizeSingleClaim(
  indexedClaim: IndexedFormalizationClaim,
  model: string,
  samplesPerClaim: number,
  timeoutMs: number,
): Promise<BatchResult> {
  const sampled = await sampleFormalizationsForClaim({
    indexedClaim,
    model,
    samplesPerClaim,
    timeoutMs,
  });
  if (!sampled.ok) {
    return { candidates: [], findings: [], errors: [sampled.error], batchAttempts: [] };
  }
  return {
    candidates: [sampled.value.candidate],
    findings: sampled.value.findings,
    errors: [],
    batchAttempts: [],
  };
}

/**
 * Formalize one multi-claim batch through an owned attached temp context.
 *
 * @param input - physical batch and adapter controls for the attached attempt
 * @returns terminal claim outcomes and immutable attempt evidence after cleanup
 * @throws {Error} if unexpected post-preparation staging fails; the worker
 *   boundary converts this to claim errors after the `finally` cleanup attempt
 *
 * @remarks
 * Once the context file is written, cleanup is attempted exactly once in a
 * `finally` block. No candidate, error, finding, or evidence is returned before
 * cleanup reaches a terminal state. Cleanup failure augments claim errors when
 * no candidate survived, or emits a warning while preserving candidates.
 * Unexpected staging failures may propagate to the physical-worker boundary,
 * but cannot bypass cleanup after successful context preparation.
 */
async function formalizeAttachedBatch(input: {
  readonly batch: PhysicalBatch<IndexedFormalizationClaim>;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}): Promise<BatchResult> {
  const context = buildBatchContextFile(input.batch.logicalFile, input.batch.claims);
  const preparedData = prepareBatchContextData(context);
  const evidenceMetadata = buildBatchEvidenceMetadata(
    context,
    input.batch.ordinal,
    input.model,
    preparedData.contextSha256,
  );
  const created = await createBatchContextDirectory();

  if (!created.ok) {
    const outcome: BatchAttemptEvidence["outcome"] = {
      kind: "transport_failure",
      detail: created.error.message,
    };
    return {
      candidates: [],
      findings: [],
      errors: input.batch.claims.map((claim) => makeClaimError(claim, created.error.message)),
      batchAttempts: [finalizeBatchEvidence(
        buildBatchEvidenceDraft(evidenceMetadata, outcome),
        "not_attempted",
      )],
    };
  }

  const prepared = await writeBatchContextFile(
    created.value,
    preparedData.serializedContext,
    preparedData.contextSha256,
  );
  if (!prepared.ok) {
    return await transportWriteFailureResult(input.batch, evidenceMetadata, created.value, prepared.error.message);
  }

  return await runAttachedAttempt(input, evidenceMetadata, preparedData.contextSha256, prepared.value);
}

/**
 * Build terminal claim errors for a batch context write failure.
 *
 * @param batch - physical batch whose context file could not be written
 * @param evidenceMetadata - frozen pointer metadata for the failed attempt
 * @param directory - created temp directory owed a cleanup attempt
 * @param message - the write failure message, reported before cleanup detail
 * @returns claim errors for every batch claim and one finalized evidence record
 *
 * @remarks
 * Preconditions: the directory exists and the file write failed. Postcondition:
 * cleanup is attempted exactly once before this result is returned; a cleanup
 * failure is appended to each claim error message without masking the original
 * write failure. No adapter call occurs on this path.
 */
async function transportWriteFailureResult(
  batch: PhysicalBatch<IndexedFormalizationClaim>,
  evidenceMetadata: BatchAttemptEvidenceMetadata,
  directory: BatchContextDirectory,
  message: string,
): Promise<BatchResult> {
  const evidenceDraft = buildBatchEvidenceDraft(evidenceMetadata, {
    kind: "transport_failure",
    detail: message,
  });
  const cleanup = await cleanupBatchContext(directory);
  const cleanupDetail = cleanup.state === "cleanup_failed"
    ? `; temporary batch cleanup also failed: ${cleanup.detail}`
    : "";
  return {
    candidates: [],
    findings: [],
    errors: batch.claims.map((claim) => makeClaimError(claim, `${message}${cleanupDetail}`)),
    batchAttempts: [finalizeBatchEvidence(
      evidenceDraft,
      cleanup.state === "cleanup_succeeded" ? "succeeded" : "failed",
    )],
  };
}

/**
 * Run the attached adapter attempt and resolve outcomes after cleanup.
 *
 * @param input - physical batch and adapter controls for the attached attempt
 * @param evidenceMetadata - frozen pointer metadata for this attempt
 * @param contextSha256 - hash of the exact serialized context bytes, used in
 *   the cleanup-failure warning
 * @param prepared - written temp context owed a `finally` cleanup attempt
 * @returns terminal claim outcomes and one evidence record finalized with the
 *   cleanup classification
 *
 * @remarks
 * Postconditions: cleanup is attempted exactly once in a `finally` block
 * before any outcome is returned. Cleanup failure preserves successful
 * candidates and adds a warning; when no candidate survived, the cleanup
 * detail is appended to every claim error instead. A thrown adapter or
 * assembly failure is normalized to claim errors and still passes through the
 * same `finally` cleanup.
 */
async function runAttachedAttempt(
  input: {
    readonly batch: PhysicalBatch<IndexedFormalizationClaim>;
    readonly model: string;
    readonly samplesPerClaim: number;
    readonly timeoutMs: number;
  },
  evidenceMetadata: BatchAttemptEvidenceMetadata,
  contextSha256: string,
  prepared: WrittenBatchContext,
): Promise<BatchResult> {
  let assembly: AttachedAssembly;
  try {
    assembly = await callAndAssembleAttached(input, prepared);
  } catch (error: unknown) {
    const message = describeUnknownError(error, "formalization attached transport failed");
    assembly = {
      candidates: [],
      findings: [],
      errors: input.batch.claims.map((claim) => makeClaimError(claim, message)),
      batchAttempts: [],
      outcome: { kind: "transport_failure", detail: "formalization adapter threw" },
    };
  }
  const evidenceDraft = buildBatchEvidenceDraft(evidenceMetadata, assembly.outcome);
  const cleanup = await cleanupBatchContext(prepared);
  const { findings, errors } = applyCleanupOutcome(input.batch, assembly, contextSha256, cleanup);
  return {
    candidates: assembly.candidates,
    findings,
    errors,
    batchAttempts: [finalizeBatchEvidence(
      evidenceDraft,
      cleanup.state === "cleanup_succeeded" ? "succeeded" : "failed",
    )],
  };
}

/**
 * Fold a terminal cleanup state into assembled findings and errors.
 *
 * @param batch - physical batch used for warning provenance and error fallback
 * @param assembly - assembled candidates, findings, and errors from the attempt
 * @param contextSha256 - context hash carried into the cleanup warning evidence
 * @param cleanup - terminal cleanup state reached by the `finally` block
 * @returns findings and errors with the cleanup classification applied
 *
 * @remarks
 * Postcondition: successful cleanup returns the assembly unchanged. A failed
 * cleanup with surviving candidates appends exactly one warning finding and
 * keeps every candidate; with no surviving candidates it appends the cleanup
 * detail to every claim error, creating one error per claim when the assembly
 * had none. The assembly itself is never mutated.
 */
function applyCleanupOutcome(
  batch: PhysicalBatch<IndexedFormalizationClaim>,
  assembly: AttachedAssembly,
  contextSha256: string,
  cleanup: BatchContextCleanup,
): { readonly findings: readonly Finding[]; readonly errors: readonly FormalizationError[] } {
  if (cleanup.state !== "cleanup_failed") {
    return { findings: assembly.findings, errors: assembly.errors };
  }
  if (assembly.candidates.length > 0) {
    return {
      findings: [...assembly.findings, buildCleanupWarning(batch, contextSha256, cleanup.detail)],
      errors: assembly.errors,
    };
  }
  const detail = `temporary batch cleanup also failed: ${cleanup.detail}`;
  const errors = assembly.errors.length === 0
    ? batch.claims.map((claim) => makeClaimError(claim, detail))
    : assembly.errors.map((error) => ({ ...error, message: `${error.message}; ${detail}` }));
  return { findings: assembly.findings, errors };
}

/**
 * Invoke the attached adapter call and assemble the attached-path assembly.
 *
 * @param input - physical batch and adapter controls for the attached attempt
 * @param prepared - written temp context whose path is attached to the call;
 *   ownership of cleanup stays with the caller's `finally` block
 * @returns an assembly carrying every terminal claim outcome plus the attempt
 *   outcome classification for evidence; `batchAttempts` stays empty because
 *   evidence is finalized only after the caller's cleanup attempt
 *
 * @throws Never intentionally: a thrown adapter call is caught and normalized
 *   into per-claim errors with a `transport_failure` outcome, so the caller's
 *   cleanup `finally` cannot be bypassed.
 *
 * @remarks
 * Postcondition: exactly one of three shapes is returned — transport-failure
 * claim errors for a thrown adapter, the recovery assembly from
 * {@link recoverAttachedFailure} for an expected adapter error, or the
 * acceptance assembly from {@link acceptAttachedResponse} for a parsed
 * response. The batch and prepared context are never mutated.
 */
async function callAndAssembleAttached(
  input: {
    readonly batch: PhysicalBatch<IndexedFormalizationClaim>;
    readonly model: string;
    readonly samplesPerClaim: number;
    readonly timeoutMs: number;
  },
  prepared: WrittenBatchContext,
): Promise<AttachedAssembly> {
  let response: Result<unknown, OpencodeError>;
  try {
    response = await callOpencode({
      model: input.model,
      phase: "formalization",
      prompt: ATTACHED_BATCH_FORMALIZATION_PROMPT,
      retries: ADAPTER_RETRIES,
      timeoutMs: input.timeoutMs,
      files: [prepared.filePath],
    });
  } catch (error: unknown) {
    const message = describeUnknownError(error, "formalization adapter threw");
    return {
      candidates: [],
      findings: [],
      errors: input.batch.claims.map((claim) => makeClaimError(claim, message)),
      batchAttempts: [],
      outcome: { kind: "transport_failure", detail: "formalization adapter threw" },
    };
  }

  if (!response.ok) {
    return await recoverAttachedFailure(input, response.error);
  }
  return await acceptAttachedResponse(input, response.value);
}

/**
 * Degrade an expected attached adapter error to claim errors or inline fallback.
 *
 * @param input - physical batch and adapter controls reused by the fallback
 * @param failure - the terminal attached adapter error being recovered from
 * @returns per-claim errors carrying the attached failure message, or the
 *   inline fallback result; either shape carries the classified attached
 *   outcome so evidence still records why the attached path failed
 *
 * @remarks
 * The degradation decision is made by {@link decideBatchDegradation} from the
 * failure kind and whether every inline prompt fits the adapter limit. When
 * the decision is to emit claim errors, no further adapter work occurs. When
 * it is to fall back, each claim is retried inline at
 * `INLINE_FALLBACK_CONCURRENCY`; because fallback workers run inside slots of
 * the outer `mapBounded(batches, concurrency)` pool, total in-flight adapter
 * calls stay bounded by the configured budget. The per-claim prompts built
 * for the fit check are reused for the fallback calls, so each claim's prompt
 * is constructed exactly once per recovery.
 */
async function recoverAttachedFailure(
  input: {
    readonly batch: PhysicalBatch<IndexedFormalizationClaim>;
    readonly model: string;
    readonly samplesPerClaim: number;
    readonly timeoutMs: number;
  },
  failure: OpencodeError,
): Promise<AttachedAssembly> {
  const outcome = classifyAdapterFailure(failure.kind);
  // Build each claim's prompt once: the same array feeds both the fit check
  // and, on fallback, the inline calls themselves.
  const inlinePrompts = input.batch.claims.map((entry) => buildFormalizationPrompt(entry.claim));
  const inlineFit = inlinePromptsFitOpencodeLimit(inlinePrompts);
  const decision = decideBatchDegradation(failure.kind, inlineFit);
  if (decision.kind === "emit_claim_errors") {
    return {
      candidates: [],
      findings: [],
      errors: input.batch.claims.map((claim) => makeClaimError(claim, failure.message)),
      batchAttempts: [],
      outcome,
    };
  }
  const fallback = await fallbackClaims(
    input.batch.claims,
    input.model,
    input.samplesPerClaim,
    input.timeoutMs,
    inlinePrompts,
  );
  return { ...fallback, outcome };
}

/**
 * Assemble candidates, findings, and errors from a parsed attached response.
 *
 * @param input - physical batch and adapter controls for fallback retries
 * @param response - untrusted parsed model response from the attached call
 * @returns merged candidates (batch successes, per-entry inline fallbacks, and
 *   top-up samples), findings, and per-claim errors, with outcome `success`
 *   only when every batch entry matched and validated
 *
 * @remarks
 * Failure degradation ladder: an unmatchable envelope falls back every claim
 * to inline sampling; individually invalid entries fall back per claim so one
 * malformed entry cannot lose its claim; valid candidates short of
 * `samplesPerClaim` are topped up by {@link addAdditionalSamples}. Every
 * fallback is bounded by `INLINE_FALLBACK_CONCURRENCY`. Inputs are never
 * mutated; candidate arrays are rebuilt rather than edited in place.
 */
async function acceptAttachedResponse(
  input: {
    readonly batch: PhysicalBatch<IndexedFormalizationClaim>;
    readonly model: string;
    readonly samplesPerClaim: number;
    readonly timeoutMs: number;
  },
  response: unknown,
): Promise<AttachedAssembly> {
  const matched = matchAttachedBatchResponse(response, input.batch.claims);
  if (!matched.ok) {
    const fallback = await fallbackClaims(
      input.batch.claims,
      input.model,
      input.samplesPerClaim,
      input.timeoutMs,
    );
    return {
      ...fallback,
      outcome: { kind: "model_failure", errorKind: "schema_validation_error" },
    };
  }

  const collected = collectMatchedCandidates(input.batch.claims, matched.value);
  const candidates: FormalizationCandidate[] = [...collected.candidates];
  const findings: Finding[] = [...collected.findings];
  const failedClaims = collected.failedClaims;

  const errors: FormalizationError[] = [];
  if (failedClaims.length > 0) {
    const fallback = await fallbackClaims(
      failedClaims,
      input.model,
      input.samplesPerClaim,
      input.timeoutMs,
    );
    candidates.push(...fallback.candidates);
    findings.push(...fallback.findings);
    errors.push(...fallback.errors);
  }

  const additional = await addAdditionalSamples(
    candidates,
    input.samplesPerClaim,
    input.model,
    input.timeoutMs,
  );
  return {
    candidates: additional.candidates,
    findings: [...findings, ...additional.findings],
    errors,
    batchAttempts: [],
    outcome: failedClaims.length === 0
      ? { kind: "success" }
      : { kind: "model_failure", errorKind: "schema_validation_error" },
  };
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
function collectMatchedCandidates(
  claims: readonly IndexedFormalizationClaim[],
  matched: ReadonlyMap<number, Result<LogicIrClaim, string>>,
): {
  readonly candidates: readonly FormalizationCandidate[];
  readonly findings: readonly Finding[];
  readonly failedClaims: readonly IndexedFormalizationClaim[];
} {
  const candidates: FormalizationCandidate[] = [];
  const findings: Finding[] = [];
  const failedClaims: IndexedFormalizationClaim[] = [];
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
function matchAttachedBatchResponse(
  response: unknown,
  claims: readonly IndexedFormalizationClaim[],
): Result<ReadonlyMap<number, Result<LogicIrClaim, string>>, string> {
  const entries = extractBatchPayload(response);
  if (entries.length !== claims.length) {
    return err(`expected ${String(claims.length)} indexed formalizations, received ${String(entries.length)}`);
  }

  const claimsByIndex = new Map<number, IndexedFormalizationClaim>();
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
    if (claim === undefined) {
      return err("batch formalization index did not resolve to a source claim");
    }
    const sample = validateSampleForClaim(extractSamplePayload(entry), claim.claim);
    matched.set(index, sample.ok ? ok(sample.value) : err(sample.error.message));
  }
  return ok(matched);
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
function readBatchEntryIndex(entry: unknown): number | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const index = (entry as { readonly index?: unknown }).index;
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0
    ? index
    : undefined;
}

/**
 * Formalize claims one-by-one inline after an attached-path failure.
 *
 * @param claims - claims to retry, each with its authoritative eligible index
 * @param model - adapter model identifier
 * @param samplesPerClaim - target valid-sample count per claim
 * @param timeoutMs - per-call adapter timeout
 * @returns per-claim candidates and findings in claim order, or per-claim
 *   errors; `batchAttempts` is empty because the inline path creates no temp
 *   context
 *
 * @remarks
 * Concurrency is `INLINE_FALLBACK_CONCURRENCY` (2). Ownership model: claims
 * are partitioned one per worker, each claim has a single writer, and results
 * are joined by eligible index, so any interleaving of workers yields the
 * same candidates and errors. These workers run inside slots of the outer
 * `mapBounded(batches, concurrency)` pool, so a degraded batch amplifies
 * adapter load by at most the fixed factor `INLINE_FALLBACK_CONCURRENCY`:
 * the worst-case in-flight bound is `concurrency * INLINE_FALLBACK_CONCURRENCY`,
 * never scaled by batch size. A worker that throws is caught
 * per claim and normalized to an error, so one bad claim cannot discard the
 * other claims' results. Postcondition: every input claim contributes exactly
 * one candidate or one error. Inputs are never mutated.
 *
 * @param prompts - optional prebuilt per-claim prompts, parallel to `claims`;
 *   when provided, `prompts[i]` must be the prompt for `claims[i]`
 */
async function fallbackClaims(
  claims: readonly IndexedFormalizationClaim[],
  model: string,
  samplesPerClaim: number,
  timeoutMs: number,
  prompts?: readonly string[],
): Promise<BatchResult> {
  precondition(
    prompts === undefined || prompts.length === claims.length,
    "fallback prompts must be parallel to claims",
  );
  const results = await mapBounded(claims, INLINE_FALLBACK_CONCURRENCY, async (indexedClaim, position) => {
    try {
      const prompt = prompts === undefined ? undefined : prompts[position];
      const sampling = prompt === undefined
        ? { indexedClaim, model, samplesPerClaim, timeoutMs }
        : { indexedClaim, model, samplesPerClaim, timeoutMs, prompt };
      return await sampleFormalizationsForClaim(sampling);
    } catch (error: unknown) {
      return err(makeClaimError(indexedClaim, describeUnknownError(error, "inline fallback failed")));
    }
  });
  const candidates: FormalizationCandidate[] = [];
  const findings: Finding[] = [];
  const errors: FormalizationError[] = [];
  for (const result of results) {
    if (result.ok) {
      candidates.push(result.value.candidate);
      findings.push(...result.value.findings);
    } else {
      errors.push(result.error);
    }
  }
  return { candidates, findings, errors, batchAttempts: [] };
}

/**
 * Top up batch-validated candidates that are short of `samplesPerClaim`.
 *
 * @param candidates - accepted batch candidates; treated as immutable
 * @param samplesPerClaim - target valid-sample count per claim
 * @param model - adapter model identifier
 * @param timeoutMs - per-call adapter timeout
 * @returns candidates sorted by eligible index with merged sample sets, plus
 *   failure findings for claims whose top-up could not complete; with
 *   `samplesPerClaim <= 1` the input array is returned unchanged
 *
 * @remarks
 * Only the deficit (`samplesPerClaim - candidate.samples.length`) is
 * requested, so per-claim adapter work stays bounded by the attempt budget in
 * {@link sampleFormalizationsForClaim}. Top-up runs at
 * `INLINE_FALLBACK_CONCURRENCY` (2) with one owner per candidate and results
 * joined by eligible index, so any interleaving yields the same output; a
 * thrown or failed top-up preserves the original candidate and emits a
 * warning finding instead of an error, because the claim already has at least
 * one valid sample. Postcondition: every input candidate appears exactly once
 * in the output, ordered by eligible index.
 */
async function addAdditionalSamples(
  candidates: readonly FormalizationCandidate[],
  samplesPerClaim: number,
  model: string,
  timeoutMs: number,
): Promise<{ readonly candidates: readonly FormalizationCandidate[]; readonly findings: readonly Finding[] }> {
  if (samplesPerClaim <= 1) {
    return { candidates, findings: [] };
  }
  const needMore = candidates.filter((candidate) => candidate.samples.length < samplesPerClaim);
  const results = await mapBounded(needMore, INLINE_FALLBACK_CONCURRENCY, async (candidate) => {
    // Only the claim and its eligible index are needed; the semantic key is
    // intentionally not reconstructed here because sampling never re-groups.
    const indexedClaim = { claim: candidate.claim, index: candidate.eligibleIndex };
    try {
      return await sampleFormalizationsForClaim({
        indexedClaim,
        model,
        samplesPerClaim: samplesPerClaim - candidate.samples.length,
        timeoutMs,
      });
    } catch (error: unknown) {
      return err<FormalizationError>({
        message: describeUnknownError(error, "additional formalization sample failed"),
        eligibleIndex: candidate.eligibleIndex,
      });
    }
  });

  const byIndex = new Map<number, FormalizationCandidate>();
  for (const candidate of candidates) {
    byIndex.set(candidate.eligibleIndex, candidate);
  }
  const findings: Finding[] = [];
  for (let position = 0; position < results.length; position += 1) {
    const result = results[position];
    const original = needMore[position];
    if (result === undefined || original === undefined) {
      continue;
    }
    if (!result.ok) {
      findings.push(buildAdditionalSampleFailureFinding(original, result.error.message));
      continue;
    }
    const existing = byIndex.get(original.eligibleIndex);
    if (existing !== undefined) {
      byIndex.set(original.eligibleIndex, {
        ...existing,
        samples: [...existing.samples, ...result.value.candidate.samples],
        invalidSamples: [...existing.invalidSamples, ...result.value.candidate.invalidSamples],
      });
      findings.push(...result.value.findings);
    }
  }
  return { candidates: [...byIndex.values()].sort(compareCandidates), findings };
}

/**
 * Collect up to `samplesPerClaim` valid Logic IR samples for one claim inline.
 *
 * @param input.indexedClaim - the claim and its authoritative eligible index;
 *   only `claim` and `index` are read, so callers without a semantic key (such
 *   as additional-sample merging) may pass the minimal shape
 * @param input.model - adapter model identifier
 * @param input.samplesPerClaim - target valid-sample count (safe integer >= 1)
 * @param input.timeoutMs - per-call adapter timeout
 * @returns the candidate and findings, or a claim-level error when no valid
 *   sample is obtained
 *
 * @remarks
 * The attempt budget is `samplesPerClaim * ADAPTER_RETRIES` and each adapter
 * call has its own internal retry budget, so total subprocess spawns per claim
 * stay bounded. The adapter short-circuits failure kinds that are
 * deterministic for a fixed prompt, so those cost one spawn per domain attempt
 * instead of a full adapter retry budget. A terminal adapter error after at
 * least one valid sample preserves the candidate and records a
 * sample-shortfall finding rather than discarding collected work. Thrown
 * adapter failures are caught as `unknown` and normalized to a claim-level
 * error. Inputs are never mutated.
 */
async function sampleFormalizationsForClaim(input: {
  readonly indexedClaim: { readonly claim: Claim; readonly index: number };
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
  /** Prebuilt prompt for the claim; built from the claim when omitted. */
  readonly prompt?: string;
}): Promise<Result<SampleSuccess, FormalizationError>> {
  const validSamples: LogicIrClaim[] = [];
  const invalidSamples: { raw: unknown; reason: string }[] = [];
  const findings: Finding[] = [];
  const maxAttempts = Math.max(1, input.samplesPerClaim * ADAPTER_RETRIES);
  let terminalFailure: string | undefined;
  // The prompt is identical across attempts: building it once here keeps the
  // multi-KB template join and fence sanitization out of the retry loop.
  const prompt = input.prompt ?? buildFormalizationPrompt(input.indexedClaim.claim);

  for (let attempt = 1; attempt <= maxAttempts && validSamples.length < input.samplesPerClaim; attempt += 1) {
    let response: Result<unknown, OpencodeError>;
    try {
      response = await callOpencode({
        model: input.model,
        phase: "formalization",
        prompt,
        retries: ADAPTER_RETRIES,
        timeoutMs: input.timeoutMs,
      });
    } catch (error: unknown) {
      return err(makeClaimError(
        input.indexedClaim,
        describeUnknownError(error, "formalization adapter threw"),
      ));
    }
    if (!response.ok) {
      // The adapter has already exhausted its internal retries, so any failure
      // ends the domain loop: with no valid sample the claim errors, otherwise
      // the shortfall finding below reports the failure while preserving
      // collected work. Deterministic kinds reach here in one spawn because
      // the adapter short-circuits them; no domain-level respawn would help.
      if (validSamples.length === 0) {
        return err(makeClaimError(input.indexedClaim, response.error.message));
      }
      terminalFailure = response.error.message;
      break;
    }

    const candidateSample = extractSamplePayload(response.value);
    const validated = validateSampleForClaim(candidateSample, input.indexedClaim.claim);
    if (!validated.ok) {
      invalidSamples.push({ raw: candidateSample, reason: validated.error.message });
      findings.push(buildInvalidSampleFinding(input.indexedClaim.claim, attempt, validated.error.message));
    } else {
      validSamples.push(validated.value);
    }
  }

  if (validSamples.length === 0) {
    return err(makeClaimError(
      input.indexedClaim,
      `all formalization samples invalid for claim ${input.indexedClaim.claim.id ?? "<unnamed>"}`,
    ));
  }
  if (validSamples.length < input.samplesPerClaim) {
    findings.push(buildSampleShortfallFinding(
      input.indexedClaim.claim,
      validSamples.length,
      input.samplesPerClaim,
      terminalFailure,
    ));
  }
  return ok({
    candidate: {
      claim: input.indexedClaim.claim,
      eligibleIndex: input.indexedClaim.index,
      samples: validSamples,
      invalidSamples,
    },
    findings,
  });
}

/**
 * Build a sandboxed prompt for one source claim.
 *
 * @param claim - requirement or scenario to present as untrusted text
 * @returns deterministic prompt containing formalization rules and the claim
 *
 * @remarks
 * Security postcondition: claim text is fenced after the sandboxing instruction,
 * and every run of 3+ backticks in the raw text is escaped so it cannot close or
 * open a prompt fence. The function performs no I/O, does not mutate `claim`,
 * and has no expected failure mode.
 *
 * @example
 * ```ts
 * const prompt = buildFormalizationPrompt(claim);
 * ```
 */
export function buildFormalizationPrompt(claim: Claim): string {
  return [
    FORMALIZATION_INSTRUCTIONS,
    FORMALIZATION_SANDBOXING,
    `<claim id=${JSON.stringify(claim.id ?? "UNNAMED")} obligation=${JSON.stringify(claim.obligation)}>`,
    "```text",
    sanitizeForCodeFence(claim.text),
    "```",
    "</claim>",
  ].join("\n");
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

type BatchAttemptEvidenceDraft = Readonly<Omit<BatchAttemptEvidence, "cleanup">>;
type BatchAttemptEvidenceMetadata = Readonly<Omit<BatchAttemptEvidenceDraft, "outcome">>;

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
function buildBatchEvidenceMetadata(
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
function buildBatchEvidenceDraft(
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
function finalizeBatchEvidence(
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
function classifyAdapterFailure(kind: OpencodeError["kind"]): BatchAttemptEvidence["outcome"] {
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
function buildInvalidSampleFinding(claim: Claim, attempt: number, reason: string): Finding {
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
function buildBatchEntryInvalidFinding(claim: Claim, reason: string): Finding {
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
function buildSampleShortfallFinding(
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
function buildAdditionalSampleFailureFinding(candidate: FormalizationCandidate, message: string): Finding {
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
function buildCleanupWarning(
  batch: PhysicalBatch<IndexedFormalizationClaim>,
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
function workerFailureResult(
  batch: PhysicalBatch<IndexedFormalizationClaim>,
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
function makeClaimError(
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
function compareCandidates(left: FormalizationCandidate, right: FormalizationCandidate): number {
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
function compareErrors(left: FormalizationError, right: FormalizationError): number {
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
function describeUnknownError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

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
function validateSampleForClaim(
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
function emptyBatchResult(): BatchResult {
  return { candidates: [], findings: [], errors: [], batchAttempts: [] };
}
