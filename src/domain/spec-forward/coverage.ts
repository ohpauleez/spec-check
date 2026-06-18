import type { ParsedProposal, ParsedSpec, ParsedTaskDocument } from "../model.js";
import type { Claim, ClaimGraph } from "../claim-graph.js";
import type { Finding } from "../findings.js";
import { severityForObligation } from "../claim-graph.js";

/**
 * Deterministic coverage and contradiction analysis across upstream and downstream claims.
 */
export function analyzeCoverage(input: {
  readonly claimGraph: ClaimGraph;
  readonly proposal?: ParsedProposal;
  readonly specs: readonly ParsedSpec[];
  readonly tasks?: ParsedTaskDocument;
}): readonly Finding[] {
  const findings: Finding[] = [];

  // Pre-compute keyword token sets once for all claims to avoid redundant tokenization
  // across the O(upstream x downstream) comparisons in sub-analyses.
  const tokenCache = buildTokenCache(input.claimGraph.claims);

  findings.push(...detectMissingSpecFiles(input.proposal, input.specs));
  findings.push(...detectUnsupportedReferences(input.claimGraph));
  findings.push(...detectCoverageGaps(input.claimGraph, tokenCache));
  findings.push(...detectContradictionsAndDrift(input.claimGraph, tokenCache));
  findings.push(...detectTaskEvidenceInconsistency(input.claimGraph, tokenCache));

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
 */
function detectMissingSpecFiles(
  proposal: ParsedProposal | undefined,
  specs: readonly ParsedSpec[],
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

  const availableCapabilities = new Set<string>(
    specs
      .map((spec) => normalizeCapabilityName(spec.file.split("/").slice(-2)[0] ?? ""))
      .filter((name) => name.length > 0),
  );

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
      evidence: [{ kind: "declared_capability", value: capability }],
    });
  }

  return findings;
}

/**
 * Detect requirements that reference upstream files not present in the claim graph.
 *
 * @param graph - claim graph containing all parsed claims
 * @returns findings for each requirement referencing unsupported upstream content
 *
 * @remarks
 * Precondition: `graph.claims` includes all upstream and downstream claims.
 * Postcondition: finding severity matches the obligation level of the referencing requirement.
 * Invariant: only requirement claims are checked; empty references and archived
 * provenance references (`openspec/changes/archive/`) are skipped.
 */
function detectUnsupportedReferences(graph: ClaimGraph): readonly Finding[] {
  const upstreamClaims = graph.claims.filter((claim) => claim.kind !== "requirement" && claim.kind !== "scenario");
  const findings: Finding[] = [];

  for (const claim of graph.claims) {
    if (claim.kind !== "requirement") {
      continue;
    }

    for (const reference of claim.references) {
      if (reference.length === 0) {
        continue;
      }

      // Archived change references are valid provenance-only links and do not
      // require the referenced document to be present in the active catalog.
      if (isArchivedChangeReference(reference)) {
        continue;
      }

      const supported = upstreamClaims.some((upstream) => upstream.provenance.file.endsWith(reference.split("#")[0] ?? ""));
      if (supported) {
        continue;
      }

      findings.push({
        severity: severityForObligation(claim.obligation),
        category: "coverage.unsupported_reference",
        provenance: claim.provenance,
        description: `Requirement references unsupported upstream content: ${reference}`,
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
 * @param graph - claim graph containing upstream and downstream claims
 * @param tokenCache - pre-computed keyword token sets for all claims
 * @returns warning findings for each upstream claim without downstream coverage
 *
 * @remarks
 * Precondition: `tokenCache` has entries for all claims in `graph`.
 * Postcondition: each finding identifies one upstream claim lacking downstream support.
 * Invariant: overlap is determined by shared keyword tokens (minimum 5 characters).
 */
function detectCoverageGaps(graph: ClaimGraph, tokenCache: TokenCache): readonly Finding[] {
  const upstream = graph.claims.filter((claim) => isUpstreamClaim(claim.kind));
  const downstream = graph.claims.filter((claim) => claim.kind === "requirement" || claim.kind === "scenario");
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
      evidence: [{ kind: "upstream_claim", value: sourceClaim.text }],
      ...(sourceClaim.id === undefined ? {} : { relatedClaimIdentifiers: [sourceClaim.id] }),
    });
  }

  return findings;
}

/**
 * Detect contradictions (negation conflicts) and semantic drift between upstream and downstream claims.
 *
 * @param graph - claim graph containing upstream and downstream claims
 * @param tokenCache - pre-computed keyword token sets for all claims
 * @returns findings for contradictions and drift between overlapping claim pairs
 *
 * @remarks
 * Precondition: `tokenCache` has entries for all claims in `graph`.
 * Postcondition: contradiction findings are emitted at the requirement's obligation severity;
 * drift findings are always warnings.
 * Invariant: only claim pairs with keyword overlap are compared.
 */
function detectContradictionsAndDrift(graph: ClaimGraph, tokenCache: TokenCache): readonly Finding[] {
  const upstream = graph.claims.filter((claim) => isUpstreamClaim(claim.kind));
  const downstream = graph.claims.filter((claim) => claim.kind === "requirement");
  const findings: Finding[] = [];

  for (const sourceClaim of upstream) {
    const sourceTokens = tokenCache.get(sourceClaim);
    for (const requirement of downstream) {
      if (!cachedTokensOverlap(sourceTokens, tokenCache.get(requirement))) {
        continue;
      }

      if (isNegationConflict(sourceClaim.text, requirement.text)) {
        findings.push({
          severity: severityForObligation(requirement.obligation),
          category: "coverage.contradiction",
          provenance: requirement.provenance,
          description: "Detected contradiction between upstream and downstream claims",
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
 * @param graph - claim graph containing task evidence and requirement claims
 * @param tokenCache - pre-computed keyword token sets for all claims
 * @returns findings for unmatched task evidence and task/requirement conflicts
 *
 * @remarks
 * Precondition: `tokenCache` has entries for all claims in `graph`.
 * Postcondition: each orphan task evidence produces a `coverage.task_gap` finding;
 * each negation conflict produces a `coverage.task_conflict` finding.
 * Invariant: overlap between task and requirement is keyword-based.
 */
function detectTaskEvidenceInconsistency(graph: ClaimGraph, tokenCache: TokenCache): readonly Finding[] {
  const tasks = graph.claims.filter((claim) => claim.kind === "task_evidence");
  const requirements = graph.claims.filter((claim) => claim.kind === "requirement");
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
 * Determine whether a claim kind belongs to the upstream category.
 *
 * @param kind - claim kind discriminator from the Claim union
 * @returns true if the kind is an upstream claim type (proposal, design, assumption, invariant, or failure mode)
 *
 * @remarks
 * Postcondition: returns true only for the closed set of upstream claim kinds.
 */
function isUpstreamClaim(kind: Claim["kind"]): boolean {
  return kind === "proposal_property" || kind === "design_property" || kind === "assumption" || kind === "invariant" || kind === "failure_mode";
}

/** Pre-computed keyword token sets indexed by claim identity (reference equality). */
type TokenCache = ReadonlyMap<Claim, ReadonlySet<string>>;

/**
 * Build a token cache for all claims once. Avoids redundant tokenization across
 * the O(upstream x downstream) comparisons.
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
 * Iterates the smaller set for O(min(|a|, |b|)) lookups.
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
 */
function isArchivedChangeReference(reference: string): boolean {
  return reference.includes("openspec/changes/archive/");
}
