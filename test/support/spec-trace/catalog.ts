import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { scanSpecMarkdown, type ScannedIdentifier } from "./scan.js";

/**
 * One canonical identifier entry stored in the repository-wide catalog.
 *
 * @remarks
 * Preconditions: `identifier` is unique across included files unless catalog
 * construction fails.
 * Postconditions: `file` and `line` always identify the authoritative defining
 * location for the identifier.
 */
export interface CanonicalCatalogEntry {
  readonly identifier: string;
  readonly file: string;
  readonly line: number;
  readonly heading?: string;
}

/**
 * Immutable view of the canonical identifier catalog.
 *
 * @remarks
 * Invariant: `entriesByIdentifier` and `identifiers` contain the same set of
 * canonical identifiers in deterministic order.
 */
export interface CanonicalCatalog {
  readonly entriesByIdentifier: ReadonlyMap<string, CanonicalCatalogEntry>;
  readonly identifiers: readonly string[];
}

/**
 * Build the repository's canonical identifier catalog from included spec files.
 *
 * @param rootDir - repository root containing `openspec/`
 * @returns canonical catalog for all included non-archived specs
 *
 * @remarks
 * Preconditions: `rootDir` is the repository root.
 * Postconditions: every included `spec.md` file contributes zero or more
 * canonical identifiers; cross-file duplicates fail construction.
 */
export function loadCanonicalCatalog(rootDir: string = getRepositoryRoot()): CanonicalCatalog {
  const files = discoverCanonicalSpecFiles(rootDir);
  return buildCanonicalCatalogFromFiles(files);
}

/**
 * Discover included canonical `spec.md` files under `openspec/specs` and active
 * `openspec/changes`.
 *
 * @param rootDir - repository root containing `openspec/`
 * @returns deterministic list of included `spec.md` files
 *
 * @remarks
 * Preconditions: discovery is limited to repository-local OpenSpec paths.
 * Postconditions: archived change specs are excluded from the returned list.
 */
export function discoverCanonicalSpecFiles(rootDir: string = getRepositoryRoot()): readonly string[] {
  const files = [
    ...collectSpecFiles(resolve(rootDir, "openspec/specs")),
    ...collectSpecFiles(resolve(rootDir, "openspec/changes"), new Set(["archive"])),
  ];

  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * Build a canonical catalog from an explicit spec-file list.
 *
 * @param files - included spec files in any order
 * @returns canonical catalog with deterministic identifier order
 *
 * @remarks
 * Preconditions: each file path points to a markdown file that may contain
 * canonical identifiers.
 * Postconditions: repeated identifiers in one file keep the first occurrence;
 * duplicates across files throw.
 */
export function buildCanonicalCatalogFromFiles(files: readonly string[]): CanonicalCatalog {
  const entriesByIdentifier = new Map<string, CanonicalCatalogEntry>();

  for (const file of [...files].sort((left, right) => left.localeCompare(right))) {
    const markdown = readFileSync(file, "utf8");
    const scannedEntries = scanSpecMarkdown(file, markdown);
    mergeScannedEntries(entriesByIdentifier, scannedEntries);
  }

  return {
    entriesByIdentifier,
    identifiers: [...entriesByIdentifier.keys()],
  };
}

/**
 * Build a canonical catalog directly from known entries.
 *
 * @param entries - precomputed catalog entries
 * @returns canonical catalog preserving the supplied entry order
 *
 * @remarks
 * Preconditions: each entry identifier is unique.
 * Postconditions: duplicate identifiers throw immediately.
 */
export function createCanonicalCatalog(
  entries: readonly CanonicalCatalogEntry[],
): CanonicalCatalog {
  const entriesByIdentifier = new Map<string, CanonicalCatalogEntry>();

  for (const entry of entries) {
    const duplicate = entriesByIdentifier.get(entry.identifier);
    if (duplicate !== undefined) {
      throw new Error(
        `Duplicate canonical identifier ${entry.identifier}: ${formatCatalogEntry(duplicate)} and ${formatCatalogEntry(entry)}`,
      );
    }
    entriesByIdentifier.set(entry.identifier, entry);
  }

  return {
    entriesByIdentifier,
    identifiers: [...entriesByIdentifier.keys()],
  };
}

/**
 * Format provenance for diagnostics.
 *
 * @param entry - canonical catalog entry to render
 * @param rootDir - optional repository root for relative paths
 * @returns concise provenance string with file, line, and heading
 */
export function formatCatalogEntry(
  entry: CanonicalCatalogEntry,
  rootDir: string = getRepositoryRoot(),
): string {
  const displayPath = toDisplayPath(entry.file, rootDir);
  if (entry.heading === undefined) {
    return `${displayPath}:${String(entry.line)}`;
  }
  return `${displayPath}:${String(entry.line)} (${entry.heading})`;
}

/**
 * Resolve the repository root from this support module's location.
 *
 * @returns repository root path
 */
export function getRepositoryRoot(): string {
  return resolve(import.meta.dirname, "../../..");
}

/**
 * Collect `spec.md` files recursively beneath one discovery root.
 *
 * @param directory - discovery root to walk
 * @param excludedDirectories - directory names to skip while recursing
 * @returns discovered `spec.md` files below the root
 */
function collectSpecFiles(
  directory: string,
  excludedDirectories: ReadonlySet<string> = new Set(),
): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) {
        continue;
      }
      files.push(...collectSpecFiles(join(directory, entry.name), excludedDirectories));
      continue;
    }

    if (entry.isFile() && entry.name === "spec.md") {
      files.push(join(directory, entry.name));
    }
  }

  return files;
}

/**
 * Merge one file's scanned identifiers into the catalog under construction.
 *
 * @param entriesByIdentifier - mutable catalog map under construction
 * @param scannedEntries - identifiers discovered in one markdown file
 *
 * @remarks
 * Preconditions: `scannedEntries` are in source order for one file.
 * Postconditions: same-file repeats keep the first occurrence; cross-file
 * duplicates throw with provenance for both definitions.
 */
function mergeScannedEntries(
  entriesByIdentifier: Map<string, CanonicalCatalogEntry>,
  scannedEntries: readonly ScannedIdentifier[],
): void {
  for (const entry of scannedEntries) {
    const existing = entriesByIdentifier.get(entry.identifier);
    if (existing === undefined) {
      entriesByIdentifier.set(entry.identifier, entry);
      continue;
    }

    if (existing.file === entry.file) {
      continue;
    }

    if (isChangeSpecPath(existing.file) && !isChangeSpecPath(entry.file)) {
      continue;
    }

    if (!isChangeSpecPath(existing.file) && isChangeSpecPath(entry.file)) {
      entriesByIdentifier.set(entry.identifier, entry);
      continue;
    }

    throw new Error(
      `Duplicate canonical identifier ${entry.identifier}: ${formatCatalogEntry(existing)} and ${formatCatalogEntry(entry)}`,
    );
  }
}

/**
 * Check whether a canonical spec path comes from an active OpenSpec change.
 *
 * @param filePath - absolute or repository-relative spec path
 * @returns true when the path is under `openspec/changes/`
 */
function isChangeSpecPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/");
  return normalized.includes("/openspec/changes/");
}

/**
 * Convert an absolute path into a repository-relative display path when possible.
 *
 * @param filePath - path to render
 * @param rootDir - repository root used for relative formatting
 * @returns relative display path when inside the repository, else the original path
 */
function toDisplayPath(filePath: string, rootDir: string): string {
  const relativePath = relative(rootDir, filePath);
  return relativePath.startsWith("..") ? filePath : relativePath;
}
