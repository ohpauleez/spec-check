/** Immutable analysis controls and opaque explicitly authored per-side models. */
import { err, ok, type Result } from "../result.js";

/** Resource bounds apply independently of physical batches and model retry counts. */
export interface AnalysisLimits {
  readonly statementBytes: number;
  readonly discoveryContextBytes: number;
  readonly discoveryChunkBytes: number;
  readonly discoveryChunks: number;
  readonly concepts: number;
  readonly expressionBytes: number;
  readonly expressionNodes: number;
  readonly expressionDepth: number;
  readonly queryBytes: number;
  readonly queryScripts: number;
  readonly solverConcurrency: number;
  readonly decodedBytes: number;
  readonly evidenceBytes: number;
}

/** Separate explicit original/generated contexts preserve the blind discovery boundary. */
export interface AnalysisConfig {
  readonly earsExtensions: readonly "where"[];
  readonly models: Readonly<Record<string, unknown>>;
  readonly generatedModels: Readonly<Record<string, unknown>>;
  readonly limits: AnalysisLimits;
}

/** Named bounded defaults from the change's static analysis contract. */
export const ANALYSIS_LIMITS: AnalysisLimits = Object.freeze({
  statementBytes: 65_536, discoveryContextBytes: 1_048_576, discoveryChunkBytes: 262_144,
  discoveryChunks: 32, concepts: 2_048, expressionBytes: 65_536, expressionNodes: 8_192,
  expressionDepth: 128, queryBytes: 4_194_304, queryScripts: 1_000, solverConcurrency: 16,
  decodedBytes: 1_048_576, evidenceBytes: 268_435_456,
});

/** Empty explicit contexts do not authorize inferred background facts. */
export const DEFAULT_ANALYSIS: AnalysisConfig = Object.freeze({
  earsExtensions: Object.freeze([]), models: Object.freeze({}), generatedModels: Object.freeze({}), limits: ANALYSIS_LIMITS,
});

/** Validate only the global control shape; group-model semantic issues remain localized. */
export function resolveAnalysisConfig(value: unknown): Result<AnalysisConfig, string> {
  if (value === undefined) return ok(DEFAULT_ANALYSIS);
  if (!isRecord(value)) return err("analysis must be an object");
  if (Object.keys(value).some((key) => !["earsExtensions", "models", "generatedModels", "limits"].includes(key))) return err("Unknown analysis control field");
  const extensions = value.earsExtensions ?? [];
  if (!Array.isArray(extensions) || extensions.some((entry) => entry !== "where") || new Set(extensions).size !== extensions.length) return err("analysis.earsExtensions accepts only a unique where extension");
  const configuredLimits = value.limits ?? {};
  if (!isRecord(configuredLimits)) return err("analysis.limits must be an object");
  for (const [key, limit] of Object.entries(configuredLimits)) {
    if (!Object.hasOwn(ANALYSIS_LIMITS, key) || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) return err(`Invalid analysis bound: ${key}`);
  }
  const limits = Object.freeze({ ...ANALYSIS_LIMITS, ...configuredLimits }) as AnalysisLimits;
  if (limits.solverConcurrency > 16 || limits.expressionDepth > 128) return err("solverConcurrency/depth cannot exceed the checked 16/128 ceilings");
  const models = value.models ?? {};
  const generatedModels = value.generatedModels ?? {};
  if (!isRecord(models) || !isRecord(generatedModels)) return err("analysis model maps must be objects keyed by semantic group");
  const original = frozenJson(models);
  const generated = frozenJson(generatedModels);
  if (!original.ok) return original;
  if (!generated.ok) return generated;
  return ok(Object.freeze({ earsExtensions: Object.freeze([...extensions]) as readonly "where"[], models: original.value, generatedModels: generated.value, limits }));
}

/** Narrow an unknown global JSON object, excluding arrays and null. */
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Deep-copy and freeze bounded JSON so resolved configuration cannot alias callers. */
function frozenJson(value: Record<string, unknown>): Result<Readonly<Record<string, unknown>>, string> {
  let copy: Record<string, unknown>;
  try { copy = structuredClone(value); } catch { return err("Analysis models must be JSON data"); }
  const pending: { value: unknown; depth: number }[] = [{ value: copy, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (++nodes > 65_536 || item.depth > 128) return err("Analysis model JSON exceeds its structural bound");
    if (typeof item.value === "object" && item.value !== null) {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
      Object.freeze(item.value);
    }
  }
  return ok(copy);
}
