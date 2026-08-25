import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";
import { traceSpec } from "../support/spec-trace.js";
import { removeOutputTemporaryFiles, removeOutputTree, resolveConfinedOutputPath, writeOutputAtomic, sha256Hex } from "../../src/adapters/fs.js";
import { toOutputDirPath, toRelativePath } from "../../src/domain/branded.js";
import type * as FsPromises from "node:fs/promises";

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

  it("removes only the selected confined stale evidence tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-check-fs-remove-"));
    await mkdir(join(dir, "formalization_evidence"), { recursive: true });
    await writeFile(join(dir, "formalization_evidence", "stale.json"), "{}\n", "utf8");
    await writeFile(join(dir, "keep.txt"), "keep\n", "utf8");

    await removeOutputTree(toOutputDirPath(dir), toRelativePath("formalization_evidence"));

    await expect(access(join(dir, "formalization_evidence"))).rejects.toThrow();
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("recreates a removed cached output directory in the same process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-check-fs-cache-"));
    const output = toOutputDirPath(dir);
    const path = toRelativePath("smt/result.smt2");
    await writeOutputAtomic(output, path, "first");
    await removeOutputTree(output, toRelativePath("smt"));
    await writeOutputAtomic(output, path, "second");
    expect(await readFile(join(dir, path), "utf8")).toBe("second");
  });

  it("removes interrupted atomic-write siblings only for managed root files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-check-fs-temp-"));
    const output = toOutputDirPath(dir);
    await writeFile(join(dir, "report.md.tmp-123-abcd"), "partial", "utf8");
    await writeFile(join(dir, "user.md.tmp-123-abcd"), "keep", "utf8");
    await removeOutputTemporaryFiles(output, [toRelativePath("report.md")]);
    await expect(readFile(join(dir, "report.md.tmp-123-abcd"), "utf8")).rejects.toThrow();
    expect(await readFile(join(dir, "user.md.tmp-123-abcd"), "utf8")).toBe("keep");
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

  it("propagates a rename failure and removes the orphan temp file", async () => {
    traceSpec("RAE-OUTPUT-ATOMIC");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-fs-rename-"));

    // Mock only `rename`; every other fs/promises export stays real so the
    // temp file is genuinely written and genuinely unlinked.
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual("node:fs/promises");
      return {
        ...actual,
        rename: vi.fn(async () => {
          throw new Error("EXDEV: cross-device rename");
        }),
      };
    });
    try {
      const { writeOutputAtomic: mockedWrite } = await import("../../src/adapters/fs.js");
      await expect(
        mockedWrite(toOutputDirPath(dir), toRelativePath("atomic.md"), "payload\n"),
      ).rejects.toThrow("EXDEV");

      // The temp orphan must be cleaned up: no `.tmp-` file may remain.
      const leftover = (await readdir(dir)).filter((name) => name.includes(".tmp-"));
      expect(leftover).toEqual([]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("removes partial temp output when the temp write fails", async () => {
    traceSpec("RAE-OUTPUT-ATOMIC", "RAE-ATOMIC-INTERRUPT");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-fs-write-"));
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
      return {
        ...actual,
        writeFile: vi.fn(async (path: Parameters<typeof actual.writeFile>[0]) => {
          await actual.writeFile(path, "partial", "utf8");
          throw new Error("ENOSPC: partial write");
        }),
      };
    });
    try {
      const { writeOutputAtomic: mockedWrite } = await import("../../src/adapters/fs.js");
      await expect(mockedWrite(toOutputDirPath(dir), toRelativePath("atomic.md"), "payload\n"))
        .rejects.toThrow("ENOSPC");
      expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("propagates the rename error even when temp cleanup also fails", async () => {
    traceSpec("RAE-OUTPUT-ATOMIC");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-fs-rename-unlink-"));

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual("node:fs/promises");
      return {
        ...actual,
        rename: vi.fn(async () => {
          throw new Error("EXDEV: rename failed");
        }),
        unlink: vi.fn(async () => {
          throw new Error("EBUSY: unlink failed");
        }),
      };
    });
    try {
      const { writeOutputAtomic: mockedWrite } = await import("../../src/adapters/fs.js");
      // The primary rename error propagates; the secondary unlink failure is
      // swallowed (documented) and must not mask the primary error.
      await expect(
        mockedWrite(toOutputDirPath(dir), toRelativePath("atomic.md"), "payload\n"),
      ).rejects.toThrow("EXDEV: rename failed");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});
