/**
 * Parses task documents, extracting task groups and individual checklist items
 * with completion status from markdown task lists.
 *
 * Role: Parser layer component responsible for task document ingestion; feeds
 * coverage analysis with task-evidence data.
 *
 * Key exports: `parseTaskDocument`
 */
import { readFile } from "node:fs/promises";

import type { ParsedTaskDocument, ParsedTaskGroup, ParsedTaskItem } from "../model.js";
import { collectUnparsedLines, parseHeading, toProvenance } from "./shared.js";

const TASK_ITEM_PATTERN = /^-\s+\[(?<mark>[ xX])\]\s+(?<text>.+)$/u;

/**
 * Parse a tasks markdown file, extracting task groups with completion status and change summaries.
 *
 * @param file - absolute or workspace-relative path to the tasks markdown file
 * @returns parsed task document containing groups, task items with completion marks,
 *   change summaries, and any unparsed lines
 *
 * @remarks
 * Preconditions:
 * - `file` must be a readable filesystem path to a UTF-8 markdown file.
 *
 * Postconditions:
 * - Every `## ` heading becomes a task group; `- [x]` / `- [ ]` items within become tasks.
 * - `### ... change summary` headings are captured separately in `changeSummaries`.
 * - Lines not consumed by any parser rule are preserved in `unparsed`.
 *
 * Failure modes:
 * - Throws if `readFile` fails (e.g., ENOENT, EACCES, or other I/O error).
 *
 * Safety: performs a single filesystem read; no concurrent mutation concerns.
 */
export async function parseTaskDocument(file: string): Promise<ParsedTaskDocument> {
  const raw = await readFile(file, "utf8");
  const lines = raw.split(/\r?\n/u);

  const groups: ParsedTaskGroup[] = [];
  const changeSummaries = new Map<string, readonly string[]>();
  const matched = new Set<number>();

  let activeGroup: { readonly title: string; readonly headingLine: number; readonly tasks: ParsedTaskItem[] } | undefined;
  let activeSummary: { readonly title: string; readonly lines: string[] } | undefined;

  const flushGroup = (): void => {
    if (activeGroup === undefined) {
      return;
    }
    groups.push({
      title: activeGroup.title,
      tasks: activeGroup.tasks,
    });
  };

  const flushSummary = (): void => {
    if (activeSummary === undefined) {
      return;
    }
    changeSummaries.set(activeSummary.title, [...activeSummary.lines]);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNo = index + 1;

    const heading = parseHeading(line);
    if (heading !== undefined && heading.level === 2) {
      flushSummary();
      activeSummary = undefined;

      flushGroup();
      activeGroup = {
        title: heading.text,
        headingLine: lineNo,
        tasks: [],
      };
      matched.add(lineNo);
      continue;
    }

    if (heading !== undefined && heading.level === 3 && heading.text.endsWith("change summary")) {
      flushSummary();
      activeSummary = {
        title: heading.text,
        lines: [],
      };
      matched.add(lineNo);
      continue;
    }

    const taskMatch = line.match(TASK_ITEM_PATTERN);
    if (taskMatch !== null && activeGroup !== undefined) {
      matched.add(lineNo);
      activeGroup.tasks.push({
        text: taskMatch.groups?.text?.trim() ?? "",
        done: (taskMatch.groups?.mark ?? " ").toLowerCase() === "x",
        provenance: toProvenance(file, lineNo),
      });
      continue;
    }

    if (activeSummary !== undefined) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("<!--")) {
        matched.add(lineNo);
        activeSummary.lines.push(trimmed);
      }
    }
  }

  flushSummary();
  flushGroup();

  return {
    file,
    groups,
    changeSummaries,
    unparsed: collectUnparsedLines(file, lines, matched),
  };
}
