import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { callOpencode, type OpencodeCallOptions } from "../../src/adapters/opencode.js";
import { groupRepresentativesBySpec } from "../../src/cli/pipeline-helpers.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import {
  buildBatchContextFile,
  hashBatchContext,
  serializeBatchContext,
  type BatchContextFile,
} from "../../src/domain/formal/batch-transport.js";
import {
  activeMergedSpecsForGrouping,
  buildLogicalFileByCapability,
  groupFormalizationClaims,
} from "../../src/domain/formal/grouping.js";
import { formalizeClaims, type FormalizationOutput } from "../../src/domain/formal/formalize.js";
import { ATTACHED_BATCH_FORMALIZATION_PROMPT } from "../../src/domain/prompts/formalization.js";
import type { MergedCapabilitySpec, ParsedRequirement, ParsedScenario } from "../../src/domain/model.js";
import { traceSpec } from "../support/spec-trace.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

const CAPABILITY = "auth";
const LOGICAL_FILE = "<merged-spec/auth>";
const BASE_FILE = "specs/auth/spec.md";
const DELTA_FILE = "openspec/changes/semantic-batching/specs/auth/spec.md";
const MODEL = "integration-model";

const BASE_TEXT = "WHEN a base session starts, THE system SHALL retain the base policy.";
const DELTA_TEXT = "WHEN a delta session starts, THE system SHALL apply the delta policy.";
const SCENARIO_TEXT = "Given a delta session, when it starts, then the system applies the scenario policy.";

interface CapturedCall {
  readonly options: OpencodeCallOptions;
  readonly filePath: string | undefined;
  readonly serializedContext: string | undefined;
}

function makeRequirement(
  identifier: string,
  file: string,
  line: number,
  deltaOperation: ParsedRequirement["deltaOperation"],
): ParsedRequirement {
  return {
    title: identifier,
    identifier,
    body: "WHEN input arrives, THE system SHALL process it.",
    earsType: "event-driven",
    deltaOperation,
    references: [],
    provenance: { file, line },
  };
}

function makeScenario(identifier: string, file: string, line: number): ParsedScenario {
  return {
    title: identifier,
    identifier,
    body: "Given input, when it changes, then the system responds.",
    deltaOperation: "ADDED",
    provenance: { file, line },
  };
}

function makeClaim(input: {
  readonly id: string;
  readonly kind: "requirement" | "scenario";
  readonly file: string;
  readonly line: number;
  readonly text: string;
}): Claim {
  return {
    id: toClaimId(input.id),
    kind: input.kind,
    text: input.text,
    obligation: "mandatory",
    provenance: { file: input.file, line: input.line },
    references: [],
    capability: toCapabilityName(CAPABILITY),
  };
}

function makeMergedCapabilitySpec(): MergedCapabilitySpec {
  return {
    capability: toCapabilityName(CAPABILITY),
    sourceFiles: [BASE_FILE, DELTA_FILE],
    logicalFile: LOGICAL_FILE,
    requirements: [
      makeRequirement("AUTH-BASE-REQ", BASE_FILE, 12, "base"),
      makeRequirement("AUTH-DELTA-REQ", DELTA_FILE, 18, "ADDED"),
    ],
    scenarios: [makeScenario("AUTH-SCENARIO", DELTA_FILE, 24)],
    findings: [],
  };
}

