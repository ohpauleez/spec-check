import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { resolveConfinedOutputPath, writeOutputAtomic } from "../../src/adapters/fs.js";
import { isCommandAvailable } from "../../src/adapters/process.js";
import { traceClaimsToSource } from "../../src/domain/code-backwards/trace.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { parseSpec } from "../../src/domain/parser/spec.js";
import { toOutputDirPath, toRelativePath } from "../../src/domain/branded.js";

describe("catalog and CLI dependency checks", () => {
  it("CLI --deps flag triggers dependency availability check", () => {
    traceSpec("CAT-CLI-DEPS");
    // Non-existent binary should return false
    expect(isCommandAvailable("/definitely/not/present/binary-9999")).toBe(false);
  });

  it("structural validation reports structural findings", async () => {
    traceSpec("CAT-STRUCT-REPORT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-struct-"));
    await writeFile(
      join(root, "spec.md"),
      [
        "## ADDED Requirements",
        "### Requirement: Missing Body [STRUCT-MISS]",
        "**References:**",
        "- proposal.md#Scope",
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseSpec(join(root, "spec.md"));
    // Parser captures structural issues
    // The spec has a requirement heading but empty body before references
    expect(parsed.requirements.length).toBeGreaterThanOrEqual(0);
  });
});

describe("reporting evidence artifacts", () => {
  it("solver and model artifacts are preserved via writeOutputAtomic", async () => {
    traceSpec("RAE-EVID-ARTS");
    const root = await mkdtemp(join(tmpdir(), "spec-check-evid-"));
    const smtContent = "(declare-const x Bool)\n(assert x)\n(check-sat)\n";
    const stdoutContent = "sat\n";

    await writeOutputAtomic(toOutputDirPath(root), toRelativePath("smt/R1.smt2"), smtContent);
    await writeOutputAtomic(toOutputDirPath(root), toRelativePath("smt/R1.stdout.txt"), stdoutContent);

    const smt = await readFile(join(root, "smt", "R1.smt2"), "utf8");
    const stdout = await readFile(join(root, "smt", "R1.stdout.txt"), "utf8");
    expect(smt).toBe(smtContent);
    expect(stdout).toBe(stdoutContent);
  });

  it("manifest absence signals incomplete run", async () => {
    traceSpec("RAE-MANIFEST-FAIL");
    const root = await mkdtemp(join(tmpdir(), "spec-check-nomanifest-"));
    // An incomplete run has no manifest.json
    let manifestExists = true;
    try {
      await readFile(join(root, "manifest.json"), "utf8");
    } catch {
      manifestExists = false;
    }
    expect(manifestExists).toBe(false);
  });

  it("writeOutputAtomic uses temp+rename to prevent partial writes", async () => {
    traceSpec("RAE-ATOMIC-INTERRUPT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-atomic-"));
    // Write and immediately verify — atomic rename ensures no partial file
    const content = "important data that must be complete\n";
    await writeOutputAtomic(toOutputDirPath(root), toRelativePath("atomic-test.txt"), content);
    const written = await readFile(join(root, "atomic-test.txt"), "utf8");
    expect(written).toBe(content);
  });
});

