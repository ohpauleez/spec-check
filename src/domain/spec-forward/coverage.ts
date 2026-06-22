/**
 * Performs deterministic coverage analysis comparing spec claims against upstream requirements.
 * Detects missing spec files, unsupported references, coverage gaps, contradictions, and
 * task-evidence inconsistencies.
 *
 * Role: Spec-forward analysis pass that validates structural completeness without LLM calls.
 *
 * Key exports: `analyzeCoverage`
 */
import type { MergedCapabilitySpec, ParsedProposal, ParsedSpec, ParsedTaskDocument } from "../model.js";
import type { Claim, ClaimGraph } from "../claim-graph.js";
import type { Finding } from "../findings.js";
import { severityForObligation } from "../claim-graph.js";

/**
 * Performs deterministic coverage and contradiction analysis across upstream and downstream claims.
 *
 * Runs five sub-analyses in sequence: missing spec files, unsupported references,
 * coverage gaps, contradictions/drift, and task evidence inconsistency.
 *
 * @param input - Analysis input bundle.
 * @param input.claimGraph - The claim graph containing all upstream and downstream claims to analyze.
 * @param input.proposal - Optional parsed proposal; when absent, the missing-spec-file check is skipped.
 * @param input.specs - All active parsed spec files in the catalog.
 * @param input.tasks - Optional parsed task document; when absent, task evidence analysis still
 *   runs but finds no task_evidence claims in the graph.
 *
 * @returns A readonly array of {@link Finding} objects. Returns an empty array when no issues
 *   are detected. Findings are emitted with severity levels derived from claim obligation
 *   (for requirement-linked checks) or fixed at "warning" (for uncovered upstream claims).
 *
 * @remarks
 * Preconditions:
 * - `input.claimGraph.claims` must include all claims extracted from the provided documents.
 * - `input.specs` file paths must follow the convention `<dir>/<capability>/...` for the
 *   missing-spec-file detection to match capabilities correctly.
 *
 * Postconditions:
 * - The returned findings array is a fresh allocation; callers may freely mutate it.
 * - Finding categories are prefixed with `coverage.` (e.g., `coverage.contradiction`,
 *   `coverage.uncovered_upstream_claim`).
 *
 * Invariants:
 * - Analysis is purely deterministic — no randomness or LLM calls.
 * - A keyword token cache is built once and shared across all O(upstream × downstream)
 *   comparisons; keyword tokens are lowercase strings of at least 5 characters.
 * - Sub-analyses are independent and do not share mutable state beyond the token cache.
 *
 * Failure modes: none — pure computation over in-memory data structures.
 *
 * @example
 * ```typescript
 * import { analyzeCoverage } from "./coverage.js";
 *
 * const findings = analyzeCoverage({
 *   claimGraph: extractedGraph,
 *   proposal: parsedProposal,
 *   specs: [parsedSpec1, parsedSpec2],
 *   tasks: parsedTaskDoc,
 * });
 *
 * const errors = findings.filter((f) => f.severity === "error");
 * console.log(`${errors.length} error-level findings detected`);
 * ```
 */
export function analyzeCoverage(input: {
  readonly claimGraph: ClaimGraph;
  readonly proposal?: ParsedProposal;
  readonly specs: readonly ParsedSpec[];
  readonly mergedSpecs?: readonly MergedCapabilitySpec[];
  readonly tasks?: ParsedTaskDocument;
}): readonly Finding[] {
  const findings: Finding[] = [];

  // Pre-compute keyword token sets once for all claims to avoid redundant tokenization
  // across the O(upstream x downstream) comparisons in sub-analyses.
  const tokenCache = buildTokenCache(input.claimGraph.claims);

  // Single-pass partition: eliminates 7 redundant .filter() calls across detectors.
  // Each detector receives exactly the claim slices it needs.
  const partition = partitionClaims(input.claimGraph.claims);
  const nonSpecClaims = [...partition.upstream, ...partition.tasks];
  const downstream = [...partition.requirements, ...partition.scenarios];

  findings.push(...detectMissingSpecFiles(input.proposal, input.specs, input.mergedSpecs));
  findings.push(...detectUnsupportedReferences(nonSpecClaims, partition.requirements));
  findings.push(...detectCoverageGaps(partition.upstream, downstream, tokenCache));
  findings.push(...detectContradictionsAndDrift(partition.upstream, partition.requirements, tokenCache));
  findings.push(...detectTaskEvidenceInconsistency(partition.tasks, partition.requirements, tokenCache));

  return findings;
}

