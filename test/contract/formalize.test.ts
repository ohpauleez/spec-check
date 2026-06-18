import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  buildFormalizationPrompt,
  extractSamplePayload,
  formalizeClaims,
} from "../../src/domain/formal/formalize.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import { toClaimId } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

function makeValidSample(claimId: string) {
  return {
    sample: {
      claimId,
      obligation: "mandatory",
      sorts: [{ name: "State", sort: "Bool" }],
      functions: [{ name: "active", args: ["Bool"], returns: "Bool" }],
      assertions: [{ id: "A1", expr: "(active true)" }],
    },
  };
}

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

describe("formalize contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formalizeClaims produces valid candidates from mock responses", async () => {
    traceSpec("FLA-FORMALIZE-CLAIMS", "FLA-FORMAL-ARTS", "FLA-SAMPLE-ACCEPT");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue({ ok: true, value: makeValidSample("R1") });

    const result = await formalizeClaims({
      claims: [makeClaim()],
      model: "test-model",
      samplesPerClaim: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates.length).toBe(1);
    expect(result.value.candidates[0]!.samples.length).toBe(2);
    expect(result.value.errors.length).toBe(0);
  });

  it("retries sampling when validation rejects and records invalid samples", async () => {
    traceSpec("FLA-SAMPLE-REJECT", "FLA-VALIDATE-SAMPLE");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    // First call is the batch — returns invalid entry so claim falls back to individual.
    // Second call (individual attempt 1) returns invalid, third returns valid.
    mocked
      .mockResolvedValueOnce({ ok: true, value: { formalizations: [{ claimId: "R1", obligation: "mandatory" }] } })
      .mockResolvedValueOnce({ ok: true, value: { sample: { claimId: "R1", obligation: "mandatory" } } })
      .mockResolvedValue({ ok: true, value: makeValidSample("R1") });

    const result = await formalizeClaims({
      claims: [makeClaim()],
      model: "test-model",
      samplesPerClaim: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates[0]!.invalidSamples.length).toBeGreaterThan(0);
    expect(result.value.findings.some((f) => f.category === "formalization.invalid_sample")).toBe(true);
  });

  it("returns error when all samples invalid after max attempts", async () => {
    traceSpec("FLA-SAMPLE-EXHAUST", "FLA-FORMAL-FAIL");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    // Always return an invalid sample (missing required fields)
    vi.mocked(callOpencode).mockResolvedValue({
      ok: true,
      value: { sample: { claimId: "R1" } },
    });

    const result = await formalizeClaims({
      claims: [makeClaim()],
      model: "test-model",
      samplesPerClaim: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates.length).toBe(0);
    expect(result.value.errors.length).toBe(1);
    expect(result.value.errors[0]?.message).toContain("all formalization samples invalid");
  });

  it("returns error when callOpencode fails fatally", async () => {
    traceSpec("FLA-FORMAL-FAIL");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue({
      ok: false,
      error: { kind: "spawn_error", phase: "formalization", message: "binary not found" },
    });

    const result = await formalizeClaims({
      claims: [makeClaim()],
      model: "test-model",
      samplesPerClaim: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates.length).toBe(0);
    expect(result.value.errors.length).toBe(1);
    expect(result.value.errors[0]?.message).toContain("failed to formalize claim");
  });

  it("filters claims to only requirement and scenario kinds", async () => {
    traceSpec("FLA-FORMALIZE-CLAIMS");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    mocked.mockResolvedValue({ ok: true, value: makeValidSample("R1") });

    const result = await formalizeClaims({
      claims: [
        makeClaim({ kind: "requirement", id: toClaimId("R1") }),
        makeClaim({ kind: "proposal_property", id: toClaimId("PP1") }),
        makeClaim({ kind: "scenario", id: toClaimId("S1") }),
        makeClaim({ kind: "assumption", id: toClaimId("A1") }),
      ],
      model: "test-model",
      samplesPerClaim: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only requirement and scenario should be formalized
    expect(result.value.candidates.length).toBe(2);
  });

  it("buildFormalizationPrompt fences claim text as untrusted", () => {
    traceSpec("FLA-FORMAL-ARTS");
    const prompt = buildFormalizationPrompt(makeClaim({ text: "WHEN input, THE system SHALL output." }));
    expect(prompt).toContain("untrusted");
    expect(prompt).toContain("<claim");
    expect(prompt).toContain("```text");
    expect(prompt).toContain("WHEN input, THE system SHALL output.");
    expect(prompt).toContain("</claim>");
  });

  it("returns successful candidates alongside errors on partial failure", async () => {
    traceSpec("FLA-FORMALIZE-CLAIMS", "FLA-FORMAL-PARTIAL");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    // Put claims in different files so they go to separate batches with concurrency: 1.
    // Batch 1 (R1) succeeds via batch response; batch 2 (R2) fails entirely.
    let callCount = 0;
    mocked.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        // Batch call for R1's file: valid batch response
        return { ok: true, value: { formalizations: [makeValidSample("R1").sample] } };
      }
      if (callCount === 2) {
        // Additional sample for R1 (samplesPerClaim: 2)
        return { ok: true, value: makeValidSample("R1") };
      }
      // Batch call and fallback for R2's file: all fail
      return { ok: false, error: { kind: "spawn_error", phase: "formalization", message: "binary not found" } };
    });

    const result = await formalizeClaims({
      claims: [
        makeClaim({ id: toClaimId("R1"), provenance: { file: "spec-a.md", heading: "R1" } }),
        makeClaim({ id: toClaimId("R2"), provenance: { file: "spec-b.md", heading: "R2" } }),
      ],
      model: "test-model",
      samplesPerClaim: 2,
      concurrency: 1,
    });

    // Should return ok with both candidates and errors available
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates.length).toBe(1);
    expect(result.value.errors.length).toBe(1);
    expect(result.value.errors[0]!.message).toContain("failed to formalize claim");
  });

  it("extractSamplePayload extracts from sample, formalization, or returns directly", () => {
    traceSpec("FLA-FORMAL-ARTS");
    // Extracts from sample field
    expect(extractSamplePayload({ sample: { claimId: "R1" } })).toEqual({ claimId: "R1" });
    // Extracts from formalization field
    expect(extractSamplePayload({ formalization: { claimId: "R2" } })).toEqual({ claimId: "R2" });
    // Returns directly if neither field present
    expect(extractSamplePayload({ claimId: "R3" })).toEqual({ claimId: "R3" });
    // Returns non-object directly
    expect(extractSamplePayload("raw")).toBe("raw");
  });
});
