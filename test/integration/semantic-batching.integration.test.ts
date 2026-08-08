import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import { groupRepresentativesBySpec } from "../../src/cli/pipeline-helpers.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import { sanitizeIdentifier } from "../../src/domain/formal/identifiers.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import type { ClaimId } from "../../src/domain/branded.js";

interface OpencodeCall {
  readonly prompt: string;
  readonly files: readonly string[];
}

let calls: OpencodeCall[] = [];

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(async (options: { readonly prompt: string; readonly files?: readonly string[] }) => {
    calls.push({ prompt: options.prompt, files: options.files ?? [] });
    return {
      ok: true,
      value: {
        formalizations: [
          { claimId: "AUTH-1", obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A1", expr: "true" }], index: 0 },
          { claimId: "AUTH-SCENARIO", obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A2", expr: "true" }], index: 1 },
          { claimId: "AUTH-2", obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A3", expr: "true" }], index: 2 },
        ],
      },
    };
  }),
}));

function makeClaim(overrides: Partial<Claim> & { readonly text: string }): Claim {
  const base: Claim = {
    id: toClaimId("DEFAULT"),
    kind: "requirement",
    text: overrides.text,
    obligation: "mandatory",
    provenance: { file: "spec.md" },
    references: [],
  };
  const merged = { ...base, ...overrides };
  if (overrides.id === undefined) {
    const { id: _unused, ...withoutId } = merged;
    void _unused;
    return withoutId as Claim;
  }
  return merged;
}

function buildSample(claimId: string): LogicIrClaim {
  return {
    claimId: claimId as ClaimId,
    obligation: "mandatory",
    variables: [{ name: sanitizeIdentifier("S"), sort: "Bool" }],
    functions: [],
    assertions: [{ id: sanitizeIdentifier("A1"), expr: "true" }],
  };
}

