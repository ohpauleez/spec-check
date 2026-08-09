import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callOpencode } from "../../src/adapters/opencode.js";
import { toCapabilityName, toClaimId, toOutputDirPath } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import {
  buildBatchContextFile,
  hashBatchContext,
  serializeBatchContextFile,
  type BatchAttemptEvidence,
} from "../../src/domain/formal/batch-transport.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import { groupFormalizationClaims } from "../../src/domain/formal/grouping.js";
import {
  buildFormalizationAttemptSet,
  serializeFormalizationAttemptSet,
  writeFormalizationAttemptSet,
} from "../../src/domain/reporting/formalization-evidence.js";
import { traceSpec } from "../support/spec-trace.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

function makeClaim(input: {
  readonly id?: string;
  readonly capability?: string;
  readonly file?: string;
  readonly text?: string;
  readonly kind?: Claim["kind"];
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

function makeValidSample(claimId: string) {
  return {
    claimId: toClaimId(claimId),
    obligation: "mandatory" as const,
    variables: [{ name: "State", sort: "Bool" as const }],
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
  return await formalizeClaims({
    claims,
    model: "evidence-model",
    samplesPerClaim: 1,
    timeoutMs: 300000,
    concurrency: 1,
    logicalFileByCapability: new Map([["auth", "merged/auth.md"]]),
  });
}

function attachedFilePath(): string {
  const path = vi.mocked(callOpencode).mock.calls[0]?.[0].files?.[0];
  if (path === undefined) throw new Error("expected an attached context file");
  return path;
}

function firstEvidence(
  result: Awaited<ReturnType<typeof formalizeAttached>>,
): BatchAttemptEvidence {
  if (!result.ok) throw new Error("expected formalization boundary success");
  const evidence = result.value.batchAttempts[0];
  if (evidence === undefined) throw new Error("expected batch attempt evidence");
  return evidence;
}

describe("batch evidence and lifecycle contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    const writtenPaths = vi.mocked(writeFile).mock.calls.map(([path]) => path);
    const attachedPaths = vi.mocked(callOpencode).mock.calls.flatMap(([options]) => options.files ?? []);
    for (const path of [...writtenPaths, ...attachedPaths]) {
      if (typeof path === "string") rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("records complete pointer-only evidence, cleans up, and persists no claim text", async () => {
    traceSpec(
      "FLA-BATCH-EVIDENCE",
      "FLA-EVIDENCE-METADATA",
      "FLA-TEMP-SUCCESS",
      "RAE-FORMAL-ATTEMPT-ATOMIC",
    );
    const secretClaimText = "WHEN delta secret 7f93 arrives, THE system SHALL respond.";
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ capability: "auth", file: "delta/auth.md", text: secretClaimText }),
    ];
    queueSuccessfulBatch(["AUTH-REQ-1", "AUTH-REQ-2"]);

    const result = await formalizeAttached(claims);
    const evidence = firstEvidence(result);

    expect(evidence).toEqual({
      batchKey: "merged/auth.md",
      claimIndexes: [0, 1],
      claimIds: ["AUTH-REQ-1", null],
      provenanceFiles: ["base/auth.md", "delta/auth.md"],
      contextSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      promptVariant: "attached-context-v1",
      model: "evidence-model",
      subBatchOrdinal: 0,
      outcome: { kind: "success" },
      cleanup: "succeeded",
    });
    expect(JSON.stringify(evidence)).not.toContain(secretClaimText);
    expect(Object.keys(evidence)).not.toContain("text");
    const filePath = attachedFilePath();
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(dirname(filePath))).toBe(false);
    expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toEqual({ encoding: "utf8", mode: 0o600, flag: "wx" });

    const outDir = await mkdtemp(join(tmpdir(), "spec-check-attempt-evidence-"));
    const attemptSet = buildFormalizationAttemptSet({ kind: "specs_forward" }, [evidence]);
    const descriptor = await writeFormalizationAttemptSet(toOutputDirPath(outDir), attemptSet);
    const evidenceBytes = await readFile(join(outDir, descriptor.path), "utf8");
    expect(evidenceBytes).not.toContain(secretClaimText);
    expect(evidenceBytes).toBe(serializeFormalizationAttemptSet(attemptSet));
    expect(JSON.parse(evidenceBytes)).toEqual({
      schemaVersion: 1,
      claimSet: { kind: "specs_forward" },
      attempts: [evidence],
    });

    const runtimeExtra = { ...evidence, text: secretClaimText };
    expect(serializeFormalizationAttemptSet(
      buildFormalizationAttemptSet({ kind: "specs_forward" }, [runtimeExtra]),
    )).not.toContain(secretClaimText);
  });

  it("hashes the exact canonical UTF-8 context bytes", async () => {
    traceSpec("FLA-EVIDENCE-HASH");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md" }),
    ];
    queueSuccessfulBatch(["AUTH-REQ-1", "AUTH-REQ-2"]);

    const evidence = firstEvidence(await formalizeAttached(claims));
    const group = groupFormalizationClaims(claims, new Map([["auth", "merged/auth.md"]]))[0];
    expect(group).toBeDefined();
    if (group === undefined) return;
    const serialized = serializeBatchContextFile(buildBatchContextFile(evidence.batchKey, group.claims));
    const expected = createHash("sha256").update(Buffer.from(serialized, "utf8")).digest("hex");

    expect(hashBatchContext(serialized)).toBe(expected);
    expect(evidence.contextSha256).toBe(expected);
  });

  it("serializes the production attached context only once", async () => {
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth" }),
    ];
    queueSuccessfulBatch(["AUTH-REQ-1", "AUTH-REQ-2"]);
    const stringify = vi.spyOn(JSON, "stringify");

    await formalizeAttached(claims);

    const contextCalls = stringify.mock.calls.filter(([value]) => {
      return typeof value === "object"
        && value !== null
        && "schemaVersion" in value
        && "batchKey" in value
        && "claims" in value;
    });
    expect(contextCalls).toHaveLength(1);
    stringify.mockRestore();
  });

  it("reconstructs deleted context bytes only within the envelope claim set", async () => {
    traceSpec("FLA-EVIDENCE-RECONSTRUCT");
    const baseText = "WHEN base input arrives, THE system SHALL respond.";
    const deltaText = "WHEN delta input arrives, THE system SHALL respond.";
    const claims = [
      makeClaim({ id: "IGNORED-1", kind: "proposal_property", file: "proposal.md" }),
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md", text: baseText }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md", text: deltaText }),
    ];
    queueSuccessfulBatch(["AUTH-REQ-1", "AUTH-REQ-2"]);

    const evidence = firstEvidence(await formalizeAttached(claims));
    const envelope = buildFormalizationAttemptSet({ kind: "specs_forward" }, [evidence]);
    const group = groupFormalizationClaims(claims, new Map([["auth", "merged/auth.md"]]))[0];
    expect(group).toBeDefined();
    if (group === undefined) return;
    const indexedClaims = new Map(group.claims.map((claim) => [claim.index, claim]));
    const reconstructedClaims = envelope.attempts[0]!.claimIndexes.map((index) => {
      const claim = indexedClaims.get(index);
      if (claim === undefined) throw new Error(`missing preserved claim at eligible index ${String(index)}`);
      return claim;
    });
    const reconstructed = serializeBatchContextFile(buildBatchContextFile(evidence.batchKey, reconstructedClaims));

    expect(hashBatchContext(reconstructed)).toBe(evidence.contextSha256);
    expect(evidence.claimIndexes).toEqual([0, 1]);
    expect(JSON.stringify(evidence)).not.toContain(baseText);
    expect(JSON.stringify(evidence)).not.toContain(deltaText);

    const wrongClaimSet = [
      makeClaim({ id: "OTHER-REQ-1", capability: "auth", text: "Different invocation one" }),
      makeClaim({ id: "OTHER-REQ-2", capability: "auth", text: "Different invocation two" }),
    ];
    const wrongGroup = groupFormalizationClaims(wrongClaimSet, new Map([["auth", "merged/auth.md"]]))[0]!;
    const wrongReconstruction = serializeBatchContextFile(buildBatchContextFile(
      evidence.batchKey,
      evidence.claimIndexes.map((index) => wrongGroup.claims[index]!),
    ));
    expect(hashBatchContext(wrongReconstruction)).not.toBe(evidence.contextSha256);
  });

  it("cleans up and normalizes a thrown attached adapter failure", async () => {
    traceSpec("FLA-TEMP-THROW");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth" }),
    ];
    vi.mocked(callOpencode).mockRejectedValueOnce(new Error("adapter exploded"));

    const result = await formalizeAttached(claims);
    const evidence = firstEvidence(result);

    if (!result.ok) return;
    expect(result.value.candidates).toEqual([]);
    expect(result.value.errors).toHaveLength(2);
    expect(result.value.errors.every((error) => error.message.includes("adapter exploded"))).toBe(true);
    expect(evidence.outcome).toEqual({ kind: "transport_failure", detail: "formalization adapter threw" });
    expect(evidence.cleanup).toBe("succeeded");
    expect(existsSync(attachedFilePath())).toBe(false);
  });

  it("returns claim errors without cleanup when temp directory creation fails", async () => {
    traceSpec("FLA-TEMP-DIRFAIL", "FLA-TEMP-OSUNWRITABLE");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth" }),
    ];
    const group = groupFormalizationClaims(claims, new Map([["auth", "merged/auth.md"]]))[0];
    if (group === undefined) throw new Error("expected semantic group");
    const expectedHash = hashBatchContext(serializeBatchContextFile(
      buildBatchContextFile(group.logicalFile, group.claims),
    ));
    vi.mocked(mkdtemp).mockRejectedValueOnce(new Error("temporary directory denied"));

    const result = await formalizeAttached(claims);
    const evidence = firstEvidence(result);

    if (!result.ok) return;
    expect(result.value.candidates).toEqual([]);
    expect(result.value.errors).toHaveLength(2);
    expect(result.value.errors.every((error) => error.message.includes("temporary directory denied"))).toBe(true);
    expect(evidence.outcome).toEqual({ kind: "transport_failure", detail: "temporary directory denied" });
    expect(evidence.cleanup).toBe("not_attempted");
    expect(evidence.contextSha256).toBe(expectedHash);
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(callOpencode).not.toHaveBeenCalled();
  });

  it("reports write and cleanup failures without masking either", async () => {
    traceSpec("FLA-TEMP-WRITEFAIL", "FLA-TEMP-WRITEFAIL-CLEANUP");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth" }),
    ];
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("context write failed"));
    vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup denied"));

    const result = await formalizeAttached(claims);
    const evidence = firstEvidence(result);

    if (!result.ok) return;
    expect(result.value.errors).toHaveLength(2);
    expect(result.value.errors.every((error) => {
      return error.message.includes("context write failed") && error.message.includes("cleanup denied");
    })).toBe(true);
    expect(evidence.outcome).toEqual({ kind: "transport_failure", detail: "context write failed" });
    expect(evidence.cleanup).toBe("failed");
    expect(callOpencode).not.toHaveBeenCalled();
    expect(vi.mocked(rm)).toHaveBeenCalledWith(expect.any(String), { recursive: true, force: false });
  });

  it("preserves candidates and emits a warning when success cleanup fails", async () => {
    traceSpec("FLA-TEMP-CLEANUP-WARN");
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth" }),
    ];
    queueSuccessfulBatch(["AUTH-REQ-1", "AUTH-REQ-2"]);
    vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup warning"));

    const result = await formalizeAttached(claims);
    const evidence = firstEvidence(result);

    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(2);
    expect(result.value.errors).toEqual([]);
    expect(evidence.outcome).toEqual({ kind: "success" });
    expect(evidence.cleanup).toBe("failed");
    const warning = result.value.findings.find((finding) => finding.category === "formalization.temp_cleanup_failed");
    expect(warning?.severity).toBe("warning");
    expect(warning?.evidence).toEqual(expect.arrayContaining([
      { kind: "batch_key", value: "merged/auth.md" },
      { kind: "sub_batch_ordinal", value: "0" },
      { kind: "cleanup_error", value: "cleanup warning" },
    ]));
  });

  it("captures and freezes evidence metadata before cleanup", async () => {
    const claims = [
      makeClaim({ id: "AUTH-REQ-1", capability: "auth", file: "base/auth.md" }),
      makeClaim({ id: "AUTH-REQ-2", capability: "auth", file: "delta/auth.md" }),
    ];
    queueSuccessfulBatch(["AUTH-REQ-1", "AUTH-REQ-2"]);
    vi.mocked(rm).mockImplementationOnce(async () => {
      (claims[0]!.provenance as { file: string }).file = "mutated-during-cleanup.md";
    });

    const evidence = firstEvidence(await formalizeAttached(claims));

    expect(evidence.provenanceFiles).toEqual(["base/auth.md", "delta/auth.md"]);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.provenanceFiles)).toBe(true);
    expect(evidence.cleanup).toBe("succeeded");
  });
});
