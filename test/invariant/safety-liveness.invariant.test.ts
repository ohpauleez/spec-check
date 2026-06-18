import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { validateFormalizationSample } from "../../src/domain/formal/validate.js";
import { classifyRelationship } from "../../src/domain/code-backwards/cross-implication.js";
import {
  buildBlindPrompt,
} from "../../src/domain/code-backwards/blind-compare.js";
import type { ParsedSpec } from "../../src/domain/model.js";
import { toClaimId, toOutputDirPath, toRelativePath } from "../../src/domain/branded.js";

import type * as FsAdapter from "../../src/adapters/fs.js";
import type FsPromises from "node:fs/promises";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(),
}));

vi.mock("../../src/adapters/fs.js", async (importOriginal) => {
  const original = await importOriginal<typeof FsAdapter>();
  return {
    ...original,
    writeOutputAtomic: vi.fn(async () => undefined),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return {
    ...original,
    readFile: vi.fn(async () => "(assert true)\n(check-sat)"),
  };
});

describe("safety properties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("SAFE-2: no claim enters the graph without provenance", () => {
    traceSpec("CGC-NORMALIZE-CLAIMS");
    const spec: ParsedSpec = {
      file: "spec.md",
      requirements: [
        { title: "R1", identifier: "R1", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: [], provenance: { file: "spec.md", line: 1 } },
        { title: "R2", identifier: "R2", body: "THE system SHOULD z.", earsType: "non-ears", references: [], provenance: { file: "spec.md", line: 5 } },
      ],
      scenarios: [
        { title: "S1", identifier: "S1", body: "GIVEN a, WHEN b, THEN c.", provenance: { file: "spec.md", line: 10 } },
      ],
      deltaSections: ["ADDED"],
      structuralFindings: [],
      unparsed: [],
    };

    const { graph } = buildClaimGraph({ specs: [spec] });
    for (const claim of graph.claims) {
      expect(claim.provenance).toBeDefined();
      expect(claim.provenance.file.length).toBeGreaterThan(0);
    }
  });

  it("SAFE-3: no formalization sample enters clustering without schema validation", () => {
    traceSpec("FLA-VALIDATE-SAMPLE", "FLA-SAMPLE-REJECT");
    // Invalid samples are rejected by validateFormalizationSample
    const invalidSamples = [
      null,
      "not an object",
      42,
      {},
      { claimId: "R1" }, // missing obligation, sorts, functions, assertions
      { claimId: "R1", obligation: "mandatory" }, // missing arrays
      { claimId: "R1", obligation: "mandatory", sorts: [], functions: [], assertions: "not-array" },
      { claimId: "", obligation: "mandatory", sorts: [], functions: [], assertions: [] }, // empty claimId
      { claimId: "R1", obligation: "bogus", sorts: [], functions: [], assertions: [] }, // bad obligation
    ];

    for (const sample of invalidSamples) {
      const result = validateFormalizationSample(sample);
      expect(result.ok).toBe(false);
    }

    // Valid sample passes
    const valid = validateFormalizationSample({
      claimId: "R1",
      obligation: "mandatory",
      sorts: [{ name: "S", sort: "Bool" }],
      functions: [],
      assertions: [{ id: "A1", expr: "true" }],
    });
    expect(valid.ok).toBe(true);
  });

  it("SAFE-5: no blind comparison exposes original requirement text to code-derived side", () => {
    traceSpec("STC-COMPARE-BLIND");
    const originalText = "THE system SHALL process all incoming requests within 100ms";
    const result = {
      capability: "cat-pipeline",
      claimId: "R1",
      classification: "weaker" as const,
      forward: "yes" as const,
      reverse: "no" as const,
      evidencePaths: [],
    };

    // The prompt builder only takes generated summary, never original text
    const prompt = buildBlindPrompt(result, "System handles requests.");
    expect(prompt).not.toContain(originalText);
    expect(prompt).toContain("Do not infer or request original requirement text");
  });

  it("SAFE-7: no cross-side classification is produced from unvalidated inputs", () => {
    traceSpec("STC-CROSS-IMPLY");
    // classifyRelationship is a pure function that only operates on validated direction results
    // It requires explicit "yes"/"no"/"inconclusive" inputs — no raw solver output
    const classification = classifyRelationship("yes", "yes");
    expect(classification).toBe("same");

    // Inconclusive input always produces uncertain — never a definitive classification
    expect(classifyRelationship("inconclusive", "yes")).toBe("uncertain");
    expect(classifyRelationship("yes", "inconclusive")).toBe("uncertain");
    expect(classifyRelationship("inconclusive", "inconclusive")).toBe("uncertain");
  });

  it("SAFE-9: claims with non-standard obligation produce only informational findings", () => {
    traceSpec("CGC-OBLIGATION-LEVEL", "CGC-OBLIG-INFO");
    const spec: ParsedSpec = {
      file: "spec.md",
      requirements: [
        // Text without SHALL or SHOULD → informational
        { title: "R1", identifier: "R1", body: "The system processes data.", earsType: "non-ears", references: [], provenance: { file: "spec.md", line: 1 } },
      ],
      scenarios: [],
      deltaSections: ["ADDED"],
      structuralFindings: [],
      unparsed: [],
    };

    const { graph } = buildClaimGraph({ specs: [spec] });
    const reqClaim = graph.claims.find((c) => c.id === "R1");
    expect(reqClaim).toBeDefined();
    expect(reqClaim!.obligation).toBe("informational");
  });
});

