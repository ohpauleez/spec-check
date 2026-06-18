import type { LogicIrClaim, LogicSort } from "../logic-ir.js";
import { toClaimId } from "../branded.js";
import { err, ok, type Result } from "../result.js";

/**
 * Validation error returned when a formalization sample fails schema checks.
 *
 * @remarks
 * Invariant: `message` is always a non-empty, human-readable description of
 * the specific validation failure encountered.
 */
export interface SampleValidationError {
  readonly message: string;
}

/**
 * Validate a raw unknown value into a typed `LogicIrClaim`.
 *
 * @param sample - untrusted value (typically parsed from LLM JSON response)
 * @returns validated `LogicIrClaim` or a validation error describing the first failure
 *
 * @remarks
 * Precondition: `sample` is an arbitrary `unknown` value from an untrusted source.
 * Postcondition: on success, the returned `LogicIrClaim` has:
 *   - a non-empty `claimId`
 *   - a valid `obligation` ("mandatory" | "advisory" | "informational")
 *   - well-formed `variables` with known sort types
 *   - well-formed `functions` with declared-or-builtin arg/return sorts
 *   - well-formed `assertions` with balanced parentheses and uppercase IDs
 * Invariant: validation is deterministic and side-effect free.
 *
 * @example
 * ```ts
 * import { validateFormalizationSample } from "./validate.js";
 *
 * const result = validateFormalizationSample(jsonPayload);
 * if (result.ok) {
 *   // result.value is a valid LogicIrClaim
 * } else {
 *   // result.error.message describes the failure
 * }
 * ```
 */
export function validateFormalizationSample(sample: unknown): Result<LogicIrClaim, SampleValidationError> {
  if (typeof sample !== "object" || sample === null) {
    return err({ message: "formalization sample must be an object" });
  }

  const record = sample as {
    readonly claimId?: unknown;
    readonly obligation?: unknown;
    readonly sorts?: unknown;
    readonly variables?: unknown;
    readonly functions?: unknown;
    readonly assertions?: unknown;
  };

  if (typeof record.claimId !== "string" || record.claimId.length === 0) {
    return err({ message: "sample claimId must be a non-empty string" });
  }

  if (record.obligation !== "mandatory" && record.obligation !== "advisory" && record.obligation !== "informational") {
    return err({ message: "sample obligation must be mandatory, advisory, or informational" });
  }

  // Accept both "variables" (preferred) and "sorts" (legacy) field names.
  const variablesRaw = record.variables ?? record.sorts;

  if (!Array.isArray(variablesRaw) || !Array.isArray(record.functions) || !Array.isArray(record.assertions)) {
    return err({ message: "sample variables/functions/assertions must all be arrays" });
  }

  const variablesResult = validateVariables(variablesRaw);
  if (!variablesResult.ok) {
    return variablesResult;
  }

  const functionsResult = validateFunctions(record.functions, variablesResult.value.declaredVariableNames);
  if (!functionsResult.ok) {
    return functionsResult;
  }

  const assertionsResult = validateAssertions(record.assertions);
  if (!assertionsResult.ok) {
    return assertionsResult;
  }

  return ok({
    claimId: toClaimId(record.claimId),
    obligation: record.obligation,
    variables: variablesResult.value.variables,
    functions: functionsResult.value,
    assertions: assertionsResult.value,
  });
}

// ---------------------------------------------------------------------------
// Variable validation
// ---------------------------------------------------------------------------

/**
 * Validate the `variables` array of a formalization sample.
 *
 * @param entries - raw variable entries from untrusted input
 * @returns validated variables plus the set of declared variable names, or validation error
 *
 * @remarks
 * Precondition: `entries` is an array (caller validates this).
 * Postcondition: all returned variables have a string `name` and a valid `LogicSort`.
 * Postcondition: `declaredVariableNames` contains exactly the names from validated entries.
 */
function validateVariables(
  entries: readonly unknown[],
): Result<{ readonly variables: { name: string; sort: LogicSort }[]; readonly declaredVariableNames: ReadonlySet<string> }, SampleValidationError> {
  const declaredVariableNames = new Set<string>();
  const variables: { name: string; sort: LogicSort }[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      return err({ message: "variable entry must be object" });
    }
    const typed = entry as { readonly name?: unknown; readonly sort?: unknown };
    if (typeof typed.name !== "string" || !isLogicSort(typed.sort)) {
      return err({ message: "variable entry must include name and known sort" });
    }
    declaredVariableNames.add(typed.name);
    variables.push({ name: typed.name, sort: typed.sort });
  }

  return ok({ variables, declaredVariableNames });
}

// ---------------------------------------------------------------------------
// Function validation
// ---------------------------------------------------------------------------

