import type { ClaimGraph } from "./claim-graph.js";
import type { SourceTrace } from "./code-backwards/trace.js";
import type { Finding } from "./findings.js";

/**
 * Compare completed task evidence claims against source-trace identifiers.
 *
 * @param input - Claim graph and source traces to cross-reference
 * @returns Findings indicating consistency or discrepancy between tasks and traces
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
        evidence: [{ kind: "identifier", value: matchedIdentifier }],
      });
      continue;
    }

    findings.push({
      severity: "warning",
      category: "task_source.discrepancy",
      provenance: claim.provenance,
      description: "Task evidence not corroborated by traced source identifiers",
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
