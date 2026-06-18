import { mkdtemp, readFile, readdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { buildManifestEntries, writeManifest, invalidateStaleManifest } from "../../src/domain/reporting/manifest.js";
import { writeOutputAtomic } from "../../src/adapters/fs.js";
import { traceSpec } from "../support/spec-trace.js";
import { toOutputDirPath, toRelativePath } from "../../src/domain/branded.js";

describe("manifest semantics", () => {
  it("writes checksums and manifest last", async () => {
    traceSpec("RAE-ATOMIC-MANIFEST", "RAE-MANIFEST-DONE", "RAE-MANIFEST-SCHEMA", "RAE-SCHEMA-HASH");
    const outDir = await mkdtemp(join(tmpdir(), "spec-check-manifest-"));
    await writeOutputAtomic(toOutputDirPath(outDir), toRelativePath("report_1.1.md"), "alpha\n");
    await writeOutputAtomic(toOutputDirPath(outDir), toRelativePath("report_1.2.md"), "beta\n");

    const entries = buildManifestEntries([
      { path: "report_1.1.md", phase: "p1", content: "alpha\n" },
      { path: "report_1.2.md", phase: "p2", content: "beta\n" },
    ]);
    await writeManifest(toOutputDirPath(outDir), entries);

    const files = await readdir(outDir);
    expect(files.includes("manifest.json")).toBe(true);

    const manifestRaw = await readFile(join(outDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as { readonly files: readonly { readonly path: string; readonly checksum: string; readonly phase: string }[] };
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("manifest entries match actual file checksums", async () => {
    traceSpec("RAE-SCHEMA-MATCH");
    const outDir = await mkdtemp(join(tmpdir(), "spec-check-manifest-"));
    const content = "checksum test\n";
    await writeOutputAtomic(toOutputDirPath(outDir), toRelativePath("check.md"), content);
    const entries = buildManifestEntries([
      { path: "check.md", phase: "test", content },
    ]);
    const { sha256Hex } = await import("../../src/adapters/fs.js");
    expect(entries[0]?.checksum).toBe(sha256Hex(content));
  });

  it("removes stale manifest from prior run", async () => {
    traceSpec("RAE-MANIFEST-STALE");
    const outDir = await mkdtemp(join(tmpdir(), "spec-check-manifest-"));
    const staleManifest = JSON.stringify({ files: [{ path: "old.md", checksum: "abc", phase: "old" }] });
    await writeFile(join(outDir, "manifest.json"), staleManifest, "utf8");

    const removed = await invalidateStaleManifest(toOutputDirPath(outDir));
    expect(removed).toBe(true);

    // Verify manifest no longer exists.
    await expect(access(join(outDir, "manifest.json"))).rejects.toThrow();
  });

  it("returns false when no stale manifest exists", async () => {
    traceSpec("RAE-MANIFEST-STALE");
    const outDir = await mkdtemp(join(tmpdir(), "spec-check-manifest-"));

    const removed = await invalidateStaleManifest(toOutputDirPath(outDir));
    expect(removed).toBe(false);
  });
});
