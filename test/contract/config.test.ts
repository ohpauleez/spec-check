import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { resolveRunConfig } from "../../src/cli/config.js";

describe("config loading and precedence", () => {
  it("uses CLI flags over config values", async () => {
    traceSpec("CAT-CLI-CONFIG", "CAT-CONFIG-MERGE");
    const root = await mkdtemp(join(tmpdir(), "spec-check-config-"));
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          inputs: ["from-config"],
          output: "config-output",
          src: "config-src",
          timeoutMs: 60000,
          allowArchive: true,
        },
        null,
        2,
      ),
      "utf8",
    );

    const resolved = await resolveRunConfig({
      inputs: ["from-cli"],
      output: "cli-output",
      src: "cli-src",
      timeoutMs: "45000",
      allowArchive: false,
      help: false,
      version: false,
      config: configPath,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }

    expect(resolved.value.inputs).toEqual(["from-cli"]);
    expect(resolved.value.output).toBe("cli-output");
    expect(resolved.value.src).toBe("cli-src");
    expect(resolved.value.timeoutMs).toBe(45000);
    expect(resolved.value.allowArchive).toBe(true);
  });

  it("rejects invalid config JSON", async () => {
    traceSpec("CAT-CONFIG-FAIL");
    const root = await mkdtemp(join(tmpdir(), "spec-check-config-"));
    const configPath = join(root, "bad.json");
    await writeFile(configPath, "{", "utf8");

    const resolved = await resolveRunConfig({
      inputs: ["in"],
      help: false,
      version: false,
      allowArchive: false,
      config: configPath,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }

    expect(resolved.error.kind).toBe("config_parse_error");
  });

  it("rejects timeout below minimum", async () => {
    traceSpec("CAT-CLI-TIMEOUT");
    const resolved = await resolveRunConfig({
      inputs: ["in"],
      timeoutMs: "1000",
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("timeout_validation_error");
  });

  it("rejects non-integer timeout", async () => {
    traceSpec("CAT-CLI-TIMEOUT");
    const resolved = await resolveRunConfig({
      inputs: ["in"],
      timeoutMs: "1.5",
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("timeout_validation_error");
  });

  it("accepts config file timeoutMs without CLI override", async () => {
    traceSpec("CAT-CLI-TIMEOUT-CONFIG");
    const root = await mkdtemp(join(tmpdir(), "spec-check-config-timeout-"));
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ timeoutMs: 60000 }), "utf8");

    const resolved = await resolveRunConfig({
      inputs: ["in"],
      help: false,
      version: false,
      allowArchive: false,
      config: configPath,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.timeoutMs).toBe(60000);
  });

  it("rejects timeout above maximum", async () => {
    traceSpec("CAT-CLI-TIMEOUT");
    const resolved = await resolveRunConfig({
      inputs: ["in"],
      timeoutMs: "1000000",
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("timeout_validation_error");
    if (resolved.error.kind !== "timeout_validation_error") return;
    expect(resolved.error.message).toContain("must be in range");
  });

  it("rejects invalid --pair-budget (non-numeric)", async () => {
    traceSpec("CAT-CLI-CONFIG");
    const resolved = await resolveRunConfig({
      inputs: ["in"],
      pairBudget: "abc",
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("pair_budget_validation_error");
  });

  it("rejects invalid --pair-budget (zero)", async () => {
    traceSpec("CAT-CLI-CONFIG");
    const resolved = await resolveRunConfig({
      inputs: ["in"],
      pairBudget: "0",
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("pair_budget_validation_error");
  });

  it("rejects invalid --pair-budget (negative)", async () => {
    traceSpec("CAT-CLI-CONFIG");
    const resolved = await resolveRunConfig({
      inputs: ["in"],
      pairBudget: "-5",
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("pair_budget_validation_error");
  });

  it("accepts valid --pair-budget", async () => {
    traceSpec("CAT-CLI-CONFIG");
    const resolved = await resolveRunConfig({
      inputs: ["in"],
      pairBudget: "50",
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.pairBudget).toBe(50);
  });
});
