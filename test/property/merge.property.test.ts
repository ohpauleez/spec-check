import fc from "fast-check";
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
): ParsedRequirement {
  return {
    title: identifier ?? `REQ-${line}`,
    ...(identifier === undefined ? {} : { identifier }),
    body: "WHEN condition exists, THE system SHALL respond.",
    earsType: "event-driven",
    deltaOperation,
    references: [],
    provenance: { file, line },
  };
}

function scen(
  identifier: string | undefined,
  line: number,
  deltaOperation: DeltaOperation,
  file: string,
  parentRequirementIdentifier?: string,
): ParsedScenario {
  return {
    title: identifier ?? `SCN-${line}`,
    ...(identifier === undefined ? {} : { identifier }),
    body: "WHEN scenario occurs, THE system SHALL handle it.",
    deltaOperation,
    ...(parentRequirementIdentifier === undefined ? {} : { parentRequirementIdentifier }),
    provenance: { file, line },
  };
}

function mkSpec(
  file: string,
  requirements: readonly ParsedRequirement[],
  scenarios: readonly ParsedScenario[],
  deltaSections: ParsedSpec["deltaSections"],
): ParsedSpec {
  return {
    file,
    requirements,
    scenarios,
    deltaSections,
    structuralFindings: [],
    unparsed: [],
  };
}

