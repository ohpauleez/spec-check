import type { LineProvenance, ParsedSection, UnparsedLine } from "../model.js";

/** Regex matching ATX-style markdown headings (levels 1–6) with captured level and text groups. */
export const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/u;

/** Regex matching canonical bracketed identifiers of the form `[PREFIX-SEGMENT-...]`. */
export const CANONICAL_IDENTIFIER_PATTERN = /^\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]$/u;

/**
 * Parse markdown headings with level and text.
 *
 * @param line - markdown line
 * @returns parsed heading when the line is a heading
 */
export function parseHeading(line: string): { readonly level: number; readonly text: string } | undefined {
  const match = line.match(HEADING_PATTERN);
  if (match === null) {
    return undefined;
  }

  return {
    level: (match[1] ?? "").length,
    text: (match[2] ?? "").trim(),
  };
}

/**
 * Validate canonical bracketed identifier format.
 *
 * @param token - bracketed identifier token
 * @returns bare canonical identifier when valid
 */
export function parseCanonicalIdentifier(token: string): string | undefined {
  const match = token.match(CANONICAL_IDENTIFIER_PATTERN);
  return match === null ? undefined : match[1] ?? undefined;
}

/**
 * Build markdown sections from heading boundaries.
 *
 * @param file - source file path
 * @param lines - full document lines
 * @param minLevel - minimum heading level to include
 * @returns parsed sections with line ranges
 */
export function extractSections(file: string, lines: readonly string[], minLevel: number): readonly ParsedSection[] {
  const sections: ParsedSection[] = [];

  let activeHeading: { readonly text: string; readonly startLine: number } | undefined;
  let activeLines: string[] = [];

  const closeActive = (lineBefore: number): void => {
    if (activeHeading === undefined) {
      return;
    }

    sections.push({
      heading: activeHeading.text,
      startLine: activeHeading.startLine,
      endLine: Math.max(activeHeading.startLine, lineBefore),
      lines: activeLines,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNo = index + 1;
    const heading = parseHeading(line);
    if (heading !== undefined && heading.level >= minLevel) {
      closeActive(lineNo - 1);
      activeHeading = { text: heading.text, startLine: lineNo };
      activeLines = [];
      continue;
    }

    if (activeHeading !== undefined) {
      activeLines.push(line);
    }
  }

  closeActive(lines.length);
  return sections;
}

/**
 * Convert unmatched lines to provenance-rich records.
 *
 * @param file - source file path
 * @param lines - full document lines
 * @param matchedLineNumbers - line numbers consumed by parser logic
 * @returns preserved unparsed lines for evidence
 */
export function collectUnparsedLines(
  file: string,
  lines: readonly string[],
  matchedLineNumbers: ReadonlySet<number>,
): readonly UnparsedLine[] {
  const unparsed: UnparsedLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    if (matchedLineNumbers.has(lineNo)) {
      continue;
    }

    const text = (lines[index] ?? "").trimEnd();
    if (text.length === 0) {
      continue;
    }

    unparsed.push({
      text,
      provenance: toProvenance(file, lineNo),
    });
  }

  return unparsed;
}

/**
 * Construct a provenance record tying a parsed element to its source location.
 *
 * @param file - absolute or workspace-relative file path
 * @param line - 1-indexed line number within the file
 * @returns immutable provenance record
 *
 * @remarks
 * Precondition: `line` is a positive integer (1-indexed).
 * Postcondition: returned object is a fresh value with no shared references.
 */
export function toProvenance(file: string, line: number): LineProvenance {
  return { file, line };
}
