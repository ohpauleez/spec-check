import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import {
  buildAttachedBatchPrompt,
  buildBatchContextFile,
  serializeBatchContextFile,
  sha256HexString,
} from "../../src/domain/formal/transport.js";
import { toClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";

function makeClaim(overrides?: { readonly [K in keyof Claim]?: Claim[K] | (K extends "id" ? undefined : never) }): Claim {
  const result: Claim = {
    kind: "requirement",
    text: "WHEN x, THE system SHALL y.",
    obligation: "mandatory",
    provenance: { file: "spec.md", heading: "R1" },
    references: [],
    id: toClaimId("R1"),
  };
  if (overrides === undefined) {
    return result;
  }
  const next = {
    ...result,
    ...(overrides.kind === undefined ? {} : { kind: overrides.kind }),
    ...(overrides.text === undefined ? {} : { text: overrides.text }),
    ...(overrides.obligation === undefined ? {} : { obligation: overrides.obligation }),
    ...(overrides.provenance === undefined ? {} : { provenance: overrides.provenance }),
    ...(overrides.references === undefined ? {} : { references: overrides.references }),
    ...(overrides.capability === undefined ? {} : { capability: overrides.capability }),
  };
  if (overrides.id === undefined) {
    const { id: _ignored, ...withoutId } = next;
    return withoutId as Claim;
  }
  return { ...next, id: overrides.id };
}

describe("batch context transport", () => {
  it("buildBatchContextFile uses eligible index and null for missing id", () => {
    traceSpec("FLA-ATTACH-NULL-ID");
    const claims = [
      { claim: makeClaim({ id: toClaimId("R1"), text: "first" }), eligibleIndex: 5 },
      { claim: makeClaim({ id: undefined as unknown as undefined, text: "second" }), eligibleIndex: 7 },
    ];
    const context = buildBatchContextFile("<merged-spec/auth>", claims);
    expect(context.schemaVersion).toBe(1);
    expect(context.batchKey).toBe("<merged-spec/auth>");
    expect(context.claims[0]!.index).toBe(5);
    expect(context.claims[0]!.id).toBe("R1");
    expect(context.claims[1]!.index).toBe(7);
    expect(context.claims[1]!.id).toBeNull();
  });

  it("buildBatchContextFile stores provenance file verbatim", () => {
    traceSpec("FLA-ATTACH-TRANSPORT");
    const claim = makeClaim({ provenance: { file: "weird/../path.md" } });
    const context = buildBatchContextFile("key", [{ claim, eligibleIndex: 0 }]);
    expect(context.claims[0]!.provenance.file).toBe("weird/../path.md");
  });

  it("serializeBatchContextFile is byte-deterministic", () => {
    traceSpec("FLA-ATTACH-DETERMINISTIC");
    const context = buildBatchContextFile("key", [
      { claim: makeClaim({ id: toClaimId("R1"), text: "line1\nline2" }), eligibleIndex: 0 },
    ]);
    const serialized = serializeBatchContextFile(context);
    expect(serialized.endsWith("}\n")).toBe(true);
    expect(serialized.includes("\r\n")).toBe(false);
    expect(serialized).toContain('"schemaVersion": 1');
    expect(serialized).toContain('"text": "line1\\nline2"');
    expect(sha256HexString(serialized)).toBe(sha256HexString(serializeBatchContextFile(context)));
  });

  it("buildAttachedBatchPrompt references attached JSON and requires index", () => {
    traceSpec("FLA-ATTACHP-REFERENCES", "FLA-ATTACHP-MATCHING");
    const prompt = buildAttachedBatchPrompt(3);
    expect(prompt).toContain("attached JSON context file");
    expect(prompt).toContain('"index": 0');
    expect(prompt).toContain("exactly 3 entries");
  });

  it("buildAttachedBatchPrompt marks JSON as untrusted data", () => {
    traceSpec("FLA-ATTACHP-UNTRUSTED");
    const prompt = buildAttachedBatchPrompt(2);
    expect(prompt).toContain("untrusted data");
  });

  it("buildAttachedBatchPrompt omits stale same-file language", () => {
    traceSpec("FLA-ATTACHP-NO-STALE");
    const prompt = buildAttachedBatchPrompt(2);
    expect(prompt).not.toContain("same spec file");
    expect(prompt).not.toContain("presented below");
    expect(prompt).not.toContain("```text");
  });

  it("buildAttachedBatchPrompt treats claim id as informational", () => {
    traceSpec("FLA-ATTACHP-MATCHING");
    const prompt = buildAttachedBatchPrompt(2);
    expect(prompt).toContain("claims[].id is informational");
  });
});
