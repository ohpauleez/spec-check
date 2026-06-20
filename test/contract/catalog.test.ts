import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { traceSpec } from "../support/spec-trace.js";
import { buildCatalog, classifyDocument, inferCapabilityName, resolveActiveCapabilities } from "../../src/domain/parser/catalog.js";
import { toCapabilityName } from "../../src/domain/branded.js";
import type { CatalogDocument } from "../../src/domain/model.js";

describe("catalog contracts", () => {
  it("classifies proposal, design, spec, task files", () => {
    traceSpec("CAT-DISCOVER-INPUTS");
    expect(classifyDocument("/root/proposal.md")?.type).toBe("proposal");
    expect(classifyDocument("/root/design.md")?.type).toBe("design");
    expect(classifyDocument("/root/specs/foo/spec.md")?.type).toBe("spec");
    expect(classifyDocument("/root/tasks.md")?.type).toBe("task");
    expect(classifyDocument("/root/random.txt")).toBeUndefined();
  });

  it("infers capability name from spec path", () => {
    traceSpec("CAT-DISCOVER-INPUTS");
    expect(inferCapabilityName("/openspec/specs/catalog-and-parse/spec.md")).toBe("catalog-and-parse");
    expect(inferCapabilityName("/no-specs-segment/spec.md")).toBeUndefined();
  });

  it("excludes archived change specs by default", async () => {
    traceSpec("CAT-DISCOVER-ARCHIVE", "CAT-EMPTY-ARCHIVE");
    const root = await mkdtemp(join(tmpdir(), "spec-check-catalog-archive-"));
    const archivedDir = join(root, "openspec", "changes", "archive", "old", "specs", "foo");
    await mkdir(archivedDir, { recursive: true });
    await writeFile(join(archivedDir, "spec.md"), "## ADDED Requirements\n", "utf8");

    const result = await buildCatalog([archivedDir]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.catalog.documents.length).toBe(0);
    expect(result.value.emptyReason?.kind).toBe("all_archived");
  });

  it("admits explicitly provided archived inputs with allowArchive", async () => {
    traceSpec("CAT-DISCOVER-ALLOW-ARCH");
    const root = await mkdtemp(join(tmpdir(), "spec-check-catalog-allow-archive-"));
    const archivedDir = join(root, "openspec", "changes", "archive", "old", "specs", "foo");
    await mkdir(archivedDir, { recursive: true });
    await writeFile(join(archivedDir, "spec.md"), "## ADDED Requirements\n", "utf8");

    const result = await buildCatalog([archivedDir], { allowArchive: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.catalog.documents.some((d) => d.type === "spec")).toBe(true);
    expect(result.value.emptyReason).toBeUndefined();
  });

  it("resolves active capabilities preferring finals over deltas", () => {
    traceSpec("CAT-DISCOVER-ACTIVE");
    const documents: CatalogDocument[] = [
      { path: "/specs/foo/spec.md", type: "spec" as const, source: "final" as const, capability: toCapabilityName("foo") },
      { path: "/changes/c1/specs/foo/spec.md", type: "spec" as const, source: "delta" as const, capability: toCapabilityName("foo") },
    ];
    const { activeDocuments } = resolveActiveCapabilities(documents);
    // Both final and first delta should be included
    expect(activeDocuments.filter((d) => d.type === "spec")).toHaveLength(2);
  });

  it("emits conflict findings for multiple deltas of same capability", () => {
    traceSpec("CAT-DISCOVER-ACTIVE");
    const documents: CatalogDocument[] = [
      { path: "/changes/a/specs/foo/spec.md", type: "spec" as const, source: "delta" as const, capability: toCapabilityName("foo") },
      { path: "/changes/b/specs/foo/spec.md", type: "spec" as const, source: "delta" as const, capability: toCapabilityName("foo") },
    ];
    const { findings } = resolveActiveCapabilities(documents);
    expect(findings.some((f) => f.category === "catalog.delta_conflict")).toBe(true);
  });

  it("rejects unreadable input path", async () => {
    traceSpec("CAT-DISCOVER-FAIL");
    const result = await buildCatalog(["/definitely/not/a/real/path"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unreadable_input");
    }
  });

  it("discovers and classifies files from real directory", async () => {
    traceSpec("CAT-DISCOVER-INPUTS");
    const root = await mkdtemp(join(tmpdir(), "spec-check-catalog-"));
    await writeFile(join(root, "proposal.md"), "## Scope\n", "utf8");
    await writeFile(join(root, "design.md"), "## Goals\n", "utf8");
    await mkdir(join(root, "specs", "test-cap"), { recursive: true });
    await writeFile(join(root, "specs", "test-cap", "spec.md"), "## ADDED\n", "utf8");

    const result = await buildCatalog([root]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.catalog.documents.length).toBeGreaterThanOrEqual(3);
      expect(result.value.emptyReason).toBeUndefined();
    }
  });

  it("returns no_recognized_docs for directories without OpenSpec docs", async () => {
    traceSpec("CAT-EMPTY-NODOCS", "CAT-CATALOG-EMPTY");
    const root = await mkdtemp(join(tmpdir(), "spec-check-catalog-empty-"));
    await writeFile(join(root, "notes.txt"), "hello", "utf8");

    const result = await buildCatalog([root]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.catalog.documents.length).toBe(0);
    expect(result.value.emptyReason?.kind).toBe("no_recognized_docs");
  });

  it("returns all_filtered when all recognized docs are excluded by capability resolution", async () => {
    traceSpec("CAT-EMPTY-FILTERED", "CAT-CATALOG-EMPTY");
    // Create a spec.md file outside a "specs/" segment so inferCapabilityName returns undefined.
    // Specs without a capability are skipped during active capability resolution, triggering
    // the all_filtered classification when no other document types are present.
    const root = await mkdtemp(join(tmpdir(), "spec-check-catalog-filtered-"));
    const noCapDir = join(root, "loose-docs");
    await mkdir(noCapDir, { recursive: true });
    await writeFile(join(noCapDir, "spec.md"), "## ADDED Requirements\n", "utf8");

    const result = await buildCatalog([noCapDir]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.catalog.documents.length).toBe(0);
    expect(result.value.emptyReason?.kind).toBe("all_filtered");
    if (result.value.emptyReason?.kind === "all_filtered") {
      expect(result.value.emptyReason.filteredCount).toBeGreaterThan(0);
      expect(result.value.emptyReason.filterReason).toContain("capability resolution");
    }
  });
});
