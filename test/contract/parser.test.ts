import { describe, expect, it } from "vitest";

import { parseHeading, parseCanonicalIdentifier } from "../../src/domain/parser/shared.js";
import { parseSpec } from "../../src/domain/parser/spec.js";
import { parseProposal } from "../../src/domain/parser/proposal.js";
import { parseDesign } from "../../src/domain/parser/design.js";
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
});
