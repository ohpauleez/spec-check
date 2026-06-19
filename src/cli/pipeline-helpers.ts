/**
 * Pipeline phase helper functions implementing ingestion, analysis, and source
 * tracing phases as composable async operations.
 *
 * Provides the concrete phase logic called by the pipeline orchestrator.
 * Exports: `runIngestionPhase`, `runAnalysisPhase`, `runSourcePhase`, and related helpers.
 */
import type { RunConfig } from "./config.js";
import type { Finding } from "../domain/findings.js";
import type { ClaimGraphOutput } from "../domain/claim-graph.js";
import type { LogicIrClaim } from "../domain/logic-ir.js";
import type { SourceTrace } from "../domain/code-backwards/trace.js";
import type { FormalizationCandidate } from "../domain/formal/formalize.js";
import type { SpecClaimGroup } from "../domain/formal/logic-analysis.js";
import type { PipelineContext } from "./pipeline-types.js";
import { toRelativePath, type RelativePath } from "../domain/branded.js";
import { isCommandAvailable } from "../adapters/process.js";
import { writeOutputAtomic } from "../adapters/fs.js";
import { buildClaimGraph } from "../domain/claim-graph.js";
import { parseDesign } from "../domain/parser/design.js";
import { parseProposal } from "../domain/parser/proposal.js";
import { parseSpec } from "../domain/parser/spec.js";
import { parseTaskDocument } from "../domain/parser/task.js";
import { analyzeCoverage } from "../domain/spec-forward/coverage.js";
import { clusterFormalizationSamples } from "../domain/formal/clustering.js";
import { deriveSpecsFromSource } from "../domain/code-backwards/derive.js";
import { formalizeGeneratedSpecs } from "../domain/code-backwards/gen-formal.js";
import { analyzeGeneratedLogic } from "../domain/code-backwards/gen-logic.js";
import { runCapabilityAggregateComparison, runBoundedPairwiseComparison } from "../domain/code-backwards/cross-implication.js";
import { runBlindComparison } from "../domain/code-backwards/blind-compare.js";
import { compileSmtlib } from "../domain/formal/smtlib.js";

// ---------------------------------------------------------------------------
// Dependency and configuration helpers
// ---------------------------------------------------------------------------

/**
 * Verify that required external tools are available on the system PATH.
 *
 * @param config - run configuration; uses `config.z3` for the Z3 binary path (falls back to "z3")
 * @returns error message string if a required dependency is missing; `undefined` if all are present
 *
 * @remarks
 * Precondition: none — safe to call at any point.
 * Postcondition: when `undefined` is returned, both `opencode` and `z3` binaries
 * are available on the system PATH (or at the configured path).
 *
 * Failure modes: none — this function does not throw. Missing dependencies are
 * reported via the returned string value.
 *
 * Safety: calls `isCommandAvailable` which may invoke a synchronous subprocess
 * check (e.g., `which`). Safe for single-threaded CLI usage.
 */
export function checkDependencies(config: RunConfig): string | undefined {
  if (!isCommandAvailable("opencode")) {
    return "opencode binary not found";
  }
  const z3Path = config.z3 ?? "z3";
  if (!isCommandAvailable(z3Path)) {
    return `z3 binary not found at ${z3Path}`;
  }
  return undefined;
}

/**
 * Compute which phases were skipped based on the actual run configuration.
 *
 * @param config - resolved run configuration
 * @returns list of phase name strings that were not enabled for this run
 *
 * @remarks
 * Precondition: `config` has been validated by `resolveRunConfig`.
 * Postcondition: only phases that were genuinely not executed are listed.
 * Postcondition: returned array is empty when all phases were enabled.
 *
 * Failure modes: none — pure computation, cannot throw.
 */
export function computeSkippedPhases(config: RunConfig): readonly string[] {
  const skipped: string[] = [];
  if (config.src === undefined) {
    skipped.push("source-trace", "code-backwards");
  }
  return skipped;
}

// ---------------------------------------------------------------------------
// Document parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse all documents discovered by the catalog phase into typed domain models.
 *
 * @param catalogOutput - catalog build output containing the document list with paths and types
 * @returns parsed proposal, design, specs, and tasks (optional fields absent when not found)
 *
 * @remarks
 * Precondition: `catalogOutput.catalog.documents` contains valid filesystem paths
 * with correct `type` classifications from the catalog phase.
 * Postcondition: all parseable documents are parsed; unparsed documents
 * produce structural findings in the returned parsed specs.
 * Postcondition: optional fields (`proposal`, `design`, `tasks`) are structurally
 * absent (not `undefined`) when the catalog contains no document of that type.
 *
 * Failure modes: individual document parsers may throw on I/O errors (e.g.,
 * file deleted between catalog and parse). Such errors propagate uncaught.
 *
 * Safety: performs filesystem reads for each cataloged document. Reads are
 * independent and executed concurrently for spec documents via `Promise.all`.
 */
