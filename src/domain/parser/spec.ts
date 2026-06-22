/**
 * Parses spec documents, extracting requirements, EARS-pattern scenarios, references,
 * and delta sections from capability spec markdown files.
 *
 * Role: Core parser for the specification layer — produces the structured spec models
 * that coverage and qualitative analysis consume.
 *
 * Key exports: `parseSpecDocument`
 */
import { readFile } from "node:fs/promises";

import type { DeltaOperation, ParsedRequirement, ParsedScenario, ParsedSpec } from "../model.js";
import { collectUnparsedLines, parseCanonicalIdentifier, parseHeading, toProvenance } from "./shared.js";

const REQUIREMENT_PREFIX = "### Requirement:";
const SCENARIO_PREFIX = "#### Scenario:";
const REFERENCES_HEADING = "**References:**";
const DELTA_HEADINGS = new Set(["ADDED Requirements", "MODIFIED Requirements", "REMOVED Requirements", "RENAMED Requirements"]);

/**
 * Parse a capability spec markdown file, extracting requirements, scenarios, references,
 * delta sections, and structural findings.
 *
 * @param file - absolute or workspace-relative path to the spec markdown file
 * @returns parsed spec model containing requirements, scenarios, delta section tags,
 *   structural findings (e.g., missing references, non-EARS bodies), and unparsed lines
 *
 * @remarks
 * Preconditions:
 * - `file` must be a readable filesystem path to a UTF-8 markdown file.
 *
 * Postconditions:
 * - Requirements are extracted from `### Requirement:` blocks; scenarios from `#### Scenario:` blocks.
 * - If no requirements or scenarios are found, a structural finding is emitted.
 * - EARS classification is applied to each requirement body.
 * - Unparsed lines (non-blank, not consumed by any rule) are preserved.
 *
 * Failure modes:
 * - Throws if `readFile` fails (e.g., ENOENT, EACCES, or other I/O error).
 *
 * Safety: performs a single filesystem read; no concurrent mutation concerns.
 */
export async function parseSpec(file: string, source: "final" | "delta" = "final"): Promise<ParsedSpec> {
  const raw = await readFile(file, "utf8");
  const lines = raw.split(/\r?\n/u);

  const requirements: ParsedRequirement[] = [];
  const scenarios: ParsedScenario[] = [];
  const structuralFindings: { message: string; provenance: { file: string; line: number } }[] = [];
  const deltaSections: ("ADDED" | "MODIFIED" | "REMOVED" | "RENAMED")[] = [];
  const matchedLines = new Set<number>();
  let currentDeltaOperation: DeltaOperation = source === "delta" ? "pre-section" : "base";
  let currentRequirementIdentifier: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNo = index + 1;
    const heading = parseHeading(line);
    if (heading !== undefined && DELTA_HEADINGS.has(heading.text)) {
      matchedLines.add(lineNo);
      if (heading.text.startsWith("ADDED")) {
        deltaSections.push("ADDED");
        if (source === "delta") {
          currentDeltaOperation = "ADDED";
        }
      } else if (heading.text.startsWith("MODIFIED")) {
        deltaSections.push("MODIFIED");
        if (source === "delta") {
          currentDeltaOperation = "MODIFIED";
        }
      } else if (heading.text.startsWith("REMOVED")) {
        deltaSections.push("REMOVED");
        if (source === "delta") {
          currentDeltaOperation = "REMOVED";
        }
      } else if (heading.text.startsWith("RENAMED")) {
        deltaSections.push("RENAMED");
        if (source === "delta") {
          currentDeltaOperation = "RENAMED";
        }
      }
      continue;
    }

    if (line.startsWith(REQUIREMENT_PREFIX)) {
      const parsed = parseRequirement(file, lines, index, currentDeltaOperation);
      requirements.push(parsed.requirement);
      currentRequirementIdentifier = parsed.requirement.identifier;
      for (let consumed = parsed.startLine; consumed <= parsed.endLine; consumed += 1) {
        matchedLines.add(consumed);
      }
      structuralFindings.push(...parsed.structuralFindings);
      index = Math.max(parsed.endLine - 1, index);
      continue;
    }

    if (line.startsWith(SCENARIO_PREFIX)) {
      const parsed = parseScenario(file, lines, index, currentDeltaOperation, currentRequirementIdentifier);
      scenarios.push(parsed.scenario);
      for (let consumed = parsed.startLine; consumed <= parsed.endLine; consumed += 1) {
        matchedLines.add(consumed);
      }
      structuralFindings.push(...parsed.structuralFindings);
      index = Math.max(parsed.endLine - 1, index);
      continue;
    }
  }

  if (requirements.length === 0 && scenarios.length === 0) {
    structuralFindings.push({
      message: "No recognizable requirement or scenario headings",
      provenance: toProvenance(file, 1),
    });
  }

  return {
    file,
    requirements,
    scenarios,
    deltaSections,
    structuralFindings,
    unparsed: collectUnparsedLines(file, lines, matchedLines),
  };
}

