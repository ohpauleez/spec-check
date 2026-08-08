/**
 * Translate requirement and scenario claims into validated Logic IR samples.
 *
 * Semantic grouping and physical batching are deterministic. Filesystem and
 * adapter effects are isolated at the attached-transport edge, where every
 * handled failure is converted into claim-level output.
 */
import { callOpencode } from "../../adapters/opencode.js";
import { mapBounded } from "../../adapters/concurrency.js";
import type { Claim } from "../claim-graph.js";
import type { LogicIrClaim } from "../logic-ir.js";
import type { Finding } from "../findings.js";
import { err, ok, type Result } from "../result.js";
import { assertNever } from "../assert.js";
import { validateFormalizationSample } from "./validate.js";
import {
  groupFormalizationClaims,
  splitPhysicalBatches,
  type IndexedFormalizationClaim,
  type PhysicalClaimBatch,
} from "./grouping.js";
import {
  buildBatchContextFile,
  buildBatchAttemptEvidence,
  cleanupBatchContextDirectory,
  createBatchContextDirectory,
  hashBatchContext,
  serializeBatchContext,
  writeBatchContextFile,
  type BatchAttemptEvidence,
  type BatchCleanupOutcome,
  type BatchAttemptOutcome,
} from "./batch-transport.js";
import { shouldDegradeBatchError } from "./degradation.js";
import type { OpencodeErrorKind } from "../../adapters/opencode.js";
import {
  ATTACHED_BATCH_FORMALIZATION_PROMPT,
  FORMALIZATION_INSTRUCTIONS,
  FORMALIZATION_SANDBOXING,
} from "../prompts/formalization.js";

/** Maximum concurrent physical batches when callers omit a value. */
const FORMALIZATION_CONCURRENCY_DEFAULT = 3;
/** Maximum concurrent per-claim fallback calls. */
// Each physical-batch worker owns one adapter slot. Keeping nested fallback
// work sequential prevents a failed batch from exceeding the caller's bound.
const INLINE_FALLBACK_CONCURRENCY = 1;
/** Adapter retry count passed for every formalization invocation. */
const ADAPTER_RETRIES = 3;
/** Default means one unbounded physical batch per logical group. */
const MAX_BATCH_SIZE_DEFAULT = 0;

/**
 * A single claim's formalization result.
 *
 * @remarks
 * `samples` contains only validated Logic IR. `eligibleIndex` is the stable
 * identity used internally and is optional only for source compatibility with
 * hand-built candidates from older callers.
 */
export interface FormalizationCandidate {
  readonly claim: Claim;
  readonly samples: readonly LogicIrClaim[];
  readonly invalidSamples: readonly { readonly raw: unknown; readonly reason: string }[];
  readonly eligibleIndex?: number;
}

/**
 * Successful output from the formalization phase.
 *
 * @remarks
 * Candidates and errors are ordered by eligible claim index where available.
 * `batchAttempts` contains metadata only; it never stores claim text.
 */
export interface FormalizationOutput {
  readonly candidates: readonly FormalizationCandidate[];
  readonly findings: readonly Finding[];
  readonly errors: readonly FormalizationError[];
  readonly batchAttempts: readonly BatchAttemptEvidence[];
}

/**
 * Claim-level expected failure from formalization.
 *
 * @remarks
 * The message remains the stable human-readable contract. Optional identity
 * fields make output attribution independent of completion order.
 */
export interface FormalizationError {
  readonly message: string;
  readonly eligibleIndex?: number;
  readonly claimId?: string;
}

interface BatchWorkResult {
  readonly candidates: readonly FormalizationCandidate[];
  readonly findings: readonly Finding[];
  readonly errors: readonly FormalizationError[];
  readonly batchAttempts: readonly BatchAttemptEvidence[];
}

interface ClaimSampleResult {
  readonly candidate: FormalizationCandidate;
  readonly findings: readonly Finding[];
}

type AdapterResponse = Awaited<ReturnType<typeof callOpencode>>;

interface AttachedTransportResult {
  readonly response: AdapterResponse | undefined;
  readonly transportFailure: string | undefined;
  readonly evidenceDraft: BatchAttemptEvidence;
  readonly outcome: BatchAttemptOutcome;
  readonly cleanup: BatchCleanupOutcome;
  readonly cleanupDetail: string | undefined;
}

