import { writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, type OutputDirPath } from "../branded.js";
import type { Finding } from "../findings.js";
import type { SourceTrace } from "./trace.js";

/**
 * A code-derived capability spec generated from source trace evidence.
 *
 * @remarks
 * Invariant: `markdown` follows the EARS-preferring spec template structure.
 * Invariant: `sourceIdentifiers` contains only primary or secondary level trace identifiers.
 */
export interface DerivedCapabilitySpec {
  readonly capability: string;
  readonly markdown: string;
  readonly sourceIdentifiers: readonly string[];
}

/**
 * Output from the code-derived spec generation pass.
 *
 * @remarks
 * Invariant: `specs` contains one entry per capability with sufficient primary/secondary evidence.
 * Invariant: `findings` includes warnings for capabilities with documentation-only evidence.
 */
export interface DerivedSpecOutput {
  readonly specs: readonly DerivedCapabilitySpec[];
  readonly findings: readonly Finding[];
}

/**
 * Generate EARS-preferring code-derived capability specs from source traces.
 */
export async function deriveSpecsFromSource(input: {
  readonly outputDir: OutputDirPath;
  readonly traces: readonly SourceTrace[];
}): Promise<DerivedSpecOutput> {
  const byCapability = new Map<string, SourceTrace[]>();
  for (const trace of input.traces) {
    const capability = inferCapability(trace.identifier);
    // Ownership: arrays are local to this Map; mutation avoids O(n^2) spread copies.
    const existing = byCapability.get(capability);
    if (existing !== undefined) {
      existing.push(trace);
    } else {
      byCapability.set(capability, [trace]);
    }
  }

  const findings: Finding[] = [];
  const specs: DerivedCapabilitySpec[] = [];

  for (const [capability, traces] of [...byCapability.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (traces.length === 0) {
      continue;
    }

    const primaryTraces = traces.filter((trace) => trace.level !== "supporting");
    if (primaryTraces.length === 0) {
      findings.push({
        severity: "warning",
        category: "code_derived.insufficient_evidence",
        provenance: { file: "<source-trace>", heading: capability },
        description: `Capability ${capability} has documentation-only evidence`,
        evidence: traces.map((trace) => ({ kind: "identifier", value: trace.identifier })),
      });
      continue;
    }

    const requirements = primaryTraces.map((trace) => {
      const prefix = trace.level === "primary" ? "WHEN" : "IF";
      return `### Requirement: Code-derived behavior for ${trace.identifier} [${trace.identifier}]\n${prefix} the implementation for ${capability} executes, THE system SHALL satisfy behavior traced by ${trace.identifier}.`;
    });

    const markdown = [
      "## ADDED Requirements",
      "",
      ...requirements,
      "",
      "## MODIFIED Requirements",
      "",
      "## REMOVED Requirements",
      "",
      "## RENAMED Requirements",
      "",
    ].join("\n");

    const outputPath = toRelativePath(`gen_specs/${capability}.md`);
    await writeOutputAtomic(input.outputDir, outputPath, `${markdown}\n`);
    specs.push({
      capability,
      markdown: `${markdown}\n`,
      sourceIdentifiers: primaryTraces.map((trace) => trace.identifier),
    });
  }

  return { specs, findings };
}

/**
 * Infer a capability name from a trace identifier by extracting the first two hyphenated segments.
 *
 * @param identifier - canonical trace identifier (e.g., "AUTH-SESSION-001")
 * @returns lowercase capability prefix (e.g., "auth-session")
 *
 * @remarks
 * Precondition: `identifier` is a non-empty string.
 * Postcondition: returned string is lowercase; single-segment identifiers are returned as-is.
 * Invariant: at most the first two hyphenated parts are retained.
 */
function inferCapability(identifier: string): string {
  const normalized = identifier.toLowerCase();
  const parts = normalized.split("-");
  if (parts.length <= 1) {
    return normalized;
  }
  return parts.slice(0, 2).join("-");
}
