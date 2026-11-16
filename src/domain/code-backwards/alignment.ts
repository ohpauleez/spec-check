/** Post-derivation checked identity alignment; independent source registries never mutate. */
import type { FrozenRegistry, RegistryConcept } from "../formal/concepts.js";
import type { ExpressionSignature, ExpressionSort, LogicExpression } from "../formal/expression-types.js";
import { sameSort } from "../formal/expressions.js";
import { mergeExpressionSignatures } from "../formal/signature.js";
import { rational } from "../formal/rational.js";
import { ImmutableObjects } from "../formal/immutable.js";
import type { ExpressionSymbol } from "../formal/expression-types.js";
import { invariant } from "../assert.js";

/** Identity map and explicit unresolved/incompatible scope, persisted before comparison. */
export interface RegistryAlignment {
  readonly status: "aligned" | "unmapped" | "incompatible";
  readonly pairs: readonly { readonly original: string; readonly generated: string; readonly joint: string }[];
  readonly issues: readonly string[];
  readonly signature: ExpressionSignature;
  readonly originalNames: ReadonlyMap<string, string>;
  readonly generatedNames: ReadonlyMap<string, string>;
}

/** Propose checked joint identities after both independently derived registries freeze.
 * @returns Aligned/unmapped/incompatible scope, ordered pairs, issues and a checked joint signature.
 * @remarks Inputs must be decoded registries; no mutation or I/O. Matching is trimmed lowercase
 * definition text plus role/sort/unit checks, not semantic proof. Ambiguity stays explicit.
 * Work is bounded by registry limits. No expected exceptions for admitted registries.
 * @example const alignment = alignRegistries(originalRegistry, generatedRegistry);
 */
export function alignRegistries(original: FrozenRegistry, generated: FrozenRegistry): RegistryAlignment {
  const pairs: RegistryAlignment["pairs"][number][] = [];
  const issues: string[] = [];
  if (original.unresolved.length > 0 || generated.unresolved.length > 0 || original.issues.length > 0 || generated.issues.length > 0 || original.sourceScope.excluded > 0 || generated.sourceScope.excluded > 0) issues.push("Registry discovery/identity/source scope is qualified or unresolved");
  const originalNames = new Map<string, string>();
  const generatedNames = new Map<string, string>();
  const symbols: ExpressionSignature["symbols"][number][] = [];
  const definitions = new Map<string, RegistryConcept[]>();
  for (const candidate of generated.concepts) {
    const key = candidate.definition.trim().toLowerCase();
    const matches = definitions.get(key) ?? []; matches.push(candidate); definitions.set(key, matches);
  }
  let incompatible = false;
  for (const concept of original.concepts) {
    const matches = definitions.get(concept.definition.trim().toLowerCase()) ?? [];
    if (matches.length !== 1 || generatedNames.has(matches[0]?.name ?? "")) { issues.push(`Unmapped/ambiguous original concept: ${concept.name}`); continue; }
    const candidate = matches[0]!;
    if (!compatibleConcepts(concept, candidate, original.signature, generated.signature)) {
      incompatible = true; issues.push(`Incompatible role/sort/unit/signature: ${concept.name} / ${candidate.name}`); continue;
    }
    const joint = `Joint${pairs.length}`;
    pairs.push(Object.freeze({ original: concept.name, generated: candidate.name, joint }));
    originalNames.set(concept.name, joint); generatedNames.set(candidate.name, joint);
    symbols.push({ name: joint, sort: concept.sort, ...(concept.args === undefined ? {} : { args: concept.args }),
      ...(concept.unit === undefined ? {} : { unit: concept.unit }), ...(concept.argUnits === undefined ? {} : { argUnits: concept.argUnits }) });
  }
  for (const concept of generated.concepts) if (!generatedNames.has(concept.name)) issues.push(`Unmapped generated concept: ${concept.name}`);
  const joint = mergeExpressionSignatures([{ symbols, enums: original.signature.enums, units: original.signature.units }]);
  if (!joint.ok) { incompatible = true; issues.push(joint.error); }
  return Object.freeze({ status: incompatible ? "incompatible" : issues.length > 0 ? "unmapped" : "aligned", pairs: Object.freeze(pairs), issues: Object.freeze(issues),
    signature: joint.ok ? joint.value : { symbols: [], enums: [], units: [] }, originalNames, generatedNames });
}

/** Rebind only checked identities without dropping unsupported children.
 * @returns Renamed immutable expression, or undefined if any source identity is unmapped.
 * @throws Invariant error if a supplied joint name is absent from the joint signature.
 * @remarks Input is a bounded validated AST; every mapped target must exist in the checked
 * joint signature. Name maps are read live, not cached snapshots; caller owns sequencing.
 * No I/O or source mutation. Recursion follows the admitted expression-depth bound.
 * @example renameExpression(expression, alignment.originalNames, originalSignature, alignment.signature);
 */
