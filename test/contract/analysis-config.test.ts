import { describe, expect, it } from "vitest";
import { resolveAnalysisConfig, DEFAULT_ANALYSIS } from "../../src/domain/formal/analysis-config.js";
import { traceSpec } from "../support/spec-trace.js";

describe("immutable static analysis configuration", () => {
  it("defaults to no inferred assumptions or EARS extensions", () => {
    traceSpec("CAT-EARS-WHERE", "FLA-ANALYSIS-BOUNDS");
    expect(resolveAnalysisConfig(undefined)).toEqual({ ok: true, value: DEFAULT_ANALYSIS });
    expect(DEFAULT_ANALYSIS.earsExtensions).toEqual([]);
    expect(DEFAULT_ANALYSIS.models).toEqual({});
  });

  it("keeps explicit original and generated model maps separate", () => {
    traceSpec("STC-ALIGN-BLIND", "FLA-PREMISE-AUTHORITY");
    const raw = { earsExtensions: ["where"], models: { auth: { background: ["original"] } }, generatedModels: { auth: { background: ["generated"] } } };
    const resolved = resolveAnalysisConfig(raw);
    if (!resolved.ok) throw new Error(resolved.error);
    raw.models.auth.background.push("mutated");
    expect(resolved.value.models).toEqual({ auth: { background: ["original"] } });
    expect(resolved.value.generatedModels).toEqual({ auth: { background: ["generated"] } });
    expect(Object.isFrozen((resolved.value.models.auth as { background: string[] }).background)).toBe(true);
  });

  it.each<{ raw: unknown }>([
    { earsExtensions: ["where", "where"] }, { earsExtensions: ["conditional"] },
    { limits: { solverConcurrency: 17 } }, { limits: { expressionDepth: 129 } },
    { limits: { concepts: 0 } }, { limits: { toString: 1 } }, { limits: { queryBytes: NaN } },
    { unknown: true }, { models: [] },
  ].map((raw) => ({ raw })))("rejects malformed global controls $raw", ({ raw }) => {
    traceSpec("FLA-ANALYSIS-BOUNDS");
    expect(resolveAnalysisConfig(raw).ok).toBe(false);
  });

  it("retains malformed individual models for localized semantic validation", () => {
    traceSpec("FLA-CONCEPT-COLLISION");
    const resolved = resolveAnalysisConfig({ models: { valid: {}, malformed: 123 } });
    expect(resolved.ok && resolved.value.models.malformed).toBe(123);
  });
});
