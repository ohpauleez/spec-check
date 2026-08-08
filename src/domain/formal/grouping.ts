/**
 * Semantic grouping helpers for formalization and solver analysis.
 *
 * Provides the shared capability/logical-file grouping authority used by both
 * the formalization phase and the solver phase, plus pure deterministic
 * sub-batching. All functions are side-effect free.
 *
 * Exports: activeMergedSpecsForGrouping, buildLogicalFileByCapability,
 *          selectClaimLogicalFile, groupBySemanticKey, splitPhysicalBatches.
 */
import type { Claim, ClaimKind } from "../claim-graph.js";
import type { MergedCapabilitySpec } from "../model.js";
import type { Result } from "../result.js";
import { err, ok } from "../result.js";

/**
 * Validation error produced when the logical-file map cannot be built from the
 * provided merged specs.
 *
 * @remarks
 * Invariant: `message` is a non-empty human-readable description.
 */
export interface LogicalFileMapError {
  readonly message: string;
}

/**
 * Select merged specs that contribute entries to the logical-file grouping map.
 *
 * @param mergedSpecs - all merged capability specs produced by the merge phase
 * @returns the specs that are active for grouping-map construction
 *
 * @remarks
 * Precondition: `mergedSpecs` may be empty.
 * Postcondition: every returned spec has `requirements.length > 0` or
 *   `scenarios.length > 0`.
 *
 * The scenario clause is defensive: in the current merge domain model, merged
 * scenarios derive only from requirement blocks, so a scenario-only merged spec
 * cannot occur. The broader rule keeps grouping correct if the domain model
 * ever admits standalone scenario claims.
 *
 * This helper is used **only** for grouping-map construction; it does not
 * replace the claim-graph or solver-input activity filters
 * (`requirements.length > 0`). The grouping map can therefore only be broader
 * than the set of specs that contribute claims, never narrower.
 */
export function activeMergedSpecsForGrouping(
  mergedSpecs: readonly MergedCapabilitySpec[],
): readonly MergedCapabilitySpec[] {
  return mergedSpecs.filter(
    (spec) => spec.requirements.length > 0 || spec.scenarios.length > 0,
  );
}

/**
 * Build a capability-to-logical-file map from the provided merged specs.
 *
 * @param specs - merged specs to map; typically the output of
 *   {@link activeMergedSpecsForGrouping}
 * @returns a `Result` containing the map, or validation errors
 *
 * @remarks
 * Precondition: every provided spec has a non-empty `capability` and a
 *   `logicalFile` string.
 * Postcondition: the map contains exactly one entry per provided spec.
 * Postcondition: every map value is a non-empty string.
 * Invariant: capability uniqueness is inherited from the merge layer's
 *   `capabilityOrder` first-occurrence deduplication; this function does not
 *   re-enforce it.
 *
 * Failure modes:
 * - Any `spec.logicalFile` is empty → `err` with one
 *   {@link LogicalFileMapError} per empty value.
 */
export function buildLogicalFileByCapability(
  specs: readonly MergedCapabilitySpec[],
): Result<ReadonlyMap<string, string>, readonly LogicalFileMapError[]> {
  const errors: LogicalFileMapError[] = [];
  const map = new Map<string, string>();

  for (const spec of specs) {
    if (spec.logicalFile.length === 0) {
      errors.push({
        message: `merged capability ${spec.capability} has an empty logicalFile`,
      });
      continue;
    }
    map.set(spec.capability, spec.logicalFile);
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok(map);
}

/**
 * Compute the shared semantic grouping key for a claim.
 *
 * @param claim - a claim with optional capability and provenance
 * @param logicalFileByCapability - map from capability name to merged logical
 *   file; may be empty
 * @returns the deterministic semantic key for this claim
 *
 * @remarks
 * Precondition: `claim.provenance.file` is defined.
 * Postcondition: the returned key is one of:
 *   - the mapped `logicalFile` for a capability-bearing claim,
 *   - the synthetic fallback `<merged-spec/{capability}>` for a capability-bearing
 *     claim with no map entry, or
 *   - `claim.provenance.file` verbatim for a capability-less claim.
 * Invariant: keys are compared by exact string equality; no normalization is applied.
 * Invariant: the same claim and map always produce the same key.
 */
export function selectClaimLogicalFile(
  claim: Pick<Claim, "capability" | "provenance">,
  logicalFileByCapability: ReadonlyMap<string, string>,
): string {
  const capability = claim.capability;
  if (capability === undefined) {
    return claim.provenance.file;
  }
  return logicalFileByCapability.get(capability) ?? `<merged-spec/${capability}>`;
}

/**
 * Shape of one logical group after semantic grouping.
 *
 * @remarks
 * Invariant: `key` is the exact semantic grouping string.
 * Invariant: `items` preserves the eligible input order of the claims that
 *   share this key.
 * Invariant: groups are ordered by first occurrence of each key in eligible
 *   input order.
 */
export interface SemanticGroup<T> {
  readonly key: string;
  readonly items: readonly T[];
}

/**
 * Group eligible items by the shared semantic key helper.
 *
 * @param items - items to group, in eligible input order
 * @param getClaim - extract the claim-like object used for key selection
 * @param logicalFileByCapability - capability → logical file map
 * @returns logical groups ordered by first key occurrence
 *
 * @remarks
 * Precondition: every item's claim has `provenance.file` defined.
 * Postcondition: every item appears in exactly one group.
 * Postcondition: groups are ordered by first occurrence of each semantic key.
 * Postcondition: items inside each group preserve eligible input order.
 * Postcondition: grouping is deterministic for the same input order and map.
 */
export function groupBySemanticKey<T>(
  items: readonly T[],
  getClaim: (item: T) => Pick<Claim, "capability" | "provenance">,
  logicalFileByCapability: ReadonlyMap<string, string>,
): readonly SemanticGroup<T>[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];

  for (const item of items) {
    const key = selectClaimLogicalFile(getClaim(item), logicalFileByCapability);
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
      order.push(key);
    }
  }

  return order.map((key) => ({
    key,
    items: groups.get(key) ?? [],
  }));
}

