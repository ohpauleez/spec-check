/**
 * Generates SMT-LIB formalizations for code-derived specification claims by
 * orchestrating formalization, clustering, and compilation steps.
 *
 * Bridges the derive stage to the formal verification layer in code-backwards.
 * Exports: generateCodeFormalizations, CodeFormalizationOutput.
 */
import { writeOutputAtomic } from "../../adapters/fs.js";
import { toCapabilityName, toRelativePath, type ModelName, type OutputDirPath, type RelativePath } from "../branded.js";
import type { Finding } from "../findings.js";
import type { Claim } from "../claim-graph.js";
import { buildClaimGraph } from "../claim-graph.js";
import { parseSpecText } from "../parser/spec.js";
import { DEFAULT_ANALYSIS, type AnalysisConfig } from "../formal/analysis-config.js";
import type { EvidenceRecorder } from "../formal/evidence.js";
import { QueryExecutor } from "../formal/query-executor.js";
import { formalizeClaims } from "../formal/formalize.js";
import { clusterWithSelection } from "../formal/selected-clustering.js";
import { compileSmtlib } from "../formal/smtlib.js";
import { TypedCompilationPreparation } from "../formal/typed-smtlib.js";
import type { LogicIrClaim } from "../logic-ir.js";
import {
  buildFormalizationAttemptSet,
  writeFormalizationAttemptSet,
  type FormalizationEvidenceFile,
} from "../reporting/formalization-evidence.js";

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
 * Invariant: `evidenceFiles` describes one durable invocation envelope per processed spec.
 * Partial results are preserved: failure of one spec does not affect others.
 */
export interface GeneratedFormalizationOutput {
  readonly claims: readonly GeneratedFormalization[];
  readonly findings: readonly Finding[];
  readonly evidenceFiles: readonly FormalizationEvidenceFile[];
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
 * Failure modes: propagates filesystem write errors from `writeOutputAtomic`.
 * LLM formalization failures and Z3 clustering errors are captured as findings
 * (error or warning severity) without throwing.
 * Safety: performs network I/O (LLM formalization) and filesystem I/O (artifact writes).
 * May spawn Z3 subprocesses for clustering stability checks. No shared mutable state.
 */
export async function formalizeGeneratedSpecs(input: {
  readonly outputDir: OutputDirPath;
  readonly generatedSpecs: readonly { readonly capability: string; readonly markdown?: string; readonly requirements: readonly { readonly id: string; readonly text: string }[]; readonly sourceIdentifiers: readonly string[] }[];
  readonly model: ModelName;
  readonly timeoutMs: number;
  readonly z3Path?: string;
  readonly analysis?: AnalysisConfig;
  readonly evidence?: EvidenceRecorder;
  readonly executor?: QueryExecutor;
  readonly configSource?: string;
  /** Direct composition may request multiple samples; ordinary CLI generation selects one. */
  readonly samplesPerClaim?: number;
}): Promise<GeneratedFormalizationOutput> {
  const findings: Finding[] = [];
  const outputClaims: GeneratedFormalization[] = [];
  const evidenceFiles: FormalizationEvidenceFile[] = [];

  const compilation = new TypedCompilationPreparation();
  const executor = input.executor ?? new QueryExecutor((input.analysis ?? DEFAULT_ANALYSIS).limits, input.evidence, input.z3Path);
  for (let ordinal = 0; ordinal < input.generatedSpecs.length; ordinal += 1) {
    const spec = input.generatedSpecs[ordinal]!;
    // Use actual requirement text from informalization (not tautological templates).
    const markdown = spec.markdown ?? spec.requirements.map((req) => `### Requirement: ${req.id} [${req.id}]\n${req.text}\n`).join("\n");
    const parsed = parseSpecText(`gen_specs/${spec.capability}.md`, markdown, "delta", { ...(input.analysis === undefined ? {} : { earsExtensions: input.analysis.earsExtensions, statementMaxBytes: input.analysis.limits.statementBytes }) });
    const graph = buildClaimGraph({ specs: [parsed] });
    const syntheticClaims: Claim[] = graph.graph.claims.map((claim) => ({ ...claim, capability: toCapabilityName(spec.capability),
      ...(claim.surface === undefined ? {} : { surface: Object.freeze({ ...claim.surface, source: Object.freeze({ ...claim.surface.source, namespace: `generated_spec:${ordinal}:${spec.capability}` }) }) }) }));
    for (const claim of syntheticClaims) if (claim.surface?.disposition.kind === "excluded") findings.push({ severity: "warning", category: "code_derived.formalization_ineligible", provenance: claim.provenance,
      description: "Generated statement is not eligible for the selected structural/semantic profile", rationale: "Source-derived prose remains evidence but cannot support an unsupported formal verdict.", evidence: [{ kind: "source", value: claim.text }] });

    const formalized = await formalizeClaims({
      claims: syntheticClaims,
      model: input.model,
      samplesPerClaim: input.samplesPerClaim ?? 1,
      timeoutMs: input.timeoutMs,
      logicalFileByCapability: new Map(),
      side: "generated_spec", ordinal,
      ...(input.analysis === undefined ? {} : { analysis: input.analysis }),
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      ...(input.configSource === undefined ? {} : { configSource: input.configSource }),
    });
    const evidenceFile = await writeFormalizationAttemptSet(
      input.outputDir,
      buildFormalizationAttemptSet(
        { kind: "generated_spec", ordinal, capability: spec.capability },
        formalized.ok ? formalized.value.batchAttempts : [],
      ),
    );
    evidenceFiles.push(evidenceFile);

    // Persist invocation evidence before interpreting formalization failure.
    if (!formalized.ok) {
      // Defensive: should not happen with current implementation but preserves type safety.
      findings.push({
        severity: "error",
        category: "code_derived.formalization_failure",
        provenance: { file: `<gen_specs/${spec.capability}.md>`, heading: spec.capability },
        description: `Code-derived formalization failed for capability ${spec.capability}: ${formalized.error.map((e) => e.message).join("; ")}`,
        rationale: "The formalization step returned an unexpected error result, preventing any formal claims from being generated for this capability. Without formal claims, the capability cannot be verified.",
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
        rationale: "All formalization attempts failed with no viable candidates produced. The capability has no formal representation and cannot proceed to verification.",
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
        rationale: "Some claims were successfully formalized but others failed. The capability has incomplete formal coverage, which may leave certain behaviors unverified.",
        evidence: spec.sourceIdentifiers.map((id) => ({ kind: "identifier", value: id })),
      });
    }

    findings.push(...formalized.value.findings);

    for (const candidate of formalized.value.candidates) {
      const clustered = await clusterWithSelection({
        claimId: candidate.claim.id ?? `GEN-${spec.capability}`,
        samples: candidate.samples,
        stabilityThreshold: 0.6,
        ...(input.z3Path === undefined ? {} : { z3Path: input.z3Path }),
        executor,
        ...(candidate.registry === undefined ? {} : { group: candidate.registry.group }),
      });
      findings.push(...clustered.findings);

      const compiled = compileSmtlib(clustered.clustered.representative, compilation);
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
    evidenceFiles,
  };
}
