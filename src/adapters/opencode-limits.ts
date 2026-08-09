/**
 * Operational limits shared by the OpenCode adapter and callers that must
 * determine whether an invocation can pass adapter validation.
 *
 * @example
 * ```ts
 * import { PROMPT_ARG_MAX_BYTES } from "./opencode-limits.js";
 *
 * const fits = Buffer.byteLength(prompt, "utf8") <= PROMPT_ARG_MAX_BYTES;
 * ```
 */

/**
 * Maximum UTF-8 byte length accepted for the OpenCode instruction argument.
 *
 * @remarks
 * The value is an adapter boundary, not a character-count limit. Callers must
 * measure with UTF-8 encoding. Inputs above the limit produce an
 * `OpencodeError` with `kind: "prompt_too_large"`; inputs exactly at the limit
 * are accepted. The constant is immutable and safe to use concurrently.
 */
export const PROMPT_ARG_MAX_BYTES = 32_768;
