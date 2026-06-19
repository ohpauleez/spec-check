/**
 * Shared type definitions for the analysis pipeline, including error types,
 * intermediate result interfaces, and the pipeline context structure.
 *
 * Provides the type contracts between pipeline phases without runtime logic.
 * Exports: `PipelineAbortError`, `PipelineContext`, `IngestionResult`, `AnalysisResult`.
 */
import type { Finding } from "../domain/findings.js";
import type { ClaimGraphOutput } from "../domain/claim-graph.js";
import type { ParsedDesign, ParsedProposal, ParsedSpec, ParsedTaskDocument } from "../domain/model.js";
import type { LogicIrClaim } from "../domain/logic-ir.js";
import type { ErrorCategory } from "../domain/errors.js";
import type { RunState } from "../domain/run-state.js";

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

  /**
   * Construct a pipeline abort error with a categorized failure reason.
   *
   * @param category - error category from the domain error hierarchy, used for exit code resolution
   * @param message - human-readable description of the abort condition
   *
   * @remarks
   * Precondition: `category` is a valid `ErrorCategory` discriminant.
   * Postcondition: `this.name` is set to `"PipelineAbortError"` for stack trace identification.
   * Postcondition: `this.category` is set for downstream exit-code mapping.
   *
   * Failure modes: none — constructor cannot fail.
   */
  constructor(category: ErrorCategory, message: string) {
    super(message);
    this.name = "PipelineAbortError";
    this.category = category;
  }
}

// ---------------------------------------------------------------------------
// Pipeline context and phase result interfaces
// ---------------------------------------------------------------------------

/**
 * Intermediate pipeline context carrying parsed artifacts between phases.
 *
 * @remarks
 * Each field is populated by its corresponding phase and consumed by later phases.
 * Fields are optional because earlier phases may not have run or may have produced
 * no output (e.g., no proposal document found).
 */
export interface PipelineContext {
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
export interface IngestionResult {
  readonly state: RunState;
  readonly catalogResult: { readonly catalog: { readonly documents: readonly { readonly path: string; readonly type: string; readonly capability?: string }[] }; readonly findings: readonly Finding[] };
  readonly ctx: PipelineContext;
}

/**
 * Result of the analysis phases (4-8).
 */
export interface AnalysisResult {
  readonly state: RunState;
  readonly claimGraphResult: { readonly graph: ClaimGraphOutput["graph"]; readonly claimFindings: readonly Finding[]; readonly coverageFindings: readonly Finding[] };
  readonly clusterResult: { readonly representatives: readonly LogicIrClaim[]; readonly findings: readonly Finding[] };
  readonly qualResult: { readonly pass1Findings: readonly Finding[]; readonly pass2Findings: readonly Finding[] };
  readonly logicResult: { readonly findings: readonly Finding[] };
}
