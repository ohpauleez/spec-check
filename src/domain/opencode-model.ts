/** Pure OpenCode model policy, independent of subprocess protocol versions.
 * @example normalizeOpencodeModel("github-copilot/gpt-5.6-terra#high");
 */
import { err, ok, type Result } from "./result.js";

/** Semantic selection shared by argument encoding and attempt telemetry. */
export interface OpencodeModelSelection {
  readonly model: string;
  readonly variant?: string;
}

/** Resolve the existing fixed, case-sensitive reasoning policy.
 * @param model - Base model identifier without a variant suffix.
 * @returns Fixed variant or undefined; pure, total, and non-mutating.
 * @example variantForModel("github-copilot/gpt-5.6-terra") // "high"
 */
export function variantForModel(model: string): string | undefined {
  if (model === "github-copilot/gpt-5.6-luna") return "max";
  if (model === "github-copilot/gpt-5.6-terra") return "high";
  return undefined;
}

/** Validate model syntax and apply the fixed variant policy.
 * @param raw - Effective CLI/config or direct-call model reference.
 * @returns Immutable semantic selection or an actionable validation reason.
 * @remarks No I/O, trimming, case conversion, or catalog lookup. Valid bare
 * identifiers retain their existing permissive syntax. Explicit references
 * require provider/model#variant; additional model slashes are preserved.
 * @example normalizeOpencodeModel("acme/family/model#high");
 */
export function normalizeOpencodeModel(raw: string): Result<OpencodeModelSelection, string> {
  if (raw.trim().length === 0) return err("invalid model reference: model must not be empty");
  const separator = raw.indexOf("#");
  if (separator === -1) {
    const variant = variantForModel(raw);
    return ok(Object.freeze({ model: raw, ...(variant === undefined ? {} : { variant }) }));
  }
  if (raw.indexOf("#", separator + 1) !== -1) {
    return err("invalid model reference: only one # separator is allowed");
  }
  const model = raw.slice(0, separator);
  const variant = raw.slice(separator + 1);
  if (variant.length === 0) return err("invalid model reference: variant must not be empty");
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1 || /\s/u.test(raw)) {
    return err("invalid model reference: explicit variants require provider/model#variant without whitespace");
  }
  const fixed = variantForModel(model);
  if (fixed !== undefined && fixed !== variant) {
    return err(`model ${model} requires variant ${fixed}; received ${variant}`);
  }
  return ok(Object.freeze({ model, variant }));
}
