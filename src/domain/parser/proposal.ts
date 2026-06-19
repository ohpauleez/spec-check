/**
 * Parses proposal documents into structured section maps.
 * Extracts known proposal sections (Motivation, Scope, Capabilities, etc.) from markdown.
 *
 * Role: Parser layer component responsible for proposal document ingestion.
 *
 * Key exports: `parseProposalDocument`
 */
import { readFile } from "node:fs/promises";

import type { ParsedProposal } from "../model.js";
import { collectUnparsedLines, extractSections } from "./shared.js";

const PROPOSAL_SECTION_KEYS = new Set([
  "Motivation",
  "Scope",
  "Context",
  "Domain Model",
  "Preconditions, Postconditions, and Invariants",
  "Failure Modes",
  "Quality Attributes",
  "Capabilities",
]);

/**
 * Parse a proposal markdown file into a deterministic section structure.
 *
 * @param file - absolute or workspace-relative path to the proposal markdown file
 * @returns parsed proposal model containing a section map (keyed by recognized heading names),
 *   the source file path, and any unparsed lines not consumed by section extraction
 *
 * @remarks
 * Preconditions:
 * - `file` must be a readable filesystem path to a UTF-8 markdown file.
 *
 * Postconditions:
 * - Only headings matching `PROPOSAL_SECTION_KEYS` are captured in the sections map.
 * - Lines consumed by recognized sections are excluded from `unparsed`.
 * - Non-blank lines outside recognized sections are preserved in `unparsed`.
 *
 * Failure modes:
 * - Throws if `readFile` fails (e.g., ENOENT, EACCES, or other I/O error).
 *
 * Safety: performs a single filesystem read; no concurrent mutation concerns.
 */
export async function parseProposal(file: string): Promise<ParsedProposal> {
  const raw = await readFile(file, "utf8");
  const lines = raw.split(/\r?\n/u);
  const sections = extractSections(file, lines, 2).filter((section) => PROPOSAL_SECTION_KEYS.has(section.heading));

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
