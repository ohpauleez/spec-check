/**
 * Multi-claim attached batch formalization internals.
 *
 * Owns physical batch dispatch, deterministic context transport, cleanup,
 * degradation policy, and index-based response validation. This module keeps
 * the complex lifecycle logic out of the main formalization orchestrator.
 *
 * Exports: formalizePhysicalBatch, FormalizePhysicalBatchInput, BatchResult,
 *          PhysicalBatch, extractBatchPayload.
 */

import { rmSync } from "node:fs";
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import type { OpencodeError } from "../../adapters/opencode.js";
import { assertNever } from "../assert.js";
import { precondition } from "../assert.js";
import { PROMPT_ARG_MAX_BYTES } from "../../adapters/opencode.js";
import { callOpencode } from "../../adapters/opencode.js";
import { mapBounded } from "../../adapters/concurrency.js";
import {
  buildAttachedBatchPrompt,
  buildBatchContextFile,
  createTempBatchDirectory,
  removeBatchContextDirectory,
  sha256HexString,
  writeBatchContextFile,
} from "./transport.js";
import { sampleFormalizationsForClaim, buildFormalizationPrompt } from "./sample-formalization.js";
import { validateFormalizationSample } from "./validate.js";
import type {
  BatchAttemptEvidence,
  BatchAttemptOutcome,
  BatchCleanupOutcome,
  FormalizationError,
  IndexedClaim,
} from "./formalize.js";

/**
 * One physical sub-batch: a slice of a logical semantic group.
 */
export interface PhysicalBatch {
  readonly batchKey: string;
  readonly ordinal: number;
  readonly claims: readonly IndexedClaim[];
}

/**
 * Result of formalizing one physical sub-batch.
 */
export interface BatchResult {
  readonly candidates: readonly {
    readonly claim: IndexedClaim;
    readonly samples: readonly LogicIrClaim[];
    readonly invalidSamples: readonly { readonly raw: unknown; readonly reason: string }[];
  }[];
  readonly findings: readonly Finding[];
  readonly errors: readonly FormalizationError[];
  readonly outcome: BatchAttemptEvidence | undefined;
}

/**
 * Input to {@link formalizePhysicalBatch}.
 */
export interface FormalizePhysicalBatchInput {
  readonly batch: PhysicalBatch;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}

/**
 * Formalize one physical sub-batch.
 *
 * @param input - batch, model, and sampling controls
 * @returns result for this physical batch
 *
 * @remarks
 * Precondition: `input.batch.claims` is non-empty or the function returns an
 *   empty result immediately.
 * Postcondition: if the batch has exactly one claim, the inline path is used.
 * Postcondition: if the batch has two or more claims, the attached transport path
 *   is used and an outcome is recorded.
 * Postcondition: every claim in the batch reaches exactly one terminal outcome
 *   within the returned result.
 */
export async function formalizePhysicalBatch(input: FormalizePhysicalBatchInput): Promise<BatchResult> {
  const { batch, model, samplesPerClaim, timeoutMs } = input;

  if (batch.claims.length === 0) {
    return { candidates: [], findings: [], errors: [], outcome: undefined };
  }

  if (batch.claims.length === 1) {
    return await formalizeSingleClaimBatch({
      claim: batch.claims[0]!,
      model,
      samplesPerClaim,
      timeoutMs,
      batchKey: batch.batchKey,
      ordinal: batch.ordinal,
    });
  }

  return await formalizeMultiClaimBatch({
    batch,
    model,
    samplesPerClaim,
    timeoutMs,
  });
}

interface FormalizeSingleClaimBatchInput {
  readonly claim: IndexedClaim;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
  readonly batchKey: string;
  readonly ordinal: number;
}

/**
 * Formalize a single-claim physical batch inline.
 *
 * @remarks
 * Postcondition: on success, one candidate is returned.
 * Postcondition: on failure, one claim-level error is returned.
 * This path does not produce a separate batch evidence record.
 */
