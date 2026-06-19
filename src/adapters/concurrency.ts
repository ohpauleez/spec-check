/**
 * Bounded-concurrency utilities for parallel async work.
 *
 * @remarks
 * Ownership model: each invocation of the mapping function receives exclusive
 * ownership of its input item. No shared mutable state exists between concurrent
 * invocations. Results are assembled in deterministic input order regardless of
 * completion order.
 */

import { precondition } from "../domain/assert.js";

/**
 * Map items through an async function with bounded concurrency.
 *
 * Results preserve the input ordering regardless of which operations complete first.
 * Each invocation of `fn` owns its item exclusively; no shared mutation occurs
 * between concurrent invocations.
 *
 * @param items - Input array to process
 * @param concurrency - Maximum simultaneous in-flight operations (must be >= 1)
 * @param fn - Async transform applied to each item
 * @returns Results in the same deterministic order as input items
 *
 * @throws Error if concurrency < 1 (precondition violation)
 * @throws Error if any invocation of `fn` throws (first rejection propagates)
 *
 * @remarks
 * Precondition: `concurrency >= 1` (enforced via assertion).
 * Postcondition: `output.length === items.length` and `output[i]` corresponds to `items[i]`.
 *
 * Failure modes:
 * - `concurrency < 1` → throws immediately via precondition assertion.
 * - Any `fn` invocation rejects → the returned promise rejects with the first error
 *   after all in-flight operations settle. Remaining unstarted items are not launched.
 * - Empty input array → resolves immediately with `[]` (cannot fail).
 *
 * Safety:
 * - Ordering guarantee: output[i] corresponds to input[i] for all i.
 * - Backpressure: at most `concurrency` calls to `fn` are in-flight at any time.
 * - Cancellation: not supported; all in-flight work completes even if one fails.
 *   Callers requiring cancellation should use AbortSignal within `fn`.
 * - No shared mutable state between concurrent `fn` invocations.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  precondition(concurrency >= 1, `mapBounded: concurrency must be >= 1, got ${String(concurrency)}`);


  if (items.length === 0) {
    return [];
  }

  // Fast path: no parallelism needed when concurrency >= item count.
  if (concurrency >= items.length) {
    return await Promise.all(items.map((item, index) => fn(item, index)));
  }

  // Semaphore-style execution: maintain a pool of at most `concurrency` in-flight slots.
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  let inFlight = 0;
  let firstError: unknown = undefined;
  let hasError = false;

  return await new Promise<readonly R[]>((resolve, reject) => {
    const tryLaunchNext = (): void => {
      while (inFlight < concurrency && nextIndex < items.length && !hasError) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        inFlight += 1;

        const item = items[currentIndex];
        if (item === undefined) {
          // Satisfy noUncheckedIndexedAccess — structurally unreachable given bounds.
          inFlight -= 1;
          continue;
        }

        fn(item, currentIndex)
          .then((result) => {
            results[currentIndex] = result;
            inFlight -= 1;

            if (hasError) {
              return;
            }

            if (nextIndex >= items.length && inFlight === 0) {
              resolve(results);
            } else {
              tryLaunchNext();
            }
          })
          .catch((error: unknown) => {
            if (!hasError) {
              hasError = true;
              firstError = error;
              // Wait for all in-flight to settle before rejecting.
              // This prevents unhandled rejections from remaining slots.
              inFlight -= 1;
              if (inFlight === 0) {
                reject(firstError);
              }
            } else {
              inFlight -= 1;
              if (inFlight === 0) {
                reject(firstError);
              }
            }
          });
      }
    };

    tryLaunchNext();
  });
}
