/**
 * Pure semantic-grouping and physical-batching helpers.
 *
 * @remarks
 * Semantic keys are compared as exact strings and are never normalized. The
 * helpers preserve input order and do not mutate claims, merged specs, maps,
 * groups, or their nested values.
 *
 * @example
 * ```ts
 * const key = selectClaimLogicalFile(
 *   { capability: toCapabilityName("auth"), provenance: { file: "specs/auth.md" } },
 *   new Map([["auth", "merged/auth.md"]]),
 * );
 * // key === "merged/auth.md"
 * ```
 */
import { precondition } from "../assert.js";
import { err, ok, type Result } from "../result.js";
import type { CapabilityName } from "../branded.js";
import type { Claim } from "../claim-graph.js";
import type { MergedCapabilitySpec } from "../model.js";
import type { IndexedBatchClaim } from "./batch-transport.js";

/**
 * Validation failure produced while constructing a capability grouping map.
 *
 * @remarks
 * The only expected mapping failure is an empty logical-file value. The
 * capability identifies the invalid supplied merged spec, and `message` is a
 * stable human-readable explanation. Values are immutable after construction.
 */
export interface LogicalFileMappingError {
  readonly kind: "empty_logical_file";
  readonly capability: CapabilityName;
  readonly message: string;
}

/**
 * One semantic group whose members are in eligible input order.
 *
 * @typeParam TClaim - immutable claim payload carried through physical slicing
 *
 * @remarks
 * `logicalFile` is the exact semantic key for every member. This interface does
 * not own or mutate `claims`; callers retain ownership of all nested values.
 */
export interface SemanticClaimGroup<TClaim> {
  readonly logicalFile: string;
  readonly claims: readonly TClaim[];
}

/**
 * One stable physical slice of a semantic claim group.
 *
 * @typeParam TClaim - immutable claim payload preserved from the semantic group
 *
 * @remarks
 * `ordinal` is zero-based within one semantic group. Every batch keeps the
 * group's exact `logicalFile`; physical slicing never changes semantic identity.
 */
export interface PhysicalBatch<TClaim> extends SemanticClaimGroup<TClaim> {
  readonly ordinal: number;
}

/**
 * An eligible formalization claim with its stable input index and semantic key.
 *
 * @remarks
 * `index` counts only requirement and scenario claims. It is authoritative for
 * attached-response matching and remains unchanged by grouping or slicing.
 */
export interface IndexedFormalizationClaim extends IndexedBatchClaim {
  readonly claim: Claim;
  readonly logicalFile: string;
}

/**
 * Select merged capability specs that can contribute claims to a grouping map.
 *
 * @param mergedSpecs - Merged capability specs considered for grouping-map construction.
 * @returns Active specs in their original order in a newly allocated array.
 *
 * @remarks
 * Preconditions: each value satisfies the {@link MergedCapabilitySpec}
 * contract. Postconditions: every returned spec has at least one requirement or
 * at least one scenario, every omitted spec has neither, and relative order is
 * preserved. This helper is only for grouping-map construction; it must not
 * replace the narrower claim-graph or solver-input activity filters.
 *
 * The scenario clause is defensive and currently unreachable because merged
 * scenarios derive from requirement blocks in the current merge domain model.
 * There are no expected failure forms or exceptions. The input and all nested
 * values remain unchanged, and work is bounded by `mergedSpecs.length`.
 *
 * @example
 * ```ts
 * const active = activeMergedSpecsForGrouping(mergedSpecs);
 * const mapping = buildLogicalFileByCapability(active);
 * ```
 */
export function activeMergedSpecsForGrouping(
  mergedSpecs: readonly MergedCapabilitySpec[],
): readonly MergedCapabilitySpec[] {
  return mergedSpecs.filter((spec) => spec.requirements.length > 0 || spec.scenarios.length > 0);
}

/**
 * Build the semantic logical-file map for supplied merged capability specs.
 *
 * @param mergedSpecs - Explicitly selected specs to map; no activity filtering is implicit.
 * @returns `ok` with a new map, or `err` containing every empty-value validation failure.
 *
 * @remarks
 * Preconditions: capabilities are validated {@link CapabilityName} values and
 * are unique under the merge-layer invariant. Callers choose activity filtering
 * explicitly, normally with {@link activeMergedSpecsForGrouping}.
 * Postconditions: success contains one entry per supplied capability and keeps
 * each logical-file string verbatim. Failure returns no map and reports every
 * supplied spec whose `logicalFile` is empty.
 *
 * This pure mapper does not normalize values, mutate input, perform I/O, or
 * re-enforce capability uniqueness. Empty values are expected validation
 * failures represented by {@link LogicalFileMappingError}; the function does
 * not throw under its preconditions. Time and allocation are bounded by
 * `mergedSpecs.length`.
 *
 * @example
 * ```ts
 * const result = buildLogicalFileByCapability(activeSpecs);
 * if (result.ok) {
 *   const authFile = result.value.get("auth");
 * }
 * ```
 */
export function buildLogicalFileByCapability(
  mergedSpecs: readonly MergedCapabilitySpec[],
): Result<ReadonlyMap<string, string>, readonly LogicalFileMappingError[]> {
  const logicalFileByCapability = new Map<string, string>();
  const errors: LogicalFileMappingError[] = [];

  for (const spec of mergedSpecs) {
    if (spec.logicalFile.length === 0) {
      errors.push({
        kind: "empty_logical_file",
        capability: spec.capability,
        message: `logicalFile must be non-empty for capability ${spec.capability}`,
      });
      continue;
    }
    logicalFileByCapability.set(spec.capability, spec.logicalFile);
  }

  if (errors.length > 0) {
    return err(errors);
  }
  return ok(logicalFileByCapability);
}

