import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  buildBlindPrompt,
  extractRationale,
  runBlindComparison,
} from "../../src/domain/code-backwards/blind-compare.js";
import type { CrossImplicationResult } from "../../src/domain/code-backwards/cross-implication.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

function makeResult(overrides?: Partial<CrossImplicationResult>): CrossImplicationResult {
  return {
    capability: "cat-pipeline",
    claimId: "R1",
    classification: "same",
    forward: "yes",
    reverse: "yes",
    evidencePaths: ["cross_implication/cat-pipeline/R1.forward.smt2"],
    ...overrides,
  };
}

describe("blind-compare contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches rationale finding with classification and LLM-extracted rationale", async () => {
    traceSpec("STC-BLIND-COMPARE", "STC-COMPARE-EXPLAIN", "STC-COMPARE-TIMEOUT");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue({
      ok: true,
      value: { rationale: "Both express the same boolean constraint." },
    });

    const output = await runBlindComparison({
      model: "test-model",
      timeoutMs: 654321,
      results: [makeResult()],
      generatedOnlyContext: [{ capability: "cat-pipeline", claimId: "R1", summary: "System supports pipeline." }],
    });

    expect(output.findings.length).toBe(1);
    const finding = output.findings[0]!;
    expect(finding.category).toBe("code_backwards.blind_explanation");
    expect(finding.evidence.some((e) => e.kind === "rationale" && e.value.includes("boolean constraint"))).toBe(true);
    expect(finding.evidence.some((e) => e.kind === "classification" && e.value === "same")).toBe(true);
    expect(vi.mocked(callOpencode).mock.calls[0]?.[0].timeoutMs).toBe(654321);
  });

  it("uses warning severity for uncertain classifications, info for definitive", async () => {
    traceSpec("STC-COMPARE-FALLBACK");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue({
      ok: true,
      value: { rationale: "Cannot determine." },
    });

    const output = await runBlindComparison({
      model: "test-model",
      timeoutMs: 300000,
      results: [
        makeResult({ classification: "uncertain", claimId: "R1" }),
        makeResult({ classification: "same", claimId: "R2" }),
      ],
      generatedOnlyContext: [
        { capability: "cat-pipeline", claimId: "R1", summary: "a" },
        { capability: "cat-pipeline", claimId: "R2", summary: "b" },
      ],
    });

    expect(output.findings.length).toBe(2);
    const uncertainFinding = output.findings.find((f) =>
      f.evidence.some((e) => e.kind === "classification" && e.value === "uncertain"),
    );
    const sameFinding = output.findings.find((f) =>
      f.evidence.some((e) => e.kind === "classification" && e.value === "same"),
    );
    expect(uncertainFinding!.severity).toBe("warning");
    expect(sameFinding!.severity).toBe("info");
  });

  it("emits blind_boundary_violation error when generated context is missing", async () => {
    traceSpec("STC-COMPARE-BLIND");
    const output = await runBlindComparison({
      model: "test-model",
      timeoutMs: 300000,
      results: [makeResult({ claimId: "MISSING" })],
      generatedOnlyContext: [],
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.category).toBe("code_backwards.blind_boundary_violation");
    expect(output.findings[0]!.severity).toBe("error");
  });

  it("buildBlindPrompt contains only generated-side context", () => {
    traceSpec("STC-COMPARE-BLIND");
    const prompt = buildBlindPrompt(makeResult(), "Generated pipeline behavior.");
    expect(prompt).toContain("Generated pipeline behavior.");
    expect(prompt).toContain("generated-side");
    expect(prompt).toContain("Do not infer or request original requirement text");
  });

  it("buildBlindPrompt includes classification", () => {
    traceSpec("STC-COMPARE-BLIND");
    const prompt = buildBlindPrompt(makeResult({ classification: "weaker" }), "summary");
    expect(prompt).toContain("weaker");
  });

  it("buildBlindPrompt escapes backtick runs in generatedSummary", () => {
    traceSpec("STC-COMPARE-BLIND", "STC-COMPARE-FENCE");
    const maliciousSummary = "Normal text\n```\ninjected fence break\n```\nmore text";
    const prompt = buildBlindPrompt(makeResult(), maliciousSummary);

    // The prompt uses a ```text fence for the summary and a ```json fence in
    // the instructions. If the summary contains unescaped ```, it would
    // prematurely close the text fence. Escaped backticks should prevent this.
    const fenceOpens = (prompt.match(/^```text$/gmu) ?? []).length;
    const fenceCloses = (prompt.match(/^```$/gmu) ?? []).length;
    // One ```text open for the summary; two closes (instruction ```json + summary ```text)
    expect(fenceOpens).toBe(1);
    expect(fenceCloses).toBe(2);
  });

  it("extractRationale returns rationale field, falls back to explanation, defaults", () => {
    traceSpec("STC-COMPARE-EXPLAIN");
    expect(extractRationale({ rationale: "Good match." })).toBe("Good match.");
    expect(extractRationale({ explanation: "Alternate field." })).toBe("Alternate field.");
    expect(extractRationale({})).toBe("No rationale provided");
    expect(extractRationale(null)).toBe("No rationale provided");
    expect(extractRationale("string")).toBe("No rationale provided");
  });

  it("records error finding when callOpencode fails for a claim", async () => {
    traceSpec("STC-BLIND-COMPARE");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue({
      ok: false,
      error: { kind: "spawn_error", phase: "blind-comparison", message: "binary not found" },
    });

    const output = await runBlindComparison({
      model: "test-model",
      timeoutMs: 300000,
      results: [makeResult()],
      generatedOnlyContext: [{ capability: "cat-pipeline", claimId: "R1", summary: "s" }],
    });

    // Graceful degradation: error finding recorded instead of throwing.
    expect(output.findings.some((f) => f.category === "code_backwards.blind_comparison_failure")).toBe(true);
    expect(output.findings.some((f) => f.description.includes("Blind comparison failed"))).toBe(true);
  });
});
