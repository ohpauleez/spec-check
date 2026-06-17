import { describe, expect, it } from "vitest";
import { traceSpec } from "../support/spec-trace.js";
import { createInitialRunState, addFindings, markPhaseCompleted } from "../../src/domain/run-state.js";
import type { Finding } from "../../src/domain/findings.js";

const makeFinding = (desc: string): Finding => ({
  severity: "warning",
  category: "test",
  provenance: { file: "test.md" },
  description: desc,
  evidence: [{ kind: "test", value: "val" }],
});

describe("run-state contracts", () => {
  it("creates initial state with empty findings and phases", () => {
    traceSpec("RAE-FINDINGS-IMMUTABLE");
    const state = createInitialRunState();
    expect(state.findings).toEqual([]);
    expect(state.completedPhases).toEqual([]);
  });

  it("appends findings preserving prior entries", () => {
    traceSpec("RAE-IMMUT-KEEP");
    const s0 = createInitialRunState();
    const f1 = makeFinding("a");
    const f2 = makeFinding("b");
    const s1 = addFindings(s0, [f1]);
    const s2 = addFindings(s1, [f2]);
    expect(s2.findings).toEqual([f1, f2]);
  });

  it("records completed phase names", () => {
    traceSpec("RAE-FINDINGS-IMMUTABLE");
    const state = markPhaseCompleted(createInitialRunState(), "parse");
    expect(state.completedPhases).toEqual(["parse"]);
  });
});
