import { expect } from "vitest";

import { getOrCreateTraceRuntimeState, recordTraceDeclaration } from "./spec-trace/runtime.js";

/**
 * Declare which canonical OpenSpec identifiers the current Vitest test verifies.
 *
 * @param identifiers - bare canonical identifiers without brackets
 *
 * @remarks
 * Preconditions: call only from inside a currently executing Vitest test body.
 * Postconditions: accepted identifiers are validated against the full canonical
 * repository catalog and recorded once per test for coverage accounting.
 * Failures: throws when the declaration is empty, malformed, unknown, or not
 * associated with an active Vitest test.
 */
export function traceSpec(...identifiers: string[]): void {
  const testKey = getCurrentTestKey();
  const state = getOrCreateTraceRuntimeState();
  recordTraceDeclaration(state, testKey, identifiers);
}

/**
 * Read the active Vitest test identity from the current expectation state.
 *
 * @returns stable key for the current test invocation
 *
 * @remarks
 * Preconditions: the caller is executing inside an active Vitest test.
 * Failures: throws when Vitest does not expose an active test name.
 */
function getCurrentTestKey(): string {
  const state = expect.getState();
  const currentTestName = typeof state.currentTestName === "string" ? state.currentTestName : undefined;
  if (currentTestName === undefined || currentTestName.length === 0) {
    throw new Error("traceSpec(...) must be called from inside a running Vitest test");
  }

  const stateWithPath = state as typeof state & { readonly testPath?: unknown };
  const testPath = typeof stateWithPath.testPath === "string" ? stateWithPath.testPath : undefined;
  return testPath === undefined ? currentTestName : `${testPath}::${currentTestName}`;
}
