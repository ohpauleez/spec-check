import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { mapBounded } from "../../adapters/concurrency.js";
import type { ClaimId } from "../branded.js";
import type { ClaimGraph } from "../claim-graph.js";
import type { Finding } from "../findings.js";

const TRACE_IDENTIFIER_PATTERN = /\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]/gu;

/** Maximum concurrent file reads during source tracing. */
const TRACE_READ_CONCURRENCY_DEFAULT = 16;

/** Maximum file size to scan for trace identifiers (bytes). */
const TRACE_FILE_SIZE_MAX_BYTES = 1_048_576; // 1 MiB

/**
 * File extensions eligible for trace identifier scanning.
 *
 * @remarks
 * Only text-based source, config, and documentation files are scanned.
 * Binary files (images, fonts, compiled artifacts) are excluded to
 * avoid wasted I/O and regex backtracking on non-textual content.
 */
const TRACE_SCANNABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".html", ".css", ".scss", ".less",
  ".rs", ".go", ".py", ".java", ".kt", ".c", ".h", ".cpp", ".hpp",
  ".sh", ".bash", ".zsh",
  ".env", ".cfg", ".ini", ".conf",
  ".xml", ".svg",
]);

/**
 * A single source-level trace linking a claim identifier to implementation files.
 *
 * @remarks
 * Invariant: `files` is sorted lexicographically and contains absolute paths.
 * Invariant: `level` classifies the strength of evidence based on file locations.
 */
export interface SourceTrace {
  readonly identifier: string;
  readonly files: readonly string[];
  readonly level: "primary" | "secondary" | "supporting";
}

/**
 * Output from the source tracing pass linking claims to implementation evidence.
 *
 * @remarks
 * Invariant: `traces` contains one entry per claim with source evidence.
 * Invariant: `findings` includes info findings for supported claims, warnings for gaps
 * and unknown identifiers, and warnings for oversized skipped files.
 */
export interface SourceTraceOutput {
  readonly findings: readonly Finding[];
  readonly traces: readonly SourceTrace[];
}

interface FileScanResult {
  readonly identifiers: readonly { readonly id: string; readonly file: string }[];
  readonly skipped: boolean;
  readonly file: string;
}

/**
 * Scan source tree for canonical identifier trace links with bounded parallel reads.
 *
 * @param input - Source directory and claim graph to trace against
 * @returns Findings and source traces linking claims to implementation files
 *
 * @remarks
 * Files are read in parallel with bounded concurrency. Files exceeding
 * TRACE_FILE_SIZE_MAX_BYTES are skipped with a warning finding.
 * Each file read is independent; no shared mutable state between parallel units.
 */
