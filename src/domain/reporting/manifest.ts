import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { writeOutputAtomic, sha256Hex } from "../../adapters/fs.js";
import { toRelativePath, type OutputDirPath } from "../branded.js";

/**
 * A single entry in the output manifest describing one rendered artifact.
 *
 * @remarks
 * Invariant: `checksum` is the SHA-256 hex digest of the artifact's content at write time.
 * Invariant: `path` is a relative path within the output directory.
 * Invariant: `phase` identifies which pipeline phase produced the artifact.
 */
export interface ManifestEntry {
  readonly path: string;
  readonly checksum: string;
  readonly phase: string;
}

/**
 * Top-level manifest file structure written as the final pipeline artifact.
 *
 * @remarks
 * Invariant: `files` contains an entry for every artifact produced during the run.
 * The manifest itself is written atomically after all other artifacts are finalized.
 */
export interface ManifestFile {
  readonly files: readonly ManifestEntry[];
}

/**
 * Build manifest entries from rendered output artifacts.
 */
export function buildManifestEntries(
  files: readonly { readonly path: string; readonly phase: string; readonly content: string }[],
): readonly ManifestEntry[] {
  return files.map((file) => ({
    path: file.path,
    checksum: sha256Hex(file.content),
    phase: file.phase,
  }));
}

/**
 * Write manifest after all other artifacts are finalized.
 */
export async function writeManifest(outputDir: OutputDirPath, entries: readonly ManifestEntry[]): Promise<void> {
  const manifest: ManifestFile = { files: entries };
  await writeOutputAtomic(outputDir, toRelativePath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Remove a stale manifest from a prior run before analysis begins.
 *
 * @param outputDir - configured output directory
 * @returns true if a stale manifest was removed, false if none existed
 *
 * @remarks
 * [RAE-MANIFEST-STALE] Ensures that a failed rerun cannot be mistaken for
 * a prior successful run. The manifest is removed eagerly at the start of
 * each run; only a successfully completed run writes a new manifest at the end.
 *
 * Precondition: `outputDir` is a valid path (directory may or may not exist).
 * Postcondition: no manifest.json exists in `outputDir` after this call.
 */
export async function invalidateStaleManifest(outputDir: OutputDirPath): Promise<boolean> {
  const manifestPath = join(outputDir, "manifest.json");
  try {
    await unlink(manifestPath);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
