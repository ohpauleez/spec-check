/** Bounded structural EARS recognition. Predicate English remains untrusted content. */
import type { EarsClauses, EarsClause, EarsModal, SurfaceIssue } from "../model.js";
import type { NormalizedSource } from "./source.js";

/** Default bound on a single normalized source statement's UTF-8 bytes. */
export const STATEMENT_MAX_BYTES = 65_536;

/** Explicit parser extensions; structural defaults never imply temporal timing. */
export interface EarsOptions {
  readonly earsExtensions?: readonly "where"[];
  readonly statementMaxBytes?: number;
}

/** Recognized structure and source-attributed eligibility issues. */
export interface EarsParseResult {
  readonly clauses?: EarsClauses;
  readonly issues: readonly SurfaceIssue[];
}

/** Candidate source clause pattern over protected-content-masked prefix text. */
interface Pattern {
  readonly form: EarsClauses["form"];
  readonly regex: RegExp;
  readonly slots: readonly ("subject" | "state" | "trigger" | "condition" | "feature")[];
}

// First match owns clause boundaries: complex must precede the broader state pattern.
const PATTERNS: readonly Pattern[] = [
  { form: "complex", regex: /^WHILE\s+(.+?),\s*WHEN\s+(.+?),\s*THE\s+(.+?)\s*$/diu, slots: ["state", "trigger", "subject"] },
  { form: "state-driven", regex: /^WHILE\s+(.+?),\s*THE\s+(.+?)\s*$/diu, slots: ["state", "subject"] },
  { form: "event-driven", regex: /^WHEN\s+(.+?),\s*THE\s+(.+?)\s*$/diu, slots: ["trigger", "subject"] },
  { form: "unwanted-behavior", regex: /^IF\s+(.+?),\s*THEN\s+THE\s+(.+?)\s*$/diu, slots: ["condition", "subject"] },
  { form: "optional", regex: /^WHERE\s+(.+?),\s*THE\s+(.+?)\s*$/diu, slots: ["feature", "subject"] },
  { form: "ubiquitous", regex: /^THE\s+(.+?)\s*$/diu, slots: ["subject"] },
];

/**
 * Recognize exactly one complete statement, retaining source-owned clause spans.
 * Reject malformed/oversized text without guessing guards or response timing.
 * @returns Recognized source clauses and explicit eligibility issues; unsupported input is data.
 * @remarks Source is normalized with an unchanged original-offset map; caller must use
 * normalizeSource rather than trim independently. Bytes are checked before structural scanning.
 * Keyword literals stay protected, no inputs mutate, and no I/O/expected exceptions occur.
 * @example parseEars(normalizeSource(file, lines, heading), { earsExtensions: ["where"] });
 */
