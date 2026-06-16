import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { CanonicalCatalog, CanonicalCatalogEntry } from "./catalog.js";
import {
  createCanonicalCatalog,
  formatCatalogEntry,
  getRepositoryRoot,
  loadCanonicalCatalog,
} from "./catalog.js";
import { TRACE_SPEC_IDENTIFIER_PATTERN } from "./scan.js";

const TRACE_STATE_KEY = Symbol.for("devbox.specTrace.state");

/**
 * Mutable run-scoped state shared by the traceability helper and setup module.
 *
 * @remarks
 * Invariant: `catalog` is the full canonical catalog for the repository for the
 * lifetime of the state object.
 */
export interface TraceRuntimeState {
  readonly catalog: CanonicalCatalog;
  readonly coverageEnabled: boolean;
  readonly seenIdentifiers: Set<string>;
  readonly identifiersByTest: Map<string, Set<string>>;
}

/**
 * Create fresh trace runtime state.
 *
 * @param options - catalog and coverage-mode options
 * @returns isolated state suitable for tests or setup initialization
 */
export function createTraceRuntimeState(options?: {
  readonly catalog?: CanonicalCatalog;
  readonly coverageEnabled?: boolean;
}): TraceRuntimeState {
  return {
    catalog: options?.catalog ?? createCanonicalCatalog([]),
    coverageEnabled: options?.coverageEnabled ?? false,
    seenIdentifiers: new Set<string>(),
    identifiersByTest: new Map<string, Set<string>>(),
  };
}

/**
 * Get or initialize the process-wide trace runtime state.
 *
 * @param options - optional catalog and root overrides used during setup
 * @returns shared trace runtime state
 *
 * @remarks
 * Preconditions: callers that override `catalog` or `coverageEnabled` do so
 * before other modules start tracing tests in the same process.
 */
export function getOrCreateTraceRuntimeState(options?: {
  readonly rootDir?: string;
  readonly catalog?: CanonicalCatalog;
  readonly coverageEnabled?: boolean;
}): TraceRuntimeState {
  const globalState = globalThis as Record<PropertyKey, unknown>;
  const existingState = globalState[TRACE_STATE_KEY];
  if (isTraceRuntimeState(existingState)) {
    return existingState;
  }

  const state = createTraceRuntimeState({
    catalog: options?.catalog ?? loadCanonicalCatalog(options?.rootDir ?? getRepositoryRoot()),
    coverageEnabled: options?.coverageEnabled ?? isTraceCoverageEnabled(),
  });
  globalState[TRACE_STATE_KEY] = state;
  return state;
}

/**
 * Replace the process-wide trace runtime state.
 *
 * @param state - state to install for subsequent trace operations
 *
 * @remarks
 * Preconditions: callers coordinate replacement before concurrent tracing in the
 * same process. Intended for setup and deterministic tests.
 */
export function setTraceRuntimeState(state: TraceRuntimeState): void {
  const globalState = globalThis as Record<PropertyKey, unknown>;
  globalState[TRACE_STATE_KEY] = state;
}

/**
 * Clear the process-wide trace runtime state.
 *
 * @remarks
 * Intended for deterministic tests that need a fresh state object.
 */
export function resetTraceRuntimeState(): void {
  const globalState = globalThis as Record<PropertyKey, unknown>;
  delete globalState[TRACE_STATE_KEY];
}

/**
 * Validate and record one traced declaration for one executing test.
 *
 * @param state - run-scoped trace runtime state
 * @param testKey - stable key for the currently executing test
 * @param identifiers - declared canonical identifiers in bare token form
 *
 * @remarks
 * Preconditions: `testKey` identifies the currently executing test.
 * Postconditions: accepted identifiers are stored once per test and contribute
 * to run-scoped coverage accounting.
 * Failures: throws on empty declarations, malformed identifiers, and unknown
 * identifiers.
 */
export function recordTraceDeclaration(
  state: TraceRuntimeState,
  testKey: string,
  identifiers: readonly string[],
): void {
  if (identifiers.length === 0) {
    throw new Error("traceSpec(...) requires at least one canonical identifier");
  }

  const identifiersForTest = getOrCreateIdentifiersForTest(state, testKey);
  for (const identifier of new Set(identifiers)) {
    if (!TRACE_SPEC_IDENTIFIER_PATTERN.test(identifier)) {
      throw new Error(
        `traceSpec(...) received malformed identifier ${JSON.stringify(identifier)}; expected ${TRACE_SPEC_IDENTIFIER_PATTERN.source}`,
      );
    }

    if (!state.catalog.entriesByIdentifier.has(identifier)) {
      throw new Error(
        `traceSpec(...) received unknown identifier ${JSON.stringify(identifier)}; it was not found in the canonical OpenSpec catalog`,
      );
    }

    identifiersForTest.add(identifier);
    state.seenIdentifiers.add(identifier);
    if (state.coverageEnabled) {
      appendTraceCoverageRecord(identifier);
    }
  }
}

