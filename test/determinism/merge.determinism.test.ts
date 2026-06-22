import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { toCapabilityName } from "../../src/domain/branded.js";
import { mergeSpecsByCapability } from "../../src/domain/parser/merge.js";
import type { CatalogDocument, ParsedSpec } from "../../src/domain/model.js";

function spec(file: string, requirements: ParsedSpec["requirements"], scenarios: ParsedSpec["scenarios"], deltaSections: ParsedSpec["deltaSections"]): ParsedSpec {
  return {
    file,
    requirements,
    scenarios,
    deltaSections,
    structuralFindings: [],
    unparsed: [],
  };
}

describe("merge determinism", () => {
  it("is byte-for-byte deterministic across repeated invocations", () => {
    traceSpec("CAT-PARSE-DETERMINISM", "CAT-DETERM-SAME", "CGC-GRAPH-DETERMINISM");
    const base = spec(
      "base.md",
      [
        {
          title: "Base One",
          identifier: "R1",
          body: "WHEN base one appears, THE system SHALL process one.",
          earsType: "event-driven",
          deltaOperation: "base",
          references: [],
          provenance: { file: "base.md", line: 1 },
        },
        {
          title: "Base Two",
          identifier: "R2",
          body: "WHEN base two appears, THE system SHALL process two.",
          earsType: "event-driven",
          deltaOperation: "base",
          references: [],
          provenance: { file: "base.md", line: 5 },
        },
      ],
      [
        {
          title: "Scenario One",
          identifier: "S1",
          body: "WHEN base scenario occurs, THE system SHALL process scenario.",
          deltaOperation: "base",
          parentRequirementIdentifier: "R1",
          provenance: { file: "base.md", line: 2 },
        },
      ],
      [],
    );

    const delta = spec(
      "delta.md",
      [
        {
          title: "Remove Two",
          identifier: "R2",
          body: "WHEN remove appears, THE system SHALL remove two.",
          earsType: "event-driven",
          deltaOperation: "REMOVED",
          references: [],
          provenance: { file: "delta.md", line: 1 },
        },
        {
          title: "Modify One",
          identifier: "R1",
          body: "WHEN modified appears, THE system SHALL process modified one.",
          earsType: "event-driven",
          deltaOperation: "MODIFIED",
          references: [],
          provenance: { file: "delta.md", line: 5 },
        },
        {
          title: "Add Three",
          identifier: "R3",
          body: "WHEN add appears, THE system SHALL process three.",
          earsType: "event-driven",
          deltaOperation: "ADDED",
          references: [],
          provenance: { file: "delta.md", line: 9 },
        },
      ],
      [
        {
          title: "Scenario One Modified",
          identifier: "S1M",
          body: "WHEN modified scenario occurs, THE system SHALL process modified scenario.",
          deltaOperation: "MODIFIED",
          parentRequirementIdentifier: "R1",
          provenance: { file: "delta.md", line: 6 },
        },
        {
          title: "Scenario Three",
          identifier: "S3",
          body: "WHEN scenario three occurs, THE system SHALL process scenario three.",
          deltaOperation: "ADDED",
          parentRequirementIdentifier: "R3",
          provenance: { file: "delta.md", line: 10 },
        },
      ],
      ["REMOVED", "MODIFIED", "ADDED"],
    );

    const docs: readonly CatalogDocument[] = [
      { path: "base.md", type: "spec", source: "final", capability: toCapabilityName("cap-a") },
      { path: "delta.md", type: "spec", source: "delta", capability: toCapabilityName("cap-a") },
    ];

    const runA = mergeSpecsByCapability(docs, [base, delta]);
    const runB = mergeSpecsByCapability(docs, [base, delta]);
    const runC = mergeSpecsByCapability(docs, [base, delta]);

    const bytesA = JSON.stringify(runA);
    const bytesB = JSON.stringify(runB);
    const bytesC = JSON.stringify(runC);

    expect(bytesA).toBe(bytesB);
    expect(bytesB).toBe(bytesC);

    expect(runA.map((entry) => entry.capability)).toEqual(["cap-a"]);
    expect(runA[0]?.requirements.map((req) => req.identifier)).toEqual(["R1", "R3"]);
    expect(runA[0]?.scenarios.map((scn) => scn.identifier)).toEqual(["S1M", "S3"]);
  });
});