export function renameExpression(expression: LogicExpression, names: ReadonlyMap<string, string>, source: ExpressionSignature, joint: ExpressionSignature, preparation = new AlignmentPreparation()): LogicExpression | undefined {
  if (expression.kind === "symbol" || expression.kind === "apply") {
    const name = names.get(expression.name);
    if (name === undefined) return undefined;
    const symbol = preparation.symbol(joint, name);
    invariant(symbol !== undefined, "Joint signature contains every aligned name");
    if (expression.kind === "symbol") return Object.freeze({ ...expression, name, sort: symbol.sort, ...(symbol.unit === undefined ? {} : { unit: symbol.unit }) });
    const args = expression.args.map((arg) => renameExpression(arg, names, source, joint, preparation));
    if (args.some((arg) => arg === undefined)) return undefined;
    return Object.freeze({ ...expression, name, args: Object.freeze(args as LogicExpression[]), sort: symbol.sort, ...(symbol.unit === undefined ? {} : { unit: symbol.unit }) });
  }
  if (expression.kind === "operator") {
    const args = expression.args.map((arg) => renameExpression(arg, names, source, joint, preparation));
    if (args.some((arg) => arg === undefined)) return undefined;
    return Object.freeze({ ...expression, args: Object.freeze(args as LogicExpression[]) });
  }
  return expression;
}

/** Index only immutable joint signatures; name maps remain live, not cached snapshots.
 * @example const preparation = new AlignmentPreparation(); preparation.symbol(jointSignature, "Joint0");
 */
export class AlignmentPreparation {
  private readonly immutable = new ImmutableObjects();
  private readonly signatures = new WeakMap<ExpressionSignature, ReadonlyMap<string, ExpressionSymbol>>();
  /** Look up the first declaration of a name in a decoded joint signature.
   * @returns Symbol or ordinary lookup absence; no I/O, mutation or expected throw.
   * @remarks Only deeply immutable signatures are cached. Callers enforce the joint-name invariant.
   * @example preparation.symbol(alignment.signature, "Joint0");
   */
  symbol(signature: ExpressionSignature, name: string): ExpressionSymbol | undefined {
    let symbols = this.signatures.get(signature);
    if (symbols === undefined) {
      const first = new Map<string, ExpressionSymbol>();
      for (const symbol of signature.symbols) if (!first.has(symbol.name)) first.set(symbol.name, symbol);
      symbols = first;
      if (this.immutable.accepts(signature)) this.signatures.set(signature, symbols);
    }
    return symbols.get(name);
  }
}

/** Exact quantity representations only; differing integer lattices are not silently equated. */
function compatibleConcepts(a: RegistryConcept, b: RegistryConcept, original: ExpressionSignature, generated: ExpressionSignature): boolean {
  if (a.role !== b.role || !compatibleSort(a.sort, b.sort, original, generated) || (a.args === undefined) !== (b.args === undefined) || (a.args?.length ?? 0) !== (b.args?.length ?? 0)) return false;
  if ((a.args ?? []).some((sort, index) => !compatibleSort(sort, b.args![index]!, original, generated))) return false;
  if (!compatibleUnit(a.unit, b.unit, original, generated)) return false;
  return (a.args ?? []).every((_, index) => compatibleUnit(a.argUnits?.[index], b.argUnits?.[index], original, generated));
}

/** Enum identity requires the same explicit universe, not merely a matching sort name. */
function compatibleSort(a: ExpressionSort, b: ExpressionSort, original: ExpressionSignature, generated: ExpressionSignature): boolean {
  if (!sameSort(a, b)) return false;
  if (typeof a === "string" || typeof b === "string") return true;
  const left = original.enums.find((item) => item.name === a.enum)?.constructors;
  const right = generated.enums.find((item) => item.name === b.enum)?.constructors;
  return left !== undefined && right !== undefined && left.length === right.length && left.every((name) => right.includes(name));
}

/** Unit names can differ only when exact dimension/scales coincide. */
function compatibleUnit(a: string | undefined, b: string | undefined, original: ExpressionSignature, generated: ExpressionSignature): boolean {
  if (a === undefined || b === undefined) return a === b;
  const left = original.units.find((entry) => entry.name === a);
  const right = generated.units.find((entry) => entry.name === b);
  if (left === undefined || right === undefined || left.dimension !== right.dimension) return false;
  const x = rational(left.scale.numerator, left.scale.denominator); const y = rational(right.scale.numerator, right.scale.denominator);
  return x.ok && y.ok && x.value.numerator === y.value.numerator && x.value.denominator === y.value.denominator;
}
