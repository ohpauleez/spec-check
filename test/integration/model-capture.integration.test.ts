import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/adapters/process.js";
import { traceSpec } from "../support/spec-trace.js";

describe("exact captured bytes at the process boundary", () => {
  it("retains invalid UTF-8 bytes without confusing lossy diagnostics with evidence", async () => {
    traceSpec("RAE-ATTEMPT-ALL-PATHS", "RAE-ATTEMPT-OVERFLOW");
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write(Buffer.from([255,40,41]));"], { captureBytes: true, timeoutMs: 5_000, maxOutputBytes: 1_024 });
    expect(result.stdoutInvalidUtf8).toBe(true);
    expect(result.stdoutBase64).toBe(Buffer.from([255, 40, 41]).toString("base64"));
    expect(result.stderrBase64).toBe("");
    expect(result.outputLimitExceeded).toBe(false);
  });
});