export async function traceClaimsToSource(input: {
  readonly srcDir: string;
  readonly claimGraph: ClaimGraph;
  readonly concurrency?: number;
}): Promise<SourceTraceOutput> {
  const concurrency = input.concurrency ?? TRACE_READ_CONCURRENCY_DEFAULT;
  const root = resolve(input.srcDir);
  const files = await collectFiles(root, root);

  // Read and scan files in parallel with bounded concurrency.
  const scanResults = await mapBounded(files, concurrency, async (file) => {
    return await scanFileForIdentifiers(file);
  });

  // Assemble identifier map from scan results (single-writer after parallel phase).
  const identifiers = new Map<string, Set<string>>();
  const findings: Finding[] = [];

  for (const scanResult of scanResults) {
    if (scanResult.skipped) {
      findings.push({
        severity: "warning",
        category: "source_trace.file_too_large",
        provenance: { file: scanResult.file },
        description: `Skipped file exceeding size limit (${String(TRACE_FILE_SIZE_MAX_BYTES)} bytes): ${scanResult.file}`,
        evidence: [{ kind: "source_file", value: scanResult.file }],
      });
      continue;
    }

    for (const { id, file } of scanResult.identifiers) {
      const existing = identifiers.get(id);
      if (existing !== undefined) {
        existing.add(file);
      } else {
        identifiers.set(id, new Set<string>([file]));
      }
    }
  }

  const claimIds: Set<string> = new Set(
    input.claimGraph.claims
      .map((claim) => claim.id)
      .filter((value): value is ClaimId => value !== undefined),
  );

  const traces: SourceTrace[] = [];

  for (const claim of input.claimGraph.claims) {
    if (claim.id === undefined) {
      continue;
    }

    const tracedFiles = identifiers.get(claim.id);
    if (tracedFiles === undefined || tracedFiles.size === 0) {
      findings.push({
        severity: "warning",
        category: "source_trace.gap",
        provenance: claim.provenance,
        description: `No source evidence found for ${claim.id}`,
        evidence: [{ kind: "claim_id", value: claim.id }],
        relatedClaimIdentifiers: [claim.id],
      });
      continue;
    }

    const filesList = [...tracedFiles].sort((left, right) => left.localeCompare(right));
    const level = classifyEvidenceLevel(filesList);
    traces.push({
      identifier: claim.id,
      files: filesList,
      level,
    });

    findings.push({
      severity: "info",
      category: "source_trace.supported",
      provenance: claim.provenance,
      description: `Source evidence supports ${claim.id}`,
      evidence: filesList.map((file) => ({ kind: "source_file", value: file })),
      relatedClaimIdentifiers: [claim.id],
    });
  }

  for (const [identifier, traceFiles] of identifiers) {
    if (claimIds.has(identifier)) {
      continue;
    }

    findings.push({
      severity: "warning",
      category: "source_trace.unknown_identifier",
      provenance: { file: [...traceFiles][0] ?? "<source>" },
      description: `Unknown identifier referenced in source: ${identifier}`,
      evidence: [...traceFiles].map((file) => ({ kind: "source_file", value: file })),
      relatedClaimIdentifiers: [identifier],
    });
  }

  return { findings, traces };
}

/**
 * Read a single file and extract trace identifiers, respecting the size guard.
 */
async function scanFileForIdentifiers(file: string): Promise<FileScanResult> {
  const fileStats = await stat(file);
  if (fileStats.size > TRACE_FILE_SIZE_MAX_BYTES) {
    return { identifiers: [], skipped: true, file };
  }

  const content = await readFile(file, "utf8");
  const identifiers: { id: string; file: string }[] = [];
  for (const match of content.matchAll(TRACE_IDENTIFIER_PATTERN)) {
    const id = match[1];
    if (id === undefined) {
      continue;
    }
    identifiers.push({ id, file });
  }

  return { identifiers, skipped: false, file };
}

/**
 * Recursively collect scannable files under a root directory.
 *
 * @param root - absolute root path for confinement checks
 * @param directory - current directory being traversed
 * @returns list of absolute file paths eligible for identifier scanning
 *
 * @remarks
 * Precondition: `root` is a resolved absolute path.
 * Postcondition: returned files are all inside `root` and have a scannable extension.
 * Invariant: non-file entries and files outside the root are excluded.
 * Files with unrecognized extensions (binary, compiled, media) are skipped
 * to avoid wasted I/O and regex backtracking on non-textual content.
 */
async function collectFiles(root: string, directory: string): Promise<readonly string[]> {
  const directoryStats = await stat(directory);
  if (!directoryStats.isDirectory()) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(root, entryPath);
      files.push(...nested);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const resolved = resolve(entryPath);
    if (!resolved.startsWith(root)) {
      continue;
    }

    // Skip files with unrecognized extensions to avoid scanning binary content.
    const extension = extname(entry.name).toLowerCase();
    if (extension.length > 0 && !TRACE_SCANNABLE_EXTENSIONS.has(extension)) {
      continue;
    }

    files.push(resolved);
  }

  return files;
}

/**
 * Classify evidence strength based on file paths containing the trace identifier.
 *
 * @param files - sorted list of absolute file paths containing the identifier
 * @returns "primary" if any file is in /src/ or is a .ts file, "secondary" for test files,
 *          "supporting" otherwise
 *
 * @remarks
 * Postcondition: classification is deterministic given the same file set.
 * Invariant: primary > secondary > supporting in evidence strength ordering.
 */
function classifyEvidenceLevel(files: readonly string[]): "primary" | "secondary" | "supporting" {
  if (files.some((file) => file.includes("/src/") || file.endsWith(".ts"))) {
    return "primary";
  }
  if (files.some((file) => file.includes("/test/"))) {
    return "secondary";
  }
  return "supporting";
}
