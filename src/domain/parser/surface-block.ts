/** Loss-aware block extraction with fences, metadata and statement admission. */
import type { ScenarioKind, SourceFragment, SurfaceIssue, SurfaceStatement } from "../model.js";
import { parseEars, STATEMENT_MAX_BYTES, type EarsOptions, type EarsParseResult } from "./ears.js";
import { fragment, normalizeSource, type SourceLine } from "./source.js";

/** Extracted source block, including original operation-independent references. */
export interface SurfaceBlock {
  readonly surface: SurfaceStatement;
  readonly references: readonly string[];
  readonly endIndex: number;
  readonly unmatchedLines: readonly number[];
}

/** Mutable local scanner state; never shared across blocks or returned to callers. */
interface BlockState {
  readonly statement: SourceLine[];
  readonly supplementary: SourceFragment[];
  readonly references: string[];
  readonly fields: Map<string, SourceLine[]>;
  readonly issues: SurfaceIssue[];
  readonly unmatched: Set<number>;
  mode: string;
  fence: { char: string; width: number } | undefined;
  comment: boolean;
}

const FIELD_NAMES: Readonly<Record<string, string>> = {
  "Format justification": "justification", "Postcondition": "postcondition",
  "Input": "input", "Expected": "expected", "Forbidden": "forbidden", "Scenario kind": "kind",
};

/**
 * Extract a single headed block without treating fenced headings as structure.
 * Every nonblank consumed line is statement, metadata, reference or supplementary
 * evidence. Malformed metadata/extra normative content stays visible and excluded.
 */
