import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runLogicAnalysis, type SpecClaimGroup } from "../../src/domain/formal/logic-analysis.js";
import { toClaimId, toOutputDirPath } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(),
}));

vi.mock("../../src/adapters/fs.js", () => ({
  writeOutputAtomic: vi.fn(async () => undefined),
  resolveConfinedOutputPath: vi.fn((outputDir: string, rel: string) => `${outputDir}/${rel}`),
}));

function group(specFile: string, claimIds: readonly string[], artifactKey?: string): SpecClaimGroup {
  return {
    specFile,
    ...(artifactKey === undefined ? {} : { artifactKey }),
    claims: claimIds.map((claimId) => ({
      claimId: toClaimId(claimId),
      obligation: "mandatory",
      variables: [{ name: "S", sort: "Bool" as const }],
      functions: [],
      assertions: [{ id: "A1", expr: "true" }],
    })),
  };
}

describe("merge logic routing contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs one logic group per merged capability and detects contradictions in one run", async () => {
    traceSpec("FLA-RUN-LOGIC", "STC-LOGIC-CONTRA");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query)
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n(CAP_A_1__a0)\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n(CAP_A_1__a0)\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n(CAP_B_1__a0)\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ kind: "unsat", stdout: "unsat\n(CAP_B_1__a0)\n", stderr: "", exitCode: 0 });

    const output = await runLogicAnalysis({
      groups: [
        group("<merged-spec/cap-a>", ["CAP-A-1", "CAP-A-2"], "merged-spec-cap-a"),
        group("<merged-spec/cap-b>", ["CAP-B-1"], "merged-spec-cap-b"),
      ],
      outputDir: toOutputDirPath("/tmp/merge-logic-routing"),
    });

    expect(vi.mocked(runZ3Query)).toHaveBeenCalledTimes(4);
    expect(output.findings.some((finding) => finding.category === "logic.contradiction" && finding.provenance.file === "<merged-spec/cap-a>")).toBe(true);
    expect(output.findings.some((finding) => finding.category === "logic.contradiction" && finding.provenance.file === "<merged-spec/cap-b>")).toBe(true);
  });

  it("writes logic artifacts under synthetic merged logicalFile artifact key", async () => {
    traceSpec("FLA-SOLVER-PERSIST", "STC-LOGIC-REPORT");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    const { writeOutputAtomic } = await import("../../src/adapters/fs.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    await runLogicAnalysis({
      groups: [group("<merged-spec/cap-a>", ["CAP-A-1"], "merged-spec-cap-a")],
      outputDir: toOutputDirPath("/tmp/merge-logic-routing"),
    });

    const paths = vi.mocked(writeOutputAtomic).mock.calls.map((call) => call[1]);
    expect(paths.some((path) => path.includes("smt/merged-spec-cap-a.smt2"))).toBe(true);
  });
});
