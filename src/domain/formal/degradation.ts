/**
 * Pure policy for handling terminal attached-batch OpenCode failures.
 *
 * @remarks
 * The adapter has already exhausted its own retry budget before this policy is
 * evaluated. This module decides only whether smaller per-claim inline work can
 * be attempted; it performs no retries or I/O itself.
 *
 * @example
 * ```ts
 * const fit = inlinePromptsFitOpencodeLimit(perClaimPrompts);
 * const decision = decideBatchDegradation("prompt_too_large", fit);
 * ```
 */

import { PROMPT_ARG_MAX_BYTES } from "../../adapters/opencode-limits.js";
import type { OpencodeError } from "../../adapters/opencode.js";
import { assertNever } from "../assert.js";

/** Terminal error discriminant returned by the OpenCode adapter. */
export type OpencodeErrorKind = OpencodeError["kind"];

/**
 * Exhaustive action selected for every claim in a failed physical batch.
 *
 * @remarks
 * `degrade_to_per_claim` permits bounded inline retries. `emit_claim_errors`
 * prohibits fallback because it cannot address the failure or cannot fit.
 */
export type BatchDegradationDecision =
  | { readonly kind: "degrade_to_per_claim" }
  | { readonly kind: "emit_claim_errors" };

/**
 * Check whether every inline fallback prompt satisfies the adapter byte limit.
 *
 * @param prompts - complete per-claim inline prompts, including templates and claim text
 * @returns `true` only when each UTF-8 byte length is at most the adapter limit
 *
 * @remarks
 * Empty input returns `true` by universal quantification; callers making a
 * physical-batch decision must provide one prompt per claim. The loop is bounded
 * by `prompts.length`, allocates no prompt copies, and has no failure forms.
 * Inputs are borrowed and never mutated.
 *
 * @example
 * ```ts
 * const allFit = inlinePromptsFitOpencodeLimit([firstPrompt, secondPrompt]);
 * ```
 */
export function inlinePromptsFitOpencodeLimit(prompts: readonly string[]): boolean {
  for (const prompt of prompts) {
    if (Buffer.byteLength(prompt, "utf8") > PROMPT_ARG_MAX_BYTES) {
      return false;
    }
  }
  return true;
}

/**
 * Select terminal handling for a failed multi-claim attached invocation.
 *
 * @param errorKind - terminal adapter failure after adapter-internal retries
 * @param allInlinePromptsFit - whether every complete per-claim prompt fits the shared byte limit
 * @returns an exhaustive degrade-to-inline or immediate-claim-errors decision
 *
 * @remarks
 * Preconditions: `allInlinePromptsFit` must be computed over every claim in the
 * physical batch, preferably with {@link inlinePromptsFitOpencodeLimit}. The fit
 * value affects only `prompt_too_large`; response failures always degrade and
 * infrastructure/configuration failures never do. The function is pure,
 * deterministic, total over `OpencodeErrorKind`, and safe for concurrent use.
 *
 * @example
 * ```ts
 * const decision = decideBatchDegradation("timeout", true);
 * // decision.kind === "degrade_to_per_claim"
 * ```
 */
export function decideBatchDegradation(
  errorKind: OpencodeErrorKind,
  allInlinePromptsFit: boolean,
): BatchDegradationDecision {
  switch (errorKind) {
    case "timeout":
    case "invalid_json":
    case "schema_validation_error":
      return { kind: "degrade_to_per_claim" };
    case "prompt_too_large":
      return allInlinePromptsFit
        ? { kind: "degrade_to_per_claim" }
        : { kind: "emit_claim_errors" };
    case "spawn_error":
    case "invalid_files":
    case "invalid_timeout":
      return { kind: "emit_claim_errors" };
    default:
      return assertNever(errorKind);
  }
}