export async function parseAllDocuments(catalogOutput: {
  readonly catalog: { readonly documents: readonly { readonly path: string; readonly type: string }[] };
}): Promise<Pick<PipelineContext, "proposal" | "design" | "specs" | "tasks">> {
  const docs = catalogOutput.catalog.documents;
  const proposalDoc = docs.find((d) => d.type === "proposal");
  const designDoc = docs.find((d) => d.type === "design");
  const specDocs = docs.filter((d) => d.type === "spec");
  const taskDoc = docs.find((d) => d.type === "task");

  const proposal = proposalDoc === undefined ? undefined : await parseProposal(proposalDoc.path);
  const design = designDoc === undefined ? undefined : await parseDesign(designDoc.path);
  const specs = await Promise.all(specDocs.map((s) => parseSpec(s.path)));
  const tasks = taskDoc === undefined ? undefined : await parseTaskDocument(taskDoc.path);

  return {
    specs,
    ...(proposal === undefined ? {} : { proposal }),
    ...(design === undefined ? {} : { design }),
    ...(tasks === undefined ? {} : { tasks }),
  };
}

/**
 * Collect structural and unparsed-line findings from all parsed documents.
 *
 * @param ctx - pipeline context containing parsed proposal, design, specs, and tasks
 * @returns array of findings for structural issues and unparsed lines across all documents
 *
 * @remarks
 * Precondition: `ctx.specs` is populated (may be empty array if no spec documents found).
 * Postcondition: every structural issue and every unparsed line has a corresponding
 * finding with provenance linking back to the source file.
 * Postcondition: returned findings have severity "warning" and categories prefixed with "parser.".
 *
 * Failure modes: none — pure computation over already-parsed in-memory data, cannot throw.
 */
export function collectParserFindings(ctx: Pick<PipelineContext, "proposal" | "design" | "specs" | "tasks">): readonly Finding[] {
  const structural: Finding[] = ctx.specs.flatMap((spec) =>
    spec.structuralFindings.map((finding) => ({
      severity: "warning" as const,
      category: "parser.structural",
      provenance: finding.provenance,
      description: finding.message,
      rationale: "Structural issues in a spec indicate malformed sections or missing required headings, which prevent reliable extraction of requirements and may cause downstream analysis to miss coverage gaps.",
      evidence: [{ kind: "file", value: spec.file }],
    })),
  );

  const unparsed: Finding[] = [
    ...(ctx.proposal?.unparsed ?? []).map((line) => ({
      severity: "warning" as const,
      category: "parser.unparsed_line",
      provenance: line.provenance,
      description: "Unparsed proposal line preserved",
      rationale: "Content that the parser cannot classify may contain requirements or constraints that will be invisible to coverage analysis, risking silent gaps in verification.",
      evidence: [{ kind: "line", value: line.text }],
    })),
    ...(ctx.design?.unparsed ?? []).map((line) => ({
      severity: "warning" as const,
      category: "parser.unparsed_line",
      provenance: line.provenance,
      description: "Unparsed design line preserved",
      rationale: "Content that the parser cannot classify may contain requirements or constraints that will be invisible to coverage analysis, risking silent gaps in verification.",
      evidence: [{ kind: "line", value: line.text }],
    })),
    ...ctx.specs.flatMap((spec) =>
      spec.unparsed.map((line) => ({
        severity: "warning" as const,
        category: "parser.unparsed_line",
        provenance: line.provenance,
        description: "Unparsed spec line preserved",
        rationale: "Content that the parser cannot classify may contain requirements or constraints that will be invisible to coverage analysis, risking silent gaps in verification.",
        evidence: [{ kind: "line", value: line.text }],
      })),
    ),
    ...(ctx.tasks?.unparsed ?? []).map((line) => ({
      severity: "warning" as const,
      category: "parser.unparsed_line",
      provenance: line.provenance,
      description: "Unparsed task line preserved",
      rationale: "Content that the parser cannot classify may contain requirements or constraints that will be invisible to coverage analysis, risking silent gaps in verification.",
      evidence: [{ kind: "line", value: line.text }],
    })),
  ];

  return [...structural, ...unparsed];
}

