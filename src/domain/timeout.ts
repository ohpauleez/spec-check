/**
 * Shared timeout policy constants for all external LLM calls.
 *
 * @remarks
 * These constants define the single source of truth for the universal timeout
 * policy enforced by both CLI config validation and the adapter layer.
 *
 * Invariant: DEFAULT_TIMEOUT_MS is within [TIMEOUT_MIN_MS, TIMEOUT_MAX_MS].
 * Invariant: TIMEOUT_MIN_MS < TIMEOUT_MAX_MS.
 *
 * Consumers: `src/cli/config.ts` (config-level validation), `src/adapters/opencode.ts`
 * (defense-in-depth validation at call time).
 */

/** Default timeout for all external LLM calls (5 minutes). */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Minimum allowed timeout for external LLM calls (30 seconds). */
export const TIMEOUT_MIN_MS = 30_000;

/** Maximum allowed timeout for external LLM calls (15 minutes). */
export const TIMEOUT_MAX_MS = 900_000;
