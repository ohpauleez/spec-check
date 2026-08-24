/**
 * Generic phase execution infrastructure that wraps async pipeline work with
 * progress event emission and run-state bookkeeping.
 *
 * Used by the pipeline orchestrator to uniformly execute and track each phase.
 * Exports: `executePhase`.
 */
import type { RunState } from "../domain/run-state.js";
import { markPhaseCompleted } from "../domain/run-state.js";
import { createProgressEvent, emitProgressEvent } from "../domain/progress.js";
import { PipelineAbortError } from "./pipeline-types.js";
import { recordPipelinePhase, runWithTelemetryPhase } from "../adapters/telemetry.js";

// ---------------------------------------------------------------------------
// Phase execution infrastructure — progress events and state tracking
// ---------------------------------------------------------------------------

/**
 * Execute a pipeline phase, emitting progress events and recording completion.
 *
 * @param name - phase name for progress events and state tracking
 * @param state - current run state before this phase
 * @param operation - async phase work to execute
 * @returns updated run state with the phase marked as completed
 *
 * @throws {PipelineAbortError} if the operation throws a PipelineAbortError (re-thrown as-is)
 * @throws {PipelineAbortError} wrapping non-Error throws as `"PipelineError"` category
 * @throws {Error} if the operation throws any other Error subclass (re-thrown as-is)
 *
 * @remarks
 * Precondition: `name` is a unique phase identifier not already in `state.completedPhases`.
 * Postcondition: exactly one "started" and one "completed" or "failed" progress event is emitted.
 * Invariant: on failure, the "failed" event is emitted before the error propagates.
 *
 * Failure modes:
 * - Any error thrown by `operation` is caught, a "failed" event is emitted, then
 *   the error is re-thrown (or wrapped in PipelineAbortError for non-Error values).
 *
 * Safety: emits progress events via the global event system. Not safe to call
 * concurrently for phases with the same `name`.
 */
export async function runPhase(name: string, state: RunState, operation: () => Promise<void>): Promise<RunState> {
  const timestamp = new Date().toISOString();
  const startedAt = process.hrtime.bigint();
  emitProgressEvent(createProgressEvent(name, "started", undefined, timestamp));
  try {
    await runWithTelemetryPhase(name, operation);
    const nextState = markPhaseCompleted(state, name);
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    recordPipelinePhase(name, timestamp, durationMs, "completed");
    emitProgressEvent(createProgressEvent(name, "completed", durationMs));
    return nextState;
  } catch (error: unknown) {
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    recordPipelinePhase(name, timestamp, durationMs, "failed");
    emitProgressEvent(createProgressEvent(name, "failed", durationMs));
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
 * @param state - current run state before this phase
 * @param operation - async phase work that produces a value of type `T`
 * @returns object containing the phase result value and updated run state
 *
 * @throws {PipelineAbortError} if the operation throws a PipelineAbortError (re-thrown as-is)
 * @throws {PipelineAbortError} wrapping non-Error throws as `"PipelineError"` category
 * @throws {Error} if the operation throws any other Error subclass (re-thrown as-is)
 *
 * @remarks
 * Precondition: `name` is a unique phase identifier not already in `state.completedPhases`.
 * Postcondition: the returned `value` is the successful result of `operation`.
 * Postcondition: the returned `state` includes `name` in its completed phases list.
 * Invariant: exactly one "started" and one "completed" or "failed" progress event is emitted.
 *
 * Failure modes:
 * - Any error thrown by `operation` is caught, a "failed" event is emitted, then
 *   the error is re-thrown (or wrapped in PipelineAbortError for non-Error values).
 *
 * Safety: emits progress events via the global event system. Not safe to call
 * concurrently for phases with the same `name`.
 */
export async function runPhaseWithResult<T>(
  name: string,
  state: RunState,
  operation: () => Promise<T>,
): Promise<{ readonly state: RunState; readonly value: T }> {
  const timestamp = new Date().toISOString();
  const startedAt = process.hrtime.bigint();
  emitProgressEvent(createProgressEvent(name, "started", undefined, timestamp));
  try {
    const value = await runWithTelemetryPhase(name, operation);
    const nextState = markPhaseCompleted(state, name);
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    recordPipelinePhase(name, timestamp, durationMs, "completed");
    emitProgressEvent(createProgressEvent(name, "completed", durationMs));
    return { state: nextState, value };
  } catch (error: unknown) {
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    recordPipelinePhase(name, timestamp, durationMs, "failed");
    emitProgressEvent(createProgressEvent(name, "failed", durationMs));
    if (error instanceof Error) {
      throw error;
    }
    throw new PipelineAbortError("PipelineError", `phase failed: ${name}`);
  }
}

/**
 * Execute an optional phase whose expected failure is returned as data.
 *
 * @param name - phase name for progress and telemetry
 * @param state - immutable run state before the attempt
 * @param operation - bounded operation returning a value
 * @param succeeded - pure classifier for whether the value is a successful outcome
 * @returns the value and state; the phase is marked complete only on success
 *
 * @throws {Error} for exceptional thrown failures after recording a failed phase
 *
 * @remarks
 * Expected failure emits a failed terminal observation but does not throw. This
 * lets the orchestrator persist degradation evidence without converting the
 * already-complete core run into a fatal pipeline result.
 */
export async function runOptionalPhaseWithResult<T>(
  name: string,
  state: RunState,
  operation: () => Promise<T>,
  succeeded: (value: T) => boolean,
): Promise<{ readonly state: RunState; readonly value: T }> {
  const timestamp = new Date().toISOString();
  const startedAt = process.hrtime.bigint();
  emitProgressEvent(createProgressEvent(name, "started", undefined, timestamp));
  try {
    const value = await runWithTelemetryPhase(name, operation);
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    const success = succeeded(value);
    recordPipelinePhase(name, timestamp, durationMs, success ? "completed" : "failed");
    emitProgressEvent(createProgressEvent(name, success ? "completed" : "failed", durationMs));
    return { state: success ? markPhaseCompleted(state, name) : state, value };
  } catch (error: unknown) {
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    recordPipelinePhase(name, timestamp, durationMs, "failed");
    emitProgressEvent(createProgressEvent(name, "failed", durationMs));
    if (error instanceof Error) {
      throw error;
    }
    throw new PipelineAbortError("PipelineError", `phase failed: ${name}`);
  }
}
