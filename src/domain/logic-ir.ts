import type { ClaimId } from "./branded.js";

/**
 * Closed domain of SMT-LIB–compatible sort identifiers for logic IR expressions.
 *
 * @remarks
 * - `"Bool"` — Boolean sort.
 * - `"Int"` — unbounded integer sort.
 * - `"Real"` — real number sort.
 * - `"String"` — string sort.
 */
export type LogicSort = "Bool" | "Int" | "Real" | "String";

/**
 * A typed variable (constant) declaration for use in SMT-LIB assertions.
 *
 * @remarks
 * Invariant: `name` is a non-empty identifier unique within the containing {@link LogicIrClaim}.
 * Each variable is compiled to `(declare-const <name> <sort>)` in SMT-LIB.
 */
export interface LogicVariableDeclaration {
  readonly name: string;
  readonly sort: LogicSort;
}

/**
 * @deprecated Use {@link LogicVariableDeclaration} instead.
 */
export type LogicSortDeclaration = LogicVariableDeclaration;

/**
 * An uninterpreted function symbol with typed argument list and return sort.
 *
 * @remarks
 * Invariant: `name` is a non-empty identifier unique within the containing {@link LogicIrClaim}.
 * Invariant: `args` may be empty (constant symbol) but is never undefined.
 */
export interface LogicFunctionSymbol {
  readonly name: string;
  readonly args: readonly LogicSort[];
  readonly returns: LogicSort;
}

/**
 * A single logical assertion expressed as an SMT-LIB–style string expression.
 *
 * @remarks
 * Invariant: `id` is a non-empty unique identifier within the containing claim.
 * Invariant: `expr` is a syntactically valid SMT-LIB expression string.
 */
export interface LogicAssertion {
  readonly id: string;
  readonly expr: string;
}

/**
 * Closed domain of obligation levels for logic IR claims, mirroring {@link ObligationLevel}.
 *
 * @remarks
 * - `"mandatory"` — violation produces an error-level finding.
 * - `"advisory"` — violation produces a warning-level finding.
 * - `"informational"` — for tracking only; no finding on violation.
 */
export type LogicObligation = "mandatory" | "advisory" | "informational";

/**
 * A single claim translated into logic IR form for formal analysis.
 *
 * @remarks
 * Invariant: `claimId` references an existing claim in the claim graph.
 * Invariant: all variable names referenced in `functions` and `assertions` are declared in `variables`.
 */
export interface LogicIrClaim {
  readonly claimId: ClaimId;
  readonly obligation: LogicObligation;
  readonly variables: readonly LogicVariableDeclaration[];
  readonly functions: readonly LogicFunctionSymbol[];
  readonly assertions: readonly LogicAssertion[];
}