function makeValidSample(claimId: string): {
  readonly claimId: ReturnType<typeof toClaimId>;
  readonly obligation: "mandatory";
  readonly variables: readonly [{ readonly name: "State"; readonly sort: "Bool" }];
  readonly functions: readonly [];
  readonly assertions: readonly [{ readonly id: "A1"; readonly expr: "true" }];
} {
  return {
    claimId: toClaimId(claimId),
    obligation: "mandatory",
    variables: [{ name: "State", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

function buildGroupingMap(spec: MergedCapabilitySpec): ReadonlyMap<string, string> {
  const result = buildLogicalFileByCapability(activeMergedSpecsForGrouping([spec]));
  if (!result.ok) {
    throw new Error(result.error.map((error) => error.message).join("; "));
  }
  return result.value;
}

function assertAttachedCall(call: CapturedCall, claimTexts: readonly string[]): void {
  const filePath = call.filePath;
  const serializedContext = call.serializedContext;
  if (filePath === undefined || serializedContext === undefined) {
    throw new Error("expected an attached context call");
  }

  expect(call.options.files).toEqual([filePath]);
  expect(call.options.prompt).toBe(ATTACHED_BATCH_FORMALIZATION_PROMPT);
  for (const claimText of claimTexts) {
    expect(call.options.prompt).not.toContain(claimText);
  }
  expect(filePath).toMatch(/(?:^|\/)spec-check-batch-[^/]+\/batch-context\.json$/u);
  expect(existsSync(filePath)).toBe(false);
  expect(existsSync(dirname(filePath))).toBe(false);
}

function assertAttachedEvidence(input: {
  readonly result: FormalizationOutput;
  readonly call: CapturedCall;
  readonly claims: readonly Claim[];
  readonly logicalFileByCapability: ReadonlyMap<string, string>;
  readonly expectedIndexes: readonly number[];
}): void {
  const evidence = input.result.batchAttempts[0];
  const serializedContext = input.call.serializedContext;
  if (evidence === undefined || serializedContext === undefined) {
    throw new Error("expected one attached batch evidence record");
  }

  const context = JSON.parse(serializedContext) as BatchContextFile;
  const indexedClaims = new Map(
    groupFormalizationClaims(input.claims, input.logicalFileByCapability)
      .flatMap((group) => group.claims.map((indexedClaim) => [indexedClaim.eligibleIndex, indexedClaim] as const)),
  );
  const reconstructedClaims = input.expectedIndexes.map((eligibleIndex) => {
    const indexedClaim = indexedClaims.get(eligibleIndex);
    if (indexedClaim === undefined) {
      throw new Error(`missing claim at eligible index ${String(eligibleIndex)}`);
    }
    return indexedClaim;
  });

  const reconstructedContext = serializeBatchContext(
    buildBatchContextFile(evidence.batchKey, reconstructedClaims),
  );

  expect(input.result.batchAttempts).toHaveLength(1);
  expect(context.schemaVersion).toBe(1);
  expect(context.batchKey).toBe(LOGICAL_FILE);
  expect(context.claims.map((claim) => claim.index)).toEqual(input.expectedIndexes);
  expect(context.claims.map((claim) => claim.provenance.file)).toEqual(
    reconstructedClaims.map((claim) => claim.claim.provenance.file),
  );
  expect(context.claims.map((claim) => claim.text)).toEqual(
    reconstructedClaims.map((claim) => claim.claim.text),
  );

  expect(evidence.schemaVersion).toBe(1);
  expect(evidence.batchKey).toBe(LOGICAL_FILE);
  expect(evidence.claimIndexes).toEqual(input.expectedIndexes);
  expect(evidence.claimIds).toEqual(reconstructedClaims.map((claim) => claim.claim.id ?? null));
  expect(evidence.provenanceFiles).toEqual(
    reconstructedClaims.map((claim) => claim.claim.provenance.file),
  );
  expect(evidence.contextSha256).toBe(hashBatchContext(serializedContext));
  expect(evidence.contextSha256).toBe(hashBatchContext(reconstructedContext));
  expect(evidence.promptVariant).toBe("attached-context-v1");
  expect(evidence.model).toBe(MODEL);
  expect(evidence.subBatchOrdinal).toBe(0);
  expect(evidence.outcome).toEqual({ kind: "success" });
  expect(evidence.cleanup).toBe("succeeded");
  expect(Object.keys(evidence)).not.toContain("text");
  expect(JSON.stringify(evidence)).not.toContain(BASE_TEXT);
  expect(JSON.stringify(evidence)).not.toContain(DELTA_TEXT);
  expect(JSON.stringify(evidence)).not.toContain(SCENARIO_TEXT);
}

describe("semantic batching integration oracle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps merged grouping, attached transport, cleanup, and evidence aligned", async () => {
    traceSpec("FLA-FORMAL-SPAN", "FLA-GROUP-SHARED", "MCA-GROUP-KEY", "MCA-ACTIVE-SPECS");
    const mergedSpec = makeMergedCapabilitySpec();
    const claims: readonly Claim[] = [
      makeClaim({ id: "AUTH-BASE-REQ", kind: "requirement", file: BASE_FILE, line: 12, text: BASE_TEXT }),
      makeClaim({ id: "AUTH-DELTA-REQ", kind: "requirement", file: DELTA_FILE, line: 18, text: DELTA_TEXT }),
      makeClaim({ id: "AUTH-SCENARIO", kind: "scenario", file: DELTA_FILE, line: 24, text: SCENARIO_TEXT }),
    ];
    const provenanceBefore = claims.map((claim) => ({ ...claim.provenance }));
    const logicalFileByCapability = buildGroupingMap(mergedSpec);
    const formalGroups = groupFormalizationClaims(claims, logicalFileByCapability);

    expect(formalGroups).toHaveLength(1);
    expect(formalGroups[0]?.logicalFile).toBe(LOGICAL_FILE);
    expect(formalGroups[0]?.claims.map((claim) => String(claim.claim.id))).toEqual([
      "AUTH-BASE-REQ",
      "AUTH-DELTA-REQ",
      "AUTH-SCENARIO",
    ]);
    expect(formalGroups[0]?.claims.map((claim) => claim.claim.provenance.file)).toEqual([
      BASE_FILE,
      DELTA_FILE,
      DELTA_FILE,
    ]);

    const capturedCalls: CapturedCall[] = [];
    const mockedCallOpencode = vi.mocked(callOpencode);
    mockedCallOpencode.mockImplementation(async (options) => {
      const filePath = options.files?.[0];
      const serializedContext = filePath === undefined ? undefined : await readFile(filePath, "utf8");
      capturedCalls.push({ options, filePath, serializedContext });

      if (serializedContext !== undefined) {
        const context = JSON.parse(serializedContext) as BatchContextFile;
        return {
          ok: true,
          value: {
            formalizations: context.claims.map((claim) => ({
              index: claim.index,
              ...makeValidSample(claim.id ?? "AUTH-UNNAMED"),
            })),
          },
        };
      }

      const inlineClaim = claims.find((claim) => claim.id !== undefined && options.prompt.includes(String(claim.id)));
      if (inlineClaim?.id === undefined) {
        throw new Error("expected an inline prompt to identify its claim");
      }
      return { ok: true, value: { sample: makeValidSample(String(inlineClaim.id)) } };
    });

    const commonInput = {
      claims,
      model: MODEL,
      samplesPerClaim: 1,
      timeoutMs: 300_000,
      concurrency: 1,
      logicalFileByCapability,
    } as const;

    const unbounded = await formalizeClaims({ ...commonInput, maxBatchSize: 0 });
    expect(unbounded.ok).toBe(true);
    if (!unbounded.ok) {
      throw new Error("unbounded formalization should succeed");
    }

    expect(mockedCallOpencode).toHaveBeenCalledTimes(1);
    const unboundedCalls = capturedCalls.splice(0);
    expect(unboundedCalls).toHaveLength(1);
    const unboundedAttached = unboundedCalls[0];
    if (unboundedAttached === undefined) {
      throw new Error("expected the unbounded attached call");
    }
    assertAttachedCall(unboundedAttached, claims.map((claim) => claim.text));
    assertAttachedEvidence({
      result: unbounded.value,
      call: unboundedAttached,
      claims,
      logicalFileByCapability,
      expectedIndexes: [0, 1, 2],
    });
    expect(unbounded.value.candidates.map((candidate) => String(candidate.claim.id))).toEqual([
      "AUTH-BASE-REQ",
      "AUTH-DELTA-REQ",
      "AUTH-SCENARIO",
    ]);
    expect(unbounded.value.candidates.map((candidate) => candidate.claim.provenance.file)).toEqual([
      BASE_FILE,
      DELTA_FILE,
      DELTA_FILE,
    ]);

    const representatives = unbounded.value.candidates.map((candidate) => {
      const representative = candidate.samples[0];
      if (representative === undefined) {
        throw new Error("expected one representative sample per candidate");
      }
      return representative;
    });
    const solverGroups = groupRepresentativesBySpec(
      unbounded.value.candidates,
      representatives,
      logicalFileByCapability,
    );
    expect(solverGroups.map((group) => ({
      key: group.specFile,
      ids: group.claims.map((claim) => String(claim.claimId)),
    }))).toEqual(formalGroups.map((group) => ({
      key: group.logicalFile,
      ids: group.claims.map((claim) => String(claim.claim.id)),
    })));

    mockedCallOpencode.mockClear();
    const bounded = await formalizeClaims({ ...commonInput, maxBatchSize: 2 });
    expect(bounded.ok).toBe(true);
    if (!bounded.ok) {
      throw new Error("bounded formalization should succeed");
    }

    expect(mockedCallOpencode).toHaveBeenCalledTimes(2);
    const boundedCalls = capturedCalls.splice(0);
    expect(boundedCalls).toHaveLength(2);
    expect(boundedCalls.map((call) => call.filePath === undefined ? "inline" : "attached")).toEqual([
      "attached",
      "inline",
    ]);
    const boundedAttached = boundedCalls[0];
    const boundedInline = boundedCalls[1];
    if (boundedAttached === undefined || boundedInline === undefined) {
      throw new Error("expected attached and inline bounded calls");
    }
    assertAttachedCall(boundedAttached, claims.map((claim) => claim.text));
    assertAttachedEvidence({
      result: bounded.value,
      call: boundedAttached,
      claims,
      logicalFileByCapability,
      expectedIndexes: [0, 1],
    });
    expect(boundedInline.options.files).toBeUndefined();
    expect(boundedInline.options.prompt).toContain(SCENARIO_TEXT);
    expect(bounded.value.candidates).toHaveLength(3);
    expect(bounded.value.errors).toEqual([]);
    expect(bounded.value.batchAttempts).toHaveLength(1);
    expect(bounded.value.candidates.map((candidate) => candidate.claim.provenance.file)).toEqual([
      BASE_FILE,
      DELTA_FILE,
      DELTA_FILE,
    ]);
    expect(claims.map((claim) => claim.provenance)).toEqual(provenanceBefore);
  });
});
