/**
 * Supported OpenSpec document classifications.
 */
export type DocumentType = "proposal" | "design" | "spec" | "task";

import type { CapabilityName } from "./branded.js";
import type { Finding } from "./findings.js";

/** Exact UTF-16 source offset and one-based line/column in the original file. */
export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/** Half-open source range; end identifies the first character outside the range. */
export interface SourceSpan {
  readonly file: string;
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

/** Source-local identity; authored IDs do not replace this identity. */
export interface SourceReference {
  readonly file: string;
  readonly ordinal: number;
  readonly namespace?: string;
}

/** Source text retained independently of its supported formal meaning. */
export interface SourceFragment {
  readonly text: string;
  readonly span: SourceSpan;
}

/** Parsed clause with original span and offsets in the normalized statement. */
export interface EarsClause extends SourceFragment {
  readonly normalizedStart: number;
  readonly normalizedEnd: number;
}

/** Source-owned structural modal, independent of logical expression content. */
export type EarsModal = "SHALL" | "MUST" | "SHOULD" | "MAY";

/** Ordered EARS structure; response negation is applied by deterministic lowering. */
export interface EarsClauses {
  readonly form: Exclude<EarsType, "non-ears">;
  readonly subject: EarsClause;
  readonly state?: EarsClause;
  readonly trigger?: EarsClause;
  readonly condition?: EarsClause;
  readonly feature?: EarsClause;
  readonly modal: EarsModal;
  readonly negatedResponse: boolean;
  readonly response: EarsClause;
}

/** Structural failure with a precise original source range. */
export interface SurfaceIssue {
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

/** Total formal admission result; excluded statements remain in the source graph. */
export type FormalDisposition =
  | { readonly kind: "eligible"; readonly representation: "ears" | "example" | "prohibited-example" }
  | { readonly kind: "excluded"; readonly reasons: readonly SurfaceIssue[] };

/** Explicit scenario interpretation. Ordinary EARS scenarios are refinements. */
export type ScenarioKind = "refinement" | "example" | "prohibited-example";

/** Separated statement and fields with a reversible normalized-text source map. */
export interface SurfaceStatement {
  readonly source: SourceReference;
  readonly sourceSha256?: string;
  readonly text: string;
  readonly span: SourceSpan;
  /** One original position per normalized UTF-16 offset, including the end. */
  readonly sourceMap: readonly SourcePosition[];
  readonly clauses?: EarsClauses;
  readonly disposition: FormalDisposition;
  readonly scenarioKind: ScenarioKind;
  readonly fields: Readonly<Partial<Record<"justification" | "postcondition" | "input" | "expected" | "forbidden", SourceFragment>>>;
  readonly supplementary: readonly SourceFragment[];
  readonly issues: readonly SurfaceIssue[];
}

/**
 * One discovered input document with deterministic classification.
 */
export interface CatalogDocument {
  readonly path: string;
  readonly type: DocumentType;
  readonly capability?: CapabilityName;
  readonly source: "final" | "delta";
}

/**
 * Active catalog used by downstream parser and analysis phases.
 */
export interface Catalog {
  readonly documents: readonly CatalogDocument[];
  readonly skippedDeltaConflicts: readonly {
    readonly capability: CapabilityName;
    readonly skippedPath: string;
    readonly keptPath: string;
  }[];
}

/**
 * Source location identifying the file and line number from which a parsed element originates.
 *
 * @remarks
 * Invariant: `file` is a non-empty relative path within the workspace.
 * Invariant: `line` is a 1-based positive integer.
 */
export interface LineProvenance {
  readonly file: string;
  readonly line: number;
}

/**
 * A contiguous section extracted from a Markdown document, bounded by heading markers.
 *
 * @remarks
 * Invariant: `startLine <= endLine`.
 * Invariant: `lines.length === endLine - startLine + 1` (inclusive range).
 * Invariant: `heading` is the normalized text of the section heading.
 */
export interface ParsedSection {
  readonly heading: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: readonly string[];
}

/**
 * A line from a document that was not consumed by any structural parser rule.
 *
 * @remarks
 * Retained for diagnostic reporting and completeness auditing.
 */
export interface UnparsedLine {
  readonly text: string;
  readonly provenance: LineProvenance;
}

/**
 * Parsed representation of an OpenSpec proposal document.
 *
 * @remarks
 * Invariant: `sections` contains only headings found in the source document.
 * Invariant: `file` is a non-empty path identifying the source document.
 */
export interface ParsedProposal {
  readonly file: string;
  readonly sections: ReadonlyMap<string, ParsedSection>;
  readonly unparsed: readonly UnparsedLine[];
}

/**
 * Parsed representation of an OpenSpec design document.
 *
 * @remarks
 * Invariant: `sections` contains only headings found in the source document.
 * Invariant: `file` is a non-empty path identifying the source document.
 */
export interface ParsedDesign {
  readonly file: string;
  readonly sections: ReadonlyMap<string, ParsedSection>;
  readonly unparsed: readonly UnparsedLine[];
}

/**
 * Closed domain of EARS (Easy Approach to Requirements Syntax) requirement types.
 *
 * @remarks
 * - `"event-driven"` — triggered by an event ("When X, the system shall…").
 * - `"state-driven"` — active while a state holds ("While X, the system shall…").
 * - `"complex"` — both state and event required ("While X, when Y, the system shall…").
 * - `"unwanted-behavior"` — specifies response to an undesirable condition ("If X, then the system shall…").
 * - `"optional"` — optional or configurable behavior ("Where X is included, the system shall…").
 * - `"ubiquitous"` — unconditional obligation ("The system shall…").
 * - `"non-ears"` — requirement that does not conform to any EARS pattern.
 */
export type EarsType = "event-driven" | "state-driven" | "complex" | "unwanted-behavior" | "optional" | "ubiquitous" | "non-ears";

/**
 * A single requirement extracted from a spec document.
 *
 * @remarks
 * Invariant: `body` is a non-empty string containing the requirement text.
 * Invariant: `earsType` classifies the requirement per the EARS taxonomy.
 * If `identifier` is present, it is unique within the containing spec.
 */
export interface ParsedRequirement {
  readonly title: string;
  readonly identifier?: string;
  readonly body: string;
  readonly earsType: EarsType;
  readonly deltaOperation: DeltaOperation;
  readonly references: readonly string[];
  readonly provenance: LineProvenance;
  /** Always produced by the source parser; optional for externally constructed models. */
  readonly surface?: SurfaceStatement;
}

/**
 * A single scenario (Given/When/Then or freeform) extracted from a spec document.
 *
 * @remarks
 * Invariant: `body` is a non-empty string containing the scenario text.
 * If `identifier` is present, it is unique within the containing spec.
 */
export interface ParsedScenario {
  readonly title: string;
  readonly identifier?: string;
  readonly body: string;
  readonly deltaOperation: DeltaOperation;
  readonly parentRequirementIdentifier?: string;
  readonly provenance: LineProvenance;
  /** Always produced by the source parser; optional for externally constructed models. */
  readonly surface?: SurfaceStatement;
}

/**
 * Closed domain of per-item delta semantics used during capability merge.
 */
export type DeltaOperation = "base" | "pre-section" | "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED";

/**
 * Parsed representation of an OpenSpec specification document.
 *
 * @remarks
 * Invariant: `file` is a non-empty path identifying the source document.
 * Invariant: `structuralFindings` captures parsing-level issues found during extraction.
 * `deltaSections` is non-empty only when the spec comes from a delta source.
 */
export interface ParsedSpec {
  readonly file: string;
  readonly requirements: readonly ParsedRequirement[];
  readonly scenarios: readonly ParsedScenario[];
  readonly deltaSections: readonly ("ADDED" | "MODIFIED" | "REMOVED" | "RENAMED")[];
  readonly structuralFindings: readonly {
    readonly message: string;
    readonly provenance: LineProvenance;
  }[];
  readonly unparsed: readonly UnparsedLine[];
}

/**
 * Active per-capability merged analysis view produced from finalized and delta specs.
 */
export interface MergedCapabilitySpec {
  readonly capability: CapabilityName;
  readonly sourceFiles: readonly string[];
  readonly logicalFile: string;
  readonly requirements: readonly ParsedRequirement[];
  readonly scenarios: readonly ParsedScenario[];
  readonly findings: readonly Finding[];
}

/**
 * A single task item (checkbox line) extracted from a task document.
 *
 * @remarks
 * Invariant: `text` is a non-empty string containing the task description.
 * `done` reflects whether the Markdown checkbox was checked (`[x]`).
 */
export interface ParsedTaskItem {
  readonly text: string;
  readonly done: boolean;
  readonly provenance: LineProvenance;
}

/**
 * A named group of task items under a common heading.
 *
 * @remarks
 * Invariant: `title` is the heading text that introduced this group.
 * Invariant: `tasks` preserves document order.
 */
export interface ParsedTaskGroup {
  readonly title: string;
  readonly tasks: readonly ParsedTaskItem[];
}

/**
 * Parsed representation of an OpenSpec task document.
 *
 * @remarks
 * Invariant: `file` is a non-empty path identifying the source document.
 * Invariant: `groups` preserves document order.
 * `changeSummaries` maps heading titles to the summary lines found beneath them.
 */
export interface ParsedTaskDocument {
  readonly file: string;
  readonly groups: readonly ParsedTaskGroup[];
  readonly changeSummaries: ReadonlyMap<string, readonly string[]>;
  readonly unparsed: readonly UnparsedLine[];
}
