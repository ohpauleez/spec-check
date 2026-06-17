import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { deriveSpecsFromSource } from "../../src/domain/code-backwards/derive.js";
import type { SourceTrace } from "../../src/domain/code-backwards/trace.js";
import { toOutputDirPath } from "../../src/domain/branded.js";

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

describe("derive contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("produces EARS-preferring markdown with WHEN/IF patterns per capability", async () => {
    traceSpec("STC-GEN-SPECS", "STC-GEN-CAPABILITY", "STC-GEN-EARS");
    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      traces: [makeTrace("CAT-PIPELINE-REQ", "primary")],
    });

    expect(output.specs.length).toBe(1);
    expect(output.specs[0]!.markdown).toContain("WHEN");
    expect(output.specs[0]!.markdown).toContain("SHALL");
    expect(output.specs[0]!.markdown).toContain("## ADDED Requirements");
  });

  it("emits limitation finding when capability has only supporting evidence", async () => {
    traceSpec("STC-GEN-INSUFFICIENT");
    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      traces: [makeTrace("DOC-GUIDE-REF", "supporting")],
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.category).toBe("code_derived.insufficient_evidence");
    expect(output.specs.length).toBe(0);
  });

  it("generated output contains source-derived text only", async () => {
    traceSpec("STC-GEN-BLIND");
    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      traces: [makeTrace("CAT-PIPELINE-REQ", "primary")],
    });

    expect(output.specs[0]!.markdown).toContain("CAT-PIPELINE-REQ");
    // Should reference implementation behavior, not original requirement text
    expect(output.specs[0]!.markdown).toContain("implementation");
  });

  it("persists gen_specs/{capability}.md via writeOutputAtomic", async () => {
    traceSpec("STC-GEN-SPECS");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      traces: [makeTrace("CAT-PIPELINE-REQ", "primary")],
    });

    const writeCall = vi.mocked(writeOutputAtomic);
    expect(writeCall).toHaveBeenCalledOnce();
    expect(writeCall.mock.calls[0]![1]).toMatch(/^gen_specs\/.+\.md$/u);
  });

  it("groups traces by inferred capability (first 2 segments)", async () => {
    traceSpec("STC-GEN-CAPABILITY");
    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      traces: [
        makeTrace("CAT-PIPELINE-REQ", "primary"),
        makeTrace("CAT-PIPELINE-OPT", "primary"),
        makeTrace("FLA-SOLVER-TIMEOUT", "primary"),
      ],
    });

    // CAT-PIPELINE groups both, FLA-SOLVER is separate
    expect(output.specs.length).toBe(2);
    const capabilities = output.specs.map((spec) => spec.capability).sort();
    expect(capabilities).toEqual(["cat-pipeline", "fla-solver"]);
  });

  it("excludes capabilities with zero traces after filtering", async () => {
    traceSpec("STC-GEN-SCOPE");
    const output = await deriveSpecsFromSource({
      outputDir: toOutputDirPath("/tmp/test-output"),
      traces: [],
    });

    expect(output.specs.length).toBe(0);
    expect(output.findings.length).toBe(0);
  });
});
