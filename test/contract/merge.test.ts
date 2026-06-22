import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { toCapabilityName } from "../../src/domain/branded.js";
import { mergeSpecsByCapability } from "../../src/domain/parser/merge.js";
import type { CatalogDocument, DeltaOperation, ParsedRequirement, ParsedScenario, ParsedSpec } from "../../src/domain/model.js";

function req(
  identifier: string | undefined,
  line: number,
  deltaOperation: DeltaOperation,
  file: string,
  body = "WHEN x, THE system SHALL y.",
): ParsedRequirement {
  return {
    title: identifier ?? `R-${line}`,
    ...(identifier === undefined ? {} : { identifier }),
    body,
    earsType: "event-driven",
    deltaOperation,
    references: [],
    provenance: { file, line },
  };
}

function scenario(
  identifier: string | undefined,
  line: number,
  deltaOperation: DeltaOperation,
  file: string,
  parentRequirementIdentifier?: string,
): ParsedScenario {
  return {
    title: identifier ?? `S-${line}`,
    ...(identifier === undefined ? {} : { identifier }),
    body: "WHEN s, THE system SHALL t.",
    deltaOperation,
    ...(parentRequirementIdentifier === undefined ? {} : { parentRequirementIdentifier }),
    provenance: { file, line },
  };
}

function spec(file: string, requirements: readonly ParsedRequirement[], scenarios: readonly ParsedScenario[], deltaSections: ParsedSpec["deltaSections"]): ParsedSpec {
  return {
    file,
    requirements,
    scenarios,
    deltaSections,
    structuralFindings: [],
    unparsed: [],
  };
}

function docs(finalFile: string | undefined, deltaFile: string | undefined, capability: string): readonly CatalogDocument[] {
  return [
    ...(finalFile === undefined ? [] : [{ path: finalFile, type: "spec" as const, source: "final" as const, capability: toCapabilityName(capability) }]),
    ...(deltaFile === undefined ? [] : [{ path: deltaFile, type: "spec" as const, source: "delta" as const, capability: toCapabilityName(capability) }]),
  ];
}

