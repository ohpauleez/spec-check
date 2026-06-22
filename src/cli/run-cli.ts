/**
 * Main pipeline orchestrator that coordinates all analysis phases — ingestion,
 * qualitative checks, formalization, logic analysis, source tracing, and reporting.
 *
 * Central coordination point between config resolution and final output.
 * Exports: `runCli`, `PipelineAbortError`.
 */
import type { RunConfig } from "./config.js";
import type { Finding } from "../domain/findings.js";
import type { LogicIrClaim } from "../domain/logic-ir.js";
import type { ClaimGraphOutput } from "../domain/claim-graph.js";
import type { PipelineContext, IngestionResult, AnalysisResult } from "./pipeline-types.js";
import { createInitialRunState, addFindings, type RunState } from "../domain/run-state.js";
import { buildCatalog, inferCapabilityName, type CatalogEmptyReason } from "../domain/parser/catalog.js";
import { assertNever } from "../domain/assert.js";
import { runQualitativePasses } from "../domain/spec-forward/qualitative.js";
import { formalizeClaims } from "../domain/formal/formalize.js";
import { runLogicAnalysis } from "../domain/formal/logic-analysis.js";
import { writeManifest, buildManifestEntries, invalidateStaleManifest } from "../domain/reporting/manifest.js";
import { writePhaseReports, writeSummaryReport } from "../domain/reporting/render.js";
import { traceClaimsToSource } from "../domain/code-backwards/trace.js";
import { analyzeTaskSourceConsistency } from "../domain/tasks-analysis.js";
import { PipelineAbortError } from "./pipeline-types.js";
import { runPhase, runPhaseWithResult } from "./phase-runner.js";
import {
  checkDependencies,
  computeSkippedPhases,
  parseAllDocuments,
  collectParserFindings,
  runClaimGraphPhase,
  runClusteringPhase,
  runMergePhase,
  groupRepresentativesBySpec,
  runCodeBackwardsWork,
} from "./pipeline-helpers.js";

export { PipelineAbortError } from "./pipeline-types.js";

// Exported for testing — formats user-facing catalog-empty diagnostics.
export { formatCatalogEmptyMessage };

/**
 * Format a user-facing diagnostic message for an empty catalog result.
 *
 * @param reason - structured empty-catalog classification with variant-specific context
 * @returns human-readable message suitable for stderr output, including actionable
 *   remediation guidance where applicable
 *
 * @remarks
 * Precondition: `reason.kind` is one of the three `CatalogEmptyReason` variants.
 * Postcondition: returned string is non-empty and includes the variant-specific count
 *   or policy reason for diagnostics.
 * Invariant: exhaustive switch ensures all variants are handled; adding a new variant
 *   produces a compile-time error.
 *
 * Failure modes: none — pure computation, cannot throw.
 */