/**
 * Validate and normalize control parameters used by formalization grouping and
 * sub-batching.
 *
 * @param params - raw numeric controls from the caller
 * @returns `ok(void)` if all controls are valid, otherwise `err` with errors
 *
 * @remarks
 * Precondition: controls may be any value; non-numbers are rejected.
 * Postcondition: when `ok`, `maxBatchSize` is a safe integer `>= 0`,
 *   `samplesPerClaim` is a safe integer `>= 1`, and `concurrency` (when
 *   supplied) is a safe integer `>= 1`.
 */
export function validateFormalizationControls(params: {
  readonly maxBatchSize: number | undefined;
  readonly samplesPerClaim: number;
  readonly concurrency: number | undefined;
}): Result<void, readonly LogicalFileMapError[]> {
  const errors: LogicalFileMapError[] = [];

  if (!Number.isSafeInteger(params.samplesPerClaim) || params.samplesPerClaim < 1) {
    errors.push({
      message: `samplesPerClaim must be a safe integer >= 1, got ${String(params.samplesPerClaim)}`,
    });
  }

  if (params.concurrency !== undefined && (!Number.isSafeInteger(params.concurrency) || params.concurrency < 1)) {
    errors.push({
      message: `concurrency must be a safe integer >= 1 when supplied, got ${String(params.concurrency)}`,
    });
  }

  const maxBatchSize = params.maxBatchSize ?? 0;
  if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 0) {
    errors.push({
      message: `maxBatchSize must be a safe integer >= 0, got ${String(params.maxBatchSize)}`,
    });
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok(undefined);
}

/**
 * Split one logical group into physical first-sample sub-batches.
 *
 * @param items - group items in eligible input order
 * @param maxBatchSize - maximum chunk size; `0` means unbounded (one chunk)
 * @returns chunks preserving item order
 *
 * @remarks
 * Precondition: `maxBatchSize` is a safe integer `>= 0`.
 * Postcondition: every item appears in exactly one chunk.
 * Postcondition: when `maxBatchSize > 0`, every chunk has length `<= maxBatchSize`.
 * Postcondition: when `maxBatchSize === 0`, the group yields exactly one chunk.
 * Postcondition: chunk sizes sum to `items.length` and item order is preserved.
 *
 * Failure modes: none — pure computation.
 */
export function splitPhysicalBatches<T>(
  items: readonly T[],
  maxBatchSize: number,
): readonly (readonly T[])[] {
  if (items.length === 0) {
    return [];
  }

  if (maxBatchSize === 0) {
    return [items];
  }

  if (maxBatchSize === 1) {
    return items.map((item) => [item]);
  }

  const chunks: (readonly T[])[] = [];
  for (let start = 0; start < items.length; start += maxBatchSize) {
    chunks.push(items.slice(start, start + maxBatchSize));
  }

  return chunks;
}

/**
 * Type guard for formalizable claim kinds.
 *
 * @param kind - claim kind to test
 * @returns true when `kind` is `"requirement"` or `"scenario"`
 */
export function isFormalizableKind(kind: ClaimKind): kind is "requirement" | "scenario" {
  return kind === "requirement" || kind === "scenario";
}
