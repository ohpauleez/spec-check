import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { deriveSpecsFromSource, inferCapability } from "../../src/domain/code-backwards/derive.js";
import { buildCapabilitySuggestionsSection } from "../../src/domain/prompts/informalize.js";
import type { SourceTrace } from "../../src/domain/code-backwards/trace.js";
import { toOutputDirPath } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

vi.mock("../../src/adapters/fs.js", () => ({
  writeOutputAtomic: vi.fn(async () => undefined),
  resolveConfinedOutputPath: vi.fn((outputDir: string, rel: string) => `${outputDir}/${rel}`),
}));

function makeTrace(identifier: string, level: "primary" | "secondary" | "supporting"): SourceTrace {
  return {
    identifier,
    files: [`src/${identifier.toLowerCase()}.ts`],
    level,
  };
}

function makeInformalizationResponse(capabilities: { name: string; requirements: { id: string; text: string; evidence?: string[] }[] }[]) {
  return {
    ok: true as const,
    value: {
      capabilities: capabilities.map((cap) => ({
        name: cap.name,
        description: `Capability ${cap.name}`,
        requirements: cap.requirements.map((req) => ({
          id: req.id,
          text: req.text,
          evidence: req.evidence ?? [],
        })),
      })),
    },
  };
}

describe("derive contract", () => {
  let srcDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    srcDir = await mkdtemp(join(tmpdir(), "spec-check-derive-"));
    await mkdir(join(srcDir, "src"), { recursive: true });
    await writeFile(join(srcDir, "src/pipeline.ts"), "export function run() { return true; }\n", "utf8");
  });

  it("produces EARS-preferring markdown from LLM informalization response", async () => {
    traceSpec("STC-GEN-SPECS", "STC-GEN-CAPABILITY", "STC-GEN-EARS", "STC-GEN-TIMEOUT", "STC-SOURCE-FILE-BUDGET");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue(makeInformalizationResponse([
      {
        name: "cat-pipeline",
        requirements: [
          { id: "CAT-PIPELINE-001", text: "WHEN source files are parsed, THE system SHALL produce a claim graph." },
        ],
      },
    ]));

    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      srcDir,
      model: "test-model",
      timeoutMs: 123456,
      traces: [makeTrace("CAT-PIPELINE-REQ", "primary")],
    });

    expect(output.specs.length).toBe(1);
    expect(output.specs[0]!.markdown).toContain("WHEN");
    expect(output.specs[0]!.markdown).toContain("SHALL");
    expect(output.specs[0]!.markdown).toContain("## ADDED Requirements");
    const call = vi.mocked(callOpencode).mock.calls[0]?.[0];
    expect(call?.timeoutMs).toBe(123456);
    expect(Array.isArray(call?.files)).toBe(true);
    expect((call?.files ?? []).length).toBeGreaterThan(0);
    expect(call?.prompt).toContain("Use attached source files");
  });

  it("returns no specs and warning finding when LLM call fails", async () => {
    traceSpec("STC-GEN-INSUFFICIENT", "STC-GEN-TIMEOUT");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue({
      ok: false,
      error: { kind: "timeout", phase: "code-derived-generation", message: "timed out" },
    });

    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      srcDir,
      model: "test-model",
      timeoutMs: 300000,
      traces: [makeTrace("DOC-GUIDE-REF", "supporting")],
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.category).toBe("code_derived.informalization_failed");
    expect(output.specs.length).toBe(0);
  });

  it("generated output contains source-derived text only (no original requirements)", async () => {
    traceSpec("STC-GEN-BLIND", "STC-SOURCE-FILE-BLIND");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue(makeInformalizationResponse([
      {
        name: "pipeline-core",
        requirements: [
          { id: "PIPELINE-CORE-001", text: "THE system SHALL validate all input files before processing." },
        ],
      },
    ]));

    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      srcDir,
      model: "test-model",
      timeoutMs: 300000,
      traces: [makeTrace("CAT-PIPELINE-REQ", "primary")],
    });

    expect(output.specs[0]!.markdown).toContain("validate");
    // Should reference implementation behavior, not original requirement text
    expect(output.specs[0]!.markdown).not.toContain("original requirement");
  });

  it("persists gen_specs/{capability}.md via writeOutputAtomic", async () => {
    traceSpec("STC-GEN-SPECS");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    vi.mocked(callOpencode).mockResolvedValue(makeInformalizationResponse([
      {
        name: "cat-pipeline",
        requirements: [
          { id: "CAT-PIPELINE-001", text: "WHEN source is parsed, THE system SHALL build graph." },
        ],
      },
    ]));

    await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      srcDir,
      model: "test-model",
      timeoutMs: 300000,
      traces: [makeTrace("CAT-PIPELINE-REQ", "primary")],
    });

    const writeCall = vi.mocked(writeOutputAtomic);
    expect(writeCall).toHaveBeenCalledOnce();
    expect(writeCall.mock.calls[0]![1]).toMatch(/^gen_specs\/.+\.md$/u);
  });

  it("returns multiple capabilities from LLM response", async () => {
    traceSpec("STC-GEN-CAPABILITY");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue(makeInformalizationResponse([
      {
        name: "cat-pipeline",
        requirements: [
          { id: "CAT-PIPELINE-001", text: "WHEN files are cataloged, THE system SHALL track types." },
          { id: "CAT-PIPELINE-002", text: "WHEN parsing fails, THE system SHALL report errors." },
        ],
      },
      {
        name: "fla-solver",
        requirements: [
          { id: "FLA-SOLVER-001", text: "WHEN SMT query times out, THE system SHALL record timeout finding." },
        ],
      },
    ]));

    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      srcDir,
      model: "test-model",
      timeoutMs: 300000,
      traces: [
        makeTrace("CAT-PIPELINE-REQ", "primary"),
        makeTrace("CAT-PIPELINE-OPT", "primary"),
        makeTrace("FLA-SOLVER-TIMEOUT", "primary"),
      ],
    });

    expect(output.specs.length).toBe(2);
    const capabilities = output.specs.map((spec) => spec.capability).sort();
    expect(capabilities).toEqual(["cat-pipeline", "fla-solver"]);
  });

  it("returns empty specs when source directory has no scannable files", async () => {
    traceSpec("STC-GEN-SCOPE");
    const emptyDir = await mkdtemp(join(tmpdir(), "spec-check-derive-empty-"));

    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      srcDir: emptyDir,
      model: "test-model",
      timeoutMs: 300000,
      traces: [],
    });

    expect(output.specs.length).toBe(0);
    expect(output.findings.some((f) => f.category === "code_derived.no_source_files")).toBe(true);
  });

  it("inferCapability extracts first two hyphenated segments", () => {
    traceSpec("STC-GEN-CAPABILITY");
    expect(inferCapability("CAT-PIPELINE-REQ")).toBe("cat-pipeline");
    expect(inferCapability("FLA-SOLVER-TIMEOUT")).toBe("fla-solver");
    expect(inferCapability("SINGLE")).toBe("single");
  });

  it("maps evidence file paths to trace identifiers for sourceIdentifiers", async () => {
    traceSpec("STC-GEN-SPECS");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue(makeInformalizationResponse([
      {
        name: "auth-session",
        requirements: [
          {
            id: "AUTH-SESSION-001",
            text: "WHEN user authenticates, THE system SHALL create session.",
            evidence: ["src/cat-pipeline-req.ts"],
          },
        ],
      },
    ]));

    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      srcDir,
      model: "test-model",
      timeoutMs: 300000,
      traces: [makeTrace("CAT-PIPELINE-REQ", "primary")],
    });

    expect(output.specs[0]!.sourceIdentifiers).toContain("CAT-PIPELINE-REQ");
  });

  it("includes suggested capability names in LLM prompt when provided", async () => {
    traceSpec("STC-GEN-CAPABILITY", "STC-GEN-SUGGEST");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue(makeInformalizationResponse([
      {
        name: "catalog-and-parse",
        requirements: [
          { id: "CAT-PARSE-001", text: "WHEN files are discovered, THE system SHALL classify them." },
        ],
      },
    ]));

    await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      srcDir,
      model: "test-model",
      timeoutMs: 300000,
      traces: [],
      suggestedCapabilities: ["catalog-and-parse", "formalization-and-logic-analysis"],
    });

    const writeCall = vi.mocked(callOpencode);
    expect(writeCall).toHaveBeenCalledOnce();
    const prompt = writeCall.mock.calls[0]![0].prompt;
    expect(prompt).toContain("catalog-and-parse");
    expect(prompt).toContain("formalization-and-logic-analysis");
    expect(prompt).toContain("Known capability names");
  });

  it("omits capability suggestions section when suggestedCapabilities is empty", async () => {
    traceSpec("STC-GEN-CAPABILITY");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue(makeInformalizationResponse([
      {
        name: "cat-pipeline",
        requirements: [
          { id: "CAT-PIPELINE-001", text: "WHEN files are parsed, THE system SHALL build graph." },
        ],
      },
    ]));

    await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      srcDir,
      model: "test-model",
      timeoutMs: 300000,
      traces: [],
      suggestedCapabilities: [],
    });

    const writeCall = vi.mocked(callOpencode);
    const prompt = writeCall.mock.calls[0]![0].prompt;
    expect(prompt).not.toContain("Known capability names");
  });

  it("omits capability suggestions section when suggestedCapabilities is undefined", async () => {
    traceSpec("STC-GEN-CAPABILITY");
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    vi.mocked(callOpencode).mockResolvedValue(makeInformalizationResponse([
      {
        name: "cat-pipeline",
        requirements: [
          { id: "CAT-PIPELINE-001", text: "WHEN files are parsed, THE system SHALL build graph." },
        ],
      },
    ]));

    await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      srcDir,
      model: "test-model",
      timeoutMs: 300000,
      traces: [],
    });

    const writeCall = vi.mocked(callOpencode);
    const prompt = writeCall.mock.calls[0]![0].prompt;
    expect(prompt).not.toContain("Known capability names");
  });
});

describe("buildCapabilitySuggestionsSection", () => {
  it("returns empty string for empty names array", () => {
    expect(buildCapabilitySuggestionsSection([])).toBe("");
  });

  it("formats capability names as a bulleted list with instructions", () => {
    const result = buildCapabilitySuggestionsSection([
      "catalog-and-parse",
      "formalization-and-logic-analysis",
      "spec-traceability",
    ]);

    expect(result).toContain("## Known capability names");
    expect(result).toContain("USE THAT EXACT NAME");
    expect(result).toContain("- catalog-and-parse");
    expect(result).toContain("- formalization-and-logic-analysis");
    expect(result).toContain("- spec-traceability");
    expect(result).toContain("create new capability names");
  });

  it("does not include any requirement text or spec content", () => {
    const result = buildCapabilitySuggestionsSection(["catalog-and-parse"]);

    // Only structural metadata (the name), not requirement text
    expect(result).not.toContain("SHALL");
    expect(result).not.toContain("WHEN");
    expect(result).not.toContain("requirement");
  });
});
