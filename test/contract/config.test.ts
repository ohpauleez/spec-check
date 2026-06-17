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
      config: configPath,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }

    expect(resolved.error.kind).toBe("config_parse_error");
  });
});
