import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { detectOpencodeRuntime } from "../../src/adapters/opencode-runtime.js";
import { runProcess } from "../../src/adapters/process.js";

/** Create one owner-executable Node fixture without invoking a shell.
 * @param path - Fresh fixture destination.
 * @param source - Trusted deterministic test program body.
 * @returns After exclusive creation and executable permission assignment.
 */
async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${source}`, { flag: "wx", mode: 0o700 });
}

describe("OpenCode real process compatibility", () => {
  it("terminates hanging/verbose probes and rejects malformed bytes and non-executable files", async () => {
    traceSpec("CAT-OC-VERSION-REJECT", "CAT-OC-VERSION");
    const root = await mkdtemp(join(tmpdir(), "spec-check-probe-"));
    try {
      const cases = [
        ["hang", "setInterval(() => {}, 1000);", "timeout"],
        ["verbose", "process.stderr.write('x'.repeat(20000)); setInterval(() => {}, 1000);", "output_limit"],
        ["invalid", "process.stdout.write(Buffer.from([0xff]));", "invalid_version"],
        ["exit", "process.stdout.write('2.0.15'); process.exitCode = 1;", "spawn_error"],
      ] as const;
      for (const [name, source, kind] of cases) {
        const path = join(root, name);
        await executable(path, source);
        expect(await detectOpencodeRuntime(path)).toMatchObject({ ok: false, error: { kind } });
      }
      const path = join(root, "not-executable");
      await writeFile(path, "2.0.15");
      await chmod(path, 0o600);
      expect(await detectOpencodeRuntime(path)).toMatchObject({ ok: false, error: { kind: "spawn_error" } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 10_000);

  it.each([1, 2] as const)("runs compiled and bundled pipelines against major %s with one probe each", async (major) => {
    traceSpec("CAT-CLI-DEPS", "CAT-OC-RUNTIME-REUSE", "CAT-OC-INVOKE", "CAT-OC-INVOKE-FAMILY", "RAE-FINAL-PROMPT-PARITY", "RAE-OC-METRICS-SNAPSHOT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-runtime-pipeline-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(join(bin, "opencode"), await readFile("test/fixtures/opencode-compat/fake-opencode.cjs"), { mode: 0o700 });
      await executable(join(bin, "z3"), `const version = process.argv[2] === '--version';
        require('node:fs').appendFileSync(process.env.SPEC_CHECK_TEST_LOG, JSON.stringify({kind: version ? 'z3-version' : 'z3-query'})+'\\n');
        process.stdout.write(version ? 'Z3 fixture\\n' : 'sat\\n'); process.stdin.resume();`);
      const capabilityDir = join(root, "openspec", "specs", "runtime-fixture");
      await mkdir(capabilityDir, { recursive: true });
      const spec = join(capabilityDir, "spec.md");
      await writeFile(spec, ["## Purpose", "Runtime compatibility fixture.", "## ADDED Requirements",
        "### Requirement: First Behavior [OC-REQ-FIRST]", "THE fixture SHALL accept requests.", "**References:**", "- spec.md#Purpose",
        "#### Scenario: First Case [OC-SCEN-FIRST]", "WHEN called, THE fixture SHALL respond.", "",
        "### Requirement: Second Behavior [OC-REQ-SECOND]", "THE fixture SHALL preserve requests.", "**References:**", "- spec.md#Purpose",
        "#### Scenario: Second Case [OC-SCEN-SECOND]", "WHEN repeated, THE fixture SHALL respond.", ""].join("\n"));
      for (const [ordinal, entry] of ["dist/src/index.js", "dist/spec-check.js"].entries()) {
        const output = join(root, `out-${ordinal}`);
        const log = join(root, `calls-${ordinal}.jsonl`);
        const invocation = await runProcess(process.execPath, [resolve(entry), spec, "--output", output], {
          timeoutMs: 30_000, maxOutputBytes: 1_048_576,
          envOverrides: { PATH: `${bin}:${process.env.PATH ?? ""}`, SPEC_CHECK_TEST_MAJOR: String(major), SPEC_CHECK_TEST_LOG: log, SPEC_CHECK_TELEMETRY: "1" },
        });
        expect(invocation.timedOut).toBe(false);
        expect(invocation.exitCode, invocation.stderr).toBeLessThanOrEqual(1);
        expect(invocation.exitCode).not.toBeNull();
        const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { readonly kind: string; readonly report?: boolean; readonly attachedBatch?: boolean });
        expect(calls.filter((call) => call.kind === "version")).toHaveLength(1);
        expect(calls.filter((call) => call.kind === "z3-version")).toHaveLength(1);
        expect(calls.some((call) => call.attachedBatch)).toBe(true);
        expect(calls.filter((call) => call.report)).toHaveLength(1);
        expect(await readFile(join(output, "report.md"), "utf8")).toContain("# Final spec-check Assessment");
        const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { readonly files: readonly { readonly path: string; readonly checksum: string }[] };
        expect(manifest.files.some((file) => file.path === "report.md")).toBe(false);
        for (const file of manifest.files) {
          expect(createHash("sha256").update(await readFile(join(output, file.path))).digest("hex")).toBe(file.checksum);
        }
        const metrics = JSON.parse(await readFile(join(output, "metrics.json"), "utf8")) as { readonly attempts: readonly { readonly opencodeMajor: number; readonly opencodePhase: string }[] };
        expect(metrics.attempts.every((attempt) => attempt.opencodeMajor === major)).toBe(true);
        expect(metrics.attempts.some((attempt) => attempt.opencodePhase === "final-report")).toBe(false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it("rejects unsupported dependencies with exit 4 and performs no analysis, while help/version never probe", async () => {
    traceSpec("CAT-DEPS-OPENCODE", "CAT-OC-VERSION-REJECT", "CAT-OC-VERSION-INFO", "CAT-OC-MODEL-INVALID");
    const root = await mkdtemp(join(tmpdir(), "spec-check-bad-version-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(join(bin, "opencode"), await readFile("test/fixtures/opencode-compat/fake-opencode.cjs"), { mode: 0o700 });
      const log = join(root, "calls.jsonl");
      const envOverrides = { PATH: `${bin}:${process.env.PATH ?? ""}`, SPEC_CHECK_TEST_MAJOR: "3", SPEC_CHECK_TEST_LOG: log };
      const entry = resolve("dist/spec-check.js");
      for (const flag of ["--help", "--version"]) {
        expect((await runProcess(process.execPath, [entry, flag], { timeoutMs: 5000, envOverrides })).exitCode).toBe(0);
      }
      await expect(readFile(log)).rejects.toThrow();
      const invalidModel = await runProcess(process.execPath, [entry, "spec.md", "--model", "provider/model#", "--output", join(root, "out")], { timeoutMs: 5000, envOverrides });
      expect(invalidModel.exitCode).toBe(3);
      await expect(readFile(log)).rejects.toThrow();
      const result = await runProcess(process.execPath, [entry, "spec.md", "--output", join(root, "out")], { timeoutMs: 5000, envOverrides });
      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain("supported major versions are 1 and 2");
      const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { readonly kind: string });
      expect(calls.map((call) => call.kind)).toEqual(["version"]);
      const longSuffix = "a".repeat(15_000);
      const unsupported = await runProcess(process.execPath, [entry, "spec.md", "--output", join(root, "long-out")], {
        timeoutMs: 5000, envOverrides: { ...envOverrides, SPEC_CHECK_TEST_VERSION: `3.0.0+${longSuffix}` },
      });
      expect(unsupported.exitCode).toBe(4);
      expect(unsupported.stderr.length).toBeLessThan(450);
      await executable(join(bin, "z3"), "console.log('z3 fixture');");
      const supported = await runProcess(process.execPath, [entry, "spec.md", "--output", join(root, "supported-out")], {
        timeoutMs: 5000, envOverrides: { ...envOverrides, SPEC_CHECK_TEST_MAJOR: "2", SPEC_CHECK_TEST_VERSION: `2.0.15+${longSuffix}` },
      });
      expect(supported.exitCode).toBe(5); // supported dependency, intentionally missing input
      expect(supported.stderr.split("\n")[0]).toContain("detected; using v2 compatibility");
      expect(supported.stderr.split("\n")[0]?.length).toBeLessThan(400);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
