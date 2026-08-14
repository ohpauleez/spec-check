import { describe, expect, it } from "vitest";

import {
  allocateOpencodeCallId,
  createTelemetryCollector,
  recordOpencodeAttempt,
  recordPipelinePhase,
  runWithTelemetryCollector,
  runWithTelemetryPhase,
  snapshotCurrentTelemetry,
} from "../../src/adapters/telemetry.js";

describe("run telemetry", () => {
  it("keeps concurrent phase attribution isolated and sorts logical calls", async () => {
    const collector = createTelemetryCollector();
    const snapshot = await runWithTelemetryCollector(collector, async () => {
      await Promise.all([
        runWithTelemetryPhase("qualitative", async () => recordSample("qualitative-review")),
        runWithTelemetryPhase("formalization", async () => recordSample("formalization")),
      ]);
      recordPipelinePhase("qualitative", "2026-01-01T00:00:00.000Z", 10, "completed");
      recordPipelinePhase("formalization", "2026-01-01T00:00:00.000Z", 20, "completed");
      return snapshotCurrentTelemetry();
    });

    expect(snapshot?.attempts.map((attempt) => attempt.pipelinePhase).sort()).toEqual(["formalization", "qualitative"]);
    expect(snapshot?.attempts.map((attempt) => attempt.logicalCallId)).toEqual([1, 2]);
    expect(snapshot?.phases.map((phase) => phase.phase)).toEqual(["qualitative", "formalization"]);
  });

  it("does not leak records between concurrent collectors", async () => {
    const left = createTelemetryCollector();
    const right = createTelemetryCollector();
    const [leftSnapshot, rightSnapshot] = await Promise.all([
      runWithTelemetryCollector(left, async () => {
        await runWithTelemetryPhase("left", async () => recordSample("formalization"));
        return snapshotCurrentTelemetry();
      }),
      runWithTelemetryCollector(right, async () => {
        await runWithTelemetryPhase("right", async () => recordSample("blind-comparison"));
        return snapshotCurrentTelemetry();
      }),
    ]);

    expect(leftSnapshot?.attempts.map((attempt) => attempt.pipelinePhase)).toEqual(["left"]);
    expect(rightSnapshot?.attempts.map((attempt) => attempt.pipelinePhase)).toEqual(["right"]);
  });
});

function recordSample(opencodePhase: "qualitative-review" | "formalization" | "blind-comparison"): void {
  const logicalCallId = allocateOpencodeCallId();
  expect(logicalCallId).toBeDefined();
  if (logicalCallId === undefined) return;
  recordOpencodeAttempt({
    logicalCallId,
    attempt: 1,
    opencodePhase,
    model: "test-model",
    variant: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    promptBytes: 4,
    attachmentCount: 0,
    exitCode: 0,
    timedOut: false,
    outcome: "success",
    usageComplete: true,
    usage: {
      events: 1,
      completeEvents: 1,
      inputTokens: 2,
      outputTokens: 3,
      reasoningTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 6,
      cost: 0.01,
    },
  });
}
