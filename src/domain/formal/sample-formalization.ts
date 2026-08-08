/**
 * Single-claim formalization sampling and prompt construction.
 *
 * Wraps the LLM call for one claim, validates returned samples, and retries up
 * to a bounded budget. The prompt builders live here because both single-claim
 * and degraded multi-claim paths need them.
 *
 * Exports: sampleFormalizationsForClaim, formalizeClaim, buildFormalizationPrompt,
 *          extractSamplePayload, buildBatchFormalizationPrompt.
 */

import { callOpencode } from "../../adapters/opencode.js";
import type { Claim } from "../claim-graph.js";
import type { Finding } from "../findings.js";
import type { LogicIrClaim } from "../logic-ir.js";
import { err, ok, type Result } from "../result.js";
import { validateFormalizationSample } from "./validate.js";
import { FORMALIZATION_INSTRUCTIONS, FORMALIZATION_SANDBOXING } from "../prompts/formalization.js";
import type { FormalizationCandidate, FormalizationError, IndexedClaim } from "./formalize.js";

/**
 * Sample multiple LLM formalizations for a single claim with a bounded retry loop.
 *
 * @param input - configuration for the single-claim sampling attempt
 * @returns `ok` with validated samples and diagnostics, or `err` with a
 *   terminal {@link FormalizationError}
 *
 * @remarks
 * Precondition: `input.samplesPerClaim >= 1`.
 * Precondition: `input.timeoutMs` is a positive safe integer.
 * Postcondition: on success, `samples.length <= input.samplesPerClaim` and every
 *   sample passed {@link validateFormalizationSample}.
 * Postcondition: invalid samples that consumed attempts are preserved with reason.
 *
 * Failure forms:
 * - Adapter returns a terminal error → `err(FormalizationError)`.
 * - Adapter throws an unexpected exception → normalized to `err(FormalizationError)`.
 * - All attempts exhausted without a valid sample → `err(FormalizationError)`.
 *
 * Bound: at most `max(1, samplesPerClaim * 3)` LLM calls.
 */
export async function sampleFormalizationsForClaim(input: {
  readonly claim: Claim;
  readonly eligibleIndex: number;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}): Promise<Result<{
  readonly candidate: IndexedClaim;
  readonly samples: readonly LogicIrClaim[];
  readonly invalidSamples: readonly { readonly raw: unknown; readonly reason: string }[];
  readonly findings: readonly Finding[];
}, FormalizationError>> {
  if (input.samplesPerClaim <= 0) {
    return err({ message: `invalid samplesPerClaim for claim ${input.claim.id ?? "<unnamed>"}` });
  }

  const validSamples: LogicIrClaim[] = [];
  const invalidSamples: { raw: unknown; reason: string }[] = [];
  const findings: Finding[] = [];

  let attempts = 0;
  const maxAttempts = Math.max(1, input.samplesPerClaim * 3);
  while (validSamples.length < input.samplesPerClaim && attempts < maxAttempts) {
    attempts += 1;
    const prompt = buildFormalizationPrompt(input.claim);
    let response: Awaited<ReturnType<typeof callOpencode>>;
    try {
      response = await callOpencode({
        model: input.model,
        phase: "formalization",
        prompt,
        retries: 3,
        timeoutMs: input.timeoutMs,
      });
    } catch (error: unknown) {
      return err({ message: `failed to formalize claim ${input.claim.id ?? "<unnamed>"}: ${normalizeThrownError(error).message}` });
    }

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
        rationale: "Repeated invalid samples consume retry budget and reduce the effective sample count available for clustering, potentially degrading confidence in the final formalization.",
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
    candidate: { claim: input.claim, eligibleIndex: input.eligibleIndex },
    samples: validSamples,
    invalidSamples,
    findings,
  });
}

/**
 * Formalize a single claim (convenience wrapper).
 *
 * @param input - claim and model to formalize
 * @returns `ok` with one validated candidate and findings, or `err`
 *
 * @remarks
 * Postcondition: on success, the candidate has exactly one sample.
 */
export async function formalizeClaim(input: {
  readonly claim: Claim;
  readonly model: string;
  readonly timeoutMs: number;
}): Promise<Result<{ readonly candidate: FormalizationCandidate; readonly findings: readonly Finding[] }, FormalizationError>> {
  const result = await sampleFormalizationsForClaim({
    claim: input.claim,
    eligibleIndex: 0,
    model: input.model,
    samplesPerClaim: 1,
    timeoutMs: input.timeoutMs,
  });

  if (!result.ok) {
    return err(result.error);
  }

  return ok({
    candidate: {
      claim: result.value.candidate.claim,
      samples: result.value.samples,
      invalidSamples: result.value.invalidSamples,
    },
    findings: result.value.findings,
  });
}

/**
 * Build a formalization prompt instructing the LLM to convert a claim into Logic IR JSON.
 *
 * @param claim - the claim to formalize
 * @returns inline prompt string with the claim text fenced
 *
 * @remarks
 * Postcondition: the prompt contains the full claim text inside a fenced code block
 *   and explicit metadata tags.
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
 * @param response - raw LLM response object
 * @returns the sample or formalization field if present, otherwise the original value
 *
 * @remarks
 * Postcondition: returns `response.sample` when defined, otherwise
 *   `response.formalization`, otherwise `response`.
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
 * Build a legacy inline prompt for multiple claims.
 *
 * @deprecated Use {@link buildAttachedBatchPrompt} for multi-claim attached batches.
 *   This helper remains exported only for existing callers and tests.
 * @param claims - claims to embed inline
 * @returns inline prompt containing all claim bodies
 *
 * @remarks
 * Postcondition: each claim appears in order with explicit index metadata.
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
    FORMALIZATION_INSTRUCTIONS,
    FORMALIZATION_SANDBOXING,
    `\n## Claims (${String(claims.length)} total)\n`,
    ...claimSections,
  ].join("\n\n");
}

/**
 * Normalize an unknown thrown value into a structured error.
 */
function normalizeThrownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
