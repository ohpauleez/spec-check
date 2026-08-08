import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import { toClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import type FsPromises from "node:fs/promises";
import type Fs from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof Fs>();
  return {
    ...original,
    get rmSync() {
      return fsMocks.rmSync;
    },
  };
});

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

const fsMocks = {
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  rmSync: vi.fn(),
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

function okBatchResponse(claimId: string) {
  return {
    ok: true as const,
    value: {
      formalizations: [{
        claimId,
        obligation: "mandatory",
        variables: [{ name: "S", sort: "Bool" }],
        functions: [],
        assertions: [{ id: "A1", expr: "true" }],
        index: 0,
      }],
    },
  };
}

function errOpencode(kind: "timeout" | "invalid_json" | "schema_validation_error" | "spawn_error" | "invalid_files" | "invalid_timeout" | "prompt_too_large") {
  return {
    ok: false as const,
    error: { kind, phase: "formalization" as const, message: `${kind} failure` },
  };
}

function okSingleResponse(claimId: string) {
  return {
    ok: true as const,
    value: {
      sample: {
        claimId,
        obligation: "mandatory",
        variables: [{ name: "S", sort: "Bool" }],
        functions: [],
        assertions: [{ id: "A1", expr: "true" }],
      },
    },
  };
}

const EMPTY_MAP = new Map<string, string>();

describe("formalization fault injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.mkdtemp.mockReset();
    fsMocks.rm.mockReset();
    fsMocks.rmSync.mockReset();
    fsMocks.writeFile.mockReset();
  });

  it("batch timeout degrades to per-claim inline retry", async () => {
    traceSpec("FLA-DEGRADE-TIMEOUT");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    mocked
      .mockResolvedValueOnce(errOpencode("timeout"))
      .mockResolvedValue(okSingleResponse("R1"));

    fsMocks.mkdtemp.mockResolvedValue("/tmp/spec-check-batch-abc123");
    fsMocks.writeFile.mockResolvedValue(undefined);
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
    expect(result.value.candidates).toHaveLength(2);
    expect(result.value.errors).toHaveLength(0);
    expect(mocked.mock.calls.filter((c) => c[0].files !== undefined).length).toBe(1);
  });

  it("batch spawn_error does not degrade", async () => {
    traceSpec("FLA-DEGRADE-SPAWN");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    mocked.mockResolvedValue(errOpencode("spawn_error"));

    fsMocks.mkdtemp.mockResolvedValue("/tmp/spec-check-batch-abc123");
    fsMocks.writeFile.mockResolvedValue(undefined);
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
    expect(result.value.candidates).toHaveLength(0);
    expect(result.value.errors).toHaveLength(2);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("temp directory creation failure yields claim errors and no cleanup", async () => {
    traceSpec("FLA-TEMP-DIRFAIL", "FLA-TEMP-OSUNWRITABLE");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue(okBatchResponse("R1"));
    fsMocks.mkdtemp.mockRejectedValue(new Error("OS temp not writable"));

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
    expect(result.value.candidates).toHaveLength(0);
    expect(result.value.errors).toHaveLength(2);
    expect(fsMocks.rm).not.toHaveBeenCalled();
    expect(result.value.batchAttempts[0]?.cleanup).toBe("not_attempted");
  });

  it("temp write failure after directory creation attempts cleanup", async () => {
    traceSpec("FLA-TEMP-WRITEFAIL", "FLA-TEMP-WRITEFAIL-CLEANUP");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue(okBatchResponse("R1"));
    fsMocks.mkdtemp.mockResolvedValue("/tmp/spec-check-batch-abc123");
    fsMocks.writeFile.mockRejectedValue(new Error("disk full"));
    fsMocks.rmSync.mockReturnValue(undefined);

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
    expect(result.value.candidates).toHaveLength(0);
    expect(result.value.errors).toHaveLength(2);
    expect(fsMocks.rmSync).toHaveBeenCalled();
  });

  it("thrown adapter failure still triggers temp cleanup", async () => {
    traceSpec("FLA-TEMP-THROW", "FLA-PARTITION-THROW");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockRejectedValueOnce(new Error("unexpected throw"));
    fsMocks.mkdtemp.mockResolvedValue("/tmp/spec-check-batch-abc123");
    fsMocks.writeFile.mockResolvedValue(undefined);
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
    expect(result.value.errors).toHaveLength(2);
    expect(fsMocks.rm).toHaveBeenCalled();
  });

  it("cleanup failure after success preserves candidates and emits warning", async () => {
    traceSpec("FLA-TEMP-CLEANUP-WARN");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue(okBatchResponse("R1"));
    fsMocks.mkdtemp.mockResolvedValue("/tmp/spec-check-batch-abc123");
    fsMocks.writeFile.mockResolvedValue(undefined);
    fsMocks.rm.mockRejectedValue(new Error("cleanup failed"));

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
    expect(result.value.candidates).toHaveLength(1);
    expect(result.value.findings.some((f) => f.category === "formalization.temp_cleanup_failed")).toBe(true);
    expect(result.value.batchAttempts[0]?.cleanup).toBe("failed");
  });

  it("unknown response index degrades per claim", async () => {
    traceSpec("FLA-ATTACHP-INDEX-VALID");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    mocked
      .mockResolvedValueOnce({
        ok: true,
        value: {
          formalizations: [
            { claimId: "R1", obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A1", expr: "true" }], index: 999 },
          ],
        },
      })
      .mockResolvedValue(okSingleResponse("R1"));

    fsMocks.mkdtemp.mockResolvedValue("/tmp/spec-check-batch-abc123");
    fsMocks.writeFile.mockResolvedValue(undefined);
    fsMocks.rm.mockResolvedValue(undefined);

    const result = await formalizeClaims({
      claims: [makeClaim({ id: toClaimId("R1") })],
      model: "test-model",
      samplesPerClaim: 1,
      timeoutMs: 300000,
      logicalFileByCapability: EMPTY_MAP,
      concurrency: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(1);
  });
});