/**
 * Select the single semantic grouping key for a claim.
 *
 * @param claim - Claim fields required for capability and provenance selection.
 * @param logicalFileByCapability - Shared validated capability-to-logical-file map.
 * @returns The mapped logical file, synthetic capability fallback, or verbatim provenance file.
 *
 * @remarks
 * Preconditions: map values are non-empty logical-file strings, as guaranteed
 * by {@link buildLogicalFileByCapability}, and `claim.provenance.file` satisfies
 * the {@link Claim} contract. Capability-bearing claims use their mapped value
 * exactly when present and otherwise use `<merged-spec/{capability}>`.
 * Capability-less claims use `claim.provenance.file` exactly.
 *
 * Exact string equality is the grouping relation; no path or Unicode
 * normalization occurs. The claim and map are never mutated. There are no
 * expected failure forms or exceptions under the preconditions, including for
 * an unmapped capability, and the operation performs no I/O.
 *
 * @example
 * ```ts
 * selectClaimLogicalFile(claim, new Map());
 * // Capability "auth" yields "<merged-spec/auth>" when unmapped.
 * ```
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
 * Whether a claim is eligible for formalization.
 *
 * @param claim - claim to classify
 * @returns `true` for requirement and scenario claims, the two kinds that
 *   carry formalizable obligations
 *
 * @remarks
 * This is the single eligibility predicate shared by grouping and by the CLI
 * layer that resolves eligible indexes back to claims; keeping it in one
 * place prevents the two from drifting. The function is pure and total.
 */
export function isFormalizableClaim(claim: Claim): boolean {
  return claim.kind === "requirement" || claim.kind === "scenario";
}

/**
 * Group formalizable claims by their exact semantic logical-file key.
 *
 * @param claims - all claims; only requirement and scenario claims are eligible
 * @param logicalFileByCapability - validated capability-to-logical-file map
 * @returns groups ordered by first key occurrence, with members in eligible input order
 *
 * @remarks
 * Each eligible claim occurs exactly once. `index` is assigned before grouping,
 * so interleaved groups retain global eligible-input identity. Inputs are not
 * mutated and key strings are not normalized.
 */
export function groupFormalizationClaims(
  claims: readonly Claim[],
  logicalFileByCapability: ReadonlyMap<string, string>,
): readonly SemanticClaimGroup<IndexedFormalizationClaim>[] {
  const claimsByLogicalFile = new Map<string, IndexedFormalizationClaim[]>();
  const logicalFileOrder: string[] = [];
  let index = 0;

  for (const claim of claims) {
    if (!isFormalizableClaim(claim)) {
      continue;
    }

    const logicalFile = selectClaimLogicalFile(claim, logicalFileByCapability);
    const indexedClaim: IndexedFormalizationClaim = { claim, index, logicalFile };
    index += 1;
    const group = claimsByLogicalFile.get(logicalFile);
    if (group === undefined) {
      claimsByLogicalFile.set(logicalFile, [indexedClaim]);
      logicalFileOrder.push(logicalFile);
    } else {
      group.push(indexedClaim);
    }
  }

  return logicalFileOrder.map((logicalFile) => ({
    logicalFile,
    claims: claimsByLogicalFile.get(logicalFile) ?? [],
  }));
}

/**
 * Split one semantic group into stable first-sample physical batches.
 *
 * @typeParam TClaim - immutable claim payload preserved by each slice
 * @param group - One semantic group in eligible input order.
 * @param maxBatchSize - Zero for one unbounded batch, otherwise a positive claim-count bound.
 * @returns Deterministic batches in stable claim order with zero-based ordinals.
 *
 * @throws {Error} If `maxBatchSize` is not a safe integer greater than or equal to zero.
 *
 * @remarks
 * Preconditions: `maxBatchSize` is a safe integer at least zero. The
 * formalization boundary is expected to reject invalid caller input before this
 * helper runs; the executable precondition prevents non-termination if an
 * internal caller violates that contract.
 *
 * Postconditions: an empty group yields no batches; zero yields one unbounded
 * batch for a non-empty group; a positive value yields stable slices no larger
 * than the bound. Every input claim appears exactly once and in order. Every
 * output preserves `group.logicalFile`, and neither the group nor claim payloads
 * are mutated. Work and allocation are bounded by `group.claims.length`.
 *
 * @example
 * ```ts
 * const batches = splitPhysicalBatches({ logicalFile: "merged/auth.md", claims }, 5);
 * // Twelve claims produce batch sizes [5, 5, 2].
 * ```
 */
export function splitPhysicalBatches<TClaim>(
  group: SemanticClaimGroup<TClaim>,
  maxBatchSize: number,
): readonly PhysicalBatch<TClaim>[] {
  precondition(Number.isSafeInteger(maxBatchSize), "maxBatchSize must be a safe integer");
  precondition(maxBatchSize >= 0, "maxBatchSize must be greater than or equal to zero");

  if (group.claims.length === 0) {
    return [];
  }
  if (maxBatchSize === 0 || maxBatchSize >= group.claims.length) {
    return [{ logicalFile: group.logicalFile, ordinal: 0, claims: group.claims }];
  }

  const batches: PhysicalBatch<TClaim>[] = [];
  for (let start = 0; start < group.claims.length; start += maxBatchSize) {
    batches.push({
      logicalFile: group.logicalFile,
      ordinal: batches.length,
      claims: group.claims.slice(start, start + maxBatchSize),
    });
  }
  return batches;
}
