import { mkdtemp, rm, writeFile } from "node:fs/promises";

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { callOpencode } from "../../src/adapters/opencode.js";
import { toCapabilityName, toClaimId } from "../../src/domain/branded.js";
import type { Claim } from "../../src/domain/claim-graph.js";
import type { BatchAttemptEvidence } from "../../src/domain/formal/batch-transport.js";
import { formalizeClaims } from "../../src/domain/formal/formalize.js";
import { traceSpec } from "../support/spec-trace.js";

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../src/adapters/opencode.js", () => ({
  callOpencode: vi.fn(),
}));

const TEMP_DIRECTORY = "/tmp/spec-check-batch-history";

/**
 * One fault-injection choice for a single attached-batch attempt history.
 *
 * @remarks
 * The attached lifecycle is the deterministic chain
 * `mkdtemp -> writeFile -> adapter call -> rm`; each field decides whether one
 * step in that chain fails. A `dirCreate` failure short-circuits the chain
 * (no directory means no write, no adapter call, no cleanup), matching the
 * transport contract.
 */
interface AttemptScript {
  readonly dirCreate: "ok" | "fail";
  readonly write: "ok" | "fail";
  readonly adapter: "success" | "invalid_envelope";
  readonly cleanup: "ok" | "fail";
}

const attemptScriptArbitrary: fc.Arbitrary<AttemptScript> = fc.record({
  dirCreate: fc.constantFrom("ok" as const, "fail" as const),
  write: fc.constantFrom("ok" as const, "fail" as const),
  adapter: fc.constantFrom("success" as const, "invalid_envelope" as const),
  cleanup: fc.constantFrom("ok" as const, "fail" as const),
});

/** Build two same-file claims so they always land in one attached batch. */
function historyClaims(): Claim[] {
  return [0, 1].map((index): Claim => ({
    kind: "requirement",
    text: `History claim ${String(index)}`,
    obligation: "mandatory",
    provenance: { file: "history.md", line: index + 1 },
    references: [],
    capability: toCapabilityName("auth"),
    id: toClaimId(`HIST-${String(index)}`),
  }));
}

/**
 * Drive one scripted attached-attempt history and return the observed outcome.
 *
 * @remarks
 * Mocks are installed per run so every generated history is independent. The
 * adapter "success" script returns a structurally valid two-entry envelope;
 * "invalid_envelope" returns zero entries so the envelope-matching failure
 * path is exercised without falling back (fallback inline calls are left to
 * the default mock, which fails them, keeping the outcome a model failure).
 */
async function runScriptedHistory(script: AttemptScript): Promise<{
  readonly batchAttempts: readonly BatchAttemptEvidence[];
  readonly cleanupCalls: number;
  readonly writeCalls: number;
  readonly mkdtempCalls: number;
}> {
  const mockedMkdtemp = vi.mocked(mkdtemp);
  const mockedWriteFile = vi.mocked(writeFile);
  const mockedRm = vi.mocked(rm);
  const mockedOpencode = vi.mocked(callOpencode);

  // Reset inside the property body: `beforeEach` runs once per `it`, not once
  // per generated history, so isolation must be established here per run.
  mockedMkdtemp.mockReset();
  mockedWriteFile.mockReset();
  mockedRm.mockReset();
  mockedOpencode.mockReset();

  if (script.dirCreate === "fail") {
    mockedMkdtemp.mockRejectedValueOnce(new Error("EACCES: temp not writable"));
  } else {
    mockedMkdtemp.mockResolvedValueOnce(TEMP_DIRECTORY);
  }
  if (script.write === "fail") {
    mockedWriteFile.mockRejectedValueOnce(new Error("ENOSPC: write failed"));
  } else {
    mockedWriteFile.mockResolvedValueOnce(undefined);
  }
  mockedOpencode.mockImplementation(async () => {
    if (script.adapter === "success") {
      return {
        ok: true,
        value: {
          formalizations: [0, 1].map((index) => ({
            index,
            claimId: `HIST-${String(index)}`,
            obligation: "mandatory",
            variables: [{ name: "State", sort: "Bool" }],
            functions: [],
            assertions: [{ id: "A1", expr: "true" }],
          })),
        },
      };
    }
    // Zero entries for a two-claim batch: envelope mismatch.
    return { ok: true, value: { formalizations: [] } };
  });
  if (script.cleanup === "fail") {
    mockedRm.mockRejectedValueOnce(new Error("EBUSY: directory busy"));
  } else {
    mockedRm.mockResolvedValueOnce(undefined);
  }

  const result = await formalizeClaims({
    claims: historyClaims(),
    model: "history-model",
    samplesPerClaim: 1,
    timeoutMs: 300_000,
    concurrency: 1,
    logicalFileByCapability: new Map([["auth", "merged/auth.md"]]),
  });

  expect(result.ok).toBe(true);
  const output = result.ok ? result.value : { batchAttempts: [] };
  return {
    batchAttempts: output.batchAttempts,
    cleanupCalls: mockedRm.mock.calls.length,
    writeCalls: mockedWriteFile.mock.calls.length,
    mkdtempCalls: mockedMkdtemp.mock.calls.length,
  };
}

