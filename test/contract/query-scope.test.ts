import { describe, expect, it } from "vitest";
import { QueryExecutor, summarizeQueryLedger } from "../../src/domain/formal/query-executor.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import { traceSpec } from "../support/spec-trace.js";

describe("disjoint query execution and scope counts", () => {
  it("separates solver uncertainty from unissued blocked/skipped plans", () => {
    traceSpec("RAE-SCOPE-LEDGER");
    const summary = summarizeQueryLedger([... ["sat", "unsat", "unknown", "timeout", "error", "skipped", "blocked"].map((status) => ({ scope: status, kind: "check", status })), { scope: "batch", kind: "check", status: "skipped", count: 100 }]);
    expect(summary).toEqual({ plannedQueries: 107, executedQueries: 5, satQueries: 1, unsatQueries: 1, skippedQueries: 101, blockedQueries: 1, inconclusiveQueries: 3, unestablishedQueries: 105 });
  });

  it("composed analyses share an actual-script budget only through the supplied executor", async () => {
    const executor = new QueryExecutor({ ...ANALYSIS_LIMITS, queryScripts: 1 }, undefined, undefined, async () => ({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 }));
    const a = () => executor.execute("<merged-spec/cap>", "a", { symbols: [], enums: [], units: [] }, []);
    const b = () => executor.execute("<comparison/cap/permission>", "b", { symbols: [], enums: [], units: [] }, []);
    expect((await a()).status).toBe("executed");
    expect((await b()).status).toBe("skipped");
    expect(summarizeQueryLedger(executor.ledger).executedQueries).toBe(1);
  });
});
