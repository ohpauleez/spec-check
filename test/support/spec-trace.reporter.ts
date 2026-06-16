import type { Reporter } from "vitest/reporters";

import {
  computeUncoveredCatalogEntries,
  createTraceRuntimeState,
  finalizeTraceCoverage,
  isTraceCoverageEnabled,
  readTraceCoverageRecord,
  removeTraceCoverageRecord,
  resetTraceCoverageRecord,
} from "./spec-trace/runtime.js";
import { loadCanonicalCatalog } from "./spec-trace/catalog.js";

/**
 * Main-process Vitest reporter that enforces spec trace coverage.
 *
 * @remarks
 * The reporter resets a shared coverage record before the suite starts and uses
 * it at the end of the run to compare observed traced identifiers against the
 * canonical OpenSpec catalog.
 */
export default class SpecTraceReporter implements Reporter {
  /**
   * Prepare a fresh shared coverage record for this run.
   */
  onInit(): void {
    if (!isTraceCoverageEnabled()) {
      return;
    }

    resetTraceCoverageRecord();
  }

  /**
   * Fail the run when coverage mode is enabled and canonical identifiers remain uncovered.
   */
  onFinished(): void {
    if (!isTraceCoverageEnabled()) {
      return;
    }

    try {
      const state = createTraceRuntimeState({
        catalog: loadCanonicalCatalog(),
        coverageEnabled: true,
      });
      for (const identifier of readTraceCoverageRecord()) {
        state.seenIdentifiers.add(identifier);
      }

      const uncovered = computeUncoveredCatalogEntries(state);
      if (uncovered.length === 0) {
        return;
      }

      const failureMessage = finalizeTraceCoverage(state);
      throw new Error(failureMessage ?? "Spec trace coverage failed");
    } finally {
      removeTraceCoverageRecord();
    }
  }
}
