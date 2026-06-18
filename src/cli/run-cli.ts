import type { RunConfig } from "./config.js";
import type { Finding } from "../domain/findings.js";
import type { ClaimGraphOutput } from "../domain/claim-graph.js";
import type { ParsedDesign, ParsedProposal, ParsedSpec, ParsedTaskDocument } from "../domain/model.js";
import type { LogicIrClaim } from "../domain/logic-ir.js";
import type { ErrorCategory } from "../domain/errors.js";
import { toRelativePath, type RelativePath } from "../domain/branded.js";
import { isCommandAvailable } from "../adapters/process.js";
import { writeOutputAtomic } from "../adapters/fs.js";
import { buildClaimGraph } from "../domain/claim-graph.js";
import { createProgressEvent, emitProgressEvent } from "../domain/progress.js";
import { createInitialRunState, markPhaseCompleted, addFindings, type RunState } from "../domain/run-state.js";
import { buildCatalog, inferCapabilityName } from "../domain/parser/catalog.js";
import { parseDesign } from "../domain/parser/design.js";
import { parseProposal } from "../domain/parser/proposal.js";
import { parseSpec } from "../domain/parser/spec.js";
import { parseTaskDocument } from "../domain/parser/task.js";
import { analyzeCoverage } from "../domain/spec-forward/coverage.js";
import { runQualitativePasses } from "../domain/spec-forward/qualitative.js";
import { formalizeClaims, type FormalizationCandidate } from "../domain/formal/formalize.js";
import { clusterFormalizationSamples } from "../domain/formal/clustering.js";
import { runLogicAnalysis, type SpecClaimGroup } from "../domain/formal/logic-analysis.js";
import { writeManifest, buildManifestEntries, invalidateStaleManifest } from "../domain/reporting/manifest.js";
import { writePhaseReports, writeSummaryReport } from "../domain/reporting/render.js";
import { traceClaimsToSource, type SourceTrace } from "../domain/code-backwards/trace.js";
import { deriveSpecsFromSource } from "../domain/code-backwards/derive.js";
import { formalizeGeneratedSpecs } from "../domain/code-backwards/gen-formal.js";
import { analyzeGeneratedLogic } from "../domain/code-backwards/gen-logic.js";
import { runCapabilityAggregateComparison, runBoundedPairwiseComparison } from "../domain/code-backwards/cross-implication.js";
import { runBlindComparison } from "../domain/code-backwards/blind-compare.js";
import { analyzeTaskSourceConsistency } from "../domain/tasks-analysis.js";
import { compileSmtlib } from "../domain/formal/smtlib.js";

// ---------------------------------------------------------------------------
// Pipeline abort mechanism
// ---------------------------------------------------------------------------

/**
 * Typed error for pipeline phase aborts.
 *
 * @remarks
 * Extends `Error` to maintain compatibility with the try/catch progress event
 * infrastructure. Carries a `category` field from the error hierarchy so the
 * top-level catch can resolve the correct exit code.
 *
 * Per the style guide: exceptions are acceptable for "infrastructure failures
 * that are truly exceptional at the current layer." Pipeline phase aborts are
 * exactly this — a domain operation returned an unrecoverable error, and the
 * orchestration layer needs to propagate it while emitting progress events.
 */
export class PipelineAbortError extends Error {
  readonly category: ErrorCategory;

  constructor(category: ErrorCategory, message: string) {
    super(message);
    this.name = "PipelineAbortError";
    this.category = category;
  }
}

/**
 * Intermediate pipeline context carrying parsed artifacts between phases.
 *
 * @remarks
 * Each field is populated by its corresponding phase and consumed by later phases.
 * Fields are optional because earlier phases may not have run or may have produced
 * no output (e.g., no proposal document found).
 */
interface PipelineContext {
  readonly proposal?: ParsedProposal;
  readonly design?: ParsedDesign;
  readonly specs: readonly ParsedSpec[];
  readonly tasks?: ParsedTaskDocument;
  readonly coverageFindings: readonly Finding[];
  readonly qualitativeFindings: readonly Finding[];
  readonly representativeClaims: readonly LogicIrClaim[];
  readonly logicFindings: readonly Finding[];
}

/**
 * Result of the ingestion phases (1-3).
 */
