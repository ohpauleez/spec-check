import { describe, expect, it } from "vitest";
import { corpus, markdown, variables } from "../../build/smt-impact/corpus.js";
import { expectedSignals } from "../../build/smt-impact/oracle.js";
import { findings, score, type Finding } from "../../build/smt-impact/score.js";
import { aggregate, reviewLabel, type Run } from "../../build/smt-impact/report.js";
import { readFile } from "node:fs/promises";
import { sha256 } from "../../build/smt-impact/collect.js";

describe("paired SMT experiment oracle and scoring", () => {
  it("has opaque model-visible identities, eight near-neighbor mechanisms and fixed independent expectations", () => {
    const cases = corpus();
    expect(cases).toHaveLength(16);
    expect(new Set(cases.map((test) => test.capability)).size).toBe(16);
    expect(new Set(cases.map((test) => test.mechanism)).size).toBe(8);
    for (const test of cases) {
      expect(markdown(test)).not.toContain(test.id);
      expect(markdown(test)).not.toMatch(/defect|control/u);
      expect(variables(test).length).toBeLessThanOrEqual(3);
      expect(expectedSignals(test)).toHaveLength(test.id.endsWith("-control") ? 0 : 1);
    }
    expect(cases.filter((test) => test.stratum === "shared-source")).toHaveLength(14);
    expect(cases.filter((test) => test.stratum === "explicit-context")).toHaveLength(2);
    expect(expectedSignals(cases.find((test) => test.id === "multi-defect")!)).toEqual(["activation-conflict"]);
    expect(expectedSignals(cases.find((test) => test.id === "advisory-defect")!)).toEqual(["advisory-conflict"]);
    expect(expectedSignals(cases.find((test) => test.id === "permission-defect")!)).toEqual(["permission-conflict"]);
  });

  it("does not reward duplicate counts, absence after failure, or wrong mandatory modality", () => {
    const cases = corpus();
    const make = (category: string): Finding => ({ severity: "error", category, description: "diagnosis", related: "EXP-CASE01-R0", evidence: "" });
    const activation = cases[0]!;
    expect(score(activation, [make("logic.activation_conflict"), make("logic.activation_conflict")], true).hits).toEqual(["activation-conflict"]);
    expect(score(cases[1]!, [], false).useful).toBe(false);
    const advisory = cases.find((test) => test.id === "advisory-defect")!;
    expect(score(advisory, [make("logic.contradiction")], true)).toMatchObject({ hits: [], falseSignals: ["mandatory-conflict"], useful: false });
    expect(score(advisory, [{ ...make("logic.contradiction"), severity: "warning" }], true).hits).toEqual([]);
    const potential = make("logic.potential_gap");
    expect(score(cases.find((test) => test.id === "multi-control")!, [potential], true).falseSignals).toEqual([]);
  });

  it("extracts actual core findings without treating scope headings or silence as diagnoses", () => {
    const parsed = findings("# Logic\n- [error] logic.activation_conflict: incompatible activation\n  - evidence: query=semantic\\_evidence/a.input.smt2\n  - related: EXP-CASE01-R0\n\n## Formal Analysis Scope\n- candidates: 2\n");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ category: "logic.activation_conflict", related: "EXP-CASE01-R0" });
  });

  it("averages repeated cases instead of changing the experimental unit", () => {
    const test = corpus()[0]!;
    const run: Run = { arm: "current", caseId: test.id, stratum: test.stratum, repetition: 0, elapsedMs: 1, exitCode: 0, timedOut: false, directory: "unused",
      observation: { score: score(test, [], true), metrics: null, queries: 1, modelCalls: 1, outputBytes: 1, linked: [], findings: [], uncertainDiagnostics: 0,
        manifest: { complete: true, entries: 0, problems: [] }, candidates: 2, totalStatements: 2, candidateCoverageBasis: "fixture", solverProcessMs: 1, modelProcessMs: 1,
        usage: { events: 0, complete: false, inputTokens: null, outputTokens: null, reasoningTokens: null, reportedCost: null }, scopeCounts: null, reportHash: null } };
    const summary = aggregate([run, run, run], "shared-source");
    expect(summary.arms[1]).toMatchObject({ cases: 1, runs: 3, recall: 0 });
    expect(summary.decision).toContain("inconclusive"); // No paired negative controls or older arm.
  });

  it("review labels do not systematically reveal the arm through execution counterbalancing", () => {
    expect(new Set(corpus().map((test) => reviewLabel(test.capability, "older")))).toEqual(new Set(["A", "B"]));
    for (const test of corpus()) expect(reviewLabel(test.capability, "older")).not.toBe(reviewLabel(test.capability, "current"));
  });

  it("retains measured corpus and baseline identity without claiming absent usage is free", async () => {
    const measured = JSON.parse(await readFile("experiments/smt-impact/measurement.json", "utf8"));
    expect(sha256(JSON.stringify(corpus()))).toBe(measured.controlled.corpusSha256);
    expect(sha256(await readFile(measured.olderSource))).toBe(measured.olderSha256);
    expect(measured.controlled.cliExecutions).toBe(measured.controlled.cases * measured.controlled.repetitionsPerCasePerArm * 2);
    expect(measured.live.cliExecutions).toBe(measured.live.cases * measured.live.repetitionsPerCasePerArm * 2);
    expect(measured.live.usage.totalCost).toBeNull();
    expect(measured.humanReview).toContain("unfilled");
  });
});