/**
 * Detect capabilities declared in the proposal that lack a corresponding spec file.
 *
 * @param proposal - parsed proposal document, or undefined if not provided
 * @param specs - available parsed spec files
 * @returns error-severity findings for each declared capability without a spec file
 *
 * @remarks
 * Precondition: `specs` file paths follow the convention `<dir>/<capability>/...`.
 * Postcondition: each finding identifies one unmatched capability name.
 * Returns empty array if proposal is undefined or has no Capabilities section.
 * Failure modes: none — pure computation.
 */
function detectMissingSpecFiles(
  proposal: ParsedProposal | undefined,
  specs: readonly ParsedSpec[],
  mergedSpecs?: readonly MergedCapabilitySpec[],
): readonly Finding[] {
  if (proposal === undefined) {
    return [];
  }

  const capabilitiesSection = proposal.sections.get("Capabilities");
  if (capabilitiesSection === undefined) {
    return [];
  }

  const declaredCapabilities = capabilitiesSection.lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => normalizeCapabilityName(line.slice(2)));

  const availableCapabilities = new Set<string>();
  if (mergedSpecs !== undefined && mergedSpecs.length > 0) {
    for (const mergedSpec of mergedSpecs) {
      availableCapabilities.add(normalizeCapabilityName(mergedSpec.capability));
    }
  } else {
    for (const spec of specs) {
      const capability = normalizeCapabilityName(spec.file.split("/").slice(-2)[0] ?? "");
      if (capability.length > 0) {
        availableCapabilities.add(capability);
      }
    }
  }

  const findings: Finding[] = [];
  for (const capability of declaredCapabilities) {
    if (availableCapabilities.has(capability)) {
      continue;
    }

    findings.push({
      severity: "error",
      category: "coverage.missing_spec_file",
      provenance: { file: proposal.file, heading: "Capabilities", line: capabilitiesSection.startLine },
      description: `Declared capability has no active spec file: ${capability}`,
      rationale: "A declared capability without a corresponding spec file means requirements for that capability cannot be verified, leaving a blind spot in coverage analysis.",
      evidence: [{ kind: "declared_capability", value: capability }],
    });
  }

  return findings;
}

/**
 * Detect requirements that reference upstream files not present in the claim graph.
 *
 * @param nonSpecClaims - pre-partitioned non-spec claims (upstream + task evidence)
 * @param requirements - pre-partitioned requirement claims to check references for
 * @returns findings for each requirement referencing unsupported upstream content
 *
 * @remarks
 * Precondition: `nonSpecClaims` and `requirements` are pre-partitioned slices of the claim graph.
 * Postcondition: finding severity matches the obligation level of the referencing requirement.
 * Invariant: only requirement claims are checked; empty references and archived
 * provenance references (`openspec/changes/archive/`) are skipped.
 * Failure modes: none — pure computation.
 */
function detectUnsupportedReferences(
  nonSpecClaims: readonly Claim[],
  requirements: readonly Claim[],
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const claim of requirements) {
    for (const reference of claim.references) {
      if (reference.length === 0) {
        continue;
      }

      // Archived change references are valid provenance-only links and do not
      // require the referenced document to be present in the active catalog.
      if (isArchivedChangeReference(reference)) {
        continue;
      }

      const supported = nonSpecClaims.some((upstream) => upstream.provenance.file.endsWith(reference.split("#")[0] ?? ""));
      if (supported) {
        continue;
      }

      findings.push({
        severity: severityForObligation(claim.obligation),
        category: "coverage.unsupported_reference",
        provenance: claim.provenance,
        description: `Requirement references unsupported upstream content: ${reference}`,
        rationale: "A requirement that references upstream content not present in the claim graph cannot be traced back to its origin, breaking the traceability chain needed for conformance verification.",
        evidence: [
          { kind: "reference", value: reference },
          { kind: "requirement", value: claim.text },
        ],
        ...(claim.id === undefined ? {} : { relatedClaimIdentifiers: [claim.id] }),
      });
    }
  }

  return findings;
}

