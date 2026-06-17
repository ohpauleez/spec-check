import { describe, expect, it } from "vitest";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("distribution parity", () => {
  it("bundled CLI contains shebang and embedded version", async () => {
    const bundled = await readFile(join(process.cwd(), "dist/spec-check.js"), "utf8");
    expect(bundled.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(bundled).toContain("__SPEC_CHECK_VERSION__");
  });
});
