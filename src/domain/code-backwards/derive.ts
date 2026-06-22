/**
 * Derives informal specifications from source code by prompting an LLM to
 * infer behavioral claims that the implementation satisfies.
 *
 * Entry point for the code-backwards pipeline — generates claims before formalization.
 * Exports: deriveSpecsFromCode, DeriveResult.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { callOpencode } from "../../adapters/opencode.js";
import { writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, type OutputDirPath } from "../branded.js";
import type { Finding } from "../findings.js";
import type { SourceTrace } from "./trace.js";
import { INFORMALIZE_INSTRUCTIONS, buildCapabilitySuggestionsSection, buildSourceContextSection } from "../prompts/informalize.js";

/** Maximum total bytes of source content to include in a single LLM prompt. */
const SOURCE_CONTENT_BUDGET_BYTES = 100_000;

/** Maximum individual file size to include in the prompt. */
const SOURCE_FILE_MAX_BYTES = 30_000;

/** Extensions to include in source scanning for informalization. */
const SCANNABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".rs", ".go", ".py", ".java", ".kt", ".c", ".h", ".cpp", ".hpp",
  ".sh", ".bash", ".zsh",
]);

/**
 * A code-derived capability spec generated from source informalization.
 *
 * @remarks
 * Invariant: `markdown` follows the EARS-preferring spec template structure.
 * Invariant: `requirements` contains the actual EARS requirement texts from informalization.
 * Invariant: `sourceIdentifiers` contains identifiers traced from source (may be empty
 * when informalization discovered capabilities without explicit trace tags).
 */
export interface DerivedCapabilitySpec {
  readonly capability: string;
  readonly markdown: string;
  readonly requirements: readonly { readonly id: string; readonly text: string }[];
  readonly sourceIdentifiers: readonly string[];
}

/**
 * Output from the code-derived spec generation pass.
 *
 * @remarks
 * Invariant: `specs` contains one entry per capability identified by informalization.
 * Invariant: `findings` includes diagnostics from the LLM informalization process.
 */
export interface DerivedSpecOutput {
  readonly specs: readonly DerivedCapabilitySpec[];
  readonly findings: readonly Finding[];
}

/**
 * Generate EARS-preferring code-derived capability specs via LLM informalization.
 *
 * Strategy (ClaimCheck-inspired):
 * 1. Scan the source directory to build a structured file listing and content context.
 * 2. Send source context to the LLM WITHOUT any original requirement text.
 * 3. The LLM produces behavioral specs based solely on what it reads in the code.
 * 4. Parse LLM output into DerivedCapabilitySpec entries.
 *
 * Source traces (from phase 9) are used as supplementary evidence but NOT as a gate —
 * informalization proceeds even without any trace matches.
 *
 * @param input - source directory, output path, model, and optional trace data
 * @returns derived specs and diagnostic findings
 *
 * @example
 * ```ts
 * const { specs, findings } = await deriveSpecsFromSource({
 *   outputDir: toOutputDirPath("./output"),
 *   srcDir: "./src",
 *   model: "anthropic:claude-sonnet-4-20250514",
 *   traces: sourceTraces,
 *   suggestedCapabilities: ["auth-session", "data-export"],
 * });
 * console.log(`Derived ${specs.length} capability specs`);
 * ```
 *
 * @remarks
 * Precondition: `input.outputDir` is a valid, writable output directory path.
 * Postcondition: on success, generated spec markdown files are atomically written to
 * `gen_specs/` under `outputDir`. Returns partial results — LLM failures produce
 * error findings rather than throwing.
 * Failure modes: propagates filesystem write errors from `writeOutputAtomic`. LLM call
 * failures are captured as error-severity findings (does not throw).
 * Safety: performs network I/O (LLM call) and filesystem I/O (source scan + artifact write).
 * No shared mutable state between calls.
 */
