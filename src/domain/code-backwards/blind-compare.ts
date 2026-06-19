/**
 * Performs identity-free semantic comparison between spec claims and code-derived
 * claims using an LLM, without relying on formal identifiers or structure.
 *
 * Provides a complementary soft-match signal alongside formal cross-implication.
 * Exports: runBlindComparison, BlindCompareOutput.
 */
import { callOpencode } from "../../adapters/opencode.js";
import type { Finding } from "../findings.js";
import type { CrossImplicationResult } from "./cross-implication.js";
import { sanitizeForCodeFence } from "../fence.js";
import { BLIND_COMPARE_INSTRUCTIONS } from "../prompts/blind-compare.js";

/**
 * Output from the blind comparison pass, containing rationale findings for each classification.
 *
 * @remarks
 * Invariant: `findings` contains one entry per input result: either a rationale finding
 * or an error finding if the LLM call failed or context was missing.
 */
export interface BlindComparisonOutput {
  readonly findings: readonly Finding[];
}

/**
 * Attach blind-comparison explanatory rationale to cross-side classifications.
 *
 * @param input - model, cross-implication results, and generated-side context
 * @returns findings with rationale for each cross-side classification
 *
 * @remarks
 * Precondition: `input.results` and `input.generatedOnlyContext` are aligned
 * by capability and claimId.
 * Postcondition: each result has a corresponding finding with rationale.
 * LLM call failures produce error-severity findings rather than aborting
 * the pipeline, preserving partial results.
 * Invariant: no original requirement text is ever exposed to the LLM.
 * Failure modes: does not throw. LLM call failures and missing context are
 * captured as error-severity findings in the output.
 * Safety: performs network I/O (LLM calls) sequentially per result. No shared
 * mutable state.
 *
 * @example
 * ```ts
 * const { findings } = await runBlindComparison({
 *   model: "anthropic:claude-sonnet-4-20250514",
 *   results: crossImplicationResults,
 *   generatedOnlyContext: [
 *     { capability: "auth", claimId: "AUTH-001", summary: "Session expires after inactivity" },
 *   ],
 * });
 * ```
 */
export async function runBlindComparison(input: {
  readonly model: string;
  readonly results: readonly CrossImplicationResult[];
  readonly generatedOnlyContext: readonly { readonly capability: string; readonly claimId: string; readonly summary: string }[];
}): Promise<BlindComparisonOutput> {
  const findings: Finding[] = [];

  for (const result of input.results) {
    const context = input.generatedOnlyContext.find(
      (entry) => entry.capability === result.capability && entry.claimId === result.claimId,
    );
    if (context === undefined) {
      findings.push({
        severity: "error",
        category: "code_backwards.blind_boundary_violation",
        provenance: { file: "<blind-compare>", heading: result.claimId },
        description: "Blind comparison context missing for claim",
        rationale: "Without the generated-only context for a claim, the blind comparison cannot proceed — the code-derived formalization has no spec-derived counterpart to compare against, breaking the identity-free matching guarantee.",
        evidence: [{ kind: "claim_id", value: result.claimId }],
        relatedClaimIdentifiers: [result.claimId],
      });
      continue;
    }

    const prompt = buildBlindPrompt(result, context.summary);
    const response = await callOpencode({
      model: input.model,
      phase: "blind-comparison",
      prompt,
      retries: 3,
    });

    // Graceful degradation: record LLM failure as a finding rather than aborting.
    if (!response.ok) {
      findings.push({
        severity: "error",
        category: "code_backwards.blind_comparison_failure",
        provenance: { file: "<blind-compare>", heading: result.claimId },
        description: `Blind comparison failed for ${result.claimId}: ${response.error.message}`,
        rationale: "A failed LLM call means no independent semantic comparison was produced for this claim, so we cannot confirm or deny alignment between the code-derived and spec-derived formalizations.",
        evidence: [{ kind: "claim_id", value: result.claimId }],
        relatedClaimIdentifiers: [result.claimId],
      });
      continue;
    }

    const rationale = extractRationale(response.value);
    findings.push({
      severity: result.classification === "uncertain" ? "warning" : "info",
      category: "code_backwards.blind_explanation",
      provenance: { file: "<blind-compare>", heading: result.claimId },
      description: `Blind comparison rationale for ${result.claimId}`,
      rationale: "Records the independent semantic comparison result so downstream consumers can assess whether the code-derived formalization aligns with the spec-derived one without relying on identifier matching.",
      evidence: [
        { kind: "classification", value: result.classification },
        { kind: "rationale", value: rationale },
      ],
      relatedClaimIdentifiers: [result.claimId],
    });
  }

  return { findings };
}

/**
 * Build a blind comparison prompt using only generated-side context and classification.
 *
 * @param result - cross-implication result to explain
 * @param generatedSummary - generated-side summary text (never original requirement text)
 * @returns prompt instructing the LLM to explain the classification without access to originals
 *
 * @remarks
 * Precondition: `generatedSummary` contains no original requirement text (blind boundary).
 * Postcondition: prompt explicitly forbids inference of original requirement content.
 * Invariant: returned prompt always requests JSON with a `rationale` field.
 * Failure modes: none — pure computation.
 */
export function buildBlindPrompt(result: CrossImplicationResult, generatedSummary: string): string {
  return [
    BLIND_COMPARE_INSTRUCTIONS,
    `Classification: ${result.classification}`,
    "Generated-side context:",
    "```text",
    sanitizeForCodeFence(generatedSummary),
    "```",
  ].join("\n");
}

/**
 * Extract the rationale string from an LLM response payload.
 *
 * @param payload - raw decoded LLM response object
 * @returns rationale string from `rationale` or `explanation` field, or a default fallback
 *
 * @remarks
 * Precondition: `payload` is untrusted and may be any JSON value.
 * Postcondition: always returns a non-empty string (falls back to "No rationale provided").
 * Invariant: never throws for any input shape.
 * Failure modes: none — pure computation, cannot fail.
 */
export function extractRationale(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "No rationale provided";
  }
  const record = payload as { readonly rationale?: unknown; readonly explanation?: unknown };
  if (typeof record.rationale === "string" && record.rationale.length > 0) {
    return record.rationale;
  }
  if (typeof record.explanation === "string" && record.explanation.length > 0) {
    return record.explanation;
  }
  return "No rationale provided";
}