export function extractSurfaceBlock(
  file: string, lines: readonly SourceLine[], startIndex: number, ordinal: number, options: EarsOptions = {},
): SurfaceBlock {
  const state: BlockState = { statement: [], supplementary: [], references: [], fields: new Map(), issues: [], unmatched: new Set(), mode: "statement", fence: undefined, comment: false };
  let endIndex = startIndex;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (state.fence === undefined && !state.comment && /^(?:#{1,3}\s|#### Scenario:)/u.test(line.text)) break;
    endIndex = index;
    consumeLine(file, line, state);
  }
  const fallback = lines[startIndex]!;
  const source = normalizeSource(file, state.statement, fallback, options.statementMaxBytes);
  const fields: SurfaceStatement["fields"] = Object.freeze(Object.fromEntries(
    [...state.fields].filter(([key]) => key !== "kind").map(([key, value]) => [key, normalizeSource(file, value, fallback, options.statementMaxBytes)]),
  ));
  const kindValue = normalizeSource(file, state.fields.get("kind") ?? [], fallback).text;
  const kind: ScenarioKind = kindValue === "example" || kindValue === "prohibited-example" ? kindValue : "refinement";
  if (kindValue !== "" && !["refinement", "example", "prohibited-example"].includes(kindValue)) {
    state.issues.push({ code: "scenario-kind", message: "Unknown scenario kind", span: source.span });
  }
  if (state.fence !== undefined) state.issues.push({ code: "unclosed-fence", message: "Unclosed fenced supporting content", span: source.span });
  if (state.comment) state.issues.push({ code: "unclosed-comment", message: "Unclosed supporting HTML comment", span: source.span });
  for (const value of Object.values(fields)) {
    if (value !== undefined && Buffer.byteLength(value.text, "utf8") > (options.statementMaxBytes ?? STATEMENT_MAX_BYTES)) {
      state.issues.push({ code: "field-limit", message: "Scenario field exceeds its byte bound", span: value.span });
    }
  }
  const parsed: EarsParseResult = kind === "refinement" ? parseEars(source, options) : { issues: [] };
  if (kind !== "refinement" && (!fields.input?.text || !(kind === "example" ? fields.expected?.text : fields.forbidden?.text)
    || (kind === "example" ? fields.forbidden !== undefined : fields.expected !== undefined))) {
    state.issues.push({ code: "scenario-fields", message: "Example requires Input and its matching Expected or Forbidden field", span: source.span });
  }
  const issues = Object.freeze([...state.issues, ...parsed.issues].map((issue) => Object.freeze(issue)));
  const surface: SurfaceStatement = Object.freeze({
    source: Object.freeze({ file, ordinal }), text: source.text, span: source.span, sourceMap: source.sourceMap,
    ...(parsed.clauses === undefined ? {} : { clauses: parsed.clauses }),
    disposition: issues.length > 0
      ? Object.freeze({ kind: "excluded", reasons: issues })
      : Object.freeze({ kind: "eligible", representation: kind === "refinement" ? "ears" : kind }),
    scenarioKind: kind, fields, supplementary: Object.freeze(state.supplementary), issues,
  });
  return { surface, references: Object.freeze(state.references), endIndex, unmatchedLines: Object.freeze([...state.unmatched]) };
}

/** Consume one line, preserving exact raw text even when its role is unsupported. */
function consumeLine(file: string, line: SourceLine, state: BlockState): void {
  const trimmed = line.text.trim();
  if (state.comment || (state.fence === undefined && trimmed.startsWith("<!--"))) {
    state.supplementary.push(fragment(file, line));
    state.comment = !trimmed.includes("-->");
    state.mode = "supplementary";
    return;
  }
  const fence = /^(\s*)(`{3,}|~{3,})/u.exec(line.text);
  if (state.fence !== undefined || fence !== null) {
    state.supplementary.push(fragment(file, line));
    if (fence !== null) {
      const delimiter = fence[2]!;
      if (state.fence === undefined) state.fence = { char: delimiter[0]!, width: delimiter.length };
      else if (delimiter[0] === state.fence.char && delimiter.length >= state.fence.width && /^\s*(?:`+|~+)\s*$/u.test(line.text)) state.fence = undefined;
    }
    state.mode = "supplementary";
    return;
  }
  if (trimmed === "") {
    if ((state.mode === "statement" && state.statement.length > 0) || state.fields.has(state.mode)) state.mode = "supplementary";
    return;
  }
  const metadata = /^\s*\*\*([^*]+):\*\*\s*(.*)$/u.exec(line.text);
  if (metadata !== null) {
    const name = metadata[1]!;
    state.mode = name === "References" ? "references" : FIELD_NAMES[name] ?? "supplementary";
    if (state.mode !== "references" && state.mode !== "supplementary") {
      if (state.fields.has(state.mode)) {
        state.issues.push({ code: "duplicate-field", message: `Duplicate ${name} metadata`, span: fragment(file, line).span });
        state.supplementary.push(fragment(file, line));
        state.mode = "supplementary";
        return;
      }
      const value = metadata[2]!;
      const start = line.text.length - value.length;
      state.fields.set(state.mode, [{ ...line, text: value, offset: line.offset + start, column: start + 1 }]);
    } else {
      state.supplementary.push(fragment(file, line));
      if (state.mode === "supplementary") state.issues.push({ code: "unknown-metadata", message: `Unknown ${name} metadata`, span: fragment(file, line).span });
    }
    return;
  }
  if (state.mode === "references" && trimmed.startsWith("- ")) {
    state.references.push(trimmed.slice(2).trim());
    state.supplementary.push(fragment(file, line));
    return;
  }
  if (line.text.startsWith("#### ") || line.text.startsWith("##### ")) state.mode = "supplementary";
  if (state.mode === "statement") state.statement.push(line);
  else if (state.fields.has(state.mode)) state.fields.get(state.mode)!.push(line);
  else {
    state.supplementary.push(fragment(file, line));
    state.unmatched.add(line.line);
    if (/^(?:WHEN|WHILE|WHERE|IF|THE)\s/iu.test(trimmed)) {
      state.issues.push({ code: "trailing-normative", message: "Additional normative statement requires a separate source heading", span: fragment(file, line).span });
    }
  }
}
