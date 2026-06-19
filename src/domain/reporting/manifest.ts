/**
 * Generates and manages the output manifest that tracks all rendered report artifacts.
 * Handles atomic writes, checksum verification, and stale artifact cleanup.
 *
 * Role: Reporting layer component that ensures output integrity and enables
 * incremental/idempotent report generation.
 *
 * Key exports: `OutputManifest`, `ManifestEntry`
 */
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
 * Build manifest entries from rendered output artifacts, computing SHA-256 checksums.
 *
 * @param files - array of output descriptors, each with a relative path, phase identifier, and content string
 * @returns manifest entries with computed checksums for each file
 *
 * @remarks
 * Preconditions: none — any array of well-typed descriptors is accepted.
 * Postconditions:
 * - The returned array has the same length and order as `files`.
 * - Each entry's `checksum` is the SHA-256 hex digest of the corresponding `content`.
 *
 * Failure modes: none — pure computation.
 *
 * @example
 * ```typescript
 * const entries = buildManifestEntries([
 *   { path: "findings.json", phase: "reporting", content: '{"findings":[]}' },
 *   { path: "summary.md", phase: "reporting", content: "# Summary\nNo issues." },
 * ]);
 * // entries[0].checksum is the SHA-256 hex of the content
 * // entries[0].path === "findings.json"
 * ```
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
 * Write the output manifest atomically after all other artifacts are finalized.
 *
 * @param outputDir - branded absolute directory path where the manifest is written
 * @param entries - manifest entries for all rendered artifacts
 * @returns resolves when the manifest has been written successfully
 *
 * @remarks
 * Preconditions:
 * - `outputDir` must reference an existing, writable directory.
 * - `entries` should reflect all artifacts produced during the run.
 *
 * Postconditions:
 * - A `manifest.json` file exists in `outputDir` with the serialized entries.
 * - The write is atomic (write-to-temp then rename).
 *
 * Failure modes:
 * - Throws if `writeOutputAtomic` fails (e.g., permission denied, disk full, directory missing).
 *
 * Safety: must be called after all other artifact writes are complete to ensure manifest consistency.
 *
 * @example
 * ```typescript
 * import { toOutputDirPath } from "../branded.js";
 *
 * const outputDir = toOutputDirPath("/tmp/spec-check-output");
 * const entries = buildManifestEntries(renderedFiles);
 * await writeManifest(outputDir, entries);
 * // Writes manifest.json atomically to the output directory
 * ```
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
 *
 * Failure modes:
 * - Returns `false` silently when no manifest exists (ENOENT).
 * - Throws for unexpected filesystem errors (e.g., EACCES, EIO) that are not ENOENT.
 *
 * Safety: performs a single filesystem unlink; no concurrent mutation concerns for
 * the manifest file itself, but callers must ensure no concurrent pipeline run
 * is writing a new manifest simultaneously.
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
