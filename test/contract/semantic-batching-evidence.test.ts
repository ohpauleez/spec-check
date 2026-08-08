import { describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import { buildBatchContextFile, serializeBatchContextFile, sha256HexString } from "../../src/domain/formal/transport.js";
import { toClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import type FsPromises from "node:fs/promises";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

const fsMocks = {
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
};

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return {
    ...original,
    get mkdtemp() {
      return fsMocks.mkdtemp;
    },
    get rm() {
      return fsMocks.rm;
    },
    get writeFile() {
      return fsMocks.writeFile;
    },
  };
});

function makeClaim(overrides?: Partial<Claim>): Claim {
  return {
    kind: "requirement",
    text: "WHEN x, THE system SHALL y.",
    obligation: "mandatory",
    provenance: { file: "spec.md", heading: "R1" },
    references: [],
    id: toClaimId("R1"),
    ...overrides,
  };
}

const EMPTY_MAP = new Map<string, string>();

describe("semantic batching evidence", () => {
  it("records batch attempt evidence for attached attempts", async () => {
    traceSpec("FLA-BATCH-EVIDENCE", "FLA-EVIDENCE-METADATA");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue({
      ok: true,
      value: {
        formalizations: [{
          claimId: "R1",
          obligation: "mandatory",
          variables: [{ name: "S", sort: "Bool" }],
          functions: [],
          assertions: [{ id: "A1", expr: "true" }],
          index: 0,
        }],
      },
    });
    fsMocks.mkdtemp.mockResolvedValue("/tmp/spec-check-batch-abc123");
    fsMocks.writeFile.mockImplementation(async () => {
      // Capture what was written without persisting.
      return Promise.resolve();
    });
    fsMocks.rm.mockResolvedValue(undefined);

    const result = await formalizeClaims({
      claims: [makeClaim({ id: toClaimId("R1") }), makeClaim({ id: toClaimId("R2") })],
      model: "test-model",
      samplesPerClaim: 1,
      timeoutMs: 300000,
      logicalFileByCapability: EMPTY_MAP,
      concurrency: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.batchAttempts.length).toBeGreaterThan(0);
    const evidence = result.value.batchAttempts[0]!;
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.claimIndexes).toEqual([0, 1]);
    expect(evidence.claimIds).toEqual(["R1", "R2"]);
    expect(evidence.provenanceFiles).toEqual(["spec.md", "spec.md"]);
    expect(evidence.contextSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.promptVariant).toBe("attached-batch-v1");
    expect(evidence.model).toBe("test-model");
    expect(evidence.subBatchOrdinal).toBe(0);
    expect(evidence.outcome.kind).toBe("success");
    expect(evidence.cleanup).toBe("succeeded");
  });

  it("context hash matches recomputed hash from serialized bytes", () => {
    traceSpec("FLA-EVIDENCE-HASH");
    const context = buildBatchContextFile("key", [
      { claim: makeClaim({ id: toClaimId("R1"), text: "claim text" }), eligibleIndex: 3 },
    ]);
    const serialized = serializeBatchContextFile(context);
    expect(sha256HexString(serialized)).toBe(sha256HexString(serializeBatchContextFile(context)));
  });

  it("deleted context is byte-reconstructable from preserved claims", () => {
    traceSpec("FLA-EVIDENCE-RECONSTRUCT");
    const claims = [
      { claim: makeClaim({ id: toClaimId("R1"), text: "first claim" }), eligibleIndex: 0 },
      { claim: makeClaim({ id: toClaimId("R2"), text: "second claim" }), eligibleIndex: 1 },
    ];
    const originalContext = buildBatchContextFile("<merged-spec/auth>", claims);
    const serialized = serializeBatchContextFile(originalContext);
    const originalHash = sha256HexString(serialized);

    // Reconstruct from preserved claim text and re-serialize deterministically.
    const reconstructed = buildBatchContextFile("<merged-spec/auth>", claims);
    const reconstructedHash = sha256HexString(serializeBatchContextFile(reconstructed));

    expect(reconstructedHash).toBe(originalHash);
  });
});
