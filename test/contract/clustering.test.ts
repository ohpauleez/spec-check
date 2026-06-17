import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  buildEquivalenceClusters,
  clusterFormalizationSamples,
} from "../../src/domain/formal/clustering.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import { toClaimId } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/z3.js", () => ({
  runZ3Query: vi.fn(),
}));

function makeSample(claimId: string, assertionExpr: string): LogicIrClaim {
  return {
    claimId: toClaimId(claimId),
    obligation: "mandatory",
    sorts: [{ name: "X", sort: "Bool" }],
    functions: [],
    assertions: [{ id: "A1", expr: assertionExpr }],
  };
}

describe("clustering contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects representative from stable cluster when threshold met", async () => {
    traceSpec("FLA-CLUSTER-AMBIG", "FLA-CLUSTER-STABLE");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    // Two samples, mutual unsat (equivalent) → single cluster
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "unsat",
      stdout: "unsat\n",
      stderr: "",
      exitCode: 0,
    });

    const { clustered, findings } = await clusterFormalizationSamples({
      claimId: "R1",
      samples: [makeSample("R1", "true"), makeSample("R1", "true")],
      stabilityThreshold: 0.5,
    });

    expect(clustered.ambiguous).toBe(false);
    expect(clustered.representative).toBeDefined();
    expect(clustered.clusters.length).toBe(1);
    expect(findings.length).toBe(0);
  });

  it("emits ambiguity finding when no cluster meets stability threshold", async () => {
    traceSpec("FLA-CLUSTER-AMBIG", "FLA-CLUSTER-DIVERGE");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    // Three samples, all sat (non-equivalent) → three clusters, none meets 0.9 threshold
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "sat",
      stdout: "sat\n",
      stderr: "",
      exitCode: 0,
    });

    const { clustered, findings } = await clusterFormalizationSamples({
      claimId: "R1",
      samples: [
        makeSample("R1", "true"),
        makeSample("R1", "(not true)"),
        makeSample("R1", "(= 1 2)"),
      ],
      stabilityThreshold: 0.9,
    });

    expect(clustered.ambiguous).toBe(true);
    expect(findings.length).toBe(1);
    expect(findings[0]!.category).toBe("formalization.ambiguity");
  });

  it("records inconclusive pairwise result when z3 returns timeout", async () => {
    traceSpec("FLA-CLUSTER-INCON");
    const { runZ3Query } = await import("../../src/adapters/z3.js");
    vi.mocked(runZ3Query).mockResolvedValue({
      kind: "timeout",
      stdout: "",
      stderr: "",
      exitCode: null,
    });

    const { clustered } = await clusterFormalizationSamples({
      claimId: "R1",
      samples: [makeSample("R1", "true"), makeSample("R1", "true")],
      stabilityThreshold: 0.5,
    });

    // Inconclusive means they won't be grouped → ambiguous
    expect(clustered.pairwise.length).toBe(1);
    expect(clustered.pairwise[0]!.leftImpliesRight).toBe("inconclusive");
    expect(clustered.pairwise[0]!.rightImpliesLeft).toBe("inconclusive");
  });

  it("with two equivalent samples (mutual unsat) produces single cluster", () => {
    traceSpec("FLA-CLUSTER-SYMM");
    const clusters = buildEquivalenceClusters(2, [
      {
        leftIndex: 0,
        rightIndex: 1,
        leftImpliesRight: "yes",
        rightImpliesLeft: "yes",
        evidence: {
          leftToRightQuery: "",
          rightToLeftQuery: "",
          leftToRightResult: "",
          rightToLeftResult: "",
        },
      },
    ]);

    expect(clusters.length).toBe(1);
    expect(clusters[0]!.members).toEqual([0, 1]);
  });

  it("with two non-equivalent samples (sat both) produces two clusters", () => {
    traceSpec("FLA-CLUSTER-DIVERGE");
    const clusters = buildEquivalenceClusters(2, [
      {
        leftIndex: 0,
        rightIndex: 1,
        leftImpliesRight: "no",
        rightImpliesLeft: "no",
        evidence: {
          leftToRightQuery: "",
          rightToLeftQuery: "",
          leftToRightResult: "",
          rightToLeftResult: "",
        },
      },
    ]);

    expect(clusters.length).toBe(2);
  });

  it("throws on empty sample set", async () => {
    traceSpec("FLA-CLUSTER-AMBIG");
    await expect(
      clusterFormalizationSamples({
        claimId: "R1",
        samples: [],
        stabilityThreshold: 0.5,
      }),
    ).rejects.toThrow("cannot cluster empty");
  });
});