describe("merge properties", () => {
  it("random valid inputs are deterministic across 3 runs", async () => {
    traceSpec("CAT-PARSE-DETERMINISM", "CAT-DETERM-SAME", "CGC-GRAPH-DETERMINISM");
    const baseIdsArb = fc.array(fc.constantFrom("R1", "R2", "R3", "R4"), { minLength: 0, maxLength: 5 });
    const deltaIdArb = fc.option(fc.constantFrom("R1", "R2", "R3", "R4", "R5", "RX"), { nil: undefined });

    await fc.assert(
      fc.asyncProperty(baseIdsArb, fc.array(deltaIdArb, { minLength: 0, maxLength: 4 }), fc.array(deltaIdArb, { minLength: 0, maxLength: 4 }), fc.array(fc.constantFrom("R1", "R2", "R3", "R4", "R5"), { minLength: 0, maxLength: 4 }), async (baseIds, modifiedIds, removedIds, addedIds) => {
        const baseReqs: ParsedRequirement[] = [];
        const baseScenarios: ParsedScenario[] = [];
        let line = 1;
        for (let i = 0; i < baseIds.length; i += 1) {
          const id = baseIds[i]!;
          baseReqs.push(req(id, line, "base", "base.md"));
          baseScenarios.push(scen(`S-${id}-${String(i)}`, line + 1, "base", "base.md", id));
          line += 3;
        }

        const deltaReqs: ParsedRequirement[] = [];
        const deltaScenarios: ParsedScenario[] = [];
        for (let i = 0; i < modifiedIds.length; i += 1) {
          const id = modifiedIds[i];
          deltaReqs.push(req(id, line, "MODIFIED", "delta.md"));
          if (id !== undefined) {
            deltaScenarios.push(scen(`SM-${id}-${String(i)}`, line + 1, "MODIFIED", "delta.md", id));
          }
          line += 3;
        }
        for (let i = 0; i < removedIds.length; i += 1) {
          deltaReqs.push(req(removedIds[i], line, "REMOVED", "delta.md"));
          line += 2;
        }
        for (let i = 0; i < addedIds.length; i += 1) {
          const id = addedIds[i]!;
          deltaReqs.push(req(id, line, "ADDED", "delta.md"));
          deltaScenarios.push(scen(`SA-${id}-${String(i)}`, line + 1, "ADDED", "delta.md", id));
          line += 3;
        }

        const deltaSections: ParsedSpec["deltaSections"] = [
          ...(addedIds.length > 0 ? ["ADDED" as const] : []),
          ...(modifiedIds.length > 0 ? ["MODIFIED" as const] : []),
          ...(removedIds.length > 0 ? ["REMOVED" as const] : []),
        ];

        const base = mkSpec("base.md", baseReqs, baseScenarios, []);
        const delta = mkSpec("delta.md", deltaReqs, deltaScenarios, deltaSections);
        const docs: readonly CatalogDocument[] = [
          { path: "base.md", type: "spec", source: "final", capability: toCapabilityName("cap-a") },
          { path: "delta.md", type: "spec", source: "delta", capability: toCapabilityName("cap-a") },
        ];

        const runA = mergeSpecsByCapability(docs, [base, delta]);
        const runB = mergeSpecsByCapability(docs, [base, delta]);
        const runC = mergeSpecsByCapability(docs, [base, delta]);

        expect(runA).toEqual(runB);
        expect(runB).toEqual(runC);
      }),
      { numRuns: 100 },
    );
  });

  it("preserves provenance, avoids silent discard, and emits complete skip findings", async () => {
    traceSpec("RAE-FINDINGS-IMMUTABLE", "CGC-COVERAGE-DETERMINISM");
    const baseIdsArb = fc.array(fc.constantFrom("R1", "R2", "R3", "R4"), { minLength: 0, maxLength: 5 });
    const missingOrMissArb = fc.option(fc.constantFrom("MISS1", "MISS2", "MISS3"), { nil: undefined });

    await fc.assert(
      fc.asyncProperty(baseIdsArb, fc.array(missingOrMissArb, { minLength: 0, maxLength: 4 }), fc.array(missingOrMissArb, { minLength: 0, maxLength: 4 }), fc.integer({ min: 0, max: 3 }), async (baseIds, modifiedIds, removedIds, standaloneCount) => {
        const baseReqs: ParsedRequirement[] = [];
        const baseScenarios: ParsedScenario[] = [];
        const sourceEvidence = new Set<string>();
        let line = 1;

        for (let i = 0; i < baseIds.length; i += 1) {
          const id = baseIds[i]!;
          const requirement = req(id, line, "base", "base.md");
          const scenario = scen(`S-${id}-${String(i)}`, line + 1, "base", "base.md", id);
          baseReqs.push(requirement);
          baseScenarios.push(scenario);
          sourceEvidence.add(`${id}|${requirement.provenance.file}|${String(requirement.provenance.line)}`);
          sourceEvidence.add(`${scenario.identifier ?? ""}|${scenario.provenance.file}|${String(scenario.provenance.line)}`);
          line += 3;
        }

        const deltaReqs: ParsedRequirement[] = [];
        const deltaScenarios: ParsedScenario[] = [];
        for (let i = 0; i < modifiedIds.length; i += 1) {
          const id = modifiedIds[i];
          const requirement = req(id, line, "MODIFIED", "delta.md");
          deltaReqs.push(requirement);
          sourceEvidence.add(`${id ?? ""}|${requirement.provenance.file}|${String(requirement.provenance.line)}`);
          line += 2;
        }
        for (let i = 0; i < removedIds.length; i += 1) {
          const id = removedIds[i];
          const requirement = req(id, line, "REMOVED", "delta.md");
          deltaReqs.push(requirement);
          sourceEvidence.add(`${id ?? ""}|${requirement.provenance.file}|${String(requirement.provenance.line)}`);
          line += 2;
        }
        for (let i = 0; i < standaloneCount; i += 1) {
          const scenario = scen(`ORPHAN-${String(i)}`, line, "ADDED", "delta.md");
          deltaScenarios.push(scenario);
          sourceEvidence.add(`${scenario.identifier ?? ""}|${scenario.provenance.file}|${String(scenario.provenance.line)}`);
          line += 2;
        }

        const base = mkSpec("base.md", baseReqs, baseScenarios, []);
        const deltaSections: ParsedSpec["deltaSections"] = [
          ...(modifiedIds.length > 0 ? ["MODIFIED" as const] : []),
          ...(removedIds.length > 0 ? ["REMOVED" as const] : []),
          ...(standaloneCount > 0 ? ["ADDED" as const] : []),
        ];
        const delta = mkSpec("delta.md", deltaReqs, deltaScenarios, deltaSections);

        const docs: readonly CatalogDocument[] = [
          { path: "base.md", type: "spec", source: "final", capability: toCapabilityName("cap-a") },
          { path: "delta.md", type: "spec", source: "delta", capability: toCapabilityName("cap-a") },
        ];
        const merged = mergeSpecsByCapability(docs, [base, delta])[0]!;

        for (const baseId of baseIds) {
          const survives = merged.requirements.some((requirement) => requirement.identifier === baseId);
          const explicitlyRemoved = removedIds.includes(baseId);
          const excludedAsDuplicate = merged.findings.some((finding) => finding.category === "spec_merge.duplicate_base_identifier" && finding.description.includes(baseId));
          expect(survives || explicitlyRemoved || excludedAsDuplicate).toBe(true);
        }

        for (const requirement of merged.requirements) {
          const key = `${requirement.identifier ?? ""}|${requirement.provenance.file}|${String(requirement.provenance.line)}`;
          expect(sourceEvidence.has(key)).toBe(true);
        }
        for (const scenario of merged.scenarios) {
          const key = `${scenario.identifier ?? ""}|${scenario.provenance.file}|${String(scenario.provenance.line)}`;
          expect(sourceEvidence.has(key)).toBe(true);
        }

        const expectedMissingModified = modifiedIds.filter((id) => id === undefined).length;
        const expectedNotFoundModified = modifiedIds
          .filter((id): id is string => id !== undefined)
          .filter((id, index, all) => all.indexOf(id) === all.lastIndexOf(id)).length;
        const expectedMissingRemoved = removedIds.filter((id) => id === undefined).length;
        const expectedNotFoundRemoved = removedIds
          .filter((id): id is string => id !== undefined)
          .filter((id, index, all) => all.indexOf(id) === all.lastIndexOf(id)).length;
        const expectedStandalone = deltaReqs.length === 0 ? standaloneCount : 0;

        const categoryCount = (category: string): number => merged.findings.filter((finding) => finding.category === category).length;
        expect(categoryCount("spec_merge.modified_missing_identifier")).toBe(expectedMissingModified);
        expect(categoryCount("spec_merge.modified_target_not_found")).toBe(expectedNotFoundModified);
        expect(categoryCount("spec_merge.removed_missing_identifier")).toBe(expectedMissingRemoved);
        expect(categoryCount("spec_merge.removed_target_not_found")).toBe(expectedNotFoundRemoved);
        expect(categoryCount("spec_merge.standalone_scenario_unsupported")).toBe(expectedStandalone);
      }),
      { numRuns: 100 },
    );
  });
});
