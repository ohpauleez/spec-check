import { describe, expect, it } from "vitest";
import { renderExpressionSignature, enumSortName, enumConstructorName, expressionSymbolName } from "../../src/domain/formal/signature.js";
import { runZ3Query } from "../../src/adapters/z3.js";
import { toSmtlibContent } from "../../src/domain/branded.js";
import type { ExpressionSignature } from "../../src/domain/formal/expression-types.js";
import { traceSpec } from "../support/spec-trace.js";

describe("typed reversible identifier mapping comments", () => {
  it("preserves constants/functions/enums/Unicode/newline identity as inert JSON comments", async () => {
    traceSpec("FLA-SMTLIB-SANITIZE", "FLA-SPEC-COMMENT-SAFE", "FLA-SPEC-DEDUP");
    const constant = "a_b"; const functionName = "λ\n(check-sat)"; const enumName = "Mode_状態"; const constructor = "active\r\n(assert false)";
    const signature: ExpressionSignature = { symbols: [{ name: constant, sort: "Bool" }, { name: functionName, sort: "Bool", args: ["Bool"] }],
      enums: [{ name: enumName, constructors: [constructor, "idle"] }], units: [] };
    const rendered = renderExpressionSignature(signature);
    if (!rendered.ok) throw new Error(rendered.error);
    expect(rendered.value).toContain(`; mapping ${JSON.stringify(constant)} -> ${expressionSymbolName(constant)}`);
    expect(rendered.value).toContain(`; mapping ${JSON.stringify(functionName)} -> ${expressionSymbolName(functionName)}`);
    expect(rendered.value).toContain(`; mapping ${JSON.stringify(enumName)} -> ${enumSortName(enumName)}`);
    expect(rendered.value).toContain(`; mapping ${JSON.stringify(`${enumName}.${constructor}`)} -> ${enumConstructorName(enumName, constructor)}`);
    expect(rendered.value.split("\n").filter((line) => line.startsWith("; mapping "))).toHaveLength(5);
    const result = await runZ3Query({ smtlib: toSmtlibContent(`${rendered.value}(assert ${expressionSymbolName(constant)})\n(check-sat)\n`) });
    expect(result.kind).toBe("sat");
  });
});
