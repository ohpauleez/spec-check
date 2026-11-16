/** Checked shared signatures and canonical safe names for every typed query path. */
import { err, ok, type Result } from "../result.js";
import { sanitizeIdentifier } from "./identifiers.js";
import { sameSort, validateSignature, ExpressionValidationContext } from "./expressions.js";
import { ImmutableObjects } from "./immutable.js";
import { createHash } from "node:crypto";
import { rational } from "./rational.js";
import type { ExpressionSignature, ExpressionSort, ExpressionSymbol } from "./expression-types.js";

/** Encode a decoded source identity in the solver value namespace, injectively.
 * @returns Solver-safe name. Pure, no expected failures; names remain distinct from sorts/labels.
 * @example expressionSymbolName("count_value"); // vcount_00005Fvalue
 */
export function expressionSymbolName(name: string): string { return `v${sanitizeIdentifier(name)}`; }

/** Encode an enum identity in a separate sort namespace; no I/O or mutation.
 * @example enumSortName("Mode"); // eMode
 */
export function enumSortName(name: string): string { return `e${sanitizeIdentifier(name)}`; }

/** Include both sort and constructor identities to prevent datatype namespace collisions.
 * @returns Injectively encoded name; pure over decoded strings, no expected failure.
 * @example enumConstructorName("Mode", "Ready"); // kMode__Ready
 */
export function enumConstructorName(sort: string, name: string): string { return `k${sanitizeIdentifier(sort)}__${sanitizeIdentifier(name)}`; }

/** Render the closed decoded scalar sort universe without side effects or expected failure.
 * @example renderSort({ enum: "Mode" }); // eMode
 */
export function renderSort(sort: ExpressionSort): string { return typeof sort === "string" ? sort : enumSortName(sort.enum); }

/** Merge decoded signatures in stable source order and snapshot accepted declarations.
 * @returns Deeply immutable compatible signature or the first validation/identity conflict reason.
 * @remarks Does not mutate callers, infer aliases or authorize conflicting declarations.
 * Work is bounded by supplied declaration collections and exact-scale arithmetic limits.
 * No I/O or expected exceptions for decoded collection shapes.
 * @example mergeExpressionSignatures([left.signature, right.signature]);
 */
export function mergeExpressionSignatures(signatures: readonly ExpressionSignature[]): Result<ExpressionSignature, string> {
  const symbols = new Map<string, ExpressionSymbol>();
  const enums = new Map<string, ExpressionSignature["enums"][number]>();
  const units = new Map<string, ExpressionSignature["units"][number]>();
  for (const signature of signatures) {
    const invalid = validateSignature(signature);
    if (invalid !== undefined) return err(invalid);
    for (const declaration of signature.units) {
      const old = units.get(declaration.name);
      const scale = rational(declaration.scale.numerator, declaration.scale.denominator);
      if (!scale.ok) return scale;
      if (old !== undefined && (old.dimension !== declaration.dimension || old.scale.numerator !== scale.value.numerator || old.scale.denominator !== scale.value.denominator)) return err(`Incompatible unit: ${declaration.name}`);
      units.set(declaration.name, Object.freeze({ ...declaration, scale: scale.value }));
    }
    for (const declaration of signature.enums) {
      const old = enums.get(declaration.name);
      if (old !== undefined && (old.constructors.length !== declaration.constructors.length || old.constructors.some((name) => !declaration.constructors.includes(name)))) return err(`Incompatible enum: ${declaration.name}`);
      if (old === undefined) enums.set(declaration.name, Object.freeze({ ...declaration, constructors: Object.freeze([...declaration.constructors]) }));
    }
    for (const symbol of signature.symbols) {
      const old = symbols.get(symbol.name);
      if (old !== undefined && !compatibleSymbols(old, symbol)) return err(`Incompatible symbol: ${symbol.name}`);
      if (old === undefined) symbols.set(symbol.name, Object.freeze({ name: symbol.name, sort: freezeSort(symbol.sort),
        ...(symbol.unit === undefined ? {} : { unit: symbol.unit }),
        ...(symbol.args === undefined ? {} : { args: Object.freeze(symbol.args.map(freezeSort)) }),
        ...(symbol.argUnits === undefined ? {} : { argUnits: Object.freeze([...symbol.argUnits]) }),
      }));
    }
  }
  const result = Object.freeze({ symbols: Object.freeze([...symbols.values()]), enums: Object.freeze([...enums.values()]), units: Object.freeze([...units.values()]) });
  const invalid = validateSignature(result);
  return invalid === undefined ? ok(result) : err(invalid);
}

