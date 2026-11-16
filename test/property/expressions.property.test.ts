import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseExpressionSyntax } from "../../src/domain/formal/expression-parser.js";
import { validateExpression } from "../../src/domain/formal/expressions.js";
import { renderExpression } from "../../src/domain/formal/expression-render.js";
import { mergeExpressionSignatures } from "../../src/domain/formal/signature.js";
import type { ExpressionSignature } from "../../src/domain/formal/expression-types.js";
import { traceSpec } from "../support/spec-trace.js";

describe("expression and shared signature invariants", () => {
  it("retains literal contents including parens and doubled quotes", () => {
    traceSpec("FLA-SMTLIB-LITERALS");
    fc.assert(fc.property(fc.string({ maxLength: 100 }), (text) => {
      const encoded = '"' + text.replace(/"/gu, '""') + '"';
      const parsed = parseExpressionSyntax(encoded);
      expect(parsed.ok && parsed.value.kind === "string" && parsed.value.text).toBe(text);
    }));
  });

  it("preserves exact integers beyond the JavaScript safe range", () => {
    traceSpec("FLA-TYPED-EXACT");
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 40n }), (n) => {
      const signature: ExpressionSignature = { symbols: [], enums: [], units: [] };
      const expr = validateExpression(String(n), signature);
      expect(expr.ok && renderExpression(expr.value)).toBe(String(n));
    }));
  });

  it("shared signature deduplication is immutable and deterministic", () => {
    traceSpec("FLA-SPEC-DEDUP", "FLA-SPEC-CLAIMIDS");
    fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), (copies) => {
      const sort = { enum: "Mode" };
      const signature: ExpressionSignature = { symbols: [{ name: "mode", sort }], enums: [{ name: "Mode", constructors: ["Ready", "Stopped"] }], units: [] };
      const merged = mergeExpressionSignatures(Array.from({ length: copies }, () => signature));
      expect(merged.ok && merged.value.symbols.length).toBe(1);
      sort.enum = "Mutated";
      expect(merged.ok && merged.value.symbols[0]?.sort).toEqual({ enum: "Mode" });
    }));
  });
});
