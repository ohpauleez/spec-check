/**
 * Translate requirement and scenario claims into validated Logic IR samples.
 *
 * Semantic grouping and physical batching are deterministic. Single-claim
 * batches use inline prompts; multi-claim batches use an attached JSON context.
 *
 * @remarks
 * Orchestration lives here; shared types live in `formalization-types.ts`,
 * pure finding/error/response-matching builders in `formalization-findings.ts`,
 * and immutable attempt-evidence staging in `batch-evidence.ts`. The public
 * names consumed by existing importers are re-exported below so module
 * boundaries can change without breaking call sites.
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
  buildBatchEvidenceDraft,
  buildBatchEvidenceMetadata,
  classifyAdapterFailure,
  finalizeBatchEvidence,
  type BatchAttemptEvidenceMetadata,
} from "./batch-evidence.js";
import {
  buildBatchContextFile,
  cleanupBatchContext,
  createBatchContextDirectory,
  prepareBatchContextData,
  writeBatchContextFile,
  type BatchAttemptEvidence,
  type BatchContextCleanup,
  type BatchContextDirectory,
  type WrittenBatchContext,
} from "./batch-transport.js";
import { decideBatchDegradation, inlinePromptsFitOpencodeLimit } from "./degradation.js";
import {
  buildAdditionalSampleFailureFinding,
  buildCleanupWarning,
  buildInvalidSampleFinding,
  buildSampleShortfallFinding,
  collectMatchedCandidates,
  compareCandidates,
  compareErrors,
  describeUnknownError,
  emptyBatchResult,
  extractSamplePayload,
  makeClaimError,
  matchAttachedBatchResponse,
  validateSampleForClaim,
  workerFailureResult,
} from "./formalization-findings.js";
import type {
  AttachedAssembly,
  BatchResult,
  FormalizationCandidate,
  FormalizationError,
  FormalizationOutput,
  SampleSuccess,
} from "./formalization-types.js";
import {
  groupFormalizationClaims,
  splitPhysicalBatches,
  type IndexedFormalizationClaim,
  type PhysicalBatch,
} from "./grouping.js";

export type { FormalizationCandidate, FormalizationError, FormalizationOutput } from "./formalization-types.js";
export {
  extractBatchPayload,
  extractSamplePayload,
} from "./formalization-findings.js";

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