export async function deriveSpecsFromSource(input: {
  readonly outputDir: OutputDirPath;
  readonly srcDir: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly traces: readonly SourceTrace[];
  readonly suggestedCapabilities?: readonly string[];
}): Promise<DerivedSpecOutput> {
  const findings: Finding[] = [];

  // Scan source directory for file listing and content.
  const sourceContext = await buildSourceContext(input.srcDir);

  if (sourceContext.attachedFiles.length === 0) {
    findings.push({
      severity: "warning",
      category: "code_derived.no_source_files",
      provenance: { file: input.srcDir },
      description: `No scannable source files found in ${input.srcDir}`,
      rationale: "Cannot derive a specification when no source files are available to analyze",
      evidence: [{ kind: "directory", value: input.srcDir }],
    });
    return { specs: [], findings };
  }

  // Build prompt with source context (no requirement text — blind informalization).
  const prompt = buildInformalizationPrompt(sourceContext, input.suggestedCapabilities);

  // Call LLM with extended timeout for large codebases.
  const response = await callOpencode({
    model: input.model,
    phase: "code-derived-generation",
    prompt,
    files: sourceContext.attachedFiles.map((file) => file.absolutePath),
    retries: 2,
    timeoutMs: input.timeoutMs,
  });

  if (!response.ok) {
    findings.push({
      severity: "error",
      category: "code_derived.informalization_failed",
      provenance: { file: input.srcDir },
      description: `Code informalization LLM call failed: ${response.error.message}`,
      rationale: "The LLM informalization step is required to translate source code into natural-language specifications",
      evidence: [{ kind: "phase", value: "code-derived-generation" }],
    });
    return { specs: [], findings };
  }

  // Parse LLM response into capability specs.
  const parsed = parseInformalizationResponse(response.value, input.traces);
  findings.push(...parsed.findings);

  // Write generated specs to output directory.
  const specs: DerivedCapabilitySpec[] = [];
  for (const cap of parsed.capabilities) {
    const markdown = formatCapabilityMarkdown(cap);
    const outputPath = toRelativePath(`gen_specs/${cap.name}.md`);
    await writeOutputAtomic(input.outputDir, outputPath, `${markdown}\n`);
    specs.push({
      capability: cap.name,
      markdown: `${markdown}\n`,
      requirements: cap.requirements.map((r) => ({ id: r.id, text: r.text })),
      sourceIdentifiers: cap.sourceIdentifiers,
    });
  }

  return { specs, findings };
}

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

/**
 * Collected source tree context used to construct the informalization prompt.
 *
 * @remarks
 * Invariant: `fileList` is sorted lexicographically and contains relative paths
 * for all files discovered under the source directory (excluding common non-source
 * directories such as node_modules, .git, dist, build, coverage).
 * Invariant: `fileContents` is a subset of `fileList` — every path in
 * `fileContents` also appears in `fileList`.
 * Invariant: the combined byte length of all `content` entries does not exceed
 * SOURCE_CONTENT_BUDGET_BYTES.
 */
interface SourceContext {
  readonly fileList: readonly string[];
  readonly attachedFiles: readonly { readonly relativePath: string; readonly absolutePath: string }[];
}

/**
 * Scan source directory to build structured context for the informalization prompt.
 *
 * @param srcDir - absolute path to source directory
 * @returns file listing and selected file contents within budget
 *
 * @remarks
 * Precondition: `srcDir` is a valid filesystem path (need not exist — produces empty result).
 * Postcondition: returned `fileList` is sorted lexicographically; `fileContents` is a
 * subset of `fileList` whose combined byte length does not exceed SOURCE_CONTENT_BUDGET_BYTES.
 * Failure modes: filesystem errors on individual files are silently caught — unreadable
 * files are skipped without aborting. If `srcDir` itself is unreadable, returns empty context.
 * Safety: performs I/O; no shared mutable state.
 */