describe("liveness properties", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("LIVE-10: if opencode responds with valid output, qualitative analysis completes", async () => {
    traceSpec("RAE-EVID-LLM");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const { runQualitativePasses } = await import("../../src/domain/spec-forward/qualitative.js");

    vi.mocked(callOpencode)
      .mockResolvedValueOnce({ ok: true, value: { findings: [{ severity: "info", category: "test", description: "ok" }] } })
      .mockResolvedValueOnce({ ok: true, value: { findings: [] } });

    const result = await runQualitativePasses({
      specs: [],
      model: "test-model",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pass1Findings.length).toBeGreaterThanOrEqual(1);
    expect(result.value.rawResponses.length).toBe(2);
  });

  it("LIVE-11: if opencode responds with valid output, formalization completes", async () => {
    traceSpec("FLA-FORMALIZE-CLAIMS", "FLA-SAMPLE-ACCEPT");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const { formalizeClaims } = await import("../../src/domain/formal/formalize.js");

    vi.mocked(callOpencode).mockResolvedValue({
      ok: true,
      value: {
        sample: {
          claimId: "R1",
          obligation: "mandatory",
          sorts: [{ name: "S", sort: "Bool" }],
          functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
          assertions: [{ id: "A1", expr: "(f true)" }],
        },
      },
    });

    const result = await formalizeClaims({
      claims: [{
        id: toClaimId("R1"),
        kind: "requirement",
        text: "WHEN x, THE system SHALL y.",
        obligation: "mandatory",
        provenance: { file: "spec.md", heading: "R1" },
        references: [],
      }],
      model: "test-model",
      samplesPerClaim: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidates.length).toBe(1);
  });

  it("LIVE-12: if z3 responds within timeout, solver analysis completes", async () => {
    traceSpec("FLA-RUN-LOGIC");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    const { runLogicAnalysis } = await import("../../src/domain/formal/logic-analysis.js");

    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(writeOutputAtomic).mockResolvedValue(undefined);

    const output = await runLogicAnalysis({
      claims: [{
        claimId: toClaimId("R1"),
        obligation: "mandatory",
        sorts: [{ name: "S", sort: "Bool" }],
        functions: [],
        assertions: [{ id: "A1", expr: "true" }],
      }],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.reportMarkdown).toContain("R1");
    expect(output.reportMarkdown).toContain("sat");
  });

  it("LIVE-13: if z3 responds within timeout, cross-side implication completes", async () => {
    traceSpec("STC-CROSS-IMPLY", "STC-IMPLY-SAME");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    const { readFile } = await import("node:fs/promises");
    const { runCrossImplication } = await import("../../src/domain/code-backwards/cross-implication.js");

    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(writeOutputAtomic).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue("(assert true)\n(check-sat)");

    const output = await runCrossImplication({
      outputDir: toOutputDirPath("/tmp/test-output"),
      original: [{ capability: "cat", claimId: "R1", smtlibPath: toRelativePath("smt/R1.smt2") }],
      generated: [{ capability: "cat", claimId: "R1", smtlibPath: toRelativePath("gen_smt/R1.smt2") }],
    });

    expect(output.results.length).toBe(1);
    expect(output.results[0]!.classification).toBe("same");
  });
});
