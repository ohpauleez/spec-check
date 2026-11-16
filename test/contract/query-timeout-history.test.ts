import { describe, expect, it } from "vitest";
import { QueryExecutor, summarizeQueryLedger } from "../../src/domain/formal/query-executor.js";
import { EvidenceRecorder, EvidencePersistenceError } from "../../src/domain/formal/evidence.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import type { Z3Result } from "../../src/adapters/z3.js";
import { traceSpec } from "../support/spec-trace.js";

/** Deterministic completion controls; every wait is resolved by the test, not a timer. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("concurrent timeout and partial-evidence histories", () => {
  it.each(["complete", "last-output-fails"])("releases slots after timeout, then preserves exact completed evidence: %s", async (mode) => {
    traceSpec("FLA-BOUNDS-QUERIES", "FLA-PERSIST-ALL", "RAE-EVIDENCE-WRITE");
    const finished = Array.from({ length: 3 }, () => deferred<Z3Result>());
    const started = Array.from({ length: 3 }, () => deferred<void>());
    const scripts: string[] = []; const written = new Map<string, string | Uint8Array>();
    let active = 0; let peak = 0;
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async (path, content) => {
      if (mode === "last-output-fails" && path.endsWith(".output.json") && typeof content === "string" && JSON.parse(content).kind === "step-2") throw new Error("injected output write failure");
      written.set(path, content);
    });
    const executor = new QueryExecutor({ ...ANALYSIS_LIMITS, solverConcurrency: 1 }, evidence, undefined, async (input) => {
      const index = scripts.length; scripts.push(input.smtlib); active += 1; peak = Math.max(peak, active); started[index]!.resolve();
      try { return await finished[index]!.promise; } finally { active -= 1; }
    });
    const jobs = Array.from({ length: 3 }, (_, index) => executor.execute("history", `step-${index}`, { symbols: [], enums: [], units: [] }, [])
      .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })));
    await started[0]!.promise;
    expect(scripts).toHaveLength(1);
    finished[0]!.resolve({ kind: "timeout", stdout: "partial before timeout\n", stderr: "", exitCode: null });
    await started[1]!.promise;
    finished[1]!.resolve({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 });
    await started[2]!.promise;
    finished[2]!.resolve({ kind: "sat", stdout: "sat\n", stderr: "", exitCode: 0 });
    const outcomes = await Promise.all(jobs);
    expect(scripts).toHaveLength(3); expect(active).toBe(0); expect(peak).toBe(1);
    expect(outcomes[0]?.ok && outcomes[0].value.result?.kind).toBe("timeout");
    const outputs = [...written].filter(([path]) => path.endsWith(".output.json")).map(([, content]) => JSON.parse(content as string));
    expect(outputs[0].result.stdout).toBe("partial before timeout\n");
    expect(outputs.map((output) => output.kind)).toEqual(mode === "complete" ? ["step-0", "step-1", "step-2"] : ["step-0", "step-1"]);
    expect(evidence.files().filter((file) => file.path.endsWith(".input.smt2"))).toHaveLength(3);
    expect(evidence.files().filter((file) => file.path.endsWith(".output.json"))).toHaveLength(mode === "complete" ? 3 : 2);
    if (mode === "last-output-fails") expect(!outcomes[2]?.ok && outcomes[2]?.error).toBeInstanceOf(EvidencePersistenceError);
    else expect(summarizeQueryLedger(executor.ledger)).toMatchObject({ plannedQueries: 3, executedQueries: 3, inconclusiveQueries: 1, satQueries: 2 });
    // All three reservations released; failed persistence retains only its already charged bytes.
    expect(evidence.reserve("after-completion", ANALYSIS_LIMITS.evidenceBytes - 65_536)).toBe(true);
  });
});