async function buildSourceContext(srcDir: string): Promise<SourceContext> {
  const allFiles: string[] = [];
  await walkDirectory(srcDir, srcDir, allFiles);
  allFiles.sort();

  // Select files for attachment inclusion within budget.
  const attachedFiles: { relativePath: string; absolutePath: string }[] = [];
  let totalBytes = 0;

  for (const filePath of allFiles) {
    if (totalBytes >= SOURCE_CONTENT_BUDGET_BYTES) break;

    const ext = extname(filePath).toLowerCase();
    if (!SCANNABLE_EXTENSIONS.has(ext)) continue;

    try {
      const fileStat = await stat(join(srcDir, filePath));
      if (fileStat.size > SOURCE_FILE_MAX_BYTES) continue;
      if (totalBytes + fileStat.size > SOURCE_CONTENT_BUDGET_BYTES) continue;

      const content = await readFile(join(srcDir, filePath), "utf-8");
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (contentBytes > SOURCE_FILE_MAX_BYTES) continue;
      if (totalBytes + contentBytes > SOURCE_CONTENT_BUDGET_BYTES) continue;

      attachedFiles.push({
        relativePath: filePath,
        absolutePath: join(srcDir, filePath),
      });
      totalBytes += contentBytes;
    } catch {
      // Skip unreadable files.
    }
  }

  return { fileList: allFiles, attachedFiles };
}

/**
 * Directory names excluded from source traversal.
 *
 * @remarks
 * These represent common non-source output directories that would pollute
 * the source context with compiled artifacts, dependencies, or test output.
 * Extending this set is safe — it only reduces the traversal scope.
 */
const EXCLUDED_SOURCE_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "out",
  "target",
  ".next",
  ".turbo",
  "__pycache__",
  ".venv",
]);

/** Maximum directory traversal depth for source context collection. */
const MAX_SOURCE_WALK_DEPTH = 50;

/**
 * Recursively walk a directory and collect relative file paths.
 *
 * @param baseDir - absolute root path used to compute relative paths
 * @param currentDir - absolute path of the directory currently being traversed
 * @param results - mutable accumulator for discovered relative file paths
 * @param depth - remaining recursion budget; stops descending when zero
 * @returns resolves when traversal is complete; results are appended to `results`
 *
 * @remarks
 * Precondition: `baseDir` is a prefix of `currentDir`.
 * Precondition: `depth >= 0`.
 * Postcondition: all regular files reachable from `currentDir` (excluding directories
 * in {@link EXCLUDED_SOURCE_DIRECTORIES}) are appended to `results` as relative paths
 * from `baseDir`, up to the depth limit.
 * Failure modes: if `readdir` fails on `currentDir`, returns without appending
 * anything — does not throw. Silently stops if depth is exhausted.
 * Safety: mutates `results` array; caller owns the array exclusively.
 * Bounded recursion: cannot exceed `MAX_SOURCE_WALK_DEPTH` stack frames.
 */
