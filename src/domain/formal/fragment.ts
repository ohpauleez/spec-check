/** Whole-query feature classification for the admitted scalar SMT fragment. */
import { err, ok, type Result } from "../result.js";
import { ExpressionValidationContext } from "./expressions.js";
import { ImmutableObjects } from "./immutable.js";
import { EXPRESSION_LIMITS, type ExpressionSignature, type ExpressionSort, type LogicExpression } from "./expression-types.js";

/** Explicit feature set; no unsupported or guessed SMT-LIB set-logic name is emitted. */
export interface SolverFragment {
  readonly mode: "static";
  readonly quantifierFree: true;
  readonly features: readonly ("bool" | "enum" | "linear-int" | "linear-real" | "uf")[];
}

/** Classify the combined signature/expressions and reject oversized query trees. */
export function classifyFragment(signature: ExpressionSignature, expressions: readonly LogicExpression[]): Result<SolverFragment, string> {
  return new FragmentClassifier().classify(signature, expressions);
}

type Feature = SolverFragment["features"][number];
interface Subtree { readonly nodes: number; readonly height: number; readonly features: readonly Feature[] }

/** Cache subtree summaries while counting every occurrence in each assembled query. */
export class FragmentClassifier {
  private readonly immutable = new ImmutableObjects();
  private readonly trees = new WeakMap<LogicExpression, Subtree>();
  private readonly signatures = new WeakMap<ExpressionSignature, readonly Feature[]>();
  constructor(private readonly validation = new ExpressionValidationContext()) {}

  classify(signature: ExpressionSignature, expressions: readonly LogicExpression[]): Result<SolverFragment, string> {
    const checked = this.validation.prepare(signature);
    if (!checked.ok) return checked;
    let signatureFeatures = this.signatures.get(signature);
    if (signatureFeatures === undefined) {
      const features = new Set<Feature>(["bool"]);
      for (const symbol of signature.symbols) {
        addSort(features, symbol.sort);
        if (symbol.args !== undefined) { features.add("uf"); for (const sort of symbol.args) addSort(features, sort); }
      }
      if (signature.enums.length > 0) features.add("enum");
      signatureFeatures = Object.freeze([...features]);
      if (this.immutable.accepts(signature)) this.signatures.set(signature, signatureFeatures);
    }
    const features = new Set(signatureFeatures);
    let nodes = 0;
    for (const expression of expressions) {
      const subtree = this.summarize(expression, 0);
      if (subtree === undefined || (nodes += subtree.nodes) > EXPRESSION_LIMITS.nodes || subtree.height > EXPRESSION_LIMITS.depth) return err("Assembled expression node/depth bound exceeded");
      for (const feature of subtree.features) features.add(feature);
    }
    return ok(Object.freeze({ mode: "static", quantifierFree: true, features: Object.freeze([...features].sort()) }));
  }

  private summarize(node: LogicExpression, depth: number): Subtree | undefined {
    if (depth > EXPRESSION_LIMITS.depth) return undefined;
    const cached = this.trees.get(node);
    if (cached !== undefined) return cached;
    const features = new Set<Feature>();
    addSort(features, node.sort);
    if (node.kind === "apply") features.add("uf");
    let nodes = 1; let height = 0;
    if (node.kind === "apply" || node.kind === "operator") for (const child of node.args) {
      const summary = this.summarize(child, depth + 1);
      if (summary === undefined || (nodes += summary.nodes) > EXPRESSION_LIMITS.nodes) return undefined;
      height = Math.max(height, summary.height + 1);
      for (const feature of summary.features) features.add(feature);
    }
    const summary = Object.freeze({ nodes, height, features: Object.freeze([...features]) });
    if (this.immutable.accepts(node)) this.trees.set(node, summary);
    return summary;
  }
}

function addSort(features: Set<Feature>, sort: ExpressionSort): void {
  if (sort === "Int") features.add("linear-int");
  else if (sort === "Real") features.add("linear-real");
  else if (typeof sort !== "string") features.add("enum");
}