export function parseEars(source: NormalizedSource, options: EarsOptions = {}): EarsParseResult {
  const issue = (code: string, message: string): EarsParseResult => ({ issues: [Object.freeze({ code, message, span: source.span })] });
  if (Buffer.byteLength(source.text, "utf8") > (options.statementMaxBytes ?? STATEMENT_MAX_BYTES)) {
    return issue("statement-limit", "EARS statement exceeds its configured byte bound");
  }
  const masked = maskProtected(source.text);
  if (masked === undefined) return issue("unclosed-content", "Unclosed quotation or inline code in EARS statement");
  const modals = [...masked.matchAll(/[A-Za-z][A-Za-z0-9_-]*/gu)]
    .filter((word) => ["SHALL", "MUST", "SHOULD", "MAY"].includes(word[0].toUpperCase()));
  if (modals.length !== 1) return issue("modal-count", "EARS requires exactly one structural modal (SHALL, MUST, SHOULD, or MAY)");
  if (!masked.endsWith(".")) return issue("missing-terminator", "EARS statement requires a final period");
  for (let i = 0; i < masked.length - 1; i += 1) {
    if (masked[i] === "." && /\s/u.test(masked[i + 1] ?? "")) {
      return issue("trailing-statement", "Multiple sentences or trailing normative content in EARS statement");
    }
  }
  const modalToken = modals[0]!; // Exactly one structural modal was established above.
  const modal = modalToken[0].toUpperCase() as EarsModal;
  const head = masked.slice(0, modalToken.index);
  if (/,(?:\s*)(?:WHILE|IF|WHERE)\b/iu.test(head)) return issue("driver-order", "EARS drivers occur in an unsupported order");
  const pattern = PATTERNS.find((candidate) => candidate.regex.test(head));
  if (pattern === undefined) return issue("clause-grammar", "EARS requires ordered nonempty clauses, commas, THE subject, and IF/THEN pairing");
  const events = [...head.matchAll(/,\s*WHEN\b/giu)].length;
  if (events > 1 || (events > 0 && pattern.form !== "complex")) return issue("driver-count", "EARS supports at most one ordered event driver");
  const matched = pattern.regex.exec(head)!; // Non-global patterns retain the successful test result.
  const clauses: Partial<Record<Pattern["slots"][number], EarsClause>> = {};
  for (let i = 0; i < pattern.slots.length; i += 1) {
    const range = matched.indices?.[i + 1];
    if (range === undefined) return issue("clause-grammar", "Unable to establish EARS clause boundaries");
    clauses[pattern.slots[i]!] = clause(source, range[0], range[1]); // Index is bounded by slots.length.
  }
  let responseStart = modalToken.index + modalToken[0].length;
  while (/\s/u.test(source.text[responseStart] ?? "") && responseStart < source.text.length) responseStart += 1;
  const negative = /^NOT\b/iu.test(masked.slice(responseStart));
  if (negative && modal === "MAY") return issue("may-not", "MAY NOT has ambiguous permission/prohibition meaning");
  if (negative) responseStart += 3;
  const response = clause(source, responseStart, source.text.length - 1);
  if (response.text.length === 0) return issue("empty-response", "EARS response must be nonempty");
  const result: EarsClauses = Object.freeze({
    ...clauses, form: pattern.form, subject: clauses.subject!, modal, // Every admitted pattern has a nonempty subject slot.
    negatedResponse: negative, response,
  });
  const issues: SurfaceIssue[] = pattern.form === "optional" && !options.earsExtensions?.includes("where")
    ? [Object.freeze({ code: "where-disabled", message: "WHERE requires analysis.earsExtensions: [\"where\"]", span: source.span })]
    : [];
  const temporal = /\b(?:within|after|every|for)\s+\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|minutes?|hours?|steps?)\b|\b(?:eventually|next\s+(?:state|step))\b/iu.exec(masked);
  if (temporal !== null) issues.push(Object.freeze({ code: "temporal-limitation", message: "Explicit temporal response/driver content requires a separately authored temporal contract; static projection is unsupported", span: clause(source, temporal.index, temporal.index + temporal[0].length).span }));
  return Object.freeze({ clauses: result, issues: Object.freeze(issues) });
}

/** Extract a trimmed clause using normalized offsets and original source bounds. */
function clause(source: NormalizedSource, begin: number, end: number): EarsClause {
  while (begin < end && /\s/u.test(source.text[begin] ?? "")) begin += 1;
  while (end > begin && /\s/u.test(source.text[end - 1] ?? "")) end -= 1;
  return Object.freeze({
    text: source.text.slice(begin, end), normalizedStart: begin, normalizedEnd: end,
    span: Object.freeze({ file: source.span.file, start: source.sourceMap[begin] ?? source.span.start, end: source.sourceMap[end] ?? source.span.end }),
  });
}

/**
 * Mask protected quote/code characters without changing UTF-16 offsets.
 * Embedded apostrophes are prose; quote delimiters and decimal punctuation are
 * never interpreted as EARS clause separators. Unclosed protected text rejects.
 */
function maskProtected(text: string): string | undefined {
  const chars = text.split("");
  let quote: string | undefined;
  let ticks = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const char = text[i]!;
    if (char === "`") {
      let stop = i + 1;
      while (text[stop] === "`") stop += 1;
      const width = stop - i;
      if (quote === undefined && (ticks === 0 || ticks === width)) ticks = ticks === 0 ? width : 0;
      for (; i < stop; i += 1) chars[i] = "~";
      i -= 1;
      continue;
    }
    if (ticks > 0) { chars[i] = "~"; continue; }
    if (quote !== undefined) {
      chars[i] = "~";
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\"" || char === "'" || char === "“" || char === "‘") {
      if ((char === "'" || char === "‘") && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[i + 1] ?? "")) continue;
      quote = char === "“" ? "”" : char === "‘" ? "’" : char;
      chars[i] = "~";
    }
  }
  return quote !== undefined || ticks > 0 ? undefined : chars.join("");
}
