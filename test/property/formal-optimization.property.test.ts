import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { discoverGroup } from "../../src/domain/formal/concept-discovery.js";
import { DEFAULT_ANALYSIS } from "../../src/domain/formal/analysis-config.js";
import { EvidenceRecorder, EvidencePersistenceError } from "../../src/domain/formal/evidence.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { parseSpecText } from "../../src/domain/parser/spec.js";
import { traceSpec } from "../support/spec-trace.js";

/** Pre-optimization serialization/chunk decisions, kept independent of the optimized packer. */
function referenceContexts(claims: readonly Claim[], limit: number): readonly string[] {
  const render = (items: readonly Claim[]) => JSON.stringify({ schemaVersion: 1, group: "group", side: "specs_forward", authored: { concepts: [], enums: [], units: [], background: [], coverage: [] },
    claims: items.map((claim, index) => ({ source: claim.surface?.source ?? { file: claim.provenance.file, ordinal: index }, kind: claim.surface?.scenarioKind ?? "refinement",
      clauses: Object.fromEntries(Object.entries(claim.surface?.clauses ?? {}).filter(([, slot]) => typeof slot === "object" && slot !== null && "text" in slot).map(([key, slot]) => [key, (slot as { text: string }).text])),
      fields: Object.fromEntries(Object.entries(claim.surface?.fields ?? {}).map(([key, field]) => [key, field?.text])), text: claim.text })),
  }, null, 2) + "\n";
  const contexts: string[] = []; let chunk: Claim[] = [];
  for (const claim of claims) {
    if (Buffer.byteLength(render([...chunk, claim]), "utf8") > limit) {
      if (chunk.length > 0) contexts.push(render(chunk));
      chunk = [];
      if (Buffer.byteLength(render([claim]), "utf8") > limit) continue;
    }
    chunk.push(claim);
  }
  if (chunk.length > 0) contexts.push(render(chunk));
  return contexts;
}

describe("optimization boundary histories", () => {
  it("linear chunk packing preserves exact JSON bytes, fallback ordinals and Unicode boundaries", async () => {
    traceSpec("FLA-BOUNDS-DISCOVERY", "FLA-CONCEPT-ORDER");
    await fc.assert(fc.asyncProperty(fc.array(fc.fullUnicodeString({ maxLength: 50 }), { maxLength: 20 }), fc.integer({ min: 300, max: 2000 }), async (texts, limit) => {
      const parsed = buildClaimGraph({ specs: [parseSpecText("spec.md", "### Requirement: Test [PREP-REQ]\nWHEN called, THE engine SHALL respond.\n**Postcondition:** response exists\n")] }).graph.claims[0]!;
      const claims: Claim[] = texts.map((text, index) => index % 2 === 0
        ? { kind: "requirement", text, obligation: "mandatory", provenance: { file: "spec:with:colons.md" }, references: [] }
        : { ...parsed, text, surface: { ...parsed.surface!, source: { ...parsed.surface!.source, ordinal: index, namespace: "test:scope" } } });
      const contexts: string[] = [];
      await discoverGroup({ group: "group", side: "specs_forward", claims, analysis: { ...DEFAULT_ANALYSIS, limits: { ...DEFAULT_ANALYSIS.limits, discoveryChunkBytes: limit } },
        invoke: async (request) => { expect(request.ordinal).toBe(contexts.length); contexts.push(request.context); return { ok: true, value: { payload: { concepts: [] }, warnings: [] } }; },
      });
      expect(contexts).toEqual(referenceContexts(claims, limit));
    }), { numRuns: 50 });
  });

  it("reservation admission agrees with a sum-based model across consumption and release histories", async () => {
    traceSpec("RAE-EVIDENCE-ADMISSION", "RAE-EVIDENCE-BUDGET");
    await fc.assert(fc.asyncProperty(fc.array(fc.record({ op: fc.constantFrom("reserve", "release", "consume"), key: fc.integer({ min: 0, max: 5 }), bytes: fc.integer({ min: 0, max: 30 }) }), { maxLength: 60 }), async (operations) => {
      const tickets = new Map<string, number>(); let used = 0; let ordinal = 0;
      const recorder = new EvidenceRecorder(100, async () => {});
      for (const operation of operations) {
        const key = String(operation.key);
        if (operation.op === "reserve") {
          const allowed = !tickets.has(key) && used + [...tickets.values()].reduce((sum, bytes) => sum + bytes, 0) + operation.bytes <= 100;
          expect(recorder.reserve(key, operation.bytes)).toBe(allowed);
          if (allowed) tickets.set(key, operation.bytes);
        } else if (operation.op === "release") { recorder.release(key); tickets.delete(key); }
        else {
          const remaining = tickets.get(key);
          const write = recorder.text(`artifact-${ordinal++}`, "value", "x".repeat(operation.bytes), "logic", key);
          if (remaining === undefined || operation.bytes > remaining) await expect(write).rejects.toBeInstanceOf(EvidencePersistenceError);
          else { tickets.set(key, remaining - operation.bytes); used += operation.bytes; await write; }
        }
      }
    }), { numRuns: 50 });
  });

  it("scope indexing preserves the original descendant predicate, ordering and idempotent writes", async () => {
    traceSpec("RAE-EVIDENCE-IDENTITY", "RAE-FORMAL-ATTEMPT-SETS");
    await fc.assert(fc.asyncProperty(fc.array(fc.oneof(fc.fullUnicodeString({ maxLength: 25 }), fc.constantFrom("root:a", "root:a:child", "root:a1", ":", "root::child")), { maxLength: 30 }), async (scopes) => {
      const records: { scope: string; path: string }[] = [];
      const recorder = new EvidenceRecorder(1_048_576, async () => {});
      for (let index = 0; index < scopes.length; index += 1) {
        const scope = scopes[index]!;
        const descriptor = await recorder.text(scope, `value-${index}`, "x");
        await recorder.text(scope, `value-${index}`, "x");
        records.push({ scope, path: descriptor.path });
      }
      const queries = new Set(["", ...scopes, ...scopes.flatMap((scope) => scope.split("").flatMap((char, index) => char === ":" ? [scope.slice(0, index)] : []))]);
      for (const query of queries) expect(recorder.filesForScope(query)).toEqual(records.filter((record) => record.scope === query || record.scope.startsWith(`${query}:`)).map((record) => record.path).sort());
    }), { numRuns: 40 });
  });

  it("failed ticketed and unticketed writes retain the same capacity charge", async () => {
    traceSpec("RAE-EVIDENCE-WRITE", "RAE-EVIDENCE-ADMISSION");
    const ticketed = new EvidenceRecorder(100, async () => { throw new Error("failed write"); });
    ticketed.reserve("attempt", 100);
    await expect(ticketed.text("scope", "value", "x".repeat(20), "logic", "attempt")).rejects.toThrow("Required evidence");
    ticketed.release("attempt"); ticketed.release("attempt");
    expect(ticketed.reserve("next", 81)).toBe(false);
    expect(ticketed.reserve("next", 80)).toBe(true);
    const unticketed = new EvidenceRecorder(100, async () => { throw new Error("failed write"); });
    await expect(unticketed.text("scope", "value", "x".repeat(20))).rejects.toThrow("Required evidence");
    expect(unticketed.reserve("next", 81)).toBe(false);
    const internalTicket = `semantic_evidence/${createHash("sha256").update("scope").digest("hex")}.value.txt`;
    unticketed.release(internalTicket);
    expect(unticketed.reserve("next", 100)).toBe(true);
  });
});