interface IngestionResult {
  readonly state: RunState;
  readonly catalogResult: { readonly catalog: { readonly documents: readonly { readonly path: string; readonly type: string; readonly capability?: string }[] }; readonly findings: readonly Finding[] };
  readonly ctx: PipelineContext;
}

/**
 * Result of the analysis phases (4-8).
 */
interface AnalysisResult {
  readonly state: RunState;
  readonly claimGraphResult: { readonly graph: ClaimGraphOutput["graph"]; readonly claimFindings: readonly Finding[]; readonly coverageFindings: readonly Finding[] };
  readonly clusterResult: { readonly representatives: readonly LogicIrClaim[]; readonly findings: readonly Finding[] };
  readonly qualResult: { readonly pass1Findings: readonly Finding[]; readonly pass2Findings: readonly Finding[] };
  readonly logicResult: { readonly findings: readonly Finding[] };
}

// ---------------------------------------------------------------------------
// Main entry point — orchestrates phase groups
// ---------------------------------------------------------------------------

/**
 * Execute the full analysis pipeline with per-phase progress events.
 *
 * @param config - resolved runtime configuration
 * @returns run state after all completed phases
 *
 * @throws {PipelineAbortError} when a phase encounters an unrecoverable error
 *   (dependency missing, catalog unreadable, LLM failure after retries)
 *
 * @remarks
 * Precondition: `config` has been validated by `resolveRunConfig`.
 * Postcondition: all completed phases are recorded in the returned state;
 * each phase emits its own started/completed/failed progress event.
 * Invariant: findings are append-only across all phases.
 */
export async function runCli(config: RunConfig): Promise<RunState> {
  // Phases 1-3: dependency check, catalog build, document parsing.
  const ingestion = await runIngestionPhases(config);

  // Phases 4-8: claim graph, qualitative, formalization, clustering, logic.
  const analysis = await runAnalysisPhases(config, ingestion);

  // Phases 9-10: source traceability and code-backwards (only when --src provided).
  let state = analysis.state;
  let srcTraceFindings: readonly Finding[] | undefined;
  let srcLogicFindings: readonly Finding[] | undefined;
  let compareFindings: readonly Finding[] | undefined;

  if (config.src !== undefined) {
    // Extract known capability names from catalog for informalization suggestions.
    const knownCapabilities = [
      ...new Set(
        ingestion.catalogResult.catalog.documents
          .filter((d) => d.capability !== undefined)
          .map((d) => d.capability as string),
      ),
    ].sort();

    const srcResult = await runSourcePhases(
      config,
      state,
      analysis.claimGraphResult,
      analysis.clusterResult.representatives,
      knownCapabilities,
    );
    state = srcResult.state;
    srcTraceFindings = srcResult.srcTraceFindings;
    srcLogicFindings = srcResult.srcLogicFindings;
    compareFindings = srcResult.compareFindings;
  }

  // Phase 11: generate reports and manifest.
  state = await runReportingPhase(config, state, analysis, srcTraceFindings, srcLogicFindings, compareFindings);

  return state;
}

// ---------------------------------------------------------------------------
// Phase group: Ingestion (Phases 1-3)
// ---------------------------------------------------------------------------

/**
 * Execute ingestion phases: dependency check, catalog build, and document parsing.
 *
 * @param config - resolved runtime configuration
 * @returns ingestion result containing run state, catalog output, and pipeline context
 *
 * @throws {PipelineAbortError} when dependencies are missing or inputs are unreadable
 *
 * @remarks
 * Postcondition: state contains findings from catalog and parsing phases.
 * Postcondition: progress events have been emitted for all three phases.
 */
async function runIngestionPhases(config: RunConfig): Promise<IngestionResult> {
  let state = createInitialRunState();

  // [RAE-MANIFEST-STALE] Remove stale manifest before analysis begins.
  await invalidateStaleManifest(config.output);

  // Phase 1: Check external dependencies.
  state = await runPhase("dependencies", state, async () => {
    const dependencyError = checkDependencies(config);
    if (dependencyError !== undefined) {
      throw new PipelineAbortError("DependencyError", dependencyError);
    }
  });

  // Phase 2: Build document catalog from input paths.
  const catalogResult = await runPhaseWithResult("catalog", state, async () => {
    const result = await buildCatalog(config.inputs);
    if (!result.ok) {
      throw new PipelineAbortError("CatalogError", `unreadable input path: ${result.error.path}`);
    }
    return result.value;
  });
  state = addFindings(catalogResult.state, catalogResult.value.findings);

  // Phase 3: Parse all discovered documents.
  const parsed = await runPhaseWithResult("parse", state, async () => {
    return await parseAllDocuments(catalogResult.value);
  });
  state = parsed.state;

  const ctx: PipelineContext = {
    ...parsed.value,
    coverageFindings: [],
    qualitativeFindings: [],
    representativeClaims: [],
    logicFindings: [],
  };

  // Accumulate structural and unparsed-line findings from parsing.
  state = addFindings(state, collectParserFindings(ctx));

  return { state, catalogResult: catalogResult.value, ctx };
}

