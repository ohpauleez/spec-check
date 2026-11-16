import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSpecText } from "../../src/domain/parser/spec.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { decodeAuthoredModel, freezeRegistry } from "../../src/domain/formal/concepts.js";
import { DEFAULT_ANALYSIS, ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import { lowerPredicates } from "../../src/domain/formal/predicate-lowering.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import { renderExpression } from "../../src/domain/formal/expression-render.js";
import { ok, err } from "../../src/domain/result.js";
import { EvidenceRecorder } from "../../src/domain/formal/evidence.js";
import { traceSpec } from "../support/spec-trace.js";
import { PREDICATE_PROMPT } from "../../src/adapters/predicate-formalization.js";

const model = { concepts: [
  { name: "Called", definition: "Called", role: "event", sort: "Bool" },
  { name: "Responded", definition: "Responded", role: "output", sort: "Bool" },
  { name: "Audited", definition: "Audited", role: "output", sort: "Bool" },
] };

describe("source-owned predicate formalization", () => {
  it("actor swaps change context and actor context survives batch recovery and additional samples", async () => {
    traceSpec("CGC-CLAIM-CLAUSES", "CAT-EARS-MATCH", "FLA-CONCEPT-SHARED");
    const configured = { concepts: [
      { name: "ServerResponse", definition: "The server responds", role: "output", sort: "Bool" },
      { name: "ClientResponse", definition: "The client responds", role: "output", sort: "Bool" },
    ] };
    async function run(subjects: readonly string[], recover: boolean) {
      const requests: string[] = [];
      const text = subjects.map((subject, index) => `### Requirement: Opaque [ACTOR-${index}]\nTHE ${subject} SHALL respond.\n`).join("\n");
      const claims = buildClaimGraph({ specs: [parseSpecText("actors.md", text)] }).graph.claims;
      const result = await formalizeClaims({ claims, model: "fixture", timeoutMs: 1000, samplesPerClaim: 2, logicalFileByCapability: new Map(),
        analysis: { ...DEFAULT_ANALYSIS, models: { "actors.md": configured } }, discover: async () => ok({ payload: { concepts: [] }, warnings: [] }),
        invoke: async (context) => {
          requests.push(context); const data = JSON.parse(context);
          return { cleanup: "succeeded", contextSha256: createHash("sha256").update(context).digest("hex"), result: ok({ formalizations: data.claims.map((claim: { index: number; sourceContext: { subject: { text: string } } }) => ({
            index: claim.index, registryHash: data.registry.hash, predicates: { response: recover && requests.length === 1 ? "MissingConcept" : claim.sourceContext.subject.text === "server" ? "ServerResponse" : "ClientResponse" },
          })) }) };
        },
      });
      expect(result.ok && result.value.candidates.map((candidate) => candidate.samples.length)).toEqual([2, 2]);
      for (const request of requests) for (const claim of JSON.parse(request).claims) {
        expect(claim.sourceContext.subject.text).toBe(subjects[claim.index]);
        expect(claim.sourceContext.form).toBe("ubiquitous");
        expect(Object.keys(claim.predicates)).toEqual(["response"]);
      }
      expect(new Set(requests.map((request) => JSON.parse(request).registry.hash)).size).toBe(1);
      return requests;
    }
    const first = await run(["server", "client"], true);
    const second = await run(["client", "server"], false);
    expect(first[0]).not.toBe(second[0]);
    expect(first.some((request) => JSON.parse(request).validationFeedback !== undefined)).toBe(true);
  });
  it("returns a validation error for public lowering input without parsed source structure", () => {
    const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Test [SOURCE-REQ]\nTHE engine SHALL respond.\n")] }).graph.claims;
    const authored = decodeAuthoredModel(model, ANALYSIS_LIMITS);
    if (!authored.ok) throw new Error(authored.error);
    const registry = freezeRegistry("spec.md", "specs_forward", claims, authored.value, [], [], ANALYSIS_LIMITS);
    const { surface: _surface, ...unparsedClaim } = claims[0]!;
    expect(lowerPredicates({}, unparsedClaim, 0, registry, ANALYSIS_LIMITS)).toEqual({ ok: false, error: "Source predicate lowering requires parsed source structure" });
  });
  it("rejects response-only output for a source with a trigger", () => {
    traceSpec("FLA-ATTACH-PROMPT", "FLA-SAMPLE-REJECT");
    const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Test [SOURCE-REQ]\nWHEN called, THE engine SHALL respond.\n")] }).graph.claims;
    const authored = decodeAuthoredModel(model, ANALYSIS_LIMITS);
    if (!authored.ok) throw new Error(authored.error);
    const registry = freezeRegistry("spec.md", "specs_forward", claims, authored.value, [], [], ANALYSIS_LIMITS);
    expect(lowerPredicates({ index: 0, registryHash: registry.hash, predicates: { response: "Responded" } }, claims[0]!, 0, registry, ANALYSIS_LIMITS).ok).toBe(false);
    expect(PREDICATE_PROMPT).toContain("NEVER omit trigger/guard slots");
  });
  it("source negation and postcondition control the response skeleton", () => {
    traceSpec("FLA-SAMPLE-ACCEPT", "FLA-MODAL-TRACKS", "FLA-SCENARIO-MEANING");
    const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Test [SOURCE-REQ]\nWHEN called, THE engine SHALL NOT respond.\n**Postcondition:** audited\n")] }).graph.claims;
    const authored = decodeAuthoredModel(model, ANALYSIS_LIMITS);
    if (!authored.ok) throw new Error(authored.error);
    const registry = freezeRegistry("spec.md", "specs_forward", claims, authored.value, [], [], ANALYSIS_LIMITS);
    const lowered = lowerPredicates({ index: 0, registryHash: registry.hash, predicates: { trigger: "Called", response: "Responded", postcondition: "Audited" } }, claims[0]!, 0, registry, ANALYSIS_LIMITS);
    expect(lowered.ok && lowered.value.staticRule?.kind).toBe("mandatory");
    expect(lowered.ok && renderExpression(lowered.value.assertions[0]!.node!)).toBe("(=> vCalled (and (not vResponded) vAudited))");
    expect(lowerPredicates({ index: 0, registryHash: registry.hash, obligation: "informational", predicates: {} }, claims[0]!, 0, registry, ANALYSIS_LIMITS).ok).toBe(false);
  });

  it("uses a frozen registry for batched and additional samples", async () => {
    traceSpec("FLA-CONCEPT-SHARED", "FLA-ATTACHP-MATCHING", "FLA-FORMAL-ARTS");
    const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Test [SOURCE-REQ]\nWHEN called, THE engine SHOULD respond.\n")] }).graph.claims;
    const hashes: string[] = [];
    const result = await formalizeClaims({ claims, model: "test", samplesPerClaim: 2, timeoutMs: 300_000, logicalFileByCapability: new Map(),
      analysis: { ...DEFAULT_ANALYSIS, models: { "spec.md": model } },
      discover: async () => ok({ payload: { concepts: [] }, warnings: [] }),
      invoke: async (context) => {
        const data = JSON.parse(context) as { registry: { hash: string }; claims: { index: number }[] };
        hashes.push(data.registry.hash);
        return { result: ok({ formalizations: data.claims.map((claim) => ({ index: claim.index, registryHash: data.registry.hash, predicates: { trigger: "Called", response: "Responded" } })) }),
          cleanup: "succeeded", contextSha256: createHash("sha256").update(context).digest("hex") };
      },
    });
    expect(result.ok && result.value.candidates[0]?.samples).toHaveLength(2);
    expect(new Set(hashes).size).toBe(1);
    expect(result.ok && result.value.candidates[0]?.samples[0]?.staticRule?.kind).toBe("advisory");
  });

  it("all-ineligible source performs no model invocation", async () => {
    traceSpec("FLA-FORMAL-NO-ELIGIBLE");
    const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Invalid [SOURCE-BAD]\nUnsupported prose.\n")] }).graph.claims;
    let calls = 0;
    const result = await formalizeClaims({ claims, model: "test", samplesPerClaim: 1, timeoutMs: 300_000, logicalFileByCapability: new Map(),
      discover: async () => { calls += 1; return ok({ payload: { concepts: [] }, warnings: [] }); },
    });
    expect(calls).toBe(0);
    expect(result.ok && result.value.candidates).toEqual([]);
  });

  it("maxBatchSize zero cannot bypass typed expression or context bounds", async () => {
    traceSpec("FLA-BOUNDS-BATCH-ZERO");
    const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Test [SOURCE-REQ]\nTHE engine SHALL respond.\n")] }).graph.claims;
    const result = await formalizeClaims({ claims, model: "test", samplesPerClaim: 1, timeoutMs: 300_000, maxBatchSize: 0, logicalFileByCapability: new Map(),
      analysis: { ...DEFAULT_ANALYSIS, limits: { ...ANALYSIS_LIMITS, expressionBytes: 1 } },
      discover: async () => ok({ payload: { concepts: [] }, warnings: [] }),
      invoke: async (context) => {
        const data = JSON.parse(context);
        return { result: ok({ formalizations: [{ index: 0, registryHash: data.registry.hash, predicates: { response: "true" } }] }), cleanup: "succeeded", contextSha256: createHash("sha256").update(context).digest("hex") };
      },
    });
    expect(result.ok && result.value.candidates).toEqual([]);
    expect(result.ok && result.value.errors).toHaveLength(1);
  });

  it("type-valid inconsistent predicates remain samples for diagnosis", () => {
    traceSpec("FLA-SAMPLE-INCONSISTENT");
    const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Test [SOURCE-REQ]\nTHE engine SHALL respond.\n")] }).graph.claims;
    const authored = decodeAuthoredModel(model, ANALYSIS_LIMITS);
    if (!authored.ok) throw new Error(authored.error);
    const registry = freezeRegistry("spec.md", "specs_forward", claims, authored.value, [], [], ANALYSIS_LIMITS);
    expect(lowerPredicates({ index: 0, registryHash: registry.hash, predicates: { response: "(and Responded (not Responded))" } }, claims[0]!, 0, registry, ANALYSIS_LIMITS).ok).toBe(true);
  });

  it("recovery feedback and rejected samples survive later candidate shortfalls", async () => {
    traceSpec("FLA-FORMAL-PARTIAL", "FLA-SAMPLE-REJECT", "RAE-FORMAL-ATTEMPT-SETS");
    const claims = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Test [SOURCE-REQ]\nWHEN called, THE engine SHALL respond.\n")] }).graph.claims;
    const writes = new Map<string, string | Uint8Array>();
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async (path, content) => { writes.set(path, content); });
    let calls = 0;
    const result = await formalizeClaims({ claims, model: "test", samplesPerClaim: 2, timeoutMs: 300_000, logicalFileByCapability: new Map(), evidence,
      analysis: { ...DEFAULT_ANALYSIS, models: { "spec.md": model } }, discover: async () => ok({ payload: { concepts: [] }, warnings: [] }),
      invoke: async (context) => {
        calls += 1; const data = JSON.parse(context);
        if (calls === 2) expect(data.validationFeedback).toContain("trigger");
        return { result: calls === 3 ? err({ kind: "timeout" as const, phase: "formalization" as const, message: "later timeout" }) : ok({ formalizations: [{ index: 0, registryHash: data.registry.hash,
          predicates: calls === 1 ? { response: "Responded" } : { trigger: "Called", response: "Responded" } }] }), cleanup: "succeeded", contextSha256: createHash("sha256").update(context).digest("hex") };
      },
    });
    expect(result.ok && result.value.candidates).toHaveLength(1);
    expect(result.ok && result.value.candidates[0]?.samples).toHaveLength(1);
    expect(result.ok && result.value.candidates[0]?.invalidSamples).toHaveLength(2);
    expect(result.ok && result.value.errors).toEqual([]);
    expect([...writes.keys()].filter((path) => path.endsWith(".validation.json"))).toHaveLength(3);
  });
});
