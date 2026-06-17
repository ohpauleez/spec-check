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
 * Parse a design markdown file into deterministic section structure.
 *
 * @param file - design markdown path
 * @returns parsed design model
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
