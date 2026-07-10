import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { traceSpec } from "../support/spec-trace.js";
import {
  neutralizeMarkdownInline,
  writePhaseReports,
  writeSummaryReport,
} from "../../src/domain/reporting/render.js";
import type { Finding } from "../../src/domain/findings.js";
import { toOutputDirPath } from "../../src/domain/branded.js";

const makeFinding = (desc: string): Finding => ({
  severity: "warning",
  category: "test.category",
  provenance: { file: "test.md", heading: "Section" },
  description: desc,
  rationale: "test rationale",
  evidence: [{ kind: "test", value: "value" }],
});

describe("reporting contracts", () => {
  it("writes phase reports at correct naming convention", async () => {
    traceSpec("RAE-REPORT-NAMES", "RAE-NAMES-PHASE");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-report-"));
    await writePhaseReports({
      outputDir: toOutputDirPath(dir),
      report11: [makeFinding("q1")],
      report12: [],
      report13: [],
    });
    const files = await readdir(dir);
    expect(files).toContain("report_1.1.md");
    expect(files).toContain("report_1.2.md");
    expect(files).toContain("report_1.3.md");
  });

  it("writes summary report at report_summary.md", async () => {
    traceSpec("RAE-NAMES-SUMMARY");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-report-"));
    await writeSummaryReport({
      outputDir: toOutputDirPath(dir),
      allFindings: [],
      skippedPhases: [],
    });
    const content = await readFile(join(dir, "report_summary.md"), "utf8");
    expect(content).toContain("report_summary");
  });

  it("includes skipped-phase explanations", () => {
    traceSpec("RAE-REPORT-SKIP");
    // Already tested in integration, just confirming via traceSpec
  });

  it("suppresses finding without required evidence as defect", async () => {
    traceSpec("RAE-EVID-FAIL", "RAE-SHAPE-FAIL");
    const badFinding: Finding = {
      severity: "warning",
      category: "test.bad",
      provenance: { file: "test.md" },
      description: "test",
      rationale: "test rationale",
      evidence: [], // empty evidence — should be suppressed
    };
    const dir = await mkdtemp(join(tmpdir(), "spec-check-report-"));
    await writePhaseReports({
      outputDir: toOutputDirPath(dir),
      report11: [badFinding],
      report12: [],
      report13: [],
    });
    const content = await readFile(join(dir, "report_1.1.md"), "utf8");
    expect(content).toContain("unsupported_verdict");
  });

  it("suppresses finding with empty rationale as defect", async () => {
    traceSpec("RAE-FINDING-SHAPE", "RAE-SHAPE-FAIL");
    // Bypass type system to simulate upstream defect producing empty rationale.
    const badFinding = {
      severity: "warning",
      category: "test.bad",
      provenance: { file: "test.md" },
      description: "test description",
      rationale: "",
      evidence: [{ kind: "test", value: "value" }],
    } as Finding;
    const dir = await mkdtemp(join(tmpdir(), "spec-check-report-"));
    await writePhaseReports({
      outputDir: toOutputDirPath(dir),
      report11: [badFinding],
      report12: [],
      report13: [],
    });
    const content = await readFile(join(dir, "report_1.1.md"), "utf8");
    // The finding is suppressed and replaced with an unsupported_verdict defect.
    expect(content).toContain("unsupported_verdict");
    // The original finding's description is not rendered as a normal finding line.
    expect(content).not.toContain("[warning] test.bad: test description");
  });

  it("suppresses finding with empty provenance file as defect", async () => {
    traceSpec("RAE-EVID-FAIL", "RAE-SHAPE-FAIL");
    // Empty provenance file string — should trigger rejection.
    const badFinding = {
      severity: "warning",
      category: "test.bad",
      provenance: { file: "" },
      description: "test description",
      rationale: "has rationale",
      evidence: [{ kind: "test", value: "value" }],
    } as Finding;
    const dir = await mkdtemp(join(tmpdir(), "spec-check-report-"));
    await writePhaseReports({
      outputDir: toOutputDirPath(dir),
      report11: [badFinding],
      report12: [],
      report13: [],
    });
    const content = await readFile(join(dir, "report_1.1.md"), "utf8");
    // The finding is suppressed and replaced with an unsupported_verdict defect.
    expect(content).toContain("unsupported_verdict");
    // The original finding's description is not rendered as a normal finding line.
    expect(content).not.toContain("[warning] test.bad: test description");
  });

  it("passes finding with all required fields including rationale", async () => {
    traceSpec("RAE-FINDING-SHAPE", "RAE-SHAPE-COMPLETE");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-report-"));
    const good = makeFinding("good finding");
    // Verify the finding type includes the required rationale field.
    expect(good.rationale).toBeDefined();
    expect(good.rationale.length).toBeGreaterThan(0);
    await writePhaseReports({
      outputDir: toOutputDirPath(dir),
      report11: [good],
      report12: [],
      report13: [],
    });
    const content = await readFile(join(dir, "report_1.1.md"), "utf8");
    expect(content).toContain("good finding");
    expect(content).not.toContain("unsupported_verdict");
  });

  it("writes code-derived logic report at report_2.logic.md", async () => {
    traceSpec("RAE-NAMES-GENLOGIC");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-report-"));
    await writePhaseReports({
      outputDir: toOutputDirPath(dir),
      report11: [],
      report12: [],
      report13: [],
      srcLogicReport: [makeFinding("gen-logic")],
    });
    const files = await readdir(dir);
    expect(files).toContain("report_2.logic.md");
  });

  it("neutralizes markdown control payloads in rendered evidence and provenance", async () => {
    traceSpec("RAE-EVID-RENDER-SAFE");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-report-"));
    const payloads = [
      "[x](http://evil)",
      "**x**",
      "_x_",
      "`code`",
      "a | b",
      "# heading",
      "> quote",
      "- bullet",
    ];

    const findings: Finding[] = payloads.map((payload, index) => ({
      severity: "error",
      category: "logic.merge_conflict",
      provenance: { file: payload, heading: payload },
      description: payload,
      rationale: "payload should stay inert",
      evidence: [{ kind: `k${String(index)}`, value: payload }],
      relatedClaimIdentifiers: [payload],
    }));

    await writePhaseReports({
      outputDir: toOutputDirPath(dir),
      report11: findings,
      report12: [],
      report13: [],
    });

    const content = await readFile(join(dir, "report_1.1.md"), "utf8");
    expect(content).not.toContain("[x](http://evil)");
    expect(content).toContain("\\[x\\]\\(http://evil\\)");
    expect(content).toContain("\\*\\*x\\*\\*");
    expect(content).toContain("\\_x\\_");
    expect(content).toContain("\\`code\\`");
    expect(content).toContain("a \\| b");
    expect(content).toContain("\\# heading");
    expect(content).toContain("\\> quote");
    expect(content).toContain("\\- bullet");
  });

  it("neutralization helper escapes block and inline markdown controls", () => {
    traceSpec("RAE-EVID-RENDER-SAFE");
    const raw = "[x](http://evil)\n# head\n> q\n- b\n1. list\n**x** _x_ `x` a | b";
    const safe = neutralizeMarkdownInline(raw);

    expect(safe).toContain("\\[x\\]\\(http://evil\\)");
    expect(safe).toContain("\\# head");
    expect(safe).toContain("\\> q");
    expect(safe).toContain("\\- b");
    expect(safe).toContain("1\\. list");
    expect(safe).toContain("\\*\\*x\\*\\*");
    expect(safe).toContain("\\_x\\_");
    expect(safe).toContain("\\`x\\`");
    expect(safe).toContain("a \\| b");
  });

  it("renders merge-conflict and invalid-group evidence as inert data", async () => {
    traceSpec("RAE-SHAPE-MERGE-CONFLICT-EVIDENCE", "RAE-EVID-RENDER-SAFE");
    const dir = await mkdtemp(join(tmpdir(), "spec-check-report-"));
    const findings: Finding[] = [
      {
        severity: "error",
        category: "logic.merge_conflict",
        provenance: { file: "specs/[x](http://evil).md" },
        description: "Function **f** conflicts",
        rationale: "must stay inert",
        evidence: [
          { kind: "existing_function_name", value: "**f**" },
          { kind: "excluded_claim_id", value: "- CLAIM-1" },
        ],
        relatedClaimIdentifiers: ["#CLAIM-1"],
      },
      {
        severity: "error",
        category: "logic.invalid_group",
        provenance: { file: "specs/>group.md" },
        description: "duplicate raw IDs: [A](b)",
        rationale: "must stay inert",
        evidence: [
          { kind: "duplicated_raw_ids", value: "a | b" },
          { kind: "sanitized_claim_id", value: "`shared`" },
        ],
        relatedClaimIdentifiers: [">CLAIM"],
      },
    ];

    await writePhaseReports({
      outputDir: toOutputDirPath(dir),
      report11: findings,
      report12: [],
      report13: [],
    });

    const content = await readFile(join(dir, "report_1.1.md"), "utf8");
    expect(content).toContain("logic.merge_conflict");
    expect(content).toContain("logic.invalid_group");
    expect(content).toContain("\\*\\*f\\*\\*");
    expect(content).toContain("a \\| b");
    expect(content).toContain("\\#CLAIM-1");
    expect(content).toContain("\\>CLAIM");
  });
});