async function formalizeSingleClaimBatch(input: FormalizeSingleClaimBatchInput): Promise<BatchResult> {
  const result = await sampleFormalizationsForClaim({
    claim: input.claim.claim,
    eligibleIndex: input.claim.eligibleIndex,
    model: input.model,
    samplesPerClaim: input.samplesPerClaim,
    timeoutMs: input.timeoutMs,
  });

  if (result.ok) {
    return {
      candidates: [{
        claim: input.claim,
        samples: result.value.samples,
        invalidSamples: result.value.invalidSamples,
      }],
      findings: result.value.findings,
      errors: [],
      outcome: undefined,
    };
  }

  return {
    candidates: [],
    findings: [],
    errors: [result.error],
    outcome: undefined,
  };
}

interface FormalizeMultiClaimBatchInput {
  readonly batch: PhysicalBatch;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}

/**
 * Formalize a multi-claim physical batch via the file-attached transport.
 *
 * @remarks
 * Precondition: `input.batch.claims.length >= 2`.
 * Postcondition: a `BatchAttemptEvidence` record is always produced, even on failure.
 * Postcondition: claim candidates are matched by explicit `index`, never by array
 *   position or `claim.id` alone.
 * Postcondition: the temp directory is attempted in a `finally`-equivalent path
 *   for every terminal state.
 *
 * Failure forms:
 * - Temp directory creation or file write failure → transport failure evidence.
 * - Adapter throws → normalized to transport failure evidence.
 * - Adapter returns a terminal non-degradable error → claim errors.
 * - Adapter returns a degradable error → per-claim inline retries.
 * - Response index mismatch or invalid sample → individual retry for affected claims.
 */
async function formalizeMultiClaimBatch(input: FormalizeMultiClaimBatchInput): Promise<BatchResult> {
  const { batch, model, samplesPerClaim, timeoutMs } = input;
  precondition(batch.claims.length >= 2, "multi-claim batch requires at least two claims");

  const context = buildBatchContextFile(batch.batchKey, batch.claims);
  let directory: string | undefined;
  let serializedContext: string | undefined;
  let contextHash: string | undefined;
  let lifecycleState: "not_created" | "dir_created" | "file_written" = "not_created";

  try {
    directory = await createTempBatchDirectory();
    lifecycleState = "dir_created";
    serializedContext = await writeBatchContextFile(directory, context);
    contextHash = sha256HexString(serializedContext);
    lifecycleState = "file_written";
  } catch (error: unknown) {
    return transportFailureResult(batch, model, error, contextHash, directory, lifecycleState);
  }

  precondition(directory !== undefined, "directory must exist after successful creation");
  precondition(serializedContext !== undefined, "serialized context must exist after successful write");
  precondition(contextHash !== undefined, "context hash must exist after successful write");

  const prompt = buildAttachedBatchPrompt(batch.claims.length);

  let response: Awaited<ReturnType<typeof callOpencode>>;
  try {
    response = await callOpencode({
      model,
      phase: "formalization",
      prompt,
      files: [directory],
      retries: 3,
      timeoutMs,
    });
  } catch (error: unknown) {
    return adapterThrowResult(batch, model, error, directory, contextHash);
  }

  if (!response.ok) {
    return await adapterErrorResult(batch, model, response.error.kind, directory, contextHash, samplesPerClaim, timeoutMs);
  }

  return await adapterSuccessResult(batch, model, response.value, directory, contextHash, samplesPerClaim, timeoutMs);
}

/**
 * Build a batch evidence record.
 */
function buildBatchEvidence(input: {
  readonly batch: PhysicalBatch;
  readonly contextHash: string;
  readonly model: string;
  readonly outcome: BatchAttemptOutcome;
  readonly cleanup: BatchCleanupOutcome;
}): BatchAttemptEvidence {
  return {
    schemaVersion: 1,
    batchKey: input.batch.batchKey,
    claimIndexes: input.batch.claims.map((item) => item.eligibleIndex),
    claimIds: input.batch.claims.map((item) => item.claim.id ?? null),
    provenanceFiles: input.batch.claims.map((item) => item.claim.provenance.file),
    contextSha256: input.contextHash,
    promptVariant: "attached-batch-v1",
    model: input.model,
    subBatchOrdinal: input.batch.ordinal,
    outcome: input.outcome,
    cleanup: input.cleanup,
  };
}

/**
 * Attempt temp cleanup and return the outcome.
 */
