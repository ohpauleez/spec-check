import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import type { Claim, ClaimKind } from "../../src/domain/claim-graph.js";
import { formalizeClaims, type FormalizationCandidate } from "../../src/domain/formal/formalize.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import type { MergedCapabilitySpec, ParsedRequirement, ParsedScenario } from "../../src/domain/model.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import { groupRepresentativesBySpec } from "../../src/cli/pipeline-helpers.js";
import {
  activeMergedSpecsForGrouping,
  buildLogicalFileByCapability,
  groupFormalizationClaims,
  selectClaimLogicalFile,
  splitPhysicalBatches,
  type IndexedFormalizationClaim,
} from "../../src/domain/formal/grouping.js";
import {
  buildBatchContextFile,
  cleanupBatchContextDirectory,
  createBatchContextDirectory,
  hashBatchContext,
  serializeBatchContext,
} from "../../src/domain/formal/batch-transport.js";
import { ATTACHED_BATCH_FORMALIZATION_PROMPT } from "../../src/domain/prompts/formalization.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

function makeClaim(input: {
  readonly id?: string;
  readonly kind?: ClaimKind;
  readonly capability?: string;
  readonly file?: string;
} = {}): Claim {
  const id = input.id;
  const capability = input.capability;
  return {
    ...(id === undefined ? {} : { id: toClaimId(id) }),
    kind: input.kind ?? "requirement",
    text: `WHEN ${id ?? "an event"} occurs, THE system SHALL respond.`,
    obligation: "mandatory",
    provenance: { file: input.file ?? "spec.md", line: 1 },
    references: [],
    ...(capability === undefined ? {} : { capability: toCapabilityName(capability) }),
  };
}

function makeRequirement(capability: string, index: number): ParsedRequirement {
  return {
    title: `Requirement ${String(index)}`,
    identifier: `${capability.toUpperCase()}-REQ-${String(index)}`,
    body: "WHEN input arrives, THE system SHALL respond.",
    earsType: "event-driven",
    deltaOperation: "base",
    references: [],
    provenance: { file: `specs/${capability}/spec.md`, line: index },
  };
}

function makeScenario(capability: string, index: number): ParsedScenario {
  return {
    title: `Scenario ${String(index)}`,
    identifier: `${capability.toUpperCase()}-SCEN-${String(index)}`,
    body: "Given input, when it changes, then the system responds.",
    deltaOperation: "base",
    provenance: { file: `specs/${capability}/spec.md`, line: index },
  };
}

function makeMergedSpec(
  capability: string,
  logicalFile: string,
  requirementCount = 0,
  scenarioCount = 0,
): MergedCapabilitySpec {
  return {
    capability: toCapabilityName(capability),
    sourceFiles: [`specs/${capability}/spec.md`],
    logicalFile,
    requirements: Array.from({ length: requirementCount }, (_, index) => makeRequirement(capability, index + 1)),
    scenarios: Array.from({ length: scenarioCount }, (_, index) => makeScenario(capability, index + 1)),
    findings: [],
  };
}

