/** Durable phase, token, cost, and timing metrics for one successful run. */
import { sha256Hex, writeOutputAtomic } from "../../adapters/fs.js";
import type { OpencodeUsage } from "../../adapters/opencode.js";
import type { RunTelemetrySnapshot } from "../../adapters/telemetry.js";
import { toRelativePath, type OutputDirPath, type RelativePath } from "../branded.js";

/** Aggregated LLM work attributed to one named pipeline phase. */
export interface PhaseLlmMetrics extends OpencodeUsage {
  readonly logicalCalls: number;
  readonly attempts: number;
  readonly attemptDurationMs: number;
  readonly usageComplete: boolean;
}

/** Manifest descriptor for the metrics artifact. */
export interface MetricsFile {
  readonly path: RelativePath;
  readonly checksum: string;
  readonly phase: "metrics";
}

/** Serialize and write `metrics.json` atomically. */
export async function writeRunMetrics(
  outputDir: OutputDirPath,
  snapshot: RunTelemetrySnapshot,
): Promise<MetricsFile> {
  const phases = snapshot.phases.map((phase) => ({
    ...phase,
    llm: aggregateAttempts(snapshot, phase.phase),
  }));
  const knownPhaseNames = new Set(snapshot.phases.map((phase) => phase.phase));
  const unattributed = snapshot.attempts.filter((attempt) => !knownPhaseNames.has(attempt.pipelinePhase));
  const scopeNames = [...new Set(snapshot.attempts.map(analysisScope))].sort();
  const content = `${JSON.stringify({
    schemaVersion: 1,
    capturedAt: snapshot.capturedAt,
    elapsedMs: snapshot.elapsedMs,
    usageComplete: snapshot.attempts.every((attempt) => attempt.usageComplete),
    phases,
    analysisScopes: scopeNames.map((scope) => ({
      scope,
      llm: aggregateAttemptList(snapshot.attempts.filter((attempt) => analysisScope(attempt) === scope)),
    })),
    unattributed: aggregateAttemptList(unattributed),
    totals: aggregateAttemptList(snapshot.attempts),
    attempts: snapshot.attempts,
  }, null, 2)}\n`;
  const path = toRelativePath("metrics.json");
  await writeOutputAtomic(outputDir, path, content);
  return Object.freeze({ path, checksum: sha256Hex(content), phase: "metrics" });
}

function analysisScope(attempt: RunTelemetrySnapshot["attempts"][number]): string {
  if (attempt.pipelinePhase === "qualitative" && attempt.opencodePhase === "qualitative-review") {
    return "qualitative.review";
  }
  if (attempt.pipelinePhase === "qualitative" && attempt.opencodePhase === "qualitative-properties") {
    return "qualitative.properties";
  }
  if (attempt.pipelinePhase === "formalization" && attempt.opencodePhase === "formalization") {
    return "formalization.specs_forward";
  }
  if (attempt.pipelinePhase === "code-backwards" && attempt.opencodePhase === "code-derived-generation") {
    return "code_backwards.generation";
  }
  if (attempt.pipelinePhase === "code-backwards" && attempt.opencodePhase === "formalization") {
    return "code_backwards.formalization";
  }
  if (attempt.pipelinePhase === "code-backwards" && attempt.opencodePhase === "blind-comparison") {
    return "code_backwards.blind_comparison";
  }
  return `${attempt.pipelinePhase}.${attempt.opencodePhase}`;
}

function aggregateAttempts(snapshot: RunTelemetrySnapshot, phase: string): PhaseLlmMetrics {
  return aggregateAttemptList(snapshot.attempts.filter((attempt) => attempt.pipelinePhase === phase));
}

function aggregateAttemptList(attempts: RunTelemetrySnapshot["attempts"]): PhaseLlmMetrics {
  const calls = new Set<number>();
  const totals = emptyMetrics();
  for (const attempt of attempts) {
    calls.add(attempt.logicalCallId);
    totals.attempts += 1;
    totals.attemptDurationMs += attempt.durationMs;
    totals.usageComplete = totals.usageComplete && attempt.usageComplete;
    addUsage(totals, attempt.usage);
  }
  totals.logicalCalls = calls.size;
  return Object.freeze(totals);
}

function emptyMetrics(): MutablePhaseLlmMetrics {
  return {
    logicalCalls: 0,
    attempts: 0,
    attemptDurationMs: 0,
    usageComplete: true,
    events: 0,
    completeEvents: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
}

type MutablePhaseLlmMetrics = {
  -readonly [Key in keyof PhaseLlmMetrics]: PhaseLlmMetrics[Key];
};

function addUsage(target: MutablePhaseLlmMetrics, usage: OpencodeUsage): void {
  for (const key of usageKeys) {
    target[key] += usage[key];
  }
}

const usageKeys = [
  "events",
  "completeEvents",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "cost",
] as const satisfies readonly (keyof OpencodeUsage)[];
