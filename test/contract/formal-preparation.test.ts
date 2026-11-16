import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ImmutableObjects } from "../../src/domain/formal/immutable.js";
import { ExpressionRenderer, renderExpression } from "../../src/domain/formal/expression-render.js";
import { ExpressionValidationContext, validateExpression } from "../../src/domain/formal/expressions.js";
import { mergeExpressionSignatures, SignaturePreparation } from "../../src/domain/formal/signature.js";
import { FragmentClassifier } from "../../src/domain/formal/fragment.js";
import { PredicatePreparation, lowerPredicates } from "../../src/domain/formal/predicate-lowering.js";
import { ModelValueDecoder } from "../../src/domain/formal/model-values.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import { decodeAuthoredModel, freezeRegistry } from "../../src/domain/formal/concepts.js";
import { parseSpecText } from "../../src/domain/parser/spec.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import type { ExpressionSignature, LogicExpression } from "../../src/domain/formal/expression-types.js";
import { AlignmentPreparation, renameExpression } from "../../src/domain/code-backwards/alignment.js";
import { EvidenceRecorder } from "../../src/domain/formal/evidence.js";
import { QueryExecutor } from "../../src/domain/formal/query-executor.js";
import { traceSpec } from "../support/spec-trace.js";

const empty: ExpressionSignature = { symbols: [], enums: [], units: [] };

