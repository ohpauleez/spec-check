/**
 * Translates natural-language specification claims into SMT-LIB formalizations
 * by prompting an LLM and validating the structured output.
 *
 * Core transformation step in the formal verification pipeline.
 * Exports: formalizeClaims, formalizeClaim.
 */
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
 *
 * @example
 * ```ts
 * const candidate: FormalizationCandidate = {
 *   claim: { kind: "requirement", text: "SHALL timeout", obligation: "mandatory",
 *     provenance: { file: "specs/auth.md" }, references: [] },
 *   samples: [validLogicIrClaim],
 *   invalidSamples: [{ raw: { malformed: true }, reason: "missing assertions field" }],
 * };
 * ```
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

/**
 * Maximum concurrent LLM formalization sessions across claims.
 *
 * @remarks
 * **Value:** 3 concurrent file-batch LLM sessions.
 *
 * **Rationale:** LLM API rate limits and cost are the binding constraints. At 3
 * concurrent sessions the pipeline keeps the model busy without triggering
 * per-minute rate limit rejections on most providers (typical burst limit is
 * 5–10 RPM for large-context calls). Lower values under-utilize available
 * throughput; higher values risk 429 errors and wasted retry budget.
 *
 * **Exceeded behavior:** This is a default — callers may override via the
 * `concurrency` parameter. If overridden higher, expect increased rate-limit
 * pressure and potential retry storms.
 */
const FORMALIZATION_CONCURRENCY_DEFAULT = 3;

/**
 * Formalize eligible claims into Logic IR using a batch-per-file strategy with bounded concurrency.
 *
 * @param input - Configuration object for the formalization pipeline.
 * @param input.claims - All claims to consider; only `"requirement"` and `"scenario"` kinds are processed.
 * @param input.model - LLM model identifier passed to the adapter for each formalization call.
 * @param input.samplesPerClaim - Number of independent valid Logic IR samples to collect per claim.
 * @param input.concurrency - Maximum concurrent file-batch LLM sessions (defaults to 3).
 *
 * @returns On success (`ok`): a {@link FormalizationOutput} containing:
 *   - `candidates` — successfully formalized claims with their valid Logic IR samples (preserves input order).
 *   - `findings` — warnings from rejected samples or batch entry validation failures.
 *   - `errors` — per-claim errors for claims that could not be formalized after all retries.
 *   The current implementation always returns `ok` with partial results; total failures are
 *   captured in `output.errors` rather than short-circuiting the pipeline.
 *
 *   On error (`err`): a readonly array of {@link FormalizationError} describing claims that
 *   failed entirely. Reserved for future use where catastrophic failure aborts the pipeline.
 *
 * @throws Propagates unhandled errors from the concurrency adapter (`mapBounded`) or the
 *   LLM transport layer if they throw outside of the handled retry/fallback paths (e.g.,
 *   network socket destruction, AbortSignal). Callers should wrap in try/catch for resilience.
 *
 * @remarks
 * Precondition: `input.claims` may be empty (produces empty output).
 * Precondition: `input.samplesPerClaim` >= 1.
 * Postcondition: every entry in `candidates` has at least one structurally valid Logic IR sample.
 * Postcondition: `candidates.length + errors.length <= eligibleClaims.length`.
 *
 * **Concurrency** (value: 3 file-batch sessions, unit: parallel LLM API calls):
 * File batches are processed with at most `concurrency` (default 3) parallel LLM
 * sessions. Within a batch, individual retries are capped at concurrency 2 (to
 * respect rate limits while still making progress on failed entries). The function
 * is safe to call concurrently from multiple callers — no shared mutable state.
 *
 * **Retry count** (value: 3, unit: LLM transport-level retries per call):
 * Each `callOpencode` invocation retries up to 3 times on transient failures
 * (network errors, 5xx responses). This bounds worst-case latency per call to
 * ~4× the single-call timeout while recovering from intermittent provider issues.
 *
 * **Sample count per claim** (value: caller-specified `samplesPerClaim`, typically 3):
 * Multiple independent formalizations are collected per claim so downstream
 * clustering can detect instability. The attempt cap per claim is bounded to
 * `samplesPerClaim × 3` maximum LLM calls to prevent unbounded retry loops when
 * the model consistently produces invalid output.
 *
 * **Batch size** (value: one batch per provenance file, unbounded claim count):
 * Claims are grouped by provenance file. Each file group is sent as a single
 * batch LLM call. This reduces LLM calls from O(claims × samplesPerClaim) to
 * O(files × samplesPerClaim) in the happy path. Individual entries that fail
 * validation are retried individually with the single-claim prompt (up to
 * `samplesPerClaim × 3` attempts per claim). If the entire batch call fails,
 * all claims in that batch fall back to individual formalization.
 *
 * @example
 * ```ts
 * const result = await formalizeClaims({
 *   claims: parsedClaims,
 *   model: "anthropic:claude-sonnet-4-20250514",
 *   samplesPerClaim: 3,
 *   concurrency: 5,
 * });
 * if (result.ok) {
 *   console.log(`Formalized ${result.value.candidates.length} claims`);
 *   console.log(`Errors: ${result.value.errors.length}`);
 *   for (const finding of result.value.findings) {
 *     console.warn(finding.description);
 *   }
 * }
 * ```
 */
