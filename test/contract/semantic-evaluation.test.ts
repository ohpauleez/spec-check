import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { traceSpec } from "../support/spec-trace.js";

describe("fixed corpus evaluation provenance", () => {
  it("binds measured coverage and defect outcomes to exact corpus/model/runtime identities", async () => {
    traceSpec("RAE-VERIFY-CORPUS");
    const evidence = JSON.parse(await readFile("openspec/changes/archive/2026-11-15-improve-ears-smt-analysis/evaluation.json", "utf8"));
    const hash = createHash("sha256").update(await readFile(evidence.corpus)).digest("hex");
    expect(hash).toBe(evidence.corpusSha256);
    expect(evidence.coverage.accepted + evidence.coverage.failed + evidence.coverage.excluded).toBe(evidence.coverage.extracted);
    expect(evidence.queries.sat + evidence.queries.unsat + evidence.queries.inconclusive).toBe(evidence.queries.executed);
    expect(evidence.discoveryUsage.complete).toBe(false);
    expect(evidence.model).toContain("#high");
    expect(evidence.semanticOutcome).toContain("EVAL-ACCEPT and EVAL-REJECT");
    expect(evidence.limitations).toContain("not broad accuracy");
  });
});
