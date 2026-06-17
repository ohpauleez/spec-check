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
 * Parse a proposal markdown file into deterministic section structure.
 *
 * @param file - proposal markdown path
 * @returns parsed proposal model
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
