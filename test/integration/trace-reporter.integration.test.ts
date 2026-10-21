import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { runProcess } from "../../src/adapters/process.js";
import { traceSpec } from "../support/spec-trace.js";

it("enforces full-catalog coverage through the installed Vitest reporter callback", async () => {
  traceSpec("TRACE-RUN-COVERAGE", "TRACE-COVERAGE-FAIL", "TRACE-RUN-SUBSET");
  const temporary = await mkdtemp(join(tmpdir(), "spec-check-reporter-"));
  try {
    // A distinct temp root prevents this deliberately failing subset run from
    // resetting the outer full-suite reporter's shared coverage record.
    const result = await runProcess(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "test/contract/process-output.test.ts"], {
      timeoutMs: 20_000, maxOutputBytes: 1_048_576,
      envOverrides: { SPEC_TRACE_COVERAGE: "1", TMPDIR: temporary, TEMP: temporary, TMP: temporary, NO_COLOR: "1" },
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Spec trace coverage failed");
    expect(result.stdout + result.stderr).toContain("Uncovered canonical identifiers");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 30_000);
