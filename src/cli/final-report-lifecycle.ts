/** Testable orchestration for the post-completion final-report lifecycle. */
import { precondition } from "../domain/assert.js";
import type { RunState } from "../domain/run-state.js";
import type { Result } from "../domain/result.js";
import {
  INITIAL_FINAL_REPORT_LIFECYCLE,
  reduceFinalReportLifecycle,
  type FinalReportError,
  type FinalReportFile,
  type FinalReportLifecycleEvent,
  type FinalReportLifecycleState,
} from "../domain/reporting/final-report.js";

/** Result and state returned by the progress-decorated report attempt. */
export interface FinalReportAttempt {
  readonly state: RunState;
  readonly result: Result<FinalReportFile, FinalReportError>;
}

/** Side effects required after the report attempt returns. */
export interface FinalReportLifecycleEffects<TSummary> {
  readonly attempt: () => Promise<FinalReportAttempt>;
  readonly cleanup: () => Promise<void>;
  readonly addWarning: (state: RunState, error: FinalReportError) => RunState;
  readonly invalidateMarker: () => Promise<void>;
  readonly rewriteSummary: (state: RunState) => Promise<TSummary>;
  readonly refreshManifest: (summary: TSummary) => Promise<void>;
  readonly observeTransition?: (event: FinalReportLifecycleEvent, state: FinalReportLifecycleState) => void;
}

/** Successful handled outcomes at the orchestration boundary. */
export interface FinalReportHandledOutcome {
  readonly ok: true;
  readonly state: RunState;
  readonly lifecycle: FinalReportLifecycleState;
  readonly outcome: "report_available" | "warning_persisted";
}

/** Fatal output failure after core completion. */
export interface FinalReportOutputFailure {
  readonly ok: false;
  readonly error: {
    readonly operation: "final-report cleanup" | "final-report marker invalidation" | "final-report summary rewrite" | "final-report manifest refresh";
    readonly cause: unknown;
    readonly lifecycle: FinalReportLifecycleState;
  };
}

/** Closed result of coordinating the optional post-completion phase. */
export type FinalReportCoordinationResult = FinalReportHandledOutcome | FinalReportOutputFailure;

/**
 * Execute final-report generation and persistence while advancing the reference model.
 *
 * @param initialState - completed reporting state before the optional attempt
 * @param effects - progress-decorated attempt and injectable persistence boundaries
 * @returns handled report/warning outcome or typed fatal output failure
 *
 * @remarks
 * Precondition: core reports and the current core manifest already exist.
 * Postcondition: success reaches `report_available` or `warning_persisted`;
 * every cleanup or persistence exception reaches `output_failed`. The function
 * is the production orchestration kernel used directly by differential tests.
 */
export async function coordinateFinalReportLifecycle<TSummary>(
  initialState: RunState,
  effects: FinalReportLifecycleEffects<TSummary>,
): Promise<FinalReportCoordinationResult> {
  let lifecycle = INITIAL_FINAL_REPORT_LIFECYCLE;
  const move = (event: FinalReportLifecycleEvent): void => {
    lifecycle = advance(lifecycle, event);
    effects.observeTransition?.(event, lifecycle);
  };
  move("begin_core_reporting");
  move("complete_core");
  move("start_report");
  const attempted = await effects.attempt();
  if (attempted.result.ok) {
    move("generation_returns");
    move("validation_succeeds");
    return { ok: true, state: attempted.state, lifecycle, outcome: "report_available" };
  }

  if (isValidationFailure(attempted.result.error)) {
    move("generation_returns");
    move("validation_fails");
  } else {
    move("generation_fails");
  }

  try {
    await effects.cleanup();
    move("cleanup_succeeds");
  } catch (cause: unknown) {
    move("output_fails");
    return outputFailure("final-report cleanup", cause, lifecycle);
  }

  const warnedState = effects.addWarning(attempted.state, attempted.result.error);
  try {
    await effects.invalidateMarker();
    move("marker_invalidation_succeeds");
  } catch (cause: unknown) {
    move("output_fails");
    return outputFailure("final-report marker invalidation", cause, lifecycle);
  }

  let summary: TSummary;
  try {
    summary = await effects.rewriteSummary(warnedState);
    move("summary_rewrite_succeeds");
  } catch (cause: unknown) {
    move("output_fails");
    return outputFailure("final-report summary rewrite", cause, lifecycle);
  }

  move("begin_manifest_refresh");
  try {
    await effects.refreshManifest(summary);
    move("manifest_refresh_succeeds");
  } catch (cause: unknown) {
    move("output_fails");
    return outputFailure("final-report manifest refresh", cause, lifecycle);
  }
  return { ok: true, state: warnedState, lifecycle, outcome: "warning_persisted" };
}

/** Separate adapter/request failures from post-response validation failures. */
function isValidationFailure(error: FinalReportError): boolean {
  return error.kind === "path_mismatch"
    || error.kind === "report_missing"
    || error.kind === "report_symlink"
    || error.kind === "report_not_regular"
    || error.kind === "report_empty"
    || error.kind === "report_structure_invalid"
    || error.kind === "report_too_large"
    || error.kind === "report_unreadable";
}

/** Apply one transition that production has established. */
function advance(
  state: FinalReportLifecycleState,
  event: FinalReportLifecycleEvent,
): FinalReportLifecycleState {
  const next = reduceFinalReportLifecycle(state, event);
  precondition(next.ok, `final-report lifecycle rejects ${event} from ${state.stage}`);
  return next.value;
}

/** Construct one typed fatal output result. */
function outputFailure(
  operation: FinalReportOutputFailure["error"]["operation"],
  cause: unknown,
  lifecycle: FinalReportLifecycleState,
): FinalReportOutputFailure {
  return { ok: false, error: { operation, cause, lifecycle } };
}
