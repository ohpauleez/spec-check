import { beforeEach, describe, expect, it, vi } from "vitest";

import { callOpencode, type OpencodeErrorKind } from "../../src/adapters/opencode.js";
import { mapBounded } from "../../src/adapters/concurrency.js";
import type { mapBounded as MapBounded } from "../../src/adapters/concurrency.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import { traceSpec } from "../support/spec-trace.js";

const workerFailureState = vi.hoisted(() => ({ rejectInlineFallback: false }));

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

vi.mock("../../src/adapters/concurrency.js", async () => {
  const actual = await vi.importActual<{ readonly mapBounded: typeof MapBounded }>(
    "../../src/adapters/concurrency.js",
  );
  return {
    ...actual,
    mapBounded: vi.fn(async <T, R>(
      items: readonly T[],
      concurrency: number,
      fn: (item: T, index: number) => Promise<R>,
    ): Promise<readonly R[]> => {
      if (workerFailureState.rejectInlineFallback && isIndexedWorkerItem(items[0])) {
        throw new Error("fallback worker failed");
      }
      return actual.mapBounded(items, concurrency, fn);
    }),
  };
});

const degradableKinds = ["timeout", "invalid_json", "schema_validation_error"] as const;
const infrastructureKinds = ["spawn_error", "invalid_files", "invalid_timeout"] as const;

function isIndexedWorkerItem(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "claim" in value
    && "eligibleIndex" in value;
}

function makeClaim(input: {
  readonly id: string;
  readonly file?: string;
  readonly text?: string;
  readonly capability?: string;
}): Claim {
  return {
    id: toClaimId(input.id),
    kind: "requirement",
    text: input.text ?? `WHEN ${input.id} occurs, THE system SHALL respond.`,
    obligation: "mandatory",
    provenance: { file: input.file ?? "specs/auth/source.md", line: 1 },
    references: [],
    capability: toCapabilityName(input.capability ?? "auth"),
  };
}

function makeClaims(): readonly Claim[] {
  return [
    makeClaim({ id: "AUTH-REQ-1", file: "base/auth.md" }),
    makeClaim({ id: "AUTH-REQ-2", file: "delta/auth.md" }),
  ];
}

