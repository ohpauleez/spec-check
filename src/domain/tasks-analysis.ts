/**
 * Analyzes consistency between task evidence claims and source-code traces,
 * producing findings for tasks that lack corroborating source identifiers.
 *
 * Domain layer — cross-references the claim graph with backwards-traced code.
 * Exports: analyzeTaskSourceConsistency.
 */
import type { ClaimGraph } from "./claim-graph.js";
import type { SourceTrace } from "./code-backwards/trace.js";
import type { Finding } from "./findings.js";

/**
 * Compare completed task evidence claims against source-trace identifiers.
 *
 * @param input - Claim graph and source traces to cross-reference
 * @returns Findings indicating consistency or discrepancy between tasks and traces
 *
 * @example
 * ```typescript
 * const findings = analyzeTaskSourceConsistency({
 *   claimGraph: { claims: [
 *     { kind: "task_evidence", text: "Implemented parseConfig in config.ts", provenance: { file: "tasks.md" } },
 *   ]},
 *   traces: [{ identifier: "parseConfig", file: "src/config.ts", line: 42 }],
 * });
 * // findings[0].category === "task_source.consistent"
 * ```
 */
export function analyzeTaskSourceConsistency(input: {
  readonly claimGraph: ClaimGraph;
  readonly traces: readonly SourceTrace[];
}): readonly Finding[] {
  const findings: Finding[] = [];
  const tracedIds = new Set(input.traces.map((trace) => trace.identifier));

  for (const claim of input.claimGraph.claims) {
    if (claim.kind !== "task_evidence") {
      continue;
    }

    const matchedIdentifier = findMatchingIdentifier(tracedIds, claim.text);
    if (matchedIdentifier !== undefined) {
      findings.push({
        severity: "info",
        category: "task_source.consistent",
        provenance: claim.provenance,
        description: `Task evidence aligns with traced source identifier ${matchedIdentifier}`,
        rationale: "Confirms that claimed task work is backed by a verifiable source trace, increasing confidence in implementation completeness",
        evidence: [{ kind: "identifier", value: matchedIdentifier }],
      });
      continue;
    }

    findings.push({
      severity: "warning",
      category: "task_source.discrepancy",
      provenance: claim.provenance,
      description: "Task evidence not corroborated by traced source identifiers",
      rationale: "Task claims without matching source traces may indicate unimplemented work, stale references, or inaccurate task descriptions",
      evidence: [{ kind: "task_claim", value: claim.text }],
    });
  }

  return findings;
}

/**
 * Find the first traced identifier that appears in the given text.
 * Iterates the Set directly to avoid per-call Array allocation.
 */
function findMatchingIdentifier(tracedIds: ReadonlySet<string>, text: string): string | undefined {
  for (const identifier of tracedIds) {
    if (text.includes(identifier)) {
      return identifier;
    }
  }
  return undefined;
}