/**
 * Formalize eligible claims with shared semantic grouping and bounded work.
 *
 * @param input - claims, adapter settings, shared grouping map, and test-only batch bound
 * @returns formalization output or validation errors before external work begins
 *
 * @remarks
 * Preconditions: `samplesPerClaim` and supplied controls are safe integers in
 * their domains; the production pipeline supplies a validated map. Postconditions:
 * every eligible claim becomes a candidate or claim error, no input claim is
 * mutated, and physical batches preserve semantic and input order. Expected
 * validation, adapter, filesystem, and model failures are returned as data;
 * unexpected worker failures are normalized to affected claim errors.
 */
export async function formalizeClaims(input: {
  readonly claims: readonly Claim[];
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
  readonly concurrency?: number;
  readonly logicalFileByCapability: ReadonlyMap<string, string>;
  readonly maxBatchSize?: number;
}): Promise<Result<FormalizationOutput, readonly FormalizationError[]>> {
  const logicalFileByCapability = input.logicalFileByCapability;
  const maxBatchSize = input.maxBatchSize ?? MAX_BATCH_SIZE_DEFAULT;
  const concurrency = input.concurrency ?? FORMALIZATION_CONCURRENCY_DEFAULT;
  const validationErrors = validateFormalizationControls({
    samplesPerClaim: input.samplesPerClaim,
    concurrency,
    maxBatchSize,
    logicalFileByCapability,
  });
  if (!validationErrors.ok) {
    return validationErrors;
  }

  const groups = groupFormalizationClaims(input.claims, logicalFileByCapability);
  const physicalBatches = groups.flatMap((group) => splitPhysicalBatches(group, maxBatchSize));
  if (physicalBatches.length === 0) {
    return ok({ candidates: [], findings: [], errors: [], batchAttempts: [] });
  }

  let batchResults: readonly BatchWorkResult[];
  try {
    batchResults = await mapBounded(physicalBatches, concurrency, async (batch) => {
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
      errors: physicalBatches.flatMap((batch) => batch.claims.map((indexed) => makeClaimError(indexed, message))),
      batchAttempts: [],
    });
  }

  const candidates = batchResults.flatMap((result) => result.candidates).sort(compareCandidates);
  const findings = batchResults.flatMap((result) => result.findings);
  const errors = batchResults.flatMap((result) => result.errors).sort(compareErrors);
  const batchAttempts = batchResults.flatMap((result) => result.batchAttempts);
  return ok({ candidates, findings, errors, batchAttempts });
}

/**
 * Validate formalization controls and shared map values before any effect.
 *
 * @param input - numeric controls and capability map
 * @returns `ok` or all validation failures discovered at the boundary
 *
 * @remarks
 * Preconditions: none; raw caller values are accepted. Postconditions: an
 * `ok` result proves safe integer domains and non-empty map values. Failure
 * form: readonly claim-style validation errors; no LLM or filesystem work.
 */
