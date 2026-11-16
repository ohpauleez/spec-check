/** Canonical renderer for validated bounded expressions; no literal token rewriting. */
import type { LogicExpression } from "./expression-types.js";
import { enumConstructorName, expressionSymbolName } from "./signature.js";
import { ImmutableObjects } from "./immutable.js";

const EXPRESSION_RENDER_CACHE_BYTES_MAX = 8_388_608;

/** Bounded run/work-unit cache of requested roots, not every overlapping subtree string.
 * @example const renderer = new ExpressionRenderer(); renderer.render(checkedNode);
 */
export class ExpressionRenderer {
  private readonly immutable = new ImmutableObjects();
  private cache = new WeakMap<LogicExpression, string>();
  private bytes = 0;
  /** Set a byte retention ceiling; callers provide a nonnegative finite capacity.
   * No I/O; cache eviction only affects performance, never output semantics.
   */
  constructor(private readonly maxBytes = EXPRESSION_RENDER_CACHE_BYTES_MAX) {}

  /** Render a validated bounded node; nested mutable data never receives a cached answer.
   * @returns Canonical SMT text. Inputs are unchanged, strings are capped per cache instance.
   * @remarks Caller owns invocation sequencing. No expected failures; malformed/cyclic
   * unvalidated graphs violate the renderer precondition.
   * @example renderer.render(expression);
   */
  render(node: LogicExpression): string {
    const cached = this.cache.get(node);
    if (cached !== undefined) return cached;
    const rendered = renderExpression(node);
    const bytes = Buffer.byteLength(rendered, "utf8");
    if (bytes <= this.maxBytes && this.immutable.accepts(node)) {
      if (this.bytes + bytes > this.maxBytes) { this.cache = new WeakMap(); this.bytes = 0; }
      this.cache.set(node, rendered); this.bytes += bytes;
    }
    return rendered;
  }
}

/**
 * Render a validated AST. Recursion is bounded by expression admission depth.
 * Units have already been checked/lowered into exact scalar conversions; they
 * remain semantic evidence on the AST rather than hidden solver assumptions.
 * @returns A canonical expression without solver commands or declarations.
 * @remarks Input must be an admitted, acyclic, bounded-depth AST; no expected exceptions,
 * I/O or mutation. Raw strings/unknown JSON are not accepted validation substitutes.
 * @example renderExpression(checked.value);
 */
export function renderExpression(node: LogicExpression): string {
  switch (node.kind) {
    case "bool": return node.value ? "true" : "false";
    case "number": {
      const negative = node.value.numerator.startsWith("-");
      const magnitude = negative ? node.value.numerator.slice(1) : node.value.numerator;
      const value = node.sort === "Int" ? magnitude : `(/ ${magnitude} ${node.value.denominator})`;
      return negative ? `(- ${value})` : value;
    }
    case "symbol": return expressionSymbolName(node.name);
    case "enum": return enumConstructorName(node.enumName, node.name);
    case "apply": return node.args.length === 0 ? expressionSymbolName(node.name) : `(${expressionSymbolName(node.name)} ${node.args.map(renderExpression).join(" ")})`;
    case "operator": return `(${node.op}${node.args.length > 0 ? " " : ""}${node.args.map(renderExpression).join(" ")})`;
  }
}