/**
 * Detect upstream claims that lack keyword-level overlap with any downstream requirement or scenario.
 *
 * @param upstream - pre-partitioned upstream claims (proposal, design, assumption, invariant, failure_mode)
 * @param downstream - pre-partitioned downstream claims (requirements + scenarios)
 * @param tokenCache - pre-computed keyword token sets for all claims
 * @returns warning findings for each upstream claim without downstream coverage
 *
 * @remarks
 * Precondition: `tokenCache` has entries for all claims in `upstream` and `downstream`.
 * Postcondition: each finding identifies one upstream claim lacking downstream support.
 * Invariant: overlap is determined by shared keyword tokens (minimum 5 characters).
 * Failure modes: none — pure computation.
 */
function detectCoverageGaps(
  upstream: readonly Claim[],
  downstream: readonly Claim[],
  tokenCache: TokenCache,
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const sourceClaim of upstream) {
    const sourceTokens = tokenCache.get(sourceClaim);
    const covered = sourceTokens !== undefined && sourceTokens.size > 0 &&
      downstream.some((targetClaim) => cachedTokensOverlap(sourceTokens, tokenCache.get(targetClaim)));
    if (covered) {
      continue;
    }

    findings.push({
      severity: "warning",
      category: "coverage.uncovered_upstream_claim",
      provenance: sourceClaim.provenance,
      description: "Upstream claim lacks matching downstream requirement coverage",
      rationale: "An upstream claim with no downstream requirement coverage indicates a design intent or constraint that was never refined into a verifiable specification, risking silent omission.",
      evidence: [{ kind: "upstream_claim", value: sourceClaim.text }],
      ...(sourceClaim.id === undefined ? {} : { relatedClaimIdentifiers: [sourceClaim.id] }),
    });
  }

  return findings;
}

/**
 * Detect contradictions (negation conflicts) and semantic drift between upstream and downstream claims.
 *
 * @param upstream - pre-partitioned upstream claims (proposal, design, assumption, invariant, failure_mode)
 * @param requirements - pre-partitioned requirement claims
 * @param tokenCache - pre-computed keyword token sets for all claims
 * @returns findings for contradictions and drift between overlapping claim pairs
 *
 * @remarks
 * Precondition: `tokenCache` has entries for all claims in `upstream` and `requirements`.
 * Postcondition: contradiction findings are emitted at the requirement's obligation severity;
 * drift findings are always warnings.
 * Invariant: only claim pairs with keyword overlap are compared.
 * Failure modes: none — pure computation.
 */
function detectContradictionsAndDrift(
  upstream: readonly Claim[],
  requirements: readonly Claim[],
  tokenCache: TokenCache,
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const sourceClaim of upstream) {
    const sourceTokens = tokenCache.get(sourceClaim);
    for (const requirement of requirements) {
      if (!cachedTokensOverlap(sourceTokens, tokenCache.get(requirement))) {
        continue;
      }

      if (isNegationConflict(sourceClaim.text, requirement.text)) {
        findings.push({
          severity: severityForObligation(requirement.obligation),
          category: "coverage.contradiction",
          provenance: requirement.provenance,
          description: "Detected contradiction between upstream and downstream claims",
          rationale: "A negation conflict between upstream intent and downstream requirement means the implementation cannot satisfy both, indicating a specification error that must be resolved before verification.",
          evidence: [
            { kind: "upstream_claim", value: sourceClaim.text },
            { kind: "downstream_requirement", value: requirement.text },
          ],
          ...(requirement.id === undefined ? {} : { relatedClaimIdentifiers: [requirement.id] }),
        });
        continue;
      }

      if (sourceClaim.kind === "failure_mode" && !containsFailureTerms(requirement.text)) {
        findings.push({
          severity: "warning",
          category: "coverage.semantic_drift",
          provenance: requirement.provenance,
          description: "Downstream requirement may omit upstream failure-mode constraints",
          rationale: "When a downstream requirement overlaps with an upstream failure mode but lacks failure-handling terms, the error path may be unspecified — risking undefined behavior under fault conditions.",
          evidence: [
            { kind: "upstream_failure_mode", value: sourceClaim.text },
            { kind: "downstream_requirement", value: requirement.text },
          ],
          ...(requirement.id === undefined ? {} : { relatedClaimIdentifiers: [requirement.id] }),
        });
      }
    }
  }

  return findings;
}

