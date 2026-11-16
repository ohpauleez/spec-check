/** Independent finite Bool/enum evaluator; imports types, not production semantics. */
import type { ExpressionSignature, LogicExpression } from "../../src/domain/formal/expression-types.js";

/** Domain assignments distinguish enum identities from Boolean values. */
export type FiniteValue = boolean | string;
export type FiniteValuation = ReadonlyMap<string, FiniteValue>;

/** Enumerate at most 4,096 valuations; numeric or nonconstant UF domains reject. */
export function finiteValuations(signature: ExpressionSignature): readonly FiniteValuation[] {
  let rows: ReadonlyMap<string, FiniteValue>[] = [new Map()];
  for (const symbol of signature.symbols) {
    if (symbol.args !== undefined && symbol.args.length > 0) throw new Error("Finite oracle does not interpret UF applications");
    const values: readonly FiniteValue[] = symbol.sort === "Bool" ? [false, true]
      : typeof symbol.sort === "object"
        ? signature.enums.find((entry) => entry.name === (symbol.sort as { enum: string }).enum)!.constructors.map((name) => `${(symbol.sort as { enum: string }).enum}:${name}`)
        : [];
    if (values.length === 0 || rows.length * values.length > 4_096) throw new Error("Unsupported or oversized finite oracle domain");
    rows = rows.flatMap((row) => values.map((value) => new Map([...row, [symbol.name, value]])));
  }
  return rows;
}

/** Evaluate finite operators directly, independently of renderer/query templates. */
export function evaluateFinite(node: LogicExpression, valuation: FiniteValuation, depth = 0): FiniteValue {
  if (depth > 128) throw new Error("Finite evaluator depth exceeded");
  if (node.kind === "bool") return node.value;
  if (node.kind === "enum") return `${node.enumName}:${node.name}`;
  if (node.kind === "symbol") {
    const value = valuation.get(node.name);
    if (value === undefined) throw new Error(`Missing oracle assignment: ${node.name}`);
    return value;
  }
  if (node.kind !== "operator") throw new Error("Non-finite expression in finite oracle");
  const values = node.args.map((child) => evaluateFinite(child, valuation, depth + 1));
  switch (node.op) {
    case "not": return !values[0];
    case "and": return values.every((value) => value === true);
    case "or": return values.some((value) => value === true);
    case "=>": return values[0] === false || values[1] === true;
    case "=": return values.every((value) => value === values[0]);
    case "distinct": return new Set(values).size === values.length;
    case "ite": return values[0] === true ? values[1]! : values[2]!;
    default: throw new Error("Numeric operator is outside the finite oracle");
  }
}
