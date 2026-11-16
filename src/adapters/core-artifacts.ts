/** Enumerate only tool-owned core trees for complete checksummed bundle manifests. */
import { readdir, readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import type { OutputDirPath } from "../domain/branded.js";
import type { ManifestEntry } from "../domain/reporting/manifest.js";

/** Read completed artifacts without following symlinks or admitting unrelated root files. */
export async function collectCoreArtifacts(output: OutputDirPath): Promise<readonly ManifestEntry[]> {
  const roots = [["smt", "logic"], ["gen_specs", "code-derived-generation"], ["gen_specs_smt", "code-derived-formalization"], ["cross_implication", "comparison"], ["cross_implication_aggregate", "comparison"]] as const;
  const entries: ManifestEntry[] = [];
  const pending: { path: string; phase: string; depth: number }[] = roots.map(([path, phase]) => ({ path, phase, depth: 0 }));
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (entries.length > 65_536 || item.depth > 32) throw new Error("Core artifact enumeration bound exceeded");
    let children;
    try {
      if ((await lstat(join(output, item.path))).isSymbolicLink()) throw new Error("Symlink in completed core artifact tree");
      children = await readdir(join(output, item.path));
    }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const child of children.sort()) {
      if (child.includes(".tmp-")) continue;
      const path = `${item.path}/${child}`;
      const info = await lstat(join(output, path));
      if (info.isSymbolicLink()) throw new Error("Symlink in completed core artifact tree");
      if (info.isDirectory()) pending.push({ path, phase: item.phase, depth: item.depth + 1 });
      else if (info.isFile()) entries.push({ path, phase: item.phase, checksum: createHash("sha256").update(await readFile(join(output, path))).digest("hex") });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Fail closed: recorder provenance must match the complete on-disk semantic tree.
 * Temporary files are unexpected too: all required atomic writers have completed.
 * Assumes a caller-owned, single-writer root; this is not race-free hostile-directory traversal.
 */
export async function reconcileSemanticEvidence(output: OutputDirPath, entries: readonly ManifestEntry[]): Promise<void> {
  const expected = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    if (!entry.path.startsWith("semantic_evidence/")) continue;
    const path = relative(resolve(output), resolve(output, entry.path)).split(sep).join("/");
    if (path !== entry.path || path.includes("\\") || expected.has(path)) throw new Error(`Invalid/duplicate semantic evidence descriptor: ${entry.path}`);
    expected.set(path, entry);
  }
  const seen = new Set<string>();
  const pending = [{ path: "semantic_evidence", depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (++visited > 65_536 || item.depth > 32) throw new Error("Semantic evidence enumeration bound exceeded");
    let info;
    try { info = await lstat(join(output, item.path)); }
    catch (error: unknown) {
      if (item.path === "semantic_evidence" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Symlink in semantic evidence: ${item.path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(join(output, item.path))).sort()) pending.push({ path: `${item.path}/${name}`, depth: item.depth + 1 });
    } else if (info.isFile()) {
      const entry = expected.get(item.path);
      if (entry === undefined) throw new Error(`Unexpected semantic evidence artifact: ${item.path}`);
      const checksum = createHash("sha256").update(await readFile(join(output, item.path))).digest("hex");
      if (checksum !== entry.checksum) throw new Error(`Semantic evidence checksum mismatch: ${item.path}`);
      seen.add(item.path);
    } else throw new Error(`Unsupported semantic evidence file type: ${item.path}`);
  }
  for (const path of expected.keys()) if (!seen.has(path)) throw new Error(`Missing semantic evidence artifact: ${path}`);
}