describe("semantic batching integration oracle", () => {
  beforeEach(() => {
    calls = [];
  });

  it("groups spanning base and delta provenance files use one shared semantic key", async () => {
    traceSpec("FLA-SEMGRP-PARITY", "FLA-FORMAL-SPAN");
    const logicalFileByCapability = new Map<string, string>([["auth", "<merged-spec/auth>"]]);

    const claims: Claim[] = [
      makeClaim({ id: toClaimId("AUTH-1"), text: "Base requirement.", capability: toCapabilityName("auth"), provenance: { file: "auth-base.md" } }),
      makeClaim({ id: toClaimId("AUTH-SCENARIO"), kind: "scenario", text: "Scenario from delta.", capability: toCapabilityName("auth"), provenance: { file: "auth-delta.md" } }),
      makeClaim({ id: toClaimId("AUTH-2"), text: "Delta requirement.", capability: toCapabilityName("auth"), provenance: { file: "auth-delta.md" } }),
      makeClaim({ id: toClaimId("OTHER-1"), text: "Other requirement.", provenance: { file: "other.md" } }),
    ];

    const result = await formalizeClaims({
      claims,
      model: "test-model",
      samplesPerClaim: 1,
      timeoutMs: 300000,
      logicalFileByCapability,
      maxBatchSize: 0,
      concurrency: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Parity: formalization produced exactly one attached attempt for the shared key.
    expect(result.value.batchAttempts).toHaveLength(1);
    const attempt = result.value.batchAttempts[0]!;
    expect(attempt.batchKey).toBe("<merged-spec/auth>");
    expect(attempt.claimIds).toEqual(["AUTH-1", "AUTH-SCENARIO", "AUTH-2"]);
    expect(attempt.provenanceFiles).toEqual(["auth-base.md", "auth-delta.md", "auth-delta.md"]);
    expect(attempt.contextSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(attempt.cleanup).toBe("succeeded");

    // Confirm the attached call used the dedicated prompt and a temp directory.
    const attachedCalls = calls.filter((call) => call.files.length > 0);
    expect(attachedCalls).toHaveLength(1);
    const attached = attachedCalls[0]!;
    expect(attached.prompt).toContain("attached JSON context file");
    expect(attached.prompt).toContain("untrusted data");
    expect(attached.prompt).not.toContain("Base requirement.");
    expect(attached.prompt).not.toContain("same spec file");
    expect(attached.prompt).not.toContain("presented below");
    expect(attached.files[0]).toMatch(/spec-check-batch-/u);

    // Solver grouping parity: representatives grouped under the same shared key.
    const candidates = result.value.candidates.filter((candidate) => candidate.claim.capability === toCapabilityName("auth"));
    expect(candidates).toHaveLength(3);
    const representatives: LogicIrClaim[] = candidates.map((candidate) => buildSample(candidate.claim.id ?? "anonymous"));
    const groups = groupRepresentativesBySpec(candidates, representatives, [
      {
        capability: toCapabilityName("auth"),
        sourceFiles: ["auth-base.md", "auth-delta.md"],
        logicalFile: "<merged-spec/auth>",
        requirements: [],
        scenarios: [],
        findings: [],
      },
    ]);

    const authGroup = groups.find((g) => g.specFile === "<merged-spec/auth>");
    expect(authGroup).toBeDefined();
    expect(authGroup!.claims).toHaveLength(3);
  });

  it("temp context directory is removed after a successful attached batch", async () => {
    traceSpec("FLA-TEMP-SUCCESS");
    const { stat } = await import("node:fs/promises");

    const logicalFileByCapability = new Map<string, string>([["auth", "<merged-spec/auth>"]]);
    const result = await formalizeClaims({
      claims: [
        makeClaim({ id: toClaimId("A"), text: "A.", capability: toCapabilityName("auth"), provenance: { file: "a.md" } }),
        makeClaim({ id: toClaimId("B"), text: "B.", capability: toCapabilityName("auth"), provenance: { file: "b.md" } }),
      ],
      model: "test-model",
      samplesPerClaim: 1,
      timeoutMs: 300000,
      logicalFileByCapability,
      maxBatchSize: 0,
      concurrency: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.batchAttempts[0]?.cleanup).toBe("succeeded");

    const attached = calls.find((call) => call.files.length > 0);
    expect(attached).toBeDefined();
    const tempDir = attached!.files[0]!.replace(/\/batch-context\.json$/u, "");
    await expect(stat(tempDir)).rejects.toThrow();
  });

  it("duplicate and missing claim IDs are handled by eligible index", async () => {
    traceSpec("FLA-IDENTITY-DUP", "FLA-IDENTITY-MISSING", "FLA-IDENTITY-INDEX");
    const logicalFileByCapability = new Map<string, string>([["auth", "<merged-spec/auth>"]]);

    vi.mocked(await import("../../src/adapters/opencode.js")).callOpencode.mockResolvedValueOnce({
      ok: true,
      value: {
        formalizations: [
          { claimId: "DUP-ID", obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A1", expr: "true" }], index: 0 },
          { claimId: "DUP-ID", obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A2", expr: "true" }], index: 1 },
          { claimId: "MISSING-ID", obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A3", expr: "true" }], index: 2 },
        ],
      },
    });

    const result = await formalizeClaims({
      claims: [
        makeClaim({ id: toClaimId("DUP-ID"), text: "First.", capability: toCapabilityName("auth"), provenance: { file: "a.md" } }),
        makeClaim({ id: toClaimId("DUP-ID"), text: "Second.", capability: toCapabilityName("auth"), provenance: { file: "b.md" } }),
        makeClaim({ text: "Missing id.", capability: toCapabilityName("auth"), provenance: { file: "c.md" } }),
      ],
      model: "test-model",
      samplesPerClaim: 1,
      timeoutMs: 300000,
      logicalFileByCapability,
      maxBatchSize: 0,
      concurrency: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates).toHaveLength(3);
    expect(result.value.candidates[0]?.claim.id).toBe("DUP-ID");
    expect(result.value.candidates[1]?.claim.id).toBe("DUP-ID");
    expect(result.value.candidates[2]?.claim.id).toBeUndefined();
  });
});
