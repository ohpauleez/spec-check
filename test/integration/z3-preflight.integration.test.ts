import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { probeZ3Dependency } from "../../src/adapters/z3.js";
import { isCommandAvailable, runProcess } from "../../src/adapters/process.js";

/** Write an argv-only Node fixture that needs no inherited PATH entry. */
async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${source}`, { flag: "wx", mode: 0o700 });
}

describe.skipIf(process.platform === "win32")("Z3 real-process preflight", () => {
  it("accepts a valid executable and rejects a permission-denied file through both availability paths", async () => {
    traceSpec("CAT-CLI-DEPS", "CAT-DEPS-Z3");
    const root = await mkdtemp(join(tmpdir(), "spec-check-z3-probe-"));
    try {
      const valid = join(root, "valid");
      await executable(valid, "if (process.argv[2] !== '--version') process.exit(99); console.log('Z3 fixture');");
      expect(await probeZ3Dependency(valid)).toEqual({ ok: true, value: undefined });
      expect(isCommandAvailable(valid)).toBe(true);
      const denied = join(root, "not executable");
      await writeFile(denied, "not executable", { mode: 0o600 });
      expect(await probeZ3Dependency(denied)).toMatchObject({ ok: false, error: { kind: "not_executable" } });
      expect(isCommandAvailable(denied)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["dist/src/index.js", "dist/spec-check.js"])("%s stops before analysis on unusable explicit/PATH Z3 and keeps informational commands dependency-free", async (entry) => {
    traceSpec("CAT-CLI-DEPS", "CAT-DEPS-Z3", "CAT-OC-VERSION-INFO");
    const root = await mkdtemp(join(tmpdir(), "spec-check-z3-cli-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const log = join(root, "opencode.jsonl");
      const solverLog = join(root, "z3.jsonl");
      const fakeOpencode = (await readFile("test/fixtures/opencode-compat/fake-opencode.cjs", "utf8")).replace(/^#!.*\n/u, "");
      await executable(join(bin, "opencode"), fakeOpencode);
      // PATH deliberately omits the host tools, so a real solver cannot mask a failure.
      const envOverrides = { PATH: bin, SPEC_CHECK_TEST_LOG: log, SPEC_CHECK_TEST_MAJOR: "2", SPEC_CHECK_TELEMETRY: "1" };
      for (const flag of ["--help", "--version"]) {
        expect((await runProcess(process.execPath, [resolve(entry), flag], { timeoutMs: 5000, envOverrides })).exitCode).toBe(0);
      }
      await expect(readFile(log)).rejects.toThrow();
      const spec = join(root, "openspec", "specs", "preflight", "spec.md");
      await mkdir(join(root, "openspec", "specs", "preflight"), { recursive: true });
      await writeFile(spec, "## Purpose\nPreflight fixture.\n## Requirements\n### Requirement: Ready [READY]\nTHE fixture SHALL respond.\n#### Scenario: Request [REQUEST]\nWHEN called, THE fixture SHALL respond.\n");
      const cases = [
        ["missing", "ENOENT", undefined],
        ["permission", "EACCES", undefined],
        ["path-permission", "EACCES", undefined],
        ["exit", "exit 7", "process.exitCode = 7;"],
        ["signal", "SIGTERM", "process.kill(process.pid, 'SIGTERM');"],
        ["overflow", "16384 captured bytes", "process.stdout.write('x'.repeat(20000)); setInterval(() => {}, 1000);"],
        ["hang", "5000ms", "setInterval(() => {}, 1000);"],
      ] as const;
      for (const [name, diagnostic, source] of cases) {
        const output = join(root, `out-${name}`);
        await mkdir(output);
        await writeFile(join(output, "manifest.json"), "stale completion marker");
        const binary = name === "path-permission" ? join(bin, "z3") : join(root, name);
        if (source !== undefined) {
          await executable(binary, `require('node:fs').appendFileSync(${JSON.stringify(solverLog)}, JSON.stringify(process.argv.slice(2))+'\\n'); ${source}`);
        } else if (name !== "missing") {
          await writeFile(binary, "permission denied", { mode: 0o600 });
        }
        const args = [resolve(entry), spec, "--output", output, ...(name === "path-permission" ? [] : ["--z3", binary])];
        const started = performance.now();
        const result = await runProcess(process.execPath, args, { timeoutMs: 10_000, maxOutputBytes: 1_048_576, envOverrides });
        expect(result.timedOut, result.stderr).toBe(false);
        expect(result.exitCode, result.stderr).toBe(4);
        expect(result.stderr).toContain("DependencyError: Z3 pre-flight failed");
        expect(result.stderr).toContain(name === "path-permission" ? '"z3"' : binary);
        expect(result.stderr).toContain(diagnostic);
        expect(result.stderr).toContain("Check --z3/PATH");
        if (name === "hang") expect(performance.now() - started).toBeLessThan(8000);
        const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { readonly phase: string; readonly status: string });
        expect(events.map(({ phase, status }) => [phase, status])).toEqual([["dependencies", "started"], ["dependencies", "failed"]]);
        await expect(readFile(join(output, "manifest.json"))).rejects.toThrow();
        await expect(readFile(join(output, "metrics.json"))).rejects.toThrow();
      }
      const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { readonly kind: string });
      expect(calls.map(({ kind }) => kind)).toEqual(cases.map(() => "version"));
      const solverCalls = (await readFile(solverLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as readonly string[]);
      expect(solverCalls).toEqual(Array.from({ length: 4 }, () => ["--version"]));
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
