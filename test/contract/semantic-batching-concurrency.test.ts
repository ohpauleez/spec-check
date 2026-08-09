import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpencodeError } from "../../src/adapters/opencode.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import type { Result } from "../../src/domain/result.js";
import { traceSpec } from "../support/spec-trace.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

function makeClaim(id: string, file: string, capability = "auth"): Claim {
  return {
    id: toClaimId(id),
    kind: "requirement",
    text: `WHEN ${id} is requested, THE system SHALL provide a result.`,
    obligation: "mandatory",
    provenance: { file, line: 1 },
    references: [],
    capability: toCapabilityName(capability),
  };
}

function makeValidSample(id: string): LogicIrClaim {
  return {
    claimId: toClaimId(id),
    obligation: "mandatory",
    variables: [{ name: "State", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

function makeAttachedResponse(entries: readonly { readonly index: number; readonly id: string }[]): Result<unknown, OpencodeError> {
  return {
    ok: true,
    value: {
      formalizations: entries.map(({ index, id }) => ({
        index,
        ...makeValidSample(id),
      })),
    },
  };
}

function makeAdapterError(kind: OpencodeError["kind"], message: string): Result<never, OpencodeError> {
  return {
    ok: false,
    error: {
      kind,
      phase: "formalization",
      message,
    },
  };
}

function inlineClaimId(prompt: string): string {
  const match = /<claim id="([^"]+)"/u.exec(prompt);
  if (match?.[1] === undefined) {
    throw new Error("inline formalization prompt did not identify a claim");
  }
  return match[1];
}

describe("semantic batching concurrency contracts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("bounds adapter calls while attached failures use inline fallback", async () => {
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    const claims = Array.from({ length: 4 }, (_, groupIndex) => [
      makeClaim(
        `GROUP${String(groupIndex + 1)}-REQ-1`,
        `group-${String(groupIndex + 1)}.md`,
        `group-${String(groupIndex + 1)}`,
      ),
      makeClaim(
        `GROUP${String(groupIndex + 1)}-REQ-2`,
        `group-${String(groupIndex + 1)}.md`,
        `group-${String(groupIndex + 1)}`,
      ),
    ]).flat();
    const configuredConcurrency = 2;
    let activeCalls = 0;
    let maximumActiveCalls = 0;

    mocked.mockImplementation(async (options) => {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      try {
        await delay(options.files === undefined ? 1 : 3);
        if (options.files !== undefined) {
          return makeAdapterError("timeout", "attached batch timed out");
        }
        const id = inlineClaimId(options.prompt);
        return { ok: true, value: { sample: makeValidSample(id) } };
      } finally {
        activeCalls -= 1;
      }
    });

    const result = await formalizeClaims({
      claims,
      model: "test-model",
      samplesPerClaim: 1,
      timeoutMs: 300_000,
      concurrency: configuredConcurrency,
      logicalFileByCapability: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(maximumActiveCalls).toBe(configuredConcurrency);
    expect(activeCalls).toBe(0);
    expect(mocked.mock.calls.filter(([options]) => options.files !== undefined)).toHaveLength(4);
    expect(mocked.mock.calls.filter(([options]) => options.files === undefined)).toHaveLength(8);
    expect(result.value.errors).toEqual([]);
    expect(result.value.candidates.map((candidate) => candidate.eligibleIndex)).toEqual(
      Array.from({ length: claims.length }, (_, index) => index),
    );
  });

  it("keeps attribution and output order independent of completion interleaving", async () => {
    traceSpec("FLA-IDENTITY-ORDER");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    const claims = [
      makeClaim("GROUP-A-REQ-1", "group-a.md", "group-a"),
      makeClaim("GROUP-A-REQ-2", "group-a.md", "group-a"),
      makeClaim("GROUP-B-REQ-1", "group-b.md", "group-b"),
      makeClaim("GROUP-B-REQ-2", "group-b.md", "group-b"),
      makeClaim("GROUP-C-REQ-1", "group-c.md", "group-c"),
      makeClaim("GROUP-C-REQ-2", "group-c.md", "group-c"),
    ];
    const completionOrder: string[] = [];

    mocked.mockImplementation(async (options) => {
      if (options.files !== undefined) {
        const contextPath = options.files[0];
        if (contextPath === undefined) {
          throw new Error("attached call missing context path");
        }
        const context = JSON.parse(await readFile(contextPath, "utf8")) as { readonly batchKey?: unknown };
        if (context.batchKey === "<merged-spec/group-a>") {
          await delay(30);
          completionOrder.push("group-a");
          return makeAttachedResponse([
            { index: 1, id: "GROUP-A-REQ-2" },
            { index: 0, id: "GROUP-A-REQ-1" },
          ]);
        }
        if (context.batchKey === "<merged-spec/group-b>") {
          await delay(1);
          completionOrder.push("group-b-attached");
          return makeAdapterError("timeout", "group b attached response timed out");
        }
        await delay(5);
        completionOrder.push("group-c");
        return makeAttachedResponse([
          { index: 5, id: "GROUP-C-REQ-2" },
          { index: 4, id: "GROUP-C-REQ-1" },
        ]);
      }

      const id = inlineClaimId(options.prompt);
      if (id === "GROUP-B-REQ-1") {
        await delay(20);
        completionOrder.push("group-b-success");
        return { ok: true, value: { sample: makeValidSample(id) } };
      }
      await delay(1);
      completionOrder.push("group-b-failure");
      return makeAdapterError("spawn_error", "group b inline fallback failed");
    });

    const result = await formalizeClaims({
      claims,
      model: "test-model",
      samplesPerClaim: 1,
      timeoutMs: 300_000,
      concurrency: 3,
      logicalFileByCapability: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(completionOrder.indexOf("group-c")).toBeLessThan(completionOrder.indexOf("group-a"));
    expect(result.value.candidates.map((candidate) => ({
      index: candidate.eligibleIndex,
      claimId: candidate.samples[0]?.claimId,
    }))).toEqual([
      { index: 0, claimId: toClaimId("GROUP-A-REQ-1") },
      { index: 1, claimId: toClaimId("GROUP-A-REQ-2") },
      { index: 2, claimId: toClaimId("GROUP-B-REQ-1") },
      { index: 4, claimId: toClaimId("GROUP-C-REQ-1") },
      { index: 5, claimId: toClaimId("GROUP-C-REQ-2") },
    ]);
    expect(result.value.errors.map((error) => ({
      index: error.eligibleIndex,
      claimId: error.claimId,
    }))).toEqual([{ index: 3, claimId: toClaimId("GROUP-B-REQ-2") }]);
  });

  it("isolates a thrown attached-group failure from a concurrently successful sibling", async () => {
    traceSpec("FLA-PARTITION-WORKER");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    const claims = [
      makeClaim("FAILED-GROUP-REQ-1", "failed-group.md", "failed-group"),
      makeClaim("FAILED-GROUP-REQ-2", "failed-group.md", "failed-group"),
      makeClaim("SIBLING-GROUP-REQ-1", "sibling-group.md", "sibling-group"),
      makeClaim("SIBLING-GROUP-REQ-2", "sibling-group.md", "sibling-group"),
    ];
    let attachedCallNumber = 0;

    mocked.mockImplementation(async (options) => {
      if (options.files === undefined) {
        throw new Error("a failed attached group must not start inline fallback");
      }
      const groupNumber = attachedCallNumber;
      attachedCallNumber += 1;
      if (groupNumber === 0) {
        await delay(1);
        throw new Error("failed attached group");
      }
      await delay(10);
      return makeAttachedResponse([
        { index: 3, id: "SIBLING-GROUP-REQ-2" },
        { index: 2, id: "SIBLING-GROUP-REQ-1" },
      ]);
    });

    const result = await formalizeClaims({
      claims,
      model: "test-model",
      samplesPerClaim: 1,
      timeoutMs: 300_000,
      concurrency: 2,
      logicalFileByCapability: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.candidates.map((candidate) => candidate.claim.id)).toEqual([
      toClaimId("SIBLING-GROUP-REQ-1"),
      toClaimId("SIBLING-GROUP-REQ-2"),
    ]);
    expect(result.value.errors.map((error) => ({
      index: error.eligibleIndex,
      claimId: error.claimId,
    }))).toEqual([
      { index: 0, claimId: toClaimId("FAILED-GROUP-REQ-1") },
      { index: 1, claimId: toClaimId("FAILED-GROUP-REQ-2") },
    ]);
    expect(mocked.mock.calls.filter(([options]) => options.files === undefined)).toHaveLength(0);
  });
});
