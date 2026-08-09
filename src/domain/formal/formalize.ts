/**
 * Translate requirement and scenario claims into validated Logic IR samples.
 *
 * Semantic grouping and physical batching are deterministic. Single-claim
 * batches use inline prompts; multi-claim batches use an attached JSON context.
 */
import { mapBounded } from "../../adapters/concurrency.js";
import { callOpencode, type OpencodeError } from "../../adapters/opencode.js";
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
const INLINE_FALLBACK_CONCURRENCY = 1;
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
    const outcome: BatchAttemptEvidence["outcome"] = {
      kind: "transport_failure",
      detail: prepared.error.message,
    };
    const evidenceDraft = buildBatchEvidenceDraft(evidenceMetadata, outcome);
    const cleanup = await cleanupBatchContext(created.value);
    const cleanupDetail = cleanup.state === "cleanup_failed"
      ? `; temporary batch cleanup also failed: ${cleanup.detail}`
      : "";
    return {
      candidates: [],
      findings: [],
      errors: input.batch.claims.map((claim) => makeClaimError(
        claim,
        `${prepared.error.message}${cleanupDetail}`,
      )),
      batchAttempts: [finalizeBatchEvidence(
        evidenceDraft,
        cleanup.state === "cleanup_succeeded" ? "succeeded" : "failed",
      )],
    };
  }

  let assembly: AttachedAssembly;
  let evidenceDraft: BatchAttemptEvidenceDraft;
  let cleanup: Awaited<ReturnType<typeof cleanupBatchContext>>;
  try {
    try {
      assembly = await callAndAssembleAttached(input, prepared.value);
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
    evidenceDraft = buildBatchEvidenceDraft(evidenceMetadata, assembly.outcome);
  } finally {
    cleanup = await cleanupBatchContext(prepared.value);
  }

  const findings = [...assembly.findings];
  let errors = [...assembly.errors];
  if (cleanup.state === "cleanup_failed") {
    if (assembly.candidates.length > 0) {
      findings.push(buildCleanupWarning(input.batch, preparedData.contextSha256, cleanup.detail));
    } else {
      const detail = `temporary batch cleanup also failed: ${cleanup.detail}`;
      errors = errors.length === 0
        ? input.batch.claims.map((claim) => makeClaimError(claim, detail))
        : errors.map((error) => ({ ...error, message: `${error.message}; ${detail}` }));
    }
  }

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
  const inlineFit = inlinePromptsFitOpencodeLimit(
    input.batch.claims.map((entry) => buildFormalizationPrompt(entry.claim)),
  );
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
  );
  return { ...fallback, outcome };
}

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

  const candidates: FormalizationCandidate[] = [];
  const findings: Finding[] = [];
  const failedClaims: IndexedFormalizationClaim[] = [];
  for (const indexedClaim of input.batch.claims) {
    const entry = matched.value.get(indexedClaim.index);
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

function matchAttachedBatchResponse(
  response: unknown,
  claims: readonly IndexedFormalizationClaim[],
): Result<ReadonlyMap<number, Result<LogicIrClaim, string>>, string> {
  const entries = extractBatchPayload(response);
  if (entries.length !== claims.length) {
    return err(`expected ${String(claims.length)} indexed formalizations, received ${String(entries.length)}`);
  }

  const expected = new Set(claims.map((claim) => claim.index));
  const matched = new Map<number, Result<LogicIrClaim, string>>();
  for (const entry of entries) {
    const index = readBatchEntryIndex(entry);
    if (index === undefined || !expected.has(index) || matched.has(index)) {
      return err("batch formalization indexes must be unique known safe integers");
    }
    const claim = claims.find((candidate) => candidate.index === index);
    if (claim === undefined) {
      return err("batch formalization index did not resolve to a source claim");
    }
    const sample = validateSampleForClaim(extractSamplePayload(entry), claim.claim);
    matched.set(index, sample.ok ? ok(sample.value) : err(sample.error.message));
  }
  return ok(matched);
}

function readBatchEntryIndex(entry: unknown): number | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const index = (entry as { readonly index?: unknown }).index;
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0
    ? index
    : undefined;
}

