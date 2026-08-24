import { describe, expect, it } from "vitest";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { traceSpec } from "../support/spec-trace.js";
import { FINAL_REPORT_PROMPT } from "../../src/domain/prompts/final-report.js";

describe("distribution parity", () => {
  it("bundled CLI contains shebang and embedded version", async () => {
    const bundled = await readFile(join(process.cwd(), "dist/spec-check.js"), "utf8");
    expect(bundled.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(bundled).toContain("__SPEC_CHECK_VERSION__");
  });

  it("bundles the final-report prompt and restricted protocol", async () => {
    traceSpec("RAE-FINAL-PROMPT-PARITY", "RAE-FINAL-PROTO-DIR");
    const bundled = await readFile(join(process.cwd(), "dist/spec-check.js"), "utf8");
    expect(bundled).toContain("spec-check-final-report");
    expect(bundled).toContain("Final spec-check Assessment");
    expect(bundled).toContain("reporting.final_report_failed");
    const sourceMap = JSON.parse(await readFile(join(process.cwd(), "dist/spec-check.js.map"), "utf8")) as {
      readonly sources: readonly string[];
      readonly sourcesContent: readonly (string | null)[];
    };
    const promptSourceIndex = sourceMap.sources.findIndex((source) => source.endsWith("src/domain/prompts/final-report.ts"));
    expect(promptSourceIndex).toBeGreaterThanOrEqual(0);
    const bundledSource = sourceMap.sourcesContent[promptSourceIndex] ?? "";
    for (const line of FINAL_REPORT_PROMPT.split("\n").filter((value) => value.length >= 24)) {
      expect(bundledSource).toContain(line.replaceAll("`", "\\`"));
    }
  });
});
