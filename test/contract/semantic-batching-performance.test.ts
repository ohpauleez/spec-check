import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { buildBatchContextFile, serializeBatchContextFile, sha256HexString } from "../../src/domain/formal/transport.js";
import type { Claim } from "../../src/domain/claim-graph.js";

function indexedClaim(text: string, index: number): { readonly claim: Claim; readonly eligibleIndex: number } {
  return {
    claim: {
      kind: "requirement",
      text,
      obligation: "mandatory",
      provenance: { file: "spec.md", heading: `R${String(index + 1)}` },
      references: [],
    },
    eligibleIndex: index,
  };
}

describe("semantic batching performance guard", () => {
  it("serializes and hashes a 500-claim context within 500ms", () => {
    traceSpec("FLA-ATTACH-DETERMINISTIC");
    const claims = Array.from({ length: 500 }).map((_, index) =>
      indexedClaim(`Claim number ${String(index + 1)} with enough text to be realistic, ${"x".repeat(50)}`, index)
    );

    const start = performance.now();
    const context = buildBatchContextFile("<merged-spec/perf>", claims);
    const serialized = serializeBatchContextFile(context);
    const hash = sha256HexString(serialized);
    const elapsed = performance.now() - start;

    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(elapsed).toBeLessThan(500);
  });

  it("grows linearly-ish: 100 claims is well under one fifth of the 500-claim budget", () => {
    traceSpec("FLA-SUBBATCH");
    const claims = Array.from({ length: 100 }).map((_, index) =>
      indexedClaim(`Small claim ${String(index + 1)}.`, index)
    );

    const start = performance.now();
    const context = buildBatchContextFile("<merged-spec/perf>", claims);
    serializeBatchContextFile(context);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});
