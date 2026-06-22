/**
 * Builds and queries the claim graph — a unified structure linking requirements,
 * scenarios, proposals, designs, and task evidence into traceable claims.
 *
 * Domain layer — core data structure for cross-artifact consistency analysis.
 * Exports: ClaimKind, Claim, ClaimGraph, buildClaimGraph.
 */
import type {
  MergedCapabilitySpec,
  ParsedDesign,
  ParsedProposal,
  ParsedRequirement,
  ParsedScenario,
  ParsedSpec,
  ParsedTaskDocument,
} from "./model.js";
import type { Finding, FindingSeverity } from "./findings.js";
import { toClaimId, type CapabilityName, type ClaimId } from "./branded.js";

/**
 * Closed domain of claim classifications within the claim graph.
 *
 * @remarks
 * - `"requirement"` — derived from a spec requirement.
 * - `"scenario"` — derived from a spec scenario.
 * - `"proposal_property"` — derived from a proposal section.
 * - `"design_property"` — derived from a design section.
 * - `"assumption"` — an assumed context from the proposal.
 * - `"invariant"` — a stated invariant from the proposal.
 * - `"failure_mode"` — a documented failure mode from the proposal.
 * - `"task_evidence"` — evidence of implementation from a task document.
 *
 * @example
 * ```ts
 * function describeClaim(kind: ClaimKind): string {
 *   switch (kind) {
 *     case "requirement": return "spec requirement";
 *     case "scenario": return "spec scenario";
 *     case "proposal_property": return "proposal property";
 *     case "design_property": return "design property";
 *     case "assumption": return "assumed context";
 *     case "invariant": return "stated invariant";
 *     case "failure_mode": return "documented failure mode";
 *     case "task_evidence": return "implementation evidence";
 *   }
 * }
 * ```
 */
export type ClaimKind =
  | "requirement"
  | "scenario"
  | "proposal_property"
  | "design_property"
  | "assumption"
  | "invariant"
  | "failure_mode"
  | "task_evidence";

/**
 * Closed domain of obligation levels determining the severity of findings
 * raised when a claim is unsatisfied.
 *
 * @remarks
 * - `"mandatory"` — maps to error-level findings.
 * - `"advisory"` — maps to warning-level findings.
 * - `"informational"` — maps to info-level findings.
 */
export type ObligationLevel = "mandatory" | "advisory" | "informational";

/**
 * A single typed claim extracted from an OpenSpec artifact with full provenance.
 *
 * @remarks
 * Invariant: `text` is a non-empty string.
 * Invariant: `provenance.file` is a non-empty path.
 * If `id` is present, it is a branded {@link ClaimId} unique within the graph.
 *
 * @example
 * ```ts
 * const claim: Claim = {
 *   id: toClaimId("AUTH-SESSION-001"),
 *   kind: "requirement",
 *   text: "The system SHALL expire sessions after 30 minutes of inactivity.",
 *   obligation: "mandatory",
 *   provenance: { file: "specs/auth.md", heading: "Session Management", line: 42 },
 *   references: ["AUTH-LOGIN-002"],
 * };
 * ```
 */
export interface Claim {
  readonly id?: ClaimId;
  readonly kind: ClaimKind;
  readonly text: string;
  readonly obligation: ObligationLevel;
  readonly provenance: {
    readonly file: string;
    readonly heading?: string;
    readonly line?: number;
  };
  readonly references: readonly string[];
  readonly capability?: CapabilityName;
}

/**
 * The complete set of claims extracted from all input artifacts.
 *
 * @remarks
 * Invariant: `claims` preserves extraction order (proposal, design, specs, tasks).
 *
 * @example
 * ```ts
 * const graph: ClaimGraph = { claims: [claim1, claim2] };
 * const mandatory = graph.claims.filter(c => c.obligation === "mandatory");
 * const requirements = graph.claims.filter(c => c.kind === "requirement");
 * ```
 */
export interface ClaimGraph {
  readonly claims: readonly Claim[];
}

/**
 * Result of building the claim graph: the graph itself plus any findings
 * discovered during construction (e.g., orphaned claims).
 */
export interface ClaimGraphOutput {
  readonly graph: ClaimGraph;
  readonly findings: readonly Finding[];
}

