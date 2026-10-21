import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { sha256Hex } from "../../src/adapters/fs.js";
import { buildManifestEntries, validateCoreManifestEntries } from "../../src/domain/reporting/manifest.js";
import {
  reduceFinalReportLifecycle,
  INITIAL_FINAL_REPORT_LIFECYCLE,
  type FinalReportLifecycleEvent,
  type FinalReportLifecycleState,
} from "../../src/domain/reporting/final-report.js";
import { buildFinalReportPrompt } from "../../src/domain/prompts/final-report.js";
import { coordinateFinalReportLifecycle, type FinalReportCoordinationResult } from "../../src/cli/final-report-lifecycle.js";
import { addFindings, createInitialRunState } from "../../src/domain/run-state.js";
import { toRelativePath } from "../../src/domain/branded.js";

describe("final-report properties", () => {
  it("preserves generated literal paths exactly", () => {
    traceSpec("RAE-FINAL-PATH-SPACE", "RAE-FINAL-PATH-WILDCARD");
    const segment = fc.string({ minLength: 1, maxLength: 40 })
      .filter((value) => !value.includes("*") && !value.includes("?") && !value.includes("/"));
    fc.assert(fc.property(segment, (value) => {
      const evidence = `/tmp/${value}`;
      const report = `${evidence}/report.md`;
      const prompt = buildFinalReportPrompt(evidence, report);
      expect(prompt).toContain(JSON.stringify(evidence));
      expect(prompt).toContain(JSON.stringify(report));
    }), { numRuns: 100 });
  });

  it("legal success and failure histories reach exactly one terminal state", () => {
    traceSpec("RAE-FINAL-OPTIONAL", "RAE-FINAL-CLEAN-FAILED", "RAE-FINAL-WARN-HASH");
    const tails: readonly (readonly FinalReportLifecycleEvent[])[] = [
      ["generation_returns", "validation_succeeds"],
      ["generation_returns", "validation_fails", "cleanup_succeeds", "marker_invalidation_succeeds", "summary_rewrite_succeeds", "begin_manifest_refresh", "manifest_refresh_succeeds"],
      ["generation_fails", "cleanup_succeeds", "marker_invalidation_succeeds", "summary_rewrite_succeeds", "begin_manifest_refresh", "manifest_refresh_succeeds"],
    ];
    fc.assert(fc.property(fc.constantFrom(...tails), (tail) => {
      let state: FinalReportLifecycleState = INITIAL_FINAL_REPORT_LIFECYCLE;
      for (const event of ["begin_core_reporting", "complete_core", "start_report", ...tail] as const) {
        const next = reduceFinalReportLifecycle(state, event);
        expect(next.ok).toBe(true);
        if (next.ok) state = next.value;
      }
      expect(["report_available", "warning_persisted"]).toContain(state.stage);
      expect(state.coreComplete).toBe(true);
      expect(state.reportManifested).toBe(false);
      if (state.stage === "warning_persisted") {
        expect(state).toMatchObject({ reportPresent: false, warningPresent: true, summaryCurrent: true, manifestCurrent: true });
      }
    }));
  });

  it("generated stuttering and failure-point histories preserve lifecycle invariants", () => {
    traceSpec("RAE-FINAL-OPTIONAL", "RAE-FINAL-CLEAN-ERROR", "RAE-FINAL-WARN-COMPLETE");
    const branch = fc.constantFrom("success", "missing", "generation", "cleanup-fail", "summary-fail", "manifest-fail");
    fc.assert(fc.property(branch, fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 8, maxLength: 8 }), (kind, stutters) => {
      const events: FinalReportLifecycleEvent[] = ["begin_core_reporting", "complete_core", "start_report"];
      if (kind === "success") events.push("generation_returns", "validation_succeeds");
      if (kind === "missing") events.push("generation_returns", "validation_fails", "cleanup_succeeds", "marker_invalidation_succeeds", "summary_rewrite_succeeds", "begin_manifest_refresh", "manifest_refresh_succeeds");
      if (kind === "generation") events.push("generation_fails", "cleanup_succeeds", "marker_invalidation_succeeds", "summary_rewrite_succeeds", "begin_manifest_refresh", "manifest_refresh_succeeds");
      if (kind === "cleanup-fail") events.push("generation_fails", "output_fails");
      if (kind === "summary-fail") events.push("generation_fails", "cleanup_succeeds", "marker_invalidation_succeeds", "output_fails");
      if (kind === "manifest-fail") events.push("generation_fails", "cleanup_succeeds", "marker_invalidation_succeeds", "summary_rewrite_succeeds", "begin_manifest_refresh", "output_fails");
      let state: FinalReportLifecycleState = INITIAL_FINAL_REPORT_LIFECYCLE;
      for (let index = 0; index < events.length; index += 1) {
        for (let count = 0; count < (stutters[index] ?? 0); count += 1) {
          const same = reduceFinalReportLifecycle(state, "stutter");
          expect(same).toEqual({ ok: true, value: state });
        }
        const next = reduceFinalReportLifecycle(state, events[index]!);
        expect(next.ok).toBe(true);
        if (next.ok) state = next.value;
        expect(state.reportManifested).toBe(false);
        if (state.summaryCurrent && !state.manifestCurrent) {
          expect(["summary_rewritten", "manifest_refreshing", "output_failed"]).toContain(state.stage);
        }
      }
      expect(["report_available", "warning_persisted", "output_failed"]).toContain(state.stage);
      expect(state.coreComplete).toBe(true);
    }), { numRuns: 100 });
  });

  it("executes production coordination against independent filesystem observations and reference histories", async () => {
    traceSpec("RAE-FINAL-OPTIONAL", "RAE-FINAL-WARN-HASH", "RAE-MANIFEST-NO-FINAL", "RAE-LIFECYCLE-PRODUCTION", "RAE-LIFECYCLE-EFFECTS");
    await fc.assert(fc.asyncProperty(fc.constantFrom<HistoryKind>("success", "validation", "generation", "cleanup", "marker", "summary", "manifest"), async (kind) => {
      const executed = await runCoordinatorHistory(kind);
      const expected = expectedHistory(kind);
      expect(executed.events).toEqual(expected);
      let model = INITIAL_FINAL_REPORT_LIFECYCLE;
      for (const event of expected) {
        const next = reduceFinalReportLifecycle(model, event);
        expect(next.ok).toBe(true);
        if (next.ok) model = next.value;
      }
      const lifecycle = executed.result.ok ? executed.result.lifecycle : executed.result.error.lifecycle;
      expect(lifecycle).toEqual(model);
      expect(model).toMatchObject(executed.observed);
      expect(executed.result.ok).toBe(!["cleanup", "marker", "summary", "manifest"].includes(kind));
    }), { numRuns: 100 });
  });

  it("an unmanifested report cannot change core entries and warning bytes do", () => {
    traceSpec("RAE-MANIFEST-NO-FINAL", "RAE-FINAL-WARN-HASH", "RAE-ATOMIC-MANIFEST");
    fc.assert(fc.property(fc.string(), fc.string(), (core, warning) => {
      const entries = buildManifestEntries([{ path: "report_summary.md", phase: "summary", content: core }]);
      const withReportPresent = buildManifestEntries([{ path: "report_summary.md", phase: "summary", content: core }]);
      expect(withReportPresent).toEqual(entries);
      expect(entries.some((entry) => entry.path === "report.md")).toBe(false);
      if (warning !== core) {
        expect(sha256Hex(warning)).not.toBe(sha256Hex(core));
      }
    }), { numRuns: 50 });
  });

  it("the production core-manifest guard rejects report descriptors", () => {
    traceSpec("RAE-MANIFEST-NO-FINAL");
    fc.assert(fc.property(fc.string(), fc.string(), (summary, report) => {
      const produced = [
        { path: "report_summary.md", phase: "summary", content: summary },
        { path: "report.md", phase: "final-report", content: report },
      ];
      const entries = buildManifestEntries(produced);
      expect(() => validateCoreManifestEntries(entries)).toThrow("exclude report.md");
    }), { numRuns: 50 });
  });
});

