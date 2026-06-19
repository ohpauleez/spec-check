import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { addFindings, createInitialRunState } from "../../src/domain/run-state.js";
import type { Finding } from "../../src/domain/findings.js";

function makeFinding(description: string): Finding {
  return {
    severity: "warning",
    category: "test",
    provenance: { file: "test.md" },
    description,
    rationale: "test rationale",
    evidence: [{ kind: "test", value: description }],
  };
}

describe("run-state properties", () => {
  it("findings are never removed by later phases (append-only)", async () => {
    traceSpec("RAE-FINDINGS-IMMUTABLE", "RAE-IMMUT-KEEP");
    const findingArb = fc.string({ minLength: 1, maxLength: 30 }).map(makeFinding);

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(findingArb, { minLength: 0, maxLength: 3 }), { minLength: 1, maxLength: 5 }),
        async (phases) => {
          let state = createInitialRunState();
          let totalFindings = 0;

          for (const phaseFindings of phases) {
            state = addFindings(state, phaseFindings);
            totalFindings += phaseFindings.length;
            expect(state.findings.length).toBe(totalFindings);
          }

          // Verify all findings from all phases are present
          let offset = 0;
          for (const phaseFindings of phases) {
            for (const finding of phaseFindings) {
              expect(state.findings[offset]).toBe(finding);
              offset += 1;
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