async function cleanup(directory: string | undefined): Promise<BatchCleanupOutcome> {
  if (directory === undefined) {
    return "not_attempted";
  }
  const result = await removeBatchContextDirectory(directory);
  return result.kind === "succeeded" ? "succeeded" : "failed";
}

/**
 * Produce a cleanup warning finding if cleanup failed after a successful model response.
 */
function cleanupWarning(batch: PhysicalBatch, cleanupOutcome: BatchCleanupOutcome): Finding | undefined {
  if (cleanupOutcome !== "failed") {
    return undefined;
  }
  return {
    severity: "warning",
    category: "formalization.temp_cleanup_failed",
    provenance: { file: batch.claims[0]?.claim.provenance.file ?? batch.batchKey },
    description: `Temp context cleanup failed for batch ${batch.batchKey} ordinal ${String(batch.ordinal)}`,
    rationale: "The batch completed successfully but its temp context directory could not be removed. Successful candidates are preserved; the failure is recorded for diagnostics.",
    evidence: [
      { kind: "batch_key", value: batch.batchKey },
      { kind: "sub_batch_ordinal", value: String(batch.ordinal) },
    ],
  };
}

/**
 * Classify an OpencodeError kind into a batch outcome category.
 */
function classifyOutcome(errorKind: OpencodeError["kind"]): BatchAttemptOutcome {
  switch (errorKind) {
    case "timeout":
    case "invalid_json":
    case "schema_validation_error":
    case "prompt_too_large":
      return { kind: "model_failure", errorKind };
    case "spawn_error":
    case "invalid_files":
    case "invalid_timeout":
      return { kind: "infrastructure_failure", errorKind };
    default:
      return assertNever(errorKind);
  }
}

/**
 * Decide whether a multi-claim attached failure should degrade to per-claim
 * inline retry or produce immediate claim-level errors.
 *
 * @remarks
 * Postcondition: `timeout`/`invalid_json`/`schema_validation_error` always degrade.
 * Postcondition: `spawn_error`/`invalid_files`/`invalid_timeout` never degrade.
 * Postcondition: `prompt_too_large` degrades only if every per-claim inline prompt
 *   fits the adapter's byte limit.
 */
function decideBatchFailurePolicy(
  errorKind: OpencodeError["kind"],
  claims: readonly IndexedClaim[],
):
  | { readonly kind: "degrade" }
  | { readonly kind: "claim_errors" } {
  switch (errorKind) {
    case "timeout":
    case "invalid_json":
    case "schema_validation_error":
      return { kind: "degrade" };
    case "spawn_error":
    case "invalid_files":
    case "invalid_timeout":
      return { kind: "claim_errors" };
    case "prompt_too_large": {
      const fits = claims.every((item) => {
        const promptBytes = Buffer.byteLength(buildFormalizationPrompt(item.claim), "utf8");
        return promptBytes <= PROMPT_ARG_MAX_BYTES;
      });
      return fits ? { kind: "degrade" } : { kind: "claim_errors" };
    }
    default:
      return assertNever(errorKind);
  }
}

/**
 * Validate a batch response against the attached claim indexes.
 *
 * @remarks
 * Postcondition: each returned entry with a unique, safe-integer `index` that matches
 *   an attached claim is placed in `matched`.
 * Postcondition: every attached claim not represented by a valid, unique index is
 *   placed in `unmatched`.
 * Invariant: `matched` and `unmatched` partition the input claims.
 */
export function validateBatchResponse(
  response: unknown,
  claims: readonly IndexedClaim[],
): {
  readonly matched: readonly { readonly claim: IndexedClaim; readonly sample: unknown }[];
  readonly unmatched: readonly IndexedClaim[];
} {
  const entries = extractBatchPayload(response);
  const byIndex = new Map<number, IndexedClaim>();
  for (const claim of claims) {
    byIndex.set(claim.eligibleIndex, claim);
  }

  const matched: { claim: IndexedClaim; sample: unknown }[] = [];
  const seen = new Set<number>();

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const typed = entry as { readonly index?: unknown };
    if (!Number.isSafeInteger(typed.index)) {
      continue;
    }
    const index = typed.index as number;
    if (!byIndex.has(index) || seen.has(index)) {
      continue;
    }
    seen.add(index);
    matched.push({ claim: byIndex.get(index)!, sample: entry });
  }

  const unmatched: IndexedClaim[] = [];
  for (const claim of claims) {
    if (!seen.has(claim.eligibleIndex)) {
      unmatched.push(claim);
    }
  }

  return { matched, unmatched };
}