export async function formalizeClaims(input: {
  readonly claims: readonly Claim[];
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
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
      timeoutMs: input.timeoutMs,
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
 * @param input.claims - claims from a single provenance file to formalize together
 * @param input.model - LLM model identifier for formalization calls
 * @param input.samplesPerClaim - number of valid Logic IR samples to collect per claim
 * @returns aggregated candidates, findings, and errors across batch and retry phases
 *
 * @remarks
 * Precondition: `input.claims` is non-empty (caller groups by file and only invokes for non-empty groups).
 * Precondition: `input.samplesPerClaim` >= 1.
 * Postcondition: every input claim appears in exactly one of: `candidates`, `errors`, or was
 * merged into an existing candidate during the additional-samples phase.
 *
 * Failure modes:
 * - Propagates unhandled errors from `callOpencode` or `mapBounded` if they throw outside
 *   of the retry/fallback paths (network socket destruction, AbortSignal).
 * - Individual claim failures are captured in `errors`; the function does not throw for
 *   per-claim LLM failures.
 */
async function formalizeBatch(input: {
  readonly claims: readonly Claim[];
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
}): Promise<{ readonly candidates: readonly FormalizationCandidate[]; readonly findings: readonly Finding[]; readonly errors: readonly FormalizationError[] }> {
  const candidates: FormalizationCandidate[] = [];
  const findings: Finding[] = [];
  const errors: FormalizationError[] = [];

  // ─── Phase 1: Batch attempt ───────────────────────────────────────────────────
  // Goal: formalize all claims in a single LLM call to amortize latency and cost.
  // A batch call is O(1) in network round-trips regardless of claim count, making
  // it strictly cheaper than per-claim calls when the model cooperates.
  const prompt = buildBatchFormalizationPrompt(input.claims);
  const response = await callOpencode({
    model: input.model,
    phase: "formalization",
    prompt,
    retries: 3,
    timeoutMs: input.timeoutMs,
  });
  // Invariant on success: `response.value` contains one entry per input claim
  // (positional correspondence). Validation of individual entries happens below.

  // If the entire batch call fails (network error, rate limit exhaustion after
  // retries, or unparseable top-level response), no partial results are salvageable.
  // Falling back to individual calls is safe because the batch failure is
  // independent of any single claim's content — the model simply did not respond.
  if (!response.ok) {
    const fallbackResults = await mapBounded(input.claims, 2, async (claim) => {
      return await sampleFormalizationsForClaim({
        claim,
        model: input.model,
        samplesPerClaim: input.samplesPerClaim,
        timeoutMs: input.timeoutMs,
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

  // Parse the batch response into positionally-indexed entries. Each entry
  // corresponds to the claim at the same index in the input array.
  const batchEntries = extractBatchPayload(response.value);

  // Match entries to claims by position. Claims whose batch entry is missing or
  // invalid are collected for individual retry. This preserves the invariant that
  // every input claim is either resolved to a candidate or queued for retry.
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
        rationale: "A batch entry that fails validation suggests the model produced malformed output for this claim; individual retry may succeed but the instability signals a fragile formalization.",
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

  // ─── Phase 2: Individual retry for failed batch entries ─────────────────────
  // Goal: recover claims that the batch call could not produce valid output for.
  // Per-claim retries are safe because each call is independent and bounded by
  // sampleFormalizationsForClaim's internal attempt cap (samplesPerClaim * 3).
  // Concurrency is capped at 2 to respect rate limits while still making progress.
  if (failedClaims.length > 0) {
    const retryResults = await mapBounded(failedClaims, 2, async (claim) => {
      return await sampleFormalizationsForClaim({
        claim,
        model: input.model,
        samplesPerClaim: input.samplesPerClaim,
        timeoutMs: input.timeoutMs,
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

  // ─── Phase 3: Additional samples for clustering ────────────────────────────
  // Goal: gather multiple independent formalizations per claim so downstream
  // clustering can detect instability (divergent interpretations of the same
  // natural-language claim). The batch call only yields one sample per claim;
  // additional samples must be collected individually.
  // The attempt cap per claim is bounded by sampleFormalizationsForClaim
  // (samplesPerClaim * 3 max attempts), preventing runaway retries.
  if (input.samplesPerClaim > 1) {
    const needMoreSamples = candidates.filter((c) => c.samples.length < input.samplesPerClaim);
    // Each candidate already holds at least one valid sample from Phase 1 or 2,
    // so failures here are non-fatal — we degrade gracefully to fewer samples
    // rather than losing the claim entirely.
    const additionalResults = await mapBounded(needMoreSamples, 2, async (candidate) => {
      const needed = input.samplesPerClaim - candidate.samples.length;
      return await sampleFormalizationsForClaim({
        claim: candidate.claim,
        model: input.model,
        samplesPerClaim: needed,
        timeoutMs: input.timeoutMs,
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
 *
 * Failure modes:
 * - Returns `err` if the LLM transport layer fails on the first call (no valid samples collected).
 * - Returns `err` if all attempts produce invalid formalizations (exhausted retry budget).
 * - Propagates unhandled errors from `callOpencode` if it throws outside retry paths.
 */
async function sampleFormalizationsForClaim(input: {
  readonly claim: Claim;
  readonly model: string;
  readonly samplesPerClaim: number;
  readonly timeoutMs: number;
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
      timeoutMs: input.timeoutMs,
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
 * Failure modes: none — pure computation.
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
 * Failure modes: none — pure computation.
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
 * Failure modes: none — pure computation.
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
 * Failure modes: none — pure computation.
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