/**
 * Parse a single requirement block starting at the given heading line.
 *
 * @param file - source file path for provenance tracking
 * @param lines - full document lines array
 * @param startIndex - 0-based index of the requirement heading line
 * @returns parsed requirement, consumed line range, and any structural findings
 *
 * @remarks
 * Precondition: `lines[startIndex]` starts with `"### Requirement:"`.
 * Postcondition: the returned `endLine` is the 1-indexed last line consumed by this block.
 * Body lines are joined with spaces; references are extracted from a `**References:**` subsection.
 * EARS classification is applied to the body and a finding is emitted for non-EARS requirements.
 * Failure modes: none — pure computation (operates on in-memory line arrays).
 */
function parseRequirement(
  file: string,
  lines: readonly string[],
  startIndex: number,
  deltaOperation: DeltaOperation,
): {
  readonly requirement: ParsedRequirement;
  readonly startLine: number;
  readonly endLine: number;
  readonly structuralFindings: ParsedSpec["structuralFindings"];
} {
  const titleLine = lines[startIndex] ?? "";
  const startLine = startIndex + 1;
  const { title, identifier, identifierError } = parseTitledIdentifier(titleLine.slice(REQUIREMENT_PREFIX.length).trim());

  const bodyLines: string[] = [];
  const references: string[] = [];
  const structuralFindings: { message: string; provenance: { file: string; line: number } }[] = [];
  let endIndex = startIndex;

  let inReferences = false;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("### Requirement:") || line.startsWith("#### Scenario:") || line.startsWith("## ")) {
      break;
    }

    endIndex = index;
    const trimmed = line.trim();
    if (trimmed === REFERENCES_HEADING) {
      inReferences = true;
      continue;
    }

    if (inReferences && trimmed.startsWith("- ")) {
      references.push(trimmed.slice(2).trim());
      continue;
    }

    if (trimmed.length > 0) {
      bodyLines.push(trimmed);
    }
  }

  const body = bodyLines.join(" ");
  if (identifierError !== undefined) {
    structuralFindings.push({ message: identifierError, provenance: { file, line: startLine } });
  }
  if (references.length === 0) {
    structuralFindings.push({ message: "Requirement missing references section", provenance: { file, line: startLine } });
  }

  const earsType = classifyEarsType(body);

  // [CAT-EARS-WARN]: emit a structural finding when a requirement body does not
  // match any recognized EARS pattern, recommending EARS conformance.
  if (earsType === "non-ears") {
    structuralFindings.push({
      message: "Requirement body does not match any recognized EARS pattern; consider rewriting for EARS conformance",
      provenance: { file, line: startLine },
    });
  }

  const requirement: ParsedRequirement = {
    title,
    ...(identifier === undefined ? {} : { identifier }),
    body,
    earsType,
    deltaOperation,
    references,
    provenance: { file, line: startLine },
  };

  return {
    requirement,
    startLine,
    endLine: endIndex,
    structuralFindings,
  };
}

/**
 * Parse a single scenario block starting at the given heading line.
 *
 * @param file - source file path for provenance tracking
 * @param lines - full document lines array
 * @param startIndex - 0-based index of the scenario heading line
 * @returns parsed scenario, consumed line range, and any structural findings
 *
 * @remarks
 * Precondition: `lines[startIndex]` starts with `"#### Scenario:"`.
 * Postcondition: the returned `endLine` is the 1-indexed last line consumed by this block.
 * Body lines are joined with spaces. Parsing terminates at the next heading of equal or higher level.
 * Failure modes: none — pure computation (operates on in-memory line arrays).
 */
function parseScenario(
  file: string,
  lines: readonly string[],
  startIndex: number,
  deltaOperation: DeltaOperation,
  parentRequirementIdentifier: string | undefined,
): {
  readonly scenario: ParsedScenario;
  readonly startLine: number;
  readonly endLine: number;
  readonly structuralFindings: ParsedSpec["structuralFindings"];
} {
  const titleLine = lines[startIndex] ?? "";
  const startLine = startIndex + 1;
  const { title, identifier, identifierError } = parseTitledIdentifier(titleLine.slice(SCENARIO_PREFIX.length).trim());

  const bodyLines: string[] = [];
  let endIndex = startIndex;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("#### Scenario:") || line.startsWith("### Requirement:") || line.startsWith("## ")) {
      break;
    }

    endIndex = index;
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      bodyLines.push(trimmed);
    }
  }

  const structuralFindings: { message: string; provenance: { file: string; line: number } }[] = [];
  if (identifierError !== undefined) {
    structuralFindings.push({ message: identifierError, provenance: { file, line: startLine } });
  }

  return {
    scenario: {
      title,
      ...(identifier === undefined ? {} : { identifier }),
      body: bodyLines.join(" "),
      deltaOperation,
      ...(parentRequirementIdentifier === undefined ? {} : { parentRequirementIdentifier }),
      provenance: { file, line: startLine },
    },
    startLine,
    endLine: endIndex,
    structuralFindings,
  };
}

