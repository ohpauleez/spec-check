/**
 * Parses design documents into structured section maps.
 * Extracts known design sections (Context, Goals, Component Design, etc.) from markdown.
 *
 * Role: Parser layer component responsible for design document ingestion.
 *
 * Key exports: `parseDesignDocument`
 */
import { readFile } from "node:fs/promises";

import type { ParsedDesign } from "../model.js";
import { collectUnparsedLines, extractSections } from "./shared.js";

const DESIGN_SECTION_KEYS = new Set([
  "Context",
  "Goals",
  "Proposed Design",
  "Component Design",
  "Data Design",
  "Interface Contracts",
  "Code Map",
  "Failure and Reliability",
  "Security",
  "Risks / Trade-offs",
  "Verification Strategy",
]);

/**
 * Parse a design markdown file into a deterministic section structure.
 *
 * @param file - absolute or workspace-relative path to the design markdown file
 * @returns parsed design model containing a section map (keyed by recognized heading names),
 *   the source file path, and any unparsed lines not consumed by section extraction
 *
 * @remarks
 * Preconditions:
 * - `file` must be a readable filesystem path to a UTF-8 markdown file.
 *
 * Postconditions:
 * - Only headings matching `DESIGN_SECTION_KEYS` are captured in the sections map.
 * - Lines consumed by recognized sections are excluded from `unparsed`.
 * - Non-blank lines outside recognized sections are preserved in `unparsed`.
 *
 * Failure modes:
 * - Throws if `readFile` fails (e.g., ENOENT, EACCES, or other I/O error).
 *
 * Safety: performs a single filesystem read; no concurrent mutation concerns.
 */
export async function parseDesign(file: string): Promise<ParsedDesign> {
  const raw = await readFile(file, "utf8");
  const lines = raw.split(/\r?\n/u);
  const sections = extractSections(file, lines, 2).filter((section) => DESIGN_SECTION_KEYS.has(section.heading));

  const matched = new Set<number>();
  for (const section of sections) {
    for (let line = section.startLine; line <= section.endLine; line += 1) {
      matched.add(line);
    }
  }

  return {
    file,
    sections: new Map(sections.map((section) => [section.heading, section] as const)),
    unparsed: collectUnparsedLines(file, lines, matched),
  };
}