/**
 * Build typed claims from parsed artifacts with mandatory provenance attachment.
 *
 * @param input - The parsed OpenSpec artifacts to extract claims from.
 * @returns A {@link ClaimGraphOutput} containing all extracted claims and any
 *   construction-time findings (e.g., orphaned claims with missing provenance).
 *
 * @remarks
 * Precondition: each parsed artifact in `input` must have valid provenance.
 * Postcondition: every claim in the returned graph has a non-empty `provenance.file`,
 *   or an error finding is emitted for the offending claim.
 * Claims are appended in deterministic order: proposal, design, specs, tasks.
 *
 * @example
 * ```ts
 * const { graph, findings } = buildClaimGraph({
 *   specs: [parsedAuthSpec, parsedStorageSpec],
 *   proposal: parsedProposal,
 *   design: parsedDesign,
 * });
 * console.log(`Extracted ${graph.claims.length} claims, ${findings.length} issues`);
 * ```
 */
export function buildClaimGraph(input: {
  readonly proposal?: ParsedProposal;
  readonly design?: ParsedDesign;
  readonly specs: readonly ParsedSpec[];
  readonly mergedSpecs?: readonly MergedCapabilitySpec[];
  readonly tasks?: ParsedTaskDocument;
}): ClaimGraphOutput {
  const claims: Claim[] = [];
  const findings: Finding[] = [];

  // --- Allocation strategy note ---
  // Each extract function allocates a fresh local array, populates it, and returns
  // it. The caller spreads the result into `claims` via `push(...extracted)`.
  //
  // This produces small intermediate arrays (typically 5–50 elements each, one per
  // artifact type) that are immediately eligible for GC. An alternative design —
  // passing `claims` as a mutable accumulator — would eliminate these allocations
  // but sacrifices two properties the style guide (typescript_style.md) prioritizes:
  //
  // 1. Safety: Each extract function is a pure transformation (input → output) with
  //    no side effects on external state. This makes them independently testable and
  //    composable without reasoning about shared mutable references.
  //
  // 2. Readability: Return-value semantics make data flow explicit at the call site.
  //    The reader sees exactly what each function contributes without tracing an
  //    accumulator parameter through multiple frames.
  //
  // The allocations are bounded (one per artifact type), occur exactly once per
  // pipeline run, and are well within V8's TurboFan fast-path for small arrays.
  // Per the style guide's Safety > Performance ordering, this tradeoff is correct.

  if (input.proposal !== undefined) {
    claims.push(...extractProposalClaims(input.proposal));
  }
  if (input.design !== undefined) {
    claims.push(...extractDesignClaims(input.design));
  }
  if (input.mergedSpecs !== undefined && input.mergedSpecs.length > 0) {
    for (const mergedSpec of input.mergedSpecs) {
      claims.push(...extractMergedSpecClaims(mergedSpec));
    }

    // Guard: detect raw specs that are not represented in any merged spec's
    // sourceFiles. If mergedSpecs is non-empty, all raw spec claims come from the
    // merged view — any uncovered raw spec has its claims silently dropped. Emit a
    // warning so this does not go unnoticed if path conventions are ever relaxed.
    const coveredFiles = new Set(input.mergedSpecs.flatMap((ms) => ms.sourceFiles));
    for (const spec of input.specs) {
      if (!coveredFiles.has(spec.file)) {
        findings.push({
          severity: "warning",
          category: "claim_graph.unmerged_spec_ignored",
          provenance: { file: spec.file },
          description: `Spec file "${spec.file}" is not covered by any merged capability and its claims were not included in the graph`,
          rationale: "When merged specs are present, raw spec claims are replaced by the merged view. A spec file missing from all MergedCapabilitySpec.sourceFiles indicates a gap in capability assignment.",
          evidence: [{ kind: "spec_file", value: spec.file }],
        });
      }
    }
  } else {
    for (const spec of input.specs) {
      claims.push(...extractSpecClaims(spec));
    }
  }
  if (input.tasks !== undefined) {
    claims.push(...extractTaskClaims(input.tasks));
  }

  findings.push(...detectOrphanClaims(claims));
  return { graph: { claims }, findings };
}

