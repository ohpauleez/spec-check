import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type FsPromises from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callOpencode } from "../../src/adapters/opencode.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import {
  buildBatchContextFile,
  hashBatchContext,
  serializeBatchContextFile,
} from "../../src/domain/formal/batch-transport.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import { groupFormalizationClaims } from "../../src/domain/formal/grouping.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import { traceSpec } from "../support/spec-trace.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

const LARGE_GROUP_CLAIM_COUNT = 1024;
const PHYSICAL_BATCH_SIZE = 64;
const PHYSICAL_BATCH_COUNT = LARGE_GROUP_CLAIM_COUNT / PHYSICAL_BATCH_SIZE;

// Contract budget: one 1,024-claim context must serialize and hash in 2 seconds.
const SERIALIZATION_HASH_BUDGET_MS = 2_000;
const LARGE_CLAIM_BODY = "payload-".repeat(160);

function makeClaim(index: number): Claim {
  const claimNumber = index + 1;
  return {
    id: toClaimId(`PERF-REQ-${String(claimNumber)}`),
    kind: "requirement",
    text: `WHEN event-${String(claimNumber)} occurs, THE system SHALL preserve ${LARGE_CLAIM_BODY}.`,
    obligation: "mandatory",
    provenance: { file: `sources/performance-${String(claimNumber)}.md`, line: 1 },
    references: [],
    capability: toCapabilityName("performance"),
  };
}

function makeValidSample(claimNumber: number): LogicIrClaim {
  return {
    claimId: toClaimId(`PERF-REQ-${String(claimNumber)}`),
    obligation: "mandatory",
    variables: [{ name: "State", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

describe("semantic batching performance contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const [filePath] of vi.mocked(writeFile).mock.calls) {
      rmSync(dirname(String(filePath)), { force: true, recursive: true });
    }
  });

  it("keeps large context serialization fast and transport work batch-sized", async () => {
    traceSpec("FLA-ATTACH-DETERMINISTIC", "FLA-ATTACH-MULTI", "FLA-SUBBATCH-CHUNKS");
    const claims = Array.from({ length: LARGE_GROUP_CLAIM_COUNT }, (_, index) => makeClaim(index));
    const logicalFileByCapability = new Map([["performance", "merged/performance.md"]]);
    const group = groupFormalizationClaims(claims, logicalFileByCapability)[0];
    expect(group).toBeDefined();
    if (group === undefined) {
      return;
    }

    const startedAt = performance.now();
    const serializedContext = serializeBatchContextFile(buildBatchContextFile(group.logicalFile, group.claims));
    const contextHash = hashBatchContext(serializedContext);
    const elapsedMs = performance.now() - startedAt;

    expect(Buffer.byteLength(serializedContext, "utf8")).toBeGreaterThan(1_000_000);
    expect(contextHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(elapsedMs).toBeLessThan(SERIALIZATION_HASH_BUDGET_MS);

    let attachedBatchNumber = 0;
    const mockedCallOpencode = vi.mocked(callOpencode);
    mockedCallOpencode.mockImplementation(async () => {
      const batchNumber = attachedBatchNumber;
      attachedBatchNumber += 1;
      const firstClaimIndex = batchNumber * PHYSICAL_BATCH_SIZE;
      const batchClaimCount = Math.min(PHYSICAL_BATCH_SIZE, claims.length - firstClaimIndex);
      return {
        ok: true,
        value: {
          formalizations: Array.from({ length: batchClaimCount }, (_, offset) => ({
            index: firstClaimIndex + offset,
            ...makeValidSample(firstClaimIndex + offset + 1),
          })),
        },
      };
    });

    const result = await formalizeClaims({
      claims,
      model: "performance-model",
      samplesPerClaim: 1,
      timeoutMs: 300_000,
      concurrency: 1,
      logicalFileByCapability,
      maxBatchSize: PHYSICAL_BATCH_SIZE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.candidates).toHaveLength(LARGE_GROUP_CLAIM_COUNT);
    expect(result.value.errors).toEqual([]);
    expect(attachedBatchNumber).toBe(PHYSICAL_BATCH_COUNT);

    const writtenPaths = vi.mocked(writeFile).mock.calls.map(([filePath]) => String(filePath));
    const attachedPaths = mockedCallOpencode.mock.calls.flatMap(([options]) => options.files ?? []);
    expect(writtenPaths).toHaveLength(PHYSICAL_BATCH_COUNT);
    expect(attachedPaths).toHaveLength(PHYSICAL_BATCH_COUNT);
    expect(writtenPaths).toEqual(attachedPaths);
    expect(writtenPaths.length).toBeLessThan(claims.length);
    expect(mockedCallOpencode.mock.calls.every(([options]) => options.files?.length === 1)).toBe(true);
  });
});
