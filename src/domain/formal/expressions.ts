/** Resolve and type-check a closed scalar expression dialect against a signature.
 * @example validateExpression("(and Enabled true)", signature, limits, runValidation);
 */
import { err, ok, type Result } from "../result.js";
import { parseExpressionSyntax, type ExpressionSyntax } from "./expression-parser.js";
import {
  EXPRESSION_LIMITS, type ExpressionIssue, type ExpressionLimits, type ExpressionOperator,
  type ExpressionSignature, type ExpressionSort, type LogicExpression,
  type ExpressionSymbol, type UnitDefinition,
} from "./expression-types.js";
import { numericAtom, rational, scaleRatio } from "./rational.js";
import { ImmutableObjects } from "./immutable.js";

const OPERATORS = new Set<string>(["not", "and", "or", "=>", "=", "distinct", "<", "<=", ">", ">=", "ite", "+", "-", "*", "to_real"]);
const RESERVED = new Set<string>([...OPERATORS, "true", "false", "quantity", "convert", "/", "assert", "check-sat", "declare-const", "declare-fun", "set-option", "get-model", "get-unsat-core", "push", "pop", "exit"]);

/** Parse/resolve one expression against a structurally decoded signature.
 * @returns A frozen typed AST, or an attributed syntax/signature/type/unit/limit issue.
 * @remarks Inputs are never mutated. Bounds apply before recursive typing; context is
 * optional run-local preparation, not authority to trust mutable callers or solver text.
 * @throws Only unexpected infrastructure/programmer failures, not ordinary invalid expressions.
 * @example validateExpression("(<= Count 3)", signature);
 */
export function validateExpression(text: string, signature: ExpressionSignature, limits: ExpressionLimits = EXPRESSION_LIMITS, context = new ExpressionValidationContext()): Result<LogicExpression, ExpressionIssue> {
  const prepared = context.prepare(signature);
  if (!prepared.ok) return err({ code: "expression-signature", message: prepared.error });
  const syntax = parseExpressionSyntax(text, limits);
  return syntax.ok ? check(syntax.value, prepared.value, 0, limits.depth) : syntax;
}

/** Index closures keep their mutable Maps private to the preparation boundary. */
export interface SignatureIndexes {
  readonly symbol: (name: string) => ExpressionSymbol | undefined;
  readonly enumeration: (constructor: string) => ExpressionSignature["enums"][number] | undefined;
  readonly unit: (name: string | undefined) => UnitDefinition | undefined;
}

/** Reuse checked indexes only for deeply immutable signatures, within one run/work unit.
 * @example const validation = new ExpressionValidationContext();
 */
export class ExpressionValidationContext {
  private readonly immutable = new ImmutableObjects();
  private readonly indexes = new WeakMap<ExpressionSignature, Result<SignatureIndexes, string>>();

  /** Resolve private lookup indexes after full signature validation.
   * @returns Checked indexes, or the signature validation reason. Invalid results are not cached.
   * @remarks Signature must have the decoded collection shape. No I/O/mutation; only deeply
   * frozen data is reused, so mutable callers are rechecked on every call.
   * @example validation.prepare(signature);
   */
  prepare(signature: ExpressionSignature): Result<SignatureIndexes, string> {
    const cached = this.indexes.get(signature);
    if (cached !== undefined) return cached;
    const issue = validateSignature(signature);
    if (issue !== undefined) return err(issue);
    const symbols = new Map(signature.symbols.map((symbol) => [symbol.name, symbol]));
    const constructors = new Map(signature.enums.flatMap((enumeration) => enumeration.constructors.map((name) => [name, enumeration] as const)));
    const units = new Map(signature.units.map((unit) => [unit.name, unit]));
    const result = ok(Object.freeze({ symbol: (name: string) => symbols.get(name), enumeration: (name: string) => constructors.get(name), unit: (name: string | undefined) => name === undefined ? undefined : units.get(name) }));
    if (this.immutable.accepts(signature)) this.indexes.set(signature, result);
    return result;
  }
}

/** Structural sort identity over decoded scalar sorts; enums compare declared identities.
 * @returns Whether the sorts match. No mutation, I/O, or expected failure.
 * @example sameSort("Int", "Real"); // false
 */
export function sameSort(a: ExpressionSort, b: ExpressionSort): boolean {
  return typeof a === "string" || typeof b === "string" ? a === b : a.enum === b.enum;
}

/** Check a structurally decoded signature before symbol resolution.
 * @returns Undefined on success, otherwise a declaration/sort/unit collision reason.
 * @remarks Linear collection traversal with bounded exact scale arithmetic; input is unchanged.
 * Does not decode arbitrary JSON shapes. No expected exceptions or I/O.
 * @example const issue = validateSignature(signature);
 */