function validateFormalizationControls(input: {
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
 * Dispatch one physical batch to inline or attached transport.
 *
 * @param input - physical batch and adapter settings
 * @returns normalized candidates, findings, errors, and attached evidence
 *
 * @remarks
 * Preconditions: the batch is non-empty and controls were validated by the
 * outer boundary. Postcondition: every batch claim is terminal in this result.
 * Failure form: all adapter, filesystem, and thrown failures are claim-level.
 */
async function formalizePhysicalBatch(input: {
  readonly batch: PhysicalClaimBatch;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}): Promise<BatchWorkResult> {
  const firstClaim = input.batch.claims[0];
  if (firstClaim === undefined) {
    return { candidates: [], findings: [], errors: [], batchAttempts: [] };
  }
  if (input.batch.claims.length === 1) {
    return await formalizeSingleClaim(firstClaim, input.model, input.samplesPerClaim, input.timeoutMs);
  }
  return await formalizeAttachedBatch(input);
}

/**
 * Formalize one claim entirely through the inline path.
 *
 * @param indexedClaim - claim with authoritative eligible index
 * @param model - adapter model identifier
 * @param samplesPerClaim - bounded valid sample target
 * @param timeoutMs - universal adapter timeout
 * @returns one candidate or one claim error
 *
 * @remarks
 * Preconditions: indexedClaim is formalizable and samplesPerClaim >= 1.
 * Postconditions: thrown adapter failures are normalized and no error escapes.
 */
async function formalizeSingleClaim(
  indexedClaim: IndexedFormalizationClaim,
  model: string,
  samplesPerClaim: number,
  timeoutMs: number,
): Promise<BatchWorkResult> {
  const sampled = await sampleFormalizationsForClaim({
    claim: indexedClaim.claim,
    eligibleIndex: indexedClaim.eligibleIndex,
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
 * Execute an attached multi-claim first-sample attempt and its degradation path.
 *
 * @param input - physical batch and adapter settings
 * @returns terminal claim results plus one evidence entry for the attempt
 *
 * @remarks
 * The temp directory is always cleaned after creation. Outcomes are assembled
 * only after cleanup reaches a terminal state, and cleanup failure after a
 * successful response becomes a warning without discarding candidates.
 */
async function formalizeAttachedBatch(input: {
  readonly batch: PhysicalClaimBatch;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}): Promise<BatchWorkResult> {
  const context = buildBatchContextFile(input.batch.logicalFile, input.batch.claims);
  const serializedContext = serializeBatchContext(context);
  const contextSha256 = hashBatchContext(serializedContext);
  const transport = await runAttachedTransport({
    batch: input.batch,
    model: input.model,
    timeoutMs: input.timeoutMs,
    serializedContext,
    contextSha256,
  });
  const assembled = await assembleAttachedOutcome({
    batch: input.batch,
    model: input.model,
    samplesPerClaim: input.samplesPerClaim,
    timeoutMs: input.timeoutMs,
    transport,
  });
  const findings = [...assembled.findings];
  let errors = [...assembled.errors];

  if (transport.cleanupDetail !== undefined) {
    if (assembled.candidates.length > 0) {
      findings.push(buildCleanupWarning(input.batch, contextSha256, transport.cleanupDetail));
    } else {
      const detail = `temporary batch cleanup also failed: ${transport.cleanupDetail}`;
      errors = errors.map((error) => ({ ...error, message: `${error.message}; ${detail}` }));
      if (errors.length === 0) {
        errors = input.batch.claims.map((claim) => makeClaimError(claim, detail));
      }
    }
  }

  const evidence: BatchAttemptEvidence = {
    ...transport.evidenceDraft,
    outcome: assembled.outcome,
    cleanup: transport.cleanup,
  };
  return { ...assembled, findings, errors, batchAttempts: [evidence] };
}

async function runAttachedTransport(input: {
  readonly batch: PhysicalClaimBatch;
  readonly model: string;
  readonly timeoutMs: number;
  readonly serializedContext: string;
  readonly contextSha256: string;
}): Promise<AttachedTransportResult> {
  const directory = await createBatchContextDirectory();
  if (!directory.ok) {
    const evidenceDraft = buildBatchAttemptEvidence({
      batch: input.batch,
      contextSha256: input.contextSha256,
      model: input.model,
      outcome: { kind: "transport_failure", detail: "temporary batch directory creation failed" },
      cleanup: "not_attempted",
    });
    return {
      response: undefined,
      outcome: { kind: "transport_failure", detail: directory.error },
      cleanup: "not_attempted",
      transportFailure: directory.error,
      cleanupDetail: undefined,
      evidenceDraft,
    };
  }

  // Construct attempt metadata before cleanup starts. The finalized record
  // below adds the terminal cleanup classification after the finally block.
  const evidenceDraft = buildBatchAttemptEvidence({
    batch: input.batch,
    contextSha256: input.contextSha256,
    model: input.model,
    outcome: { kind: "transport_failure", detail: "attached attempt pending" },
    cleanup: "not_attempted",
  });

  let response: AdapterResponse | undefined;
  let transportFailure: string | undefined;
  let outcome: BatchAttemptOutcome | undefined;
  let cleanup: BatchCleanupOutcome = "succeeded";
  let cleanupDetail: string | undefined;
  try {
    const written = await writeBatchContextFile(directory.value, input.serializedContext);
    if (!written.ok) {
      transportFailure = written.error;
      outcome = { kind: "transport_failure", detail: written.error };
    } else {
      const result = await callAttachedAdapter({
        filePath: written.value.filePath,
        model: input.model,
        timeoutMs: input.timeoutMs,
      });
      response = result.response;
      transportFailure = result.transportFailure;
      outcome = result.outcome;
    }
  } finally {
    const cleaned = await cleanupBatchContextDirectory(directory.value);
    if (!cleaned.ok) {
      cleanup = "failed";
      cleanupDetail = cleaned.error;
    }
  }
  return {
    response,
    transportFailure,
    evidenceDraft,
    outcome: outcome ?? { kind: "transport_failure", detail: "attached attempt did not run" },
    cleanup,
    cleanupDetail,
  };
}

async function callAttachedAdapter(input: {
  readonly filePath: string;
  readonly model: string;
  readonly timeoutMs: number;
}): Promise<{
  readonly response?: AdapterResponse;
  readonly transportFailure?: string;
  readonly outcome: BatchAttemptOutcome;
}> {
  try {
    const response = await callOpencode({
      model: input.model,
      phase: "formalization",
      prompt: ATTACHED_BATCH_FORMALIZATION_PROMPT,
      retries: ADAPTER_RETRIES,
      timeoutMs: input.timeoutMs,
      files: [input.filePath],
    });
    if (response.ok) {
      return { response, outcome: { kind: "transport_failure", detail: "attached response pending validation" } };
    }
    return {
      response,
      outcome: isInfrastructureErrorKind(response.error.kind)
        ? { kind: "infrastructure_failure", errorKind: response.error.kind }
        : { kind: "model_failure", errorKind: response.error.kind },
    };
  } catch (error: unknown) {
    const detail = describeUnknownError(error, "formalization adapter threw");
    // Keep the detailed message on the claim error, but do not copy arbitrary
    // adapter text into durable evidence where it could contain claim content.
    return {
      outcome: { kind: "transport_failure", detail: "formalization adapter threw" },
      transportFailure: detail,
    };
  }
}

async function assembleAttachedOutcome(input: {
  readonly batch: PhysicalClaimBatch;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
  readonly transport: AttachedTransportResult;
}): Promise<BatchWorkResult & { readonly outcome: BatchAttemptOutcome }> {
  if (input.transport.transportFailure !== undefined) {
    return {
      candidates: [],
      findings: [],
      errors: input.batch.claims.map((claim) => makeClaimError(claim, input.transport.transportFailure!)),
      batchAttempts: [],
      outcome: input.transport.outcome,
    };
  }
  const response = input.transport.response;
  if (response === undefined) {
    return {
      candidates: [],
      findings: [],
      errors: input.batch.claims.map((claim) => makeClaimError(claim, "attached attempt did not return a response")),
      batchAttempts: [],
      outcome: input.transport.outcome,
    };
  }
  if (!response.ok) {
    return await recoverAttachedAdapterFailure(input, response.error.kind, response.error.message);
  }
  return await acceptAttachedResponse(input, response.value);
}

async function recoverAttachedAdapterFailure(input: {
  readonly batch: PhysicalClaimBatch;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}, kind: OpencodeErrorKind, message: string): Promise<BatchWorkResult & { readonly outcome: BatchAttemptOutcome }> {
  const outcome: BatchAttemptOutcome = isInfrastructureErrorKind(kind)
    ? { kind: "infrastructure_failure", errorKind: kind }
    : { kind: "model_failure", errorKind: kind };
  if (!shouldDegradeBatchError(kind, input.batch.claims.map((claim) => claim.claim))) {
    return {
      candidates: [],
      findings: [],
      errors: input.batch.claims.map((claim) => makeClaimError(claim, message)),
      batchAttempts: [],
      outcome,
    };
  }
  const fallback = await fallbackClaims(input.batch.claims, input.model, input.samplesPerClaim, input.timeoutMs);
  return { ...fallback, outcome };
}

async function acceptAttachedResponse(input: {
  readonly batch: PhysicalClaimBatch;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}, response: unknown): Promise<BatchWorkResult & { readonly outcome: BatchAttemptOutcome }> {
  const matched = matchAttachedBatchResponse(response, input.batch.claims);
  if (!matched.ok) {
    const fallback = await fallbackClaims(input.batch.claims, input.model, input.samplesPerClaim, input.timeoutMs);
    return {
      ...fallback,
      outcome: { kind: "model_failure", errorKind: "schema_validation_error" },
    };
  }

  const candidates: FormalizationCandidate[] = [];
  const findings: Finding[] = [];
  const errors: FormalizationError[] = [];
  const failedClaims: IndexedFormalizationClaim[] = [];
  for (const indexedClaim of input.batch.claims) {
    const entry = matched.value.entries.get(indexedClaim.eligibleIndex);
    if (entry === undefined || !entry.ok) {
      failedClaims.push(indexedClaim);
      if (entry !== undefined) {
        findings.push(buildBatchEntryInvalidFinding(indexedClaim.claim, entry.error));
      }
      continue;
    }
    candidates.push({
      claim: indexedClaim.claim,
      eligibleIndex: indexedClaim.eligibleIndex,
      samples: [entry.value],
      invalidSamples: [],
    });
  }
  if (failedClaims.length > 0) {
    const fallback = await fallbackClaims(failedClaims, input.model, input.samplesPerClaim, input.timeoutMs);
    candidates.push(...fallback.candidates);
    findings.push(...fallback.findings);
    errors.push(...fallback.errors);
  }
  const additional = await addAdditionalSamples(candidates, input.samplesPerClaim, input.model, input.timeoutMs);
  return {
    candidates: [...additional.candidates],
    findings: [...findings, ...additional.findings],
    errors,
    batchAttempts: [],
    outcome: failedClaims.length > 0
      ? { kind: "model_failure", errorKind: "schema_validation_error" }
      : { kind: "success" },
  };
}

interface MatchedBatchResponse {
  readonly entries: ReadonlyMap<number, Result<LogicIrClaim, string>>;
}

/**
 * Match a batch response by explicit original eligible indexes.
 *
 * @param response - untrusted adapter payload
 * @param claims - authoritative attached claim indexes
 * @returns indexed validation results or structural schema failure
 *
 * @remarks
 * Unknown, duplicate, missing, non-integer, or count-mismatched indexes reject
 * the whole mapping as `schema_validation_error`; individual Logic IR failures
 * remain per-claim results so fallback can be bounded and precise.
 */
function matchAttachedBatchResponse(
  response: unknown,
  claims: readonly IndexedFormalizationClaim[],
): Result<MatchedBatchResponse, string> {
  const entries = extractBatchPayload(response);
  const expected = new Set(claims.map((claim) => claim.eligibleIndex));
  if (entries.length !== claims.length) {
    return err(`expected ${String(claims.length)} indexed formalizations, received ${String(entries.length)}`);
  }

  const matched = new Map<number, Result<LogicIrClaim, string>>();
  for (const entry of entries) {
    const index = readBatchEntryIndex(entry);
    if (index === undefined || !expected.has(index) || matched.has(index)) {
      return err("batch formalization indexes must be unique known safe integers");
    }
    const sample = validateFormalizationSample(extractSamplePayload(entry));
    matched.set(index, sample.ok ? ok(sample.value) : err(sample.error.message));
  }

  for (const expectedIndex of expected) {
    if (!matched.has(expectedIndex)) {
      return err(`batch formalization is missing index ${String(expectedIndex)}`);
    }
  }
  return ok({ entries: matched });
}

function readBatchEntryIndex(entry: unknown): number | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const index = (entry as { readonly index?: unknown }).index;
  return typeof index === "number" && Number.isSafeInteger(index) ? index : undefined;
}

/**
 * Retry a set of claims through bounded inline formalization.
 *
 * @param claims - claims affected by a model-response or structural failure
 * @param model - adapter model identifier
 * @param samplesPerClaim - full target because no batch sample is trusted
 * @param timeoutMs - universal adapter timeout
 * @returns deterministic per-claim results
 *
 * @remarks
 * Preconditions: claims are distinct by eligible index. Postconditions: every
 * supplied claim is represented by a candidate or error; worker throws are
 * normalized locally so sibling claims continue.
 */
async function fallbackClaims(
  claims: readonly IndexedFormalizationClaim[],
  model: string,
  samplesPerClaim: number,
  timeoutMs: number,
): Promise<BatchWorkResult> {
  const results = await mapBounded(claims, INLINE_FALLBACK_CONCURRENCY, async (indexedClaim) => {
    try {
      const result = await sampleFormalizationsForClaim({
        claim: indexedClaim.claim,
        eligibleIndex: indexedClaim.eligibleIndex,
        model,
        samplesPerClaim,
        timeoutMs,
      });
      return result;
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
 * Collect additional samples and merge by eligible index, never by claim ID.
 *
 * @param candidates - candidates with at least one sample
 * @param samplesPerClaim - desired total sample count
 * @param model - adapter model identifier
 * @param timeoutMs - universal adapter timeout
 * @returns merged candidates and findings; existing candidates survive failures
 *
 * @remarks
 * Preconditions: candidates have stable eligible indexes. Postconditions:
 * duplicate or missing IDs cannot cross-merge, input claim objects are not
 * mutated, and candidate order remains eligible order.
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
    const eligibleIndex = candidate.eligibleIndex;
    if (eligibleIndex === undefined) {
      return err({ message: "candidate lacks eligible index for additional sample merge" });
    }
    try {
      return await sampleFormalizationsForClaim({
        claim: candidate.claim,
        eligibleIndex,
        model,
        samplesPerClaim: samplesPerClaim - candidate.samples.length,
        timeoutMs,
      });
    } catch (error: unknown) {
      return err({ message: describeUnknownError(error, "additional formalization sample failed") });
    }
  });

  const byIndex = new Map<number, FormalizationCandidate>();
  for (const candidate of candidates) {
    if (candidate.eligibleIndex !== undefined) {
      byIndex.set(candidate.eligibleIndex, candidate);
    }
  }
  const findings: Finding[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const original = needMore[index];
    if (result === undefined || original === undefined) {
      continue;
    }
    if (!result.ok) {
      findings.push({
        severity: "warning",
        category: "formalization.additional_sample_failed",
        provenance: original.claim.provenance,
        description: `Additional formalization samples were not completed: ${result.error.message}`,
        rationale: "The first valid sample is preserved, but an incomplete bounded sample set reduces clustering confidence.",
        evidence: [
          { kind: "claim", value: original.claim.text },
          { kind: "eligible_index", value: String(original.eligibleIndex ?? "unknown") },
        ],
        ...(original.claim.id === undefined ? {} : { relatedClaimIdentifiers: [original.claim.id] }),
      });
      continue;
    }
    const eligibleIndex = original.eligibleIndex;
    if (eligibleIndex === undefined) {
      continue;
    }
    const existing = byIndex.get(eligibleIndex);
    if (existing === undefined) {
      continue;
    }
    byIndex.set(eligibleIndex, {
      ...existing,
      samples: [...existing.samples, ...result.value.candidate.samples],
      invalidSamples: [...existing.invalidSamples, ...result.value.candidate.invalidSamples],
    });
    findings.push(...result.value.findings);
  }
  return {
    candidates: [...byIndex.values()].sort(compareCandidates),
    findings,
  };
}

/**
 * Sample one claim with a bounded retry budget.
 *
 * @param input - claim identity and adapter settings
 * @returns candidate with valid samples or a claim-level error
 *
 * @remarks
 * Preconditions: target samples >= 1. Postconditions: success has at least one
 * valid sample; loop iterations are bounded by `samplesPerClaim * 3`. Thrown
 * adapter values are caught as unknown and normalized.
 */
async function sampleFormalizationsForClaim(input: {
  readonly claim: Claim;
  readonly eligibleIndex: number;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}): Promise<Result<ClaimSampleResult, FormalizationError>> {
  const validSamples: LogicIrClaim[] = [];
  const invalidSamples: { raw: unknown; reason: string }[] = [];
  const findings: Finding[] = [];
  const maxAttempts = Math.max(1, input.samplesPerClaim * ADAPTER_RETRIES);
  let terminalFailure: string | undefined;

  for (let attempts = 1; attempts <= maxAttempts && validSamples.length < input.samplesPerClaim; attempts += 1) {
    let response;
    try {
      response = await callOpencode({
        model: input.model,
        phase: "formalization",
        prompt: buildFormalizationPrompt(input.claim),
        retries: ADAPTER_RETRIES,
        timeoutMs: input.timeoutMs,
      });
    } catch (error: unknown) {
      return err(makeClaimError(input, describeUnknownError(error, "formalization adapter threw")));
    }
    if (!response.ok) {
      if (validSamples.length > 0) {
        terminalFailure = response.error.message;
        break;
      }
      return err(makeClaimError(input, response.error.message));
    }

    const candidateSample = extractSamplePayload(response.value);
    const validated = validateFormalizationSample(candidateSample);
    if (!validated.ok) {
      invalidSamples.push({ raw: candidateSample, reason: validated.error.message });
      findings.push(buildInvalidSampleFinding(input.claim, attempts, validated.error.message));
      continue;
    }
    validSamples.push(validated.value);
  }

  if (validSamples.length === 0) {
    return err(makeClaimError(input, `all formalization samples invalid for claim ${input.claim.id ?? "<unnamed>"}`));
  }
  if (validSamples.length < input.samplesPerClaim) {
    findings.push({
      severity: "warning",
      category: "formalization.sample_shortfall",
      provenance: input.claim.provenance,
      description: terminalFailure === undefined
        ? `Only ${String(validSamples.length)} of ${String(input.samplesPerClaim)} requested formalization samples were valid`
        : `Additional formalization sampling stopped after an adapter failure: ${terminalFailure}`,
      rationale: "The bounded retry budget preserved a valid candidate but did not produce the requested sample count.",
      evidence: [
        { kind: "valid_samples", value: String(validSamples.length) },
        { kind: "requested_samples", value: String(input.samplesPerClaim) },
      ],
      ...(input.claim.id === undefined ? {} : { relatedClaimIdentifiers: [input.claim.id] }),
    });
  }
  return ok({
    candidate: {
      claim: input.claim,
      eligibleIndex: input.eligibleIndex,
      samples: validSamples,
      invalidSamples,
    },
    findings,
  });
}

/**
 * Build the single-claim inline formalization prompt.
 *
 * @param claim - untrusted claim data
 * @returns sandboxed prompt
 *
 * @remarks
 * Preconditions: claim is a claim-graph value. Postconditions: claim text is
 * fenced as data and never placed in instruction position. Failure form: none.
 */
export function buildFormalizationPrompt(claim: Claim): string {
  return [
    FORMALIZATION_INSTRUCTIONS,
    FORMALIZATION_SANDBOXING,
    `<claim id=${JSON.stringify(claim.id ?? "UNNAMED")} obligation=${JSON.stringify(claim.obligation)}>`,
    "```text",
    claim.text,
    "```",
    "</claim>",
  ].join("\n");
}

/**
 * Extract a single formalization payload from a raw adapter response.
 *
 * @param response - untrusted decoded response
 * @returns nested sample/formalization payload or original value
 *
 * @remarks
 * Pure and non-throwing. Non-object responses are passed through for validator
 * diagnostics.
 */
export function extractSamplePayload(response: unknown): unknown {
  if (typeof response !== "object" || response === null) {
    return response;
  }
  const record = response as { readonly sample?: unknown; readonly formalization?: unknown };
  if (record.sample !== undefined) {
    return record.sample;
  }
  if (record.formalization !== undefined) {
    return record.formalization;
  }
  const formalizations = (record as { readonly formalizations?: unknown }).formalizations;
  if (Array.isArray(formalizations) && formalizations.length === 1) {
    return formalizations[0];
  }
  return response;
}

/**
 * Build the legacy inline batch prompt for direct callers still using it.
 *
 * @param claims - claims to render
 * @returns sandboxed positional batch prompt
 *
 * @remarks
 * This helper is retained for source compatibility and is not used by the
 * production transport, which always uses the dedicated attached prompt.
 */
export function buildBatchFormalizationPrompt(claims: readonly Claim[]): string {
  const sections = claims.map((claim, index) => [
    `<claim index="${String(index)}" id=${JSON.stringify(claim.id ?? "UNNAMED")} obligation=${JSON.stringify(claim.obligation)}>`,
    "```text",
    claim.text,
    "```",
    "</claim>",
  ].join("\n"));
  return [FORMALIZATION_INSTRUCTIONS, FORMALIZATION_SANDBOXING, `\n## Claims (${String(claims.length)} total)\n`, ...sections].join("\n\n");
}

/**
 * Extract the formalization entries array from a batch response.
 *
 * @param response - untrusted decoded adapter response
 * @returns entries or an empty array for an unrecognized structure
 *
 * @remarks
 * Pure, bounded by the response object, and never throws.
 */
export function extractBatchPayload(response: unknown): readonly unknown[] {
  if (typeof response !== "object" || response === null) {
    return [];
  }
  const record = response as { readonly formalizations?: unknown };
  if (Array.isArray(record.formalizations)) {
    return record.formalizations;
  }
  return Array.isArray(response) ? response : [];
}

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

function buildCleanupWarning(batch: PhysicalClaimBatch, contextSha256: string, detail: string): Finding {
  const firstClaim = batch.claims[0]?.claim;
  return {
    severity: "warning",
    category: "formalization.temp_cleanup_failed",
    provenance: firstClaim?.provenance ?? { file: batch.logicalFile },
    description: `Temporary attached batch cleanup failed for ${batch.logicalFile} batch ${String(batch.ordinal)}`,
    rationale: "Successful formalization candidates are preserved, but cleanup failure requires operational attention because the ephemeral context may remain on disk.",
    evidence: [
      { kind: "batch_key", value: batch.logicalFile },
      { kind: "sub_batch_ordinal", value: String(batch.ordinal) },
      { kind: "context_sha256", value: contextSha256 },
      { kind: "cleanup_error", value: detail },
    ],
  };
}

function buildBatchEntryInvalidFinding(claim: Claim, reason: string): Finding {
  return {
    severity: "warning",
    category: "formalization.batch_entry_invalid",
    provenance: claim.provenance,
    description: `Batch entry invalid, retrying individually: ${reason}`,
    rationale: "A malformed indexed batch entry is retried individually so one model-response defect cannot lose the claim.",
    evidence: [{ kind: "claim", value: claim.text }, { kind: "reason", value: reason }],
    ...(claim.id === undefined ? {} : { relatedClaimIdentifiers: [claim.id] }),
  };
}

function isInfrastructureErrorKind(kind: OpencodeErrorKind): boolean {
  switch (kind) {
    case "spawn_error":
    case "invalid_files":
    case "invalid_timeout":
      return true;
    case "timeout":
    case "invalid_json":
    case "schema_validation_error":
    case "prompt_too_large":
      return false;
    default:
      return assertNever(kind);
  }
}

function workerFailureResult(batch: PhysicalClaimBatch, error: unknown): BatchWorkResult {
  const message = describeUnknownError(error, "formalization physical batch worker failed");
  return {
    candidates: [],
    findings: [],
    errors: batch.claims.map((claim) => makeClaimError(claim, message)),
    batchAttempts: [],
  };
}

function makeClaimError(
  claim: IndexedFormalizationClaim | { readonly claim: Claim; readonly eligibleIndex: number },
  message: string,
): FormalizationError {
  return {
    message: `failed to formalize claim ${claim.claim.id ?? "<unnamed>"}: ${message}`,
    eligibleIndex: claim.eligibleIndex,
    ...(claim.claim.id === undefined ? {} : { claimId: claim.claim.id }),
  };
}

function compareCandidates(left: FormalizationCandidate, right: FormalizationCandidate): number {
  return (left.eligibleIndex ?? Number.MAX_SAFE_INTEGER) - (right.eligibleIndex ?? Number.MAX_SAFE_INTEGER);
}

function compareErrors(left: FormalizationError, right: FormalizationError): number {
  return (left.eligibleIndex ?? Number.MAX_SAFE_INTEGER) - (right.eligibleIndex ?? Number.MAX_SAFE_INTEGER);
}

function describeUnknownError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