describe("merge contracts", () => {
  it("passes finalized-only capability unchanged", () => {
    traceSpec("MCA-MERGE-CAP", "MCA-MERGE-FINAL");
    const base = spec(
      "base.md",
      [req("R1", 10, "base", "base.md")],
      [scenario("S1", 11, "base", "base.md", "R1")],
      [],
    );
    const merged = mergeSpecsByCapability(docs("base.md", undefined, "cap-a"), [base]);
    expect(merged[0]?.requirements.map((r) => r.identifier)).toEqual(["R1"]);
    expect(merged[0]?.scenarios.map((s) => s.identifier)).toEqual(["S1"]);
    expect(merged[0]?.findings).toEqual([]);
  });

  it("applies REMOVED then MODIFIED then ADDED deterministically", () => {
    traceSpec("MCA-MERGE-CAP", "MCA-MERGE-ACTIVE", "MCA-DELTA-SEM", "MCA-DELTA-ADD", "MCA-DELTA-MOD", "MCA-DELTA-REM", "MCA-MERGE-ORDER");
    const base = spec(
      "base.md",
      [req("R1", 10, "base", "base.md"), req("R2", 20, "base", "base.md"), req("R3", 30, "base", "base.md")],
      [scenario("S1", 11, "base", "base.md", "R1"), scenario("S2", 21, "base", "base.md", "R2")],
      [],
    );
    const delta = spec(
      "delta.md",
      [
        req("R3", 10, "REMOVED", "delta.md"),
        req("R2", 20, "MODIFIED", "delta.md", "WHEN m, THE system SHALL updated."),
        req("R4", 30, "ADDED", "delta.md"),
      ],
      [scenario("S2B", 21, "MODIFIED", "delta.md", "R2"), scenario("S4", 31, "ADDED", "delta.md", "R4")],
      ["REMOVED", "MODIFIED", "ADDED"],
    );
    const merged = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta])[0]!;
    expect(merged.requirements.map((r) => r.identifier)).toEqual(["R1", "R2", "R4"]);
    expect(merged.scenarios.map((s) => s.identifier)).toEqual(["S1", "S2B", "S4"]);
  });

  it("surfaces unmatched and missing-id operations with one finding each", () => {
    traceSpec("MCA-MERGE-FIND", "MCA-MERGE-MISSING-ID", "MCA-MERGE-NO-TARGET");
    const delta = spec(
      "delta.md",
      [
        req(undefined, 10, "MODIFIED", "delta.md"),
        req("NOPE", 20, "MODIFIED", "delta.md"),
        req(undefined, 30, "REMOVED", "delta.md"),
        req("NOPE2", 40, "REMOVED", "delta.md"),
      ],
      [],
      ["MODIFIED", "REMOVED"],
    );
    const merged = mergeSpecsByCapability(docs(undefined, "delta.md", "cap-a"), [delta])[0]!;
    const categories = merged.findings.map((f) => f.category);
    expect(categories.filter((c) => c === "spec_merge.modified_missing_identifier")).toHaveLength(1);
    expect(categories.filter((c) => c === "spec_merge.modified_target_not_found")).toHaveLength(1);
    expect(categories.filter((c) => c === "spec_merge.removed_missing_identifier")).toHaveLength(1);
    expect(categories.filter((c) => c === "spec_merge.removed_target_not_found")).toHaveLength(1);
  });

  it("surfaces ADDED collisions in requirement and scenario namespaces", () => {
    traceSpec("MCA-MERGE-DUP-ADD", "MCA-DELTA-SURVIVING", "MCA-DELTA-NAMESPACE");
    const base = spec(
      "base.md",
      [req("R1", 10, "base", "base.md")],
      [scenario("S1", 11, "base", "base.md", "R1")],
      [],
    );
    const delta = spec(
      "delta.md",
      [req("R1", 10, "ADDED", "delta.md"), req("R2", 20, "ADDED", "delta.md")],
      [scenario("S1", 21, "ADDED", "delta.md", "R2")],
      ["ADDED"],
    );
    const merged = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta])[0]!;
    const collisionFindings = merged.findings.filter((f) => f.category === "spec_merge.duplicate_added_identifier");
    expect(collisionFindings).toHaveLength(2);
    expect(collisionFindings.some((f) => f.description.includes("requirement namespace"))).toBe(true);
    expect(collisionFindings.some((f) => f.description.includes("scenario namespace"))).toBe(true);
  });

  it("surfaces duplicate base and duplicate delta identifiers", () => {
    traceSpec("MCA-MERGE-DUP-BASE", "MCA-MERGE-DUP-DELTA");
    const base = spec(
      "base.md",
      [req("R1", 10, "base", "base.md"), req("R1", 20, "base", "base.md")],
      [],
      [],
    );
    const delta = spec(
      "delta.md",
      [req("R2", 10, "ADDED", "delta.md"), req("R2", 20, "ADDED", "delta.md")],
      [],
      ["ADDED"],
    );
    const merged = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta])[0]!;
    expect(merged.findings.some((f) => f.category === "spec_merge.duplicate_base_identifier")).toBe(true);
    expect(merged.findings.filter((f) => f.category === "spec_merge.duplicate_delta_identifier")).toHaveLength(2);
    expect(merged.requirements.map((r) => r.identifier)).toEqual(["R1"]);
  });

  it("surfaces pre-section content", () => {
    traceSpec("MCA-MERGE-PRE-SECTION");
    const delta = spec(
      "delta.md",
      [req("RPRE", 5, "pre-section", "delta.md")],
      [
        scenario("SPRE", 4, "pre-section", "delta.md"),
      ],
      ["ADDED"],
    );
    const merged = mergeSpecsByCapability(docs(undefined, "delta.md", "cap-a"), [delta])[0]!;
    expect(merged.findings.filter((f) => f.category === "spec_merge.pre_section_content")).toHaveLength(2);
  });

  it("surfaces standalone scenarios in delta sections", () => {
    traceSpec("MCA-MERGE-STANDALONE");
    const delta = spec(
      "delta.md",
      [],
      [scenario("SADD-STANDALONE", 20, "ADDED", "delta.md")],
      ["ADDED"],
    );
    const merged = mergeSpecsByCapability(docs(undefined, "delta.md", "cap-a"), [delta])[0]!;
    expect(merged.findings.filter((f) => f.category === "spec_merge.standalone_scenario_unsupported")).toHaveLength(1);
  });

  it("warns on finalized delta headings and renamed sections", () => {
    traceSpec("MCA-MERGE-FINAL-DELTA", "MCA-MERGE-RENAME");
    const base = spec("base.md", [req("R1", 10, "base", "base.md")], [], ["ADDED"]);
    const delta = spec("delta.md", [req("RREN", 10, "RENAMED", "delta.md")], [], ["RENAMED"]);
    const merged = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta])[0]!;
    expect(merged.findings.some((f) => f.category === "spec_merge.finalized_spec_delta_heading_ignored")).toBe(true);
    expect(merged.findings.some((f) => f.category === "spec_merge.rename_unsupported")).toBe(true);
  });

  it("skips modified replacement when it introduces external collisions", () => {
    traceSpec("MCA-DELTA-MOD-COLLISION");
    const base = spec(
      "base.md",
      [req("R1", 10, "base", "base.md"), req("R2", 20, "base", "base.md")],
      [scenario("S1", 11, "base", "base.md", "R1"), scenario("S2", 21, "base", "base.md", "R2")],
      [],
    );
    const delta = spec(
      "delta.md",
      [req("R2", 10, "MODIFIED", "delta.md")],
      [scenario("S1", 11, "MODIFIED", "delta.md", "R2")],
      ["MODIFIED"],
    );
    const merged = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta])[0]!;
    expect(merged.findings.some((f) => f.category === "spec_merge.duplicate_modified_identifier")).toBe(true);
    expect(merged.scenarios.map((s) => s.identifier)).toContain("S2");
  });

  it("emits empty capability finding when no surviving requirements remain", () => {
    traceSpec("MCA-MERGE-EMPTY");
    const base = spec("base.md", [req("R1", 10, "base", "base.md")], [], []);
    const delta = spec("delta.md", [req("R1", 10, "REMOVED", "delta.md")], [], ["REMOVED"]);
    const merged = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta])[0]!;
    expect(merged.requirements).toHaveLength(0);
    expect(merged.findings.some((f) => f.category === "spec_merge.empty_capability_skipped")).toBe(true);
  });

  it("keeps capability-local failures isolated", () => {
    const capA = spec("a-delta.md", [req(undefined, 10, "MODIFIED", "a-delta.md")], [], ["MODIFIED"]);
    const capB = spec("b-base.md", [req("RB", 10, "base", "b-base.md")], [], []);
    const merged = mergeSpecsByCapability(
      [
        { path: "a-delta.md", type: "spec", source: "delta", capability: toCapabilityName("cap-a") },
        { path: "b-base.md", type: "spec", source: "final", capability: toCapabilityName("cap-b") },
      ],
      [capA, capB],
    );

    const mergedA = merged.find((m) => m.capability === "cap-a")!;
    const mergedB = merged.find((m) => m.capability === "cap-b")!;
    expect(mergedA.findings.some((f) => f.category === "spec_merge.modified_missing_identifier")).toBe(true);
    expect(mergedB.requirements.map((r) => r.identifier)).toEqual(["RB"]);
  });

  it("supports delta-only capability with ADDED output and MODIFIED/REMOVED findings", () => {
    traceSpec("MCA-MERGE-DELTA-ONLY");
    const delta = spec(
      "delta.md",
      [req("RADD", 10, "ADDED", "delta.md"), req("RMOD", 20, "MODIFIED", "delta.md"), req("RREM", 30, "REMOVED", "delta.md")],
      [],
      ["ADDED", "MODIFIED", "REMOVED"],
    );
    const merged = mergeSpecsByCapability(docs(undefined, "delta.md", "cap-a"), [delta])[0]!;
    expect(merged.requirements.map((r) => r.identifier)).toEqual(["RADD"]);
    expect(merged.findings.some((f) => f.category === "spec_merge.modified_target_not_found")).toBe(true);
    expect(merged.findings.some((f) => f.category === "spec_merge.removed_target_not_found")).toBe(true);
  });

  it("warns for RENAMED sections in delta-only capability", () => {
    const delta = spec("delta.md", [req("RREN", 10, "RENAMED", "delta.md")], [], ["RENAMED"]);
    const merged = mergeSpecsByCapability(docs(undefined, "delta.md", "cap-a"), [delta])[0]!;
    expect(merged.findings.some((f) => f.category === "spec_merge.rename_unsupported")).toBe(true);
  });

  it("emits one finding per RENAMED requirement (D-13 compliance)", () => {
    const delta = spec(
      "delta.md",
      [req("REN1", 10, "RENAMED", "delta.md"), req("REN2", 20, "RENAMED", "delta.md"), req("REN3", 30, "RENAMED", "delta.md")],
      [],
      ["RENAMED"],
    );
    const merged = mergeSpecsByCapability(docs(undefined, "delta.md", "cap-a"), [delta])[0]!;
    const renameFindings = merged.findings.filter((f) => f.category === "spec_merge.rename_unsupported");
    // D-13: every skipped merge operation produces exactly one finding
    expect(renameFindings).toHaveLength(3);
    expect(renameFindings[0]!.description).toContain("REN1");
    expect(renameFindings[1]!.description).toContain("REN2");
    expect(renameFindings[2]!.description).toContain("REN3");
  });

  it("is deterministic across repeated runs", () => {
    traceSpec("MCA-MERGE-ORDER");
    const base = spec("base.md", [req("R1", 10, "base", "base.md")], [], []);
    const delta = spec("delta.md", [req("R2", 10, "ADDED", "delta.md")], [], ["ADDED"]);

    const runA = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta]);
    const runB = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta]);
    const runC = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta]);

    expect(runA).toEqual(runB);
    expect(runB).toEqual(runC);
  });

  it("preserves provenance and does not remove base blocks without explicit cause", () => {
    traceSpec("MCA-MERGE-PROVEN", "MCA-MERGE-SOURCE");
    const base = spec(
      "base.md",
      [req("R1", 10, "base", "base.md"), req("R2", 20, "base", "base.md")],
      [scenario("S1", 11, "base", "base.md", "R1")],
      [],
    );
    const delta = spec("delta.md", [req("R2", 10, "MODIFIED", "delta.md")], [], ["MODIFIED"]);
    const merged = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta])[0]!;

    expect(merged.requirements.map((r) => r.identifier)).toEqual(["R1", "R2"]);
    const provenanceFiles = [
      ...merged.requirements.map((r) => r.provenance.file),
      ...merged.scenarios.map((s) => s.provenance.file),
    ];
    expect(provenanceFiles.every((file) => file === "base.md" || file === "delta.md")).toBe(true);
  });

  it("emits exactly one finding per skipped operation and malformed standalone item", () => {
    const base = spec("base.md", [req("R1", 10, "base", "base.md")], [], []);
    const delta = spec(
      "delta.md",
      [
        req(undefined, 10, "MODIFIED", "delta.md"),
        req("R1", 20, "ADDED", "delta.md"),
      ],
      [scenario("S-ORPHAN", 5, "ADDED", "delta.md")],
      ["MODIFIED", "ADDED"],
    );
    const merged = mergeSpecsByCapability(docs("base.md", "delta.md", "cap-a"), [base, delta])[0]!;
    const relevant = merged.findings.filter((finding) =>
      ["spec_merge.modified_missing_identifier", "spec_merge.duplicate_added_identifier", "spec_merge.standalone_scenario_unsupported"].includes(finding.category),
    );
    expect(relevant).toHaveLength(3);
  });
});