function makeRepresentative(id: string): LogicIrClaim {
  return {
    claimId: toClaimId(id),
    obligation: "mandatory",
    variables: [{ name: "State", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

function makeValidSample(id: string): LogicIrClaim {
  return makeRepresentative(id);
}

function makeCandidate(claim: Claim): FormalizationCandidate {
  return {
    claim,
    samples: [makeRepresentative(claim.id ?? "UNNAMED-CLAIM")],
    invalidSamples: [],
  };
}

function buildMap(specs: readonly MergedCapabilitySpec[]): ReadonlyMap<string, string> {
  const result = buildLogicalFileByCapability(specs);
  if (!result.ok) {
    throw new Error(result.error.map((error) => error.message).join("; "));
  }
  return result.value;
}

function makeIndexedClaims(count: number, capability = "auth"): readonly IndexedFormalizationClaim[] {
  return Array.from({ length: count }, (_, index) => {
    const claim = makeClaim({
      id: `AUTH-REQ-${String(index + 1)}`,
      capability,
      file: `specs/${capability}/source-${String(index + 1)}.md`,
    });
    return {
      claim,
      eligibleIndex: index,
      logicalFile: `<merged-spec/${capability}>`,
    };
  });
}

describe("semantic grouping contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses mapped, provenance, unmapped, and empty-map semantic keys", () => {
    traceSpec("FLA-SEMGRP-MAPPED", "FLA-SEMGRP-PROVENANCE", "FLA-SEMGRP-FALLBACK");
    const mappedClaim = makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" });
    const capabilityLessClaim = makeClaim({ id: "PLAIN-REQ-1", file: "opaque/../source\\spec.md" });
    const unmappedClaim = makeClaim({ id: "REPORT-REQ-1", capability: "reporting", file: "base/reporting.md" });

    expect(selectClaimLogicalFile(mappedClaim, new Map([["auth", "merged/auth.md"]]))).toBe("merged/auth.md");
    expect(selectClaimLogicalFile(capabilityLessClaim, new Map())).toBe("opaque/../source\\spec.md");
    expect(selectClaimLogicalFile(unmappedClaim, new Map([["auth", "merged/auth.md"]]))).toBe(
      "<merged-spec/reporting>",
    );
    expect(selectClaimLogicalFile(unmappedClaim, new Map())).toBe("<merged-spec/reporting>");
  });

  it("keeps requirement and scenario claims in one semantic group", () => {
    traceSpec("FLA-SEMGRP-KINDS");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", kind: "requirement", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-SCEN-1", kind: "scenario", capability: "auth", file: "delta/auth.md" }),
    ];
    const map = new Map([["auth", "<merged-spec/auth>"]]);

    expect(selectClaimLogicalFile(claims[0]!, map)).toBe(selectClaimLogicalFile(claims[1]!, map));
    const groups = groupFormalizationClaims(claims, map);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.logicalFile).toBe("<merged-spec/auth>");
    expect(groups[0]?.claims.map((entry) => entry.claim.id)).toEqual(["AUTH-REQ-1", "AUTH-SCEN-1"]);
  });

  it("selects active requirement and scenario-only specs and excludes empty specs", () => {
    traceSpec("MCA-ACTIVE-REQ", "MCA-ACTIVE-SCEN", "MCA-ACTIVE-EMPTY", "MCA-GROUP-KEY-SCEN", "MCA-GROUP-KEY-COMPLETE", "FLA-SEMGRP-COVERAGE");
    const requirementSpec = makeMergedSpec("auth", "merged/auth.md", 1);
    const scenarioOnlySpec = makeMergedSpec("reporting", "merged/reporting.md", 0, 1);
    const emptySpec = makeMergedSpec("empty", "merged/empty.md");

    const active = activeMergedSpecsForGrouping([requirementSpec, scenarioOnlySpec, emptySpec]);
    expect(active).toEqual([requirementSpec, scenarioOnlySpec]);

    const map = buildMap(active);
    expect([...map.entries()]).toEqual([
      ["auth", "merged/auth.md"],
      ["reporting", "merged/reporting.md"],
    ]);

    const scenarioClaim = makeClaim({ id: "REPORTING-SCEN-1", kind: "scenario", capability: "reporting", file: "delta/reporting.md" });
    expect(selectClaimLogicalFile(scenarioClaim, map)).toBe("merged/reporting.md");
  });

  it("rejects empty logical-file values instead of adding them to the map", () => {
    traceSpec("MCA-GROUP-KEY-EMPTY");
    const result = buildLogicalFileByCapability([makeMergedSpec("auth", "")]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toHaveLength(1);
    expect(result.error[0]?.kind).toBe("empty_logical_file");
    expect(result.error[0]?.capability).toBe("auth");
  });

  it("orders groups by first key occurrence and preserves eligible claim order", () => {
    traceSpec("FLA-SEMGRP-ORDER");
    const claims = [
      makeClaim({ id: "IGNORED-1", kind: "proposal_property", capability: "auth", file: "ignored.md" }),
      makeClaim({ id: "B-1", capability: "cap-b", file: "b-source.md" }),
      makeClaim({ id: "A-1", capability: "cap-a", file: "a-source.md" }),
      makeClaim({ id: "B-2", capability: "cap-b", file: "b-delta.md" }),
      makeClaim({ id: "PLAIN-1", file: "plain.md" }),
    ];
    const map = new Map([
      ["cap-a", "logical/a.md"],
      ["cap-b", "logical/b.md"],
    ]);

    const groups = groupFormalizationClaims(claims, map);
    expect(groups.map((group) => group.logicalFile)).toEqual(["logical/b.md", "logical/a.md", "plain.md"]);
    expect(groups.map((group) => group.claims.map((entry) => entry.claim.id))).toEqual([
      ["B-1", "B-2"],
      ["A-1"],
      ["PLAIN-1"],
    ]);
    expect(groups.map((group) => group.claims.map((entry) => entry.eligibleIndex))).toEqual([[0, 2], [1], [3]]);
    expect(groupFormalizationClaims(claims, map)).toEqual(groups);
  });

  it("matches historical file grouping when semantic keys equal provenance files", () => {
    traceSpec("FLA-SEMGRP-EMERGENT");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "specs/auth.md" }),
      makeClaim({ id: "PLAIN-REQ-1", file: "specs/plain.md" }),
      makeClaim({ id: "AUTH-SCEN-1", kind: "scenario", capability: "auth", file: "specs/auth.md" }),
    ];
    const map = new Map([["auth", "specs/auth.md"]]);
    const expected = new Map<string, string[]>();
    for (const claim of claims) {
      if (claim.kind !== "requirement" && claim.kind !== "scenario") continue;
      const ids = expected.get(claim.provenance.file);
      if (ids === undefined) {
        expected.set(claim.provenance.file, [claim.id ?? "UNNAMED"]);
      } else {
        ids.push(claim.id ?? "UNNAMED");
      }
    }

    const actual = groupFormalizationClaims(claims, map).map((group) => [
      group.logicalFile,
      group.claims.map((entry) => entry.claim.id ?? "UNNAMED"),
    ]);
    expect(actual).toEqual([...expected.entries()]);
  });

  it("keeps solver and formalization grouping keys aligned after solver filtering", () => {
    traceSpec("FLA-SEMGRP-PARITY", "MCA-SOLVER-SHARED-KEY", "MCA-SOLVER-FILTER-FIRST");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "PLAIN-REQ-1", file: "plain.md" }),
      makeClaim({ id: "AUTH-SCEN-1", kind: "scenario", capability: "auth", file: "delta/auth.md" }),
      makeClaim({ id: "REPORT-REQ-1", capability: "reporting", file: "base/reporting.md" }),
      makeClaim({ id: "PROP-1", kind: "proposal_property", capability: "auth", file: "proposal.md" }),
    ];
    const map = new Map([
      ["auth", "<merged-spec/auth>"],
      ["reporting", "<merged-spec/reporting>"],
    ]);
    const candidates = claims.map(makeCandidate);
    const representatives = claims.map((claim) => makeRepresentative(claim.id ?? "UNNAMED-CLAIM"));
    const solverGroups = groupRepresentativesBySpec(candidates, representatives, map);
    const solverEligibleClaims = claims.filter(
      (claim) => (claim.kind === "requirement" || claim.kind === "scenario") && claim.capability !== undefined,
    );
    const formalGroups = groupFormalizationClaims(solverEligibleClaims, map);

    expect(solverGroups.map((group) => ({
      key: group.specFile,
      ids: group.claims.map((claim) => claim.claimId),
    }))).toEqual(formalGroups.map((group) => ({
      key: group.logicalFile,
      ids: group.claims.map((entry) => entry.claim.id),
    })));
  });
});

