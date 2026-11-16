import { describe, expect, it } from "vitest";
import { parseExpressionSyntax } from "../../src/domain/formal/expression-parser.js";
import { validateExpression } from "../../src/domain/formal/expressions.js";
import { renderExpression } from "../../src/domain/formal/expression-render.js";
import { mergeExpressionSignatures, renderExpressionSignature } from "../../src/domain/formal/signature.js";
import { classifyFragment } from "../../src/domain/formal/fragment.js";
import type { ExpressionSignature } from "../../src/domain/formal/expression-types.js";
import { rational } from "../../src/domain/formal/rational.js";
import { traceSpec } from "../support/spec-trace.js";
import { sanitizeAssertionExpr } from "../../src/domain/formal/smtlib.js";

const signature: ExpressionSignature = {
  symbols: [{ name: "x", sort: "Int" }, { name: "y", sort: "Int" }, { name: "flag", sort: "Bool" },
    { name: "latency", sort: "Int", unit: "ms" }, { name: "mode", sort: { enum: "Mode" } },
    { name: "matches", sort: "Bool", args: ["Int"] }],
  enums: [{ name: "Mode", constructors: ["Ready", "Stopped"] }],
  units: [{ name: "ms", dimension: "time", scale: { numerator: "1", denominator: "1000" } },
    { name: "s", dimension: "time", scale: { numerator: "1", denominator: "1" } },
    { name: "bytes", dimension: "size", scale: { numerator: "1", denominator: "1" } }],
};

describe("typed scalar expression kernel", () => {
  it.each(["(and flag (= mode Ready))", "(=> flag (< (+ x 1) 3))", "(* (+ 1 2) x)", "(matches 3)", "(- (/ 1 3))"])("accepts %s", (expr) => {
    traceSpec("FLA-SAMPLE-ACCEPT", "FLA-TYPED-FRAGMENT");
    expect(validateExpression(expr, signature).ok).toBe(true);
  });

  it.each(["(< flag 3)", "(matches true)", "(matches 1 2)", "unknown", "(and flag) (check-sat)", "(* x y)", "(div x 2)", '(= "x_y()" "x_y()")', "(forall ((i Int)) (> i 0))", "(= x (to_real y))", "(assert flag)"])("rejects %s", (expr) => {
    traceSpec("FLA-SAMPLE-REJECT", "FLA-TYPED-UNSUPPORTED");
    expect(validateExpression(expr, signature).ok).toBe(false);
  });

  it.each(["(/ x 2)", "(/ 1.0 2)", "(/ (quantity 1 ms) 2)", "(/ 1 (quantity 2 ms))", "(/ 1 0)"])("rejects division outside the exact rational-literal contract: %s", (text) => {
    traceSpec("FLA-TYPED-UNSUPPORTED", "FLA-SAMPLE-REJECT");
    expect(validateExpression(text, signature).ok).toBe(false);
  });

  it("lexes string punctuation literally and rejects the unsupported theory", () => {
    traceSpec("FLA-SMTLIB-LITERALS");
    const raw = parseExpressionSyntax('"x_y(""quoted"")"');
    expect(raw.ok && raw.value.kind).toBe("string");
    expect(raw.ok && raw.value.kind === "string" && raw.value.text).toBe('x_y("quoted")');
    expect(validateExpression('"x_y()"', signature).ok).toBe(false);
    expect(sanitizeAssertionExpr('(= path_value "is-ready_x")')).toBe('(= path_00005Fvalue "is-ready_x")');
  });

  it("preserves exact integers, decimals and reduced rationals", () => {
    traceSpec("FLA-TYPED-EXACT");
    const integer = validateExpression("9007199254740993", signature);
    expect(integer.ok && renderExpression(integer.value)).toBe("9007199254740993");
    const decimal = validateExpression("0.125", signature);
    expect(decimal.ok && renderExpression(decimal.value)).toBe("(/ 1 8)");
    expect(rational("-2", "-4")).toEqual({ ok: true, value: { numerator: "1", denominator: "2" } });
    expect(rational("1", "0").ok).toBe(false);
  });

  it("requires explicit unit annotations and exact conversion", () => {
    traceSpec("FLA-TYPED-EXACT");
    expect(validateExpression("(<= latency 200)", signature).ok).toBe(false);
    expect(validateExpression("(<= latency (quantity 200 ms))", signature).ok).toBe(true);
    const converted = validateExpression("(convert latency s)", signature);
    expect(converted.ok && converted.value.sort).toBe("Real");
    expect(converted.ok && converted.value.unit).toBe("s");
    expect(converted.ok && renderExpression(converted.value)).toBe("(* (to_real vlatency) (/ 1 1000))");
    expect(validateExpression("(convert latency bytes)", signature).ok).toBe(false);
  });

  it("checks shared signatures and declares each symbol once", () => {
    traceSpec("FLA-SPEC-DEDUP", "FLA-SPEC-NAMED", "FLA-SMTLIB-QUERYSAT");
    const merged = mergeExpressionSignatures([signature, signature]);
    expect(merged.ok && merged.value.symbols.length).toBe(signature.symbols.length);
    const emitted = merged.ok ? renderExpressionSignature(merged.value) : merged;
    expect(emitted.ok && emitted.value.match(/declare-const vx /gu)?.length).toBe(1);
    expect(emitted.ok && emitted.value).not.toContain("check-sat");
    expect(mergeExpressionSignatures([signature, { ...signature, symbols: [{ name: "x", sort: "Bool" }] }]).ok).toBe(false);
  });

  it("classifies the assembled query and bounds syntax nodes/depth", () => {
    traceSpec("FLA-TYPED-COMBINED", "FLA-BOUNDS-EXPRESSIONS");
    const expr = validateExpression("(and flag (matches x) (= mode Ready))", signature);
    expect(expr.ok && classifyFragment(signature, [expr.value])).toEqual({ ok: true, value: { mode: "static", quantifierFree: true, features: ["bool", "enum", "linear-int", "uf"] } });
    expect(parseExpressionSyntax("(not (not flag))", { bytes: 100, nodes: 20, depth: 1 }).ok).toBe(false);
    expect(parseExpressionSyntax("flag", { bytes: 100, nodes: 0, depth: 1 }).ok).toBe(false);
    expect(parseExpressionSyntax("(and flag flag)", { bytes: 100, nodes: 2, depth: 3 }).ok).toBe(false);
  });

  it("distinguishes quoted numeric symbol identities from numeric literals", () => {
    traceSpec("FLA-SMTLIB-SANITIZE");
    const input: ExpressionSignature = { symbols: [{ name: "123", sort: "Bool" }], enums: [], units: [] };
    const expr = validateExpression("|123|", input);
    expect(expr.ok && expr.value.sort).toBe("Bool");
    expect(expr.ok && renderExpression(expr.value)).toBe("v_00003123");
  });

  it("renders zero-arity functions as constant symbols rather than empty applications", () => {
    traceSpec("FLA-SMTLIB-COMPILE");
    const input: ExpressionSignature = { symbols: [{ name: "f", args: [], sort: "Bool" }], enums: [], units: [] };
    const expr = validateExpression("(f)", input);
    expect(expr.ok && renderExpression(expr.value)).toBe("vf");
  });
});