export function validateSignature(signature: ExpressionSignature): string | undefined {
  const seen = new Set<string>();
  const enumNames = new Set<string>();
  const unitNames = new Set<string>();
  for (const unit of signature.units) {
    if (!unit.name || !unit.dimension || unitNames.has(unit.name) || !scaleRatio(unit.scale, unit.scale).ok) return "Invalid or duplicate unit definition";
    unitNames.add(unit.name);
  }
  for (const declaration of signature.enums) {
    if (!declaration.name || enumNames.has(declaration.name) || declaration.constructors.length === 0) return "Invalid or duplicate enum definition";
    enumNames.add(declaration.name);
    for (const constructor of declaration.constructors) {
      if (!constructor || seen.has(constructor) || RESERVED.has(constructor)) return "Invalid or colliding enum constructor";
      seen.add(constructor);
    }
  }
  const validSort = (sort: ExpressionSort): boolean => typeof sort === "string" ? ["Bool", "Int", "Real"].includes(sort) : enumNames.has(sort.enum);
  for (const symbol of signature.symbols) {
    if (!symbol.name || seen.has(symbol.name) || RESERVED.has(symbol.name) || !validSort(symbol.sort)
      || symbol.args?.some((sort) => !validSort(sort)) || (symbol.unit !== undefined && !unitNames.has(symbol.unit))
      || (symbol.argUnits !== undefined && symbol.argUnits.length !== symbol.args?.length)
      || symbol.argUnits?.some((unit) => unit !== undefined && !unitNames.has(unit))) return "Invalid, shadowing, or incompatible symbol signature";
    if (symbol.unit !== undefined && symbol.sort !== "Int" && symbol.sort !== "Real") return "Only numeric values carry quantity units";
    if (symbol.argUnits?.some((unit, index) => unit !== undefined && symbol.args?.[index] !== "Int" && symbol.args?.[index] !== "Real")) return "Only numeric function arguments carry quantity units";
    seen.add(symbol.name);
  }
  return undefined;
}

/** Bounded recursion mirrors parser depth (128 by default), never unbounded syntax. */
function check(node: ExpressionSyntax, signature: SignatureIndexes, depth: number, maxDepth: number): Result<LogicExpression, ExpressionIssue> {
  const fail = (message: string): Result<LogicExpression, ExpressionIssue> => err({ code: "expression-type", message, offset: node.offset });
  if (depth > maxDepth) return fail("Expression typing depth exceeded");
  if (node.kind === "string") return fail("String theory is unsupported; literal contents are not rewritten");
  if (node.kind === "atom" || node.kind === "quoted-symbol") {
    if (node.kind === "atom" && (node.text === "true" || node.text === "false")) return ok(Object.freeze({ kind: "bool", value: node.text === "true", sort: "Bool" }));
    if (node.kind === "atom" && /^-?\d/u.test(node.text)) {
      const literal = numericAtom(node.text);
      return literal.ok ? ok(Object.freeze({ kind: "number", ...literal.value })) : fail(literal.error);
    }
    const symbol = signature.symbol(node.text);
    if (symbol !== undefined && (symbol.args === undefined || symbol.args.length === 0)) return ok(Object.freeze({ kind: "symbol", name: symbol.name, sort: freezeSort(symbol.sort), ...(symbol.unit === undefined ? {} : { unit: symbol.unit }) }));
    const enumeration = signature.enumeration(node.text);
    if (enumeration !== undefined) return ok(Object.freeze({ kind: "enum", name: node.text, enumName: enumeration.name, sort: Object.freeze({ enum: enumeration.name }) }));
    return fail(`Undeclared symbol or nonconstant function: ${node.text}`);
  }
  const head = node.items[0];
  if (head?.kind !== "atom" && head?.kind !== "quoted-symbol") return fail("Application head must be a declared function or supported operator");
  if (head.text === "quantity" || head.text === "convert") return checkQuantity(node, signature, depth, maxDepth);
  const args: LogicExpression[] = [];
  for (const child of node.items.slice(1)) {
    const value = check(child, signature, depth + 1, maxDepth);
    if (!value.ok) return value;
    args.push(value.value);
  }
  const [n, d] = args;
  if (head.text === "/" && args.length === 2 && n?.kind === "number" && d?.kind === "number" && n.sort === "Int" && d.sort === "Int" && n.unit === undefined && d.unit === undefined) {
    const value = rational(n.value.numerator, d.value.numerator);
    return value.ok ? ok(Object.freeze({ kind: "number", value: value.value, sort: "Real" })) : fail(value.error);
  }
  if (OPERATORS.has(head.text)) return checkOperator(head.text as ExpressionOperator, args, node.offset);
  const fn = signature.symbol(head.text);
  const fnArgs = fn?.args;
  if (fn === undefined || fnArgs === undefined || fnArgs.length !== args.length) return fail(`Unknown operator or wrong function arity: ${head.text}`);
  if (args.some((arg, i) => {
    const expected = fnArgs[i];
    return expected === undefined || !sameSort(arg.sort, expected) || arg.unit !== fn.argUnits?.[i];
  })) return fail(`Function argument sort/unit mismatch: ${head.text}`);
  return ok(Object.freeze({ kind: "apply", name: fn.name, args: Object.freeze(args), sort: freezeSort(fn.sort), ...(fn.unit === undefined ? {} : { unit: fn.unit }) }));
}

