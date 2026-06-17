import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runLogicAnalysis } from "../../src/domain/formal/logic-analysis.js";
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
    sorts: [{ name: "S", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: "true" }],
  };
}

describe("logic-analysis contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mandatory contradiction (unsat) reported at severity error", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-LOGIC-CORE");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runLogicAnalysis({
      claims: [makeClaim("R1", "mandatory")],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.severity).toBe("error");
    expect(output.findings[0]!.category).toBe("logic.contradiction");
  });

  it("advisory contradiction (unsat) reported at severity warning", async () => {
    traceSpec("FLA-LOGIC-ADVISORY");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runLogicAnalysis({
      claims: [makeClaim("R2", "advisory")],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.severity).toBe("warning");
    expect(output.findings[0]!.category).toBe("logic.contradiction");
  });

  it("timeout/unknown result preserved as inconclusive finding", async () => {
    traceSpec("FLA-LOGIC-TIMEOUT");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "timeout",
      stdout: "",
      stderr: "",
      exitCode: null,
    });

    const output = await runLogicAnalysis({
      claims: [makeClaim("R3", "mandatory")],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(1);
    expect(output.findings[0]!.category).toBe("logic.inconclusive");
    expect(output.findings[0]!.severity).toBe("warning");
  });

  it("persists SMT-LIB input, stdout, stderr for each query", async () => {
    traceSpec("FLA-SOLVER-PERSIST", "FLA-PERSIST-SAT", "FLA-PERSIST-UNSAT");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    await runLogicAnalysis({
      claims: [makeClaim("R4", "mandatory")],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    const writeCall = vi.mocked(writeOutputAtomic);
    // 3 writes per claim: .smt2, .stdout.txt, .stderr.txt
    expect(writeCall).toHaveBeenCalledTimes(3);
    const paths = writeCall.mock.calls.map((call) => call[1]);
    expect(paths.some((p) => p.endsWith(".smt2"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".stdout.txt"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".stderr.txt"))).toBe(true);
  });

  it("report markdown includes per-claim result lines", async () => {
    traceSpec("FLA-RUN-LOGIC");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runLogicAnalysis({
      claims: [makeClaim("R5", "mandatory")],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.reportMarkdown).toContain("R5");
    expect(output.reportMarkdown).toContain("sat");
  });

  it("sat result does not generate contradiction finding", async () => {
    traceSpec("FLA-RUN-LOGIC");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    const output = await runLogicAnalysis({
      claims: [makeClaim("R6", "mandatory")],
      outputDir: toOutputDirPath("/tmp/test-output"),
    });

    expect(output.findings.length).toBe(0);
  });
});