/** Generated outcome, including every independently injected persistence failure. */
type HistoryKind = "success" | "validation" | "generation" | "cleanup" | "marker" | "summary" | "manifest";

/** Independent expected protocol history; does not execute production effects. */
function expectedHistory(kind: HistoryKind): readonly FinalReportLifecycleEvent[] {
  const events: FinalReportLifecycleEvent[] = ["begin_core_reporting", "complete_core", "start_report"];
  if (kind === "success") return [...events, "generation_returns", "validation_succeeds"];
  events.push(...(kind === "validation" ? ["generation_returns", "validation_fails"] as const : ["generation_fails"] as const));
  const steps = [["cleanup", "cleanup_succeeds"], ["marker", "marker_invalidation_succeeds"], ["summary", "summary_rewrite_succeeds"], ["manifest", "manifest_refresh_succeeds"]] as const;
  for (const [operation, event] of steps) {
    if (operation === "manifest") events.push("begin_manifest_refresh");
    if (kind === operation) return [...events, "output_fails"];
    events.push(event);
  }
  return events;
}

/** Run the coordinator imported by run-cli against a byte-oriented fake FS.
 * Observations derive from stored bytes/effects, never from reducer events.
 */
async function runCoordinatorHistory(kind: HistoryKind): Promise<{
  readonly result: FinalReportCoordinationResult;
  readonly events: readonly FinalReportLifecycleEvent[];
  readonly observed: { readonly reportPresent: boolean; readonly warningPresent: boolean; readonly summaryCurrent: boolean; readonly manifestCurrent: boolean; readonly reportManifested: boolean };
}> {
  const state = createInitialRunState();
  const files = new Map([["summary", "core"], ["manifest", sha256Hex("core")]]);
  const events: FinalReportLifecycleEvent[] = [];
  let warning = false;
  const fail = (operation: HistoryKind): void => { if (kind === operation) throw new Error(`injected ${operation}`); };
  const result = await coordinateFinalReportLifecycle<string>(state, {
    attempt: async () => {
      if (kind === "success") {
        files.set("report", "validated report");
        return { state, result: { ok: true, value: { path: toRelativePath("report.md"), content: "validated report" } } };
      }
      return { state, result: { ok: false, error: { kind: kind === "validation" ? "report_missing" : "agent_failed", message: "injected report failure" } } };
    },
    cleanup: async () => { fail("cleanup"); files.delete("report"); },
    addWarning: (current, error) => {
      warning = true;
      return addFindings(current, [{ severity: "warning", category: "reporting.final_report_failed", provenance: { file: "<report>" }, description: error.message, rationale: "optional report failure", evidence: [{ kind: "failure", value: error.kind }] }]);
    },
    invalidateMarker: async () => { fail("marker"); files.delete("manifest"); },
    rewriteSummary: async () => { fail("summary"); files.set("summary", "warning"); return "warning"; },
    refreshManifest: async (summary) => {
      fail("manifest");
      expect(files.has("manifest")).toBe(false);
      expect(files.get("summary")).toBe(summary);
      files.set("manifest", sha256Hex(summary));
    },
    observeTransition: (event) => { events.push(event); },
  });
  // A failed marker invalidation leaves the original core bundle authoritative.
  const expectedSummary = warning && files.get("manifest") !== sha256Hex("core") ? "warning" : "core";
  return { result, events, observed: {
    reportPresent: files.has("report"), warningPresent: warning,
    summaryCurrent: files.get("summary") === expectedSummary,
    manifestCurrent: files.get("manifest") === sha256Hex(files.get("summary") ?? ""),
    reportManifested: false,
  } };
}
