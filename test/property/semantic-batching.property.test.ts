import { readFile } from "node:fs/promises";

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { callOpencode } from "../../src/adapters/opencode.js";
import { groupRepresentativesBySpec } from "../../src/cli/pipeline-helpers.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import {
  buildBatchContextFile,
  hashBatchContext,
  serializeBatchContextFile,
} from "../../src/domain/formal/batch-transport.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import {
  groupFormalizationClaims,
  selectClaimLogicalFile,
  splitPhysicalBatches,
} from "../../src/domain/formal/grouping.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import { traceSpec } from "../support/spec-trace.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

const capabilityNames = ["auth", "catalog", "reporting", "formal"] as const;
const capabilityArbitrary = fc.constantFrom(...capabilityNames);
const logicalFileArbitrary = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}\.md$/u);
const claimArbitrary = fc
  .record({
    kind: fc.constantFrom<Claim["kind"]>("requirement", "scenario"),
    capability: fc.option(capabilityArbitrary, { nil: undefined }),
    id: fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
    file: logicalFileArbitrary,
  })
  .map(({ kind, capability, id, file }): Claim => ({
    kind,
    text: `WHEN ${file} changes, THE system SHALL respond.`,
    obligation: "mandatory",
    provenance: { file, line: 1 },
    references: [],
    ...(id === undefined ? {} : { id: toClaimId(`CLAIM-${String(id)}`) }),
    ...(capability === undefined ? {} : { capability: toCapabilityName(capability) }),
  }));
const claimListArbitrary = fc.array(claimArbitrary, { maxLength: 40 });
const logicalFileMapArbitrary = fc.dictionary(capabilityArbitrary, logicalFileArbitrary);

function eligibleClaims(claims: readonly Claim[]): readonly Claim[] {
  return claims.filter((claim) => claim.kind === "requirement" || claim.kind === "scenario");
}

