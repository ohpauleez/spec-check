/**
 * Run-scoped telemetry for external OpenCode invocations.
 *
 * AsyncLocalStorage preserves pipeline-phase attribution across concurrent
 * workers without changing domain function signatures.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { OpencodeError, OpencodePhase, OpencodeUsage } from "./opencode.js";

/** One actual OpenCode subprocess attempt, including retries. */
export interface OpencodeAttemptTelemetry {
  readonly logicalCallId: number;
  readonly attempt: number;
  readonly pipelinePhase: string;
  readonly opencodePhase: OpencodePhase;
  readonly model: string;
  readonly variant: string | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly promptBytes: number;
  readonly attachmentCount: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outcome: "success" | OpencodeError["kind"];
  readonly usageComplete: boolean;
  readonly usage: OpencodeUsage;
}

/** One named pipeline phase terminal observation. */
export interface PipelinePhaseTelemetry {
  readonly phase: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: "completed" | "failed";
}

/** Immutable snapshot of one enabled spec-check run. */
export interface RunTelemetrySnapshot {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly elapsedMs: number;
  readonly phases: readonly PipelinePhaseTelemetry[];
  readonly attempts: readonly OpencodeAttemptTelemetry[];
}

interface TelemetryCollector {
  readonly startedNs: bigint;
  nextCallId: number;
  readonly phases: PipelinePhaseTelemetry[];
  readonly attempts: OpencodeAttemptTelemetry[];
}

interface TelemetryContext {
  readonly collector: TelemetryCollector;
  readonly pipelinePhase: string;
}

const telemetryContext = new AsyncLocalStorage<TelemetryContext>();

/** Whether durable telemetry was explicitly requested for this process. */
export function isTelemetryEnabled(): boolean {
  return process.env.SPEC_CHECK_TELEMETRY === "1";
}

/** Create an empty collector for one pipeline run. */
export function createTelemetryCollector(): TelemetryCollector {
  return { startedNs: process.hrtime.bigint(), nextCallId: 1, phases: [], attempts: [] };
}

/** Record one named phase completion or failure. */
export function recordPipelinePhase(
  phase: string,
  startedAt: string,
  durationMs: number,
  outcome: PipelinePhaseTelemetry["outcome"],
): void {
  const current = telemetryContext.getStore();
  if (current === undefined) {
    return;
  }
  current.collector.phases.push(Object.freeze({ phase, startedAt, durationMs, outcome }));
}

/** Bind a collector to all asynchronous work started by one pipeline run. */
export async function runWithTelemetryCollector<T>(
  collector: TelemetryCollector,
  operation: () => Promise<T>,
): Promise<T> {
  return await telemetryContext.run({ collector, pipelinePhase: "pipeline" }, operation);
}

/** Bind the currently executing named pipeline phase. */
export async function runWithTelemetryPhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const current = telemetryContext.getStore();
  if (current === undefined) {
    return await operation();
  }
  return await telemetryContext.run({ collector: current.collector, pipelinePhase: phase }, operation);
}

/** Allocate a stable logical call ID inside the current run. */
export function allocateOpencodeCallId(): number | undefined {
  const current = telemetryContext.getStore();
  if (current === undefined) {
    return undefined;
  }
  const id = current.collector.nextCallId;
  current.collector.nextCallId += 1;
  return id;
}

/** Record one completed subprocess attempt. Telemetry must never affect analysis. */
export function recordOpencodeAttempt(attempt: Omit<OpencodeAttemptTelemetry, "pipelinePhase">): void {
  const current = telemetryContext.getStore();
  if (current === undefined) {
    return;
  }
  current.collector.attempts.push(Object.freeze({
    ...attempt,
    pipelinePhase: current.pipelinePhase,
    usage: Object.freeze({ ...attempt.usage }),
  }));
}

/** Snapshot the collector bound to the current asynchronous context. */
export function snapshotCurrentTelemetry(): RunTelemetrySnapshot | undefined {
  const current = telemetryContext.getStore();
  if (current === undefined) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    elapsedMs: Number((process.hrtime.bigint() - current.collector.startedNs) / 1_000_000n),
    phases: Object.freeze(current.collector.phases.map((phase) => Object.freeze({ ...phase }))),
    attempts: Object.freeze(
      [...current.collector.attempts]
        .sort((left, right) => left.logicalCallId - right.logicalCallId || left.attempt - right.attempt)
        .map((attempt) => Object.freeze({ ...attempt, usage: Object.freeze({ ...attempt.usage }) })),
    ),
  });
}