// ---------------------------------------------------------------------------
// Phase group: Analysis (Phases 4-8)
// ---------------------------------------------------------------------------

/**
 * Execute analysis phases: claim graph, qualitative, formalization, clustering, logic.
 *
 * @param config - resolved runtime configuration
 * @param ingestion - result from ingestion phases
 * @returns analysis result with updated state and phase outputs
 *
 * @throws {PipelineAbortError} when qualitative or formalization phases fail
 *
 * @remarks
 * Postcondition: state contains findings from all analysis phases.
 * Postcondition: progress events have been emitted for all five phases.
 */
async function runAnalysisPhases(config: RunConfig, ingestion: IngestionResult): Promise<AnalysisResult> {
  let state = ingestion.state;
  const ctx = ingestion.ctx;

  // Phase 4: Build claim graph and analyze coverage.
  const claimGraphResult = await runPhaseWithResult("claim-graph", state, async () => {
    return runClaimGraphPhase(ctx);
  });
  state = addFindings(claimGraphResult.state, claimGraphResult.value.claimFindings);
  state = addFindings(state, claimGraphResult.value.coverageFindings);

  // Phase 5: Run qualitative review passes.
  const qualResult = await runPhaseWithResult("qualitative", state, async () => {
    const result = await runQualitativePasses({
      specs: ctx.specs,
      model: config.model,
      ...(ctx.proposal === undefined ? {} : { proposal: ctx.proposal }),
      ...(ctx.design === undefined ? {} : { design: ctx.design }),
    });
    if (!result.ok) {
      throw new PipelineAbortError("QualitativeError", result.error.message);
    }
    return result.value;
  });
  state = addFindings(qualResult.state, [...qualResult.value.pass1Findings, ...qualResult.value.pass2Findings]);

  // Phase 6: Formalize claims via LLM.
  const formalResult = await runPhaseWithResult("formalization", state, async () => {
    const result = await formalizeClaims({
      claims: claimGraphResult.value.graph.claims,
      model: config.model,
      samplesPerClaim: 1,
    });
    if (!result.ok) {
      throw new PipelineAbortError("FormalizationError", result.error.map((e) => e.message).join("; "));
    }
    if (result.value.errors.length > 0 && result.value.candidates.length === 0) {
      throw new PipelineAbortError("FormalizationError", result.value.errors.map((e) => e.message).join("; "));
    }
    return result.value;
  });
  state = addFindings(formalResult.state, formalResult.value.findings);

  // Phase 7: Cluster formalization samples and select representatives.
  const clusterResult = await runPhaseWithResult("clustering", state, async () => {
    return await runClusteringPhase(config, formalResult.value.candidates);
  });
  state = addFindings(clusterResult.state, clusterResult.value.findings);

  // Phase 8: Run formal logic analysis on per-spec combined SMT-LIB.
  const logicResult = await runPhaseWithResult("logic", state, async () => {
    const groups = groupRepresentativesBySpec(formalResult.value.candidates, clusterResult.value.representatives);
    const output = await runLogicAnalysis({
      groups,
      outputDir: config.output,
      ...(config.z3 === undefined ? {} : { z3Path: config.z3 }),
    });
    return output;
  });
  state = addFindings(logicResult.state, logicResult.value.findings);

  return {
    state,
    claimGraphResult: claimGraphResult.value,
    clusterResult: clusterResult.value,
    qualResult: qualResult.value,
    logicResult: logicResult.value,
  };
}

// ---------------------------------------------------------------------------
// Phase group: Reporting (Phase 11)
// ---------------------------------------------------------------------------