function formatCatalogEmptyMessage(reason: CatalogEmptyReason): string {
  switch (reason.kind) {
    case "no_recognized_docs":
      return `No OpenSpec documents found in ${String(reason.inputCount)} provided input(s). Ensure input paths contain proposal.md, design.md, or spec.md documents.`;
    case "all_archived":
      return `All ${String(reason.archivedCount)} discovered documents are in archived change directories. Use --allow-archive to treat explicitly provided archived inputs as active.`;
    case "all_filtered":
      return `All ${String(reason.filteredCount)} discovered documents were excluded by policy: ${reason.filterReason}.`;
    default:
      return assertNever(reason);
  }
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
      config.src,
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
 * Precondition: `config` has been validated by `resolveRunConfig`.
 * Postcondition: state contains findings from catalog and parsing phases.
 * Postcondition: progress events have been emitted for all three phases.
 * Postcondition: stale manifest has been invalidated before analysis begins.
 *
 * Failure modes:
 * - Throws `PipelineAbortError("DependencyError", ...)` if `opencode` or `z3` is not on PATH.
 * - Throws `PipelineAbortError("CatalogError", ...)` if an input path is unreadable.
 *
 * Safety: performs filesystem I/O (manifest invalidation, catalog read, document parse).
 * Must not be called concurrently with another pipeline run targeting the same output directory.
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
    const result = await buildCatalog(config.inputs, { allowArchive: config.allowArchive });
    if (!result.ok) {
      throw new PipelineAbortError("CatalogError", `unreadable input path: ${result.error.path}`);
    }
    if (result.value.catalog.documents.length === 0 && result.value.emptyReason !== undefined) {
      throw new PipelineAbortError("CatalogError", formatCatalogEmptyMessage(result.value.emptyReason));
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
    mergedSpecs: [],
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
 * Precondition: `ingestion` was produced by a successful `runIngestionPhases` call
 * (i.e., catalog and parsed documents are populated).
 * Postcondition: state contains findings from all analysis phases.
 * Postcondition: progress events have been emitted for all five phases.
 *
 * Failure modes:
 * - Throws `PipelineAbortError("QualitativeError", ...)` if LLM qualitative passes fail.
 * - Throws `PipelineAbortError("FormalizationError", ...)` if LLM formalization fails or
 *   produces only errors with no candidates.
 *
 * Safety: invokes LLM and Z3 solver as external processes. Network failures in LLM
 * calls will surface as PipelineAbortError after internal retry exhaustion.
 */
async function runAnalysisPhases(config: RunConfig, ingestion: IngestionResult): Promise<AnalysisResult> {
  let state = ingestion.state;
  let ctx = ingestion.ctx;

  const mergeResult = await runPhaseWithResult("merge", state, async () => {
    return runMergePhase({
      catalogDocuments: ingestion.catalogResult.catalog.documents,
      parsedSpecs: ctx.specs,
    });
  });
  state = mergeResult.state;
  ctx = {
    ...ctx,
    mergedSpecs: mergeResult.value,
  };
  state = addFindings(state, ctx.mergedSpecs.flatMap((spec) => spec.findings));

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
      timeoutMs: config.timeoutMs,
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
      timeoutMs: config.timeoutMs,
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
    const nonEmptyMergedSpecs = ctx.mergedSpecs.filter((spec) => spec.requirements.length > 0);
    const groups = groupRepresentativesBySpec(
      formalResult.value.candidates,
      clusterResult.value.representatives,
      nonEmptyMergedSpecs,
    );
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
 * Precondition: all prior phases have completed and their findings are in `state`.
 * Postcondition: all report files and manifest are written to the output directory.
 * Invariant: manifest is written last (atomic completion marker).
 *
 * Failure modes: filesystem write errors propagate as uncaught exceptions (rare
 * in practice — output directory was already written to by earlier phases).
 *
 * Safety: writes to the output directory. Must not be called concurrently with
 * another reporting phase targeting the same output directory.
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
// Phase group: Source traceability (Phases 9-10)
// ---------------------------------------------------------------------------

/**
 * Run source traceability and code-backwards phases.
 *
 * @param config - run configuration for the pipeline
 * @param srcDir - resolved source directory path (caller guarantees non-undefined)
 * @param initialState - current run state from prior phases
 * @param claimGraphResult - claim graph from the specs-forward pipeline
 * @param representativeClaims - representative formalized claims from clustering
 * @param knownCapabilities - known capability names from the catalog for informalization
 * @returns updated state and categorized findings for reports
 *
 * @remarks
 * Precondition: `srcDir` is a readable directory path (caller narrows from `config.src`).
 * Precondition: `claimGraphResult.graph.claims` contains valid provenance paths.
 * Postcondition: all source-related phases have emitted progress events.
 * Postcondition: returned findings are partitioned into trace, logic, and compare categories.
 *
 * Failure modes:
 * - Throws `PipelineAbortError` if source trace or code-backwards work fails
 *   (e.g., source directory unreadable, LLM or Z3 failures).
 *
 * Safety: reads from `srcDir` directory and invokes external processes (LLM, Z3).
 * Must not be called concurrently with another source phase targeting the same directories.
 */
async function runSourcePhases(
  config: RunConfig,
  srcDir: string,
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
      srcDir,
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
      srcDir,
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