/**
 * Extract claims from a parsed spec document's requirements and scenarios.
 *
 * @param spec - The parsed spec to extract claims from.
 * @returns Claims derived from all requirements and scenarios in the spec.
 *
 * @remarks
 * Postcondition: returned claims preserve document order (requirements first, then scenarios).
 */
function extractSpecClaims(spec: ParsedSpec): readonly Claim[] {
  const claims: Claim[] = [];

  for (const requirement of spec.requirements) {
    claims.push(claimFromRequirement(requirement));
  }
  for (const scenario of spec.scenarios) {
    claims.push(claimFromScenario(scenario));
  }

  return claims;
}

function extractMergedSpecClaims(spec: MergedCapabilitySpec): readonly Claim[] {
  const claims: Claim[] = [];

  for (const requirement of spec.requirements) {
    claims.push(claimFromRequirement(requirement, spec.capability));
  }
  for (const scenario of spec.scenarios) {
    claims.push(claimFromScenario(scenario, spec.capability));
  }

  return claims;
}

/**
 * Convert a single parsed requirement into a typed claim.
 *
 * @param requirement - The parsed requirement to convert.
 * @returns A claim with kind `"requirement"` and obligation derived from RFC 2119 keywords.
 *
 * @remarks
 * Postcondition: the claim's `id` is set only when `requirement.identifier` is defined.
 */
function claimFromRequirement(requirement: ParsedRequirement, capability?: CapabilityName): Claim {
  return {
    ...(requirement.identifier === undefined ? {} : { id: toClaimId(requirement.identifier) }),
    kind: "requirement",
    text: requirement.body,
    obligation: deriveObligation(requirement.body),
    provenance: requirement.provenance,
    references: requirement.references,
    ...(capability === undefined ? {} : { capability }),
  };
}

/**
 * Convert a single parsed scenario into a typed claim.
 *
 * @param scenario - The parsed scenario to convert.
 * @returns A claim with kind `"scenario"` and obligation derived from RFC 2119 keywords.
 *
 * @remarks
 * Postcondition: the claim's `id` is set only when `scenario.identifier` is defined.
 * Postcondition: `references` is always empty for scenario-derived claims.
 */
function claimFromScenario(scenario: ParsedScenario, capability?: CapabilityName): Claim {
  return {
    ...(scenario.identifier === undefined ? {} : { id: toClaimId(scenario.identifier) }),
    kind: "scenario",
    text: scenario.body,
    obligation: deriveObligation(scenario.body),
    provenance: scenario.provenance,
    references: [],
    ...(capability === undefined ? {} : { capability }),
  };
}

/**
 * Extract claims from a parsed proposal, mapping well-known section headings to
 * claim kinds and obligation levels.
 *
 * @param proposal - The parsed proposal document.
 * @returns Claims derived from recognized proposal sections; unrecognized sections are skipped.
 *
 * @remarks
 * Postcondition: only non-empty trimmed lines produce claims.
 * The section-to-kind mapping is a closed internal policy.
 */
function extractProposalClaims(proposal: ParsedProposal): readonly Claim[] {
  const claims: Claim[] = [];
  const sectionMap: Record<string, { readonly kind: ClaimKind; readonly obligation: ObligationLevel }> = {
    "Scope": { kind: "proposal_property", obligation: "informational" },
    "Capabilities": { kind: "proposal_property", obligation: "informational" },
    "Preconditions, Postconditions, and Invariants": { kind: "invariant", obligation: "mandatory" },
    "Failure Modes": { kind: "failure_mode", obligation: "advisory" },
    "Context": { kind: "assumption", obligation: "informational" },
  };

  for (const [heading, section] of proposal.sections) {
    const descriptor = sectionMap[heading];
    if (descriptor === undefined) {
      continue;
    }

    for (const line of section.lines.map((value) => value.trim()).filter((value) => value.length > 0)) {
      claims.push({
        kind: descriptor.kind,
        text: line,
        obligation: descriptor.obligation,
        provenance: {
          file: proposal.file,
          heading,
          line: section.startLine,
        },
        references: [],
      });
    }
  }

  return claims;
}

