import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpecText } from "../../src/domain/parser/spec.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { groupFormalizationClaims } from "../../src/domain/formal/grouping.js";
import { traceSpec } from "../support/spec-trace.js";

describe("source provenance and admission invariants", () => {
  it("maps every normalized offset to an original character or join boundary", () => {
    traceSpec("CAT-SPANS-NORMALIZE", "CGC-CLAIM-PROVEN");
    fc.assert(fc.property(fc.constantFrom("\n", "\r\n"), fc.integer({ min: 0, max: 12 }), (newline, indent) => {
      const raw = `### Requirement: Test [SURFACE-REQ]${newline}WHEN a request${newline}${" ".repeat(indent)}arrives, THE engine MUST respond.${newline}`;
      const surface = parseSpecText("spec.md", raw).requirements[0]!.surface!;
      expect(surface.disposition.kind).toBe("eligible");
      expect(surface.sourceMap).toHaveLength(surface.text.length + 1);
      for (let i = 0; i < surface.text.length; i += 1) {
        const original = raw[surface.sourceMap[i]!.offset];
        if (surface.text[i] === " ") expect(original === " " || original === "\r" || original === "\n").toBe(true);
        else expect(original).toBe(surface.text[i]);
      }
    }));
  });

  it("retains every extracted claim and indexes only the admitted subset", () => {
    traceSpec("CGC-SCOPE-PARTITION", "CGC-SCOPE-IDENTITY");
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 30 }), (eligible) => {
      const raw = eligible.map((valid) => `### Requirement: Test [SURFACE-REQ]\n${valid ? "THE engine SHALL respond." : "Unsupported prose."}\n`).join("\n");
      const parsed = parseSpecText("spec.md", raw);
      const claims = buildClaimGraph({ specs: [parsed] }).graph.claims;
      const admitted = groupFormalizationClaims(claims, new Map()).flatMap((group) => group.claims);
      expect(claims).toHaveLength(eligible.length);
      expect(admitted).toHaveLength(eligible.filter(Boolean).length);
      expect(admitted.map((item) => item.index)).toEqual(admitted.map((_, i) => i));
      expect(new Set(claims.map((claim) => claim.surface?.source.ordinal)).size).toBe(eligible.length);
    }));
  });
});