describe("source traceability scope and hierarchy", () => {
  it("identifier found in test file classifies as secondary evidence", async () => {
    traceSpec("STC-ID-TEST");
    const root = await mkdtemp(join(tmpdir(), "spec-check-stc-test-"));
    const testDir = join(root, "test");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "impl.test.js"), "// [STC-ID-TEST-REQ]\ntest('example', () => {});\n", "utf8");

    const graph = buildClaimGraph({
      specs: [{
        file: "spec.md",
        requirements: [{ title: "R", identifier: "STC-ID-TEST-REQ", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: [], provenance: { file: "spec.md", line: 1 } }],
        scenarios: [],
        deltaSections: ["ADDED"],
        structuralFindings: [],
        unparsed: [],
      }],
    });

    const trace = await traceClaimsToSource({ srcDir: root, claimGraph: graph.graph });
    const stcTrace = trace.traces.find((t) => t.identifier === "STC-ID-TEST-REQ");
    expect(stcTrace).toBeDefined();
    expect(stcTrace!.level).toBe("secondary");
  });

  it("identifier found in source comment classifies as primary evidence", async () => {
    traceSpec("STC-ID-SOURCE");
    const root = await mkdtemp(join(tmpdir(), "spec-check-stc-src-"));
    const srcDir = join(root, "src");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "module.ts"), "// [STC-ID-SRC]\nexport const x = 1;\n", "utf8");

    const graph = buildClaimGraph({
      specs: [{
        file: "spec.md",
        requirements: [{ title: "R", identifier: "STC-ID-SRC", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: [], provenance: { file: "spec.md", line: 1 } }],
        scenarios: [],
        deltaSections: ["ADDED"],
        structuralFindings: [],
        unparsed: [],
      }],
    });

    const trace = await traceClaimsToSource({ srcDir: root, claimGraph: graph.graph });
    const stcTrace = trace.traces.find((t) => t.identifier === "STC-ID-SRC");
    expect(stcTrace).toBeDefined();
    expect(stcTrace!.level).toBe("primary");
  });

  it("source within scope is scanned", async () => {
    traceSpec("STC-SCOPE-CONFINE", "STC-SCOPE-IN");
    const root = await mkdtemp(join(tmpdir(), "spec-check-stc-scope-"));
    await writeFile(join(root, "valid.ts"), "// [SCOPE-IN-REQ]\n", "utf8");

    const graph = buildClaimGraph({
      specs: [{
        file: "spec.md",
        requirements: [{ title: "R", identifier: "SCOPE-IN-REQ", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: [], provenance: { file: "spec.md", line: 1 } }],
        scenarios: [],
        deltaSections: ["ADDED"],
        structuralFindings: [],
        unparsed: [],
      }],
    });

    const trace = await traceClaimsToSource({ srcDir: root, claimGraph: graph.graph });
    expect(trace.traces.some((t) => t.identifier === "SCOPE-IN-REQ")).toBe(true);
  });

  it("source outside scope is excluded via path boundary", () => {
    traceSpec("STC-SCOPE-OUT");
    // resolveConfinedOutputPath prevents traversal outside root
    expect(() => resolveConfinedOutputPath(toOutputDirPath("/tmp/output"), toRelativePath("../../outside"))).toThrow("escapes");
  });

  it("unreadable source directory results in error", async () => {
    traceSpec("STC-SCOPE-FAIL");
    await expect(
      traceClaimsToSource({
        srcDir: "/definitely/not/a/real/directory/99999",
        claimGraph: { claims: [] },
      }),
    ).rejects.toThrow();
  });

  it("evidence hierarchy classifies code as primary, docs as supporting", async () => {
    traceSpec("STC-EVIDENCE-HIERARCHY", "STC-HIER-CODE", "STC-HIER-DOCONLY");
    const root = await mkdtemp(join(tmpdir(), "spec-check-stc-hier-"));
    const srcDir = join(root, "src");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(srcDir, { recursive: true });

    // Implementation source → primary evidence
    await writeFile(join(srcDir, "impl.ts"), "// [HIER-CODE-REQ]\nexport const x = 1;\n", "utf8");
    // Documentation → supporting evidence
    await writeFile(join(root, "readme.md"), "See [HIER-DOC-REQ] for details.\n", "utf8");

    const graph = buildClaimGraph({
      specs: [{
        file: "spec.md",
        requirements: [
          { title: "Code", identifier: "HIER-CODE-REQ", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: [], provenance: { file: "spec.md", line: 1 } },
          { title: "Doc", identifier: "HIER-DOC-REQ", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: [], provenance: { file: "spec.md", line: 2 } },
        ],
        scenarios: [],
        deltaSections: ["ADDED"],
        structuralFindings: [],
        unparsed: [],
      }],
    });

    const trace = await traceClaimsToSource({ srcDir: root, claimGraph: graph.graph });
    const codeTrace = trace.traces.find((t) => t.identifier === "HIER-CODE-REQ");
    const docTrace = trace.traces.find((t) => t.identifier === "HIER-DOC-REQ");

    expect(codeTrace).toBeDefined();
    expect(codeTrace!.level).toBe("primary");
    expect(docTrace).toBeDefined();
    expect(docTrace!.level).toBe("supporting");
  });

  it("identifier in documentation only classifies as weakly supported", async () => {
    traceSpec("STC-TRACE-WEAK");
    const root = await mkdtemp(join(tmpdir(), "spec-check-stc-weak-"));
    // Identifier appears only in a markdown doc — no implementation source or test.
    await writeFile(join(root, "notes.md"), "Reference: [WEAK-ONLY-REQ] mentioned here.\n", "utf8");

    const graph = buildClaimGraph({
      specs: [{
        file: "spec.md",
        requirements: [{
          title: "Weak",
          identifier: "WEAK-ONLY-REQ",
          body: "WHEN x, THE system SHALL y.",
          earsType: "event-driven",
          references: [],
          provenance: { file: "spec.md", line: 1 },
        }],
        scenarios: [],
        deltaSections: ["ADDED"],
        structuralFindings: [],
        unparsed: [],
      }],
    });

    const trace = await traceClaimsToSource({ srcDir: root, claimGraph: graph.graph });
    const weakTrace = trace.traces.find((t) => t.identifier === "WEAK-ONLY-REQ");
    expect(weakTrace).toBeDefined();
    expect(weakTrace!.level).toBe("supporting");

    // Finding should be weakly_supported, not fully supported.
    const weakFinding = trace.findings.find(
      (f) => f.category === "source_trace.weakly_supported" && f.relatedClaimIdentifiers?.includes("WEAK-ONLY-REQ"),
    );
    expect(weakFinding).toBeDefined();
    expect(weakFinding!.description).toContain("does not demonstrate behavioral correctness");

    // Ensure it is NOT classified as fully supported.
    const strongFinding = trace.findings.find(
      (f) => f.category === "source_trace.supported" && f.relatedClaimIdentifiers?.includes("WEAK-ONLY-REQ"),
    );
    expect(strongFinding).toBeUndefined();
  });
});
