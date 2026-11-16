/** Independent bounded expression descriptions/source serializer/reference semantics.
 * No production parser, renderer or arithmetic implementation is used here.
 */
import fc from "fast-check";
import type { ExpressionSignature } from "../../src/domain/formal/expression-types.js";

export type Variable = "flag" | "other" | "count" | "mode";
export type Operator = "not" | "and" | "or" | "=>" | "=" | "<=" | "+" | "-" | "*" | "ite" | "to_real";
export type Term =
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "integer"; readonly value: bigint }
  | { readonly kind: "real"; readonly numerator: bigint; readonly denominator: bigint }
  | { readonly kind: "enum"; readonly value: "ready" | "stopped" }
  | { readonly kind: "variable"; readonly name: Variable }
  | { readonly kind: "operator"; readonly op: Operator; readonly args: readonly Term[] };

export interface Fraction { readonly n: bigint; readonly d: bigint }
export type Value = boolean | string | Fraction;
export interface Assignment { readonly flag: boolean; readonly other: boolean; readonly count: number; readonly mode: "ready" | "stopped" }
export interface Names extends Record<Variable, string> { readonly next: string; readonly enumSort: string; readonly ready: string; readonly stopped: string }

const integer: fc.Arbitrary<Term> = fc.bigInt({ min: -20n, max: 20n }).map((value) => ({ kind: "integer", value }));
const real: fc.Arbitrary<Term> = fc.tuple(fc.bigInt({ min: -20n, max: 20n }), fc.bigInt({ min: 1n, max: 10n })).map(([numerator, denominator]) => ({ kind: "real", numerator, denominator }));
const variable = (name: Variable): Term => ({ kind: "variable", name });
export const op = (operator: Operator, ...args: readonly Term[]): Term => ({ kind: "operator", op: operator, args });

/** Depth decreases on every recursive edge; shrinking preserves the selected sort. */
export function integerTerms(depth: number): fc.Arbitrary<Term> {
  const leaf = fc.oneof(integer, fc.constant(variable("count")));
  if (depth === 0) return leaf;
  const child = integerTerms(depth - 1);
  return fc.oneof(leaf, fc.tuple(child, child).map(([a, b]) => op("+", a, b)), child.map((value) => op("-", value)),
    fc.tuple(integer, child).map(([scalar, value]) => op("*", scalar, value)));
}

/** Exact Real branches use explicit coercion; no implicit Int/Real mixing is generated. */
export function realTerms(depth: number): fc.Arbitrary<Term> {
  const leaf = fc.oneof(real, integerTerms(0).map((value) => op("to_real", value)));
  if (depth === 0) return leaf;
  return fc.oneof(leaf, fc.tuple(realTerms(depth - 1), realTerms(depth - 1)).map(([a, b]) => op("+", a, b)));
}

export function enumTerms(): fc.Arbitrary<Term> {
  return fc.oneof(fc.constant(variable("mode")), fc.constant<Term>({ kind: "enum", value: "ready" }), fc.constant<Term>({ kind: "enum", value: "stopped" }));
}

/** Every generated tree is Bool-sorted, with bounded arithmetic/enum/conditional children. */
export function booleanTerms(depth: number): fc.Arbitrary<Term> {
  const leaf = fc.oneof(fc.boolean().map<Term>((value) => ({ kind: "bool", value })), fc.constant(variable("flag")), fc.constant(variable("other")));
  if (depth === 0) return leaf;
  const child = booleanTerms(depth - 1);
  return fc.oneof(leaf, child.map((a) => op("not", a)), fc.tuple(fc.constantFrom<Operator>("and", "or", "=>", "="), child, child).map(([kind, a, b]) => op(kind, a, b)),
    fc.tuple(integerTerms(depth - 1), integerTerms(depth - 1)).map(([a, b]) => op("<=", a, b)),
    fc.tuple(realTerms(depth - 1), realTerms(depth - 1)).map(([a, b]) => op("<=", a, b)),
    fc.tuple(enumTerms(), enumTerms()).map(([a, b]) => op("=", a, b)), fc.tuple(child, child, child).map(([c, a, b]) => op("ite", c, a, b)));
}

/** Bijective table: index suffixes keep adversarial spellings distinct and away from builtins. */
export function names(suffix = "plain"): Names {
  return { flag: `0_${suffix}`, other: `other-${suffix}`, count: `count.${suffix}`, mode: `mode:${suffix}`, next: `next;${suffix}`,
    enumSort: `Sort_${suffix}`, ready: `ready ${suffix}`, stopped: `stopped_δ_${suffix}` };
}

export function signature(table: Names): ExpressionSignature {
  return { symbols: [{ name: table.flag, sort: "Bool" }, { name: table.other, sort: "Bool" }, { name: table.count, sort: "Int" },
    { name: table.mode, sort: { enum: table.enumSort } }, { name: table.next, args: ["Int"], sort: "Int" }],
    enums: [{ name: table.enumSort, constructors: [table.ready, table.stopped] }], units: [] };
}

/** Structural source serialization. Quoted test names deliberately exclude pipe/backslash/newline. */
export function source(term: Term, table: Names): string {
  switch (term.kind) {
    case "bool": return String(term.value);
    case "integer": return String(term.value);
    case "real": return `(/ ${term.numerator} ${term.denominator})`;
    case "enum": return `|${table[term.value]}|`;
    case "variable": return `|${table[term.name]}|`;
    case "operator": return `(${term.op} ${term.args.map((arg) => source(arg, table)).join(" ")})`;
  }
}

function fraction(value: Value): Fraction {
  if (typeof value !== "object") throw new Error("Generator violated numeric operand sort");
  return value;
}

/** Reference arithmetic uses unreduced exact fractions and cross-products, independently of production. */
export function evaluate(term: Term, assignment: Assignment): Value {
  switch (term.kind) {
    case "bool": return term.value;
    case "integer": return { n: term.value, d: 1n };
    case "real": return { n: term.numerator, d: term.denominator };
    case "enum": return term.value;
    case "variable": return term.name === "count" ? { n: BigInt(assignment.count), d: 1n } : assignment[term.name];
    case "operator": return evaluateOperator(term.op, term.args.map((arg) => evaluate(arg, assignment)));
  }
}

function evaluateOperator(kind: Operator, args: readonly Value[]): Value {
  const a = args[0]!; const b = args[1]!;
  switch (kind) {
    case "not": return !a;
    case "and": return a === true && b === true;
    case "or": return a === true || b === true;
    case "=>": return a === false || b === true;
    case "ite": return a === true ? b : args[2]!;
    case "=": return typeof a === "object" && typeof b === "object" ? a.n * b.d === b.n * a.d : a === b;
    case "to_real": return fraction(a);
    case "<=": { const x = fraction(a); const y = fraction(b); return x.n * y.d <= y.n * x.d; }
    case "+": { const x = fraction(a); const y = fraction(b); return { n: x.n * y.d + y.n * x.d, d: x.d * y.d }; }
    case "-": { const x = fraction(a); return { n: -x.n, d: x.d }; }
    case "*": { const x = fraction(a); const y = fraction(b); return { n: x.n * y.n, d: x.d * y.d }; }
  }
}
