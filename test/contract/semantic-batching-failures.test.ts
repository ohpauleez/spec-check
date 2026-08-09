import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mapBounded } from "../../src/adapters/concurrency.js";
import { callOpencode, type OpencodeError } from "../../src/adapters/opencode.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import {
  formalizeClaims,
  type FormalizationOutput,
} from "../../src/domain/formal/formalize.js";
import type { Result } from "../../src/domain/result.js";
import { traceSpec } from "../support/spec-trace.js";

const workerFailureState = vi.hoisted(() => ({ rejectInlineFallback: false }));

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

vi.mock("../../src/adapters/concurrency.js", async () => {
  const actual = await vi.importActual<{ readonly mapBounded: typeof mapBounded }>(
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
      return await actual.mapBounded(items, concurrency, fn);
    }),
  };
});

const degradableKinds = [
  ["timeout", "FLA-DEGRADE-TIMEOUT"],
  ["invalid_json", "FLA-DEGRADE-JSON"],
  ["schema_validation_error", "FLA-DEGRADE-SCHEMA"],
] as const satisfies readonly (readonly [OpencodeError["kind"], string])[];

const infrastructureKinds = [
  ["spawn_error", "FLA-DEGRADE-SPAWN"],
  ["invalid_files", "FLA-DEGRADE-FILES"],
  ["invalid_timeout", "FLA-DEGRADE-INVTIMEOUT"],
] as const satisfies readonly (readonly [OpencodeError["kind"], string])[];

const TEMP_DIRECTORY = "/tmp/spec-check-batch-injected";

const invalidControls = [
  ["samplesPerClaim", -1],
  ["samplesPerClaim", Number.NaN],
  ["samplesPerClaim", Number.POSITIVE_INFINITY],
  ["samplesPerClaim", Number.NEGATIVE_INFINITY],
  ["samplesPerClaim", 1.5],
  ["samplesPerClaim", Number.MAX_SAFE_INTEGER + 1],
  ["samplesPerClaim", Number.MIN_SAFE_INTEGER - 1],
  ["concurrency", -1],
  ["concurrency", Number.NaN],
  ["concurrency", Number.POSITIVE_INFINITY],
  ["concurrency", Number.NEGATIVE_INFINITY],
  ["concurrency", 1.5],
  ["concurrency", Number.MAX_SAFE_INTEGER + 1],
  ["concurrency", Number.MIN_SAFE_INTEGER - 1],
  ["maxBatchSize", -1],
  ["maxBatchSize", Number.NaN],
  ["maxBatchSize", Number.POSITIVE_INFINITY],
  ["maxBatchSize", Number.NEGATIVE_INFINITY],
  ["maxBatchSize", 0.5],
  ["maxBatchSize", Number.MAX_SAFE_INTEGER + 1],
  ["maxBatchSize", Number.MIN_SAFE_INTEGER - 1],
] as const;

function isIndexedWorkerItem(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "claim" in value
    && "index" in value;
}

