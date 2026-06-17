/**
 * Assertion utilities for runtime invariant enforcement.
 *
 * @remarks
 * These functions are for programmer errors and broken structural invariants,
 * not for expected domain failures (which use `Result<T, E>`).
 *
 * Per the style guide: "Use exceptions only for broken invariants, impossible
 * states, programmer errors, and infrastructure failures that are truly
 * exceptional at the current layer."
 *
 * Each assertion function throws an `Error` with a descriptive message that
 * identifies the assertion category (invariant, precondition, postcondition)
 * to aid debugging.
 */

/**
 * Assert that a precondition holds at a function boundary.
 *
 * @param condition - boolean expression that must be true for the function to proceed
 * @param message - description of the violated contract
 *
 * @throws {Error} Always throws when `condition` is false, indicating a caller
 *   violated the function's contract.
 *
 * @remarks
 * Precondition: none (this is the precondition checker itself).
 * Postcondition: when this function returns normally, `condition` is `true`
 * and TypeScript narrows the type accordingly.
 * Safety: assertions must be side-effect free.
 *
 * @example
 * ```ts
 * import { precondition } from "./assert.js";
 *
 * function divide(a: number, b: number): number {
 *   precondition(b !== 0, "divisor must be non-zero");
 *   return a / b;
 * }
 * ```
 */
export function precondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Precondition violated: ${message}`);
  }
}

/**
 * Assert that an invariant holds within a function or module.
 *
 * @param condition - boolean expression that must always be true
 * @param message - description of the violated invariant
 *
 * @throws {Error} Always throws when `condition` is false, indicating a
 *   structural invariant has been broken.
 *
 * @remarks
 * Precondition: none (this is the invariant checker itself).
 * Postcondition: when this function returns normally, `condition` is `true`
 * and TypeScript narrows the type accordingly.
 * Safety: assertions must be side-effect free.
 *
 * @example
 * ```ts
 * import { invariant } from "./assert.js";
 *
 * function appendOnly(prev: readonly string[], next: readonly string[]): readonly string[] {
 *   const result = [...prev, ...next];
 *   invariant(result.length === prev.length + next.length, "append-only length preservation");
 *   return result;
 * }
 * ```
 */
export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invariant violated: ${message}`);
  }
}

/**
 * Assert that a postcondition holds after a computation.
 *
 * @param condition - boolean expression that must be true for the output to be valid
 * @param message - description of the violated output guarantee
 *
 * @throws {Error} Always throws when `condition` is false, indicating the
 *   function failed to establish its output contract.
 *
 * @remarks
 * Precondition: the computation whose output is being validated has completed.
 * Postcondition: when this function returns normally, `condition` is `true`
 * and TypeScript narrows the type accordingly.
 * Safety: assertions must be side-effect free.
 *
 * @example
 * ```ts
 * import { postcondition } from "./assert.js";
 *
 * function clamp(value: number, min: number, max: number): number {
 *   const result = Math.min(Math.max(value, min), max);
 *   postcondition(result >= min && result <= max, "result is within bounds");
 *   return result;
 * }
 * ```
 */
export function postcondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Postcondition violated: ${message}`);
  }
}

/**
 * Exhaustiveness helper for closed discriminated unions.
 *
 * @param value - unexpected value; TypeScript narrows this to `never` when all
 *   union branches have been handled
 * @returns never — this function always throws
 *
 * @throws {Error} Always throws because reaching this code path implies a logic
 *   error: a discriminated union branch was not handled by the caller.
 *
 * @remarks
 * Precondition: all valid branches of the union must be handled before this call.
 * Postcondition: execution never continues past this call — always throws.
 * Safety: if a new variant is added to a union, TypeScript will report a compile
 * error at the call site because `value` will no longer narrow to `never`.
 *
 * @example
 * ```ts
 * import { assertNever } from "./assert.js";
 *
 * type Direction = "up" | "down";
 *
 * function describe(d: Direction): string {
 *   switch (d) {
 *     case "up": return "ascending";
 *     case "down": return "descending";
 *     default: return assertNever(d);
 *   }
 * }
 * ```
 */
export function assertNever(value: never): never {
  throw new Error(`Unreachable value: ${String(value)}`);
}
