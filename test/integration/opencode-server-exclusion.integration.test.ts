import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { detectOpencodeRuntime } from "../../src/adapters/opencode-runtime.js";
import { buildOpencodeEnvironment } from "../../src/adapters/opencode-protocol.js";
import { runProcess } from "../../src/adapters/process.js";

const discoveryIt = process.env.SPEC_CHECK_V2_DISCOVERY === "1" ? it : it.skip;

describe("opt-in actual v2 server-plugin exclusion", () => {
  discoveryIt("distinguishes import exclusion from empty arrays and setup-only removals", async () => {
    traceSpec("RAE-OC-COMPAT", "RAE-OC-COMPAT-CONFIG", "RAE-OC-COMPAT-AUTHORITY", "RAE-OC-COMPAT-EXCLUDE");
    const detected = await detectOpencodeRuntime(process.env.SPEC_CHECK_OPENCODE_BINARY ?? "opencode");
    if (!detected.ok) throw new Error(detected.error.message);
    expect(detected.value.major).toBe(2);
    const root = await mkdtemp(join(tmpdir(), "spec-check-server-exclusion-"));
    try {
      for (const control of ["baseline", "empty", "remove", "exclude"] as const) {
        const caseRoot = join(root, control);
        const work = join(caseRoot, "ancestor", "work");
        const privateRoot = join(caseRoot, "private");
        const plugin = join(caseRoot, "ancestor", ".opencode", "plugins", "marker");
        await mkdir(work, { recursive: true });
        await mkdir(privateRoot);
        await mkdir(plugin, { recursive: true });
        const imports = join(caseRoot, "import-marker");
        const setups = join(caseRoot, "setup-marker");
        await writeFile(join(plugin, "index.ts"), [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(imports)}, "IMPORTED");`,
          `export default { id: "spec-check.marker", setup() { writeFileSync(${JSON.stringify(setups)}, "SETUP"); } };`,
        ].join("\n"));
        const config = JSON.stringify({
          ...(control === "empty" ? { plugins: [] } : {}),
          ...(control === "remove" ? { plugins: ["-spec-check.*"] } : {}),
          agents: { "spec-check-final-report": { mode: "primary", permissions: [{ action: "*", resource: "*", effect: "deny" }] } },
        });
        const configPath = join(privateRoot, "opencode.json");
        await writeFile(configPath, config, { mode: 0o600, flag: "wx" });
        const overrides = buildOpencodeEnvironment({
          model: "spec-check-nonexistent-provider/model", prompt: "fixture", phase: "final-report",
          workspaceRoot: work, opencodeConfigContent: config, opencodeConfigDir: privateRoot, opencodeConfigPath: configPath,
        }, detected.value);
        const result = await runProcess(detected.value.binaryPath, ["run", "--standalone", "fixture", "--agent", "spec-check-final-report", "--model", "spec-check-nonexistent-provider/model", "--format", "json", "--print-logs"], {
          cwd: work, timeoutMs: 15_000, maxOutputBytes: 1_048_576,
          envOverrides: {
            ...overrides, OPENCODE_CONFIG_PROJECT_DISABLE: control === "exclude" ? "1" : "0",
            OPENCODE_DISABLE_PROJECT_CONFIG: "1", // native 0 must override this alias in the positive controls
            HOME: join(caseRoot, "home"), XDG_DATA_HOME: join(caseRoot, "data"), XDG_STATE_HOME: join(caseRoot, "state"), XDG_CACHE_HOME: join(caseRoot, "cache"), OPENCODE_DISABLE_MODELS_FETCH: "1",
          },
        });
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain("provider.no-route");
        const imported = await readFile(imports, "utf8").catch(() => undefined);
        const setup = await readFile(setups, "utf8").catch(() => undefined);
        expect(imported, `${control}: ${result.stderr}`).toBe(control === "exclude" ? undefined : "IMPORTED");
        expect(setup).toBe(control === "exclude" || control === "remove" ? undefined : "SETUP");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 90_000);
});