function makeClaim(input: {
  readonly id: string;
  readonly text?: string;
  readonly file?: string;
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

function makeValidSample(claimId: string) {
  return {
    claimId: toClaimId(claimId),
    obligation: "mandatory",
    variables: [{ name: "State", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

function makeAdapterError(
  kind: OpencodeError["kind"],
  message: string,
): Result<unknown, OpencodeError> {
  return {
    ok: false,
    error: { kind, phase: "formalization", message },
  };
}

function inlineSampleResponse(claimId: string): Result<unknown, OpencodeError> {
  return {
    ok: true,
    value: { sample: makeValidSample(claimId) },
  };
}

function claimIdFromInlinePrompt(prompt: string): string {
  const match = /<claim id="([^"]+)"/u.exec(prompt);
  if (match?.[1] === undefined) {
    throw new Error("inline fallback prompt lacks a claim ID");
  }
  return match[1];
}

function attachedSampleResponse(claims: readonly Claim[] = makeClaims()): Result<unknown, OpencodeError> {
  return {
    ok: true,
    value: {
      formalizations: claims.map((claim, index) => ({
        index,
        ...makeValidSample(claim.id ?? `CLAIM-${String(index)}`),
      })),
    },
  };
}

async function formalize(
  claims: readonly Claim[] = makeClaims(),
  samplesPerClaim = 1,
): Promise<Result<FormalizationOutput, readonly { readonly message: string }[]>> {
  return await formalizeClaims({
    claims,
    model: "failure-test-model",
    samplesPerClaim,
    timeoutMs: 300_000,
    concurrency: 1,
    logicalFileByCapability: new Map([
      ["auth", "merged/auth.md"],
      ["failed", "merged/failed.md"],
      ["sibling", "merged/sibling.md"],
    ]),
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

describe("semantic batching fault injection", () => {
  beforeEach(() => {
    workerFailureState.rejectInlineFallback = false;
    vi.mocked(callOpencode).mockReset();
    vi.mocked(mapBounded).mockClear();
    vi.mocked(mkdtemp).mockReset();
    vi.mocked(mkdtemp).mockResolvedValue(TEMP_DIRECTORY);
    vi.mocked(writeFile).mockReset();
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(rm).mockReset();
    vi.mocked(rm).mockResolvedValue(undefined);
  });

  describe("control validation boundary", () => {
    it.each(invalidControls)("rejects %s=%s before adapter, filesystem, or worker effects", async (control, value) => {
      traceSpec("FLA-SUBBATCH-INVALID");
      const input = {
        claims: makeClaims(),
        model: "failure-test-model",
        samplesPerClaim: 1,
        timeoutMs: 300_000,
        concurrency: 1,
        maxBatchSize: 0,
        logicalFileByCapability: new Map([["auth", "merged/auth.md"]]),
      };

      const result = await formalizeClaims({ ...input, [control]: value });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual([{ message: `${control} must be a safe integer >= ${control === "maxBatchSize" ? "0" : "1"}` }]);
      expect(mapBounded).not.toHaveBeenCalled();
      expect(callOpencode).not.toHaveBeenCalled();
      expect(mkdtemp).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    });
  });

  describe("adapter error policy", () => {
    it.each(degradableKinds)("degrades attached %s to one inline call per claim", async (kind, specId) => {
      traceSpec("FLA-DEGRADE-KIND", specId);
      const mocked = vi.mocked(callOpencode);
      mocked.mockResolvedValueOnce(makeAdapterError(kind, `attached ${kind} failure`));
      mocked.mockImplementation(async (options) => inlineSampleResponse(claimIdFromInlinePrompt(options.prompt)));

      const result = await formalize();

      expectClaimPartition(result, [0, 1], []);
      expect(mocked).toHaveBeenCalledTimes(3);
      expect(mocked.mock.calls[0]?.[0].files).toHaveLength(1);
      expect(mocked.mock.calls.slice(1).map(([options]) => options.files)).toEqual([undefined, undefined]);
      if (result.ok) {
        expect(result.value.batchAttempts[0]?.outcome).toEqual({ kind: "model_failure", errorKind: kind });
      }
    });

    it.each(infrastructureKinds)("does not fallback after attached %s", async (kind, specId) => {
      traceSpec("FLA-DEGRADE-KIND", specId);
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
      traceSpec("FLA-DEGRADE-KIND", "FLA-DEGRADE-TOOLARGE");
      const mocked = vi.mocked(callOpencode);
      mocked.mockResolvedValueOnce(makeAdapterError("prompt_too_large", "attached prompt is too large"));
      mocked.mockImplementation(async (options) => inlineSampleResponse(claimIdFromInlinePrompt(options.prompt)));

      const result = await formalize();

      expectClaimPartition(result, [0, 1], []);
      expect(mocked).toHaveBeenCalledTimes(3);
      expect(mocked.mock.calls[0]?.[0].files).toHaveLength(1);
      expect(mocked.mock.calls.slice(1).every(([options]) => options.files === undefined)).toBe(true);
      if (result.ok) {
        expect(result.value.batchAttempts[0]?.outcome).toEqual({
          kind: "model_failure",
          errorKind: "prompt_too_large",
        });
      }
    });

    it("does not fallback from prompt_too_large when one complete inline prompt cannot fit", async () => {
      traceSpec("FLA-DEGRADE-KIND", "FLA-DEGRADE-TOOLARGE");
      const claims = [
        makeClaim({ id: "AUTH-REQ-1", file: "base/auth.md" }),
        makeClaim({ id: "AUTH-REQ-2", file: "delta/auth.md", text: "x".repeat(32_768) }),
      ];
      const mocked = vi.mocked(callOpencode);
      mocked.mockResolvedValueOnce(makeAdapterError("prompt_too_large", "attached prompt is too large"));

      const result = await formalize(claims);

      expectClaimPartition(result, [], [0, 1]);
      expect(mocked).toHaveBeenCalledOnce();
      if (result.ok) {
        expect(result.value.errors.every((error) => error.message.includes("attached prompt is too large"))).toBe(true);
      }
    });
  });

  describe("additional sample failures", () => {
    it("retains an attached candidate when its requested additional sample terminally fails", async () => {
      traceSpec("FLA-PARTITION-ADDITIONAL-WARN", "FLA-CLAIM-PARTITION");
      const mocked = vi.mocked(callOpencode);
      mocked
        .mockResolvedValueOnce(attachedSampleResponse())
        .mockResolvedValueOnce(makeAdapterError("timeout", "additional sample timed out"))
        .mockResolvedValueOnce(inlineSampleResponse("AUTH-REQ-2"));

      const result = await formalize(makeClaims(), 2);

      expectClaimPartition(result, [0, 1], []);
      if (!result.ok) return;
      expect(result.value.candidates[0]?.samples).toEqual([makeValidSample("AUTH-REQ-1")]);
      expect(result.value.candidates[1]?.samples).toHaveLength(2);
      expect(result.value.errors.some((error) => error.eligibleIndex === 0)).toBe(false);
      expect(result.value.findings).toContainEqual(expect.objectContaining({
        severity: "warning",
        category: "formalization.additional_sample_failed",
        relatedClaimIdentifiers: [toClaimId("AUTH-REQ-1")],
      }));
    });
  });

  describe("temporary context lifecycle", () => {
    it("turns an unwritable temp directory into errors for every claim", async () => {
      traceSpec("FLA-TEMP-LIFECYCLE", "FLA-TEMP-DIRFAIL", "FLA-TEMP-OSUNWRITABLE", "FLA-CLAIM-PARTITION");
      vi.mocked(mkdtemp).mockRejectedValueOnce(new Error("EACCES: OS temp is not writable"));

      const result = await formalize();

      expectClaimPartition(result, [], [0, 1]);
      expect(writeFile).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(callOpencode).not.toHaveBeenCalled();
      if (result.ok) {
        expect(result.value.errors.every((error) => error.message.includes("EACCES"))).toBe(true);
        expect(result.value.batchAttempts[0]?.outcome).toEqual({
          kind: "transport_failure",
          detail: "EACCES: OS temp is not writable",
        });
        expect(result.value.batchAttempts[0]?.cleanup).toBe("not_attempted");
      }
    });

    it("cleans a created directory before reporting a context write failure", async () => {
      traceSpec("FLA-TEMP-LIFECYCLE", "FLA-TEMP-WRITEFAIL", "FLA-TEMP-ORDER", "FLA-CLAIM-PARTITION");
      vi.mocked(writeFile).mockRejectedValueOnce(new Error("ENOSPC: context write failed"));

      const result = await formalize();

      expectClaimPartition(result, [], [0, 1]);
      expect(rm).toHaveBeenCalledWith(TEMP_DIRECTORY, { recursive: true, force: false });
      expect(vi.mocked(writeFile).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(rm).mock.invocationCallOrder[0] ?? 0);
      expect(callOpencode).not.toHaveBeenCalled();
      if (result.ok) {
        expect(result.value.errors.every((error) => error.message.includes("ENOSPC"))).toBe(true);
        expect(result.value.batchAttempts[0]?.cleanup).toBe("succeeded");
      }
    });

    it("preserves the write failure when partial-state cleanup also fails", async () => {
      traceSpec("FLA-TEMP-LIFECYCLE", "FLA-TEMP-WRITEFAIL", "FLA-TEMP-WRITEFAIL-CLEANUP", "FLA-CLAIM-PARTITION");
      vi.mocked(writeFile).mockRejectedValueOnce(new Error("ENOSPC: primary write failure"));
      vi.mocked(rm).mockRejectedValueOnce(new Error("EPERM: secondary cleanup failure"));

      const result = await formalize();

      expectClaimPartition(result, [], [0, 1]);
      expect(callOpencode).not.toHaveBeenCalled();
      if (result.ok) {
        expect(result.value.errors.every((error) => {
          const primary = error.message.indexOf("ENOSPC: primary write failure");
          const secondary = error.message.indexOf("EPERM: secondary cleanup failure");
          return primary >= 0 && secondary > primary;
        })).toBe(true);
        expect(result.value.batchAttempts[0]?.outcome).toEqual({
          kind: "transport_failure",
          detail: "ENOSPC: primary write failure",
        });
        expect(result.value.batchAttempts[0]?.cleanup).toBe("failed");
      }
    });

    it("removes the temporary context after a successful attached response", async () => {
      traceSpec("FLA-TEMP-LIFECYCLE", "FLA-TEMP-SUCCESS", "FLA-TEMP-ORDER");
      vi.mocked(callOpencode).mockResolvedValueOnce(attachedSampleResponse());

      const result = await formalize();

      expectClaimPartition(result, [0, 1], []);
      expect(rm).toHaveBeenCalledWith(TEMP_DIRECTORY, { recursive: true, force: false });
      if (result.ok) {
        expect(result.value.batchAttempts[0]?.cleanup).toBe("succeeded");
      }
    });

    it("waits for cleanup to terminate before resolving claim outcomes", async () => {
      traceSpec("FLA-TEMP-LIFECYCLE", "FLA-TEMP-ORDER", "FLA-TEMP-TERMINATION");
      vi.mocked(callOpencode).mockResolvedValueOnce(attachedSampleResponse());
      let releaseCleanup: (() => void) | undefined;
      vi.mocked(rm).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
      });

      let settled = false;
      const pending = formalize().then((result) => {
        settled = true;
        return result;
      });
      await vi.waitFor(() => {
        expect(rm).toHaveBeenCalledOnce();
      });

      expect(settled).toBe(false);
      expect(releaseCleanup).toBeTypeOf("function");
      releaseCleanup?.();
      const result = await pending;
      expectClaimPartition(result, [0, 1], []);
    });

    it("stages evidence pointers before temp ownership so later source access cannot drop evidence", async () => {
      traceSpec("FLA-TEMP-LIFECYCLE", "FLA-TEMP-THROW", "FLA-TEMP-ORDER", "FLA-BATCH-EVIDENCE");
      const claims = makeClaims();
      const firstProvenance = claims[0]?.provenance;
      if (firstProvenance === undefined) throw new Error("expected first claim provenance");
      let fileReads = 0;
      Object.defineProperty(firstProvenance, "file", {
        configurable: true,
        enumerable: true,
        get() {
          fileReads += 1;
          if (fileReads > 1) throw new Error("source provenance was read after context construction");
          return "base/auth.md";
        },
      });
      vi.mocked(callOpencode).mockResolvedValueOnce(attachedSampleResponse());

      const result = await formalize(claims);

      expectClaimPartition(result, [0, 1], []);
      expect(callOpencode).toHaveBeenCalledOnce();
      expect(rm).toHaveBeenCalledWith(TEMP_DIRECTORY, { recursive: true, force: false });
      if (result.ok) {
        expect(result.value.batchAttempts).toHaveLength(1);
        expect(result.value.batchAttempts[0]?.provenanceFiles).toEqual(["base/auth.md", "delta/auth.md"]);
      }
    });

    it("preserves successful candidates and emits evidence when cleanup fails", async () => {
      traceSpec("FLA-TEMP-LIFECYCLE", "FLA-TEMP-CLEANUP-WARN", "FLA-TEMP-ORDER", "FLA-CLAIM-PARTITION");
      vi.mocked(callOpencode).mockResolvedValueOnce(attachedSampleResponse());
      vi.mocked(rm).mockRejectedValueOnce(new Error("EPERM: cleanup denied"));

      const result = await formalize();

      expectClaimPartition(result, [0, 1], []);
      if (!result.ok) return;
      const warning = result.value.findings.find((finding) => finding.category === "formalization.temp_cleanup_failed");
      expect(warning).toMatchObject({
        severity: "warning",
        category: "formalization.temp_cleanup_failed",
      });
      expect(warning?.evidence).toEqual(expect.arrayContaining([
        { kind: "batch_key", value: "merged/auth.md" },
        { kind: "sub_batch_ordinal", value: "0" },
        { kind: "cleanup_error", value: "EPERM: cleanup denied" },
        { kind: "context_sha256", value: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ]));
      expect(result.value.batchAttempts[0]?.cleanup).toBe("failed");
      expect(result.value.batchAttempts[0]?.outcome).toEqual({ kind: "success" });
    });
  });

  describe("thrown failures and claim partition", () => {
    it("normalizes an attached adapter throw and still cleans its temporary context", async () => {
      traceSpec("FLA-PARTITION-THROW", "FLA-TEMP-LIFECYCLE", "FLA-TEMP-THROW", "FLA-TEMP-ORDER");
      vi.mocked(callOpencode).mockRejectedValueOnce(new Error("attached adapter exploded"));

      const result = await formalize();

      expectClaimPartition(result, [], [0, 1]);
      expect(rm).toHaveBeenCalledWith(TEMP_DIRECTORY, { recursive: true, force: false });
      if (result.ok) {
        expect(result.value.errors.every((error) => error.message.includes("attached adapter exploded"))).toBe(true);
        expect(result.value.batchAttempts[0]?.outcome).toEqual({
          kind: "transport_failure",
          detail: "formalization adapter threw",
        });
        expect(result.value.batchAttempts[0]?.cleanup).toBe("succeeded");
      }
    });

    it("normalizes a single-claim inline adapter throw without creating temporary state", async () => {
      traceSpec("FLA-PARTITION-THROW", "FLA-CLAIM-PARTITION");
      vi.mocked(callOpencode).mockRejectedValueOnce(new Error("single inline adapter exploded"));

      const result = await formalize([makeClaim({ id: "AUTH-REQ-1" })]);

      expectClaimPartition(result, [], [0]);
      expect(mkdtemp).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(vi.mocked(callOpencode).mock.calls[0]?.[0].files).toBeUndefined();
      if (result.ok) {
        expect(result.value.errors[0]?.claimId).toBe(toClaimId("AUTH-REQ-1"));
        expect(result.value.errors[0]?.message).toContain("single inline adapter exploded");
      }
    });

    it("keeps sibling outcomes and loses no claims when one fallback worker throws", async () => {
      traceSpec("FLA-CLAIM-PARTITION", "FLA-PARTITION-WORKER");
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
});
