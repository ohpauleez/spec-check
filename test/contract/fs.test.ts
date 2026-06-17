import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { traceSpec } from "../support/spec-trace.js";
import { resolveConfinedOutputPath, writeOutputAtomic, sha256Hex } from "../../src/adapters/fs.js";
import { toOutputDirPath, toRelativePath } from "../../src/domain/branded.js";

describe("filesystem adapter contracts", () => {
  it("allows path within output directory", () => {
    traceSpec("RAE-OUTPUT-CONFINE", "RAE-CONFINE-PASS");
    const result = resolveConfinedOutputPath(toOutputDirPath("/tmp/out"), toRelativePath("report.md"));
    expect(result).toBe("/tmp/out/report.md");
  });

  it("rejects path traversal outside boundary", () => {
    traceSpec("RAE-CONFINE-FAIL");
    expect(() => resolveConfinedOutputPath(toOutputDirPath("/tmp/out"), toRelativePath("../../etc/passwd"))).toThrow("escapes");
  });

  it("rejects absolute path outside boundary", () => {
    traceSpec("RAE-CONFINE-FAIL");
    expect(() => resolveConfinedOutputPath(toOutputDirPath("/tmp/out"), toRelativePath("/etc/passwd"))).toThrow("escapes");
  });

  it("computes sha256 lowercase hex of correct length", () => {
    traceSpec("RAE-MANIFEST-SCHEMA", "RAE-SCHEMA-HASH");
    const hash = sha256Hex("hello\n");
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("writes atomic output file with correct content", async () => {
    traceSpec("RAE-OUTPUT-ATOMIC", "RAE-ATOMIC-PASS");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-fs-"));
    await writeOutputAtomic(toOutputDirPath(dir), toRelativePath("test.md"), "content\n");
    const content = await readFile(join(dir, "test.md"), "utf8");
    expect(content).toBe("content\n");
  });
});
