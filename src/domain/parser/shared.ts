/**
 * Shared parsing utilities used across all document parsers.
 * Provides heading detection, section extraction, identifier parsing, and provenance tracking.
 *
 * Role: Foundation layer for the parser module — all specific parsers depend on these helpers.
 *
 * Key exports: `parseHeading`, `extractSections`, `parseCanonicalIdentifier`,
 * `collectUnparsedLines`, `toProvenance`, `HEADING_PATTERN`
 */
import type { LineProvenance, ParsedSection, UnparsedLine } from "../model.js";

/** Regex matching ATX-style markdown headings (levels 1–6) with captured level and text groups. */
export const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/u;

/** Regex matching canonical bracketed identifiers of the form `[PREFIX-SEGMENT-...]`. */
export const CANONICAL_IDENTIFIER_PATTERN = /^\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]$/u;

/**
 * Parse a markdown line to extract ATX-style heading level and text.
 *
 * @param line - a single line of markdown text to inspect
 * @returns an object with `level` (1–6) and trimmed `text` if the line is a valid ATX heading,
 *   or `undefined` if the line is not a heading
 *
 * @remarks
 * Preconditions: none — any string is accepted.
 * Postconditions: when defined, `level` is in [1, 6] and `text` is the trimmed heading content.
 * Failure modes: none — pure computation.
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
 * Validate and extract a canonical bracketed identifier of the form `[PREFIX-SEGMENT-...]`.
 *
 * @param token - bracketed string to validate (e.g. `"[REQ-AUTH-01]"`)
 * @returns the bare identifier string (without brackets) if valid, or `undefined` if malformed
 *
 * @remarks
 * Preconditions: none — any string is accepted.
 * Postconditions: when defined, the returned string matches `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`.
 * Failure modes: none — pure computation.
 */
export function parseCanonicalIdentifier(token: string): string | undefined {
  const match = token.match(CANONICAL_IDENTIFIER_PATTERN);
  return match === null ? undefined : match[1] ?? undefined;
}

/**
 * Build structured sections from a markdown document by splitting at heading boundaries.
 *
 * @param file - source file path for provenance tracking (not read; already split into lines)
 * @param lines - full document content split into lines
 * @param minLevel - minimum ATX heading level (1–6) to treat as a section boundary
 * @returns ordered array of parsed sections, each with heading text, line range, and body lines
 *
 * @remarks
 * Preconditions:
 * - `minLevel` should be in [1, 6]; values outside this range will simply match no headings.
 * - `lines` represents the full document content.
 *
 * Postconditions:
 * - Sections are returned in document order.
 * - Each section's `startLine` is the 1-indexed heading line; `endLine` is the last body line
 *   (or `startLine` if the section has no body).
 * - Content before the first qualifying heading is not captured.
 *
 * Failure modes: none — pure computation.
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
 * Collect all non-blank lines that were not consumed by parser logic, preserving provenance.
 *
 * @param file - source file path for provenance records
 * @param lines - full document content split into lines
 * @param matchedLineNumbers - set of 1-indexed line numbers that were successfully parsed
 * @returns array of unparsed lines with their provenance (file and line number)
 *
 * @remarks
 * Preconditions:
 * - `matchedLineNumbers` contains 1-indexed values corresponding to lines in `lines`.
 *
 * Postconditions:
 * - Only non-blank, unmatched lines appear in the output.
 * - Output preserves document order.
 *
 * Failure modes: none — pure computation.
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
 * Failure modes: none — pure computation.
 */
export function toProvenance(file: string, line: number): LineProvenance {
  return { file, line };
}
