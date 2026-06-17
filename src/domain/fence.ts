/**
 * Sanitize content for safe embedding inside a markdown code fence.
 *
 * @param content - untrusted content to sanitize
 * @returns content with backtick runs escaped so they cannot break the surrounding fence
 *
 * @remarks
 * Postcondition: runs of 3+ backticks are escaped (each backtick replaced with `\``),
 * preventing premature closure of the surrounding code fence.
 * Invariant: content not containing 3+ consecutive backticks is returned unchanged.
 */
export function sanitizeForCodeFence(content: string): string {
  return content.replace(/`{3,}/gu, (match) => match.replace(/`/gu, "\\`"));
}
