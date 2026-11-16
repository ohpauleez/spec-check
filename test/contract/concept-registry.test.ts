import { describe, expect, it } from "vitest";
import { decodeAuthoredModel, freezeRegistry, type AuthoredModel } from "../../src/domain/formal/concepts.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import { parseSpecText } from "../../src/domain/parser/spec.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { traceSpec } from "../support/spec-trace.js";

const raw = "### Requirement: Test [CONCEPT-REQ]\nWHEN request arrives, THE engine SHALL respond.\n";
const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", raw)] }).graph.claims;
const empty: AuthoredModel = { concepts: [], enums: [], units: [], background: [], coverage: [] };
const candidate = { name: "Request", sort: "Bool", definition: "An incoming request", role: "event", aliases: ["request"], source: { file: "spec.md", ordinal: 0 }, term: "request" };

describe("frozen capability concepts", () => {
  it("grounds proposals in selected source without admitting background guesses", () => {
    traceSpec("FLA-CONCEPT-FREEZE", "FLA-PREMISE-INFERRED", "FLA-PREMISE-CONDITIONAL", "FLA-PREMISE-AUTHORITY");
    const registry = freezeRegistry("group", "specs_forward", claims, empty, [candidate], ["Requests are positive"], ANALYSIS_LIMITS);
    expect(registry.concepts[0]?.status).toBe("grounded-proposal");
    expect(registry.concepts[0]?.evidence[0]?.file).toBe("spec.md");
    expect(registry.background).toEqual([]);
    expect(registry.proposedAssumptions).toHaveLength(1);
    expect(Object.isFrozen(registry.signature.symbols)).toBe(true);
  });

  it("does not accept model-invented exhaustive enums", () => {
    traceSpec("FLA-PREMISE-ENUM");
    const registry = freezeRegistry("group", "specs_forward", claims, empty, [{ ...candidate, sort: { enum: "Mode" } }], [], ANALYSIS_LIMITS);
    expect(registry.concepts).toEqual([]);
    expect(registry.unresolved).toContain("Request");
  });

  it("rejects incompatible explicit keys rather than choosing the first", () => {
    traceSpec("FLA-CONCEPT-COLLISION");
    expect(decodeAuthoredModel({ concepts: [candidate, { ...candidate, sort: "Int" }] }, ANALYSIS_LIMITS).ok).toBe(false);
    expect(decodeAuthoredModel(123, ANALYSIS_LIMITS).ok).toBe(false);
    expect(decodeAuthoredModel({ concepts: [candidate, candidate] }, ANALYSIS_LIMITS).ok).toBe(false);
    expect(decodeAuthoredModel({ concepts: [{ ...candidate, scope: "unknown temporal domain" }] }, ANALYSIS_LIMITS).ok).toBe(false);
    expect(decodeAuthoredModel({ transitions: ["future"] }, ANALYSIS_LIMITS).ok).toBe(false);
  });

  it("retains unresolved identity collisions instead of equating meanings", () => {
    traceSpec("FLA-CONCEPT-COLLISION");
    const registry = freezeRegistry("group", "specs_forward", claims, empty, [candidate, { ...candidate, definition: "A different request" }], [], ANALYSIS_LIMITS);
    expect(registry.concepts).toEqual([]);
    expect(registry.unresolved).toEqual(["Request"]);
  });

  it("freezes declarations and grounds retries against the same scoped hash", () => {
    traceSpec("FLA-CONCEPT-SHARED", "FLA-CONCEPT-ORDER");
    const response = { ...candidate, name: "Responded", role: "output", definition: "Response emitted", term: "respond" };
    const first = freezeRegistry("group", "specs_forward", claims, empty, [candidate, response], [], ANALYSIS_LIMITS);
    const second = freezeRegistry("group", "specs_forward", claims, empty, [response, candidate], [], ANALYSIS_LIMITS);
    expect(first.hash).toBe(second.hash);
    expect(first).toEqual(second);
    expect(freezeRegistry("group", "generated_spec", claims, empty, [candidate, response], [], ANALYSIS_LIMITS).hash).not.toBe(first.hash);
  });

  it("does not create private symbols for missing or removed source grounding", () => {
    traceSpec("FLA-CONCEPT-MISSING", "MCA-CONCEPT-REMOVED");
    const registry = freezeRegistry("group", "specs_forward", [], empty, [candidate], [], ANALYSIS_LIMITS);
    expect(registry.signature.symbols).toEqual([]);
    expect(registry.unresolved).toContain("Request");
  });

  it("preserves explicit configuration authority against model-proposed changes", () => {
    traceSpec("FLA-PREMISE-AUTHORITY");
    const authored = decodeAuthoredModel({ concepts: [candidate], background: ["Request"] }, ANALYSIS_LIMITS);
    if (!authored.ok) throw new Error(authored.error);
    const registry = freezeRegistry("group", "specs_forward", claims, authored.value, [{ ...candidate, sort: "Int" }], [], ANALYSIS_LIMITS, "config.json");
    expect(registry.concepts[0]?.status).toBe("explicit");
    expect(registry.concepts[0]?.sort).toBe("Bool");
    expect(registry.concepts[0]?.authority).toEqual({ kind: "configuration", pointer: "/analysis/models/group/concepts/0", file: "config.json" });
    expect(registry.background).toEqual(["Request"]);
  });

  it("exposes concept bounds instead of silently truncating discovery", () => {
    traceSpec("FLA-BOUNDS-DISCOVERY");
    const registry = freezeRegistry("group", "specs_forward", claims, empty, [candidate, { ...candidate, name: "Other" }], [], { ...ANALYSIS_LIMITS, concepts: 1 });
    expect(registry.concepts).toHaveLength(1);
    expect(registry.unresolved).toHaveLength(1);
    expect(registry.issues.join(" ")).toContain("bound");
  });

  it("frozen evidence and authored arrays cannot alias caller mutation", () => {
    traceSpec("FLA-CONCEPT-SHARED");
    const background = ["Request"];
    const source = { file: "spec.md", ordinal: 0 };
    const model: AuthoredModel = { ...empty, background, coverage: [{ name: "scope", applicability: "Request", sources: [source] }] };
    const proposal = { description: "proposed only" };
    const registry = freezeRegistry("group", "specs_forward", claims, model, [candidate], [proposal], ANALYSIS_LIMITS);
    background.push("mutated"); source.ordinal = 99; proposal.description = "mutated";
    expect(registry.background).toEqual(["Request"]);
    expect(registry.coverage[0]?.sources[0]?.ordinal).toBe(0);
    expect(registry.proposedAssumptions).toEqual(['{"description":"proposed only"}']);
  });
});