describe("immutable formal preparation", () => {
  it("rejects shallow freezes, accessors, mutable containers and cycles without reading getters", () => {
    const eligibility = new ImmutableObjects();
    let reads = 0;
    expect(eligibility.accepts(Object.freeze({ get value() { reads += 1; return 1; } }))).toBe(false);
    expect(reads).toBe(0);
    expect(eligibility.accepts(Object.freeze(new Map()))).toBe(false);
    expect(eligibility.accepts(Object.freeze({ nested: {} }))).toBe(false);
    const cycle: { nested?: unknown } = {}; cycle.nested = cycle; Object.freeze(cycle);
    expect(eligibility.accepts(cycle)).toBe(false);
    expect(eligibility.accepts(Object.freeze({ nested: Object.freeze([1, "value"]) }))).toBe(true);
  });

  it("mutable nested numerals never produce stale rendering, including tiny caches", () => {
    const value = { numerator: "1", denominator: "1" };
    const node: LogicExpression = Object.freeze({ kind: "number", sort: "Int", value });
    const renderer = new ExpressionRenderer(1);
    expect(renderer.render(node)).toBe("1");
    value.numerator = "2";
    expect(renderer.render(node)).toBe("2");
    value.numerator = "123";
    expect(renderer.render(node)).toBe("123");
  });

  it("prepared declaration/hash/index caches recheck nested signature mutations", () => {
    const symbol: { name: string; sort: "Bool" | "Int" } = { name: "x", sort: "Bool" };
    const signature = Object.freeze({ symbols: [symbol], enums: [], units: [] });
    const declarations = new SignaturePreparation(); const validation = new ExpressionValidationContext();
    const before = declarations.fingerprint(signature);
    expect(declarations.render(signature)).toEqual({ ok: true, value: '; mapping "x" -> vx\n(declare-const vx Bool)\n' });
    symbol.sort = "Int";
    expect(declarations.render(signature)).toEqual({ ok: true, value: '; mapping "x" -> vx\n(declare-const vx Int)\n' });
    expect(declarations.fingerprint(signature)).not.toBe(before);
    expect(validateExpression("(not x)", signature, undefined, validation).ok).toBe(false);
    symbol.sort = "Bool";
    expect(validateExpression("(not x)", signature, undefined, validation).ok).toBe(true);
    signature.symbols.push({ name: "x", sort: "Bool" });
    expect(declarations.render(signature).ok).toBe(false);
  });

  it("immutable signatures reuse checked indexes and retain the existing fingerprint bytes", () => {
    const merged = mergeExpressionSignatures([{ symbols: [{ name: "x", sort: "Bool" }], enums: [], units: [] }]);
    if (!merged.ok) throw new Error(merged.error);
    const context = new ExpressionValidationContext();
    expect(context.prepare(merged.value)).toBe(context.prepare(merged.value));
    const prepared = new SignaturePreparation();
    expect(prepared.fingerprint(merged.value)).toBe(createHash("sha256").update(JSON.stringify(merged.value)).digest("hex"));
  });

  it("cached fragment summaries count repeated occurrences and preserve depth limits", () => {
    const leaf: LogicExpression = Object.freeze({ kind: "bool", value: true, sort: "Bool" });
    const classifier = new FragmentClassifier();
    expect(classifier.classify(empty, Array.from({ length: 8192 }, () => leaf)).ok).toBe(true);
    expect(classifier.classify(empty, Array.from({ length: 8193 }, () => leaf)).ok).toBe(false);
    let expression: LogicExpression = leaf;
    for (let i = 0; i < 128; i += 1) expression = Object.freeze({ kind: "operator", op: "not", args: Object.freeze([expression]), sort: "Bool" });
    expect(classifier.classify(empty, [expression]).ok).toBe(true);
    const deeper: LogicExpression = Object.freeze({ kind: "operator", op: "not", args: Object.freeze([expression]), sort: "Bool" });
    expect(classifier.classify(empty, [deeper]).ok).toBe(false);
  });

  it("shared authored predicates retain values and limits while mutable backgrounds are rechecked", () => {
    const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Test [PREP-REQ]\nTHE engine SHALL respond.\n")] }).graph.claims;
    const model = decodeAuthoredModel({ background: ["true"], coverage: [{ name: "family", applicability: "true", sources: [{ file: "spec.md", ordinal: 0 }] }] }, ANALYSIS_LIMITS);
    if (!model.ok) throw new Error(model.error);
    const registry = freezeRegistry("group", "specs_forward", claims, model.value, [], [], ANALYSIS_LIMITS);
    const preparation = new PredicatePreparation();
    const raw = { index: 0, registryHash: registry.hash, predicates: { response: "true" } };
    const a = lowerPredicates(raw, claims[0]!, 0, registry, ANALYSIS_LIMITS, preparation);
    const b = lowerPredicates(raw, claims[0]!, 0, registry, ANALYSIS_LIMITS, preparation);
    if (!a.ok || !b.ok) throw new Error("invalid fixture");
    expect(a.value.background).toBe(b.value.background);
    expect(a.value.coverage).toBe(b.value.coverage);
    expect(lowerPredicates(raw, claims[0]!, 0, registry, ANALYSIS_LIMITS)).toEqual(a);
    expect(lowerPredicates(raw, claims[0]!, 0, registry, { ...ANALYSIS_LIMITS, expressionBytes: 1 }, preparation).ok).toBe(false);
    const background = ["true"];
    const mutable = Object.freeze({ ...registry, background });
    expect(preparation.prepare(mutable).ok).toBe(true);
    background[0] = "unknown";
    expect(preparation.prepare(mutable)).toEqual({ ok: false, error: "Invalid explicit background predicate" });
  });

  it.each(["background", "coverage"])("applies effective byte/node/depth limits to %s across cache reuse", (field) => {
    traceSpec("FLA-BOUNDS-EXPRESSIONS");
    const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Test [PREP-REQ]\nTHE engine SHALL respond.\n")] }).graph.claims;
    const expression = "(not (not true))";
    const model = decodeAuthoredModel(field === "background" ? { background: [expression] }
      : { coverage: [{ name: "family", applicability: expression, sources: [{ file: "spec.md", ordinal: 0 }] }] }, ANALYSIS_LIMITS);
    if (!model.ok) throw new Error(model.error);
    const registry = freezeRegistry("group", "specs_forward", claims, model.value, [], [], ANALYSIS_LIMITS);
    const preparation = new PredicatePreparation();
    const raw = { index: 0, registryHash: registry.hash, predicates: { response: "true" } };
    const exact = { ...ANALYSIS_LIMITS, expressionBytes: Buffer.byteLength(expression), expressionNodes: 5, expressionDepth: 2 };
    expect(lowerPredicates(raw, claims[0]!, 0, registry, exact, preparation).ok).toBe(true);
    for (const limit of [{ ...exact, expressionBytes: exact.expressionBytes - 1 }, { ...exact, expressionNodes: 4 }, { ...exact, expressionDepth: 1 }]) {
      const rejected = lowerPredicates(raw, claims[0]!, 0, registry, limit, preparation);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error).toContain(field === "background" ? "background" : "coverage");
      expect(lowerPredicates(raw, claims[0]!, 0, registry, exact, preparation).ok).toBe(true);
    }
  });

  it("witness indexes reflect mutable symbol names between calls", () => {
    const symbol = { name: "x", sort: "Bool" as const };
    const signature = Object.freeze({ symbols: [symbol], enums: [], units: [] });
    const decoder = new ModelValueDecoder();
    expect(decoder.decode("sat\n((vx true))\n", signature)).toEqual({ x: "true" });
    symbol.name = "y";
    expect(decoder.decode("sat\n((vy false))\n", signature)).toEqual({ y: "false" });
    expect(decoder.decode("sat\n((vx true))\n", signature)).toBeUndefined();
  });

  it("alignment indexing does not snapshot or cache a caller's mutable name map", () => {
    const signature = mergeExpressionSignatures([{ symbols: [{ name: "x", sort: "Bool" }, { name: "y", sort: "Bool" }], enums: [], units: [] }]);
    if (!signature.ok) throw new Error(signature.error);
    const expression = validateExpression("x", signature.value);
    if (!expression.ok) throw new Error(expression.error.message);
    const names = new Map([["x", "x"]]); const prepared = new AlignmentPreparation();
    expect(renameExpression(expression.value, names, signature.value, signature.value, prepared)?.kind).toBe("symbol");
    names.set("x", "y");
    expect(renameExpression(expression.value, names, signature.value, signature.value, prepared)).toMatchObject({ name: "y" });
  });

  it("query preparation preserves exact script, evidence bytes, order and actual execution counts", async () => {
    const merged = mergeExpressionSignatures([{ symbols: [{ name: "Flag_X", sort: "Bool" }, { name: "Count", sort: "Int" }], enums: [], units: [] }]);
    if (!merged.ok) throw new Error(merged.error);
    const parsed = validateExpression("(and Flag_X (>= Count 0))", merged.value);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const writes = new Map<string, string | Uint8Array>();
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async (path, bytes) => { writes.set(path, bytes); });
    const result = { kind: "sat" as const, stdout: '(:version "4.8.12")\nsat\n', stderr: "", exitCode: 0 };
    let calls = 0;
    const executor = new QueryExecutor(ANALYSIS_LIMITS, evidence, undefined, async () => { calls += 1; return result; });
    const expression = "(and vFlag_00005FX (>= vCount 0))";
    const script = `(get-info :version)\n; mapping "Flag_X" -> vFlag_00005FX\n; mapping "Count" -> vCount\n(declare-const vFlag_00005FX Bool)\n(declare-const vCount Int)\n(assert ${expression})\n(check-sat)\n`;
    for (let ordinal = 0; ordinal < 2; ordinal += 1) {
      const outcome = await executor.execute("group", "test", merged.value, [parsed.value]);
      expect(outcome.script).toBe(script);
      const scope = `group:query:${ordinal}:test`;
      const root = createHash("sha256").update(scope).digest("hex");
      expect(outcome.inputPath).toBe(`semantic_evidence/${root}.input.smt2`);
      expect(writes.get(outcome.outputPath!)).toBe(JSON.stringify({ scope, kind: "test", fragment: { mode: "static", quantifierFree: true, features: ["bool", "linear-int"] }, predicates: [expression],
        signatureHash: createHash("sha256").update(JSON.stringify(merged.value)).digest("hex"), solverOptions: {}, solverVersion: "4.8.12", result,
        decodedValues: null, decodedCore: null, attributionStrength: null }, null, 2) + "\n");
    }
    expect(calls).toBe(2);
    expect(executor.ledger.map((record) => record.scope)).toEqual(["group:query:0:test", "group:query:1:test"]);
  });

  it("bounded cached rendering agrees with the pure renderer through cache resets", () => {
    fc.assert(fc.property(fc.array(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), { minLength: 1, maxLength: 30 }), (values) => {
      const renderer = new ExpressionRenderer(32);
      const expressions = values.map((value) => {
        const parsed = validateExpression(String(value), empty); if (!parsed.ok) throw new Error(parsed.error.message); return parsed.value;
      });
      for (const node of [...expressions, ...expressions.reverse()]) expect(renderer.render(node)).toBe(renderExpression(node));
    }));
  });
});