/**
 * Extract an array of formalization entries from a batch LLM response.
 *
 * @param response - raw LLM response object
 * @returns array of formalization entries, or an empty array if unrecoverable
 *
 * @remarks
 * Postcondition: returns `response.formalizations` when it is an array, otherwise
 *   returns `response` if it is an array, otherwise an empty array.
 */
export function extractBatchPayload(response: unknown): readonly unknown[] {
  if (typeof response !== "object" || response === null) {
    return [];
  }

  const record = response as { readonly formalizations?: unknown };
  if (Array.isArray(record.formalizations)) {
    return record.formalizations;
  }

  if (Array.isArray(response)) {
    return response;
  }

  return [];
}

/**
 * Normalize an unknown thrown value into a structured error.
 */
function normalizeThrownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Build a finding for an invalid batch entry.
 */
function batchEntryInvalidFinding(item: IndexedClaim, reason: string): Finding {
  return {
    severity: "warning",
    category: "formalization.batch_entry_invalid",
    provenance: item.claim.provenance,
    description: `Batch entry invalid, retrying individually: ${reason}`,
    rationale: "A batch entry that fails validation suggests the model produced malformed output for this claim; individual retry may succeed but the instability signals a fragile formalization.",
    evidence: [{ kind: "claim", value: item.claim.text }],
    ...(item.claim.id === undefined ? {} : { relatedClaimIdentifiers: [item.claim.id] }),
  };
}

/**
 * Compose a terminal result for a transport/setup failure before the adapter call.
 */
function transportFailureResult(
  batch: PhysicalBatch,
  model: string,
  error: unknown,
  contextHash: string | undefined,
  directory: string | undefined,
  lifecycleState: "not_created" | "dir_created" | "file_written",
): BatchResult {
  const normalized = normalizeThrownError(error);
  const outcome: BatchAttemptOutcome = {
    kind: "transport_failure",
    detail: normalized.message,
  };
  const evidence = buildBatchEvidence({
    batch,
    contextHash: contextHash ?? "",
    model,
    outcome,
    cleanup: lifecycleState === "not_created" ? "not_attempted" : cleanupSync(directory),
  });
  return {
    candidates: [],
    findings: [],
    errors: batch.claims.map((item) => ({
      message: `failed to formalize claim ${item.claim.id ?? "<unnamed>"}: ${normalized.message}`,
    })),
    outcome: evidence,
  };
}

/**
 * Synchronously attempt cleanup when we are already inside a failure path.
 *
 * Used only when returning from a catch block where the directory may be partially
 * created. The cleanup result is folded into the evidence record.
 */
function cleanupSync(directory: string | undefined): BatchCleanupOutcome {
  if (directory === undefined) {
    return "not_attempted";
  }
  try {
    // Synchronous cleanup is intentionally best-effort in failure paths.
    // The import is local to avoid coupling the rest of the module to sync fs.
    rmSync(directory, { recursive: true, force: true });
    return "succeeded";
  } catch {
    return "failed";
  }
}

/**
 * Compose a terminal result when the adapter threw unexpectedly.
 */
async function adapterThrowResult(
  batch: PhysicalBatch,
  model: string,
  error: unknown,
  directory: string | undefined,
  contextHash: string,
): Promise<BatchResult> {
  const normalized = normalizeThrownError(error);
  const cleanupOutcome = await cleanup(directory);
  const evidence = buildBatchEvidence({
    batch,
    contextHash,
    model,
    outcome: { kind: "transport_failure", detail: normalized.message },
    cleanup: cleanupOutcome,
  });
  const warning = cleanupWarning(batch, cleanupOutcome);
  return {
    candidates: [],
    findings: warning === undefined ? [] : [warning],
    errors: batch.claims.map((item) => ({
      message: `failed to formalize claim ${item.claim.id ?? "<unnamed>"}: ${normalized.message}`,
    })),
    outcome: evidence,
  };
}

/**
 * Compose a terminal result when the adapter returned an error.
 */
