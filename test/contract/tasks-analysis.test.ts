import { describe, expect, it } from "vitest";
import { traceSpec } from "../support/spec-trace.js";
import { analyzeTaskSourceConsistency } from "../../src/domain/tasks-analysis.js";
import type { ClaimGraph } from "../../src/domain/claim-graph.js";
import type { SourceTrace } from "../../src/domain/code-backwards/trace.js";

describe("task-source consistency analysis", () => {
  it("reports consistent when task text matches traced identifier", () => {
    traceSpec("STC-TASK-SOURCE", "STC-TASKSRC-MATCH", "CGC-TASK-EVIDENCE");
    const graph: ClaimGraph = {
      claims: [{
        kind: "task_evidence",
        text: "Implemented CAT-CLI-ARGS parsing",
        obligation: "informational",
        provenance: { file: "tasks.md", heading: "Group 1" },
        references: [],
      }],
    };
    const traces: readonly SourceTrace[] = [
      { identifier: "CAT-CLI-ARGS", files: ["src/cli.ts"], level: "primary" },
    ];
    const findings = analyzeTaskSourceConsistency({ claimGraph: graph, traces });
    expect(findings.some((f) => f.category === "task_source.consistent")).toBe(true);
  });

  it("reports discrepancy when task text has no matching trace", () => {
    traceSpec("STC-TASKSRC-CONFLICT", "CGC-TASK-CONFLICT");
    const graph: ClaimGraph = {
      claims: [{
        kind: "task_evidence",
        text: "Implemented feature X without any identifiers",
        obligation: "informational",
        provenance: { file: "tasks.md", heading: "Group 1" },
        references: [],
      }],
    };
    const findings = analyzeTaskSourceConsistency({ claimGraph: graph, traces: [] });
    expect(findings.some((f) => f.category === "task_source.discrepancy")).toBe(true);
  });

  it("skips non-task-evidence claims", () => {
    traceSpec("CGC-TASK-GAP");
    const graph: ClaimGraph = {
      claims: [{
        kind: "requirement",
        text: "SHALL do X",
        obligation: "mandatory",
        provenance: { file: "spec.md" },
        references: [],
      }],
    };
    const findings = analyzeTaskSourceConsistency({ claimGraph: graph, traces: [] });
    expect(findings).toHaveLength(0);
  });
});
