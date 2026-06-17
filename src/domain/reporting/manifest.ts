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