async function adapterErrorResult(
  batch: PhysicalBatch,
  model: string,
  errorKind: OpencodeError["kind"],
  directory: string,
  contextHash: string,
  samplesPerClaim: number,
  timeoutMs: number,
): Promise<BatchResult> {
  const policy = decideBatchFailurePolicy(errorKind, batch.claims);
  const cleanupOutcome = await cleanup(directory);
  const evidence = buildBatchEvidence({
    batch,
    contextHash,
    model,
    outcome: classifyOutcome(errorKind),
    cleanup: cleanupOutcome,
  });
  const warning = cleanupWarning(batch, cleanupOutcome);

  if (policy.kind === "degrade") {
    const degraded = await mapBounded(batch.claims, 2, async (item) => {
      return await sampleFormalizationsForClaim({
        claim: item.claim,
        eligibleIndex: item.eligibleIndex,
        model,
        samplesPerClaim,
        timeoutMs,
      });
    });
    const candidates: {
      claim: IndexedClaim;
      samples: readonly LogicIrClaim[];
      invalidSamples: readonly { raw: unknown; reason: string }[];
    }[] = [];
    const degradedErrors: FormalizationError[] = [];
    const degradedFindings: Finding[] = [];
    for (const result of degraded) {
      if (result.ok) {
        candidates.push({
          claim: { claim: result.value.candidate.claim, eligibleIndex: result.value.candidate.eligibleIndex },
          samples: result.value.samples,
          invalidSamples: result.value.invalidSamples,
        });
        degradedFindings.push(...result.value.findings);
      } else {
        degradedErrors.push(result.error);
      }
    }
    return {
      candidates,
      findings: warning === undefined ? degradedFindings : [...degradedFindings, warning],
      errors: degradedErrors,
      outcome: evidence,
    };
  }

  return {
    candidates: [],
    findings: warning === undefined ? [] : [warning],
    errors: batch.claims.map((item) => ({
      message: `failed to formalize claim ${item.claim.id ?? "<unnamed>"}: terminal adapter error`,
    })),
    outcome: evidence,
  };
}

/**
 * Compose a terminal result when the adapter returned a payload.
 */
async function adapterSuccessResult(
  batch: PhysicalBatch,
  model: string,
  response: unknown,
  directory: string,
  contextHash: string,
  samplesPerClaim: number,
  timeoutMs: number,
): Promise<BatchResult> {
  const validated = validateBatchResponse(response, batch.claims);
  const cleanupOutcome = await cleanup(directory);
  const evidence = buildBatchEvidence({
    batch,
    contextHash,
    model,
    outcome: { kind: "success" },
    cleanup: cleanupOutcome,
  });
  const warning = cleanupWarning(batch, cleanupOutcome);

  const failedClaims: IndexedClaim[] = [];
  const candidates: {
    claim: IndexedClaim;
    samples: readonly LogicIrClaim[];
    invalidSamples: readonly { raw: unknown; reason: string }[];
  }[] = [];
  const localFindings: Finding[] = [];
  const localErrors: FormalizationError[] = [];

  for (const entry of validated.matched) {
    const validation = validateFormalizationSample(entry.sample);
    if (!validation.ok) {
      failedClaims.push(entry.claim);
      localFindings.push(batchEntryInvalidFinding(entry.claim, validation.error.message));
      continue;
    }
    candidates.push({ claim: entry.claim, samples: [validation.value], invalidSamples: [] });
  }

  failedClaims.push(...validated.unmatched);

  if (failedClaims.length > 0) {
    const retries = await mapBounded(failedClaims, 2, async (item) => {
      return await sampleFormalizationsForClaim({
        claim: item.claim,
        eligibleIndex: item.eligibleIndex,
        model,
        samplesPerClaim: 1,
        timeoutMs,
      });
    });
    for (const result of retries) {
      if (result.ok) {
        candidates.push({
          claim: { claim: result.value.candidate.claim, eligibleIndex: result.value.candidate.eligibleIndex },
          samples: result.value.samples,
          invalidSamples: result.value.invalidSamples,
        });
        localFindings.push(...result.value.findings);
      } else {
        localErrors.push(result.error);
      }
    }
  }

  if (warning !== undefined) {
    localFindings.push(warning);
  }

  return { candidates, findings: localFindings, errors: localErrors, outcome: evidence };
}

