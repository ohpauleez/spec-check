import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  buildReviewPrompt,
  extractFindingsFromResponses,
  fenceDocument,
  normalizeRawFinding,
  runQualitativePasses,
} from "../../src/domain/spec-forward/qualitative.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

describe("qualitative review contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runQualitativePasses calls opencode for both passes and returns merged findings", async () => {
    traceSpec("RAE-EVID-LLM", "RAE-PRESERVE-EVID");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    mocked
      .mockResolvedValueOnce({
        ok: true,
        value: { findings: [{ severity: "warning", category: "gap", description: "missing precondition" }] },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { findings: [{ severity: "info", category: "clarity", description: "ambiguous wording" }] },
      });

    const result = await runQualitativePasses({
      specs: [],
      model: "test-model",
      timeoutMs: 300_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pass1Findings.length).toBe(1);
    expect(result.value.pass2Findings.length).toBe(1);
    expect(result.value.rawResponses.length).toBe(2);
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[0]?.[0].timeoutMs).toBe(300_000);
    expect(Array.isArray(mocked.mock.calls[0]?.[0].files)).toBe(true);
  });

  it("returns error when first pass callOpencode fails", async () => {
    traceSpec("FLA-FORMAL-FAIL");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValueOnce({
      ok: false,
      error: { kind: "timeout", phase: "qualitative-review", message: "timed out" },
    });

    const result = await runQualitativePasses({
      specs: [],
      model: "test-model",
      timeoutMs: 300_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("pass 1 failed");
  });

  it("returns error when second pass callOpencode fails", async () => {
    traceSpec("FLA-FORMAL-FAIL");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const mocked = vi.mocked(callOpencode);
    mocked
      .mockResolvedValueOnce({ ok: true, value: { findings: [] } })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "timeout", phase: "qualitative-properties", message: "timed out" },
      });

    const result = await runQualitativePasses({
      specs: [],
      model: "test-model",
      timeoutMs: 300_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("pass 2 failed");
  });

  it("buildReviewPrompt fences all document content as untrusted", () => {
    traceSpec("RAE-EVID-LLM");
    const bundle = buildReviewPrompt("qualitative_review", {
      proposal: {
        file: "proposal.md",
        sections: new Map([["Scope", { heading: "Scope", lines: ["system shall respond"], startLine: 1, endLine: 2 }]]),
        unparsed: [],
      },
      specs: [],
    });

    expect(bundle.prompt).toContain("untrusted");
    expect(bundle.files).toEqual(["proposal.md"]);
  });

  it("fenceDocument wraps content in document tags with markdown fence", () => {
    traceSpec("STC-COMPARE-BLIND");
    const fenced = fenceDocument("test-label", "some content here");
    expect(fenced).toContain('<document name="test-label">');
    expect(fenced).toContain("```markdown");
    expect(fenced).toContain("some content here");
    expect(fenced).toContain("</document>");
  });

  it("extractFindingsFromResponses normalizes LLM findings with severity/category/provenance", () => {
    traceSpec("RAE-FINDING-SHAPE", "RAE-SHAPE-COMPLETE");
    const findings = extractFindingsFromResponses([
      {
        phase: "qualitative-review",
        response: {
          findings: [
            { severity: "error", category: "gap.missing", description: "no precondition", file: "spec.md" },
          ],
        },
      },
    ]);

    expect(findings.length).toBe(1);
    const finding = findings[0];
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("error");
    expect(finding!.category).toBe("gap.missing");
    expect(finding!.provenance.file).toBe("spec.md");
  });

  it("normalizeRawFinding defaults severity to warning for unknown values", () => {
    traceSpec("RAE-FINDING-SHAPE");
    const finding = normalizeRawFinding(
      { severity: "bogus", category: "test", description: "test finding" },
      "test-phase",
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("normalizeRawFinding returns undefined for non-object input", () => {
    traceSpec("RAE-SHAPE-FAIL");
    expect(normalizeRawFinding("not an object", "test-phase")).toBeUndefined();
    expect(normalizeRawFinding(null, "test-phase")).toBeUndefined();
    expect(normalizeRawFinding(42, "test-phase")).toBeUndefined();
  });

  it("normalizeRawFinding extracts rationale from raw input when present", () => {
    traceSpec("RAE-FINDING-SHAPE", "RAE-SHAPE-COMPLETE");
    const finding = normalizeRawFinding(
      {
        severity: "warning",
        category: "test.check",
        description: "test finding",
        rationale: "explicit rationale from LLM",
        file: "spec.md",
      },
      "test-phase",
    );
    expect(finding).toBeDefined();
    expect(finding!.rationale).toBe("explicit rationale from LLM");
  });

  it("normalizeRawFinding derives rationale fallback when raw input lacks it", () => {
    traceSpec("RAE-FINDING-SHAPE", "RAE-SHAPE-COMPLETE");
    const finding = normalizeRawFinding(
      { severity: "error", category: "test.check", description: "missing something" },
      "review",
    );
    expect(finding).toBeDefined();
    expect(finding!.rationale.length).toBeGreaterThan(0);
    expect(finding!.rationale).toContain("review");
  });
});
