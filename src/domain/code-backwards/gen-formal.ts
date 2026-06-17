import { writeOutputAtomic } from "../../adapters/fs.js";
import { toCapabilityName, toClaimId, toRelativePath, type ModelName, type OutputDirPath, type RelativePath } from "../branded.js";
import type { Finding } from "../findings.js";
import type { Claim } from "../claim-graph.js";
import { formalizeClaims } from "../formal/formalize.js";
import { clusterFormalizationSamples } from "../formal/clustering.js";
import { compileSmtlib } from "../formal/smtlib.js";
import type { LogicIrClaim } from "../logic-ir.js";

/**
 * A single formalized claim from the code-derived spec pipeline with its SMT artifact path.
 *
 * @remarks
 * Invariant: `representative` is the selected stable Logic IR sample for this claim.
 * Invariant: `smtlibPath` is a relative path within the output directory where the
 * compiled SMT-LIB artifact has been atomically written.
 */
export interface GeneratedFormalization {
  readonly capability: string;
  readonly claimId: string;
  readonly representative: LogicIrClaim;
  readonly smtlibPath: RelativePath;
}

/**
 * Output from formalizing all code-derived specs.
 *
 * @remarks
 * Invariant: `claims` contains successfully formalized claims with persisted SMT artifacts.
 * Invariant: `findings` accumulates errors for failed specs and warnings for ambiguous samples.
 * Partial results are preserved: failure of one spec does not affect others.
 */
export interface GeneratedFormalizationOutput {
  readonly claims: readonly GeneratedFormalization[];
  readonly findings: readonly Finding[];
}

/**
 * Apply the same formalization pipeline to code-derived specs and persist SMT artifacts.
 *
 * @param input - code-derived specs, model, output directory, and optional z3 path
 * @returns formalized claims with SMT artifacts and accumulated findings
 *
 * @remarks
 * Precondition: `input.generatedSpecs` contains code-derived capability specs.
 * Postcondition: each successfully formalized claim has its SMT-LIB artifact
 * written to the output directory. Failed formalizations produce error-severity
 * findings rather than aborting the pipeline.
 * Invariant: partial results are preserved — a failure for one spec does not
 * prevent other specs from being formalized.
 */
export async function formalizeGeneratedSpecs(input: {
  readonly outputDir: OutputDirPath;
  readonly generatedSpecs: readonly { readonly capability: string; readonly sourceIdentifiers: readonly string[] }[];
  readonly model: ModelName;
  readonly z3Path?: string;
}): Promise<GeneratedFormalizationOutput> {
  const findings: Finding[] = [];
  const outputClaims: GeneratedFormalization[] = [];

  for (const spec of input.generatedSpecs) {
    const syntheticClaims: Claim[] = spec.sourceIdentifiers.map((identifier) => ({
      id: toClaimId(identifier),
      kind: "requirement",
      text: `WHEN implementation executes for ${spec.capability}, THE system SHALL satisfy ${identifier}`,
      obligation: "mandatory",
      provenance: { file: `<gen_specs/${spec.capability}.md>`, heading: identifier },
      references: [],
      capability: toCapabilityName(spec.capability),
    }));

    const formalized = await formalizeClaims({
      claims: syntheticClaims,
      model: input.model,
      samplesPerClaim: 3,
    });

    // formalizeClaims always returns ok; check for errors in the output.
    if (!formalized.ok) {
      // Defensive: should not happen with current implementation but preserves type safety.
      findings.push({
        severity: "error",
        category: "code_derived.formalization_failure",
        provenance: { file: `<gen_specs/${spec.capability}.md>`, heading: spec.capability },
        description: `Code-derived formalization failed for capability ${spec.capability}: ${formalized.error.map((e) => e.message).join("; ")}`,
        evidence: spec.sourceIdentifiers.map((id) => ({ kind: "identifier", value: id })),
      });
      continue;
    }

    // Record complete failure (no candidates at all) as error-severity finding.
    if (formalized.value.errors.length > 0 && formalized.value.candidates.length === 0) {
      findings.push({
        severity: "error",
        category: "code_derived.formalization_failure",
        provenance: { file: `<gen_specs/${spec.capability}.md>`, heading: spec.capability },
        description: `Code-derived formalization failed for capability ${spec.capability}: ${formalized.value.errors.map((e) => e.message).join("; ")}`,
        evidence: spec.sourceIdentifiers.map((id) => ({ kind: "identifier", value: id })),
      });
      continue;
    }

    // Record partial failures (some claims succeeded, others failed) as warning.
    if (formalized.value.errors.length > 0) {
      findings.push({
        severity: "warning",
        category: "code_derived.formalization_partial",
        provenance: { file: `<gen_specs/${spec.capability}.md>`, heading: spec.capability },
        description: `Partial formalization failure for capability ${spec.capability}: ${formalized.value.errors.map((e) => e.message).join("; ")}`,
        evidence: spec.sourceIdentifiers.map((id) => ({ kind: "identifier", value: id })),
      });
    }

    findings.push(...formalized.value.findings);

    for (const candidate of formalized.value.candidates) {
      const clustered = await clusterFormalizationSamples({
        claimId: candidate.claim.id ?? `GEN-${spec.capability}`,
        samples: candidate.samples,
        stabilityThreshold: 0.6,
        ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
      });
      findings.push(...clustered.findings);

      const compiled = compileSmtlib(clustered.clustered.representative);
      const smtPath = toRelativePath(`gen_specs_smt/${spec.capability}/${compiled.sanitizedClaimId}.smt2`);
      await writeOutputAtomic(input.outputDir, smtPath, compiled.smtlib);

      outputClaims.push({
        capability: spec.capability,
        claimId: candidate.claim.id ?? `GEN-${spec.capability}`,
        representative: clustered.clustered.representative,
        smtlibPath: smtPath,
      });
    }
  }

  return {
    claims: outputClaims,
    findings,
  };
}
