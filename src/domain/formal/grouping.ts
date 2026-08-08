/**
 * Shared semantic grouping helpers for formalization and solver analysis.
 *
 * These helpers are pure. They preserve input order, do not normalize semantic
 * keys, and keep grouping policy separate from phase-specific claim filtering.
 */
import type { Claim } from "../claim-graph.js";
import type { CapabilityName } from "../branded.js";
import type { MergedCapabilitySpec } from "../model.js";
import { err, ok, type Result } from "../result.js";

/**
 * Expected validation failure for an unusable merged capability logical file.
 *
 * @remarks
 * Preconditions: `capability` is a validated capability name and the failure
 * was found while examining a supplied merged capability spec.
 * Postconditions: `kind` identifies an empty logical-file value and `message`
 * identifies the affected capability.
 * Invariant: this error never contains a normalized or substituted logical file.
 * Failure form: returned in the `error` branch of
 * {@link buildLogicalFileByCapability}; no exception is thrown for this
 * expected validation failure.
 * Safety: the value contains validation metadata only and performs no I/O.
 */
export interface LogicalFileMappingError {
  readonly kind: "empty_logical_file";
  readonly capability: CapabilityName;
  readonly message: string;
}

/**
 * Select merged capability specs that can contribute claims to a grouping map.
 *
 * @param mergedSpecs - merged capability specs considered for grouping-map construction
 * @returns active specs in their original order, without mutating the input
 * @remarks
 * Preconditions: each supplied value has the `MergedCapabilitySpec` shape.
 * Postconditions: every returned spec has at least one requirement or at least
 * one scenario; every omitted spec has neither; relative order is preserved.
 * Invariants: this helper is only a grouping-map activity filter and does not
 * replace the narrower claim-graph or solver-input filter. The scenario clause
 * is defensive and currently unreachable because merged scenarios derive from
 * requirement blocks in the present merge domain model.
 * Failure modes: none; this is a pure filter over in-memory readonly data.
 * Safety: the returned array is newly allocated and the input specs and nested
 * values are never mutated.
 */
export function activeMergedSpecsForGrouping(
  mergedSpecs: readonly MergedCapabilitySpec[],
): readonly MergedCapabilitySpec[] {
  return mergedSpecs.filter((spec) => spec.requirements.length > 0 || spec.scenarios.length > 0);
}

/**
 * Build the semantic logical-file map for the supplied merged capability specs.
 *
 * @param mergedSpecs - explicitly selected specs to map
 * @returns a new capability-to-logical-file map, or validation errors for every
 *   supplied spec whose logical-file value is empty
 * @remarks
 * Preconditions: capabilities are validated `CapabilityName` values; callers
 * choose activity filtering explicitly, normally with
 * {@link activeMergedSpecsForGrouping}.
 * Postconditions: on success, the map contains one entry for every provided
 * capability under the merge-layer uniqueness invariant, with each logical-file
 * string preserved verbatim. On failure, no map is returned as a successful
 * value and every detected empty value is represented in the error array.
 * Invariants: this is a pure mapper; it does not normalize values, mutate
 * specs, or re-enforce capability uniqueness supplied by the merge layer.
 * Failure forms: empty `logicalFile` values return `err(readonly
 * LogicalFileMappingError[])`; no expected validation failure is thrown.
 * Safety: allocation is bounded by the number of supplied specs and performs no
 * filesystem, network, or process work.
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
 * @param claim - claim fields needed for capability and provenance selection
 * @param logicalFileByCapability - shared capability-to-logical-file map
 * @returns the mapped logical file, the synthetic capability fallback, or the
 *   verbatim provenance file for a capability-less claim
 * @remarks
 * Preconditions: map values are non-empty logical-file strings, as guaranteed
 * by {@link buildLogicalFileByCapability}; `claim.provenance.file` is available.
 * Postconditions: capability-bearing claims use their mapped value exactly when
 * present, otherwise `<merged-spec/{capability}>`; capability-less claims use
 * `claim.provenance.file` exactly.
 * Invariants: key comparison is exact string equality; no path or Unicode
 * normalization occurs; the claim and map are never mutated.
 * Failure modes: none under the stated preconditions; this pure deterministic
 * selector does not throw for an unmapped capability.
 * Safety: performs no I/O and allocates only a synthetic fallback string when
 * required.
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
 * A formalizable claim paired with its stable identity in eligible-claim order.
 *
 * @remarks
 * The index is authoritative for internal matching. Claim IDs remain display
 * metadata because they may be absent or duplicated.
 */
