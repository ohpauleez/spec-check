/**
 * SMT-LIB identifier sanitization utilities.
 *
 * This module owns the canonical solver-facing identifier encoding used for
 * claim IDs, declaration names, and assertion labels.
 */
import { toSanitizedClaimId, type SanitizedClaimId } from "../branded.js";

const ESCAPE_LEAD = "_";
const HEX_WIDTH = 6;

/**
 * Check whether a code point is an ASCII letter or digit.
 *
 * @param codePoint - Unicode code point to check.
 * @returns `true` when `codePoint` is in `[A-Za-z0-9]`.
 *
 * @remarks
 * Preconditions: none.
 * Postconditions: result is deterministic and side-effect free.
 */
function isAsciiLetterOrDigit(codePoint: number): boolean {
  return (
    (codePoint >= 65 && codePoint <= 90)
    || (codePoint >= 97 && codePoint <= 122)
    || (codePoint >= 48 && codePoint <= 57)
  );
}

/**
 * Encode one Unicode code point as an SMT-safe fixed-width escape token.
 *
 * @param codePoint - Unicode code point to encode.
 * @returns Escape token in the form `_<HEX6>` with uppercase hexadecimal digits.
 *
 * @remarks
 * Preconditions: `codePoint` is a finite integer between `0` and `0x10FFFF`.
 * Postconditions:
 * - output starts with `_` and has total length 7;
 * - output is uniquely decodable by fixed-width scanning.
 */
function encodeCodePointEscape(codePoint: number): string {
  const hex = codePoint.toString(16).toUpperCase().padStart(HEX_WIDTH, "0");
  return `${ESCAPE_LEAD}${hex}`;
}

/**
 * Sanitize raw text into a valid SMT-LIB simple symbol using an injective
 * fixed-width encoding.
 *
 * @param value - Raw identifier from untrusted or user-provided input.
 * @returns Branded sanitized identifier matching `^[A-Za-z_][A-Za-z0-9_]*$`.
 *
 * @throws {Error} If iteration encounters an undefined code point. This is an
 * internal invariant guard and should be unreachable for JavaScript strings.
 *
 * @remarks
 * Preconditions:
 * - `value` is any JavaScript UTF-16 string (including empty, astral code
 *   points, and unpaired surrogates).
 *
 * Postconditions:
 * - output is never empty;
 * - output starts with `[A-Za-z_]` and uses only `[A-Za-z0-9_]`;
 * - only ASCII letters and digits pass through unchanged;
 * - `_` is reserved as an escape lead and always escapes as `_00005F`;
 * - every non-pass-through code point escapes as `_` + six uppercase hex digits;
 * - a leading raw digit is escaped to preserve SMT simple-symbol validity;
 * - empty input maps to `_`;
 * - no Unicode normalization is applied;
 * - iteration is by Unicode code point (`for...of` + `codePointAt`), never by
 *   UTF-16 code unit (`charCodeAt`).
 *
 * Invariants:
 * - the encoding is injective and uniquely decodable;
 * - sanitized outputs for non-empty inputs never contain `__`, which preserves
 *   assertion-label separator unambiguity for `<sanitizedClaimId>__a<index>`.
 *
 * @example
 * ```ts
 * sanitizeIdentifier("REQ(1)");
 * // => "REQ_0000281_000029"
 *
 * sanitizeIdentifier("REQ_281_29");
 * // => "REQ_00005F281_00005F29"
 *
 * sanitizeIdentifier("😀");
 * // => "_01F600"
 * ```
 */
export function sanitizeIdentifier(value: string): SanitizedClaimId {
  if (value.length === 0) {
    return toSanitizedClaimId(ESCAPE_LEAD);
  }

  let output = "";
  let index = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      throw new Error("failed to read Unicode code point while sanitizing identifier");
    }

    const isLeadingCodePoint = index === 0;
    const isPassThrough = isAsciiLetterOrDigit(codePoint) && !(isLeadingCodePoint && codePoint >= 48 && codePoint <= 57);

    if (isPassThrough) {
      output += character;
    } else {
      output += encodeCodePointEscape(codePoint);
    }

    index += 1;
  }

  return toSanitizedClaimId(output);
}