// ---------------------------------------------------------------------------
// Analysis phase helpers
// ---------------------------------------------------------------------------

/**
 * Build claim graph from parsed documents and compute coverage findings.
 *
 * @param ctx - pipeline context with parsed proposal, design, specs, and tasks
 * @returns object containing the claim graph, claim-level findings, and coverage findings
 *
 * @remarks
 * Precondition: `ctx.specs` is non-empty (at least one spec document must be parsed).
 * Postcondition: all claims have provenance tracing back to their source document and line.
 * Postcondition: coverage analysis is deterministic given the same input documents.
 *
 * Failure modes: none — pure computation over in-memory parsed documents, cannot throw.
 */
export function runClaimGraphPhase(ctx: Pick<PipelineContext, "proposal" | "design" | "specs" | "tasks">): {
  readonly graph: ClaimGraphOutput["graph"];
  readonly claimFindings: readonly Finding[];
  readonly coverageFindings: readonly Finding[];
} {
  const graphOutput = buildClaimGraph({
    specs: ctx.specs,
    ...(ctx.proposal === undefined ? {} : { proposal: ctx.proposal }),
    ...(ctx.design === undefined ? {} : { design: ctx.design }),
    ...(ctx.tasks === undefined ? {} : { tasks: ctx.tasks }),
  });

  const coverageFindings = analyzeCoverage({
    claimGraph: graphOutput.graph,
    specs: ctx.specs,
    ...(ctx.proposal === undefined ? {} : { proposal: ctx.proposal }),
    ...(ctx.tasks === undefined ? {} : { tasks: ctx.tasks }),
  });

  return { graph: graphOutput.graph, claimFindings: graphOutput.findings, coverageFindings };
}

/**
 * Cluster formalization samples and extract a single representative claim per candidate.
 *
 * @param config - run configuration; uses `config.z3` for the Z3 solver path
 * @param candidates - formalization candidates, each containing a claim ID and multiple samples
 * @returns object with representative claims (one per candidate) and ambiguity findings
 *
 * @remarks
 * Precondition: each candidate has at least one sample in `candidate.samples`.
 * Postcondition: exactly one representative per candidate in the same order as input.
 * Postcondition: ambiguity findings emitted for unstable clusters (stability below threshold).
 *
 * Failure modes: Z3 solver invocation may fail if the binary is unavailable or crashes
 * on malformed SMT-LIB input. Such failures propagate as uncaught errors.
 *
 * Safety: invokes Z3 as an external process for equivalence checking during clustering.
 * Each clustering call is independent; candidates are processed sequentially.
 */
export async function runClusteringPhase(
  config: RunConfig,
  candidates: readonly { readonly claim: { readonly id?: string }; readonly samples: readonly LogicIrClaim[] }[],
): Promise<{ readonly representatives: readonly LogicIrClaim[]; readonly findings: readonly Finding[] }> {
  const representatives: LogicIrClaim[] = [];
  const findings: Finding[] = [];

  for (const candidate of candidates) {
    const clustered = await clusterFormalizationSamples({
      claimId: candidate.claim.id ?? "UNNAMED",
      samples: candidate.samples,
      stabilityThreshold: 0.6,
      ...(config.z3 === undefined ? {} : { z3Path: config.z3 }),
    });
    representatives.push(clustered.clustered.representative);
    findings.push(...clustered.findings);
  }

  return { representatives, findings };
}

/**
 * Group representative claims by their source spec file for per-spec Z3 analysis.
 *
 * @param candidates - original formalization candidates carrying `claim.provenance.file`
 * @param representatives - clustered representative claims in the same order as `candidates`
 * @returns array of {@link SpecClaimGroup} with one entry per unique spec file,
 *   ordered by first occurrence
 *
 * @remarks
 * Precondition: `representatives` is in the same order as `candidates` (one per candidate).
 * Precondition: `candidates[i]!.claim.provenance.file` is defined for all indices.
 * Postcondition: every representative appears in exactly one group.
 * Postcondition: groups are ordered by first occurrence of the spec file in `candidates`.
 *
 * Failure modes: none — pure computation over in-memory data, cannot throw.
 */
