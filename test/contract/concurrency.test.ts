import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { mapBounded } from "../../src/adapters/concurrency.js";

/**
 * Regression coverage for the bounded-concurrency adapter's settle behavior.
 *
 * These are deterministic reproductions of a liveness defect: when
 * `concurrency < items.length` (the semaphore path), an earlier rejection would
 * set `hasError` and drain the pool, but a later-settling success callback would
 * early-return without performing the final `reject`, so the returned promise
 * never settled. Per docs/typescript_style.md rule 11, a concurrency bug becomes
 * a deterministic regression test.
 *
 * The per-test timeout is the hang detector: on a regression these reject-vs-hang
 * cases would exceed the deadline instead of rejecting.
 */
describe("mapBounded settle behavior under rejection", () => {
  it("rejects instead of hanging when a later op resolves after an earlier op rejects", async () => {
    // Repro requires the semaphore path (concurrency < items.length) so that a
    // success callback can run AFTER a sibling rejection has flipped hasError and
    // drained inFlight to zero.
    let launched = 0;
    const fn = async (item: string): Promise<number> => {
      launched += 1;
      if (item === "reject-first") {
        // Rejects on the first microtask, before the delayed success below.
        throw new Error("boom-A");
      }
      if (item === "resolve-later") {
        // Settle on a later macrotask so this success is processed after the
        // sibling rejection has set hasError and dropped inFlight to zero.
        await delay(10);
        return 1;
      }
      // At concurrency 2 the third item must never launch once the first
      // rejection halts the pool; invoking it is a tripwire.
      throw new Error("third item must not launch");
    };

    await expect(
      mapBounded(["reject-first", "resolve-later", "never"], 2, fn),
    ).rejects.toThrow("boom-A");

    // Exactly the two initially-admitted items ran; the rejection stopped the
    // pool from launching the third item.
    expect(launched).toBe(2);
  }, 2000);

  it("rejects with the first error when the failing op is the last in flight", async () => {
    // Non-regression guard for the already-correct path: the rejecting op settles
    // last, so the catch handler owns the final reject.
    const fn = async (item: string): Promise<number> => {
      if (item === "reject-later") {
        await delay(10);
        throw new Error("boom-B");
      }
      return 0;
    };

    await expect(
      mapBounded(["ok", "reject-later", "ok-2"], 2, fn),
    ).rejects.toThrow("boom-B");
  }, 2000);

  it("preserves input order for the all-success semaphore path", async () => {
    // Sanity anchor: the ordering postcondition still holds when nothing fails and
    // completion order differs from input order.
    const fn = async (value: number): Promise<number> => {
      await delay(value === 0 ? 15 : 1);
      return value * 2;
    };

    const result = await mapBounded([0, 1, 2, 3], 2, fn);
    expect(result).toEqual([0, 2, 4, 6]);
  }, 2000);
});
