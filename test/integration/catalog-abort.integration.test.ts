/**
 * Integration test verifying that a CatalogError aborts the pipeline before
 * any downstream qualitative, formal, or comparison phases execute.
 *
 * Covers: RAE-REPORT-CATALOG, CAT-DISCOVER-EMPTY, CAT-EMPTY-ARCHIVE, CAT-EMPTY-FILTERED.
 */
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runCli } from "../../src/cli/run-cli.js";
import { PipelineAbortError } from "../../src/cli/pipeline-types.js";
import { toModelName, toOutputDirPath } from "../../src/domain/branded.js";
import type { RunConfig } from "../../src/cli/config.js";

// Mock external adapters to prevent real calls and to verify they are never reached.
vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

// Mock dependency check to bypass opencode/z3 availability requirement.
vi.mock("../../src/cli/pipeline-helpers.js", async (importOriginal) => {
  const original = await (importOriginal() as Promise<Record<string, unknown>>);
  return {
    ...original,
    checkDependencies: () => undefined,
  };
});

function makeConfig(inputs: string[], output: string, opts?: { allowArchive?: boolean }): RunConfig {
  return {
    inputs,
    output: toOutputDirPath(output),
    src: undefined,
    caps: undefined,
    z3: undefined,
    model: toModelName("test-model"),
    pairBudget: 100,
    timeoutMs: 300_000,
    allowArchive: opts?.allowArchive ?? false,
  };
}

describe("catalog abort integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts pipeline on no_recognized_docs — no downstream reports produced", async () => {
    traceSpec("RAE-REPORT-CATALOG", "CAT-DISCOVER-EMPTY");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-abort-nodocs-"));
    const inputDir = join(root, "input");
    const outputDir = join(root, "output");
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    // Only non-OpenSpec content in the input directory.
    await writeFile(join(inputDir, "notes.txt"), "random notes\n", "utf8");

    const config = makeConfig([inputDir], outputDir);

    await expect(runCli(config)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PipelineAbortError);
      const abort = error as PipelineAbortError;
      expect(abort.category).toBe("CatalogError");
      expect(abort.message).toContain("No OpenSpec documents found");
      return true;
    });

    // Downstream phases never ran — output directory has no reports.
    const outputFiles = await readdir(outputDir);
    expect(outputFiles).toHaveLength(0);

    // LLM adapter was never called.
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    expect(vi.mocked(callOpencode)).not.toHaveBeenCalled();
  });

  it("aborts pipeline on all_archived without --allow-archive — no downstream reports produced", async () => {
    traceSpec("RAE-REPORT-CATALOG", "CAT-EMPTY-ARCHIVE");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-abort-archive-"));
    const outputDir = join(root, "output");
    await mkdir(outputDir, { recursive: true });
    // Create archived spec structure: openspec/changes/archive/<name>/specs/<cap>/spec.md
    const archivedDir = join(root, "openspec", "changes", "archive", "old-change", "specs", "foo");
    await mkdir(archivedDir, { recursive: true });
    await writeFile(join(archivedDir, "spec.md"), "## ADDED Requirements\n\n### Requirement: Foo [FOO-REQ]\nWHEN x, THE system SHALL y.\n", "utf8");

    const config = makeConfig([archivedDir], outputDir, { allowArchive: false });

    await expect(runCli(config)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PipelineAbortError);
      const abort = error as PipelineAbortError;
      expect(abort.category).toBe("CatalogError");
      expect(abort.message).toContain("--allow-archive");
      return true;
    });

    // No downstream output generated.
    const outputFiles = await readdir(outputDir);
    expect(outputFiles).toHaveLength(0);

    // LLM adapter was never called.
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    expect(vi.mocked(callOpencode)).not.toHaveBeenCalled();
  });

  it("aborts pipeline on all_filtered — no downstream reports produced", async () => {
    traceSpec("RAE-REPORT-CATALOG", "CAT-EMPTY-FILTERED");
    const root = await mkdtemp(join(tmpdir(), "spec-check-int-abort-filtered-"));
    const outputDir = join(root, "output");
    await mkdir(outputDir, { recursive: true });
    // Create a spec.md outside a "specs/" segment so inferCapabilityName returns undefined.
    // Specs without a capability are filtered during active capability resolution.
    const looseDir = join(root, "loose-docs");
    await mkdir(looseDir, { recursive: true });
    await writeFile(join(looseDir, "spec.md"), "## ADDED Requirements\n\n### Requirement: Bar [BAR-REQ]\nWHEN a, THE system SHALL b.\n", "utf8");

    const config = makeConfig([looseDir], outputDir);

    await expect(runCli(config)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PipelineAbortError);
      const abort = error as PipelineAbortError;
      expect(abort.category).toBe("CatalogError");
      expect(abort.message).toContain("capability resolution");
      return true;
    });

    // No downstream output generated.
    const outputFiles = await readdir(outputDir);
    expect(outputFiles).toHaveLength(0);

    // LLM adapter was never called.
    const { callOpencode } = await import("../../src/adapters/opencode.js");
    expect(vi.mocked(callOpencode)).not.toHaveBeenCalled();
  });
});
