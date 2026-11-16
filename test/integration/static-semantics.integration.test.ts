import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runZ3Query } from "../../src/adapters/z3.js";
import { toSmtlibContent } from "../../src/domain/branded.js";
import { validateExpression } from "../../src/domain/formal/expressions.js";
import { renderExpression } from "../../src/domain/formal/expression-render.js";
import { renderExpressionSignature, expressionSymbolName, enumConstructorName } from "../../src/domain/formal/signature.js";
import type { ExpressionSignature } from "../../src/domain/formal/expression-types.js";
import { finiteValuations, evaluateFinite } from "../support/static-evaluator.js";
import { traceSpec } from "../support/spec-trace.js";

const available = spawnSync("z3", ["--version"], { encoding: "utf8", timeout: 5_000 }).status === 0;
const signature: ExpressionSignature = {
  symbols: [{ name: "g", sort: "Bool" }, { name: "x", sort: "Bool" }, { name: "mode", sort: { enum: "Mode" } }],
  enums: [{ name: "Mode", constructors: ["Ready", "Stopped"] }], units: [],
};

describe.skipIf(!available)("typed SMT matches independent finite evaluator", () => {
  it.each(["(=> g x)", "(and (=> g x) (not x))", "(and g (=> g x) (not x))", "(or (= mode Ready) (not x))", "(ite g (= mode Ready) x)"])("%s under every finite valuation", async (text) => {
    traceSpec("RAE-VERIFY-ORACLE", "FLA-TYPED-COMBINED", "FLA-SMTLIB-COMPILE");
    const checked = validateExpression(text, signature);
    const preamble = renderExpressionSignature(signature);
    if (!checked.ok || !preamble.ok) throw new Error("Invalid hand-authored oracle input");
    for (const valuation of finiteValuations(signature)) {
      const assignments = [...valuation].map(([name, value]) => {
        const symbol = signature.symbols.find((entry) => entry.name === name)!;
        const rendered = typeof value === "boolean" ? String(value) : enumConstructorName((symbol.sort as { enum: string }).enum, value.split(":")[1]!);
        return `(assert (= ${expressionSymbolName(name)} ${rendered}))`;
      });
      const script = [preamble.value, ...assignments, `(assert ${renderExpression(checked.value)})`, "(check-sat)", ""].join("\n");
      const result = await runZ3Query({ smtlib: toSmtlibContent(script), timeoutMs: 5_000 });
      expect(result.kind, `${text}, ${JSON.stringify([...valuation])}, ${result.stdout}`).toBe(evaluateFinite(checked.value, valuation) ? "sat" : "unsat");
    }
  });

  it("explicit exact unit conversion preserves integer measurement meaning", async () => {
    traceSpec("FLA-TYPED-EXACT");
    const units: ExpressionSignature = {
      symbols: [{ name: "latency", sort: "Int", unit: "ms" }], enums: [],
      units: [{ name: "ms", dimension: "time", scale: { numerator: "1", denominator: "1000" } }, { name: "s", dimension: "time", scale: { numerator: "1", denominator: "1" } }],
    };
    const checked = validateExpression("(<= (convert latency s) (quantity (/ 1 5) s))", units);
    const preamble = renderExpressionSignature(units);
    if (!checked.ok || !preamble.ok) throw new Error("Invalid explicit conversion fixture");
    for (const milliseconds of [199, 200, 201]) {
      const result = await runZ3Query({ smtlib: toSmtlibContent(`${preamble.value}(assert (= vlatency ${milliseconds}))\n(assert ${renderExpression(checked.value)})\n(check-sat)\n`), timeoutMs: 5_000 });
      expect(result.kind).toBe(milliseconds <= 200 ? "sat" : "unsat");
    }
  });
});
