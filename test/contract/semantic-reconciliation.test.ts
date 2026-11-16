import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { reconcileSemanticEvidence } from "../../src/adapters/core-artifacts.js";
import { validateCoreManifestEntries } from "../../src/domain/reporting/manifest.js";
import { toOutputDirPath } from "../../src/domain/branded.js";
import { traceSpec } from "../support/spec-trace.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spec-check-reconcile-"));
  const output = toOutputDirPath(root);
  await mkdir(join(root, "semantic_evidence"));
  const bytes = Buffer.from([255, 0, 40, 41]);
  const descriptor = { path: "semantic_evidence/exact.bin", checksum: createHash("sha256").update(bytes).digest("hex"), phase: "formalization" };
  await writeFile(join(root, descriptor.path), bytes);
  return { output, descriptor };
}

describe("completion-time semantic evidence reconciliation", () => {
  it("retains recorder checksum/phase provenance without duplicate enumeration descriptors", async () => {
    traceSpec("RAE-EVIDENCE-MANAGED", "RAE-EVIDENCE-WRITE");
    const { output, descriptor } = await fixture();
    await expect(reconcileSemanticEvidence(output, [descriptor])).resolves.toBeUndefined();
    const entries = [descriptor];
    expect(validateCoreManifestEntries(entries)).toBe(entries);
    expect(entries[0]?.phase).toBe("formalization");
  });

  it.each(["missing", "changed", "stray", "temporary", "directory", "symlink", "tree-symlink"])("fails closed on %s artifacts", async (fault) => {
    const { output, descriptor } = await fixture();
    const path = join(output, descriptor.path);
    if (fault === "missing") await rm(path);
    if (fault === "changed") await writeFile(path, "changed");
    if (fault === "stray") await writeFile(join(output, "semantic_evidence/stray.json"), "{}");
    if (fault === "temporary") await writeFile(join(output, "semantic_evidence/exact.bin.tmp-1-ab"), "partial");
    if (fault === "directory") { await rm(path); await mkdir(path); }
    if (fault === "symlink") { await rm(path); await symlink(join(output, "missing-target"), path); }
    if (fault === "tree-symlink") { await rm(join(output, "semantic_evidence"), { recursive: true }); await mkdir(join(output, "elsewhere")); await symlink(join(output, "elsewhere"), join(output, "semantic_evidence")); }
    await expect(reconcileSemanticEvidence(output, [descriptor])).rejects.toThrow();
  });

  it("rejects duplicate paths, path aliases, and unsupported filesystem types", async () => {
    const { output, descriptor } = await fixture();
    expect(() => validateCoreManifestEntries([descriptor, { ...descriptor, phase: "logic" }])).toThrow("duplicate");
    await expect(reconcileSemanticEvidence(output, [descriptor, descriptor])).rejects.toThrow("duplicate");
    await expect(reconcileSemanticEvidence(output, [{ ...descriptor, path: "semantic_evidence/../outside.bin" }])).rejects.toThrow("Invalid");
    if (process.platform !== "win32") {
      const fifo = join(output, "semantic_evidence/pipe");
      const result = spawnSync("mkfifo", [fifo]);
      expect(result.status).toBe(0);
      await expect(reconcileSemanticEvidence(output, [descriptor])).rejects.toThrow("Unsupported");
    }
  });

  it("missing evidence trees are valid only when there are no expected artifacts", async () => {
    const { output, descriptor } = await fixture();
    await rm(join(output, "semantic_evidence"), { recursive: true });
    await expect(reconcileSemanticEvidence(output, [])).resolves.toBeUndefined();
    await expect(reconcileSemanticEvidence(output, [descriptor])).rejects.toThrow("Missing");
  });
});