/** Enforce operator arities, sorts, dimensions, and the linear multiplication fragment. */
function checkOperator(op: ExpressionOperator, args: readonly LogicExpression[], offset: number): Result<LogicExpression, ExpressionIssue> {
  const fail = (message: string): Result<LogicExpression, ExpressionIssue> => err({ code: "expression-type", message, offset });
  const a = args[0];
  let sort: ExpressionSort = "Bool";
  let unit: string | undefined;
  if (["not", "and", "or", "=>"].includes(op)) {
    if ((op === "not" && args.length !== 1) || (op === "=>" && args.length !== 2) || args.some((arg) => arg.sort !== "Bool")) return fail("Boolean operator arity/sort mismatch");
  } else if (op === "ite") {
    if (args.length !== 3 || a?.sort !== "Bool" || !sameSort(args[1]!.sort, args[2]!.sort) || args[1]!.unit !== args[2]!.unit) return fail("ite requires Bool condition and equal branch sorts/units");
    sort = args[1]!.sort; unit = args[1]!.unit;
  } else if (op === "to_real") {
    if (args.length !== 1 || a?.sort !== "Int") return fail("to_real requires one Int operand");
    sort = "Real"; unit = a.unit;
  } else {
    if (a === undefined || (op === "-" ? args.length < 1 : args.length < 2)) return fail("Operator requires operands");
    if (args.some((arg) => !sameSort(arg.sort, a.sort))) return fail("Operand sorts must match; coercions must be explicit");
    if (!["=", "distinct"].includes(op) && a.sort !== "Int" && a.sort !== "Real") return fail("Numeric operator requires numeric operands");
    if (op === "*") {
      if (args.length !== 2 || args.filter((arg) => !numericConstant(arg)).length > 1 || args.filter((arg) => arg.unit !== undefined).length > 1) return fail("Only linear scalar multiplication is supported");
      unit = args.find((arg) => arg.unit !== undefined)?.unit;
    } else {
      if (args.some((arg) => arg.unit !== a.unit)) return fail("Operand units must match; use explicit quantity/convert annotations");
      unit = a.unit;
    }
    if (["+", "-", "*"].includes(op)) sort = a.sort;
    else unit = undefined;
  }
  return ok(Object.freeze({ kind: "operator", op, args: Object.freeze([...args]), sort, ...(unit === undefined ? {} : { unit }) }));
}

/** Syntactic numeric constants include only pure constant arithmetic, never UF calls.
 * @remarks Input comes from bounded expression validation (depth at most the effective
 * expression limit). Recursion follows only accepted child nodes and has no effects.
 */
function numericConstant(node: LogicExpression): boolean {
  return node.kind === "number" || (node.kind === "operator" && ["+", "-", "*", "to_real"].includes(node.op) && node.args.every(numericConstant));
}

/** Copy enum sort identity so accepted nodes do not alias mutable caller metadata. */
function freezeSort(sort: ExpressionSort): ExpressionSort { return typeof sort === "string" ? sort : Object.freeze({ enum: sort.enum }); }

/** Explicit non-SMT unit annotations lower to exact linear scalar expressions. */
function checkQuantity(node: Extract<ExpressionSyntax, { kind: "list" }>, signature: SignatureIndexes, depth: number, maxDepth: number): Result<LogicExpression, ExpressionIssue> {
  const fail = (message: string): Result<LogicExpression, ExpressionIssue> => err({ code: "expression-unit", message, offset: node.offset });
  const [head, valueNode, unitNode] = node.items;
  if (node.items.length !== 3 || head?.kind !== "atom" || valueNode === undefined || unitNode?.kind !== "atom") return fail("quantity/convert require a value and explicit unit name");
  const target = signature.unit(unitNode.text);
  if (target === undefined) return fail("Unknown unit");
  const checked = check(valueNode, signature, depth + 1, maxDepth);
  if (!checked.ok) return checked;
  const value = checked.value;
  if (head.text === "quantity") {
    if (!numericConstant(value) || value.unit !== undefined) return fail("quantity annotates only a dimensionless numeric constant");
    return ok(Object.freeze({ ...value, unit: target.name }));
  }
  const from = signature.unit(value.unit);
  if (from === undefined || from.dimension !== target.dimension) return fail("Conversion requires explicit same-dimension source and target units");
  const factor = scaleRatio(from.scale, target.scale);
  if (!factor.ok) return fail(factor.error);
  const promote = value.sort === "Int" && factor.value.denominator !== "1";
  const scalar: LogicExpression = promote ? Object.freeze({ kind: "operator", op: "to_real", args: Object.freeze([value]), sort: "Real", unit: from.name }) : value;
  const sort = scalar.sort;
  if (sort !== "Int" && sort !== "Real") return fail("Conversion requires a numeric value");
  const coefficient: LogicExpression = Object.freeze({ kind: "number", value: factor.value, sort });
  return ok(Object.freeze({ kind: "operator", op: "*", args: Object.freeze([scalar, coefficient]), sort, unit: target.name }));
}
