import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/run-cli.js";
import { toModelName, toOutputDirPath, toRelativePath } from "../../src/domain/branded.js";
import { DEFAULT_ANALYSIS } from "../../src/domain/formal/analysis-config.js";
import { traceSpec } from "../support/spec-trace.js";
import type * as ProcessModule from "../../src/adapters/process.js";
import type { RunProcessOptions } from "../../src/adapters/process.js";
import * as OutputFs from "../../src/adapters/fs.js";
import { createHash } from "node:crypto";
import * as CoreArtifacts from "../../src/adapters/core-artifacts.js";

const provider = vi.hoisted(() => ({ invalidPredicates: false, invalidReport: false }));

vi.mock("../../src/adapters/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessModule>();
  return { ...actual, runProcess: vi.fn(async (command: string, args: readonly string[], options?: RunProcessOptions) => {
    if (command !== "opencode") return await actual.runProcess(command, args, options);
    if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "1.19.3\n", stderr: "", timedOut: false };
    let payload: unknown = { findings: [] };
    if (provider.invalidReport && args.includes("--agent")) payload = { wrongReport: true };
    const fileIndex = args.indexOf("--file");
    if (fileIndex >= 0 && args[fileIndex + 1]?.endsWith(".ts")) payload = { capabilities: [{ name: "surface", description: "Independent generated response behavior", requirements: [{ id: "GEN-RESPONSE", text: "WHEN called, THE engine MAY respond.", evidence: ["engine.ts"] }] }] };
    if (fileIndex >= 0 && args[fileIndex + 1]?.endsWith(".json")) {
      const context = JSON.parse(await readFile(args[fileIndex + 1]!, "utf8"));
      if (context.registry !== undefined) payload = { formalizations: context.claims.map((claim: { index: number; predicates: Record<string, string> }) => ({ index: claim.index, registryHash: provider.invalidPredicates ? "wrong-registry" : context.registry.hash,
        predicates: Object.fromEntries(Object.keys(claim.predicates).map((slot) => [slot, slot === "trigger" ? "Called" : "Responded"])) })) };
      else payload = { concepts: [], proposedAssumptions: [] };
    }
    const stdout = JSON.stringify({ type: "text", part: { text: JSON.stringify(payload) } }) + "\n";
    return { exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, stdoutBase64: Buffer.from(stdout).toString("base64"), stderrBase64: "" };
  }) };
});

