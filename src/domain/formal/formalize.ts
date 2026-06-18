import { callOpencode } from "../../adapters/opencode.js";
import { mapBounded } from "../../adapters/concurrency.js";
import type { Claim } from "../claim-graph.js";
import type { LogicIrClaim } from "../logic-ir.js";
import type { Finding } from "../findings.js";
import { err, ok, type Result } from "../result.js";
import { validateFormalizationSample } from "./validate.js";
import { FORMALIZATION_INSTRUCTIONS, FORMALIZATION_SANDBOXING, BATCH_FORMALIZATION_INSTRUCTIONS } from "../prompts/formalization.js";

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
 * Successful output from the formalization pipeline across all eligible claims.
 *
 * @remarks
 * Invariant: `candidates` preserves input claim order for successfully formalized claims.
 * Invariant: `findings` aggregates warnings from invalid sample rejections.
 * Invariant: `errors` contains failures for claims that could not be formalized.
 * Callers can inspect `errors` to decide whether partial results are acceptable.
 */
export interface FormalizationOutput {
  readonly candidates: readonly FormalizationCandidate[];
  readonly findings: readonly Finding[];
  readonly errors: readonly FormalizationError[];
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

/** Maximum concurrent LLM formalization sessions across claims. */
const FORMALIZATION_CONCURRENCY_DEFAULT = 3;

/**
 * Formalize eligible claims with batch-per-file strategy and bounded concurrency.
 *
 * @param input - Claims to formalize, model to use, and samples per claim
 * @returns All successfully formalized candidates, aggregated findings, and any errors
 *
 * @remarks
 * Strategy: claims are grouped by provenance file. Each file's claims are sent as
 * a single batch LLM call. Individual entries that fail validation are retried
 * individually with the single-claim prompt. This reduces LLM calls from
 * O(claims × samplesPerClaim) to O(files × samplesPerClaim) in the happy path.
 */
export async function formalizeClaims(input: {
  readonly claims: readonly Claim[];
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly concurrency?: number;
}): Promise<Result<FormalizationOutput, readonly FormalizationError[]>> {
  const concurrency = input.concurrency ?? FORMALIZATION_CONCURRENCY_DEFAULT;
  const eligibleClaims = input.claims.filter(
    (candidate) => candidate.kind === "requirement" || candidate.kind === "scenario",
  );

  // Group claims by provenance file for batch processing.
  const claimsByFile = new Map<string, Claim[]>();
  for (const claim of eligibleClaims) {
    const file = claim.provenance.file;
    const group = claimsByFile.get(file);
    if (group !== undefined) {
      group.push(claim);
    } else {
      claimsByFile.set(file, [claim]);
    }
  }

  // Process each file's batch with bounded concurrency across files.
  const fileGroups = [...claimsByFile.values()];
  const batchResults = await mapBounded(fileGroups, concurrency, async (fileClaims) => {
    return await formalizeBatch({
      claims: fileClaims,
      model: input.model,
      samplesPerClaim: input.samplesPerClaim,
    });
  });

  // Aggregate results across all file batches.
  const candidates: FormalizationCandidate[] = [];
  const findings: Finding[] = [];
  const errors: FormalizationError[] = [];

  for (const batchResult of batchResults) {
    candidates.push(...batchResult.candidates);
    findings.push(...batchResult.findings);
    errors.push(...batchResult.errors);
  }

  return ok({ candidates, findings, errors });
}

/**
 * Formalize a batch of claims from a single spec file.
 *
 * Strategy: attempt a single batch LLM call for all claims in the group.
 * For each entry in the batch response that fails validation, fall back to
 * individual single-claim formalization.
 *
 * @param input - claims from one file, model, and samples per claim
 * @returns aggregated candidates, findings, and errors
 */
async function formalizeBatch(input: {
  readonly claims: readonly Claim[];
  readonly model: string;
  readonly samplesPerClaim: number;
}): Promise<{ readonly candidates: readonly FormalizationCandidate[]; readonly findings: readonly Finding[]; readonly errors: readonly FormalizationError[] }> {
  const candidates: FormalizationCandidate[] = [];
  const findings: Finding[] = [];
  const errors: FormalizationError[] = [];

  // Attempt batch call.
  const prompt = buildBatchFormalizationPrompt(input.claims);
  const response = await callOpencode({
    model: input.model,
    phase: "formalization",
    prompt,
    retries: 3,
  });

  // If the entire batch call fails, fall back to individual calls for all claims.
  if (!response.ok) {
    const fallbackResults = await mapBounded(input.claims, 2, async (claim) => {
      return await sampleFormalizationsForClaim({
        claim,
        model: input.model,
        samplesPerClaim: input.samplesPerClaim,
      });
    });
    for (const result of fallbackResults) {
      if (result.ok) {
        candidates.push(result.value.candidate);
        findings.push(...result.value.findings);
      } else {
        errors.push(result.error);
      }
    }
    return { candidates, findings, errors };
  }

  // Parse batch response.
  const batchEntries = extractBatchPayload(response.value);

  // Match entries to claims by position.
  const failedClaims: Claim[] = [];
  for (let i = 0; i < input.claims.length; i++) {
    const claim = input.claims[i];
    if (claim === undefined) continue;

    const entry = batchEntries[i];
    if (entry === undefined) {
      // No corresponding entry in batch response — retry individually.
      failedClaims.push(claim);
      continue;
    }

    const validated = validateFormalizationSample(entry);
    if (!validated.ok) {
      failedClaims.push(claim);
      findings.push({
        severity: "warning",
        category: "formalization.batch_entry_invalid",
        provenance: claim.provenance,
        description: `Batch entry invalid, retrying individually: ${validated.error.message}`,
        evidence: [{ kind: "claim", value: claim.text }],
        ...(claim.id === undefined ? {} : { relatedClaimIdentifiers: [claim.id] }),
      });
      continue;
    }

    candidates.push({
      claim,
      samples: [validated.value],
      invalidSamples: [],
    });
  }

  // Retry individually for failed batch entries (need samplesPerClaim > 1 or validation failure).
  if (failedClaims.length > 0) {
    const retryResults = await mapBounded(failedClaims, 2, async (claim) => {
      return await sampleFormalizationsForClaim({
        claim,
        model: input.model,
        samplesPerClaim: input.samplesPerClaim,
      });
    });
    for (const result of retryResults) {
      if (result.ok) {
        candidates.push(result.value.candidate);
        findings.push(...result.value.findings);
      } else {
        errors.push(result.error);
      }
    }
  }

  // For claims that succeeded in batch but need additional samples (samplesPerClaim > 1),
  // collect additional samples individually.
  if (input.samplesPerClaim > 1) {
    const needMoreSamples = candidates.filter((c) => c.samples.length < input.samplesPerClaim);
    const additionalResults = await mapBounded(needMoreSamples, 2, async (candidate) => {
      const needed = input.samplesPerClaim - candidate.samples.length;
      return await sampleFormalizationsForClaim({
        claim: candidate.claim,
        model: input.model,
        samplesPerClaim: needed,
      });
    });
    for (const result of additionalResults) {
      if (result.ok) {
        // Find existing candidate and merge samples.
        const existing = candidates.find((c) => c.claim.id === result.value.candidate.claim.id);
        if (existing !== undefined) {
          const merged: FormalizationCandidate = {
            claim: existing.claim,
            samples: [...existing.samples, ...result.value.candidate.samples],
            invalidSamples: [...existing.invalidSamples, ...result.value.candidate.invalidSamples],
          };
          const idx = candidates.indexOf(existing);
          candidates[idx] = merged;
        }
        findings.push(...result.value.findings);
      }
      // Silently ignore errors for additional samples — we already have at least one.
    }
  }

  return { candidates, findings, errors };
}

/**
 * Sample multiple LLM formalizations for a single claim with retry loop.
 *
 * @param input - claim to formalize, model name, and number of valid samples needed
 * @returns candidate with valid samples and findings, or error if all attempts fail
 *
 * @remarks
 * Precondition: `input.samplesPerClaim` >= 1.
 * Postcondition: on success, `candidate.samples.length >= 1` (at least one valid sample).
 * Invariant: retry attempts are bounded to `samplesPerClaim * 3` to prevent unbounded loops.
 * Each attempt makes one LLM call; invalid responses are recorded but do not abort the loop.
 */
async function sampleFormalizationsForClaim(input: {
  readonly claim: Claim;
  readonly model: string;
  readonly samplesPerClaim: number;
}): Promise<Result<{ readonly candidate: FormalizationCandidate; readonly findings: readonly Finding[] }, FormalizationError>> {
  const validSamples: LogicIrClaim[] = [];
  const invalidSamples: { raw: unknown; reason: string }[] = [];
  const findings: Finding[] = [];

  let attempts = 0;
  const maxAttempts = Math.max(1, input.samplesPerClaim * 3);
  while (validSamples.length < input.samplesPerClaim && attempts < maxAttempts) {
    attempts += 1;
    const prompt = buildFormalizationPrompt(input.claim);
    const response = await callOpencode({
      model: input.model,
      phase: "formalization",
      prompt,
      retries: 3,
    });
    if (!response.ok) {
      return err({ message: `failed to formalize claim ${input.claim.id ?? "<unnamed>"}: ${response.error.message}` });
    }

    const candidateSample = extractSamplePayload(response.value);
    const validated = validateFormalizationSample(candidateSample);
    if (!validated.ok) {
      invalidSamples.push({ raw: candidateSample, reason: validated.error.message });
      findings.push({
        severity: "warning",
        category: "formalization.invalid_sample",
        provenance: input.claim.provenance,
        description: `Rejected invalid formalization sample: ${validated.error.message}`,
        evidence: [
          { kind: "claim", value: input.claim.text },
          { kind: "attempt", value: String(attempts) },
        ],
        ...(input.claim.id === undefined ? {} : { relatedClaimIdentifiers: [input.claim.id] }),
      });
      continue;
    }

    validSamples.push(validated.value);
  }

  if (validSamples.length === 0) {
    return err({ message: `all formalization samples invalid for claim ${input.claim.id ?? "<unnamed>"}` });
  }

  return ok({
    candidate: {
      claim: input.claim,
      samples: validSamples,
      invalidSamples,
    },
    findings,
  });
}

/**
 * Build a formalization prompt instructing the LLM to convert a claim into Logic IR JSON.
 *
 * @param claim - the claim to formalize, embedded as fenced untrusted data
 * @returns prompt string with claim text sandboxed inside XML and code fences
 *
 * @remarks
 * Precondition: `claim.text` is treated as untrusted user content.
 * Postcondition: prompt instructs strict JSON output with Logic IR schema fields.
 * Invariant: claim text is never interpreted as instructions by the prompt structure.
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
 * Extract the formalization sample payload from a raw LLM response.
 *
 * @param response - raw decoded LLM response object
 * @returns the nested `sample` or `formalization` field if present, otherwise the response itself
 *
 * @remarks
 * Precondition: `response` is untrusted and may be any JSON value.
 * Postcondition: returns the most specific nested payload for downstream validation.
 * Invariant: never throws; returns `response` as-is for non-object inputs.
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

  return response;
}

/**
 * Build a batch formalization prompt for multiple claims from a single spec file.
 *
 * @param claims - claims from one provenance file to formalize together
 * @returns prompt string with all claims sandboxed in numbered fences
 *
 * @remarks
 * Precondition: all claims share the same provenance file.
 * Postcondition: the prompt instructs the LLM to return a JSON array in claim order.
 */
export function buildBatchFormalizationPrompt(claims: readonly Claim[]): string {
  const claimSections = claims.map((claim, index) => {
    return [
      `<claim index="${String(index)}" id=${JSON.stringify(claim.id ?? "UNNAMED")} obligation=${JSON.stringify(claim.obligation)}>`,
      "```text",
      claim.text,
      "```",
      "</claim>",
    ].join("\n");
  });

  return [
    BATCH_FORMALIZATION_INSTRUCTIONS,
    FORMALIZATION_SANDBOXING,
    `\n## Claims (${String(claims.length)} total)\n`,
    ...claimSections,
  ].join("\n\n");
}

/**
 * Extract an array of formalization entries from a batch LLM response.
 *
 * @param response - raw decoded LLM response object
 * @returns array of individual entry payloads (may be shorter than expected if LLM omitted entries)
 *
 * @remarks
 * Precondition: `response` is untrusted and may be any JSON value.
 * Postcondition: returns an array; empty array if structure is unrecognized.
 */
export function extractBatchPayload(response: unknown): readonly unknown[] {
  if (typeof response !== "object" || response === null) {
    return [];
  }

  const record = response as { readonly formalizations?: unknown };
  if (Array.isArray(record.formalizations)) {
    return record.formalizations;
  }

  // Fallback: if the response is itself an array, treat it as the formalizations list.
  if (Array.isArray(response)) {
    return response;
  }

  return [];
}
