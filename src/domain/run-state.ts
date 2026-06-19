/**
 * Tracks pipeline execution state — accumulated findings and completed phases —
 * providing immutable state transitions for the verification pipeline.
 *
 * Domain layer — manages progression through ordered verification phases.
 * Exports: RunState, createInitialRunState, addFindings, markPhaseComplete.
 */
import type { Finding } from "./findings.js";
import { invariant, postcondition } from "./assert.js";

export interface RunState {
  readonly findings: readonly Finding[];
  readonly completedPhases: readonly string[];
}

/**
 * Create a fresh run state with empty findings and no completed phases.
 *
 * @returns A new {@link RunState} with `findings` and `completedPhases` both empty.
 *
 * @remarks
 * Postcondition: `findings.length === 0 && completedPhases.length === 0`.
 *
 * @example
 * ```typescript
 * const state = createInitialRunState();
 * // state.findings === []
 * // state.completedPhases === []
 * ```
 */
export function createInitialRunState(): RunState {
  return {
    findings: [],
    completedPhases: [],
  };
}

/**
 * Append new findings to the run state immutably.
 *
 * @param state - Current run state
 * @param findings - New findings to append
 * @returns New state with all prior findings preserved plus new ones appended
 *
 * @throws Error if the append-only invariant is violated (broken postcondition)
 *
 * @remarks
 * The spread construction structurally guarantees that all prior findings are
 * preserved. The O(1) length assertion validates this postcondition cheaply.
 * A full O(n) membership check runs only in development mode for defense-in-depth.
 *
 * @example
 * ```typescript
 * let state = createInitialRunState();
 * const newFindings: Finding[] = [
 *   { severity: "warning", category: "coherence", provenance: { file: "spec.md" },
 *     description: "Ambiguous requirement", rationale: "...", evidence: [] },
 * ];
 * state = addFindings(state, newFindings);
 * // state.findings.length === 1
 * ```
 */
export function addFindings(state: RunState, findings: readonly Finding[]): RunState {
  const nextFindings = [...state.findings, ...findings];

  // O(1) structural postcondition: spread guarantees preservation.
  postcondition(
    nextFindings.length === state.findings.length + findings.length,
    "findings append-only invariant violated: unexpected length",
  );

  // O(n) defense-in-depth check, only in development.
  if (process.env["NODE_ENV"] === "development") {
    const nextSet = new Set(nextFindings);
    const missingPrior = state.findings.some((priorFinding) => !nextSet.has(priorFinding));
    invariant(!missingPrior, "findings immutability violated; prior finding removed");
  }

  return {
    findings: nextFindings,
    completedPhases: state.completedPhases,
  };
}

/**
 * Mark a pipeline phase as completed by appending it to the run state immutably.
 *
 * @param state - Current run state.
 * @param phase - The name of the phase that completed.
 * @returns New state with `phase` appended to `completedPhases`; `findings` unchanged.
 *
 * @remarks
 * Precondition: `phase` is a non-empty string.
 * Postcondition: `result.completedPhases` ends with `phase`.
 * Postcondition: `result.findings === state.findings` (identity-preserving).
 *
 * @example
 * ```typescript
 * let state = createInitialRunState();
 * state = markPhaseCompleted(state, "structural");
 * state = markPhaseCompleted(state, "qualitative");
 * // state.completedPhases === ["structural", "qualitative"]
 * ```
 */
export function markPhaseCompleted(state: RunState, phase: string): RunState {
  return {
    findings: state.findings,
    completedPhases: [...state.completedPhases, phase],
  };
}
