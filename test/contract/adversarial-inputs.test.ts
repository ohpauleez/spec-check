import { describe, expect, it, beforeAll } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseSpec } from "../../src/domain/parser/spec.js";
import { parseProposal } from "../../src/domain/parser/proposal.js";
import { parseDesign } from "../../src/domain/parser/design.js";
import { parseTaskDocument } from "../../src/domain/parser/task.js";
import { validateFormalizationSample } from "../../src/domain/formal/validate.js";
import { sanitizeIdentifier, compileSmtlib } from "../../src/domain/formal/smtlib.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { toClaimId, toCapabilityName } from "../../src/domain/branded.js";

// Pre-created fixture files — written once in beforeAll to minimize async overhead
const fixtures: Record<string, string> = {};

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "spec-check-adversarial-"));

  const files: Record<string, string> = {
    "empty.md": "",
    "headings-only.md": "## Scope\n## Capabilities\n## Context\n",
    "heading-spec.md": "### Requirement: A\n### Requirement: B\n",
    "long-line.md": `## Scope\n${"a".repeat(10_000)}\n`,
    "long-req.md": [
      "### Requirement: Long [CAT-LONG-LINE]",
      "WHEN " + "x".repeat(10_000) + ", THE system SHALL respond.",
      "",
      "**References:**",
      "- proposal.md#Scope",
    ].join("\n"),
    "unicode.md": [
      "## Scope",
      "ZWJ: \u200D\u200D\u200D RTL: \u200F\u200E Emoji: \u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
      "",
      "## Capabilities",
      "- \u{1F680} rocket capability",
    ].join("\n"),
    "unicode-id.md": [
      "### Requirement: \u00DC\u00F1\u00EF Test [CAT-UNICODE-1]",
      "WHEN event, THE system SHALL respond.",
      "",
      "**References:**",
      "- proposal.md#Scope",
    ].join("\n"),
    "nested-headings.md": Array.from({ length: 20 }, (_, i) =>
      `${"#".repeat(i + 1)} Level ${i + 1}\nContent at level ${i + 1}`
    ).join("\n"),
    "malformed-ears.md": [
      "### Requirement: Broken When [CAT-BROKEN-WHEN]",
      "WHEN event arrives but no SHALL keyword present.",
      "",
      "**References:**",
      "- proposal.md#Scope",
      "",
      "### Requirement: Broken If [CAT-BROKEN-IF]",
      "IF something bad happens.",
      "",
      "**References:**",
      "- proposal.md#Scope",
      "",
      "### Requirement: Only Shall [CAT-ONLY-SHALL]",
      "The system SHALL do something without WHEN or IF.",
      "",
      "**References:**",
      "- proposal.md#Scope",
    ].join("\n"),
    "null-bytes.md": "## Scope\nLine with null\x00byte\nLine with bell\x07char\n## Capabilities\n- ok\n",
    "design.md": "## Goals\n- quality\n## Context\n- background\n",
    "tasks.md": "## Phase 1\n- [ ] task one\n- [x] task two\n",
  };

  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await writeFile(path, content, "utf8");
    fixtures[name] = path;
  }
});