function makeValidSample(claimId: string): LogicIrClaim {
  return {
    claimId: toClaimId(claimId),
    obligation: "mandatory",
    variables: [{ name: "State", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

function makeAdapterError(kind: OpencodeErrorKind, message: string) {
  return {
    ok: false as const,
    error: {
      kind,
      phase: "formalization" as const,
      message,
    },
  };
}

function inlineSampleResponse() {
  return {
    ok: true as const,
    value: { sample: makeValidSample("INLINE-FALLBACK") },
  };
}

async function formalize(claims: readonly Claim[] = makeClaims()) {
  return formalizeClaims({
    claims,
    model: "failure-test-model",
    samplesPerClaim: 1,
    timeoutMs: 300000,
    concurrency: 1,
    logicalFileByCapability: new Map([["auth", "merged/auth.md"]]),
  });
}

function expectClaimPartition(
  result: Awaited<ReturnType<typeof formalize>>,
  expectedCandidateIndexes: readonly number[],
  expectedErrorIndexes: readonly number[],
): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.value.candidates.map((candidate) => candidate.eligibleIndex)).toEqual(expectedCandidateIndexes);
  expect(result.value.errors.map((error) => error.eligibleIndex)).toEqual(expectedErrorIndexes);
  expect(result.value.candidates).toHaveLength(expectedCandidateIndexes.length);
  expect(result.value.errors).toHaveLength(expectedErrorIndexes.length);
  expect([
    ...result.value.candidates.map((candidate) => candidate.eligibleIndex),
    ...result.value.errors.map((error) => error.eligibleIndex),
  ].sort((left, right) => (left ?? -1) - (right ?? -1))).toEqual(
    [...expectedCandidateIndexes, ...expectedErrorIndexes].sort((left, right) => left - right),
  );
}

describe("semantic batching failure policy", () => {
  beforeEach(() => {
    workerFailureState.rejectInlineFallback = false;
    vi.mocked(callOpencode).mockReset();
    vi.mocked(mapBounded).mockClear();
  });

  it.each(degradableKinds)("degrades attached %s to one inline call per claim", async (kind) => {
    traceSpec("FLA-DEGRADE-KIND", "FLA-DEGRADE-TIMEOUT", "FLA-DEGRADE-JSON", "FLA-DEGRADE-SCHEMA");
    const mocked = vi.mocked(callOpencode);
    mocked.mockResolvedValueOnce(makeAdapterError(kind, `attached ${kind} failure`));
    mocked.mockResolvedValue(inlineSampleResponse());

    const result = await formalize();

    expectClaimPartition(result, [0, 1], []);
    expect(mocked).toHaveBeenCalledTimes(3);
    expect(mocked.mock.calls[0]?.[0].files).toHaveLength(1);
    expect(mocked.mock.calls.slice(1).map(([options]) => options.files)).toEqual([undefined, undefined]);
    if (result.ok) {
      expect(result.value.batchAttempts[0]?.outcome).toEqual({ kind: "model_failure", errorKind: kind });
    }
  });

  it.each(infrastructureKinds)("does not fallback after attached %s", async (kind) => {
    traceSpec("FLA-DEGRADE-SPAWN", "FLA-DEGRADE-FILES", "FLA-DEGRADE-INVTIMEOUT");
    const mocked = vi.mocked(callOpencode);
    mocked.mockResolvedValueOnce(makeAdapterError(kind, `attached ${kind} failure`));

    const result = await formalize();

    expectClaimPartition(result, [], [0, 1]);
    expect(mocked).toHaveBeenCalledOnce();
    expect(mocked.mock.calls[0]?.[0].files).toHaveLength(1);
    if (result.ok) {
      expect(result.value.errors.every((error) => error.message.includes(`attached ${kind} failure`))).toBe(true);
      expect(result.value.batchAttempts[0]?.outcome).toEqual({
        kind: "infrastructure_failure",
        errorKind: kind,
      });
    }
  });

  it("falls back from prompt_too_large when every inline prompt fits", async () => {
    traceSpec("FLA-DEGRADE-TOOLARGE");
    const mocked = vi.mocked(callOpencode);
    mocked.mockResolvedValueOnce(makeAdapterError("prompt_too_large", "attached prompt is too large"));
    mocked.mockResolvedValue(inlineSampleResponse());

    const result = await formalize();

    expectClaimPartition(result, [0, 1], []);
    expect(mocked).toHaveBeenCalledTimes(3);
    expect(mocked.mock.calls[0]?.[0].files).toHaveLength(1);
    expect(mocked.mock.calls.slice(1).every(([options]) => options.files === undefined)).toBe(true);
  });

  it("does not fallback from prompt_too_large when one inline prompt cannot fit", async () => {
    traceSpec("FLA-DEGRADE-TOOLARGE");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-REQ-2", file: "delta/auth.md", text: "x".repeat(32768) }),
    ];
    const mocked = vi.mocked(callOpencode);
    mocked.mockResolvedValueOnce(makeAdapterError("prompt_too_large", "attached prompt is too large"));

    const result = await formalize(claims);

    expectClaimPartition(result, [], [0, 1]);
    expect(mocked).toHaveBeenCalledOnce();
    expect(mocked.mock.calls[0]?.[0].files).toHaveLength(1);
    if (result.ok) {
      expect(result.value.errors.every((error) => error.message.includes("attached prompt is too large"))).toBe(true);
    }
  });

  it("normalizes a thrown adapter failure for a single inline claim", async () => {
    traceSpec("FLA-PARTITION-THROW");
    const mocked = vi.mocked(callOpencode);
    mocked.mockRejectedValueOnce(new Error("single inline adapter exploded"));

    const result = await formalize([makeClaim({ id: "AUTH-REQ-1" })]);

    expectClaimPartition(result, [], [0]);
    expect(mocked).toHaveBeenCalledOnce();
    expect(mocked.mock.calls[0]?.[0].files).toBeUndefined();
    if (result.ok) {
      expect(result.value.errors[0]?.claimId).toBe(toClaimId("AUTH-REQ-1"));
      expect(result.value.errors[0]?.message).toContain("single inline adapter exploded");
    }
  });

  it("keeps sibling batch outcomes when one fallback worker throws", async () => {
    traceSpec("FLA-PARTITION-WORKER");
    const claims = [
      makeClaim({ id: "FAILED-REQ-1", file: "failed/auth.md", capability: "failed" }),
      makeClaim({ id: "FAILED-REQ-2", file: "failed/delta.md", capability: "failed" }),
      makeClaim({ id: "SIBLING-REQ-1", file: "sibling/auth.md", capability: "sibling" }),
      makeClaim({ id: "SIBLING-REQ-2", file: "sibling/delta.md", capability: "sibling" }),
    ];
    const mocked = vi.mocked(callOpencode);
    workerFailureState.rejectInlineFallback = true;
    mocked.mockResolvedValueOnce(makeAdapterError("timeout", "attached timeout"));
    mocked.mockResolvedValueOnce({
      ok: true,
      value: {
        formalizations: [
          { index: 2, ...makeValidSample("SIBLING-REQ-1") },
          { index: 3, ...makeValidSample("SIBLING-REQ-2") },
        ],
      },
    });

    const result = await formalize(claims);

    expectClaimPartition(result, [2, 3], [0, 1]);
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls.every(([options]) => options.files !== undefined)).toBe(true);
    if (result.ok) {
      expect(result.value.errors.every((error) => error.message.includes("fallback worker failed"))).toBe(true);
    }
  });
});