describe("source predicates to typed SMT and completed evidence", () => {
  beforeEach(() => { vi.clearAllMocks(); provider.invalidPredicates = false; provider.invalidReport = false; });

  it("runs the source pipeline with real Z3 and checksummed raw/query artifacts", async () => {
    traceSpec("RAE-SEMANTIC-EVIDENCE", "RAE-QUERY-EXACT", "RAE-EVIDENCE-MANAGED", "RAE-EVIDENCE-FINAL", "FLA-PERSIST-ALL", "FLA-FORMALIZE-CLAIMS", "RAE-FORMAL-STRENGTH", "RAE-SCOPE-LEDGER", "RAE-STRENGTH-INTENT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-semantic-pipeline-"));
    const input = join(root, "openspec/specs/surface/spec.md");
    await mkdir(join(root, "openspec/specs/surface"), { recursive: true });
    await writeFile(input, "### Requirement: Response [SOURCE-REQ]\nWHEN called, THE engine SHALL respond.\n\n**References:**\n- proposal.md#Scope\n");
    const output = toOutputDirPath(join(root, "out"));
    const state = await runCli({ inputs: [input], output, src: undefined, caps: undefined, z3: undefined, model: toModelName("test-model"), pairBudget: 20, timeoutMs: 300_000, maxBatchSize: 32, allowArchive: false,
      analysis: { ...DEFAULT_ANALYSIS, models: { surface: { concepts: [
        { name: "Called", definition: "Called", role: "event", sort: "Bool" }, { name: "Responded", definition: "Responded", role: "output", sort: "Bool" },
      ] } } },
    });
    expect(state.findings.some((finding) => finding.category === "logic.solver_error")).toBe(false);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { files: { path: string; checksum: string }[] };
    expect(manifest.files.some((file) => file.path.startsWith("semantic_evidence/") && file.path.endsWith(".input.smt2"))).toBe(true);
    expect(manifest.files.some((file) => file.path.endsWith(".stdout.bin"))).toBe(true);
    expect(manifest.files.some((file) => file.path.endsWith(".registry.json"))).toBe(true);
    expect(manifest.files.some((file) => file.path === "report.md")).toBe(false);
    const attemptSet = JSON.parse(await readFile(join(output, "formalization_evidence/specs_forward.json"), "utf8"));
    expect(attemptSet.attempts[0].registryHash).toBeTruthy();
    expect(attemptSet.attempts[0].contextArtifact).toContain("semantic_evidence/");
    const ledgerFile = manifest.files.find((file) => file.path.endsWith(".ledger.json"))!;
    const ledger = JSON.parse(await readFile(join(output, ledgerFile.path), "utf8"));
    expect(ledger.scopeCounts.extracted).toBe(1);
    expect(ledger.scopeCounts.eligible + ledger.scopeCounts.excluded).toBe(ledger.scopeCounts.extracted);
    const summary = await readFile(join(output, "report_summary.md"), "utf8");
    expect(summary).toContain("recorded interpretations");
    expect(summary).toContain("Single samples do not establish");
  });

  it("keeps independent generated parsing and separate permission comparison in the CLI", async () => {
    traceSpec("STC-FORMAL-MODAL", "STC-ALIGN-BLIND", "STC-PERMISSION-RELATION", "RAE-STRENGTH-PARTIAL");
    const root = await mkdtemp(join(tmpdir(), "spec-check-semantic-source-"));
    const input = join(root, "openspec/specs/surface/spec.md");
    const src = join(root, "src");
    await mkdir(join(root, "openspec/specs/surface"), { recursive: true }); await mkdir(src);
    await writeFile(input, "### Requirement: Permission [SOURCE-PERMISSION]\nWHEN called, THE engine MAY respond.\n\n**References:**\n- proposal.md#Scope\n");
    await writeFile(join(src, "engine.ts"), "export function respond() { return 'response'; }\n");
    const concepts = [{ name: "Called", definition: "Called", role: "event", sort: "Bool" }, { name: "Responded", definition: "Responded", role: "output", sort: "Bool" }];
    const output = toOutputDirPath(join(root, "out"));
    const state = await runCli({ inputs: [input], output, src, caps: undefined, z3: undefined, model: toModelName("test-model"), pairBudget: 20, timeoutMs: 300_000, maxBatchSize: 32, allowArchive: false,
      analysis: { ...DEFAULT_ANALYSIS, models: { surface: { concepts } }, generatedModels: { surface: { concepts } } },
    });
    expect(state.findings.some((finding) => finding.description.includes("permission-equivalent"))).toBe(true);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { files: { path: string }[] };
    expect(manifest.files.some((file) => file.path.endsWith(".alignment.json"))).toBe(true);
    const requestFile = manifest.files.find((file) => file.path.endsWith(".request.json"))!;
    const request = JSON.parse(await readFile(join(output, requestFile.path), "utf8"));
    expect(request.sources[0].originalPath).toBe(join(src, "engine.ts"));
    expect(await readFile(join(output, request.sources[0].artifact))).toEqual(await readFile(join(src, "engine.ts")));
    expect(manifest.files.some((file) => file.path.endsWith(".captured.json"))).toBe(true);
    const generated = await readFile(join(output, "gen_specs/surface.md"), "utf8");
    expect(generated).toContain("[GEN-RESPONSE]");
    expect(generated).not.toContain("SOURCE-PERMISSION");
    expect(await readFile(join(output, "report_summary.md"), "utf8")).toContain("Formal Analysis Scope");
  });

  it("required generation input persistence failure is OutputError with no manifest or generation attempt", async () => {
    traceSpec("RAE-EVIDENCE-WRITE", "STC-ALIGN-BLIND");
    const root = await mkdtemp("/tmp/opencode/generation-write-failure-");
    const input = join(root, "openspec/specs/surface/spec.md"); const src = join(root, "src"); const output = toOutputDirPath(join(root, "out"));
    await mkdir(join(root, "openspec/specs/surface"), { recursive: true }); await mkdir(src);
    await writeFile(input, "### Requirement: Prose [SOURCE-PROSE]\nUnsupported prose.\n");
    await writeFile(join(src, "engine.ts"), "export const value = 1;\n");
    const actual = OutputFs.writeOutputAtomic;
    const spy = vi.spyOn(OutputFs, "writeOutputAtomic").mockImplementation(async (directory, path, content) => {
      if (path.endsWith(".request.json")) throw new Error("injected generation input write failure");
      await actual(directory, path, content);
    });
    try {
      await expect(runCli({ inputs: [input], output, src, caps: undefined, z3: undefined, model: toModelName("fixture"), pairBudget: 20, timeoutMs: 30_000, maxBatchSize: 32, allowArchive: false })).rejects.toMatchObject({ category: "OutputError" });
      await expect(access(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(join(output, "semantic_evidence"))).some((path) => path.endsWith(".stdout.bin"))).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("all rejected predicate attempts retain raw evidence and fail formalization with exit category 9", async () => {
    traceSpec("FLA-FORMAL-FAIL", "FLA-PARTITION-ABORT", "RAE-ATTEMPT-ALL-PATHS");
    const root = await mkdtemp(join(tmpdir(), "spec-check-semantic-failure-"));
    const input = join(root, "openspec/specs/surface/spec.md"); const output = toOutputDirPath(join(root, "out"));
    await mkdir(join(root, "openspec/specs/surface"), { recursive: true });
    await writeFile(input, "### Requirement: Test [SOURCE-REQ]\nTHE engine SHALL respond.\n");
    provider.invalidPredicates = true;
    await expect(runCli({ inputs: [input], output, src: undefined, caps: undefined, z3: undefined, model: toModelName("test-model"), pairBudget: 20, timeoutMs: 300_000, maxBatchSize: 32, allowArchive: false })).rejects.toMatchObject({ category: "FormalizationError" });
    expect((await readdir(join(output, "semantic_evidence"))).filter((path) => path.endsWith(".stdout.bin")).length).toBeGreaterThan(1);
    await expect(access(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("required registry persistence failure remains OutputError rather than a model retry", async () => {
    traceSpec("RAE-EVIDENCE-WRITE", "RAE-QUERY-AUX-FAIL");
    const root = await mkdtemp(join(tmpdir(), "spec-check-semantic-write-"));
    const input = join(root, "openspec/specs/surface/spec.md"); const output = toOutputDirPath(join(root, "out"));
    await mkdir(join(root, "openspec/specs/surface"), { recursive: true });
    await writeFile(input, "### Requirement: Test [SOURCE-REQ]\nTHE engine SHALL respond.\n");
    const actual = OutputFs.writeOutputAtomic;
    const spy = vi.spyOn(OutputFs, "writeOutputAtomic").mockImplementation(async (directory, path, content) => {
      if (path.endsWith(".registry.json")) throw new Error("injected required write failure");
      await actual(directory, path, content);
    });
    try {
      await expect(runCli({ inputs: [input], output, src: undefined, caps: undefined, z3: undefined, model: toModelName("test-model"), pairBudget: 20, timeoutMs: 300_000, maxBatchSize: 32, allowArchive: false })).rejects.toMatchObject({ category: "OutputError" });
      await expect(access(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { spy.mockRestore(); }
  });

  it("capacity-skipped formal work completes diagnostics and stale evidence is removed on rerun", async () => {
    traceSpec("RAE-EVIDENCE-BUDGET", "RAE-EVIDENCE-ADMISSION", "RAE-EVIDENCE-MANAGED", "RAE-SCOPE-LEDGER");
    const root = await mkdtemp(join(tmpdir(), "spec-check-semantic-capacity-"));
    const input = join(root, "openspec/specs/surface/spec.md"); const output = toOutputDirPath(join(root, "out"));
    await mkdir(join(root, "openspec/specs/surface"), { recursive: true });
    await writeFile(input, "### Requirement: Test [SOURCE-REQ]\nTHE engine SHALL respond.\n");
    const config = { inputs: [input], output, src: undefined, caps: undefined, z3: undefined, model: toModelName("test-model"), pairBudget: 20, timeoutMs: 300_000, maxBatchSize: 32, allowArchive: false,
      analysis: { ...DEFAULT_ANALYSIS, limits: { ...DEFAULT_ANALYSIS.limits, evidenceBytes: 1_048_576 } } };
    const first = await runCli(config);
    expect(first.findings.some((finding) => finding.description.includes("No valid typed source interpretation"))).toBe(true);
    await writeFile(join(output, "semantic_evidence/stale.json"), "stale");
    await runCli(config);
    await expect(access(join(output, "semantic_evidence/stale.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { files: { path: string; checksum: string }[] };
    for (const file of manifest.files) expect(createHash("sha256").update(await readFile(join(output, file.path))).digest("hex"), file.path).toBe(file.checksum);
  });

  it("optional final-report failure preserves scope qualifications and a refreshed core manifest", async () => {
    traceSpec("RAE-EVIDENCE-FINAL", "RAE-FORMAL-STRENGTH", "RAE-STRENGTH-PARTIAL");
    const root = await mkdtemp(join(tmpdir(), "spec-check-semantic-report-"));
    const input = join(root, "openspec/specs/surface/spec.md"); const output = toOutputDirPath(join(root, "out"));
    await mkdir(join(root, "openspec/specs/surface"), { recursive: true });
    await writeFile(input, "### Requirement: Unsupported [SOURCE-REQ]\nUnsupported prose.\n");
    provider.invalidReport = true;
    await runCli({ inputs: [input], output, src: undefined, caps: undefined, z3: undefined, model: toModelName("test-model"), pairBudget: 20, timeoutMs: 300_000, maxBatchSize: 32, allowArchive: false });
    expect(await readFile(join(output, "report_summary.md"), "utf8")).toContain("Formal Analysis Scope");
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { files: { path: string; checksum: string }[] };
    for (const file of manifest.files) expect(createHash("sha256").update(await readFile(join(output, file.path))).digest("hex"), file.path).toBe(file.checksum);
    await expect(access(join(output, "report.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["stray", "changed", "missing", "enumeration", "manifest-write", "refresh-stray"])("required completion failure (%s) is OutputError with no new manifest", async (fault) => {
    traceSpec("RAE-EVIDENCE-WRITE", "RAE-EVIDENCE-MANAGED");
    const root = await mkdtemp(join(tmpdir(), "spec-check-enhance-output-"));
    const input = join(root, "openspec/specs/surface/spec.md"); const output = toOutputDirPath(join(root, "out"));
    await mkdir(join(root, "openspec/specs/surface"), { recursive: true });
    await writeFile(input, "### Requirement: Unsupported [SOURCE-REQ]\nUnsupported prose.\n");
    const actual = OutputFs.writeOutputAtomic;
    let summaryWrites = 0; let manifests = 0;
    const spy = vi.spyOn(OutputFs, "writeOutputAtomic").mockImplementation(async (directory, path, content) => {
      if (fault === "manifest-write" && path === "manifest.json") throw new Error("injected publication failure");
      await actual(directory, path, content);
      if (path === "manifest.json") manifests += 1;
      if (path === "report_summary.md") {
        summaryWrites += 1;
        if (fault === "stray" || (fault === "refresh-stray" && summaryWrites >= 3)) await writeFile(join(output, "semantic_evidence/stray.json"), "{}");
        if (fault === "changed" || fault === "missing") {
          const target = (await readdir(join(output, "semantic_evidence"))).find((file) => file.endsWith(".effective-config.json"))!;
          if (fault === "changed") await writeFile(join(output, "semantic_evidence", target), "{}");
          else await OutputFs.removeOutputTree(output, toRelativePath(`semantic_evidence/${target}`));
        }
      }
    });
    const enumeration = fault === "enumeration" ? vi.spyOn(CoreArtifacts, "collectCoreArtifacts").mockRejectedValue(new Error("injected enumeration failure")) : undefined;
    try {
      await expect(runCli({ inputs: [input], output, src: undefined, caps: undefined, z3: undefined, model: toModelName("test-model"), pairBudget: 20, timeoutMs: 300_000, maxBatchSize: 32, allowArchive: false })).rejects.toMatchObject({ category: "OutputError" });
      await expect(access(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
      if (fault === "refresh-stray") expect(manifests).toBe(1);
    } finally { spy.mockRestore(); enumeration?.mockRestore(); }
  });
});
