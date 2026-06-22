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

  it("rejects path traversal at branding boundary", () => {
    traceSpec("RAE-CONFINE-FAIL");
    // Defense-in-depth: toRelativePath rejects traversal paths before they reach resolveConfinedOutputPath.
    expect(() => toRelativePath("../../etc/passwd")).toThrow("invalid relative path");
  });

  it("rejects absolute path at branding boundary", () => {
    traceSpec("RAE-CONFINE-FAIL");
    // Defense-in-depth: toRelativePath rejects absolute paths before they reach resolveConfinedOutputPath.
    expect(() => toRelativePath("/etc/passwd")).toThrow("invalid relative path");
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

  it("accepts filenames containing '..' as a substring (not a traversal segment)", () => {
    // Per-segment check: only path segments that are literally ".." are rejected.
    // Filenames like "version..2" contain ".." but are not directory traversal.
    expect(() => toRelativePath("data/version..2/file.md")).not.toThrow();
    expect(() => toRelativePath("foo..bar/baz.txt")).not.toThrow();
    expect(() => toRelativePath("a..b")).not.toThrow();
  });

  it("still rejects actual '..' traversal segments", () => {
    expect(() => toRelativePath("data/../secret.txt")).toThrow("invalid relative path");
    expect(() => toRelativePath("../escape")).toThrow("invalid relative path");
    expect(() => toRelativePath("a/b/../../c")).toThrow("invalid relative path");
  });
});
