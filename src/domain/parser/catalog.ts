import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { toCapabilityName, type CapabilityName } from "../branded.js";
import type { Finding } from "../findings.js";
import type { Catalog, CatalogDocument, DocumentType } from "../model.js";
import { err, ok, type Result } from "../result.js";

/**
 * Error produced when a catalog input path cannot be read from the filesystem.
 *
 * @remarks
 * Invariant: `kind` is always `"unreadable_input"`. The `path` field contains
 * the resolved filesystem path that could not be accessed.
 */
export interface CatalogBuildError {
  readonly kind: "unreadable_input";
  readonly path: string;
}

/**
 * Successful result of catalog construction containing the resolved catalog and any diagnostic findings.
 *
 * @remarks
 * Invariant: `catalog.documents` contains only active (non-archived) documents with at most
 * one delta spec per capability. Conflicting deltas are recorded in `findings`.
 */
export interface CatalogBuildOutput {
  readonly catalog: Catalog;
  readonly findings: readonly Finding[];
}

/**
 * Resolve input paths into a deterministic active OpenSpec catalog.
 *
 * @param inputs - CLI input files and/or directories
 * @returns active catalog with conflict findings or unreadable-input error
 */
export async function buildCatalog(inputs: readonly string[]): Promise<Result<CatalogBuildOutput, CatalogBuildError>> {
  const discoveredFiles: string[] = [];
  for (const input of inputs) {
    const resolved = resolve(input);
    const files = await collectFiles(resolved);
    if (!files.ok) {
      return files;
    }
    discoveredFiles.push(...files.value);
  }

  const classified = discoveredFiles
    .map(classifyDocument)
    .filter((entry): entry is CatalogDocument => entry !== undefined)
    .filter((entry) => !entry.path.includes("/openspec/changes/archive/"));

  const { activeDocuments, findings } = resolveActiveCapabilities(classified);

  return ok({
    catalog: {
      documents: activeDocuments,
      skippedDeltaConflicts: findings
        .filter((finding) => finding.category === "catalog.delta_conflict")
        .map((finding) => {
          const [skippedPathEvidence, keptPathEvidence, capabilityEvidence] = finding.evidence;
          return {
            capability: toCapabilityName(capabilityEvidence?.value ?? "unknown"),
            skippedPath: skippedPathEvidence?.value ?? "unknown",
            keptPath: keptPathEvidence?.value ?? "unknown",
          };
        }),
    },
    findings,
  });
}

/**
 * Recursively collect all file paths under a given filesystem path.
 *
 * @param path - resolved absolute filesystem path (file or directory)
 * @returns flat array of file paths, or an unreadable_input error if stat/readdir fails
 *
 * @remarks
 * Precondition: `path` is a resolved absolute path.
 * Postcondition: on success, every entry in the returned array is a regular file path.
 * Recursion is bounded by filesystem depth.
 */
async function collectFiles(path: string): Promise<Result<readonly string[], CatalogBuildError>> {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    return err({ kind: "unreadable_input", path });
  }

  if (stats.isFile()) {
    return ok([path]);
  }

  if (!stats.isDirectory()) {
    return ok([]);
  }

  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return err({ kind: "unreadable_input", path });
  }

  const files: string[] = [];
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(childPath);
      if (!nested.ok) {
        return nested;
      }
      files.push(...nested.value);
      continue;
    }

    if (entry.isFile()) {
      files.push(childPath);
    }
  }

  return ok(files);
}

/**
 * Classify a file path as an OpenSpec document by its basename.
 *
 * @param path - absolute file path to classify
 * @returns catalog document descriptor, or `undefined` if the file is not a recognized document type
 *
 * @remarks
 * Precondition: `path` is a non-empty file path with a recognizable basename.
 * Postcondition: when a value is returned, `type` and `source` are consistent with the path structure.
 * Only `proposal.md`, `design.md`, `tasks.md`, and `spec.md` are recognized.
 */
