/**
 * Closed domain of finding severity levels, ordered from most to least severe.
 *
 * @remarks
 * - `"error"` — a violation of a mandatory requirement.
 * - `"warning"` — a violation of an advisory requirement.
 * - `"info"` — an informational observation that does not indicate a defect.
 */
export type FindingSeverity = "error" | "warning" | "info";

/**
 * Location metadata that traces a finding back to its source document.
 *
 * @remarks
 * Invariant: `file` is always a non-empty string.
 * `heading` and `line` are optional and provide increasing precision.
 */
export interface FindingProvenance {
  readonly file: string;
  readonly heading?: string;
  readonly line?: number;
}

/**
 * A single piece of supporting evidence attached to a finding.
 *
 * @remarks
 * `kind` discriminates the evidence type (e.g., `"claim_text"`, `"reference"`).
 * `value` is the raw evidence content.
 */
export interface FindingEvidence {
  readonly kind: string;
  readonly value: string;
}

/**
 * A single diagnostic finding produced by the analysis pipeline.
 *
 * @remarks
 * Invariant: `category` is a dot-separated hierarchical identifier (e.g., `"claim_graph.orphaned_claim"`).
 * Invariant: `rationale` explains why the finding exists; it is always non-empty.
 * Invariant: `evidence` is non-empty when supporting context is available.
 * `suggestion` provides an actionable remediation hint when one can be inferred.
 * `relatedClaimIdentifiers` links the finding to specific claims in the claim graph.
 *
 * Required by spec [RAE-FINDING-SHAPE]: severity, category, provenance,
 * description, rationale, and evidence are all mandatory fields.
 */
export interface Finding {
  readonly severity: FindingSeverity;
  readonly category: string;
  readonly provenance: FindingProvenance;
  readonly description: string;
  readonly rationale: string;
  readonly evidence: readonly FindingEvidence[];
  readonly suggestion?: string;
  readonly relatedClaimIdentifiers?: readonly string[];
}
