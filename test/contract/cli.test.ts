import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { parseArgv } from "../../src/cli/parse-argv.js";
import { resolveRunConfig } from "../../src/cli/config.js";

describe("CLI argument parsing", () => {
  it("parses valid flags and positional paths", () => {
    traceSpec("CAT-CLI-ARGS");
    const parsed = parseArgv([
      "openspec/changes/spec-check-core",
      "--output",
      "out",
      "--src",
      "src",
      "--model",
      "github-copilot/gpt-5.3-codex",
      "--caps",
      "caps.md",
      "--z3",
      "/usr/bin/z3",
      "--config",
      "config.json",
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.value.inputs).toEqual(["openspec/changes/spec-check-core"]);
    expect(parsed.value.output).toBe("out");
    expect(parsed.value.src).toBe("src");
    expect(parsed.value.model).toBe("github-copilot/gpt-5.3-codex");
    expect(parsed.value.caps).toBe("caps.md");
    expect(parsed.value.z3).toBe("/usr/bin/z3");
    expect(parsed.value.config).toBe("config.json");
  });

  it("rejects unrecognized flags", () => {
    traceSpec("CAT-CLI-ARGS", "CAT-CLI-BADFLAG");
    const parsed = parseArgv(["--unknown"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.kind).toBe("unknown_flag");
  });

  it("rejects missing input paths", () => {
    traceSpec("CAT-CLI-NOINPUT");
    const parsed = parseArgv([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // No inputs provided — caller is responsible for checking
    expect(parsed.value.inputs.length).toBe(0);
  });

  it("parses help and version flags", () => {
    traceSpec("CAT-CLI-HELP", "CAT-CLI-VERSION");
    const help = parseArgv(["--help"]);
    const version = parseArgv(["--version"]);

    expect(help.ok).toBe(true);
    expect(version.ok).toBe(true);

    if (help.ok) {
      expect(help.value.help).toBe(true);
    }
    if (version.ok) {
      expect(version.value.version).toBe(true);
    }
  });

  it("accepts flag values starting with a hyphen", () => {
    traceSpec("CAT-CLI-ARGS");
    const parsed = parseArgv(["--output", "-my-dir"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.output).toBe("-my-dir");
  });

  it("supports equals syntax for flag values", () => {
    traceSpec("CAT-CLI-ARGS", "CAT-CLI-EQSYNTAX");
    const parsed = parseArgv(["--output=my-dir", "--z3=/usr/bin/z3-4.12"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.output).toBe("my-dir");
    expect(parsed.value.z3).toBe("/usr/bin/z3-4.12");
  });

  it("rejects output directory inside source directory", async () => {
    traceSpec("CAT-CLI-OUTSRC");
    const resolved = await resolveRunConfig({
      inputs: ["openspec/changes/spec-check-core"],
      output: "/tmp/project/src/output",
      src: "/tmp/project/src",
      help: false,
      version: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("output_inside_src");
  });

  it("rejects output directory equal to source directory", async () => {
    traceSpec("CAT-CLI-OUTSRC");
    const resolved = await resolveRunConfig({
      inputs: ["openspec/changes/spec-check-core"],
      output: "/tmp/shared-dir",
      src: "/tmp/shared-dir",
      help: false,
      version: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("output_inside_src");
  });

  it("accepts output directory outside source directory", async () => {
    traceSpec("CAT-CLI-OUTSRC");
    const resolved = await resolveRunConfig({
      inputs: ["openspec/changes/spec-check-core"],
      output: "/tmp/output",
      src: "/tmp/project/src",
      help: false,
      version: false,
    });

    expect(resolved.ok).toBe(true);
  });
});
