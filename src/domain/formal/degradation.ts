/**
 * Local adapter-error policy for attached formalization batches.
 *
 * This module deliberately returns a boolean instead of introducing a public
 * error taxonomy. Terminal adapter kinds remain the authority for behavior.
 */
import type { OpencodeErrorKind } from "../../adapters/opencode.js";
import { PROMPT_ARG_MAX_BYTES } from "../../adapters/opencode-limits.js";
import type { Claim } from "../claim-graph.js";
import { FORMALIZATION_INSTRUCTIONS, FORMALIZATION_SANDBOXING } from "../prompts/formalization.js";
import { assertNever } from "../assert.js";

/**
 * Decide whether a terminal attached-batch error may degrade inline.
 *
 * @param kind - terminal adapter failure kind after adapter retries
 * @param claims - affected claims used for the prompt-size pre-check
 * @returns true only for model-response failures or a fitting prompt-too-large fallback
 *
 * @remarks
 * Preconditions: `kind` is a closed adapter error kind and claims are the
 * physical batch claims. Postconditions: infrastructure failures never degrade;
 * prompt-too-large degrades only when every inline prompt fits in UTF-8 bytes.
 * Failure form: none; pure deterministic policy.
 */
export function shouldDegradeBatchError(kind: OpencodeErrorKind, claims: readonly Claim[]): boolean {
  switch (kind) {
    case "timeout":
    case "invalid_json":
    case "schema_validation_error":
      return true;
    case "prompt_too_large":
      return claims.every((claim) => Buffer.byteLength(buildInlinePrompt(claim), "utf8") <= PROMPT_ARG_MAX_BYTES);
    case "spawn_error":
    case "invalid_files":
    case "invalid_timeout":
      return false;
    default:
      return assertNever(kind);
  }
}

function buildInlinePrompt(claim: Claim): string {
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
