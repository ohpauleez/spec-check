import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  mkdtemp as ActualMkdtemp,
  rm as ActualRm,
  writeFile as ActualWriteFile,
} from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { callOpencode } from "../../src/adapters/opencode.js";
import type { Claim, ClaimKind } from "../../src/domain/claim-graph.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import {
  buildBatchContextFile,
  hashBatchContext,
  serializeBatchContext,
} from "../../src/domain/formal/batch-transport.js";
import { groupFormalizationClaims } from "../../src/domain/formal/grouping.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<{
    readonly mkdtemp: typeof ActualMkdtemp;
    readonly rm: typeof ActualRm;
    readonly writeFile: typeof ActualWriteFile;
  }>("node:fs/promises");
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

function makeClaim(input: {
  readonly id?: string;
  readonly kind?: ClaimKind;
  readonly capability?: string;
  readonly file?: string;
  readonly text?: string;
} = {}): Claim {
  return {
    ...(input.id === undefined ? {} : { id: toClaimId(input.id) }),
    kind: input.kind ?? "requirement",
    text: input.text ?? "WHEN input arrives, THE system SHALL respond.",
    obligation: "mandatory",
    provenance: { file: input.file ?? "specs/auth/source.md", line: 1 },
    references: [],
    ...(input.capability === undefined ? {} : { capability: toCapabilityName(input.capability) }),
  };
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

function queueSuccessfulBatch(claimIds: readonly string[]): void {
  vi.mocked(callOpencode).mockResolvedValueOnce({
    ok: true,
    value: {
      formalizations: claimIds.map((claimId, index) => ({
        index,
        ...makeValidSample(claimId),
      })),
    },
  });
}

async function formalizeAttached(claims: readonly Claim[]) {
  return formalizeClaims({
    claims,
    model: "evidence-model",
    samplesPerClaim: 1,
    timeoutMs: 300000,
    concurrency: 1,
    logicalFileByCapability: new Map([["auth", "merged/auth.md"]]),
  });
}

function attachedFilePath(): string {
  const options = vi.mocked(callOpencode).mock.calls[0]?.[0];
  const filePath = options?.files?.[0];
  if (filePath === undefined) {
    throw new Error("expected an attached context file");
  }
  return filePath;
}

describe("batch evidence and lifecycle contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    const writtenPaths = vi.mocked(writeFile).mock.calls.map(([filePath]) => filePath);
    const attachedPaths = vi.mocked(callOpencode).mock.calls.flatMap(([options]) => options.files ?? []);
    for (const filePath of [...writtenPaths, ...attachedPaths]) {
      if (typeof filePath === "string") {
        rmSync(dirname(filePath), { recursive: true, force: true });
      }
    }
  });

  it("records complete pointer-only evidence and cleans up after success", async () => {
    traceSpec("FLA-BATCH-EVIDENCE", "FLA-EVIDENCE-METADATA", "FLA-TEMP-SUCCESS");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ capability: "auth", file: "delta/auth.md", text: "WHEN delta input arrives, THE system SHALL respond." }),
    ];
    queueSuccessfulBatch(["AUTH-REQ-1", "AUTH-REQ-2"]);

    const result = await formalizeAttached(claims);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.value.batchAttempts[0];
    expect(evidence).toBeDefined();
    if (evidence === undefined) return;

    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.batchKey).toBe("merged/auth.md");
    expect(evidence.claimIndexes).toEqual([0, 1]);
    expect(evidence.claimIds).toEqual(["AUTH-REQ-1", null]);
    expect(evidence.provenanceFiles).toEqual(["base/auth.md", "delta/auth.md"]);
    expect(evidence.contextSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.promptVariant).toBe("attached-context-v1");
    expect(evidence.model).toBe("evidence-model");
    expect(evidence.subBatchOrdinal).toBe(0);
    expect(evidence.outcome).toEqual({ kind: "success" });
    expect(evidence.cleanup).toBe("succeeded");
    expect(JSON.stringify(evidence)).not.toContain("WHEN delta input arrives");
    expect(Object.keys(evidence)).not.toContain("text");

    const filePath = attachedFilePath();
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(dirname(filePath))).toBe(false);
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toEqual({ encoding: "utf8", mode: 0o600, flag: "wx" });
  });

  it("hashes the exact serialized UTF-8 context bytes", async () => {
    traceSpec("FLA-EVIDENCE-HASH");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md" }),
    ];
    queueSuccessfulBatch(["AUTH-REQ-1", "AUTH-REQ-2"]);

    const result = await formalizeAttached(claims);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.value.batchAttempts[0];
    expect(evidence).toBeDefined();
    if (evidence === undefined) return;

    const group = groupFormalizationClaims(claims, new Map([["auth", "merged/auth.md"]]))[0];
    expect(group).toBeDefined();
    if (group === undefined) return;
    const serialized = serializeBatchContext(buildBatchContextFile(evidence.batchKey, group.claims));
    const expectedHash = createHash("sha256").update(Buffer.from(serialized, "utf8")).digest("hex");

    expect(hashBatchContext(serialized)).toBe(expectedHash);
    expect(evidence.contextSha256).toBe(expectedHash);
  });

  it("reconstructs deleted context from recorded eligible indexes", async () => {
    traceSpec("FLA-EVIDENCE-RECONSTRUCT");
    const claims = [
      makeClaim({ id: "IGNORED-1", kind: "proposal_property", file: "proposal.md" }),
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md", text: "WHEN base input arrives, THE system SHALL respond." }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md", text: "WHEN delta input arrives, THE system SHALL respond." }),
    ];
    queueSuccessfulBatch(["AUTH-REQ-1", "AUTH-REQ-2"]);

    const result = await formalizeAttached(claims);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.value.batchAttempts[0];
    expect(evidence).toBeDefined();
    if (evidence === undefined) return;

    const group = groupFormalizationClaims(claims, new Map([["auth", "merged/auth.md"]]))[0];
    expect(group).toBeDefined();
    if (group === undefined) return;
    const indexedClaims = new Map(
      group.claims.map((indexedClaim) => [indexedClaim.eligibleIndex, indexedClaim] as const),
    );
    const reconstructedClaims = evidence.claimIndexes.map((eligibleIndex) => {
      const indexedClaim = indexedClaims.get(eligibleIndex);
      if (indexedClaim === undefined) {
        throw new Error(`missing preserved claim at eligible index ${String(eligibleIndex)}`);
      }
      return indexedClaim;
    });
    const reconstructed = serializeBatchContext(
      buildBatchContextFile(evidence.batchKey, reconstructedClaims),
    );

    expect(hashBatchContext(reconstructed)).toBe(evidence.contextSha256);
    expect(evidence.claimIndexes).toEqual([0, 1]);
    expect(JSON.stringify(evidence)).not.toContain("base input arrives");
    expect(JSON.stringify(evidence)).not.toContain("delta input arrives");
  });

  it("cleans up and normalizes a thrown attached adapter failure", async () => {
    traceSpec("FLA-TEMP-THROW");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md" }),
    ];
    vi.mocked(callOpencode).mockRejectedValueOnce(new Error("adapter exploded"));

    const result = await formalizeAttached(claims);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toEqual([]);
    expect(result.value.errors).toHaveLength(2);
    expect(result.value.errors.every((error) => error.message.includes("adapter exploded"))).toBe(true);
    expect(result.value.batchAttempts[0]?.outcome).toEqual({
      kind: "transport_failure",
      detail: "formalization adapter threw",
    });
    expect(result.value.batchAttempts[0]?.cleanup).toBe("succeeded");

    const filePath = attachedFilePath();
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(dirname(filePath))).toBe(false);
  });

  it("returns claim errors when temporary directory creation fails", async () => {
    traceSpec("FLA-TEMP-DIRFAIL", "FLA-TEMP-OSUNWRITABLE");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md" }),
    ];
    vi.mocked(mkdtemp).mockRejectedValueOnce(new Error("temporary directory denied"));

    const result = await formalizeAttached(claims);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toEqual([]);
    expect(result.value.errors).toHaveLength(2);
    expect(result.value.errors.every((error) => error.message.includes("temporary directory denied"))).toBe(true);
    expect(result.value.batchAttempts[0]?.outcome).toEqual({
      kind: "transport_failure",
      detail: "temporary directory denied",
    });
    expect(result.value.batchAttempts[0]?.cleanup).toBe("not_attempted");
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(vi.mocked(callOpencode)).not.toHaveBeenCalled();
  });

  it("cleans up after a write failure without masking a cleanup failure", async () => {
    traceSpec("FLA-TEMP-WRITEFAIL", "FLA-TEMP-WRITEFAIL-CLEANUP");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md" }),
    ];
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("context write failed"));
    vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup denied"));

    const result = await formalizeAttached(claims);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toEqual([]);
    expect(result.value.errors).toHaveLength(2);
    expect(result.value.errors.every((error) => {
      return error.message.includes("context write failed") && error.message.includes("cleanup denied");
    })).toBe(true);
    expect(result.value.batchAttempts[0]?.outcome).toEqual({
      kind: "transport_failure",
      detail: "context write failed",
    });
    expect(result.value.batchAttempts[0]?.cleanup).toBe("failed");
    expect(vi.mocked(callOpencode)).not.toHaveBeenCalled();
    expect(vi.mocked(rm)).toHaveBeenCalledOnce();
    expect(vi.mocked(rm).mock.calls[0]?.[1]).toEqual({ recursive: true, force: true });
  });

  it("preserves successful candidates and emits a cleanup warning", async () => {
    traceSpec("FLA-TEMP-CLEANUP-WARN");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md" }),
    ];
    queueSuccessfulBatch(["AUTH-REQ-1", "AUTH-REQ-2"]);
    vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup warning"));

    const result = await formalizeAttached(claims);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(2);
    expect(result.value.errors).toEqual([]);
    expect(result.value.batchAttempts[0]?.outcome).toEqual({ kind: "success" });
    expect(result.value.batchAttempts[0]?.cleanup).toBe("failed");

    const warning = result.value.findings.find((finding) => finding.category === "formalization.temp_cleanup_failed");
    expect(warning).toBeDefined();
    if (warning === undefined) return;
    expect(warning.severity).toBe("warning");
    expect(warning.evidence).toEqual(expect.arrayContaining([
      { kind: "batch_key", value: "merged/auth.md" },
      { kind: "sub_batch_ordinal", value: "0" },
      { kind: "cleanup_error", value: "cleanup warning" },
    ]));
  });
});
