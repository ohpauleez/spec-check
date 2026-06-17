/**
 * Closed domain of lifecycle statuses for a pipeline phase.
 *
 * @remarks
 * - `"started"` — phase execution has begun.
 * - `"completed"` — phase finished successfully.
 * - `"failed"` — phase terminated due to an error.
 * - `"skipped"` — phase was not executed (e.g., missing input).
 */
export type PhaseStatus = "started" | "completed" | "failed" | "skipped";

/**
 * A structured event representing a phase lifecycle transition.
 *
 * @remarks
 * Invariant: `phase` is a non-empty string identifying the pipeline phase.
 * Invariant: `timestamp` is a valid ISO 8601 UTC string.
 * `duration_ms` is present only for terminal statuses (`"completed"` or `"failed"`).
 */
export interface ProgressEvent {
  readonly phase: string;
  readonly status: PhaseStatus;
  readonly timestamp: string;
  readonly duration_ms?: number;
}

/**
 * Emit one progress event as a single JSON line on stdout.
 *
 * @param event - event payload
 *
 * @remarks
 * Precondition: `event` is a fully-formed progress event.
 * Postcondition: exactly one newline-terminated JSON line is written to stdout.
 */
export function emitProgressEvent(event: ProgressEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Build a progress event with a caller-supplied or default UTC ISO timestamp.
 *
 * @param phase - pipeline phase name
 * @param status - phase status
 * @param durationMs - optional phase duration in milliseconds
 * @param timestamp - optional ISO timestamp; defaults to current time when omitted
 * @returns progress event payload
 *
 * @remarks
 * Precondition: `phase` is a non-empty phase name string.
 * Postcondition: returned event has a valid ISO timestamp.
 * The `timestamp` parameter allows the edge/adapter layer to inject time,
 * keeping the domain core free of direct nondeterminism when desired.
 */
export function createProgressEvent(
  phase: string,
  status: PhaseStatus,
  durationMs?: number,
  timestamp?: string,
): ProgressEvent {
  return {
    phase,
    status,
    timestamp: timestamp ?? new Date().toISOString(),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
  };
}