export interface IndexedFormalizationClaim {
  readonly claim: Claim;
  readonly eligibleIndex: number;
  readonly logicalFile: string;
}

/**
 * A deterministic logical group of formalizable claims.
 *
 * @remarks
 * Groups are ordered by first key occurrence. Claims preserve eligible input
 * order and all members have the same semantic key.
 */
export interface SemanticClaimGroup {
  readonly logicalFile: string;
  readonly claims: readonly IndexedFormalizationClaim[];
}

/**
 * A first-sample physical batch cut from one semantic group.
 *
 * @remarks
 * `ordinal` is zero-based within its logical group. Slicing never changes the
 * semantic key or the stable claim indexes.
 */
export interface PhysicalClaimBatch {
  readonly logicalFile: string;
  readonly ordinal: number;
  readonly claims: readonly IndexedFormalizationClaim[];
}

/**
 * Group eligible requirement and scenario claims by the shared semantic key.
 *
 * @param claims - all claim-graph claims; non-formalizable kinds are ignored
 * @param logicalFileByCapability - validated capability grouping map
 * @returns first-occurrence ordered semantic groups
 *
 * @remarks
 * Preconditions: map values are non-empty strings. Postconditions: each
 * eligible claim occurs exactly once, group order is deterministic, and member
 * order matches eligible input order. Failure form: none for valid inputs.
 */
export function groupFormalizationClaims(
  claims: readonly Claim[],
  logicalFileByCapability: ReadonlyMap<string, string>,
): readonly SemanticClaimGroup[] {
  const groups = new Map<string, IndexedFormalizationClaim[]>();
  const order: string[] = [];
  let eligibleIndex = 0;

  for (const claim of claims) {
    if (claim.kind !== "requirement" && claim.kind !== "scenario") {
      continue;
    }

    const logicalFile = selectClaimLogicalFile(claim, logicalFileByCapability);
    const indexedClaim: IndexedFormalizationClaim = { claim, eligibleIndex, logicalFile };
    eligibleIndex += 1;
    const existing = groups.get(logicalFile);
    if (existing !== undefined) {
      existing.push(indexedClaim);
      continue;
    }
    groups.set(logicalFile, [indexedClaim]);
    order.push(logicalFile);
  }

  return order.map((logicalFile) => ({
    logicalFile,
    claims: groups.get(logicalFile) ?? [],
  }));
}

/**
 * Split one semantic group into stable first-sample physical batches.
 *
 * @param group - one semantic group in eligible input order
 * @param maxBatchSize - zero for one unbounded batch, otherwise a positive bound
 * @returns deterministic physical batches with stable order and ordinals
 *
 * @remarks
 * Preconditions: `maxBatchSize` is a safe integer greater than or equal to
 * zero. Postconditions: zero produces one batch, positive values produce chunks
 * no larger than the bound, and all claims are preserved exactly once. Failure
 * form: invalid control values are programmer/input validation failures and are
 * rejected by the formalization boundary before this helper is called.
 */
export function splitPhysicalBatches(
  group: SemanticClaimGroup,
  maxBatchSize: number,
): readonly PhysicalClaimBatch[] {
  if (group.claims.length === 0) {
    return [];
  }
  if (maxBatchSize === 0 || maxBatchSize >= group.claims.length) {
    return [{ logicalFile: group.logicalFile, ordinal: 0, claims: group.claims }];
  }

  const batches: PhysicalClaimBatch[] = [];
  for (let start = 0; start < group.claims.length; start += maxBatchSize) {
    batches.push({
      logicalFile: group.logicalFile,
      ordinal: batches.length,
      claims: group.claims.slice(start, start + maxBatchSize),
    });
  }
  return batches;
}
