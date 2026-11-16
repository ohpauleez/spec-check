/** Typed scalar expression and static-behavior contracts, separate from source syntax. */
import type { SourceReference } from "../model.js";

/** Closed first-delivery sort universe; enum identities are explicit declarations. */
export type ExpressionSort = "Bool" | "Int" | "Real" | { readonly enum: string };

/** Exact reduced rational with a positive denominator, serialized without rounding. */
export interface Rational {
  readonly numerator: string;
  readonly denominator: string;
}

/** Explicit unit identity and authored exact scale to its dimension's base unit. */
export interface UnitDefinition {
  readonly name: string;
  readonly dimension: string;
  readonly scale: Rational;
}

/** Scoped concept constant or function signature supplied by the frozen registry. */
export interface ExpressionSymbol {
  readonly name: string;
  readonly sort: ExpressionSort;
  readonly args?: readonly ExpressionSort[];
  readonly unit?: string;
  readonly argUnits?: readonly (string | undefined)[];
}

/** Frozen declaration context; duplicate identity resolution precedes expression work. */
export interface ExpressionSignature {
  readonly symbols: readonly ExpressionSymbol[];
  readonly enums: readonly { readonly name: string; readonly constructors: readonly string[] }[];
  readonly units: readonly UnitDefinition[];
}

/** Sort-checked expression metadata; a unit names an explicit signature definition. */
interface ExpressionType {
  readonly sort: ExpressionSort;
  readonly unit?: string;
}

/** Admitted SMT operators; custom unit annotations lower into these scalar nodes. */
export type ExpressionOperator = "not" | "and" | "or" | "=>" | "=" | "distinct" | "<" | "<=" | ">" | ">=" | "ite" | "+" | "-" | "*" | "to_real";

/** Immutable validated expression nodes; raw strings never represent accepted meaning. */
export type LogicExpression = ExpressionType & (
  | { readonly kind: "bool"; readonly value: boolean; readonly sort: "Bool" }
  | { readonly kind: "number"; readonly value: Rational; readonly sort: "Int" | "Real" }
  | { readonly kind: "symbol"; readonly name: string }
  | { readonly kind: "enum"; readonly name: string; readonly enumName: string }
  | { readonly kind: "apply"; readonly name: string; readonly args: readonly LogicExpression[] }
  | { readonly kind: "operator"; readonly op: ExpressionOperator; readonly args: readonly LogicExpression[] }
);

/** Source-owned static rule; modality is not an LLM-selected assertion severity. */
export interface StaticRule {
  readonly source: SourceReference;
  readonly claimId?: string;
  readonly kind: "mandatory" | "advisory" | "permission";
  readonly guard: LogicExpression;
  readonly response: LogicExpression;
  readonly interpretationDependent: boolean;
}

/** Concrete example queries never harden their input into a global requirement. */
export interface StaticScenario {
  readonly source: SourceReference;
  readonly kind: "example" | "prohibited-example";
  readonly input: LogicExpression;
  readonly outcome: LogicExpression;
}

/** Authored applicability domain and selected behavior-family guard references. */
export interface StaticCoverage {
  readonly name: string;
  readonly applicability: LogicExpression;
  readonly sources: readonly SourceReference[];
  readonly explicit: boolean;
}

/** Static semantic model; trace elements are deliberately absent from this contract. */
export interface StaticModel {
  readonly signature: ExpressionSignature;
  readonly background: readonly LogicExpression[];
  readonly rules: readonly StaticRule[];
  readonly scenarios: readonly StaticScenario[];
  readonly coverage: readonly StaticCoverage[];
}

/** Path-attributed boundary issue for parsing, resolution, typing or fragment limits. */
export interface ExpressionIssue {
  readonly code: string;
  readonly message: string;
  readonly offset?: number;
}

/** Named expression bounds, independent of physical formalization sub-batching. */
export interface ExpressionLimits {
  readonly bytes: number;
  readonly nodes: number;
  readonly depth: number;
}

/** Default conservative expression admission limits. */
export const EXPRESSION_LIMITS: ExpressionLimits = Object.freeze({ bytes: 65_536, nodes: 8_192, depth: 128 });