/**
 * Compute uncovered canonical identifiers for a coverage run.
 *
 * @param state - run-scoped trace runtime state
 * @returns uncovered catalog entries in deterministic catalog order
 */
export function computeUncoveredCatalogEntries(
  state: TraceRuntimeState,
): readonly CanonicalCatalogEntry[] {
  const uncovered: CanonicalCatalogEntry[] = [];
  for (const identifier of state.catalog.identifiers) {
    if (state.seenIdentifiers.has(identifier)) {
      continue;
    }

    const entry = state.catalog.entriesByIdentifier.get(identifier);
    if (entry !== undefined) {
      uncovered.push(entry);
    }
  }
  return uncovered;
}

/**
 * Build the end-of-run coverage failure message, if any.
 *
 * @param state - run-scoped trace runtime state
 * @param rootDir - repository root for relative provenance formatting
 * @returns failure message when coverage mode is enabled and identifiers are uncovered
 */
export function finalizeTraceCoverage(
  state: TraceRuntimeState,
  rootDir: string = getRepositoryRoot(),
): string | undefined {
  if (!state.coverageEnabled) {
    return undefined;
  }

  const uncovered = computeUncoveredCatalogEntries(state);
  if (uncovered.length === 0) {
    return undefined;
  }

  const lines = [
    "Spec trace coverage failed. Uncovered canonical identifiers:",
    ...uncovered.map((entry) => `- ${entry.identifier}: ${formatCatalogEntry(entry, rootDir)}`),
  ];
  return lines.join("\n");
}

/**
 * Check whether trace coverage mode is enabled for this process.
 *
 * @returns true when trace coverage should be enforced at run end
 */
export function isTraceCoverageEnabled(): boolean {
  const rawValue = process.env.DEVBOX_TRACE_COVERAGE;
  return rawValue === "1" || rawValue === "true";
}

/**
 * Get or create the unique identifier set for one test.
 *
 * @param state - run-scoped trace runtime state
 * @param testKey - currently executing test key
 * @returns mutable set of identifiers already declared by that test
 */
function getOrCreateIdentifiersForTest(
  state: TraceRuntimeState,
  testKey: string,
): Set<string> {
  const existing = state.identifiersByTest.get(testKey);
  if (existing !== undefined) {
    return existing;
  }

  const created = new Set<string>();
  state.identifiersByTest.set(testKey, created);
  return created;
}

/**
 * Narrow an unknown global value to trace runtime state.
 *
 * @param value - unknown global value
 * @returns true when the value has the required runtime-state shape
 */
function isTraceRuntimeState(value: unknown): value is TraceRuntimeState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TraceRuntimeState>;
  return (
    candidate.catalog !== undefined
    && candidate.seenIdentifiers instanceof Set
    && candidate.identifiersByTest instanceof Map
    && typeof candidate.coverageEnabled === "boolean"
  );
}

/**
 * Reset the shared coverage record file for a new coverage-mode test run.
 *
 * @remarks
 * Intended for the Vitest reporter running in the main process.
 */
export function resetTraceCoverageRecord(): void {
  writeFileSync(getTraceCoverageRecordPath(), "", "utf8");
}

/**
 * Read all identifiers recorded during the current coverage-mode run.
 *
 * @returns de-duplicated set of traced identifiers observed across the run
 */
export function readTraceCoverageRecord(): ReadonlySet<string> {
  try {
    const rawContent = readFileSync(getTraceCoverageRecordPath(), "utf8");
    const identifiers = rawContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return new Set(identifiers);
  } catch {
    return new Set<string>();
  }
}

/**
 * Remove the shared coverage record file.
 *
 * @remarks
 * Best-effort cleanup for the Vitest reporter.
 */
export function removeTraceCoverageRecord(): void {
  rmSync(getTraceCoverageRecordPath(), { force: true });
}

/**
 * Append one accepted identifier to the shared coverage record.
 *
 * @param identifier - accepted canonical identifier
 */
function appendTraceCoverageRecord(identifier: string): void {
  appendFileSync(getTraceCoverageRecordPath(), `${identifier}\n`, "utf8");
}

/**
 * Compute the shared file path used for coverage-mode aggregation.
 *
 * @returns repository-stable temporary file path
 */
function getTraceCoverageRecordPath(): string {
  const rootDir = getRepositoryRoot();
  const digest = createHash("sha256").update(rootDir).digest("hex").slice(0, 16);
  return join(tmpdir(), `devbox-spec-trace-${digest}.log`);
}