export function groupRepresentativesBySpec(
  candidates: readonly FormalizationCandidate[],
  representatives: readonly LogicIrClaim[],
): SpecClaimGroup[] {
  const groups = new Map<string, LogicIrClaim[]>();
  const order: string[] = [];

  for (let i = 0; i < representatives.length; i++) {
    const file = candidates[i]!.claim.provenance.file;
    let group = groups.get(file);
    if (group === undefined) {
      group = [];
      groups.set(file, group);
      order.push(file);
    }
    group.push(representatives[i]!);
  }

  return order.map((file) => ({ specFile: file, claims: groups.get(file)! }));
}

// ---------------------------------------------------------------------------
// Code-backwards pipeline work
// ---------------------------------------------------------------------------

/**
 * Execute code-backwards pipeline work: derive specs, formalize, cross-implication, blind comparison.
 *
 * @param config - run configuration with output dir, src dir, model, z3 path, and pair budget
 * @param traceOutput - source trace output from phase 9 containing findings and trace data
 * @param representativeClaims - original representative claims for cross-implication (from phase 7)
 * @param knownCapabilities - capability names from the catalog for informalization suggestions
 * @param claimCapabilityMap - mapping from claim ID to resolved capability name for grouping
 * @returns categorized findings: `allFindings` (complete), `logicFindings` (generated logic only),
 *   and `compareFindings` (aggregate + pairwise + blind comparison)
 *
 * @remarks
 * Precondition: `config.src` is defined (caller guards this).
 * Precondition: `traceOutput.traces` contains valid source traces from the trace phase.
 * Postcondition: gen_specs/, gen_specs_smt/, and smt/original/ directories are populated
 *   under `config.output`.
 * Postcondition: cross-implication queries and results are persisted verbatim.
 *
 * Failure modes:
 * - LLM failures in `deriveSpecsFromSource` or `runBlindComparison` propagate as uncaught errors.
 * - Z3 failures in formalization, logic analysis, or cross-implication propagate as uncaught errors.
 * - Filesystem write errors in `writeOutputAtomic` propagate as uncaught errors.
 *
 * Safety: invokes LLM (network I/O) and Z3 (subprocess) multiple times. Writes
 * intermediate artifacts to the output directory. Must not be called concurrently
 * with another code-backwards phase targeting the same output directory.
 *
 * **Pair budget** (value: `config.pairBudget`, unit: maximum claim pairs for Tier 2):
 * The `pairBudget` parameter controls how many individual original↔generated claim
 * pairs are checked in the bounded pairwise comparison (Tier 2). Each pair requires
 * two Z3 invocations (forward + reverse implication). The budget caps total solver
 * cost for this tier — when exceeded, remaining pairs are skipped silently and only
 * the aggregate (Tier 1) and already-checked pairs inform the blind comparison
 * (Tier 3). Typical values: 20–100 depending on spec complexity and CI time budget.
 *
 * **Tiered budget allocation:**
 * - Tier 1 (aggregate): Always runs, cost is O(capabilities) — one pair of queries
 *   per capability regardless of claim count within that capability.
 * - Tier 2 (bounded pairwise): Bounded by `pairBudget`. Greedy-matches claims
 *   within each capability up to the budget. Cost is O(pairBudget) Z3 calls.
 * - Tier 3 (blind comparison): LLM-based, cost is O(pairwise results) — one LLM
 *   call using all Tier 2 results as context.
 */