describe("physical batching and attached transport contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("splits twelve claims into stable [5, 5, 2] physical batches", () => {
    traceSpec("FLA-SUBBATCH", "FLA-SUBBATCH-CHUNKS");
    const claims = makeIndexedClaims(12);
    const group = {
      logicalFile: "<merged-spec/auth>",
      claims,
    } as const;

    const batches = splitPhysicalBatches(group, 5);
    expect(batches.map((batch) => batch.claims.length)).toEqual([5, 5, 2]);
    expect(batches.map((batch) => batch.ordinal)).toEqual([0, 1, 2]);
    expect(batches.flatMap((batch) => batch.claims.map((claim) => claim.eligibleIndex))).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect(batches.every((batch) => batch.logicalFile === "<merged-spec/auth>")).toBe(true);
  });

  it("keeps maxBatchSize zero unbounded and size one single-claim", () => {
    traceSpec("FLA-SUBBATCH-ZERO", "FLA-SUBBATCH-ONE");
    const group = {
      logicalFile: "logical/auth.md",
      claims: makeIndexedClaims(4),
    } as const;

    const unbounded = splitPhysicalBatches(group, 0);
    expect(unbounded).toHaveLength(1);
    expect(unbounded[0]?.claims).toEqual(group.claims);

    const singleClaim = splitPhysicalBatches(group, 1);
    expect(singleClaim).toHaveLength(4);
    expect(singleClaim.every((batch) => batch.claims.length === 1)).toBe(true);
    expect(singleClaim.flatMap((batch) => batch.claims.map((claim) => claim.eligibleIndex))).toEqual([0, 1, 2, 3]);
  });

  it("rejects invalid physical controls before invoking the adapter", async () => {
    traceSpec("FLA-SUBBATCH-INVALID");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const invalidInputs: readonly {
      readonly samplesPerClaim?: number;
      readonly concurrency?: number;
      readonly maxBatchSize?: number;
    }[] = [
      { maxBatchSize: -1 },
      { maxBatchSize: Number.NaN },
      { maxBatchSize: Number.POSITIVE_INFINITY },
      { maxBatchSize: 1.5 },
      { samplesPerClaim: 0 },
      { samplesPerClaim: 1.5 },
      { concurrency: 0 },
      { concurrency: 1.5 },
    ];

    for (const invalid of invalidInputs) {
      const result = await formalizeClaims({
        claims: [makeClaim({ id: "AUTH-REQ-1", capability: "auth" })],
        model: "test-model",
        samplesPerClaim: invalid.samplesPerClaim ?? 1,
        timeoutMs: 300000,
        concurrency: invalid.concurrency ?? 1,
        logicalFileByCapability: new Map([["auth", "logical/auth.md"]]),
        maxBatchSize: invalid.maxBatchSize ?? 0,
      });

      expect(result.ok).toBe(false);
    }
    expect(vi.mocked(callOpencode)).not.toHaveBeenCalled();
  });

  it("routes multi-claim batches through attached JSON and size-one batches inline", async () => {
    traceSpec("FLA-ATTACH-TRANSPORT", "FLA-ATTACH-MULTI", "FLA-ATTACH-SINGLE");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md" }),
    ];
    mocked.mockResolvedValueOnce({
      ok: true,
      value: {
        formalizations: [
          { index: 0, ...makeValidSample("AUTH-REQ-1") },
          { index: 1, ...makeValidSample("AUTH-REQ-2") },
        ],
      },
    });

    const attachedResult = await formalizeClaims({
      claims,
      model: "test-model",
      samplesPerClaim: 1,
      timeoutMs: 300000,
      concurrency: 1,
      logicalFileByCapability: new Map([["auth", "<merged-spec/auth>"]]),
    });

    expect(attachedResult.ok).toBe(true);
    expect(mocked).toHaveBeenCalledOnce();
    const attachedOptions = mocked.mock.calls[0]?.[0];
    expect(attachedOptions?.files).toHaveLength(1);
    expect(attachedOptions?.prompt).toBe(ATTACHED_BATCH_FORMALIZATION_PROMPT);
    expect(attachedOptions?.prompt).not.toContain(claims[0]!.text);
    if (attachedResult.ok) {
      expect(attachedResult.value.candidates).toHaveLength(2);
      expect(attachedResult.value.batchAttempts).toHaveLength(1);
    }

    vi.clearAllMocks();
    mocked.mockResolvedValue({ ok: true, value: { sample: makeValidSample("AUTH-REQ-1") } });
    const inlineResult = await formalizeClaims({
      claims: [claims[0]!],
      model: "test-model",
      samplesPerClaim: 1,
      timeoutMs: 300000,
      concurrency: 1,
      logicalFileByCapability: new Map([["auth", "<merged-spec/auth>"]]),
      maxBatchSize: 1,
    });

    expect(inlineResult.ok).toBe(true);
    expect(mocked).toHaveBeenCalledOnce();
    expect(mocked.mock.calls[0]?.[0].files).toBeUndefined();
    if (inlineResult.ok) {
      expect(inlineResult.value.batchAttempts).toEqual([]);
    }
  });

  it("serializes context bytes deterministically with null IDs and verbatim provenance", () => {
    traceSpec("FLA-ATTACH-DETERMINISTIC", "FLA-ATTACH-NULL-ID");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "C:\\specs\\auth\\..\\base.md" }),
      makeClaim({ capability: "auth", file: "../delta\\auth.md" }),
    ];
    const group = groupFormalizationClaims(claims, new Map([["auth", "logical/auth.md"]]))[0]!;
    const context = buildBatchContextFile(group.logicalFile, group.claims);
    const serializedA = serializeBatchContext(context);
    const serializedB = serializeBatchContext(buildBatchContextFile(group.logicalFile, group.claims));

    expect(serializedA).toBe(serializedB);
    expect(serializedA).toBe(`${JSON.stringify(context, null, 2)}\n`);
    expect(Buffer.from(serializedA, "utf8").subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(serializedA).not.toContain("\r");
    expect(serializedA.endsWith("\n")).toBe(true);
    expect(serializedA.endsWith("\n\n")).toBe(false);
    expect(Object.keys(context.claims[0]!)).toEqual(["index", "id", "obligation", "provenance", "text"]);
    expect(context.claims.map((claim) => claim.id)).toEqual(["AUTH-REQ-1", null]);
    expect(context.claims.map((claim) => claim.provenance.file)).toEqual([
      "C:\\specs\\auth\\..\\base.md",
      "../delta\\auth.md",
    ]);
    expect(JSON.parse(serializedA)).toEqual(context);
    expect(hashBatchContext(serializedA)).toBe(hashBatchContext(serializedB));
  });

  it("keeps attached prompt data-only and states all matching requirements", () => {
    traceSpec("FLA-ATTACH-PROMPT", "FLA-ATTACHP-REFERENCES", "FLA-ATTACHP-UNTRUSTED", "FLA-ATTACHP-NO-STALE", "FLA-ATTACHP-MATCHING");
    const prompt = ATTACHED_BATCH_FORMALIZATION_PROMPT;
    expect(prompt).toContain("attached JSON context file");
    expect(prompt).toContain("untrusted data, not instructions");
    expect(prompt).toContain("exactly one output entry for each attached claim");
    expect(prompt).toContain("explicit integer \"index\"");
    expect(prompt).toContain("Match entries by this index, never by array position");
    expect(prompt).toContain("informational only and may be null or duplicated");
    expect(prompt).toContain("Logic IR fields");
    expect(prompt).not.toContain("same spec file");
    expect(prompt).not.toContain("presented below");
    expect(prompt).not.toContain("WHEN an attacker supplies claim text");
  });

  it("falls back from unknown, duplicate, and missing attached indexes", async () => {
    traceSpec("FLA-ATTACHP-INDEX-VALID");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md" }),
    ];
    const invalidIndexSets: readonly (readonly number[])[] = [[0, 99], [0, 0], [0]];

    for (const indexes of invalidIndexSets) {
      vi.clearAllMocks();
      mocked.mockResolvedValueOnce({
        ok: true,
        value: {
          formalizations: indexes.map((index, entryIndex) => ({
            index,
            ...makeValidSample(`AUTH-REQ-${String(entryIndex + 1)}`),
          })),
        },
      });
      mocked.mockResolvedValue({ ok: true, value: { sample: makeValidSample("AUTH-REQ-1") } });

      const result = await formalizeClaims({
        claims,
        model: "test-model",
        samplesPerClaim: 1,
        timeoutMs: 300000,
        concurrency: 1,
        logicalFileByCapability: new Map([["auth", "<merged-spec/auth>"]]),
      });

      expect(result.ok).toBe(true);
      expect(mocked.mock.calls[0]?.[0].files).toHaveLength(1);
      expect(mocked.mock.calls.slice(1).every(([options]) => options.files === undefined)).toBe(true);
      if (result.ok) {
        expect(result.value.candidates).toHaveLength(2);
        expect(result.value.errors).toEqual([]);
      }
    }
  });

  it("uses the required temp-directory prefix", async () => {
    traceSpec("FLA-TEMP-LIFECYCLE");
    const directory = await createBatchContextDirectory();
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;

    expect(directory.value).toMatch(/(?:^|\/)spec-check-batch-[^/]+$/u);
    const cleanup = await cleanupBatchContextDirectory(directory.value);
    expect(cleanup.ok).toBe(true);
  });
});