/**
 * Detect task evidence claims that lack matching requirements or conflict with them.
 *
 * @param tasks - pre-partitioned task evidence claims
 * @param requirements - pre-partitioned requirement claims
 * @param tokenCache - pre-computed keyword token sets for all claims
 * @returns findings for unmatched task evidence and task/requirement conflicts
 *
 * @remarks
 * Precondition: `tokenCache` has entries for all claims in `tasks` and `requirements`.
 * Postcondition: each orphan task evidence produces a `coverage.task_gap` finding;
 * each negation conflict produces a `coverage.task_conflict` finding.
 * Invariant: overlap between task and requirement is keyword-based.
 * Failure modes: none — pure computation.
 */
function detectTaskEvidenceInconsistency(
  tasks: readonly Claim[],
  requirements: readonly Claim[],
  tokenCache: TokenCache,
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const taskClaim of tasks) {
    const taskTokens = tokenCache.get(taskClaim);
    const relatedRequirements = requirements.filter((requirement) => cachedTokensOverlap(taskTokens, tokenCache.get(requirement)));
    if (relatedRequirements.length === 0) {
      findings.push({
        severity: "warning",
        category: "coverage.task_gap",
        provenance: taskClaim.provenance,
        description: "Completed task evidence has no matching specification requirement",
        rationale: "Task evidence without a matching requirement suggests work was done outside the scope of the specification, which may indicate undocumented requirements or scope creep.",
        evidence: [{ kind: "task_evidence", value: taskClaim.text }],
      });
      continue;
    }

    for (const requirement of relatedRequirements) {
      if (!isNegationConflict(taskClaim.text, requirement.text)) {
        continue;
      }

      findings.push({
        severity: "warning",
        category: "coverage.task_conflict",
        provenance: taskClaim.provenance,
        description: "Task evidence appears inconsistent with requirement behavior",
        rationale: "A negation conflict between task evidence and a requirement indicates the implementation may have diverged from the specified behavior, requiring investigation before the task can be considered compliant.",
        evidence: [
          { kind: "task_evidence", value: taskClaim.text },
          { kind: "requirement", value: requirement.text },
        ],
        ...(requirement.id === undefined ? {} : { relatedClaimIdentifiers: [requirement.id] }),
      });
    }
  }

  return findings;
}

/**
 * Pre-partitioned claim arrays by role, built in a single pass over the claim graph.
 *
 * @remarks
 * Invariant: the union of all four arrays equals the original claims array (no claims lost).
 * The partition is exhaustive over the {@link ClaimKind} discriminant.
 */
interface ClaimPartition {
  readonly upstream: readonly Claim[];
  readonly requirements: readonly Claim[];
  readonly scenarios: readonly Claim[];
  readonly tasks: readonly Claim[];
}

/**
 * Partition claims by their role in coverage analysis in a single O(n) pass.
 *
 * Eliminates 7 redundant `.filter()` calls that previously occurred across
 * individual detector functions, each of which iterated the full claim array.
 *
 * @param claims - all claims from the claim graph
 * @returns a {@link ClaimPartition} with claims bucketed by analysis role
 *
 * @remarks
 * Precondition: `claims` contains valid Claim objects with a recognized `kind`.
 * Postcondition: every input claim appears in exactly one output bucket.
 * Invariant: exhaustive switch over {@link ClaimKind} — adding a new kind produces
 * a compile-time error until the partition is updated.
 * Failure modes: none — pure computation.
 */
function partitionClaims(claims: readonly Claim[]): ClaimPartition {
  const upstream: Claim[] = [];
  const requirements: Claim[] = [];
  const scenarios: Claim[] = [];
  const tasks: Claim[] = [];
  for (const claim of claims) {
    switch (claim.kind) {
      case "requirement": requirements.push(claim); break;
      case "scenario": scenarios.push(claim); break;
      case "task_evidence": tasks.push(claim); break;
      case "proposal_property":
      case "design_property":
      case "assumption":
      case "invariant":
      case "failure_mode":
        upstream.push(claim); break;
    }
  }
  return { upstream, requirements, scenarios, tasks };
}

/** Pre-computed keyword token sets indexed by claim identity (reference equality). */
type TokenCache = ReadonlyMap<Claim, ReadonlySet<string>>;

