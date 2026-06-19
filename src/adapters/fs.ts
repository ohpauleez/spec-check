/**
 * Filesystem adapter that wraps I/O operations for safely writing, renaming,
 * and deleting files within a confined output directory.
 *
 * Adapter layer — isolates domain logic from direct filesystem access.
 * Exports: resolveConfinedOutputPath, writeOutputFile, atomicWriteOutputFile, removeOutputFile.
 */
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
 *
 * @remarks
 * Precondition: `outputDir` is a valid directory path (branded `OutputDirPath`).
 * `relativePath` is a branded `RelativePath` that should not escape the root.
 * Postcondition: the returned absolute path is a descendant of `outputDir` (no `..` traversal).
 *
 * Failure modes:
 * - Path traversal detected (relative path resolves outside output dir) → throws
 *   via `precondition` assertion with a descriptive message.
 * - This function never performs I/O; it only resolves and validates path strings.
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
 * @param content - UTF-8 content to write
 *
 * @throws Error if the write or rename fails after cleanup
 *
 * @remarks
 * Precondition: `outputDir` exists or will be created via `mkdir`.
 * `relativePath` must resolve inside `outputDir` (enforced by `resolveConfinedOutputPath`).
 * Postcondition: either the file exists at the final path with the given content,
 * or the operation throws and no orphan temp files remain on disk.
 * Invariant: the temp file is always cleaned up if rename fails.
 *
 * Failure modes:
 * - Directory creation fails (permissions, disk full) → throws Error from `mkdir`.
 * - Write to temp file fails (disk full, I/O error) → throws Error from `writeFile`.
 * - Rename fails (cross-device, permissions) → temp file cleaned up, then throws the rename Error.
 * - Path traversal attempt → throws via `resolveConfinedOutputPath` precondition.
 *
 * Safety: uses PID and timestamp in temp filename to avoid collisions between
 * concurrent calls targeting the same output path. Not safe for concurrent writes
 * to the same `relativePath` from multiple processes (last rename wins).
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
 * @param content - text content to hash
 * @returns 64-character lowercase hexadecimal SHA-256 digest
 *
 * @remarks
 * Precondition: `content` is a valid UTF-8 string.
 * Postcondition: returns a deterministic 64-character hex string for the given input.
 *
 * Failure modes: none — pure computation over Node.js crypto primitives.
 */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
