/** Bounded lossless scalar witness decoding; exact numbers remain SMT value strings. */
import { parseExpressionSyntax, type ExpressionSyntax } from "./expression-parser.js";
import type { ExpressionSignature, ExpressionSymbol } from "./expression-types.js";
import { expressionSymbolName, enumConstructorName } from "./signature.js";
import { ImmutableObjects } from "./immutable.js";
import { locateSolverVerdict } from "./solver-verdict.js";

/** Completeness refers only to the explicitly requested scalar symbols. */
export interface DecodedModelValues {
  readonly status: "complete" | "partial" | "unavailable";
  readonly assignments: Readonly<Record<string, string>> | null;
  readonly missing: readonly string[];
}

/** Decode one SAT response without floating-point conversion or fabricated fields.
 * @returns All scalar assignments, or undefined for unavailable/partial/malformed output.
 * @remarks Signature must be decoded. Parsing is bounded; raw text and input remain unchanged.
 * Use decodeResult when partial scope must remain visible. No I/O or expected exceptions.
 * @example decodeModelValues("sat\n((vx true))\n", signature);
 */
export function decodeModelValues(stdout: string, signature: ExpressionSignature): Readonly<Record<string, string>> | undefined {
  return new ModelValueDecoder().decode(stdout, signature);
}

/** Private run-scoped witness-name indexes; mutable signatures bypass caching.
 * @example const decoder = new ModelValueDecoder(); decoder.decodeResult(stdout, signature);
 */
export class ModelValueDecoder {
  private readonly immutable = new ImmutableObjects();
  private readonly indexes = new WeakMap<ExpressionSignature, ReadonlyMap<string, ExpressionSymbol>>();

  /** Compatibility projection of decodeResult: only complete scalar scope yields assignments.
   * @remarks No I/O/mutation or expected throws; exact numeric lexemes are retained.
   * @example decoder.decode(stdout, signature);
   */
  decode(stdout: string, signature: ExpressionSignature): Readonly<Record<string, string>> | undefined {
    const decoded = this.decodeResult(stdout, signature);
    return decoded.status === "complete" ? decoded.assignments ?? undefined : undefined;
  }

  /** Validate one SAT value-list against requested emitted scalar names.
   * @returns Complete/partial/unavailable scope, exact assignments and missing source names.
   * @remarks Expected defaults to all scalar signature entries. Duplicates, wrong sorts, absent
   * or non-SAT verdicts reject decoding, not the primary solver result. Bounded syntax parsing;
   * no I/O, mutation, or expected exceptions. Request arrays are not retained or altered.
   * @example decoder.decodeResult(stdout, signature, ["vx"]);
   */
  decodeResult(stdout: string, signature: ExpressionSignature, expected?: readonly string[]): DecodedModelValues {
    const unavailable = (): DecodedModelValues => ({ status: "unavailable", assignments: null, missing: [] });
    const verdict = locateSolverVerdict(stdout);
    if (verdict?.kind !== "sat") return unavailable();
    const afterSat = stdout.slice(verdict.end).trim();
    const parsed = parseExpressionSyntax(afterSat);
    if (!parsed.ok || parsed.value.kind !== "list") return unavailable();
    let names = this.indexes.get(signature);
    if (names === undefined) {
      names = new Map(signature.symbols.filter((symbol) => symbol.args === undefined || symbol.args.length === 0).map((symbol) => [expressionSymbolName(symbol.name), symbol]));
      if (this.immutable.accepts(signature)) this.indexes.set(signature, names);
    }
    const requested = new Set(expected ?? names.keys());
    if (requested.size !== (expected?.length ?? names.size) || [...requested].some((name) => !names.has(name))) return unavailable();
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    const seen = new Set<string>();
    for (const pair of parsed.value.items) {
      if (pair.kind !== "list" || pair.items.length !== 2 || pair.items[0]?.kind !== "atom") return unavailable();
      const key = pair.items[0].text;
      const symbol = names.get(key);
      if (symbol === undefined || !requested.has(key) || seen.has(key) || !scalarValue(pair.items[1]!, symbol, signature)) return unavailable();
      seen.add(key);
      values[symbol.name] = rawValue(pair.items[1]!);
    }
    const missing = [...requested].filter((name) => !seen.has(name)).map((name) => names!.get(name)!.name);
    return Object.freeze({ status: missing.length === 0 ? "complete" : "partial", assignments: Object.freeze(values), missing: Object.freeze(missing) });
  }
}

/** Only exact scalar solver values, not arbitrary terms, qualify as decoded assignments. */
function scalarValue(node: ExpressionSyntax, symbol: ExpressionSymbol, signature: ExpressionSignature): boolean {
  if (symbol.sort === "Bool") return node.kind === "atom" && ["true", "false"].includes(node.text);
  if (typeof symbol.sort === "object") {
    const enumeration = signature.enums.find((item) => item.name === (symbol.sort as { enum: string }).enum);
    return node.kind === "atom" && (enumeration?.constructors.some((name) => enumConstructorName(enumeration.name, name) === node.text) ?? false);
  }
  const integer = (value: ExpressionSyntax): boolean => value.kind === "atom" && /^\d+$/u.test(value.text);
  const numeric = (value: ExpressionSyntax): boolean => {
    if (integer(value)) return true;
    if (value.kind === "atom") return symbol.sort === "Real" && /^\d+\.\d+$/u.test(value.text);
    if (value.kind !== "list" || value.items[0]?.kind !== "atom") return false;
    if (value.items[0].text === "-" && value.items.length === 2) {
      const child = value.items[1]!;
      return child.kind === "atom" ? numeric(child) : child.kind === "list" && child.items[0]?.kind === "atom" && child.items[0].text === "/" && numeric(child);
    }
    return symbol.sort === "Real" && value.items[0].text === "/" && value.items.length === 3
      && value.items.slice(1).every((part) => part.kind === "atom" && /^\d+(?:\.\d+)?$/u.test(part.text))
      && /[1-9]/u.test((value.items[2] as { text: string }).text);
  };
  return numeric(node);
}

/** Reconstruct scalar syntax, not application identifiers or commands.
 * @remarks Input is a finite syntax tree admitted by the bounded parser; recursion cannot
 * exceed its depth limit. No I/O, mutation or expected failure; exact literal text is retained.
 */
function rawValue(node: ExpressionSyntax): string {
  if (node.kind === "list") return `(${node.items.map(rawValue).join(" ")})`;
  if (node.kind === "string") return `"${node.text.replace(/"/gu, '""')}"`;
  if (node.kind === "quoted-symbol") return `|${node.text}|`;
  return node.text;
}