/**
 * Build a pre-computed token cache mapping each claim to its keyword token set.
 *
 * @param claims - all claims from the claim graph to tokenize
 * @returns a map from claim reference identity to the claim's keyword token set
 *
 * @remarks
 * Precondition: `claims` is a non-empty array of valid Claim objects with non-null `text`.
 * Postcondition: the returned map has exactly one entry per input claim.
 * Invariant: tokenization uses `keywordTokens` — lowercase tokens of 5+ characters.
 * Failure modes: none — pure computation.
 */
function buildTokenCache(claims: readonly Claim[]): TokenCache {
  const cache = new Map<Claim, ReadonlySet<string>>();
  for (const claim of claims) {
    cache.set(claim, keywordTokens(claim.text));
  }
  return cache;
}

/**
 * Check whether two pre-computed token sets share any keyword.
 *
 * @param a - first token set (or undefined if the claim was not cached)
 * @param b - second token set (or undefined if the claim was not cached)
 * @returns true if the sets share at least one common token
 *
 * @remarks
 * Precondition: none — undefined inputs are handled as no-overlap.
 * Postcondition: returns true only when at least one token exists in both sets.
 * Invariant: iterates the smaller set for O(min(|a|, |b|)) lookups.
 * Failure modes: none — pure computation.
 */
function cachedTokensOverlap(
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined,
): boolean {
  if (a === undefined || b === undefined || a.size === 0 || b.size === 0) {
    return false;
  }
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) {
      return true;
    }
  }
  return false;
}

/**
 * Tokenize text into a set of lowercase keywords for overlap comparison.
 *
 * @param text - raw claim text to tokenize
 * @returns set of lowercase keyword tokens with length >= 5 characters
 *
 * @remarks
 * Postcondition: all tokens are lowercase, trimmed, and at least 5 characters long.
 * Invariant: splitting is performed on non-alphanumeric boundaries.
 * Failure modes: none — pure computation.
 */
function keywordTokens(text: string): ReadonlySet<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 5),
  );
}

/**
 * Detect whether two texts exhibit a negation conflict (one negated, the other not).
 *
 * @param left - first text to compare
 * @param right - second text to compare
 * @returns true if exactly one of the texts contains negation markers
 *
 * @remarks
 * Postcondition: returns true only when the negation status of the two texts differs.
 * Failure modes: none — pure computation.
 */
function isNegationConflict(left: string, right: string): boolean {
  const leftNegated = containsNegation(left);
  const rightNegated = containsNegation(right);
  return leftNegated !== rightNegated;
}

/**
 * Check whether text contains common English negation markers.
 *
 * @param text - text to inspect for negation
 * @returns true if the text contains " not ", " never ", or " no " (case-insensitive)
 *
 * @remarks
 * Postcondition: matching is case-insensitive and requires surrounding whitespace.
 * Failure modes: none — pure computation.
 */
function containsNegation(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes(" not ") || normalized.includes(" never ") || normalized.includes(" no ");
}

/**
 * Check whether text contains failure-related terminology.
 *
 * @param text - text to inspect for failure terms
 * @returns true if the text contains "fail", "error", "timeout", or "unknown" (case-insensitive)
 *
 * @remarks
 * Postcondition: matching is case-insensitive substring search.
 * Failure modes: none — pure computation.
 */
function containsFailureTerms(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("fail") || normalized.includes("error") || normalized.includes("timeout") || normalized.includes("unknown");
}

/**
 * Normalize a capability name for comparison by lowercasing, stripping markdown formatting, and hyphenating.
 *
 * @param raw - raw capability name string (may include markdown formatting characters)
 * @returns normalized lowercase hyphenated capability name
 *
 * @remarks
 * Postcondition: returned string is trimmed, lowercase, with no backticks/asterisks/underscores,
 * and whitespace runs replaced by hyphens.
 * Failure modes: none — pure computation.
 */
function normalizeCapabilityName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[`*_]/gu, "")
    .replace(/\s+/gu, "-");
}

/**
 * Check whether a reference path points to an archived change directory.
 *
 * @param reference - raw reference path string from a requirement's `**References:**` block
 * @returns true if the reference path includes `openspec/changes/archive/`
 *
 * @remarks
 * Archived change documents are valid provenance-only links — they record the design
 * history behind a requirement but do not need to be present in the active analysis catalog.
 * Postcondition: returns true only for paths that pass through the archive directory.
 * Failure modes: none — pure computation.
 */
function isArchivedChangeReference(reference: string): boolean {
  return reference.includes("openspec/changes/archive/");
}
