/** Run-local cache eligibility: frozen plain data, including every nested value.
 * @example const eligibility = new ImmutableObjects(); eligibility.accepts(frozenData);
 */
const IMMUTABLE_SCAN_NODES_MAX = 65_536;
const IMMUTABLE_SCAN_DEPTH_MAX = 256;

/** Positive-only eligibility memo; misses never authorize stale reuse of mutable callers. */
export class ImmutableObjects {
  private readonly known = new WeakSet<object>();

  /** Check deeply frozen plain data without invoking getters.
   * @returns False for mutable/unsupported/cyclic/oversized graphs, true only for cache-safe data.
   * @remarks Work is bounded by the named depth/node limits. Positive results are local to
   * this instance; no I/O or mutation of caller data. Proxies are outside the plain-data contract.
   * @example eligibility.accepts(Object.freeze({ value: 1 })); // true
   */
  accepts(value: unknown): boolean {
    let remaining = IMMUTABLE_SCAN_NODES_MAX;
    const active = new WeakSet<object>();
    const visit = (item: unknown, depth: number): boolean => {
      if (typeof item !== "object" || item === null) return typeof item !== "function";
      if (this.known.has(item)) return true;
      if (--remaining < 0 || depth > IMMUTABLE_SCAN_DEPTH_MAX || active.has(item) || !Object.isFrozen(item)) return false;
      const prototype = Object.getPrototypeOf(item) as unknown;
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
      active.add(item);
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor) || !visit(descriptor.value, depth + 1)) { active.delete(item); return false; }
      }
      active.delete(item);
      this.known.add(item);
      return true;
    };
    return visit(value, 0);
  }
}
