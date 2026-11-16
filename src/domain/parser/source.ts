/** Pure source-range construction and normalization; offsets use UTF-16 units. */
import type { SourceFragment, SourcePosition, SourceSpan } from "../model.js";
import { err, ok, type Result } from "../result.js";

/** Original line content without its newline and its exact original position. */
export interface SourceLine {
  readonly text: string;
  readonly offset: number;
  readonly line: number;
  /** Original starting column for a sliced metadata value. */
  readonly column?: number;
}

/** Normalize only newline representation, retaining original file offsets. */
export function sourceLines(raw: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== "\n") continue;
    const end = raw[index - 1] === "\r" && index < raw.length ? index - 1 : index;
    lines.push(Object.freeze({ text: raw.slice(offset, end), offset, line: lines.length + 1 }));
    offset = index + 1;
  }
  return Object.freeze(lines);
}

/** Construct an original source position at a checked line-local offset. */
export function position(line: SourceLine, index: number): SourcePosition {
  return Object.freeze({ offset: line.offset + index, line: line.line, column: (line.column ?? 1) + index });
}

/** Retain exact line-local text and a half-open original source span. */
export function fragment(file: string, line: SourceLine, start = 0, end = line.text.length): SourceFragment {
  return Object.freeze({
    text: line.text.slice(start, end),
    span: Object.freeze({ file, start: position(line, start), end: position(line, end) }),
  });
}

/** Normalized prose has no leading/trailing whitespace. Offsets index this exact
 * text; the source map includes its exclusive end. Consumers must not trim it again.
 */
export interface NormalizedSource extends SourceFragment {
  readonly sourceMap: readonly SourcePosition[];
}

/**
 * Join trimmed prose lines with one space and retain a position for every offset.
 * Synthetic join spaces map to the preceding source end; input is never mutated.
 */
export function normalizeSource(file: string, lines: readonly SourceLine[], fallback: SourceLine, maxMapBytes = 65_536): NormalizedSource {
  const normalized = lines.map((line) => line.text.trim()).filter((text) => text.length > 0).join(" ");
  if (Buffer.byteLength(normalized, "utf8") > maxMapBytes) {
    const first = lines.find((line) => line.text.trim().length > 0) ?? fallback;
    const last = lines[lines.length - 1] ?? fallback;
    return Object.freeze({ text: normalized, sourceMap: Object.freeze([]), span: Object.freeze({
      file, start: position(first, first.text.length - first.text.trimStart().length), end: position(last, last.text.trimEnd().length),
    }) });
  }
  const parts: string[] = [];
  const map: SourcePosition[] = [];
  let end = position(fallback, fallback.text.length);
  for (const line of lines) {
    const start = line.text.length - line.text.trimStart().length;
    const stop = line.text.trimEnd().length;
    if (stop <= start) continue;
    if (parts.length > 0) { parts.push(" "); map.push(end); }
    parts.push(line.text.slice(start, stop));
    for (let index = start; index < stop; index += 1) map.push(position(line, index));
    end = position(line, stop);
  }
  map.push(end);
  return Object.freeze({
    text: parts.join(""),
    span: Object.freeze({ file, start: map[0] ?? end, end }),
    sourceMap: Object.freeze(map),
  });
}

/** Validate a source range at an untrusted data boundary without throwing. */
export function validateSourceSpan(value: unknown): Result<SourceSpan, string> {
  if (typeof value !== "object" || value === null) return err("source span must be an object");
  const record = value as { file?: unknown; start?: unknown; end?: unknown };
  if (typeof record.file !== "string" || record.file.length === 0) return err("source file must be nonempty");
  const start = validatePosition(record.start);
  const end = validatePosition(record.end);
  if (!start.ok) return start;
  if (!end.ok) return end;
  if (end.value.offset < start.value.offset || end.value.line < start.value.line
    || (end.value.line === start.value.line && end.value.column < start.value.column)) {
    return err("source span end precedes start");
  }
  return ok(Object.freeze({ file: record.file, start: start.value, end: end.value }));
}

/** Validate a one-based source position and nonnegative original UTF-16 offset. */
function validatePosition(value: unknown): Result<SourcePosition, string> {
  if (typeof value !== "object" || value === null) return err("source position must be an object");
  const record = value as { offset?: unknown; line?: unknown; column?: unknown };
  if (typeof record.offset !== "number" || !Number.isSafeInteger(record.offset) || record.offset < 0
    || typeof record.line !== "number" || !Number.isSafeInteger(record.line) || record.line < 1
    || typeof record.column !== "number" || !Number.isSafeInteger(record.column) || record.column < 1) {
    return err("source position requires a safe offset and positive line/column");
  }
  return ok(Object.freeze({ offset: record.offset, line: record.line, column: record.column }));
}