/**
 * Execute the reporting phase: generate reports and write manifest.
 *
 * @param config - resolved runtime configuration
 * @param state - current run state from all prior phases
 * @param analysis - analysis phase results for report routing
 * @param srcTraceFindings - source trace findings (undefined if phase was skipped)
 * @param srcLogicFindings - source logic findings (undefined if phase was skipped)
 * @param compareFindings - comparison findings (undefined if phase was skipped)
 * @returns updated run state with reporting phase completed
 *
 * @remarks
 * Postcondition: all report files and manifest are written to the output directory.
 * Invariant: manifest is written last (atomic completion marker).
 */
async function runReportingPhase(
  config: RunConfig,
  state: RunState,
  analysis: AnalysisResult,
  srcTraceFindings: readonly Finding[] | undefined,
  srcLogicFindings: readonly Finding[] | undefined,
  compareFindings: readonly Finding[] | undefined,
): Promise<RunState> {
  const skippedPhases = computeSkippedPhases(config);

  return await runPhase("reporting", state, async () => {
    const phaseFiles = await writePhaseReports({
      outputDir: config.output,
      report11: analysis.qualResult.pass1Findings,
      report12: analysis.qualResult.pass2Findings,
      report13: analysis.claimGraphResult.coverageFindings,
      logicReport: analysis.logicResult.findings,
      ...(srcTraceFindings === undefined ? {} : { srcTraceReport: srcTraceFindings }),
      ...(srcLogicFindings === undefined ? {} : { srcLogicReport: srcLogicFindings }),
      ...(compareFindings === undefined ? {} : { compareReport: compareFindings }),
    });
    const summaryFile = await writeSummaryReport({
      outputDir: config.output,
      allFindings: state.findings,
      skippedPhases,
    });
    await writeManifest(config.output, buildManifestEntries([...phaseFiles, summaryFile]));
  });
}

// ---------------------------------------------------------------------------
// Phase helpers — each extracts a cohesive unit of pipeline work.
// ---------------------------------------------------------------------------

/**
 * Parse all documents discovered by the catalog phase.
 *
 * @param catalogOutput - catalog build output with document list and findings
 * @returns parsed proposal, design, specs, and tasks
 *
 * @remarks
 * Postcondition: all parseable documents are parsed; unparsed documents
 * produce structural findings in the returned parsed specs.
 */
