export const TRACE_SPEC_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]+(?:-[A-Z0-9]{2,})+$/;

const BRACKETED_IDENTIFIER_PATTERN = /\[([A-Z][A-Z0-9]+(?:-[A-Z0-9]{2,})+)\]/g;
const HEADING_PATTERN = /^#{1,6}\s+((?:Requirement|Scenario):\s+.+)$/;

/**
 * Provenance for one canonical identifier discovered in OpenSpec markdown.
 *
 * @remarks
 * Preconditions: `file` is the scanned markdown file and `line` is a 1-based
 * line number within that file.
 * Postconditions: `identifier` is always the bare token form without brackets.
 * Invariant: `heading` is the nearest Requirement or Scenario heading, with any
 * bracketed identifier token removed from the stored text.
 */
export interface ScannedIdentifier {
  readonly identifier: string;
  readonly file: string;
  readonly line: number;
  readonly heading?: string;
}

/**
 * Scan one canonical spec markdown document for bracketed identifiers.
 *
 * @param file - absolute or test-local path used for provenance
 * @param markdown - markdown source to scan
 * @returns discovered identifiers in source order with provenance
 *
 * @remarks
 * Preconditions: `markdown` is treated as untrusted text and is never executed.
 * Postconditions: returned identifiers exclude inline-code and fenced-code
 * regions, and every identifier is in bare token form.
 * Invariant: heading provenance is the nearest Requirement or Scenario heading
 * seen before the identifier on a non-code line.
 */
export function scanSpecMarkdown(file: string, markdown: string): readonly ScannedIdentifier[] {
  const lines = markdown.split(/\r?\n/u);
  const identifiers: ScannedIdentifier[] = [];
  let activeFence: { readonly marker: "`" | "~"; readonly length: number } | undefined;
  let currentHeading: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index] ?? "";
    const trimmedStart = line.trimStart();

    if (activeFence !== undefined) {
      if (isFenceBoundary(trimmedStart, activeFence.marker, activeFence.length)) {
        activeFence = undefined;
      }
      continue;
    }

    const openingFence = readFenceBoundary(trimmedStart);
    if (openingFence !== undefined) {
      activeFence = openingFence;
      continue;
    }

    const nextHeading = parseHeading(trimmedStart);
    if (nextHeading !== undefined) {
      currentHeading = nextHeading;
    }

    const visibleText = stripInlineCode(line);
    for (const match of visibleText.matchAll(BRACKETED_IDENTIFIER_PATTERN)) {
      const identifier = match[1];
      if (identifier === undefined) {
        continue;
      }
      identifiers.push({
        identifier,
        file,
        line: lineNumber,
        ...(currentHeading === undefined ? {} : { heading: currentHeading }),
      });
    }
  }

  return identifiers;
}

/**
 * Parse Requirement or Scenario headings into human-readable provenance text.
 *
 * @param line - left-trimmed markdown line
 * @returns sanitized heading text when the line defines a tracked heading
 *
 * @remarks
 * Preconditions: `line` is outside fenced code.
 * Postconditions: bracketed identifiers are removed from the returned heading.
 * Invariant: only Requirement and Scenario headings contribute provenance.
 */
function parseHeading(line: string): string | undefined {
  const match = line.match(HEADING_PATTERN);
  if (match === null) {
    return undefined;
  }

  const rawHeading = match[1];
  if (rawHeading === undefined) {
    return undefined;
  }

  const heading = rawHeading
    .replace(BRACKETED_IDENTIFIER_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();

  return heading.length > 0 ? heading : undefined;
}

/**
 * Detect a fenced-code boundary marker.
 *
 * @param line - left-trimmed markdown line
 * @returns fence marker and minimum closing length when present
 *
 * @remarks
 * Preconditions: `line` is outside inline code analysis.
 * Postconditions: only triple-backtick and triple-tilde style fences open.
 * Invariant: the returned marker is later used to require a matching close.
 */
function readFenceBoundary(
  line: string,
): { readonly marker: "`" | "~"; readonly length: number } | undefined {
  const match = line.match(/^(`{3,}|~{3,})/u);
  if (match === null) {
    return undefined;
  }

  const token = match[1];
  if (token === undefined) {
    return undefined;
  }
  const marker = token.startsWith("`") ? "`" : "~";
  return { marker, length: token.length };
}

/**
 * Check whether a line closes the active fenced-code block.
 *
 * @param line - left-trimmed markdown line
 * @param marker - active fence character
 * @param minimumLength - fence length required to close the block
 * @returns true when the line closes the active fence
 *
 * @remarks
 * Preconditions: `marker` and `minimumLength` came from an earlier open fence.
 * Postconditions: a close is accepted only when it uses the same marker and a
 * length at least as large as the opening fence.
 */
function isFenceBoundary(line: string, marker: "`" | "~", minimumLength: number): boolean {
  const pattern = new RegExp(`^${escapeForRegExp(marker)}{${String(minimumLength)},}`, "u");
  return pattern.test(line);
}

/**
 * Remove inline code spans so identifier extraction only sees visible prose.
 *
 * @param line - raw markdown line outside fenced code
 * @returns the same line with inline-code spans removed
 *
 * @remarks
 * Preconditions: fenced-code handling has already excluded code blocks.
 * Postconditions: text inside matched backtick-delimited spans is absent from
 * the returned line.
 * Invariant: unmatched trailing backticks suppress the rest of the line.
 */
function stripInlineCode(line: string): string {
  let result = "";
  let index = 0;
  let activeDelimiterLength: number | undefined;

  while (index < line.length) {
    const runLength = countBackticks(line, index);
    if (runLength > 0) {
      if (activeDelimiterLength === undefined) {
        activeDelimiterLength = runLength;
      } else if (activeDelimiterLength === runLength) {
        activeDelimiterLength = undefined;
      }
      index += runLength;
      continue;
    }

    if (activeDelimiterLength === undefined) {
      result += line[index];
    }
    index += 1;
  }

  return result;
}

/**
 * Count a contiguous run of backticks at the given position.
 *
 * @param line - markdown line being scanned
 * @param startIndex - current scan position
 * @returns number of contiguous backticks starting at `startIndex`
 */
function countBackticks(line: string, startIndex: number): number {
  let index = startIndex;
  while (line[index] === "`") {
    index += 1;
  }
  return index - startIndex;
}

/**
 * Escape a single-character fence marker for a regular expression.
 *
 * @param value - regular-expression literal fragment
 * @returns escaped fragment safe for interpolation into `RegExp`
 */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
