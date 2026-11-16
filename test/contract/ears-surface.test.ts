import { describe, expect, it } from "vitest";
import { parseSpecText } from "../../src/domain/parser/spec.js";
import { validateSourceSpan } from "../../src/domain/parser/source.js";
import { traceSpec } from "../support/spec-trace.js";

/** Source fixtures are independent of parser serialization or clause extraction. */
function spec(statement: string, extra = ""): string {
  return `### Requirement: Test [SURFACE-REQ]\n${statement}\n\n**References:**\n- proposal.md#Scope\n${extra}`;
}

describe("strict EARS surface admission", () => {
  it.each([
    ["THE engine MUST respond.", "ubiquitous"],
    ["WHILE ready, THE engine SHOULD respond.", "state-driven"],
    ["WHEN called, THE engine MAY respond.", "event-driven"],
    ["IF ready, THEN THE engine SHALL respond.", "unwanted-behavior"],
    ["WHILE ready, WHEN called, THE engine SHALL NOT respond.", "complex"],
  ])("parses %s", (text, form) => {
    traceSpec("CAT-EARS-MATCH", "CAT-EARS-MODALS", "CAT-PARSE-EARS");
    const result = parseSpecText("spec.md", spec(text)).requirements[0]!;
    expect(result.earsType).toBe(form);
    expect(result.surface?.disposition.kind).toBe("eligible");
    expect(result.surface?.clauses?.response.text).toBe("respond");
    expect(result.surface?.clauses?.negatedResponse).toBe(text.includes("NOT"));
  });

  it.each([
    "WHEN ready THE engine SHALL respond.",
    "IF ready, THE engine SHALL respond.",
    "WHEN called, WHILE ready, THE engine SHALL respond.",
    "WHEN , THE engine SHALL respond.",
    "THE engine MAY NOT respond.",
    "THE engine SHALL respond. THE engine SHALL stop.",
    "THE engine SHALL respond", "THE engine SHALL .",
    "THE engine SHALL display \"not closed.",
  ])("rejects malformed %s", (text) => {
    traceSpec("CAT-EARS-STRICT", "CAT-EARS-MAY-NOT", "CAT-EARS-WARN");
    const result = parseSpecText("spec.md", spec(text)).requirements[0]!.surface!;
    expect(result.disposition.kind).toBe("excluded");
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.span.file).toBe("spec.md");
  });

  it("preserves protected punctuation, substrings and decimal content", () => {
    traceSpec("CAT-EARS-TOKENS");
    const text = 'WHEN the user\'s OTHERWHEN option is selected, THE engine SHALL display "WHILE, SHALL NOT" and `WHEN.flag` at 0.5.';
    const result = parseSpecText("spec.md", spec(text)).requirements[0]!.surface!;
    expect(result.disposition.kind).toBe("eligible");
    expect(result.clauses?.trigger?.text).toBe("the user's OTHERWHEN option is selected");
    expect(result.clauses?.response.text).toBe('display "WHILE, SHALL NOT" and `WHEN.flag` at 0.5');
  });

  it("recognizes WHERE structure but gates its eligibility explicitly", () => {
    traceSpec("CAT-EARS-WHERE");
    const raw = spec("WHERE enabled, THE engine SHALL respond.");
    expect(parseSpecText("spec.md", raw).requirements[0]?.surface?.disposition.kind).toBe("excluded");
    expect(parseSpecText("spec.md", raw, "final", { earsExtensions: ["where"] }).requirements[0]?.surface?.disposition.kind).toBe("eligible");
  });

  it("separates fences and keeps embedded headings out of parser control", () => {
    traceSpec("CAT-SPANS-FENCES", "CAT-STATEMENT-SPANS", "CAT-EARS-EXACT");
    const raw = spec("THE engine SHALL respond.", "\n#### Requirement model\n```alloy\n## REMOVED Requirements\n### Requirement: Fake [FAKE-REQ]\nsig State {}\n```\n");
    const result = parseSpecText("spec.md", raw);
    expect(result.requirements).toHaveLength(1);
    expect(result.deltaSections).toEqual([]);
    expect(result.requirements[0]?.body).toBe("THE engine SHALL respond.");
    expect(result.requirements[0]?.surface?.supplementary.some((item) => item.text.includes("sig State"))).toBe(true);
  });

  it("maps multiline CRLF clauses to original offsets and positions", () => {
    traceSpec("CAT-SPANS-NORMALIZE");
    const raw = spec("WHEN a request\r\n  arrives, THE engine MUST respond.").replace(/(?<!\r)\n/gu, "\r\n");
    const surface = parseSpecText("spec.md", raw).requirements[0]!.surface!;
    const trigger = surface.clauses!.trigger!;
    expect(raw.slice(trigger.span.start.offset, trigger.span.end.offset)).toBe("a request\r\n  arrives");
    expect(trigger.span.start).toMatchObject({ line: 2, column: 6 });
    expect(trigger.span.end).toMatchObject({ line: 3, column: 10 });
    expect(surface.sourceMap).toHaveLength(surface.text.length + 1);
    expect(validateSourceSpan(trigger.span).ok).toBe(true);
    expect(validateSourceSpan({ ...trigger.span, end: { offset: 0, line: 0, column: 0 } }).ok).toBe(false);
  });

  it("normalizes statement-edge whitespace before recognition without moving original clause offsets", () => {
    const raw = "### Requirement: Test [SURFACE-REQ]\r\n  \tTHE engine SHALL respond. \t  \r\n";
    const surface = parseSpecText("spec.md", raw).requirements[0]!.surface!;
    expect(surface.text).toBe("THE engine SHALL respond.");
    expect(surface.text.trim()).toBe(surface.text);
    expect(surface.disposition.kind).toBe("eligible");
    const response = surface.clauses!.response;
    expect(raw.slice(response.span.start.offset, response.span.end.offset)).toBe("respond");
    expect(raw[surface.sourceMap[surface.text.length]!.offset - 1]).toBe(".");
  });

  it("preserves source identity and blocks oversized statement maps", () => {
    traceSpec("CAT-SPANS-BOUND");
    const raw = spec(`THE engine SHALL ${"x".repeat(65_536)}.`);
    const surface = parseSpecText("spec.md", raw).requirements[0]!.surface!;
    expect(surface.source).toEqual({ file: "spec.md", ordinal: 0 });
    expect(surface.disposition.kind).toBe("excluded");
    expect(surface.sourceMap).toEqual([]);
    expect(surface.issues[0]?.code).toBe("statement-limit");
  });

  it("requires supported meaning despite format justification", () => {
    traceSpec("CAT-FORMAT-JUSTIFIED", "CAT-FORMAL-DISPOSITION");
    const surface = parseSpecText("spec.md", spec("Decision table follows.", "**Format justification:** Mathematical table.\n")).requirements[0]!.surface!;
    expect(surface.fields.justification?.text).toBe("Mathematical table.");
    expect(surface.disposition.kind).toBe("excluded");
  });

  it("retains explicit deadlines as unsupported scope rather than timeless responses", () => {
    traceSpec("CAT-FORMAL-DISPOSITION", "FLA-TYPED-UNSUPPORTED");
    const surface = parseSpecText("spec.md", spec("WHEN called, THE engine SHALL respond within 200 ms.")).requirements[0]!.surface!;
    expect(surface.clauses?.form).toBe("event-driven");
    expect(surface.disposition.kind).toBe("excluded");
    expect(surface.issues.some((issue) => issue.code === "temporal-limitation")).toBe(true);
    const label = parseSpecText("spec.md", spec('THE engine SHALL display "within 200 ms".')).requirements[0]!.surface!;
    expect(label.disposition.kind).toBe("eligible");
  });

  it("distinguishes examples, prohibited examples and refinement postconditions", () => {
    traceSpec("CAT-SCENARIO-EXAMPLE", "CAT-SCENARIO-DEFAULT");
    const raw = spec("THE engine SHALL respond.", [
      "#### Scenario: Example [SURFACE-EXAMPLE]", "**Scenario kind:** example", "**Input:** x is 1.", "**Expected:** response is A.",
      "#### Scenario: Bad [SURFACE-BAD]", "**Scenario kind:** prohibited-example", "**Input:** x is 2.", "**Forbidden:** response is B.",
      "#### Scenario: Refine [SURFACE-REFINE]", "WHEN called, THE engine SHALL respond.", "**Postcondition:** Result exists.",
    ].join("\n"));
    const result = parseSpecText("spec.md", raw);
    expect(result.scenarios.map((item) => item.surface?.scenarioKind)).toEqual(["example", "prohibited-example", "refinement"]);
    expect(result.scenarios.every((item) => item.surface?.disposition.kind === "eligible")).toBe(true);
    expect(result.scenarios[0]?.surface?.fields.input?.span.start.column).toBe(12);
    expect(result.scenarios[2]?.surface?.fields.postcondition?.text).toBe("Result exists.");
  });

  it("retains duplicate and contradictory fields as excluded evidence", () => {
    traceSpec("CAT-SCENARIO-METADATA");
    const raw = spec("THE engine SHALL respond.", "#### Scenario: Invalid [SURFACE-BAD]\n**Scenario kind:** example\n**Input:** first\n**Input:** second\n**Forbidden:** not expected\n");
    const surface = parseSpecText("spec.md", raw).scenarios[0]!.surface!;
    expect(surface.disposition.kind).toBe("excluded");
    expect(surface.fields.input?.text).toBe("first");
    expect(surface.supplementary.some((line) => line.text.includes("second"))).toBe(true);
    expect(surface.issues.map((issue) => issue.code)).toContain("duplicate-field");
  });
});