/**
 * Validate the `functions` array and verify sort references.
 *
 * @param entries - raw function entries from untrusted input
 * @param declaredVariableNames - set of variable names declared in the sample's variables array
 * @returns validated function symbols or validation error
 *
 * @remarks
 * Precondition: `entries` is an array; `declaredVariableNames` contains all validated variable names.
 * Postcondition: all returned functions have valid names, arg sorts, and return sorts.
 * Postcondition: all referenced sorts are either built-in or declared in the sample.
 */
function validateFunctions(
  entries: readonly unknown[],
  declaredVariableNames: ReadonlySet<string>,
): Result<{ name: string; args: LogicSort[]; returns: LogicSort }[], SampleValidationError> {
  const functions: { name: string; args: LogicSort[]; returns: LogicSort }[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      return err({ message: "function entry must be object" });
    }
    const typed = entry as { readonly name?: unknown; readonly args?: unknown; readonly returns?: unknown };
    if (typeof typed.name !== "string" || !Array.isArray(typed.args) || !isLogicSort(typed.returns)) {
      return err({ message: "function entry malformed" });
    }
    const args: LogicSort[] = [];
    for (const arg of typed.args) {
      if (!isLogicSort(arg)) {
        return err({ message: "function arg sort must be known" });
      }
      args.push(arg);
    }
    functions.push({ name: typed.name, args, returns: typed.returns });
  }

  // Cross-reference: verify all function sorts are declared or built-in.
  for (const functionSymbol of functions) {
    for (const argSort of functionSymbol.args) {
      if (!usesDeclaredOrBuiltInSort(argSort, declaredVariableNames)) {
        return err({ message: `function ${functionSymbol.name} uses undeclared sort ${argSort}` });
      }
    }
    if (!usesDeclaredOrBuiltInSort(functionSymbol.returns, declaredVariableNames)) {
      return err({ message: `function ${functionSymbol.name} returns undeclared sort ${functionSymbol.returns}` });
    }
  }

  return ok(functions);
}

// ---------------------------------------------------------------------------
// Assertion validation
// ---------------------------------------------------------------------------

/**
 * Validate the `assertions` array of a formalization sample.
 *
 * @param entries - raw assertion entries from untrusted input
 * @returns validated assertions or validation error
 *
 * @remarks
 * Precondition: `entries` is an array (caller validates this).
 * Postcondition: all returned assertions have uppercase IDs and well-formed s-expressions.
 */
function validateAssertions(
  entries: readonly unknown[],
): Result<{ id: string; expr: string }[], SampleValidationError> {
  const assertions: { id: string; expr: string }[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      return err({ message: "assertion entry must be object" });
    }
    const typed = entry as { readonly id?: unknown; readonly expr?: unknown };
    if (typeof typed.id !== "string" || !/^[A-Z][A-Z0-9_-]*$/u.test(typed.id) || typeof typed.expr !== "string") {
      return err({ message: "assertion entry malformed" });
    }
    if (!isWellFormedAssertion(typed.expr)) {
      return err({ message: `assertion ${typed.id} is not well-formed` });
    }
    assertions.push({ id: typed.id, expr: typed.expr });
  }

  return ok(assertions);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard for the `LogicSort` string literal union.
 *
 * @param value - unknown value to test
 * @returns true when value is one of "Bool", "Int", "Real", "String"
 *
 * @remarks
 * Postcondition: when true, TypeScript narrows `value` to `LogicSort`.
 */
function isLogicSort(value: unknown): value is LogicSort {
  return value === "Bool" || value === "Int" || value === "Real" || value === "String";
}

/**
 * Check whether a sort is either a built-in SMT sort or one declared in the sample's variable array.
 *
 * @param sort - sort name to validate
 * @param declaredVariableNames - set of variable names declared in the current sample
 * @returns true when the sort is a recognized built-in or was declared in the sample
 *
 * @remarks
 * Precondition: `declaredVariableNames` must contain all names from the sample's `variables` array.
 * Postcondition: returns true only for sorts that will be available in the SMT solver context.
 */
function usesDeclaredOrBuiltInSort(sort: LogicSort, declaredVariableNames: ReadonlySet<string>): boolean {
  return sort === "Bool" || sort === "Int" || sort === "Real" || sort === "String" || declaredVariableNames.has(sort);
}

/**
 * Check that an s-expression string has balanced parentheses and is non-empty.
 *
 * @param expr - s-expression string to validate
 * @returns true when the expression is non-empty and has balanced parentheses
 *
 * @remarks
 * Postcondition: when true, `expr` has equal opening and closing parentheses
 * with no point where closing count exceeds opening count.
 */
function isWellFormedAssertion(expr: string): boolean {
  if (expr.trim().length === 0) {
    return false;
  }

  let balance = 0;
  for (const char of expr) {
    if (char === "(") {
      balance += 1;
    } else if (char === ")") {
      balance -= 1;
      if (balance < 0) {
        return false;
      }
    }
  }

  return balance === 0;
}
