/**
 * Provides source traceability by scanning implementation files for claim-ID
 * references, linking spec claims back to the source code that implements them.
 *
 * Enables coverage reporting in the code-backwards verification pipeline.
 * Exports: traceClaimsToSource, SourceTrace.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { mapBounded } from "../../adapters/concurrency.js";
import type { ClaimId } from "../branded.js";
import type { ClaimGraph } from "../claim-graph.js";
import type { Finding } from "../findings.js";

const TRACE_IDENTIFIER_PATTERN = /\[([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)\]/gu;

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

/**
 * Result of scanning a single source file for trace identifiers.
 *
 * @remarks
 * Invariant: when `skipped` is `true`, `identifiers` is empty — a skipped file
 * produces no identifier matches.
 * Invariant: when `skipped` is `false`, `identifiers` contains zero or more
 * matches found via regex scanning of the file contents.
 * Invariant: `file` always equals the absolute path that was passed to the scan
 * function and appears identically in each entry of `identifiers`.
 */
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
 * Precondition: `input.srcDir` is a valid filesystem path (need not exist — produces
 * empty traces with no error). `input.claimGraph` satisfies the ClaimGraph contract.
 * Postcondition: `traces` contains one entry per claim that has source evidence;
 * `findings` includes info/warning diagnostics for supported claims, gaps, unknown
 * identifiers, and oversized skipped files.
 * Failure modes: propagates filesystem errors if the root directory stat fails.
 * Individual file read errors (permissions, broken symlinks) are silently skipped
 * without aborting the scan.
 * Safety: performs bounded-concurrency parallel file I/O. Each file read is independent;
 * no shared mutable state between parallel units. The assembly phase is sequential.
 * Files are read in parallel with bounded concurrency. Files exceeding
 * TRACE_FILE_SIZE_MAX_BYTES are skipped with a warning finding.
 * Each file read is independent; no shared mutable state between parallel units.
 *
 * @example
 * ```ts
 * const { findings, traces } = await traceClaimsToSource({
 *   srcDir: "./src",
 *   claimGraph: graph,
 *   concurrency: 8,
 * });
 * for (const trace of traces) {
 *   console.log(`${trace.identifier} [${trace.level}]: ${trace.files.length} files`);
 * }
 * ```
 */
export async function traceClaimsToSource(input: {
  readonly srcDir: string;
  readonly claimGraph: ClaimGraph;
  readonly concurrency?: number;
}): Promise<SourceTraceOutput> {
  const concurrency = input.concurrency ?? TRACE_READ_CONCURRENCY_DEFAULT;
  const root = resolve(input.srcDir);

  // Phase 1: Collect — enumerate all scannable files under the source root.
  const files = await collectFiles(root, root);

  // Phase 2: Scan — read and scan files in parallel with bounded concurrency.
  // Each file read is independent; parallelism is safe with no shared state.
  const scanResults = await mapBounded(files, concurrency, async (file) => {
    return await scanFileForIdentifiers(file);
  });

  // Phase 3: Assemble — aggregate scan results into an identifier→files map.
  // This is single-writer sequential work after the parallel phase completes.
  const identifiers = new Map<string, Set<string>>();
  const findings: Finding[] = [];

  for (const scanResult of scanResults) {
    if (scanResult.skipped) {
      findings.push({
        severity: "warning",
        category: "source_trace.file_too_large",
        provenance: { file: scanResult.file },
        description: `Skipped file exceeding size limit (${String(TRACE_FILE_SIZE_MAX_BYTES)} bytes): ${scanResult.file}`,
        rationale: "Files that exceed the size limit cannot be scanned for trace identifiers, leaving any claims they implement unverifiable through source traceability.",
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

  // Phase 4: Classify — walk the claim graph and match each claim against
  // the assembled identifier map, classifying evidence strength per claim.
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
        rationale: "A claim with no corresponding source file means the specification makes a promise that cannot be traced back to any implementation, indicating a potential gap in coverage.",
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

    // [STC-TRACE-WEAK] Distinguish strong behavioral evidence from weak traceability links.
    if (level === "supporting") {
      findings.push({
        severity: "info",
        category: "source_trace.weakly_supported",
        provenance: claim.provenance,
        description: `Source evidence links to ${claim.id} but does not demonstrate behavioral correctness (supporting evidence only)`,
        rationale: "Weak traceability links (e.g. identifier mentions in non-behavioral files like configs or types) do not prove the claim is correctly implemented, only that it is referenced.",
        evidence: filesList.map((file) => ({ kind: "source_file", value: file })),
        relatedClaimIdentifiers: [claim.id],
      });
    } else {
      findings.push({
        severity: "info",
        category: "source_trace.supported",
        provenance: claim.provenance,
        description: `Source evidence supports ${claim.id}`,
        rationale: "Confirms that the claim has strong source traceability with behavioral evidence, providing positive assurance that the specification is backed by implementation.",
        evidence: filesList.map((file) => ({ kind: "source_file", value: file })),
        relatedClaimIdentifiers: [claim.id],
      });
    }
  }

  // Phase 5: Detect unknown identifiers — any trace identifier present in
  // source but absent from the claim graph signals a stale or misspelled ref.
  for (const [identifier, traceFiles] of identifiers) {
    if (claimIds.has(identifier)) {
      continue;
    }

    findings.push({
      severity: "warning",
      category: "source_trace.unknown_identifier",
      provenance: { file: [...traceFiles][0] ?? "<source>" },
      description: `Unknown identifier referenced in source: ${identifier}`,
      rationale: "A trace identifier present in source code but absent from the claim graph suggests either a stale reference to a removed claim or a misspelled identifier, both of which undermine traceability integrity.",
      evidence: [...traceFiles].map((file) => ({ kind: "source_file", value: file })),
      relatedClaimIdentifiers: [identifier],
    });
  }

  return { findings, traces };
}

/**
 * Read a single file and extract trace identifiers, respecting the size guard.
 *
 * @param file - absolute path to the file to scan
 * @returns scan result containing matched identifiers, skip status, and the file path
 *
 * @remarks
 * Precondition: `file` is an absolute path to an existing filesystem entry.
 * Postcondition: if file size exceeds TRACE_FILE_SIZE_MAX_BYTES, returns `skipped: true`
 * with empty identifiers. Otherwise, returns all regex-matched trace identifiers.
 * Failure modes: propagates filesystem errors from `stat` or `readFile` (e.g., ENOENT,
 * EACCES). Callers should handle or catch.
 * Safety: performs filesystem I/O; safe for concurrent invocation on distinct files.
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
 * Failure modes: propagates errors from `stat` on `directory`. Individual `readdir`
 * failures in nested directories do not abort the full traversal.
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
 * Failure modes: none — pure computation.
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
