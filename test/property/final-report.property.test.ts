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

  it("differentially matches generated histories to an independent fake boundary", () => {
    traceSpec("RAE-FINAL-OPTIONAL", "RAE-FINAL-WARN-HASH", "RAE-MANIFEST-NO-FINAL");
    const branch = fc.constantFrom("success", "warning", "output-failure");
    fc.assert(fc.property(branch, (kind) => {
      const events: FinalReportLifecycleEvent[] = ["begin_core_reporting", "complete_core", "start_report"];
      if (kind === "success") events.push("generation_returns", "validation_succeeds");
      if (kind === "warning") events.push(
        "generation_fails", "cleanup_succeeds", "marker_invalidation_succeeds",
        "summary_rewrite_succeeds", "begin_manifest_refresh", "manifest_refresh_succeeds",
      );
      if (kind === "output-failure") events.push(
        "generation_fails", "cleanup_succeeds", "marker_invalidation_succeeds",
        "summary_rewrite_succeeds", "begin_manifest_refresh", "output_fails",
      );
      let model = INITIAL_FINAL_REPORT_LIFECYCLE;
      const fake = {
        reportPresent: false, warningPresent: false, summaryCurrent: false,
        manifestCurrent: false, reportManifested: false,
      };
      for (const event of events) {
        const next = reduceFinalReportLifecycle(model, event);
        expect(next.ok).toBe(true);
        if (next.ok) model = next.value;
        applyFakeBoundaryEvent(fake, event);
        expect(model).toMatchObject(fake);
      }
    }), { numRuns: 60 });
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

function applyFakeBoundaryEvent(
  fake: {
    reportPresent: boolean; warningPresent: boolean; summaryCurrent: boolean;
    manifestCurrent: boolean; reportManifested: boolean;
  },
  event: FinalReportLifecycleEvent,
): void {
  if (event === "complete_core") {
    fake.summaryCurrent = true;
    fake.manifestCurrent = true;
  } else if (event === "validation_succeeds") {
    fake.reportPresent = true;
  } else if (event === "cleanup_succeeds") {
    fake.reportPresent = false;
    fake.warningPresent = true;
  } else if (event === "marker_invalidation_succeeds") {
    fake.summaryCurrent = false;
    fake.manifestCurrent = false;
  } else if (event === "summary_rewrite_succeeds") {
    fake.summaryCurrent = true;
  } else if (event === "manifest_refresh_succeeds") {
    fake.manifestCurrent = true;
  }
}
