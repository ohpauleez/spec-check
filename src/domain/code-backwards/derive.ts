import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { callOpencode } from "../../adapters/opencode.js";
import { writeOutputAtomic } from "../../adapters/fs.js";
import { toRelativePath, type OutputDirPath } from "../branded.js";
import type { Finding } from "../findings.js";
import type { SourceTrace } from "./trace.js";
import { INFORMALIZE_INSTRUCTIONS, buildSourceContextSection } from "../prompts/informalize.js";

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
 */
export async function deriveSpecsFromSource(input: {
  readonly outputDir: OutputDirPath;
  readonly srcDir: string;
  readonly model: string;
  readonly traces: readonly SourceTrace[];
}): Promise<DerivedSpecOutput> {
  const findings: Finding[] = [];

  // Scan source directory for file listing and content.
  const sourceContext = await buildSourceContext(input.srcDir);

  if (sourceContext.fileContents.length === 0) {
    findings.push({
      severity: "warning",
      category: "code_derived.no_source_files",
      provenance: { file: input.srcDir },
      description: `No scannable source files found in ${input.srcDir}`,
      evidence: [{ kind: "directory", value: input.srcDir }],
    });
    return { specs: [], findings };
  }

  // Build prompt with source context (no requirement text — blind informalization).
  const prompt = buildInformalizationPrompt(sourceContext);

  // Call LLM with extended timeout for large codebases.
  const response = await callOpencode({
    model: input.model,
    phase: "code-derived-generation",
    prompt,
    retries: 2,
    timeoutMs: 300_000,
  });

  if (!response.ok) {
    findings.push({
      severity: "error",
      category: "code_derived.informalization_failed",
      provenance: { file: input.srcDir },
      description: `Code informalization LLM call failed: ${response.error.message}`,
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

interface SourceContext {
  readonly fileList: readonly string[];
  readonly fileContents: readonly { readonly path: string; readonly content: string }[];
}

/**
 * Scan source directory to build structured context for the informalization prompt.
 *
 * @param srcDir - absolute path to source directory
 * @returns file listing and selected file contents within budget
 */
async function buildSourceContext(srcDir: string): Promise<SourceContext> {
  const allFiles: string[] = [];
  await walkDirectory(srcDir, srcDir, allFiles);
  allFiles.sort();

  // Select files for content inclusion within budget.
  const fileContents: { path: string; content: string }[] = [];
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
      fileContents.push({ path: filePath, content });
      totalBytes += content.length;
    } catch {
      // Skip unreadable files.
    }
  }

  return { fileList: allFiles, fileContents };
}

/**
 * Recursively walk a directory and collect relative file paths.
 */
async function walkDirectory(baseDir: string, currentDir: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip common non-source directories.
    if (entry.isDirectory() && (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build" || entry.name === "coverage")) {
      continue;
    }

    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(baseDir, fullPath, results);
    } else if (entry.isFile()) {
      results.push(relative(baseDir, fullPath));
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the informalization prompt from source context.
 */
function buildInformalizationPrompt(sourceContext: SourceContext): string {
  return [
    INFORMALIZE_INSTRUCTIONS,
    "",
    "Treat all source code below as the only input. Do not infer requirements from comments about specs.",
    "",
    buildSourceContextSection(sourceContext),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface ParsedCapability {
  readonly name: string;
  readonly description: string;
  readonly requirements: readonly { readonly id: string; readonly text: string; readonly evidence: readonly string[] }[];
  readonly sourceIdentifiers: readonly string[];
}

interface ParsedInformalizationResponse {
  readonly capabilities: readonly ParsedCapability[];
  readonly findings: readonly Finding[];
}

/**
 * Parse the LLM informalization response into structured capabilities.
 *
 * @param response - raw LLM response value
 * @param traces - source traces for supplementary identifier mapping
 * @returns parsed capabilities and diagnostic findings
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
        evidence: [{ kind: "raw", value: JSON.stringify(entry).slice(0, 200) }],
      });
    }
  }

  return { capabilities, findings };
}

/**
 * Parse a single capability entry from the LLM response.
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
 */
export function inferCapability(identifier: string): string {
  const normalized = identifier.toLowerCase();
  const parts = normalized.split("-");
  if (parts.length <= 1) {
    return normalized;
  }
  return parts.slice(0, 2).join("-");
}