async function fallbackClaims(
  claims: readonly IndexedFormalizationClaim[],
  model: string,
  samplesPerClaim: number,
  timeoutMs: number,
): Promise<BatchResult> {
  const results = await mapBounded(claims, INLINE_FALLBACK_CONCURRENCY, async (indexedClaim) => {
    try {
      return await sampleFormalizationsForClaim({ indexedClaim, model, samplesPerClaim, timeoutMs });
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
    const indexedClaim: IndexedFormalizationClaim = {
      claim: candidate.claim,
      index: candidate.eligibleIndex,
      logicalFile: candidate.claim.provenance.file,
    };
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

async function sampleFormalizationsForClaim(input: {
  readonly indexedClaim: IndexedFormalizationClaim;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}): Promise<Result<SampleSuccess, FormalizationError>> {
  const validSamples: LogicIrClaim[] = [];
  const invalidSamples: { raw: unknown; reason: string }[] = [];
  const findings: Finding[] = [];
  const maxAttempts = Math.max(1, input.samplesPerClaim * ADAPTER_RETRIES);
  let terminalFailure: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts && validSamples.length < input.samplesPerClaim; attempt += 1) {
    let response: Result<unknown, OpencodeError>;
    try {
      response = await callOpencode({
        model: input.model,
        phase: "formalization",
        prompt: buildFormalizationPrompt(input.indexedClaim.claim),
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
 * Build the legacy inline batch prompt retained for source compatibility.
 *
 * @param claims - claims to include in input order
 * @returns deterministic inline prompt with zero-based display indexes
 *
 * @remarks
 * Production multi-claim work uses the attached context prompt instead.
 * Security postcondition: every claim is fenced as untrusted data, and every
 * run of 3+ backticks in raw claim text is escaped so it cannot close or open a
 * prompt fence. The function performs no I/O, does not mutate `claims`, and has
 * no expected failure mode.
 *
 * @example
 * ```ts
 * const prompt = buildBatchFormalizationPrompt(claims);
 * ```
 */
export function buildBatchFormalizationPrompt(claims: readonly Claim[]): string {
  const sections = claims.map((claim, index) => [
    `<claim index="${String(index)}" id=${JSON.stringify(claim.id ?? "UNNAMED")} obligation=${JSON.stringify(claim.obligation)}>`,
    "```text",
    sanitizeForCodeFence(claim.text),
    "```",
    "</claim>",
  ].join("\n"));
  return [
    FORMALIZATION_INSTRUCTIONS,
    FORMALIZATION_SANDBOXING,
    `\n## Claims (${String(claims.length)} total)\n`,
    ...sections,
  ].join("\n\n");
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

function buildBatchEvidenceDraft(
  metadata: BatchAttemptEvidenceMetadata,
  outcome: BatchAttemptEvidence["outcome"],
): BatchAttemptEvidenceDraft {
  return Object.freeze({
    ...metadata,
    outcome: Object.freeze(outcome),
  });
}

function finalizeBatchEvidence(
  draft: BatchAttemptEvidenceDraft,
  cleanup: BatchAttemptEvidence["cleanup"],
): BatchAttemptEvidence {
  return Object.freeze({ ...draft, cleanup });
}

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

function makeClaimError(claim: IndexedFormalizationClaim, message: string): FormalizationError {
  return {
    message: `failed to formalize claim ${claim.claim.id ?? "<unnamed>"}: ${message}`,
    eligibleIndex: claim.index,
    ...(claim.claim.id === undefined ? {} : { claimId: claim.claim.id }),
  };
}

function compareCandidates(left: FormalizationCandidate, right: FormalizationCandidate): number {
  return left.eligibleIndex - right.eligibleIndex;
}

function compareErrors(left: FormalizationError, right: FormalizationError): number {
  return (left.eligibleIndex ?? Number.MAX_SAFE_INTEGER) - (right.eligibleIndex ?? Number.MAX_SAFE_INTEGER);
}

function describeUnknownError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

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

function emptyBatchResult(): BatchResult {
  return { candidates: [], findings: [], errors: [], batchAttempts: [] };
}