function makeSample(claimId: string): LogicIrClaim {
  return {
    claimId: toClaimId(claimId),
    obligation: "mandatory",
    variables: [{ name: "State", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

/**
 * Build a single attached batch of named, same-capability claims.
 *
 * @remarks
 * All claims share capability `auth` and provenance file so grouping places
 * them in exactly one multi-claim physical batch, forcing the attached path.
 */
function makeAttachedBatchClaims(count: number, prefix: string): Claim[] {
  return Array.from({ length: count }, (_, index): Claim => ({
    kind: "requirement",
    text: `${prefix} claim ${String(index)}`,
    obligation: "mandatory",
    provenance: { file: `${prefix}.md`, line: index + 1 },
    references: [],
    capability: toCapabilityName("auth"),
    id: toClaimId(`${prefix}-${String(index)}`),
  }));
}

/** Per-claim outcome script for the latency-shuffled metamorphic run. */
interface OutcomeScriptEntry {
  readonly valid: boolean;
  /** Milliseconds of artificial delay before this claim resolves. */
  readonly delayMs: number;
}

/**
 * Run `formalizeClaims` over one attached batch with scripted per-claim
 * outcomes and completion order controlled by artificial delays.
 *
 * @remarks
 * The adapter mock resolves the attached envelope once; claims scripted
 * invalid return an empty `claimId` (schema-invalid), which the matcher keeps
 * as per-entry data so the outcome set still covers every claim. Delay values
 * shuffle promise resolution order without real wall-clock dependence beyond
 * the injected timers.
 */
async function runScriptedAttachedBatch(
  claims: readonly Claim[],
  scripts: readonly OutcomeScriptEntry[],
): Promise<{
  readonly candidateIndexes: readonly number[];
  readonly errorIndexes: readonly number[];
  readonly findingCategories: readonly string[];
  readonly attemptClaimIndexes: readonly (readonly number[])[];
}> {
  vi.mocked(callOpencode).mockImplementation(async () => {
    const formalizations = claims.map((claim, index) => {
      const script = scripts[index];
      const claimId = claim.id ?? toClaimId(`UNNAMED-${String(index)}`);
      return script !== undefined && script.valid
        ? { index, ...makeSample(claimId) }
        : { index, claimId: "" };
    });
    return { ok: true, value: { formalizations } };
  });

  const result = await formalizeClaims({
    claims,
    model: "metamorphic-model",
    samplesPerClaim: 1,
    timeoutMs: 300_000,
    concurrency: 1,
    logicalFileByCapability: new Map([["auth", "merged/auth.md"]]),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return { candidateIndexes: [], errorIndexes: [], findingCategories: [], attemptClaimIndexes: [] };
  }
  return {
    candidateIndexes: result.value.candidates.map((candidate) => candidate.eligibleIndex),
    errorIndexes: result.value.errors.map((error) => error.eligibleIndex ?? -1),
    findingCategories: result.value.findings.map((finding) => finding.category),
    attemptClaimIndexes: result.value.batchAttempts.map((attempt) => attempt.claimIndexes),
  };
}

describe("semantic batching properties", () => {
  it("selects deterministic keys", () => {
    traceSpec("FLA-SEMANTIC-GROUPING");
    fc.assert(
      fc.property(claimArbitrary, logicalFileMapArbitrary, (claim, entries) => {
        const map = new Map<string, string>(Object.entries(entries));
        const keys = Array.from({ length: 3 }, () => selectClaimLogicalFile(claim, map));
        expect(new Set(keys)).toEqual(new Set([keys[0]]));
      }),
      { numRuns: 200 },
    );
  });

  it("groups every eligible claim exactly once in stable order", () => {
    traceSpec("FLA-CLAIM-PARTITION", "FLA-SEMGRP-ORDER");
    fc.assert(
      fc.property(claimListArbitrary, logicalFileMapArbitrary, (claims, entries) => {
        const map = new Map<string, string>(Object.entries(entries));
        const groups = groupFormalizationClaims(claims, map);
        const eligible = eligibleClaims(claims);
        const flattened = groups.flatMap((group) => group.claims);

        expect(flattened).toHaveLength(eligible.length);
        expect(new Set(flattened.map((entry) => entry.index)).size).toBe(eligible.length);
        expect(new Set(flattened.map((entry) => entry.claim))).toEqual(new Set(eligible));
        expect(groups.map((group) => group.logicalFile)).toEqual([
          ...new Set(eligible.map((claim) => selectClaimLogicalFile(claim, map))),
        ]);
        expect(groups.every((group) => group.claims.every((entry, position, members) =>
          position === 0 || entry.index > members[position - 1]!.index))).toBe(true);
        expect(flattened.every((entry) =>
          entry.logicalFile === selectClaimLogicalFile(entry.claim, map))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("matches solver grouping after the same explicit filtering", () => {
    traceSpec("FLA-SEMGRP-PARITY", "FLA-GROUP-SHARED", "MCA-SOLVER-NODUP");
    fc.assert(
      fc.property(claimListArbitrary, logicalFileMapArbitrary, (claims, entries) => {
        const map = new Map<string, string>(Object.entries(entries));
        const filtered = claims.filter((claim) => claim.capability !== undefined);
        const formalGroups = groupFormalizationClaims(filtered, map);
        const candidates = filtered.map((claim, index) => ({
          claim,
          eligibleIndex: index,
          samples: [makeSample(`PROPERTY-${String(index)}`)],
          invalidSamples: [],
        }));
        const representatives = candidates.map((candidate) => candidate.samples[0]!);
        const solverGroups = groupRepresentativesBySpec(candidates, representatives, map);

        expect(solverGroups.map((group) => [
          group.specFile,
          group.claims.map((sample) => String(sample.claimId)),
        ])).toEqual(formalGroups.map((group) => [
          group.logicalFile,
          group.claims.map((entry) => `PROPERTY-${String(entry.index)}`),
        ]));
      }),
      { numRuns: 200 },
    );
  });

  it("equals historical file grouping when semantic keys equal provenance files", () => {
    traceSpec("FLA-SEMGRP-EMERGENT");
    fc.assert(
      fc.property(claimListArbitrary, (claims) => {
        const capabilityLess = claims.map((claim): Claim => {
          const { capability: _capability, ...rest } = claim;
          return rest;
        });
        const historical = new Map<string, Claim[]>();
        for (const claim of eligibleClaims(capabilityLess)) {
          const group = historical.get(claim.provenance.file);
          if (group === undefined) historical.set(claim.provenance.file, [claim]);
          else group.push(claim);
        }

        expect(groupFormalizationClaims(capabilityLess, new Map()).map((group) => [
          group.logicalFile,
          group.claims.map((entry) => entry.claim),
        ])).toEqual([...historical.entries()]);
      }),
      { numRuns: 200 },
    );
  });

  it("preserves sub-batch bounds, sum, key, order, ordinals, and termination", () => {
    traceSpec("FLA-SUBBATCH", "FLA-CLAIM-PARTITION");
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { maxLength: 100 }),
        fc.integer({ min: 0, max: 50 }),
        (claims, maxBatchSize) => {
          const group = { logicalFile: "merged/generated.md", claims };
          const batches = splitPhysicalBatches(group, maxBatchSize);

          expect(batches.flatMap((batch) => batch.claims)).toEqual(claims);
          expect(batches.reduce((sum, batch) => sum + batch.claims.length, 0)).toBe(claims.length);
          expect(batches.every((batch) => batch.logicalFile === group.logicalFile)).toBe(true);
          expect(batches.map((batch) => batch.ordinal)).toEqual(
            Array.from({ length: batches.length }, (_, index) => index),
          );
          expect(batches.length).toBeLessThanOrEqual(claims.length);
          if (claims.length === 0) expect(batches).toEqual([]);
          else if (maxBatchSize === 0) expect(batches).toHaveLength(1);
          else expect(batches.every((batch) => batch.claims.length <= maxBatchSize)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("does not mutate claims or provenance while grouping and splitting", () => {
    traceSpec("FLA-CLAIM-PARTITION", "FLA-SUBBATCH");
    fc.assert(
      fc.property(
        claimListArbitrary,
        logicalFileMapArbitrary,
        fc.integer({ min: 0, max: 20 }),
        (claims, entries, maxBatchSize) => {
          const before = structuredClone(claims);
          for (const group of groupFormalizationClaims(claims, new Map(Object.entries(entries)))) {
            splitPhysicalBatches(group, maxBatchSize);
          }
          expect(claims).toEqual(before);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps candidates distinct when claim IDs are duplicate or missing", async () => {
    traceSpec("FLA-IDENTITY-INDEX", "FLA-IDENTITY-DUP", "FLA-IDENTITY-MISSING");
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 2, maxLength: 8 }),
        async (hasId) => {
          vi.mocked(callOpencode).mockImplementation(async (options) => {
            const filePath = options.files?.[0];
            if (filePath !== undefined) {
              const context = JSON.parse(await readFile(filePath, "utf8")) as {
                readonly claims: readonly { readonly index: number; readonly id: string | null }[];
              };
              return {
                ok: true,
                value: {
                  formalizations: context.claims.map(({ index, id }) => ({
                    index,
                    ...makeSample(id ?? `FIRST-${String(index)}`),
                  })),
                },
              };
            }
            const match = /Identity claim (\d+)/u.exec(options.prompt);
            const index = match?.[1] ?? "UNKNOWN";
            const sourceId = /<claim id="([^"]+)"/u.exec(options.prompt)?.[1];
            return {
              ok: true,
              value: { sample: makeSample(sourceId === "UNNAMED" ? `EXTRA-${index}` : sourceId ?? `EXTRA-${index}`) },
            };
          });
          const claims: Claim[] = hasId.map((present, index) => ({
            kind: "requirement",
            text: `Identity claim ${String(index)}`,
            obligation: "mandatory",
            provenance: { file: `identity-${String(index)}.md`, line: index + 1 },
            references: [],
            capability: toCapabilityName("auth"),
            ...(present ? { id: toClaimId("DUPLICATE") } : {}),
          }));

          const result = await formalizeClaims({
            claims,
            model: "property-model",
            samplesPerClaim: 2,
            timeoutMs: 300_000,
            concurrency: 1,
            logicalFileByCapability: new Map([["auth", "merged/auth.md"]]),
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.candidates.map((candidate) => candidate.eligibleIndex)).toEqual(
            hasId.map((_, index) => index),
          );
          expect(result.value.candidates.map((candidate) => candidate.samples.map((sample) => sample.claimId)))
            .toEqual(hasId.map((present, index) => present
              ? ["DUPLICATE", "DUPLICATE"]
              : [`FIRST-${String(index)}`, `EXTRA-${String(index)}`]));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("repeats groups, chunks, context bytes, and hashes identically", () => {
    traceSpec("FLA-SEMGRP-ORDER", "FLA-ATTACH-DETERMINISTIC");
    const claims: Claim[] = Array.from({ length: 7 }, (_, index) => ({
      kind: index % 2 === 0 ? "requirement" : "scenario",
      text: `Deterministic claim ${String(index)}`,
      obligation: "mandatory",
      provenance: { file: index < 4 ? "base.md" : "delta.md", line: index + 1 },
      references: [],
      capability: toCapabilityName("auth"),
      id: toClaimId(`AUTH-${String(index)}`),
    }));
    const map = new Map([["auth", "merged/auth.md"]]);
    const snapshots = Array.from({ length: 3 }, () => {
      const groups = groupFormalizationClaims(claims, map);
      const batches = groups.flatMap((group) => splitPhysicalBatches(group, 3));
      const contexts = batches.map((batch) => serializeBatchContextFile(
        buildBatchContextFile(batch.logicalFile, batch.claims),
      ));
      return {
        groups: groups.map((group) => [group.logicalFile, group.claims.map((entry) => entry.index)]),
        batches: batches.map((batch) => [batch.logicalFile, batch.ordinal, batch.claims.map((entry) => entry.index)]),
        contexts,
        hashes: contexts.map(hashBatchContext),
      };
    });

    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
  });

  it("yields identical terminal outcome sets under shuffled completion order", async () => {
    traceSpec("FLA-IDENTITY-ORDER", "FLA-PARTITION-WORKER", "FLA-FORMALIZE-CLAIMS");
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }).chain((count) =>
          fc.tuple(
            fc.constant(count),
            fc.array(
              fc.record({
                valid: fc.boolean(),
                delayMs: fc.integer({ min: 0, max: 5 }),
              }),
              { minLength: count, maxLength: count },
            ),
          )),
        async ([count, scripts]) => {
          const claims = makeAttachedBatchClaims(count, "ORDER");

          // Run the same scripted outcomes twice with the completion order
          // reversed: metamorphic relation requires identical terminal sets.
          const forward = await runScriptedAttachedBatch(claims, scripts);
          const reversed = await runScriptedAttachedBatch(
            claims,
            [...scripts].reverse().map((script, index) => ({
              // Keep validity pinned to the claim, shuffle only timing.
              valid: scripts[index]?.valid ?? script.valid,
              delayMs: 5 - script.delayMs,
            })),
          );

          expect(reversed.candidateIndexes).toEqual(forward.candidateIndexes);
          expect(reversed.errorIndexes).toEqual(forward.errorIndexes);
          expect([...reversed.findingCategories].sort()).toEqual([...forward.findingCategories].sort());
          expect(reversed.attemptClaimIndexes).toEqual(forward.attemptClaimIndexes);

          // Every claim reaches exactly one terminal outcome.
          const allIndexes = [...forward.candidateIndexes, ...forward.errorIndexes].sort((a, b) => a - b);
          expect(allIndexes).toEqual(claims.map((_, index) => index));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps attempt evidence isolated between two concurrent invocations", async () => {
    traceSpec("FLA-EVIDENCE-RECONSTRUCT", "RAE-FORMAL-ATTEMPT-SETS");
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 2, max: 5 }),
        async (countA, countB) => {
          const claimsA = makeAttachedBatchClaims(countA, "SETA");
          const claimsB = makeAttachedBatchClaims(countB, "SETB");
          const indexesA = new Set(claimsA.map((claim) => claim.id));
          const indexesB = new Set(claimsB.map((claim) => claim.id));

          vi.mocked(callOpencode).mockImplementation(async (options) => {
            const filePath = options.files?.[0];
            if (filePath === undefined) {
              return { ok: false, error: { kind: "invalid_json", phase: "formalization", message: "no context" } };
            }
            const context = JSON.parse(await readFile(filePath, "utf8")) as {
              readonly claims: readonly { readonly index: number; readonly id: string | null }[];
            };
            return {
              ok: true,
              value: {
                formalizations: context.claims.map(({ index, id }) => ({
                  index,
                  ...makeSample(id ?? `UNKNOWN-${String(index)}`),
                })),
              },
            };
          });

          const map = new Map([["auth", "merged/auth.md"]]);
          const [resultA, resultB] = await Promise.all([
            formalizeClaims({
              claims: claimsA, model: "m", samplesPerClaim: 1, timeoutMs: 300_000,
              concurrency: 1, logicalFileByCapability: map,
            }),
            formalizeClaims({
              claims: claimsB, model: "m", samplesPerClaim: 1, timeoutMs: 300_000,
              concurrency: 1, logicalFileByCapability: map,
            }),
          ]);

          expect(resultA.ok).toBe(true);
          expect(resultB.ok).toBe(true);
          if (!resultA.ok || !resultB.ok) return;

          // Each invocation's evidence references only its own claim set:
          // claim ids in A's attempts come from A, and B's from B.
          for (const attempt of resultA.value.batchAttempts) {
            for (const id of attempt.claimIds) {
              expect(id === null || indexesA.has(toClaimId(id))).toBe(true);
              expect(id === null || !indexesB.has(toClaimId(id))).toBe(true);
            }
          }
          for (const attempt of resultB.value.batchAttempts) {
            for (const id of attempt.claimIds) {
              expect(id === null || indexesB.has(toClaimId(id))).toBe(true);
              expect(id === null || !indexesA.has(toClaimId(id))).toBe(true);
            }
          }
        },
      ),
      { numRuns: 80 },
    );
  });
});
