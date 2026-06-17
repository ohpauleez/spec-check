import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { precondition } from "../domain/assert.js";
import type { OutputDirPath, RelativePath } from "../domain/branded.js";

/**
 * Resolve and validate that a path stays inside the output directory.
 *
 * @param outputDir - configured output directory
 * @param relativePath - file path relative to output directory
 * @returns absolute target path inside output directory
 */
export function resolveConfinedOutputPath(outputDir: OutputDirPath, relativePath: RelativePath): string {
  const root = resolve(outputDir);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  precondition(!rel.startsWith("..") && !rel.startsWith("/"), `output path escapes configured output directory: ${relativePath}`);
  return target;
}

/**
 * Write a UTF-8 file atomically via temporary file and rename.
 *
 * @param outputDir - configured output directory root
 * @param relativePath - destination path inside output directory
 * @param content - UTF-8 content
 *
 * @throws Error if the write or rename fails after cleanup
 *
 * @remarks
 * Precondition: `outputDir` exists or will be created via `mkdir`.
 * Postcondition: either the file exists at the final path with the given content,
 * or the operation throws and no orphan temp files remain on disk.
 * Invariant: the temp file is always cleaned up if rename fails.
 */
export async function writeOutputAtomic(outputDir: OutputDirPath, relativePath: RelativePath, content: string): Promise<void> {
  const finalPath = resolveConfinedOutputPath(outputDir, relativePath);
  await mkdir(dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now().toString(16)}`;
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, finalPath);
  } catch (renameError: unknown) {
    // Clean up orphan temp file before propagating the failure.
    try {
      await unlink(tempPath);
    } catch {
      // Swallow cleanup errors — the rename failure is the primary error.
    }
    throw renameError;
  }
}

/**
 * Compute SHA-256 lowercase hex checksum for UTF-8 content.
 *
 * @param content - text content
 * @returns sha256 checksum
 */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
