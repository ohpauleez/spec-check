import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { parseArgv } from "../../src/cli/parse-argv.js";
import { resolveRunConfig } from "../../src/cli/config.js";
import { formatCatalogEmptyMessage, formalizationErrorsToFindings } from "../../src/cli/run-cli.js";
import { toClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";

describe("CLI argument parsing", () => {
  it("parses valid flags and positional paths", () => {
    traceSpec("CAT-CLI-ARGS");
    const parsed = parseArgv([
      "openspec/changes/spec-check-core",
      "--output",
      "out",
      "--src",
      "src",
      "--model",
      "github-copilot/gpt-5.3-codex",
      "--caps",
      "caps.md",
      "--z3",
      "/usr/bin/z3",
      "--config",
      "config.json",
      "--timeout-ms",
      "120000",
      "--allow-archive",
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.value.inputs).toEqual(["openspec/changes/spec-check-core"]);
    expect(parsed.value.output).toBe("out");
    expect(parsed.value.src).toBe("src");
    expect(parsed.value.model).toBe("github-copilot/gpt-5.3-codex");
    expect(parsed.value.caps).toBe("caps.md");
    expect(parsed.value.z3).toBe("/usr/bin/z3");
    expect(parsed.value.config).toBe("config.json");
    expect(parsed.value.timeoutMs).toBe("120000");
    expect(parsed.value.allowArchive).toBe(true);
  });

  it("rejects unrecognized flags", () => {
    traceSpec("CAT-CLI-ARGS", "CAT-CLI-BADFLAG");
    const parsed = parseArgv(["--unknown"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.kind).toBe("unknown_flag");
  });

  it("rejects missing input paths", () => {
    traceSpec("CAT-CLI-NOINPUT");
    const parsed = parseArgv([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // No inputs provided — caller is responsible for checking
    expect(parsed.value.inputs.length).toBe(0);
  });

  it("resolveRunConfig rejects empty inputs with missing_inputs error", async () => {
    traceSpec("CAT-CLI-NOINPUT");
    const resolved = await resolveRunConfig({
      inputs: [],
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("missing_inputs");
  });

  it("parses help and version flags", () => {
    traceSpec("CAT-CLI-HELP", "CAT-CLI-VERSION");
    const help = parseArgv(["--help"]);
    const version = parseArgv(["--version"]);

    expect(help.ok).toBe(true);
    expect(version.ok).toBe(true);

    if (help.ok) {
      expect(help.value.help).toBe(true);
    }
    if (version.ok) {
      expect(version.value.version).toBe(true);
    }
  });

  it("accepts flag values starting with a hyphen", () => {
    traceSpec("CAT-CLI-ARGS");
    const parsed = parseArgv(["--output", "-my-dir"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.output).toBe("-my-dir");
  });

  it("supports equals syntax for flag values", () => {
    traceSpec("CAT-CLI-ARGS", "CAT-CLI-EQSYNTAX");
    const parsed = parseArgv(["--output=my-dir", "--z3=/usr/bin/z3-4.12", "--timeout-ms=45000"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.output).toBe("my-dir");
    expect(parsed.value.z3).toBe("/usr/bin/z3-4.12");
    expect(parsed.value.timeoutMs).toBe("45000");
  });

  it("parses --max-batch-size in both space and equals syntax", () => {
    traceSpec("CAT-CLI-ARGS", "CAT-CLI-EQSYNTAX");
    const spaced = parseArgv(["in", "--max-batch-size", "16"]);
    expect(spaced.ok).toBe(true);
    if (!spaced.ok) return;
    expect(spaced.value.maxBatchSize).toBe("16");

    const equals = parseArgv(["in", "--max-batch-size=24"]);
    expect(equals.ok).toBe(true);
    if (!equals.ok) return;
    expect(equals.value.maxBatchSize).toBe("24");
  });

  it("parses allow-archive as boolean flag", () => {
    traceSpec("CAT-CLI-ALLOW-ARCH");
    const parsed = parseArgv(["/tmp/input", "--allow-archive"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.allowArchive).toBe(true);
  });

  it("rejects output directory inside source directory", async () => {
    traceSpec("CAT-CLI-OUTSRC");
    const resolved = await resolveRunConfig({
      inputs: ["openspec/changes/spec-check-core"],
      output: "/tmp/project/src/output",
      src: "/tmp/project/src",
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("output_inside_src");
  });

  it("rejects output directory equal to source directory", async () => {
    traceSpec("CAT-CLI-OUTSRC");
    const resolved = await resolveRunConfig({
      inputs: ["openspec/changes/spec-check-core"],
      output: "/tmp/shared-dir",
      src: "/tmp/shared-dir",
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.kind).toBe("output_inside_src");
  });

  it("accepts output directory outside source directory", async () => {
    traceSpec("CAT-CLI-OUTSRC");
    const resolved = await resolveRunConfig({
      inputs: ["openspec/changes/spec-check-core"],
      output: "/tmp/output",
      src: "/tmp/project/src",
      help: false,
      version: false,
      allowArchive: false,
    });

    expect(resolved.ok).toBe(true);
  });
});

describe("formatCatalogEmptyMessage", () => {
  it("formats no_recognized_docs with input count", () => {
    traceSpec("CAT-CATALOG-EMPTY", "RAE-CATALOG-ERROR", "RAE-CATALOG-NODOCS");
    const msg = formatCatalogEmptyMessage({ kind: "no_recognized_docs", inputCount: 3 });
    expect(msg).toContain("No OpenSpec documents found");
    expect(msg).toContain("3");
  });

  it("formats all_archived with archived count and --allow-archive guidance", () => {
    traceSpec("CAT-CATALOG-EMPTY", "RAE-CATALOG-ERROR", "RAE-CATALOG-ARCHIVE");
    const msg = formatCatalogEmptyMessage({ kind: "all_archived", archivedCount: 5 });
    expect(msg).toContain("5");
    expect(msg).toContain("--allow-archive");
  });

  it("formats all_filtered with count and filter reason", () => {
    traceSpec("CAT-CATALOG-EMPTY", "RAE-CATALOG-ERROR", "RAE-CATALOG-FILTERED");
    const msg = formatCatalogEmptyMessage({
      kind: "all_filtered",
      filteredCount: 2,
      filterReason: "capability resolution excluded all specs",
    });
    expect(msg).toContain("2");
    expect(msg).toContain("capability resolution excluded all specs");
  });

  it("formats each empty-catalog variant with contextual details", () => {
    traceSpec("CAT-CATALOG-EMPTY", "RAE-SHAPE-CATALOG", "CAT-DISCOVER-EMPTY");
    const noRecognized = formatCatalogEmptyMessage({ kind: "no_recognized_docs", inputCount: 0 });
    expect(noRecognized).toContain("0");

    const allArchived = formatCatalogEmptyMessage({ kind: "all_archived", archivedCount: 3 });
    expect(allArchived).toContain("3");

    const allFiltered = formatCatalogEmptyMessage({ kind: "all_filtered", filterReason: "archive policy", filteredCount: 2 });
    expect(allFiltered).toContain("archive policy");
    expect(allFiltered).toContain("2");
  });
});

describe("formalizationErrorsToFindings", () => {
  it("resolves eligible claim provenance and preserves error order", () => {
    traceSpec("FLA-FORMALIZE-CLAIMS", "RAE-FINDING-SHAPE");
    const claims: Claim[] = [
      {
        kind: "proposal_property",
        text: "An ineligible upstream claim",
        obligation: "informational",
        provenance: { file: "proposal.md", line: 2 },
        references: [],
      },
      {
        id: toClaimId("CLI-PARTIAL-R1"),
        kind: "requirement",
        text: "The first eligible claim",
        obligation: "mandatory",
        provenance: { file: "spec.md", heading: "First", line: 4 },
        references: [],
      },
      {
        id: toClaimId("CLI-PARTIAL-S1"),
        kind: "scenario",
        text: "The second eligible claim",
        obligation: "mandatory",
        provenance: { file: "spec.md", heading: "Second", line: 8 },
        references: [],
      },
    ];

    const findings = formalizationErrorsToFindings([
      { message: "second failed", eligibleIndex: 1, claimId: "stale-informational-id" },
      { message: "first failed", eligibleIndex: 0, claimId: "CLI-PARTIAL-R1" },
    ], claims);

    expect(findings.map((finding) => finding.description)).toEqual(["second failed", "first failed"]);
    expect(findings.map((finding) => finding.provenance)).toEqual([
      { file: "spec.md", heading: "Second", line: 8 },
      { file: "spec.md", heading: "First", line: 4 },
    ]);
    expect(findings.map((finding) => finding.category)).toEqual([
      "formalization.claim_failed",
      "formalization.claim_failed",
    ]);
    expect(findings.map((finding) => finding.severity)).toEqual(["warning", "warning"]);
    expect(findings.map((finding) => finding.evidence)).toEqual([
      [
        { kind: "eligible_index", value: "1" },
        { kind: "claim_id", value: "CLI-PARTIAL-S1" },
      ],
      [
        { kind: "eligible_index", value: "0" },
        { kind: "claim_id", value: "CLI-PARTIAL-R1" },
      ],
    ]);
  });
});
