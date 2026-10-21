import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { callOpencode, extractOpencodeUsage } from "../../src/adapters/opencode.js";
import { buildFinalReportAgentConfig } from "../../src/adapters/opencode-protocol.js";
import { runProcess } from "../../src/adapters/process.js";
import { resolveRunConfig } from "../../src/cli/config.js";
import { parseArgv } from "../../src/cli/parse-argv.js";
import { createTelemetryCollector, runWithTelemetryCollector, snapshotCurrentTelemetry } from "../../src/adapters/telemetry.js";

vi.mock("../../src/adapters/process.js", () => ({ runProcess: vi.fn() }));
const result = { exitCode: 0, signal: null, stdout: '{"type":"text","part":{"text":"{\\"findings\\":[]}"}}', stderr: "", timedOut: false } as const;

describe("versioned OpenCode protocol", () => {
  beforeEach(() => { vi.mocked(runProcess).mockReset(); });

  it.each([1, 2] as const)("encodes major %s with exact validated attachment identity", async (major) => {
    traceSpec("CAT-OC-INVOKE-FAMILY", "CAT-OC-MODEL-EXPLICIT");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-protocol-"));
    try {
      const file = join(dir, "space ü.json");
      await writeFile(file, "{}");
      vi.mocked(runProcess).mockResolvedValue(result);
      expect((await callOpencode({ model: "provider/family/model#high", prompt: "one prompt", phase: "formalization", files: [file, file], runtime: { major, binaryPath: "opencode", version: `${major}.0.0` } })).ok).toBe(true);
      expect(vi.mocked(runProcess).mock.calls[0]?.[1]).toEqual([
        "run", "one prompt", "--model", major === 1 ? "provider/family/model" : "provider/family/model#high", "--format", "json",
        ...(major === 1 ? ["--variant", "high"] : []), "--file", file, "--file", file,
      ]);
      expect(runProcess).toHaveBeenCalledOnce();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("uses native restricted v2 config, cwd, and non-inherited server exclusion", async () => {
    traceSpec("RAE-FINAL-PROTO-DIR", "RAE-FINAL-AGENT", "RAE-OC-COMPAT-EXCLUDE", "RAE-OC-COMPAT-CONFIG", "RAE-OC-COMPAT-AUTHORITY");
    const config = buildFinalReportAgentConfig("/private", "/evidence", "/evidence/report.md", [], 2);
    const decoded = JSON.parse(config) as { readonly agents: Record<string, { readonly system: string; readonly permissions: readonly { readonly action: string; readonly effect: string }[] }>; readonly lsp?: unknown };
    const policy = decoded.agents["spec-check-final-report"];
    expect(policy?.system).toContain("Never modify files");
    expect(policy?.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    for (const action of ["edit", "shell", "subagent", "webfetch", "websearch"]) {
      expect(policy?.permissions).toContainEqual({ action, resource: "*", effect: "deny" });
    }
    expect(decoded.lsp).toBeUndefined();
    vi.mocked(runProcess).mockResolvedValue({ ...result, stdout: '{"type":"text","part":{"text":"{\\"report_path\\":\\"/evidence/report.md\\",\\"report_markdown\\":\\"# Report\\"}"}}' });
    await callOpencode({ model: "provider/model#high", prompt: "read report", phase: "final-report", runtime: { binaryPath: "opencode", version: "2.0.15", major: 2 }, workspaceRoot: "/private", opencodeConfigContent: config, opencodeConfigDir: "/private", opencodeConfigPath: "/private/opencode.json" });
    expect(vi.mocked(runProcess).mock.calls[0]?.[1]).toEqual(["run", "--standalone", "read report", "--model", "provider/model#high", "--format", "json", "--agent", "spec-check-final-report"]);
    expect(vi.mocked(runProcess).mock.calls[0]?.[2]).toMatchObject({ cwd: "/private", envOverrides: { PWD: "/private", OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_CONFIG_DIR: "/private" } });
  });

  it.each([1, 2] as const)("decodes captured major %s text and usage with no protocol branch", async (major) => {
    traceSpec("RAE-OC-EVENTS", "RAE-OC-EVENTS-USAGE", "RAE-OC-EVENTS-UNKNOWN");
    const stdout = await readFile(`test/fixtures/opencode-v${major}.events.ndjson`, "utf8");
    vi.mocked(runProcess).mockResolvedValue({ ...result, stdout: `${stdout}{"type":"future_status","part":{"text":"not a response"}}\n` });
    const payload = await callOpencode({ model: "m", prompt: "p", phase: "qualitative-review", runtime: { binaryPath: "opencode", version: `${major}.0.0`, major } });
    expect(payload).toMatchObject({ ok: true, value: { read_token: "<REDACTED_RANDOM_TOKEN>" } });
    const usage = extractOpencodeUsage(stdout);
    expect(usage.events).toBeGreaterThan(0);
    // Captured v2.0.15 omits tokens.total; retain the existing incomplete-usage
    // classification instead of silently fabricating complete telemetry.
    expect(usage.completeEvents).toBe(major === 1 ? usage.events : 0);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(extractOpencodeUsage('{"type":"step_finish","part":{"tokens":{}}}').completeEvents).toBe(0);
  });

  it.each([1, 2] as const)("rejects major %s captured error and process failure with partial payload", async (major) => {
    traceSpec("RAE-OC-EVENTS-INVALID");
    const stdout = await readFile(`test/fixtures/opencode-v${major}.error.ndjson`, "utf8");
    const options = { model: "m", prompt: "p", phase: "qualitative-review" as const, retries: 1, runtime: { binaryPath: "opencode", version: `${major}.0.0`, major } };
    vi.mocked(runProcess).mockResolvedValue({ ...result, stdout });
    expect((await callOpencode(options)).ok).toBe(false);
    vi.mocked(runProcess).mockResolvedValue({ ...result, exitCode: 1 });
    expect(await callOpencode(options)).toMatchObject({ ok: false, error: { kind: "spawn_error" } });
  });

  it.each(["future_status", "step_start"])("never accepts an event-only %s stream as a raw model response", async (type) => {
    traceSpec("RAE-OC-EVENTS-UNKNOWN", "RAE-OC-EVENTS-INVALID");
    vi.mocked(runProcess).mockResolvedValue({ ...result, stdout: JSON.stringify({ type, findings: [], part: { text: "not a model response" } }) });
    expect(await callOpencode({ model: "m", prompt: "p", phase: "qualitative-review", retries: 1,
      runtime: { binaryPath: "opencode", version: "2.0.15", major: 2 } })).toMatchObject({ ok: false, error: { kind: "invalid_json" } });
  });

  it("records semantic model/variant and additive major metadata, without a probe attempt", async () => {
    traceSpec("RAE-OC-METRICS", "RAE-OC-METRICS-SCHEMA", "RAE-OC-METRICS-PROBE");
    vi.mocked(runProcess).mockImplementation(async (_command, args) => args[0] === "--version" ? { ...result, stdout: "2.0.15" } : result);
    await runWithTelemetryCollector(createTelemetryCollector(), async () => {
      await callOpencode({ model: "github-copilot/gpt-5.6-terra#high", prompt: "p", phase: "formalization" });
      const snapshot = snapshotCurrentTelemetry();
      expect(snapshot?.schemaVersion).toBe(1);
      expect(snapshot?.attempts).toHaveLength(1);
      expect(snapshot?.attempts[0]).toMatchObject({ model: "github-copilot/gpt-5.6-terra", variant: "high", opencodeMajor: 2 });
      const attempt = snapshot?.attempts[0];
      if (attempt === undefined) throw new Error("expected one recorded attempt");
      const { opencodeMajor: _historicallyAbsent, ...historical } = attempt;
      expect(JSON.parse(JSON.stringify(historical))).toMatchObject({ variant: "high", model: "github-copilot/gpt-5.6-terra" });
    });
  });

  it("does not re-read stdout for usage parsing without a telemetry context", async () => {
    traceSpec("RAE-RUN-METRICS");
    let reads = 0;
    vi.mocked(runProcess).mockResolvedValue({ ...result, get stdout() { reads += 1; return result.stdout; } });
    const request = { model: "m", prompt: "p", phase: "qualitative-review" as const, runtime: { binaryPath: "opencode", version: "2.0.15", major: 2 as const } };
    expect((await callOpencode(request)).ok).toBe(true);
    expect(reads).toBe(1);
    reads = 0;
    await runWithTelemetryCollector(createTelemetryCollector(), async () => {
      expect((await callOpencode(request)).ok).toBe(true);
      expect(reads).toBe(2);
      expect(snapshotCurrentTelemetry()?.attempts).toHaveLength(1);
    });
  });

  it("rejects invalid effective model settings as ConfigError before dependencies", async () => {
    traceSpec("CAT-OC-MODEL-INVALID");
    const argv = parseArgv(["spec.md", "--model", "github-copilot/gpt-5.6-terra#max"]);
    expect(argv.ok).toBe(true);
    if (argv.ok) expect(await resolveRunConfig(argv.value)).toMatchObject({ ok: false, error: { kind: "model_validation_error" } });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("retains release-specific gate evidence and its original blocking counterexample", async () => {
    traceSpec("RAE-OC-COMPAT", "RAE-OC-COMPAT-BLOCK");
    // This checks preserved empirical evidence, not a replacement for the
    // explicitly opted-in pinned-binary/live verification that produced it.
    const evidence = await readFile("openspec/changes/support-opencode-v2/v2-isolation-verification.md", "utf8").catch(async (error: unknown) => {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // The empirical record moves with the change at archive time; normal
      // verification must continue to find it after capability-spec sync.
      const archived = (await readdir("openspec/changes/archive"))
        .filter((name) => name.endsWith("-support-opencode-v2")).sort().at(-1);
      if (archived === undefined) throw new Error("Missing OpenCode compatibility acceptance evidence");
      return await readFile(join("openspec/changes/archive", archived, "v2-isolation-verification.md"), "utf8");
    });
    const fixture = JSON.parse(await readFile("test/fixtures/opencode-compat/exclusion-observations.json", "utf8")) as {
      readonly release: string; readonly binarySha256: string; readonly scope: string;
      readonly observations: readonly { readonly controls: string; readonly externalPlugins: number; readonly mcpServers: number; readonly startupMarkers: boolean; readonly builtinPlugins?: number; readonly trustedAgent?: boolean }[];
    };
    expect(evidence).toContain(fixture.binarySha256);
    expect(evidence).toContain("## Original Counterexample: Ancestor Plugin Startup");
    expect(evidence).toContain("[RAE-OC-COMPAT-BLOCK]");
    expect(evidence).toContain("## Final Gate Decision");
    expect(fixture.release).toBe("2.0.15");
    expect(fixture.scope).toBe("external-server-integrations");
    expect(fixture.observations.slice(0, 2).every((item) => item.startupMarkers && item.externalPlugins > 0 && item.mcpServers > 0)).toBe(true);
    expect(fixture.observations[2]).toMatchObject({ controls: "private-global-and-no-project", externalPlugins: 0, mcpServers: 0, startupMarkers: false, trustedAgent: true });
    expect(fixture.observations[2]?.builtinPlugins).toBeGreaterThan(0);
  });
});