async function parseAllDocuments(catalogOutput: {
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
 * Collect structural and unparsed-line findings from parsed documents.
 *
 * @param ctx - pipeline context with parsed documents
 * @returns findings for structural issues and unparsed lines
 *
 * @remarks
 * Postcondition: every structural issue and every unparsed line has a corresponding
 * finding with provenance linking back to the source file.
 */
function collectParserFindings(ctx: Pick<PipelineContext, "proposal" | "design" | "specs" | "tasks">): readonly Finding[] {
  const structural: Finding[] = ctx.specs.flatMap((spec) =>
    spec.structuralFindings.map((finding) => ({
      severity: "warning" as const,
      category: "parser.structural",
      provenance: finding.provenance,
      description: finding.message,
      evidence: [{ kind: "file", value: spec.file }],
    })),
  );

  const unparsed: Finding[] = [
    ...(ctx.proposal?.unparsed ?? []).map((line) => ({
      severity: "warning" as const,
      category: "parser.unparsed_line",
      provenance: line.provenance,
      description: "Unparsed proposal line preserved",
      evidence: [{ kind: "line", value: line.text }],
    })),
    ...(ctx.design?.unparsed ?? []).map((line) => ({
      severity: "warning" as const,
      category: "parser.unparsed_line",
      provenance: line.provenance,
      description: "Unparsed design line preserved",
      evidence: [{ kind: "line", value: line.text }],
    })),
    ...ctx.specs.flatMap((spec) =>
      spec.unparsed.map((line) => ({
        severity: "warning" as const,
        category: "parser.unparsed_line",
        provenance: line.provenance,
        description: "Unparsed spec line preserved",
        evidence: [{ kind: "line", value: line.text }],
      })),
    ),
    ...(ctx.tasks?.unparsed ?? []).map((line) => ({
      severity: "warning" as const,
      category: "parser.unparsed_line",
      provenance: line.provenance,
      description: "Unparsed task line preserved",
      evidence: [{ kind: "line", value: line.text }],
    })),
  ];

  return [...structural, ...unparsed];
}

/**
 * Build claim graph and compute coverage findings.
 *
 * @param ctx - pipeline context with parsed documents
 * @returns claim graph output and separate coverage findings
 *
 * @remarks
 * Postcondition: all claims have provenance; coverage analysis is deterministic.
 */
function runClaimGraphPhase(ctx: Pick<PipelineContext, "proposal" | "design" | "specs" | "tasks">): {
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
 * Cluster formalization samples and extract representative claims.
 *
 * @param config - run configuration with z3 path
 * @param candidates - formalization candidates to cluster
 * @returns representative claims and clustering findings
 *
 * @remarks
 * Postcondition: exactly one representative per candidate.
 * Postcondition: ambiguity findings emitted for unstable clusters.
 */
async function runClusteringPhase(
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
 * @param candidates - original formalization candidates (carry provenance.file)
 * @param representatives - clustered representatives (same order as candidates)
 * @returns SpecClaimGroup array with one entry per unique spec file
 *
 * @remarks
 * Precondition: `representatives` is in the same order as `candidates` (one per candidate).
 * Postcondition: every representative appears in exactly one group.
 * Postcondition: groups are ordered by first occurrence of the spec file.
 */
function groupRepresentativesBySpec(
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

/**
 * Run source traceability and code-backwards phases.
 *
 * @param config - run configuration
 * @param initialState - current run state
 * @param claimGraphResult - claim graph from the specs-forward pipeline
 * @param representativeClaims - representative formalized claims
 * @returns updated state and categorized findings for reports
 *
 * @remarks
 * Precondition: `config.src` is defined (caller guards this).
 * Postcondition: all source-related phases have emitted progress events.
 */
async function runSourcePhases(
  config: RunConfig,
  initialState: RunState,
  claimGraphResult: { readonly graph: ClaimGraphOutput["graph"] },
  representativeClaims: readonly LogicIrClaim[],
  knownCapabilities: readonly string[],
): Promise<{
  readonly state: RunState;
  readonly srcTraceFindings: readonly Finding[];
  readonly srcLogicFindings: readonly Finding[];
  readonly compareFindings: readonly Finding[];
}> {
  let state = initialState;

  // Phase 9: Source traceability — scan source for claim identifiers.
  const traceResult = await runPhaseWithResult("source-trace", state, async () => {
    const traceOutput = await traceClaimsToSource({
      srcDir: config.src!,
      claimGraph: claimGraphResult.graph,
    });
    const taskFindings = analyzeTaskSourceConsistency({
      claimGraph: claimGraphResult.graph,
      traces: traceOutput.traces,
    });
    return { traceOutput, taskFindings };
  });
  state = addFindings(traceResult.state, traceResult.value.traceOutput.findings);
  state = addFindings(state, traceResult.value.taskFindings);

  // Phase 10: Code-backwards — derive specs, formalize, cross-imply, blind compare.
  // Build claimId → capability mapping from the claim graph provenance paths.
  const claimCapabilityMap = new Map<string, string>();
  for (const claim of claimGraphResult.graph.claims) {
    if (claim.id !== undefined) {
      const cap = inferCapabilityName(claim.provenance.file);
      if (cap !== undefined) {
        claimCapabilityMap.set(claim.id, cap);
      }
    }
  }

  const codeResult = await runPhaseWithResult("code-backwards", state, async () => {
    return await runCodeBackwardsWork(
      config,
      traceResult.value.traceOutput,
      representativeClaims,
      knownCapabilities,
      claimCapabilityMap,
    );
  });
  state = addFindings(codeResult.state, codeResult.value.allFindings);

  return {
    state,
    srcTraceFindings: [...traceResult.value.traceOutput.findings, ...traceResult.value.taskFindings],
    srcLogicFindings: codeResult.value.logicFindings,
    compareFindings: codeResult.value.compareFindings,
  };
}

/**
 * Execute code-backwards pipeline work: derive specs, formalize, cross-implication, blind comparison.
 *
 * @param config - run configuration
 * @param traceOutput - source trace output from phase 9
 * @param representativeClaims - original representative claims for cross-implication
 * @param knownCapabilities - capability names from the catalog for informalization suggestions
 * @param claimCapabilityMap - mapping from claim ID to resolved capability name
 * @returns categorized findings from all code-backwards sub-phases
 *
 * @remarks
 * Postcondition: gen_specs/, gen_specs_smt/, and smt/original/ directories are populated.
 * Postcondition: cross-implication queries and results are persisted verbatim.
 */
async function runCodeBackwardsWork(
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
  const aggregate = await runCapabilityAggregateComparison({
    outputDir: config.output,
    originalByCapability,
    generatedByCapability,
    ...(config.z3 === undefined ? {} : { z3Path: config.z3 }),
  });
  allFindings.push(...aggregate.findings);

  // Tier 2: Bounded pairwise cross-implication with greedy matching.
  const pairwise = await runBoundedPairwiseComparison({
    outputDir: config.output,
    originalByCapability,
    generatedByCapability,
    pairBudget: config.pairBudget,
    ...(config.z3 === undefined ? {} : { z3Path: config.z3 }),
  });
  allFindings.push(...pairwise.findings);

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

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Compute which phases were skipped based on the actual run configuration.
 *
 * @param config - resolved run configuration
 * @returns list of phase names that were not enabled for this run
 *
 * @remarks
 * Postcondition: only phases that were genuinely not executed are listed.
 */
function computeSkippedPhases(config: RunConfig): readonly string[] {
  const skipped: string[] = [];
  if (config.src === undefined) {
    skipped.push("source-trace", "code-backwards");
  }
  return skipped;
}

// ---------------------------------------------------------------------------
// Infrastructure — dependency checking and phase execution with progress events.
// ---------------------------------------------------------------------------

/**
 * Verify that required external tools are available.
 *
 * @param config - run configuration
 * @returns error message if a dependency is missing, undefined otherwise
 *
 * @remarks
 * Postcondition: when undefined is returned, both `opencode` and `z3` binaries
 * are available on the system PATH (or at the configured path).
 */
function checkDependencies(config: RunConfig): string | undefined {
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
 * Execute a pipeline phase, emitting progress events and recording completion.
 *
 * @param name - phase name for progress events and state tracking
 * @param state - current run state
 * @param operation - async phase work
 * @returns updated run state with the phase marked as completed
 *
 * @throws {PipelineAbortError} if the operation throws a PipelineAbortError
 * @throws {Error} if the operation throws any other error
 *
 * @remarks
 * Postcondition: exactly one started and one completed/failed event is emitted.
 * Invariant: on failure, the failed event is emitted before the error propagates.
 */
async function runPhase(name: string, state: RunState, operation: () => Promise<void>): Promise<RunState> {
  const timestamp = new Date().toISOString();
  const startedAt = Date.now();
  emitProgressEvent(createProgressEvent(name, "started", undefined, timestamp));
  try {
    await operation();
    const nextState = markPhaseCompleted(state, name);
    emitProgressEvent(createProgressEvent(name, "completed", Date.now() - startedAt));
    return nextState;
  } catch (error: unknown) {
    emitProgressEvent(createProgressEvent(name, "failed", Date.now() - startedAt));
    if (error instanceof Error) {
      throw error;
    }
    throw new PipelineAbortError("PipelineError", `phase failed: ${name}`);
  }
}

/**
 * Execute a pipeline phase that returns a value, with progress events.
 *
 * @param name - phase name for progress events and state tracking
 * @param state - current run state
 * @param operation - async phase work that produces a value
 * @returns the phase result and updated run state
 *
 * @throws {PipelineAbortError} if the operation throws a PipelineAbortError
 * @throws {Error} if the operation throws any other error
 *
 * @remarks
 * Postcondition: the returned value is the result of the operation; state
 * includes the phase in its completed list.
 */
async function runPhaseWithResult<T>(
  name: string,
  state: RunState,
  operation: () => Promise<T>,
): Promise<{ readonly state: RunState; readonly value: T }> {
  const timestamp = new Date().toISOString();
  const startedAt = Date.now();
  emitProgressEvent(createProgressEvent(name, "started", undefined, timestamp));
  try {
    const value = await operation();
    const nextState = markPhaseCompleted(state, name);
    emitProgressEvent(createProgressEvent(name, "completed", Date.now() - startedAt));
    return { state: nextState, value };
  } catch (error: unknown) {
    emitProgressEvent(createProgressEvent(name, "failed", Date.now() - startedAt));
    if (error instanceof Error) {
      throw error;
    }
    throw new PipelineAbortError("PipelineError", `phase failed: ${name}`);
  }
}
