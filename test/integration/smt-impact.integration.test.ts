import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/adapters/process.js";
import { sha256 } from "../../build/smt-impact/collect.js";

describe("actual previous/current binary experiment", () => {
  it("runs real Z3 with fixed interpretations, opaque identical inputs and auditable paired results", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-check-impact-")); const output = join(root, "bundle");
    const result = await runProcess(process.execPath, ["dist/build/smt-impact.js", "--mode", "controlled", "--cases", "activation-defect,activation-control", "--repetitions", "1", "--output", output], { timeoutMs: 60_000, maxOutputBytes: 1_048_576 });
    expect(result.exitCode, result.stderr).toBe(0);
    const identity = JSON.parse(await readFile(join(output, "identity.json"), "utf8"));
    expect(identity.binaries[0].sha256).toBe(sha256(await readFile("pasture/spec-check.older")));
    expect(identity.binaries[1].sha256).toBe(sha256(await readFile("dist/spec-check.js")));
    const results = JSON.parse(await readFile(join(output, "results.json"), "utf8"));
    expect(results.runs).toHaveLength(4);
    const original = results.runs.find((run: { arm: string; caseId: string }) => run.arm === "older" && run.caseId === "activation-defect");
    const current = results.runs.find((run: { arm: string; caseId: string }) => run.arm === "current" && run.caseId === "activation-defect");
    expect(original.observation.score.observed).toEqual([]);
    expect(current.observation.score.observed).toEqual(["activation-conflict"]);
    expect(current.observation.queries).toBeGreaterThan(original.observation.queries);
    expect(current.observation.usage.reportedCost).toBeNull();
    const manifest = JSON.parse(await readFile(join(output, "experiment-manifest.json"), "utf8"));
    for (const file of manifest.files) expect(sha256(await readFile(join(output, file.path))), file.path).toBe(file.sha256);
  }, 65_000);
});
