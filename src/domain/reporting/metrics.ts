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
  const buckets = collectMetricBuckets(snapshot);
  const phases = snapshot.phases.map((phase) => ({
    ...phase,
    llm: finishBucket(buckets.phases.get(phase.phase) ?? emptyBucket()),
  }));
  const scopeNames = [...buckets.scopes.keys()].sort();
  const content = `${JSON.stringify({
    schemaVersion: 1,
    capturedAt: snapshot.capturedAt,
    elapsedMs: snapshot.elapsedMs,
    usageComplete: buckets.total.metrics.usageComplete,
    phases,
    analysisScopes: scopeNames.map((scope) => ({
      scope,
      llm: finishBucket(buckets.scopes.get(scope) ?? emptyBucket()),
    })),
    unattributed: finishBucket(buckets.unattributed),
    totals: finishBucket(buckets.total),
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

/** Owned accumulator for one phase/scope/total, deduplicating logical calls. */
interface MetricBucket {
  readonly calls: Set<number>;
  readonly metrics: MutablePhaseLlmMetrics;
}

/** Accumulate all enabled metrics in one stable attempt-order pass.
 * No source arrays are mutated; additions retain the prior floating-point order.
 */
function collectMetricBuckets(snapshot: RunTelemetrySnapshot) {
  const phases = new Map<string, MetricBucket>();
  const scopes = new Map<string, MetricBucket>();
  const known = new Set(snapshot.phases.map((phase) => phase.phase));
  const total = emptyBucket();
  const unattributed = emptyBucket();
  for (const attempt of snapshot.attempts) {
    addAttempt(total, attempt);
    addAttempt(selectBucket(phases, attempt.pipelinePhase), attempt);
    addAttempt(selectBucket(scopes, analysisScope(attempt)), attempt);
    if (!known.has(attempt.pipelinePhase)) addAttempt(unattributed, attempt);
  }
  return { phases, scopes, total, unattributed };
}

/** Create a fresh bucket; no mutable state is shared between groups. */
function emptyBucket(): MetricBucket { return { calls: new Set(), metrics: emptyMetrics() }; }

/** Select or create one invocation-owned aggregation bucket. */
function selectBucket(buckets: Map<string, MetricBucket>, key: string): MetricBucket {
  const existing = buckets.get(key);
  if (existing !== undefined) return existing;
  const created = emptyBucket();
  buckets.set(key, created);
  return created;
}

/** Add one attempt exactly once to this bucket, preserving usage completeness. */
function addAttempt(bucket: MetricBucket, attempt: RunTelemetrySnapshot["attempts"][number]): void {
  bucket.calls.add(attempt.logicalCallId);
  bucket.metrics.attempts += 1;
  bucket.metrics.attemptDurationMs += attempt.durationMs;
  bucket.metrics.usageComplete = bucket.metrics.usageComplete && attempt.usageComplete;
  addUsage(bucket.metrics, attempt.usage);
}

/** Publish an immutable bucket snapshot without exposing accumulator ownership. */
function finishBucket(bucket: MetricBucket): PhaseLlmMetrics {
  return Object.freeze({ ...bucket.metrics, logicalCalls: bucket.calls.size });
}

/** Initialize schema-v1 aggregate fields in their stable serialization order. */
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

/** Add validated usage counters/cost in the original attempt order. */
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
