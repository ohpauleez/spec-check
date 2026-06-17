/**
 * Tagged union result for expected success/failure outcomes.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Construct a successful `Result`.
 *
 * @param value - success value
 * @returns successful result branch
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Construct a failed `Result`.
 *
 * @param error - error payload
 * @returns failed result branch
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
