import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../src/adapters/fs.js";
import { toOutputDirPath } from "../../src/domain/branded.js";
import { writeRunMetrics } from "../../src/domain/reporting/metrics.js";
import { traceSpec } from "../support/spec-trace.js";

describe("run metrics artifact", () => {
  it("reconciles phase and run totals and returns its checksum", async () => {
    traceSpec("RAE-RUN-METRICS", "RAE-METRICS-RECONCILE", "RAE-METRICS-MANIFEST");
    const output = await mkdtemp(join(tmpdir(), "spec-check-metrics-"));
    const descriptor = await writeRunMetrics(toOutputDirPath(output), {
      schemaVersion: 1,
      capturedAt: "2026-01-01T00:00:00.000Z",
      elapsedMs: 100,
      phases: [{ phase: "qualitative", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 90, outcome: "completed" }],
      attempts: [{
        logicalCallId: 1,
        attempt: 1,
        pipelinePhase: "qualitative",
        opencodePhase: "qualitative-review",
        model: "model",
        variant: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 80,
        promptBytes: 10,
        attachmentCount: 1,
        exitCode: 0,
        timedOut: false,
        outcome: "success",
        usageComplete: true,
        usage: { events: 1, completeEvents: 1, inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 19, cost: 0.2 },
      }],
    });
    const content = await readFile(join(output, "metrics.json"), "utf8");
    const metrics = JSON.parse(content) as {
      readonly totals: { readonly totalTokens: number; readonly logicalCalls: number };
      readonly phases: readonly { readonly llm: { readonly totalTokens: number } }[];
      readonly analysisScopes: readonly { readonly scope: string; readonly llm: { readonly totalTokens: number } }[];
    };

    expect(descriptor).toEqual({ path: "metrics.json", checksum: sha256Hex(content), phase: "metrics" });
    expect(metrics.totals).toMatchObject({ totalTokens: 19, logicalCalls: 1 });
    expect(metrics.phases[0]?.llm.totalTokens).toBe(19);
    expect(metrics.analysisScopes).toEqual([{ scope: "qualitative.review", llm: expect.objectContaining({ totalTokens: 19 }) }]);
  });
});
