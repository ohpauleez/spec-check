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