describe("attached temp lifecycle histories", () => {
  it("cleanup is attempted iff a directory was created, and evidence matches the terminal state", async () => {
    traceSpec("FLA-TEMP-LIFECYCLE", "FLA-TEMP-TERMINATION", "FLA-TEMP-ORDER", "FLA-TEMP-DIRFAIL");
    await fc.assert(
      fc.asyncProperty(attemptScriptArbitrary, async (script) => {
        const observed = await runScriptedHistory(script);

        // Exactly one attempt, exactly one evidence record.
        expect(observed.batchAttempts).toHaveLength(1);
        const evidence = observed.batchAttempts[0];
        expect(evidence).toBeDefined();
        if (evidence === undefined) return;

        // Directory creation precedes all other steps.
        expect(observed.mkdtempCalls).toBe(1);

        if (script.dirCreate === "fail") {
          // No directory: no write, no cleanup; evidence records not_attempted.
          expect(observed.writeCalls).toBe(0);
          expect(observed.cleanupCalls).toBe(0);
          expect(evidence.cleanup).toBe("not_attempted");
          expect(evidence.outcome.kind).toBe("transport_failure");
          return;
        }

        // A directory existed, so cleanup must be attempted exactly once.
        expect(observed.cleanupCalls).toBe(1);
        expect(evidence.cleanup).toBe(script.cleanup === "fail" ? "failed" : "succeeded");
      }),
      { numRuns: 120 },
    );
  });

  it("cleanup failure never masks the attempt outcome and never skips the attempt", async () => {
    traceSpec("FLA-TEMP-CLEANUP-WARN", "FLA-TEMP-WRITEFAIL", "FLA-TEMP-SUCCESS");
    await fc.assert(
      fc.asyncProperty(
        attemptScriptArbitrary.filter((script) => script.dirCreate === "ok"),
        async (script) => {
          const observed = await runScriptedHistory(script);
          const evidence = observed.batchAttempts[0];
          expect(evidence).toBeDefined();
          if (evidence === undefined) return;

          // The outcome channel reflects the adapter/write verdict, never the
          // cleanup verdict: cleanup classification lives only in `cleanup`.
          if (script.write === "fail") {
            expect(evidence.outcome.kind).toBe("transport_failure");
          } else {
            expect(evidence.outcome.kind === "success" || evidence.outcome.kind === "model_failure").toBe(true);
          }
          // Cleanup outcome is independent of, and never replaces, the attempt outcome.
          expect(evidence.cleanup === "succeeded" || evidence.cleanup === "failed").toBe(true);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("a write failure still attempts cleanup exactly once before returning evidence", async () => {
    traceSpec("FLA-TEMP-WRITEFAIL-CLEANUP", "FLA-TEMP-TERMINATION");
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("ok" as const, "fail" as const),
        fc.constantFrom("success" as const, "invalid_envelope" as const),
        async (cleanup, adapter) => {
          const observed = await runScriptedHistory({
            dirCreate: "ok",
            write: "fail",
            adapter,
            cleanup,
          });
          // Write failed, so the adapter was never reached; cleanup still ran.
          expect(observed.cleanupCalls).toBe(1);
          const evidence = observed.batchAttempts[0];
          expect(evidence?.outcome.kind).toBe("transport_failure");
          expect(evidence?.cleanup).toBe(cleanup === "fail" ? "failed" : "succeeded");
        },
      ),
      { numRuns: 40 },
    );
  });
});
