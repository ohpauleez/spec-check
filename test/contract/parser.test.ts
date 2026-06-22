import { describe, expect, it } from "vitest";

import { parseHeading, parseCanonicalIdentifier } from "../../src/domain/parser/shared.js";
import { parseSpec } from "../../src/domain/parser/spec.js";
import { parseProposal } from "../../src/domain/parser/proposal.js";
import { parseDesign } from "../../src/domain/parser/design.js";
import { mergeSpecsByCapability } from "../../src/domain/parser/merge.js";
import { toCapabilityName } from "../../src/domain/branded.js";
import { traceSpec } from "../support/spec-trace.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parser structural checks", () => {
  it("validates heading extraction", () => {
    traceSpec("CAT-VALIDATE-STRUCT");
    const heading = parseHeading("### Requirement: Example [CAT-EXAMPLE]");
    expect(heading).toEqual({ level: 3, text: "Requirement: Example [CAT-EXAMPLE]" });
  });

  it("validates canonical identifier format", () => {
    traceSpec("CAT-STRUCT-IDFORMAT");
    expect(parseCanonicalIdentifier("[CAT-EXAMPLE-1]")).toBe("CAT-EXAMPLE-1");
    expect(parseCanonicalIdentifier("[bad]")).toBeUndefined();
  });

  it("recognizes EARS and preserves unparsed lines deterministically", async () => {
    traceSpec("CAT-PARSE-EARS", "CAT-EARS-MATCH", "CAT-PRESERVE-LOSS", "CAT-PRESERVE-LINES");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "spec.md");
    const content = [
      "## ADDED Requirements",
      "",
      "### Requirement: Parse events [CAT-PARSE-EVENTS]",
      "WHEN an event arrives, THE system SHALL parse it.",
      "",
      "**References:**",
      "- proposal.md#Scope",
      "",
      "#### Scenario: Event parsed [CAT-PARSE-EVENTS-SCENARIO]",
      "WHEN event input exists, THE parser SHALL emit a parsed record.",
      "",
      "## NOTES",
      "Unmatched line that should be preserved",
      "",
    ].join("\n");
    await writeFile(file, content, "utf8");

    const parsedA = await parseSpec(file);
    const parsedB = await parseSpec(file);

    expect(parsedA.requirements[0]?.earsType).toBe("event-driven");
    expect(parsedA.unparsed.some((line) => line.text.includes("NOTES"))).toBe(true);
    expect(parsedA).toEqual(parsedB);
  });

  it("extracts proposal sections with provenance", async () => {
    traceSpec("CAT-VALIDATE-STRUCT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "proposal.md");
    await writeFile(file, "## Scope\n- deterministic analysis\n\n## Capabilities\n- parsing\n", "utf8");
    const parsed = await parseProposal(file);
    expect(parsed.sections.has("Scope")).toBe(true);
    expect(parsed.file).toBe(file);
  });

  it("extracts design sections with provenance", async () => {
    traceSpec("CAT-VALIDATE-STRUCT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "design.md");
    await writeFile(file, "## Goals\n- quality\n", "utf8");
    const parsed = await parseDesign(file);
    expect(parsed.sections.has("Goals")).toBe(true);
  });

  it("extracts scenario with identifier and postcondition", async () => {
    traceSpec("CAT-VALIDATE-STRUCT", "CAT-STRUCT-IDFORMAT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "spec.md");
    const content = [
      "## ADDED Requirements",
      "",
      "### Requirement: Parent [CAT-PARENT]",
      "WHEN x, THE system SHALL y.",
      "",
      "**References:**",
      "- proposal.md#Scope",
      "",
      "#### Scenario: Child [CAT-CHILD]",
      "WHEN condition, THE system SHALL respond.",
      "",
      "**Postcondition:** System responded.",
    ].join("\n");
    await writeFile(file, content, "utf8");
    const parsed = await parseSpec(file);
    expect(parsed.scenarios.length).toBeGreaterThan(0);
    expect(parsed.scenarios[0]?.identifier).toBe("CAT-CHILD");
  });

  it("extracts requirement references", async () => {
    traceSpec("CAT-VALIDATE-STRUCT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "spec.md");
    const content = [
      "## ADDED Requirements",
      "",
      "### Requirement: Ref test [CAT-REFS]",
      "WHEN x, THE system SHALL y.",
      "",
      "**References:**",
      "- proposal.md#Scope",
      "- design.md#Goals",
    ].join("\n");
    await writeFile(file, content, "utf8");
    const parsed = await parseSpec(file);
    expect(parsed.requirements[0]?.references.length).toBe(2);
  });

  it("flags non-EARS requirement", async () => {
    traceSpec("CAT-EARS-WARN");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "spec.md");
    const content = [
      "## ADDED Requirements",
      "",
      "### Requirement: NoEARS [CAT-NOEARS]",
      "This requirement does not follow EARS pattern.",
      "",
      "**References:**",
      "- proposal.md#Scope",
    ].join("\n");
    await writeFile(file, content, "utf8");
    const parsed = await parseSpec(file);
    const nonEars = parsed.requirements.find((r) => r.identifier === "CAT-NOEARS");
    // Parser classifies non-EARS bodies as "non-ears" type or emits a structural finding
    const hasWarning = parsed.structuralFindings.some((f) =>
      f.message.toLowerCase().includes("ears")
    ) || nonEars?.earsType === "non-ears";
    expect(hasWarning).toBe(true);
  });

  it("classifies complex (WHILE+WHEN) pattern", async () => {
    traceSpec("CAT-PARSE-EARS", "CAT-EARS-MATCH");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "spec.md");
    const content = [
      "## ADDED Requirements",
      "",
      "### Requirement: Complex pattern [CAT-COMPLEX]",
      "WHILE the system is in maintenance mode, WHEN a user submits a request, THE system SHALL queue the request.",
      "",
      "**References:**",
      "- proposal.md#Scope",
    ].join("\n");
    await writeFile(file, content, "utf8");
    const parsed = await parseSpec(file);
    expect(parsed.requirements[0]?.earsType).toBe("complex");
  });

  it("classifies optional (WHERE) pattern", async () => {
    traceSpec("CAT-PARSE-EARS", "CAT-EARS-MATCH");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "spec.md");
    const content = [
      "## ADDED Requirements",
      "",
      "### Requirement: Optional pattern [CAT-OPTIONAL]",
      "WHERE admin features are enabled, THE system SHALL display the admin panel.",
      "",
      "**References:**",
      "- proposal.md#Scope",
    ].join("\n");
    await writeFile(file, content, "utf8");
    const parsed = await parseSpec(file);
    expect(parsed.requirements[0]?.earsType).toBe("optional");
  });

  it("still classifies WHILE-only as state-driven (not complex)", async () => {
    traceSpec("CAT-PARSE-EARS", "CAT-EARS-MATCH");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "spec.md");
    const content = [
      "## ADDED Requirements",
      "",
      "### Requirement: State pattern [CAT-STATE]",
      "WHILE the system is in maintenance mode, THE system SHALL reject all incoming requests.",
      "",
      "**References:**",
      "- proposal.md#Scope",
    ].join("\n");
    await writeFile(file, content, "utf8");
    const parsed = await parseSpec(file);
    expect(parsed.requirements[0]?.earsType).toBe("state-driven");
  });

  it("still classifies WHEN-only as event-driven (not complex)", async () => {
    traceSpec("CAT-PARSE-EARS", "CAT-EARS-MATCH");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "spec.md");
    const content = [
      "## ADDED Requirements",
      "",
      "### Requirement: Event pattern [CAT-EVENT]",
      "WHEN a user submits a request, THE system SHALL process it.",
      "",
      "**References:**",
      "- proposal.md#Scope",
    ].join("\n");
    await writeFile(file, content, "utf8");
    const parsed = await parseSpec(file);
    expect(parsed.requirements[0]?.earsType).toBe("event-driven");
  });

  it("assigns deltaOperation by exact delta heading and scenario inheritance", async () => {
    traceSpec("CAT-EARS-DELTA", "CAT-EARS-PARENT", "CAT-EARS-PRE-SECTION", "CAT-EARS-EXACT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "spec.md");
    const content = [
      "Unstructured intro line",
      "",
      "### Requirement: Intro req [PARSE-PRE-REQ]",
      "WHEN intro, THE system SHALL track.",
      "",
      "#### Scenario: Intro scenario [PARSE-PRE-SCN]",
      "WHEN intro, THE system SHALL emit.",
      "",
      "## ADDED Requirements",
      "### Requirement: Added req [PARSE-ADD-REQ]",
      "WHEN add, THE system SHALL add.",
      "",
      "#### Scenario: Added scenario [PARSE-ADD-SCN]",
      "WHEN add, THE system SHALL confirm.",
      "",
      "## MODIFIED Requirements",
      "### Requirement: Modified req [PARSE-MOD-REQ]",
      "WHEN mod, THE system SHALL modify.",
      "",
      "## REMOVED Requirements",
      "### Requirement: Removed req [PARSE-REM-REQ]",
      "WHEN rem, THE system SHALL remove.",
      "",
      "## RENAMED Requirements",
      "### Requirement: Renamed req [PARSE-REN-REQ]",
      "WHEN ren, THE system SHALL rename.",
    ].join("\n");
    await writeFile(file, content, "utf8");

    const parsed = await parseSpec(file, "delta");
    const byId = new Map(parsed.requirements.map((req) => [req.identifier, req]));
    const scenarioById = new Map(parsed.scenarios.map((scenario) => [scenario.identifier, scenario]));

    expect(byId.get("PARSE-PRE-REQ")?.deltaOperation).toBe("pre-section");
    expect(scenarioById.get("PARSE-PRE-SCN")?.deltaOperation).toBe("pre-section");
    expect(byId.get("PARSE-ADD-REQ")?.deltaOperation).toBe("ADDED");
    expect(scenarioById.get("PARSE-ADD-SCN")?.deltaOperation).toBe("ADDED");
    expect(byId.get("PARSE-MOD-REQ")?.deltaOperation).toBe("MODIFIED");
    expect(byId.get("PARSE-REM-REQ")?.deltaOperation).toBe("REMOVED");
    expect(byId.get("PARSE-REN-REQ")?.deltaOperation).toBe("RENAMED");
    expect(scenarioById.get("PARSE-ADD-SCN")?.parentRequirementIdentifier).toBe("PARSE-ADD-REQ");
  });

  it("keeps finalized items at base operation and exact headings only", async () => {
    traceSpec("CAT-EARS-FINAL-DELTA", "CAT-EARS-EXACT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const finalFile = join(root, "final-spec.md");
    const deltaFile = join(root, "delta-spec.md");

    await writeFile(
      finalFile,
      [
        "## ADDED Requirements",
        "### Requirement: Final req [PARSE-FINAL-REQ]",
        "WHEN final, THE system SHALL hold.",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      deltaFile,
      [
        "## Added Requirements",
        "### Requirement: Approx req [PARSE-APPROX-REQ]",
        "WHEN approx, THE system SHALL not switch section.",
      ].join("\n"),
      "utf8",
    );

    const parsedFinal = await parseSpec(finalFile, "final");
    const parsedApproxDelta = await parseSpec(deltaFile, "delta");

    expect(parsedFinal.requirements[0]?.deltaOperation).toBe("base");
    expect(parsedApproxDelta.requirements[0]?.deltaOperation).toBe("pre-section");

    const merged = mergeSpecsByCapability(
      [
        { path: finalFile, type: "spec", source: "final", capability: toCapabilityName("parser") },
      ],
      [parsedFinal],
    );
    expect(merged[0]?.findings.some((f) => f.category === "spec_merge.finalized_spec_delta_heading_ignored")).toBe(true);
  });

  it("keeps parentRequirementIdentifier undefined when scenario has no preceding requirement", async () => {
    traceSpec("CAT-EARS-NO-PARENT");
    const root = await mkdtemp(join(tmpdir(), "spec-check-parser-"));
    const file = join(root, "spec.md");
    const content = [
      "## ADDED Requirements",
      "#### Scenario: Orphan scenario [PARSE-ORPHAN-SCN]",
      "WHEN orphaned, THE system SHALL preserve it.",
    ].join("\n");
    await writeFile(file, content, "utf8");

    const parsed = await parseSpec(file, "delta");
    expect(parsed.scenarios[0]?.parentRequirementIdentifier).toBeUndefined();
  });
});
