import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { booleanTerms, integerTerms, realTerms, enumTerms, names, signature, source, evaluate, op, type Assignment, type Term, type Names } from "../support/generated-expressions.js";
import { validateExpression } from "../../src/domain/formal/expressions.js";
import { renderExpression } from "../../src/domain/formal/expression-render.js";
import { renderExpressionSignature, expressionSymbolName, enumConstructorName } from "../../src/domain/formal/signature.js";
import { runZ3Query } from "../../src/adapters/z3.js";
import { toSmtlibContent } from "../../src/domain/branded.js";
import { traceSpec } from "../support/spec-trace.js";

const assignment = fc.record({ flag: fc.boolean(), other: fc.boolean(), count: fc.integer({ min: -3, max: 3 }), mode: fc.constantFrom<"ready" | "stopped">("ready", "stopped") });
const hasZ3 = spawnSync("z3", ["--version"], { timeout: 5000 }).status === 0;
const PROPERTY_DEPTH_MAX = 3;
const SOLVER_PROPERTY_RUNS = 8; // Six solver calls/run: three forms under two bijective spellings.

async function verdict(term: Term, values: Assignment, table: Names) {
  const sig = signature(table);
  const parsed = validateExpression(source(term, table), sig);
  const declarations = renderExpressionSignature(sig);
  if (!parsed.ok || !declarations.ok) throw new Error("Generated valid expression/signature was rejected");
  const bindings = [`(= ${expressionSymbolName(table.flag)} ${values.flag})`, `(= ${expressionSymbolName(table.other)} ${values.other})`,
    `(= ${expressionSymbolName(table.count)} ${values.count < 0 ? `(- ${-values.count})` : values.count})`,
    `(= ${expressionSymbolName(table.mode)} ${enumConstructorName(table.enumSort, table[values.mode])})`];
  const script = `${declarations.value}${bindings.map((binding) => `(assert ${binding})`).join("\n")}\n(assert ${renderExpression(parsed.value)})\n(check-sat)\n`;
  return (await runZ3Query({ smtlib: toSmtlibContent(script), timeoutMs: 5000 })).kind;
}

describe("bounded sort-directed expression generation", () => {
  it("validates generated Bool, Int, Real and enum source descriptions with sort-preserving shrinking", () => {
    traceSpec("FLA-TYPED-FRAGMENT", "FLA-SAMPLE-ACCEPT");
    const table = names(); const sig = signature(table);
    for (const [arbitrary, expected] of [[booleanTerms(PROPERTY_DEPTH_MAX), "Bool"], [integerTerms(PROPERTY_DEPTH_MAX), "Int"], [realTerms(PROPERTY_DEPTH_MAX), "Real"], [enumTerms(), { enum: table.enumSort }]] as const) {
      fc.assert(fc.property(arbitrary, (term) => {
        const parsed = validateExpression(source(term, table), sig);
        expect(parsed.ok, source(term, table)).toBe(true);
        if (parsed.ok) expect(parsed.value.sort).toEqual(expected);
      }), { numRuns: 100 });
    }
  });

  it("canonical literal rendering is stable without assuming source names invert solver namespaces", () => {
    traceSpec("FLA-TYPED-EXACT");
    fc.assert(fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 100n }), (n, d) => {
      const sig = { symbols: [], enums: [], units: [] };
      const first = validateExpression(`(/ ${n} ${d})`, sig);
      if (!first.ok) throw new Error(first.error.message);
      const second = validateExpression(renderExpression(first.value), sig);
      expect(second.ok).toBe(true);
      if (second.ok) { expect(second.value.sort).toBe(first.value.sort); expect(renderExpression(second.value)).toBe(renderExpression(first.value)); }
    }));
  });

  it.skipIf(!hasZ3)("independent exact semantics and SAT/UNSAT forms survive bijective identifier renaming", async () => {
    traceSpec("RAE-VERIFY-ORACLE", "FLA-SMTLIB-SANITIZE", "FLA-SMTLIB-LITERALS");
    // Every solver sample includes Int, Real and enum comparisons, not just a lucky Bool leaf.
    const mixed = fc.tuple(booleanTerms(2), integerTerms(2), realTerms(1), enumTerms()).map(([bool, integer, real, enumeration]) => op("and", bool,
      op("and", op("<=", integer, { kind: "integer", value: 3n }), op("and", op("<=", real, { kind: "real", numerator: 1n, denominator: 3n }), op("=", enumeration, { kind: "variable", name: "mode" })))));
    await fc.assert(fc.asyncProperty(mixed, assignment, fc.constantFrom("Unicodeδ", "punctuation-._:;", "numeric123"), async (term, values, suffix) => {
      const forms = [term, op("or", term, op("not", term)), op("and", term, op("not", term))];
      const expected = [evaluate(term, values) === true ? "sat" : "unsat", "sat", "unsat"];
      for (let index = 0; index < forms.length; index += 1) {
        const original = await verdict(forms[index]!, values, names());
        const renamed = await verdict(forms[index]!, values, names(suffix));
        expect(original).toBe(expected[index]); expect(renamed).toBe(original);
      }
    }), { numRuns: SOLVER_PROPERTY_RUNS, endOnFailure: true });
  }, 30_000);

  it.skipIf(!hasZ3)("typed UF applications and exact unit/coercion lowering are solver-accepted", async () => {
    traceSpec("FLA-TYPED-EXACT", "FLA-TYPED-COMBINED");
    const table = names(); const sig = signature(table);
    const uf = validateExpression(`(= (|${table.next}| |${table.count}|) (|${table.next}| |${table.count}|))`, sig);
    const declarations = renderExpressionSignature(sig);
    if (!uf.ok || !declarations.ok) throw new Error("Invalid UF test input");
    expect((await runZ3Query({ smtlib: toSmtlibContent(`${declarations.value}(assert ${renderExpression(uf.value)})\n(check-sat)\n`) })).kind).toBe("sat");
    await fc.assert(fc.asyncProperty(fc.integer({ min: -10000, max: 10000 }), async (milliseconds) => {
      const units = { symbols: [], enums: [], units: [{ name: "ms", dimension: "time", scale: { numerator: "1", denominator: "1000" } }, { name: "s", dimension: "time", scale: { numerator: "1", denominator: "1" } }] };
      const parsed = validateExpression(`(= (convert (quantity ${milliseconds} ms) s) (quantity (/ ${milliseconds} 1000) s))`, units);
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect((await runZ3Query({ smtlib: toSmtlibContent(`(assert ${renderExpression(parsed.value)})\n(check-sat)\n`) })).kind).toBe("sat");
    }), { numRuns: 8, endOnFailure: true });
  });
});