/** Deep-copy the only compound sort so frozen signatures cannot alias callers. */
function freezeSort(sort: ExpressionSort): ExpressionSort { return typeof sort === "string" ? sort : Object.freeze({ enum: sort.enum }); }

/** Match declaration kinds, argument order, exact sorts, and explicit quantity units. */
function compatibleSymbols(a: ExpressionSymbol, b: ExpressionSymbol): boolean {
  return sameSort(a.sort, b.sort) && a.unit === b.unit
    && (a.args === undefined) === (b.args === undefined)
    && (a.args?.length ?? 0) === (b.args?.length ?? 0)
    && (a.args ?? []).every((sort, i) => sameSort(sort, b.args![i]!) && a.argUnits?.[i] === b.argUnits?.[i]);
}

/** Emit checked datatype declarations before uses and each scoped symbol exactly once.
 * @returns Declaration text, or the signature validation failure; never emits solver commands.
 * @remarks Decoded inputs remain unchanged. Optional preparation is run-local and only caches
 * deeply immutable data. No I/O or expected throws.
 * @example renderExpressionSignature(signature, runPreparation);
 */
export function renderExpressionSignature(signature: ExpressionSignature, preparation = new SignaturePreparation()): Result<string, string> {
  return preparation.render(signature);
}

/** Run-local declaration/fingerprint preparation; unknown mutable inputs are rechecked.
 * @example const preparation = new SignaturePreparation(); preparation.render(signature);
 */
export class SignaturePreparation {
  readonly validation = new ExpressionValidationContext();
  private readonly immutable = new ImmutableObjects();
  private readonly declarations = new WeakMap<ExpressionSignature, string>();
  private readonly hashes = new WeakMap<ExpressionSignature, string>();

  /** Validate and render declarations, reusing only immutable-signature results.
   * @returns Canonical declarations or a validation error. Does not mutate signature or perform I/O.
   * @remarks Structurally decoded signatures are required; declaration order remains source order.
   * @example preparation.render(signature);
   */
  render(signature: ExpressionSignature): Result<string, string> {
    const cached = this.declarations.get(signature);
    if (cached !== undefined) return ok(cached);
    const checked = this.validation.prepare(signature);
    if (!checked.ok) return checked;
    const rendered = renderDeclarations(signature);
    if (this.immutable.accepts(signature)) this.declarations.set(signature, rendered);
    return ok(rendered);
  }

  /** Hash the exact existing JSON serialization lazily, without normalizing order/content.
   * @returns Lowercase SHA-256 digest; no expected failures for a decoded acyclic signature.
   * @remarks Deeply immutable inputs can reuse results. Unexpected serialization/crypto failures
   * propagate; this fingerprint does not itself establish signature validity.
   * @example preparation.fingerprint(signature);
   */
  fingerprint(signature: ExpressionSignature): string {
    const cached = this.hashes.get(signature);
    if (cached !== undefined) return cached;
    const hash = createHash("sha256").update(JSON.stringify(signature), "utf8").digest("hex");
    if (this.immutable.accepts(signature)) this.hashes.set(signature, hash);
    return hash;
  }
}

/** A validated single signature has unique identities; no merge/copy is needed to render it. */
function renderDeclarations(signature: ExpressionSignature): string {
  const lines: string[] = [];
  const mapping = (source: string, target: string): void => { lines.push(`; mapping ${JSON.stringify(source)} -> ${target}`); };
  for (const declaration of signature.enums) {
    mapping(declaration.name, enumSortName(declaration.name));
    for (const name of declaration.constructors) mapping(`${declaration.name}.${name}`, enumConstructorName(declaration.name, name));
  }
  for (const symbol of signature.symbols) mapping(symbol.name, expressionSymbolName(symbol.name));
  for (const declaration of signature.enums) lines.push(`(declare-datatype ${enumSortName(declaration.name)} (${declaration.constructors.map((name) => `(${enumConstructorName(declaration.name, name)})`).join(" ")}))`);
  for (const symbol of signature.symbols) lines.push(symbol.args === undefined
    ? `(declare-const ${expressionSymbolName(symbol.name)} ${renderSort(symbol.sort)})`
    : `(declare-fun ${expressionSymbolName(symbol.name)} (${symbol.args.map(renderSort).join(" ")}) ${renderSort(symbol.sort)})`);
  return lines.join("\n") + (lines.length === 0 ? "" : "\n");
}
