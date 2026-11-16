import { describe, expect, it } from "vitest";
import { discoverGroup } from "../../src/domain/formal/concept-discovery.js";
import { DEFAULT_ANALYSIS } from "../../src/domain/formal/analysis-config.js";
import { parseSpecText } from "../../src/domain/parser/spec.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { ok, err } from "../../src/domain/result.js";
import { traceSpec } from "../support/spec-trace.js";

const parsed = parseSpecText("spec.md", "### Requirement: Test [DISCOVERY-REQ]\nWHEN request arrives, THE engine SHALL respond.\n");
const claims = buildClaimGraph({ specs: [parsed] }).graph.claims;

describe("bounded frozen concept discovery", () => {
  it("freezes only after the complete pass with selected source grounding", async () => {
    traceSpec("FLA-CONCEPT-FREEZE", "FLA-CONCEPT-ORDER", "FLA-CONCEPT-SHARED");
    const result = await discoverGroup({ group: "group", side: "specs_forward", claims,
      invoke: async (request) => {
        expect(JSON.parse(request.context).claims[0].source).toEqual({ file: "spec.md", ordinal: 0 });
        return ok({ payload: { concepts: [{ name: "Request", definition: "Incoming request", role: "event", sort: "Bool", source: { file: "spec.md", ordinal: 0 }, term: "request" }] }, warnings: [] });
      },
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.registry.concepts[0]?.name).toBe("Request");
    expect(Object.isFrozen(result.registry)).toBe(true);
  });

  it("does not supply original authored models to generated discovery", async () => {
    traceSpec("STC-ALIGN-BLIND");
    const result = await discoverGroup({ group: "group", side: "generated_spec", claims,
      analysis: { ...DEFAULT_ANALYSIS, models: { group: { background: ["ORIGINAL SECRET"] } } },
      invoke: async (request) => {
        expect(request.context).not.toContain("ORIGINAL SECRET");
        return ok({ payload: { concepts: [], proposedAssumptions: ["proposed only"] }, warnings: [] });
      },
    });
    expect(result.registry.background).toEqual([]);
  });

  it("keeps transport/model failures as localized explicit scope", async () => {
    traceSpec("FLA-CONCEPT-MISSING", "FLA-BOUNDS-DISCOVERY");
    const result = await discoverGroup({ group: "group", side: "specs_forward", claims, invoke: async () => err("model timeout") });
    expect(result.issues).toContain("model timeout");
    expect(result.registry.concepts).toEqual([]);
    expect(result.attempts[0]?.response.ok).toBe(false);
  });

  it("does not call the model on a context that exceeds admission bounds", async () => {
    traceSpec("FLA-BOUNDS-DISCOVERY");
    let calls = 0;
    const result = await discoverGroup({ group: "group", side: "specs_forward", claims,
      analysis: { ...DEFAULT_ANALYSIS, limits: { ...DEFAULT_ANALYSIS.limits, discoveryContextBytes: 1 } },
      invoke: async () => { calls += 1; return ok({ payload: { concepts: [] }, warnings: [] }); },
    });
    expect(calls).toBe(0);
    expect(result.issues.join(" ")).toContain("bound");
  });

  it("propagates required evidence failures rather than accepting an unrecorded pass", async () => {
    traceSpec("RAE-EVIDENCE-WRITE");
    const failure = new Error("required evidence failed");
    await expect(discoverGroup({ group: "group", side: "specs_forward", claims, invoke: async () => { throw failure; } })).rejects.toBe(failure);
  });
});
