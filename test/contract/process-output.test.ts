import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runProcess } from "../../src/adapters/process.js";

describe("process output bounds", () => {
  it("kills a child when combined captured output exceeds the configured byte bound", async () => {
    traceSpec("RAE-FINAL-PROTO-ACK");
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(100000))"],
      { timeoutMs: 30_000, maxOutputBytes: 1_024 },
    );
    expect(result.outputLimitExceeded).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_024);
  });
});