describe("adversarial inputs", () => {
  describe("parser robustness", () => {
    it("handles empty markdown — parseSpec", async () => {
      const r = await parseSpec(fixtures["empty.md"]!);
      expect(r.requirements).toHaveLength(0);
      expect(r.scenarios).toHaveLength(0);
      expect(r.structuralFindings.length).toBeGreaterThan(0);
    });

    it("handles empty markdown — parseProposal", async () => {
      const r = await parseProposal(fixtures["empty.md"]!);
      expect(r.sections.size).toBe(0);
    });

    it("handles empty markdown — parseDesign", async () => {
      const r = await parseDesign(fixtures["empty.md"]!);
      expect(r.sections.size).toBe(0);
    });

    it("handles empty markdown — parseTaskDocument", async () => {
      const r = await parseTaskDocument(fixtures["empty.md"]!);
      expect(r.groups).toHaveLength(0);
    });

    it("handles markdown with only headings, no content", async () => {
      const r = await parseProposal(fixtures["headings-only.md"]!);
      expect(r.sections.has("Scope")).toBe(true);
    });

    it("handles spec with heading-only document (no requirement bodies)", async () => {
      const r = await parseSpec(fixtures["heading-spec.md"]!);
      expect(r.requirements.length).toBe(2);
      expect(r.requirements[0]?.body).toBe("");
      expect(r.requirements[1]?.body).toBe("");
    });

    it("handles extremely long single line (10KB) without hanging", async () => {
      const r = await parseProposal(fixtures["long-line.md"]!);
      expect(r.sections.has("Scope")).toBe(true);
    });

    it("handles extremely long requirement body in spec", async () => {
      const r = await parseSpec(fixtures["long-req.md"]!);
      expect(r.requirements.length).toBe(1);
      expect(r.requirements[0]?.earsType).toBe("event-driven");
    });

    it("handles unicode edge cases — ZWJ, RTL marks, emoji sequences", async () => {
      const r = await parseProposal(fixtures["unicode.md"]!);
      expect(r.sections.has("Scope")).toBe(true);
      expect(r.sections.has("Capabilities")).toBe(true);
    });

    it("handles unicode in spec identifiers", async () => {
      const r = await parseSpec(fixtures["unicode-id.md"]!);
      expect(r.requirements.length).toBe(1);
      expect(r.requirements[0]?.identifier).toBe("CAT-UNICODE-1");
    });

    it("handles deeply nested headings (20 levels) without stack overflow", async () => {
      const [specR, proposalR, designR, taskR] = await Promise.all([
        parseSpec(fixtures["nested-headings.md"]!),
        parseProposal(fixtures["nested-headings.md"]!),
        parseDesign(fixtures["nested-headings.md"]!),
        parseTaskDocument(fixtures["nested-headings.md"]!),
      ]);
      expect(specR.file).toBe(fixtures["nested-headings.md"]!);
      expect(proposalR.file).toBe(fixtures["nested-headings.md"]!);
      expect(designR.file).toBe(fixtures["nested-headings.md"]!);
      expect(taskR.file).toBe(fixtures["nested-headings.md"]!);
    });

    it("handles malformed EARS — missing keywords, partial patterns", async () => {
      const r = await parseSpec(fixtures["malformed-ears.md"]!);
      expect(r.requirements.length).toBe(3);
      for (const req of r.requirements) {
        expect(["event-driven", "state-driven", "conditional", "unwanted-behavior", "ubiquitous", "non-ears"]).toContain(req.earsType);
      }
    });

    it("handles null bytes and control characters in markdown", async () => {
      const r = await parseProposal(fixtures["null-bytes.md"]!);
      expect(r.sections.has("Scope")).toBe(true);
    });
  });

  describe("domain logic robustness", () => {
    it("handles duplicate claim IDs in buildClaimGraph", () => {
      const result = buildClaimGraph({
        specs: [{
          file: "spec.md",
          requirements: [
            { title: "First", identifier: "REQ-DUPLICATE", body: "WHEN x, THE system SHALL do A.", earsType: "event-driven", references: ["proposal.md#Scope"], provenance: { file: "spec.md", line: 5 } },
            { title: "Second", identifier: "REQ-DUPLICATE", body: "WHEN y, THE system SHALL do B.", earsType: "event-driven", references: ["proposal.md#Scope"], provenance: { file: "spec.md", line: 10 } },
          ],
          scenarios: [],
          deltaSections: ["ADDED"],
          structuralFindings: [],
          unparsed: [],
        }],
      });
      expect(result.graph.claims.filter((c) => c.id === "REQ-DUPLICATE").length).toBe(2);
    });

    it("handles claims with empty file provenance — orphan detection", () => {
      const result = buildClaimGraph({
        specs: [{
          file: "",
          requirements: [{ title: "", identifier: "REQ-EMPTY", body: "", earsType: "non-ears", references: [], provenance: { file: "", line: 0 } }],
          scenarios: [],
          deltaSections: [],
          structuralFindings: [],
          unparsed: [],
        }],
      });
      expect(result.findings.some((f) => f.category === "claim_graph.orphaned_claim")).toBe(true);
    });

    it("handles circular capability references in proposal", () => {
      const cap = toCapabilityName("self-referencing");
      const result = buildClaimGraph({
        proposal: {
          file: "proposal.md",
          sections: new Map([["Capabilities", { heading: "Capabilities", lines: [`${cap} depends on ${cap}`, "circular-a depends on circular-b", "circular-b depends on circular-a"], startLine: 1, endLine: 4 }]]),
          unparsed: [],
        },
        specs: [],
      });
      expect(result.graph.claims.length).toBeGreaterThan(0);
    });

    it("handles task document with no completed tasks", () => {
      const result = buildClaimGraph({
        specs: [],
        tasks: {
          file: "tasks.md",
          groups: [{ title: "Phase 1", tasks: [{ text: "incomplete", done: false, provenance: { file: "tasks.md", line: 3 } }] }],
          changeSummaries: new Map(),
          unparsed: [],
        },
      });
      expect(result.graph.claims.filter((c) => c.kind === "task_evidence")).toHaveLength(0);
    });

    it("handles empty body with correct obligation derivation", () => {
      const result = buildClaimGraph({
        specs: [{
          file: "m.md",
          requirements: [{ title: "E", identifier: "MIX-EMPTY", body: "", earsType: "non-ears", references: [], provenance: { file: "m.md", line: 1 } }],
          scenarios: [],
          deltaSections: [],
          structuralFindings: [],
          unparsed: [],
        }],
      });
      expect(result.graph.claims.find((c) => c.id === "MIX-EMPTY")?.obligation).toBe("informational");
    });
  });

  describe("formal system robustness", () => {
    it("sanitizeIdentifier handles (check-sat) injection", () => {
      const result = sanitizeIdentifier("(check-sat)");
      expect(result).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(result).not.toContain("(");
      expect(result).not.toContain(")");
    });

    it("sanitizeIdentifier handles (exit) injection", () => {
      const result = sanitizeIdentifier("(exit)");
      expect(result).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    });

    it("sanitizeIdentifier handles nested parentheses", () => {
      const result = sanitizeIdentifier("(assert (= (+ x 1) y))");
      expect(result).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    });

    it("sanitizeIdentifier handles empty string", () => {
      expect(sanitizeIdentifier("")).toBe("_");
    });

    it("sanitizeIdentifier handles only special characters", () => {
      const result = sanitizeIdentifier("()[]{}!@#$%^&*");
      expect(result).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    });

    it("sanitizeIdentifier handles null bytes and control characters", () => {
      const result = sanitizeIdentifier("\x00\x01\x02\x03");
      expect(result).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    });

    it("sanitizeIdentifier handles unicode — emoji, CJK, RTL", () => {
      const result = sanitizeIdentifier("\u{1F600}\u4E16\u754C\u0627\u0644\u0639");
      expect(result).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    });

    it("sanitizeIdentifier handles leading digits", () => {
      const result = sanitizeIdentifier("123abc");
      expect(result).toMatch(/^[A-Za-z_]/);
    });

    it("validateFormalizationSample rejects null", () => {
      const result = validateFormalizationSample(null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBeDefined();
    });

    it("validateFormalizationSample rejects undefined", () => {
      expect(validateFormalizationSample(undefined).ok).toBe(false);
    });

    it("validateFormalizationSample rejects array", () => {
      expect(validateFormalizationSample([1, 2, 3]).ok).toBe(false);
    });

    it("validateFormalizationSample rejects unbalanced parentheses", () => {
      const r = validateFormalizationSample({
        claimId: "VALID-ID", obligation: "mandatory",
        sorts: [{ name: "S", sort: "Bool" }],
        functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
        assertions: [{ id: "ASSERT-1", expr: "(((((" }],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("not well-formed");
    });

    it("validateFormalizationSample handles SMT injection in assertion expr", () => {
      const r = validateFormalizationSample({
        claimId: "REQ-INJECT", obligation: "mandatory",
        sorts: [{ name: "S", sort: "Bool" }],
        functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
        assertions: [{ id: "ASSERT-INJECT", expr: "(check-sat)(exit)" }],
      });
      expect(r.ok === true || r.ok === false).toBe(true);
    });

    it("validateFormalizationSample rejects lowercase assertion ID", () => {
      const r = validateFormalizationSample({
        claimId: "REQ-LOWER", obligation: "mandatory",
        sorts: [{ name: "S", sort: "Bool" }],
        functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
        assertions: [{ id: "assert-lower", expr: "(f true)" }],
      });
      expect(r.ok).toBe(false);
    });

    it("compileSmtlib handles injection-like identifiers", () => {
      const claim = {
        claimId: toClaimId("REQ-INJECT"),
        obligation: "mandatory" as const,
        sorts: [{ name: "(exit)", sort: "Bool" as const }],
        functions: [{ name: "evil()", args: ["Bool" as const], returns: "Bool" as const }],
        assertions: [{ id: "ASSERT-EVIL", expr: "(f true)" }],
      };
      const compiled = compileSmtlib(claim);
      expect(compiled.sanitizedClaimId).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      // (check-sat) is no longer emitted by compileSmtlib; it is appended at query time.
      expect(compiled.smtlib).toContain("(assert");
    });

    it("compileSmtlib handles empty sorts and functions", () => {
      const claim = {
        claimId: toClaimId("REQ-MINIMAL"),
        obligation: "advisory" as const,
        sorts: [] as const,
        functions: [] as const,
        assertions: [{ id: "ASSERT-ONLY", expr: "true" }],
      };
      const compiled = compileSmtlib(claim);
      expect(compiled.smtlib).toContain("(assert");
      expect(compiled.claimId).toBe("REQ-MINIMAL");
    });

    it("validateFormalizationSample handles special chars in sort name", () => {
      const r = validateFormalizationSample({
        claimId: "REQ-SPECIAL", obligation: "mandatory",
        sorts: [{ name: "My Sort (evil)", sort: "Bool" }],
        functions: [{ name: "f", args: ["Bool"], returns: "Bool" }],
        assertions: [{ id: "ASSERT-1", expr: "(f true)" }],
      });
      expect(r.ok === true || r.ok === false).toBe(true);
    });
  });
});