export function classifyDocument(path: string): CatalogDocument | undefined {
  const name = basename(path);
  if (name !== "proposal.md" && name !== "design.md" && name !== "tasks.md" && name !== "spec.md") {
    return undefined;
  }

  const typeByName: Record<string, DocumentType> = {
    "proposal.md": "proposal",
    "design.md": "design",
    "tasks.md": "task",
    "spec.md": "spec",
  };

  const type = typeByName[name];
  if (type === undefined) {
    return undefined;
  }
  const capability: CapabilityName | undefined = type === "spec" ? inferCapabilityName(path) : undefined;
  const source = path.includes("/openspec/changes/") ? "delta" : "final";

  return {
    path,
    type,
    source,
    ...(capability === undefined ? {} : { capability }),
  };
}

/**
 * Infer the capability name from a spec file path by extracting the segment after `specs/`.
 *
 * @param path - absolute path to a spec document
 * @returns branded capability name, or `undefined` if the path does not contain a `specs/` segment
 *
 * @remarks
 * Precondition: `path` uses forward-slash separators.
 * Postcondition: when defined, the returned name is the directory segment immediately following
 * the last occurrence of `specs` in the path.
 */
export function inferCapabilityName(path: string): CapabilityName | undefined {
  const segments = path.split("/");
  const specsIndex = segments.lastIndexOf("specs");
  if (specsIndex < 0 || specsIndex + 1 >= segments.length) {
    return undefined;
  }

  const segment = segments[specsIndex + 1];
  return segment === undefined ? undefined : toCapabilityName(segment);
}

/**
 * Resolve active capability documents from a set of classified documents, selecting at most
 * one delta per capability and emitting conflict findings for duplicates.
 *
 * @param documents - classified catalog documents (may include multiple deltas per capability)
 * @returns active document set and any delta-conflict findings
 *
 * @remarks
 * Precondition: all documents have been classified by `classifyDocument`.
 * Postcondition: `activeDocuments` contains at most one finalized spec and one delta spec per
 * capability, sorted lexicographically by path. Conflicts are deterministically resolved by
 * choosing the lexicographically first delta path.
 * Invariant: non-spec documents pass through unconditionally.
 */
export function resolveActiveCapabilities(documents: readonly CatalogDocument[]): {
  readonly activeDocuments: readonly CatalogDocument[];
  readonly findings: readonly Finding[];
} {
  const nonSpecs = documents.filter((document) => document.type !== "spec");
  const specs = documents.filter((document): document is CatalogDocument & { readonly type: "spec" } => document.type === "spec");

  const finalByCapability = new Map<string, CatalogDocument>();
  const deltasByCapability = new Map<string, CatalogDocument[]>();

  for (const spec of specs) {
    const capability = spec.capability;
    if (capability === undefined) {
      continue;
    }

    if (spec.source === "final") {
      finalByCapability.set(capability, spec);
      continue;
    }

    // Ownership: arrays are local to this Map; mutation avoids O(n^2) spread copies.
    const existing = deltasByCapability.get(capability);
    if (existing !== undefined) {
      existing.push(spec);
    } else {
      deltasByCapability.set(capability, [spec]);
    }
  }

  const findings: Finding[] = [];
  const selectedSpecs: CatalogDocument[] = [];

  const allCapabilities = new Set<string>([...finalByCapability.keys(), ...deltasByCapability.keys()]);
  for (const capability of [...allCapabilities].sort((left, right) => left.localeCompare(right))) {
    const finalized = finalByCapability.get(capability);
    if (finalized !== undefined) {
      selectedSpecs.push(finalized);
    }

    const deltas = [...(deltasByCapability.get(capability) ?? [])].sort((left, right) => left.path.localeCompare(right.path));
    if (deltas.length === 0) {
      continue;
    }

    const kept = deltas[0];
    if (kept !== undefined) {
      selectedSpecs.push(kept);
    }

    for (let index = 1; index < deltas.length; index += 1) {
      const skipped = deltas[index];
      if (kept === undefined || skipped === undefined) {
        continue;
      }

      findings.push({
        severity: "warning",
        category: "catalog.delta_conflict",
        provenance: { file: skipped.path },
        description: `Skipped conflicting in-development delta for capability ${capability}`,
        evidence: [
          { kind: "skipped_path", value: skipped.path },
          { kind: "kept_path", value: kept.path },
          { kind: "capability", value: capability },
        ],
      });
    }
  }

  const activeDocuments = [...nonSpecs, ...selectedSpecs].sort((left, right) => left.path.localeCompare(right.path));

  return { activeDocuments, findings };
}