/**
 * Extract claims from a parsed design document, treating every non-empty line
 * in every section as an informational design property claim.
 *
 * @param design - The parsed design document.
 * @returns Claims with kind `"design_property"` and obligation `"informational"`.
 *
 * @remarks
 * Postcondition: only non-empty trimmed lines produce claims.
 */
function extractDesignClaims(design: ParsedDesign): readonly Claim[] {
  const claims: Claim[] = [];
  for (const [heading, section] of design.sections) {
    for (const line of section.lines.map((value) => value.trim()).filter((value) => value.length > 0)) {
      claims.push({
        kind: "design_property",
        text: line,
        obligation: "informational",
        provenance: {
          file: design.file,
          heading,
          line: section.startLine,
        },
        references: [],
      });
    }
  }
  return claims;
}

/**
 * Extract claims from a parsed task document, including completed task items
 * and change summary lines.
 *
 * @param tasks - The parsed task document.
 * @returns Claims with kind `"task_evidence"` and obligation `"informational"`.
 *
 * @remarks
 * Precondition: `tasks` is a fully-parsed task document.
 * Postcondition: only completed (`done === true`) task items produce claims.
 * Change summary lines are included unconditionally.
 */
function extractTaskClaims(tasks: ParsedTaskDocument): readonly Claim[] {
  const claims: Claim[] = [];
  for (const group of tasks.groups) {
    for (const task of group.tasks) {
      if (!task.done) {
        continue;
      }
      claims.push({
        kind: "task_evidence",
        text: task.text,
        obligation: "informational",
        provenance: {
          file: tasks.file,
          heading: group.title,
          line: task.provenance.line,
        },
        references: [],
      });
    }
  }

  for (const [summaryTitle, lines] of tasks.changeSummaries) {
    for (const line of lines) {
      claims.push({
        kind: "task_evidence",
        text: line,
        obligation: "informational",
        provenance: {
          file: tasks.file,
          heading: summaryTitle,
        },
        references: [],
      });
    }
  }

  return claims;
}

/**
 * Derive the obligation level from claim text using RFC 2119 keyword detection.
 *
 * @param text - The claim body text to analyze.
 * @returns `"mandatory"` if text contains "SHALL", `"advisory"` if "SHOULD",
 *   otherwise `"informational"`.
 *
 * @remarks
 * The comparison is case-insensitive. First match wins (SHALL takes precedence over SHOULD).
 */
function deriveObligation(text: string): ObligationLevel {
  const normalized = text.toUpperCase();
  if (normalized.includes("SHALL")) {
    return "mandatory";
  }
  if (normalized.includes("SHOULD")) {
    return "advisory";
  }
  return "informational";
}

/**
 * Detect claims with missing provenance (empty `file` field) and emit error findings.
 *
 * @param claims - The complete list of extracted claims to validate.
 * @returns Findings for each claim whose `provenance.file` is empty.
 *
 * @remarks
 * Postcondition: claims with a non-empty `provenance.file` never produce findings.
 */
function detectOrphanClaims(claims: readonly Claim[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const claim of claims) {
    if (claim.provenance.file.length > 0) {
      continue;
    }

    findings.push({
      severity: "error",
      category: "claim_graph.orphaned_claim",
      provenance: {
        file: "<unknown>",
        ...(claim.provenance.heading === undefined ? {} : { heading: claim.provenance.heading }),
      },
      description: "Claim missing provenance",
      rationale: "An orphaned claim cannot be traced back to its source document, making it impossible to verify correctness or detect when the upstream specification changes.",
      evidence: [{ kind: "claim_text", value: claim.text }],
      ...(claim.id === undefined ? {} : { relatedClaimIdentifiers: [claim.id] }),
    });
  }

  return findings;
}

/**
 * Map an obligation level to its corresponding finding severity.
 *
 * @param obligation - The obligation level to map.
 * @returns The corresponding {@link FindingSeverity}: `"error"` for mandatory,
 *   `"warning"` for advisory, `"info"` for informational.
 *
 * @remarks
 * This is a total function over the closed {@link ObligationLevel} domain.
 */
export function severityForObligation(obligation: ObligationLevel): FindingSeverity {
  switch (obligation) {
    case "mandatory":
      return "error";
    case "advisory":
      return "warning";
    case "informational":
      return "info";
  }
}
