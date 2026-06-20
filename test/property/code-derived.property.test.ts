import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { buildFormalizationPrompt } from "../../src/domain/formal/formalize.js";
import { buildReviewPrompt } from "../../src/domain/spec-forward/qualitative.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import type { ParsedProposal, ParsedSpec } from "../../src/domain/model.js";
import { toClaimId } from "../../src/domain/branded.js";

describe("code-derived generation boundary properties", () => {
  it("formalization prompts never include original proposal/design text verbatim", async () => {
    traceSpec("STC-GEN-BLIND");
    const claimTextArb = fc.string({ minLength: 5, maxLength: 80 });

    await fc.assert(
      fc.asyncProperty(claimTextArb, async (text) => {
        const claim: Claim = {
          kind: "requirement",
          text,
          obligation: "mandatory",
          provenance: { file: "gen_specs/cap.md", heading: "R1" },
          references: [],
          id: toClaimId("GEN-R1"),
        };

        const prompt = buildFormalizationPrompt(claim);

        // Prompt should contain claim text fenced, not proposal/design text
        expect(prompt).toContain(text);
        expect(prompt).toContain("<claim");
        expect(prompt).toContain("```text");
        expect(prompt).toContain("</claim>");
        expect(prompt).toContain("untrusted");
      }),
      { numRuns: 20 },
    );
  });

  it("qualitative review prompts fence all documents as untrusted", async () => {
    traceSpec("RAE-EVID-LLM");
    const lineArb = fc.string({ minLength: 1, maxLength: 40 });

    await fc.assert(
      fc.asyncProperty(fc.array(lineArb, { minLength: 1, maxLength: 3 }), async (lines) => {
        const proposal: ParsedProposal = {
          file: "proposal.md",
          sections: new Map([["Scope", { heading: "Scope", lines, startLine: 1, endLine: lines.length + 1 }]]),
          unparsed: [],
        };
        const spec: ParsedSpec = {
          file: "spec.md",
          requirements: [
            { title: "R1", identifier: "R1", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: [], provenance: { file: "spec.md", line: 1 } },
          ],
          scenarios: [],
          deltaSections: ["ADDED"],
          structuralFindings: [],
          unparsed: [],
        };

        const bundle = buildReviewPrompt("qualitative_review", { proposal, specs: [spec] });
        expect(bundle.prompt).toContain("untrusted");
        expect(bundle.files).toContain("proposal.md");
        expect(bundle.files).toContain("spec.md");
      }),
      { numRuns: 20 },
    );
  });
});