async function walkDirectory(baseDir: string, currentDir: string, results: string[], depth: number = MAX_SOURCE_WALK_DEPTH): Promise<void> {
  if (depth <= 0) {
    // Safety: silently stop — source context is best-effort, not critical.
    return;
  }

  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip common non-source directories that contain build outputs or dependencies.
    if (entry.isDirectory() && EXCLUDED_SOURCE_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(baseDir, fullPath, results, depth - 1);
    } else if (entry.isFile()) {
      results.push(relative(baseDir, fullPath));
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the informalization prompt from source context and optional capability suggestions.
 *
 * @param sourceContext - structured source file listing and contents
 * @param suggestedCapabilities - optional capability names to hint at during informalization
 * @returns assembled prompt string ready for LLM submission
 *
 * @remarks
 * Precondition: `sourceContext` conforms to the SourceContext invariants.
 * Postcondition: returned string includes INFORMALIZE_INSTRUCTIONS, optional capability
 * suggestions section, and source context section — never includes original requirement text.
 * Failure modes: none — pure computation.
 */
function buildInformalizationPrompt(
  sourceContext: SourceContext,
  suggestedCapabilities?: readonly string[],
): string {
  const sections = [
    INFORMALIZE_INSTRUCTIONS,
    "",
    "Treat attached source files as the only trusted evidence input. Do not infer requirements from comments about specs.",
  ];

  if (suggestedCapabilities !== undefined && suggestedCapabilities.length > 0) {
    sections.push("", buildCapabilitySuggestionsSection(suggestedCapabilities));
  }

  sections.push(
    "",
    "Use attached source files for full content. The listing below describes project scope.",
    buildSourceContextSection({
      fileList: sourceContext.fileList,
      fileContents: [],
    }),
  );
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * A single capability extracted and validated from the LLM informalization response.
 *
 * @remarks
 * Invariant: `name` is a non-empty string — entries with missing or empty names
 * are rejected during parsing.
 * Invariant: each entry in `requirements` has a non-empty `id` and `text` — malformed
 * requirement entries are filtered out before inclusion.
 * Invariant: `sourceIdentifiers` contains trace identifiers resolved from source
 * evidence files; it may be empty if no trace mapping exists for the capability's files.
 */
interface ParsedCapability {
  readonly name: string;
  readonly description: string;
  readonly requirements: readonly { readonly id: string; readonly text: string; readonly evidence: readonly string[] }[];
  readonly sourceIdentifiers: readonly string[];
}

/**
 * Validated parse result of the full LLM informalization response.
 *
 * @remarks
 * Invariant: if the response failed structural validation (not an object, or
 * missing `capabilities` array), `capabilities` is empty and `findings` contains
 * at least one error-severity finding describing the failure.
 * Invariant: each entry in `capabilities` passed field-level validation; malformed
 * entries are excluded and reported as warning findings.
 */
interface ParsedInformalizationResponse {
  readonly capabilities: readonly ParsedCapability[];
  readonly findings: readonly Finding[];
}

/**
 * Parse the LLM informalization response into structured capabilities.
 *
 * @param response - raw LLM response value (untrusted — may be any JSON shape)
 * @param traces - source traces for supplementary identifier mapping
 * @returns parsed capabilities and diagnostic findings
 *
 * @remarks
 * Precondition: none — handles arbitrary input defensively.
 * Postcondition: if `response` is structurally valid, `capabilities` contains
 * parsed entries that passed field-level validation; otherwise `capabilities` is
 * empty and `findings` contains at least one error-severity diagnostic.
 * Failure modes: none — does not throw. Structural errors are captured as findings.
 */
function parseInformalizationResponse(
  response: unknown,
  traces: readonly SourceTrace[],
): ParsedInformalizationResponse {
  const findings: Finding[] = [];

  if (typeof response !== "object" || response === null) {
    findings.push({
      severity: "error",
      category: "code_derived.parse_failed",
      provenance: { file: "<informalization>" },
      description: "Informalization response is not a JSON object",
      rationale: "The informalization response must be a valid JSON object to extract capability specifications",
      evidence: [{ kind: "response_type", value: typeof response }],
    });
    return { capabilities: [], findings };
  }

  const record = response as { readonly capabilities?: unknown };
  if (!Array.isArray(record.capabilities)) {
    findings.push({
      severity: "error",
      category: "code_derived.parse_failed",
      provenance: { file: "<informalization>" },
      description: "Informalization response missing 'capabilities' array",
      rationale: "The response schema requires a top-level 'capabilities' array to enumerate derived specs",
      evidence: [{ kind: "keys", value: Object.keys(response as object).join(", ") }],
    });
    return { capabilities: [], findings };
  }

  // Build trace identifier lookup by file path.
  const traceByFile = new Map<string, string[]>();
  for (const trace of traces) {
    for (const file of trace.files) {
      const existing = traceByFile.get(file);
      if (existing !== undefined) {
        existing.push(trace.identifier);
      } else {
        traceByFile.set(file, [trace.identifier]);
      }
    }
  }

  const capabilities: ParsedCapability[] = [];
  for (const entry of record.capabilities) {
    const parsed = parseCapabilityEntry(entry, traceByFile);
    if (parsed !== undefined) {
      capabilities.push(parsed);
    } else {
      findings.push({
        severity: "warning",
        category: "code_derived.invalid_capability_entry",
        provenance: { file: "<informalization>" },
        description: "Skipped malformed capability entry in informalization response",
        rationale: "Each capability entry must conform to the expected shape to produce a valid derived spec",
        evidence: [{ kind: "raw", value: JSON.stringify(entry).slice(0, 200) }],
      });
    }
  }

  return { capabilities, findings };
}

/**
 * Parse a single capability entry from the LLM response.
 *
 * @param entry - untrusted capability entry object from the LLM response array
 * @param traceByFile - lookup map from file paths to trace identifiers
 * @returns parsed capability if structurally valid, or `undefined` if malformed
 *
 * @remarks
 * Precondition: none — handles arbitrary input defensively.
 * Postcondition: returns `undefined` for any entry missing required fields (name,
 * description, requirements array with at least one valid requirement).
 * When returning a value, guarantees non-empty `name` and non-empty `requirements`.
 * Failure modes: none — pure computation, never throws.
 */
function parseCapabilityEntry(
  entry: unknown,
  traceByFile: ReadonlyMap<string, string[]>,
): ParsedCapability | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;

  const record = entry as {
    readonly name?: unknown;
    readonly description?: unknown;
    readonly requirements?: unknown;
  };

  if (typeof record.name !== "string" || record.name.length === 0) return undefined;
  if (typeof record.description !== "string") return undefined;
  if (!Array.isArray(record.requirements)) return undefined;

  const requirements: { id: string; text: string; evidence: string[] }[] = [];
  const sourceIdentifiers = new Set<string>();

  for (const req of record.requirements) {
    if (typeof req !== "object" || req === null) continue;
    const reqRecord = req as { readonly id?: unknown; readonly text?: unknown; readonly evidence?: unknown };
    if (typeof reqRecord.id !== "string" || typeof reqRecord.text !== "string") continue;

    const evidence = Array.isArray(reqRecord.evidence)
      ? reqRecord.evidence.filter((e): e is string => typeof e === "string")
      : [];

    requirements.push({ id: reqRecord.id, text: reqRecord.text, evidence });

    // Map evidence file paths to known trace identifiers.
    for (const evidenceFile of evidence) {
      const ids = traceByFile.get(evidenceFile);
      if (ids !== undefined) {
        for (const id of ids) {
          sourceIdentifiers.add(id);
        }
      }
    }
  }

  if (requirements.length === 0) return undefined;

  return {
    name: record.name,
    description: record.description,
    requirements,
    sourceIdentifiers: [...sourceIdentifiers],
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Format a parsed capability into EARS-preferring markdown spec structure.
 *
 * @param cap - validated parsed capability with name, description, and requirements
 * @returns markdown string following the EARS-preferring spec template
 *
 * @remarks
 * Precondition: `cap` satisfies the ParsedCapability invariants (non-empty name, non-empty requirements).
 * Postcondition: returned markdown includes a top-level heading, description blockquote,
 * and requirement subsections with evidence annotations.
 * Failure modes: none — pure computation.
 */
function formatCapabilityMarkdown(cap: ParsedCapability): string {
  const requirements = cap.requirements.map((req) => {
    const evidenceNote = req.evidence.length > 0
      ? `\n<!-- Evidence: ${req.evidence.join(", ")} -->`
      : "";
    return `### Requirement: ${req.id}\n${req.text}${evidenceNote}`;
  });

  return [
    `# Capability: ${cap.name}`,
    "",
    `> ${cap.description}`,
    "",
    "## ADDED Requirements",
    "",
    ...requirements,
    "",
    "## MODIFIED Requirements",
    "",
    "## REMOVED Requirements",
    "",
    "## RENAMED Requirements",
    "",
  ].join("\n");
}

/**
 * Infer a capability name from a trace identifier by extracting the first two hyphenated segments.
 *
 * @param identifier - canonical trace identifier (e.g., "AUTH-SESSION-001")
 * @returns lowercase capability prefix (e.g., "auth-session")
 *
 * @remarks
 * Precondition: `identifier` is a non-empty string.
 * Postcondition: returned string is lowercase; single-segment identifiers are returned as-is.
 * Invariant: at most the first two hyphenated parts are retained.
 * Failure modes: none — pure computation.
 */
export function inferCapability(identifier: string): string {
  const normalized = identifier.toLowerCase();
  const parts = normalized.split("-");
  if (parts.length <= 1) {
    return normalized;
  }
  return parts.slice(0, 2).join("-");
}
