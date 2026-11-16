import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { traceSpec } from "../support/spec-trace.js";

const hasJava = spawnSync("java", ["-version"], { timeout: 5_000 }).status === 0;

describe.skipIf(!hasJava)("bounded static model verification", () => {
  it("checks generated-only ownership, snapshot preservation and unstable-contributor credit", async () => {
    traceSpec("RAE-VERIFY-MODEL", "FLA-BOUNDS-QUERIES", "STC-ALIGN-BLIND", "RAE-STRENGTH-PARTIAL");
    const output = join(await mkdtemp("/tmp/opencode/boundary-model-"), "results");
    const result = spawnSync("java", ["-jar", resolve("tooling/alloy_v6.2.0.jar"), "exec", "-c", "*", "-t", "none", "-o", output,
      resolve("openspec/changes/archive/2026-11-15-improve-ears-smt-analysis/models/boundary-remediation.als")], { encoding: "utf8", timeout: 90_000 });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(await readFile(join(output, "receipt.json"), "utf8")) as { commands: Record<string, { expects: number; solution?: unknown[] }> };
    const commands = Object.values(receipt.commands);
    expect(commands).toHaveLength(7);
    expect(commands.filter((command) => command.expects === 1)).toHaveLength(3);
    for (const command of commands) expect((command.solution?.length ?? 0) > 0).toBe(command.expects === 1);
  }, 100_000);
  it("finds all positive witnesses and no counterexample in the declared finite scopes", async () => {
    traceSpec("RAE-VERIFY-MODEL");
    const output = join(await mkdtemp(join(tmpdir(), "spec-check-semantic-model-")), "results");
    const result = spawnSync("java", ["-jar", resolve("tooling/alloy_v6.2.0.jar"), "exec", "-c", "*", "-t", "none", "-o", output,
      resolve("openspec/changes/archive/2026-11-15-improve-ears-smt-analysis/models/static-semantics.als")], { encoding: "utf8", timeout: 90_000 });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(await readFile(join(output, "receipt.json"), "utf8")) as { commands: Record<string, { expects: number; solution?: unknown[] }> };
    const commands = Object.values(receipt.commands);
    expect(commands).toHaveLength(7);
    expect(commands.filter((command) => command.expects === 1)).toHaveLength(3);
    expect(commands.filter((command) => command.expects === 1).every((command) => (command.solution?.length ?? 0) > 0)).toBe(true);
    expect(commands.filter((command) => (command.expects ?? 0) === 0)).toHaveLength(4);
    expect(commands.filter((command) => (command.expects ?? 0) === 0).every((command) => (command.solution?.length ?? 0) === 0)).toBe(true);
  }, 100_000);
});
