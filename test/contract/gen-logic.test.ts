import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { analyzeGeneratedLogic } from "../../src/domain/code-backwards/gen-logic.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import { toClaimId, toOutputDirPath } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(),
}));

vi.mock("../../src/adapters/fs.js", () => ({
  writeOutputAtomic: vi.fn(async () => undefined),
  resolveConfinedOutputPath: vi.fn((outputDir: string, rel: string) => `${outputDir}/${rel}`),
}));

function makeClaim(claimId: string, obligation: "mandatory" | "advisory" | "informational"): LogicIrClaim {
  return {
    claimId: toClaimId(claimId),
    obligation,
    variables: [{ name: "S", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

function makeGenClaim(capability: string, claimId: string, obligation: "mandatory" | "advisory" | "informational" = "mandatory") {
  return { capability, representative: makeClaim(claimId, obligation) };
}

describe("gen-logic contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to runLogicAnalysis and returns its findings and report", async () => {
    traceSpec("STC-GEN-LOGIC", "STC-LOGIC-REPORT");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await analyzeGeneratedLogic({
      claims: [makeGenClaim("test-cap", "GEN-R1")],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.reportMarkdown).toContain("gen_specs/test-cap");
    expect(output.reportMarkdown).toContain("SAT");
  });

  it("reports internal contradiction in code-derived formalizations", async () => {
    traceSpec("STC-LOGIC-CONTRA");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n(GEN_2DR2__a0)\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await analyzeGeneratedLogic({
      claims: [makeGenClaim("test-cap", "GEN-R2")],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.category).toBe("logic.contradiction");
    expect(output.findings[0]!.severity).toBe("error");
  });

  it("handles solver timeout without blocking", async () => {
    traceSpec("STC-LOGIC-TIMEOUT");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "timeout",
      stdout: "",
      stderr: "",
      exitCode: null,
    });

    const output = await analyzeGeneratedLogic({
      claims: [makeGenClaim("test-cap", "GEN-R3")],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.category).toBe("logic.inconclusive");
  });

  it("groups multiple claims from same capability into one Z3 call", async () => {
    traceSpec("STC-GEN-LOGIC");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    await analyzeGeneratedLogic({
      claims: [
        makeGenClaim("cap-a", "GEN-R4"),
        makeGenClaim("cap-a", "GEN-R5"),
        makeGenClaim("cap-b", "GEN-R6"),
      ],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    // 2 Z3 calls: one for cap-a (2 claims), one for cap-b (1 claim).
    expect(vi.mocked(runZ3Query)).toHaveBeenCalledTimes(2);
  });
});
