import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { writeRunMetrics, type PhaseLlmMetrics } from "../../src/domain/reporting/metrics.js";
import type { RunTelemetrySnapshot, OpencodeAttemptTelemetry } from "../../src/adapters/telemetry.js";
import { toOutputDirPath } from "../../src/domain/branded.js";
import { traceSpec } from "../support/spec-trace.js";

/** Independent mathematical reconciliation, using simple reductions per query. */
function reference(attempts: readonly OpencodeAttemptTelemetry[]): PhaseLlmMetrics {
  return {
    logicalCalls: new Set(attempts.map((a) => a.logicalCallId)).size,
    attempts: attempts.length, attemptDurationMs: attempts.reduce((n, a) => n + a.durationMs, 0),
    usageComplete: attempts.every((a) => a.usageComplete),
    events: attempts.reduce((n, a) => n + a.usage.events, 0),
    completeEvents: attempts.reduce((n, a) => n + a.usage.completeEvents, 0),
    inputTokens: attempts.reduce((n, a) => n + a.usage.inputTokens, 0),
    outputTokens: attempts.reduce((n, a) => n + a.usage.outputTokens, 0),
    reasoningTokens: attempts.reduce((n, a) => n + a.usage.reasoningTokens, 0),
    cacheReadTokens: attempts.reduce((n, a) => n + a.usage.cacheReadTokens, 0),
    cacheWriteTokens: attempts.reduce((n, a) => n + a.usage.cacheWriteTokens, 0),
    totalTokens: attempts.reduce((n, a) => n + a.usage.totalTokens, 0),
    cost: attempts.reduce((n, a) => n + a.usage.cost, 0),
  };
}

/** Build bounded retry/scope attribution data, retaining repeated logical IDs. */
function attempt(values: { readonly id: number; readonly phase: string; readonly tokens: number; readonly complete: boolean }): OpencodeAttemptTelemetry {
  return {
    logicalCallId: values.id, attempt: 1, pipelinePhase: values.phase,
    opencodePhase: "formalization", model: "model", variant: null,
    startedAt: "2026-01-01T00:00:00Z", durationMs: values.tokens,
    promptBytes: 1, attachmentCount: 0, exitCode: 0, timedOut: false, outcome: "success", usageComplete: values.complete,
    usage: { events: 1, completeEvents: values.complete ? 1 : 0, inputTokens: values.tokens, outputTokens: 1, reasoningTokens: 2,
      cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: values.tokens + 10, cost: values.tokens / 1000 },
  };
}

it("single-pass metrics reconcile with independent reductions for generated retry histories", async () => {
  traceSpec("RAE-METRICS-RECONCILE", "RAE-OC-METRICS-SNAPSHOT");
  const root = await mkdtemp(join(tmpdir(), "spec-check-metric-properties-"));
  try {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({ id: fc.integer({ min: 0, max: 5 }), phase: fc.constantFrom("formalization", "code-backwards", "unknown"), tokens: fc.integer({ min: 0, max: 10000 }), complete: fc.boolean() }), { maxLength: 30 }), async (values) => {
      const attempts = values.map(attempt);
      const snapshot: RunTelemetrySnapshot = { schemaVersion: 1, capturedAt: "2026-01-01T00:00:00Z", elapsedMs: 1,
        phases: ["formalization", "code-backwards", "formalization"].map((phase) => ({ phase, startedAt: "2026-01-01T00:00:00Z", durationMs: 1, outcome: "completed" })), attempts };
      const before = JSON.stringify(snapshot);
      await writeRunMetrics(toOutputDirPath(root), snapshot);
      const metrics = JSON.parse(await readFile(join(root, "metrics.json"), "utf8")) as {
        readonly totals: PhaseLlmMetrics; readonly unattributed: PhaseLlmMetrics;
        readonly phases: readonly { readonly phase: string; readonly llm: PhaseLlmMetrics }[];
        readonly analysisScopes: readonly { readonly scope: string; readonly llm: PhaseLlmMetrics }[];
      };
      expect(metrics.totals).toEqual(reference(attempts));
      expect(metrics.unattributed).toEqual(reference(attempts.filter((a) => a.pipelinePhase === "unknown")));
      for (const phase of metrics.phases) expect(phase.llm).toEqual(reference(attempts.filter((a) => a.pipelinePhase === phase.phase)));
      const scope = (a: OpencodeAttemptTelemetry): string => a.pipelinePhase === "formalization" ? "formalization.specs_forward" : a.pipelinePhase === "code-backwards" ? "code_backwards.formalization" : "unknown.formalization";
      expect(metrics.analysisScopes.map((s) => s.scope)).toEqual([...new Set(attempts.map(scope))].sort());
      for (const group of metrics.analysisScopes) expect(group.llm).toEqual(reference(attempts.filter((a) => scope(a) === group.scope)));
      expect(JSON.stringify(snapshot)).toBe(before);
    }), { numRuns: 50 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
