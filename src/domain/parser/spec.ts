/** Parse constrained spec Markdown into loss-aware statements and EARS clauses. */
import { readFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import type { DeltaOperation, ParsedRequirement, ParsedScenario, ParsedSpec } from "../model.js";
import type { EarsOptions } from "./ears.js";
import { extractSurfaceBlock } from "./surface-block.js";
import { sourceLines } from "./source.js";
import { collectUnparsedLines, parseCanonicalIdentifier } from "./shared.js";

const DELTA_OPERATIONS = new Map<string, DeltaOperation>([
  ["## ADDED Requirements", "ADDED"], ["## MODIFIED Requirements", "MODIFIED"],
  ["## REMOVED Requirements", "REMOVED"], ["## RENAMED Requirements", "RENAMED"],
]);

/** Read a source file once; all deterministic parsing delegates to parseSpecText. */
export async function parseSpec(file: string, source: "final" | "delta" = "final", options: EarsOptions = {}): Promise<ParsedSpec> {
  const bytes = await readFile(file);
  if (!isUtf8(bytes)) throw new Error(`Specification input is not valid UTF-8: ${file}`);
  return parseSpecText(file, bytes.toString("utf8"), source, options);
}

/**
 * Parse without filesystem effects. Preserve original operation/parent metadata
 * independently of eligibility; fences cannot introduce headings or operations.
 * Expected source defects return findings; inputs and retained fields are immutable.
 */
export function parseSpecText(file: string, raw: string, source: "final" | "delta" = "final", options: EarsOptions = {}): ParsedSpec {
  const lines = sourceLines(raw);
  const sourceSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  const requirements: ParsedRequirement[] = [];
  const scenarios: ParsedScenario[] = [];
  const structuralFindings: ParsedSpec["structuralFindings"][number][] = [];
  const deltaSections: ParsedSpec["deltaSections"][number][] = [];
  const matched = new Set<number>();
  let operation: DeltaOperation = source === "final" ? "base" : "pre-section";
  let parent: string | undefined;
  let ordinal = 0;
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line.text)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^\s*(?:`+|~+)\s*$/u.test(line.text)) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const nextOperation = DELTA_OPERATIONS.get(line.text);
    if (nextOperation !== undefined) {
      matched.add(line.line);
      deltaSections.push(nextOperation as ParsedSpec["deltaSections"][number]);
      if (source === "delta") operation = nextOperation;
      parent = undefined;
      continue;
    }
    const requirement = line.text.startsWith("### Requirement:");
    const scenario = line.text.startsWith("#### Scenario:");
    if (!requirement && !scenario) continue;
    const prefix = requirement ? "### Requirement:" : "#### Scenario:";
    const identity = titledIdentifier(line.text.slice(prefix.length).trim());
    const block = extractSurfaceBlock(file, lines, index, ordinal++, options);
    const provenance = { file, line: line.line };
    if (identity.error !== undefined) structuralFindings.push({ message: identity.error, provenance });
    for (const issue of block.surface.issues) structuralFindings.push({ message: issue.message, provenance: { file, line: issue.span.start.line } });
    const shared = { title: identity.title, ...(identity.identifier === undefined ? {} : { identifier: identity.identifier }),
      body: block.surface.text, deltaOperation: operation, provenance, surface: Object.freeze({ ...block.surface, sourceSha256 }) };
    if (requirement) {
      requirements.push(Object.freeze({ ...shared, earsType: block.surface.clauses?.form ?? "non-ears", references: block.references }));
      parent = identity.identifier;
      if (block.references.length === 0) structuralFindings.push({ message: "Requirement missing references section", provenance });
    } else scenarios.push(Object.freeze({ ...shared, ...(parent === undefined ? {} : { parentRequirementIdentifier: parent }) }));
    const unmatched = new Set(block.unmatchedLines);
    for (let consumed = index; consumed <= block.endIndex; consumed += 1) {
      if (!unmatched.has(lines[consumed]!.line)) matched.add(lines[consumed]!.line);
    }
    index = block.endIndex;
  }
  if (requirements.length + scenarios.length === 0) structuralFindings.push({ message: "No recognizable requirement or scenario headings", provenance: { file, line: 1 } });
  return { file, requirements, scenarios, structuralFindings, deltaSections, unparsed: collectUnparsedLines(file, lines.map((line) => line.text), matched) };
}

/** Parse optional authored display identity; malformed IDs do not merge sources. */
function titledIdentifier(raw: string): { title: string; identifier?: string; error?: string } {
  const open = raw.lastIndexOf("[");
  const close = raw.lastIndexOf("]");
  if (open < 0 || close < open) return { title: raw };
  const token = raw.slice(open, close + 1);
  const identifier = parseCanonicalIdentifier(token);
  const title = raw.slice(0, open).trim();
  return identifier === undefined ? { title, error: `Malformed identifier token: ${token}` } : { title, identifier };
}