export async function runCodeBackwardsWork(
  config: RunConfig,
  traceOutput: { readonly findings: readonly Finding[]; readonly traces: readonly SourceTrace[] },
  representativeClaims: readonly LogicIrClaim[],
  knownCapabilities: readonly string[],
  claimCapabilityMap: ReadonlyMap<string, string>,
): Promise<{
  readonly allFindings: readonly Finding[];
  readonly logicFindings: readonly Finding[];
  readonly compareFindings: readonly Finding[];
}> {
  const allFindings: Finding[] = [];

  // --- Tiered comparison strategy overview ---
  // This function orchestrates a multi-tier comparison between original
  // (user-authored) specs and generated (code-derived) specs:
  //   Tier 0: Derive specs from source traces and formalize them to SMT-LIB.
  //   Tier 1: Direct implication — per-capability aggregate Z3 implication
  //           checks (cheap, always runs, catches broad mismatches).
  //   Tier 2: Bounded pairwise — greedy-matched cross-implication between
  //           individual original/generated claims within each capability
  //           (moderate cost, bounded by pairBudget).
  //   Tier 3: Blind comparison — LLM-based semantic comparison of pairwise
  //           results without bias from claim origin labels.
  // Each tier feeds findings into allFindings and later tiers consume
  // context from earlier tiers (e.g., blind comparison uses pairwise results).

  const derivedSpecs = await deriveSpecsFromSource({
    outputDir: config.output,
    srcDir: config.src!,
    model: config.model,
    traces: traceOutput.traces,
    suggestedCapabilities: knownCapabilities,
  });
  allFindings.push(...derivedSpecs.findings);

  const generatedFormal = await formalizeGeneratedSpecs({
    outputDir: config.output,
    generatedSpecs: derivedSpecs.specs,
    model: config.model,
    ...(config.z3 === undefined ? {} : { z3Path: config.z3 }),
  });
  allFindings.push(...generatedFormal.findings);

  const generatedLogic = await analyzeGeneratedLogic({
    claims: generatedFormal.claims.map((c) => ({ capability: c.capability, representative: c.representative })),
    outputDir: config.output,
    ...(config.z3 === undefined ? {} : { z3Path: config.z3 }),
  });
  allFindings.push(...generatedLogic.findings);

  // Compile original claims to SMT-LIB for cross-implication.
  // Use the claim-to-capability map for correct capability resolution.
  const originalFormalRefs: { capability: string; claimId: string; smtlibPath: RelativePath }[] = [];
  for (const claim of representativeClaims) {
    const compiled = compileSmtlib(claim);
    const capability = claimCapabilityMap.get(claim.claimId) ?? "unknown";
    const relativePath = toRelativePath(`smt/original/${compiled.sanitizedClaimId}.smt2`);
    await writeOutputAtomic(config.output, relativePath, compiled.smtlib);
    originalFormalRefs.push({ capability, claimId: claim.claimId, smtlibPath: relativePath });
  }

  // Group claims by capability for tiered comparison.
  const originalByCapability = new Map<string, { claimId: string; smtlibPath: RelativePath }[]>();
  for (const ref of originalFormalRefs) {
    const existing = originalByCapability.get(ref.capability);
    if (existing !== undefined) {
      existing.push({ claimId: ref.claimId, smtlibPath: ref.smtlibPath });
    } else {
      originalByCapability.set(ref.capability, [{ claimId: ref.claimId, smtlibPath: ref.smtlibPath }]);
    }
  }

  const generatedByCapability = new Map<string, { claimId: string; smtlibPath: RelativePath }[]>();
  for (const claim of generatedFormal.claims) {
    const existing = generatedByCapability.get(claim.capability);
    if (existing !== undefined) {
      existing.push({ claimId: claim.claimId, smtlibPath: claim.smtlibPath });
    } else {
      generatedByCapability.set(claim.capability, [{ claimId: claim.claimId, smtlibPath: claim.smtlibPath }]);
    }
  }

  // Tier 1: Capability-level aggregate comparison (cheap, always runs).
  // Goal: Detect broad directional mismatches — does the original spec imply
  // the generated spec (and vice versa) at the capability granularity?
  const aggregate = await runCapabilityAggregateComparison({
    outputDir: config.output,
    originalByCapability,
    generatedByCapability,
    ...(config.z3 === undefined ? {} : { z3Path: config.z3 }),
  });
  allFindings.push(...aggregate.findings);

  // Tier 2: Bounded pairwise cross-implication with greedy matching.
  // Goal: Identify specific claim-level divergences that aggregate checks
  // miss. Bounded by pairBudget to keep solver cost predictable.
  const pairwise = await runBoundedPairwiseComparison({
    outputDir: config.output,
    originalByCapability,
    generatedByCapability,
    pairBudget: config.pairBudget,
    ...(config.z3 === undefined ? {} : { z3Path: config.z3 }),
  });
  allFindings.push(...pairwise.findings);

  // Tier 3: Blind comparison — LLM judges pairwise results without knowing
  // which claims are "original" vs "generated", removing confirmation bias.
  // Goal: Surface semantic differences that formal implication cannot capture
  // (e.g., intent mismatches, missing context, over-specification).
  const blindComparison = await runBlindComparison({
    model: config.model,
    results: pairwise.results,
    generatedOnlyContext: derivedSpecs.specs.flatMap((spec) =>
      spec.sourceIdentifiers.map((id) => ({
        capability: spec.capability,
        claimId: id,
        summary: `Generated capability ${spec.capability} covers ${id}`,
      })),
    ),
  });
  allFindings.push(...blindComparison.findings);

  return {
    allFindings,
    logicFindings: generatedLogic.findings,
    compareFindings: [...aggregate.findings, ...pairwise.findings, ...blindComparison.findings],
  };
}