/**
 * Extract a title and optional canonical identifier from a heading suffix string.
 *
 * @param raw - trimmed text after the heading prefix (e.g. after `"### Requirement:"`)
 * @returns title text, optional parsed identifier, and optional identifier parse error
 *
 * @remarks
 * Precondition: `raw` is the trimmed portion of a heading line after the type prefix.
 * Postcondition: `title` is always non-empty when the input is non-empty. If a bracketed
 * token is present but malformed, `identifierError` describes the issue and `identifier`
 * is undefined. A well-formed token yields `identifier` with no error.
 * Failure modes: none — pure computation.
 */
function parseTitledIdentifier(raw: string): {
  readonly title: string;
  readonly identifier?: string;
  readonly identifierError?: string;
} {
  const open = raw.lastIndexOf("[");
  const close = raw.lastIndexOf("]");
  if (open < 0 || close < 0 || close < open) {
    return { title: raw.trim() };
  }

  const token = raw.slice(open, close + 1);
  const parsed = parseCanonicalIdentifier(token);
  if (parsed === undefined) {
    return {
      title: raw.slice(0, open).trim(),
      identifierError: `Malformed identifier token: ${token}`,
    };
  }

  return {
    title: raw.slice(0, open).trim(),
    identifier: parsed,
  };
}

/** Negative-scenario indicators that distinguish unwanted-behavior from plain conditional EARS. */
const UNWANTED_BEHAVIOR_INDICATORS = [
  "NOT", "FAIL", "ERROR", "INVALID", "UNAVAILABLE", "UNAUTHORIZED",
  "TIMEOUT", "EXCEED", "CORRUPT", "MALFORM", "REJECT", "DENIED",
  "LOSS", "LOST", "UNABLE", "VIOLATION", "OVERFLOW", "UNDERFLOW",
] as const;

/**
 * Classify a requirement body into one of the recognized EARS patterns.
 *
 * @param body - the combined body text of the requirement
 * @returns the EARS classification for the requirement
 *
 * @remarks
 * Precondition: `body` is the trimmed, non-empty body text of a parsed requirement.
 * Postcondition: returns one of the recognized EARS types. The `"complex"` pattern
 * is checked before `"event-driven"` and `"state-driven"` so that WHILE+WHEN
 * combinations are not misclassified. The `"optional"` pattern is checked before
 * `"ubiquitous"` so that WHERE-gated requirements are distinguished from
 * unconditional obligations. The `"unwanted-behavior"` pattern is distinguished
 * from `"conditional"` by the presence of negative-scenario indicators between
 * `IF` and `THEN`.
 * Invariant: classification is purely textual — no external state is consulted.
 * Failure modes: none — pure computation.
 */
function classifyEarsType(body: string): ParsedRequirement["earsType"] {
  const normalized = body.trim().toUpperCase();
  // Complex: WHILE <precondition>, WHEN <trigger> — must be checked before
  // individual event-driven (WHEN) or state-driven (WHILE) patterns.
  if (normalized.includes("WHILE") && normalized.includes("WHEN") && normalized.includes("THE") && normalized.includes("SHALL")) {
    return "complex";
  }
  if (normalized.includes("WHEN") && normalized.includes("THE") && normalized.includes("SHALL")) {
    return "event-driven";
  }
  if (normalized.includes("WHILE") && normalized.includes("THE") && normalized.includes("SHALL")) {
    return "state-driven";
  }
  // Unwanted-behavior is a specialization of conditional: IF <negative condition> THEN ... SHALL.
  // Check for unwanted-behavior before plain conditional so the narrower match wins.
  if (normalized.includes("IF") && normalized.includes("THEN") && normalized.includes("SHALL")) {
    const ifIndex = normalized.indexOf("IF");
    const thenIndex = normalized.indexOf("THEN");
    // Extract the condition clause between IF and THEN for indicator scanning.
    const conditionClause = normalized.slice(ifIndex, thenIndex);
    const hasUnwantedIndicator = UNWANTED_BEHAVIOR_INDICATORS.some(
      (indicator) => conditionClause.includes(indicator),
    );
    return hasUnwantedIndicator ? "unwanted-behavior" : "conditional";
  }
  // Optional: WHERE <feature is included> — must be checked before ubiquitous
  // so that feature-gated requirements are not classified as unconditional.
  if (normalized.includes("WHERE") && normalized.includes("THE") && normalized.includes("SHALL")) {
    return "optional";
  }
  // Ubiquitous: unconditional obligation with no trigger keyword.
  if (normalized.includes("THE") && normalized.includes("SHALL")) {
    return "ubiquitous";
  }
  return "non-ears";
}
