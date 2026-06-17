import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runZ3Query } from "../../src/adapters/z3.js";
import { toSmtlibContent } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/process.js", () => ({
  runProcess: vi.fn(),
}));

describe("z3 adapter contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pipes SMT-LIB via stdin and captures stdout/stderr", async () => {
    traceSpec("FLA-SOLVER-TIMEOUT", "FLA-TIMEOUT-PASS");
    const { runProcess } = await import("../../src/adapters/process.js");
    const mocked = vi.mocked(runProcess);
    mocked.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: "sat\n",
      stderr: "",
      timedOut: false,
    });

    await runZ3Query({ smtlib: toSmtlibContent("(check-sat)"), timeoutMs: 5000 });

    expect(mocked).toHaveBeenCalledOnce();
    const [command, args, options] = mocked.mock.calls[0] as [string, readonly string[], { stdinText?: string }];
    expect(command).toBe("z3");
    expect(args).toEqual(["-in"]);
    expect(options.stdinText).toBe("(check-sat)");
  });

  it("classifies sat stdout as sat", async () => {
    traceSpec("FLA-TIMEOUT-PASS");
    const { runProcess } = await import("../../src/adapters/process.js");
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: "sat\n",
      stderr: "",
      timedOut: false,
    });

    const result = await runZ3Query({ smtlib: toSmtlibContent("(check-sat)") });
    expect(result.kind).toBe("sat");
    expect(result.stdout).toBe("sat\n");
  });

  it("classifies unsat stdout as unsat", async () => {
    traceSpec("FLA-TIMEOUT-PASS");
    const { runProcess } = await import("../../src/adapters/process.js");
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: "unsat\n",
      stderr: "",
      timedOut: false,
    });

    const result = await runZ3Query({ smtlib: toSmtlibContent("(check-sat)") });
    expect(result.kind).toBe("unsat");
  });

  it("classifies unknown stdout as unknown", async () => {
    traceSpec("FLA-TIMEOUT-PASS");
    const { runProcess } = await import("../../src/adapters/process.js");
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      stdout: "unknown\n",
      stderr: "",
      timedOut: false,
    });

    const result = await runZ3Query({ smtlib: toSmtlibContent("(check-sat)") });
    expect(result.kind).toBe("unknown");
  });

  it("classifies unrecognized first line as error", async () => {
    traceSpec("FLA-TIMEOUT-PASS");
    const { runProcess } = await import("../../src/adapters/process.js");
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      stdout: "something unexpected\n",
      stderr: "parse error",
      timedOut: false,
    });

    const result = await runZ3Query({ smtlib: toSmtlibContent("(check-sat)") });
    expect(result.kind).toBe("error");
    expect(result.stderr).toBe("parse error");
  });

  it("returns timeout when process timed out", async () => {
    traceSpec("FLA-SOLVER-TIMEOUT", "FLA-TIMEOUT-EXCEED");
    const { runProcess } = await import("../../src/adapters/process.js");
    vi.mocked(runProcess).mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      timedOut: true,
    });

    const result = await runZ3Query({ smtlib: toSmtlibContent("(check-sat)"), timeoutMs: 100 });
    expect(result.kind).toBe("timeout");
  });

  it("returns error when process throws", async () => {
    traceSpec("CAT-DEPS-Z3");
    const { runProcess } = await import("../../src/adapters/process.js");
    vi.mocked(runProcess).mockRejectedValueOnce(new Error("ENOENT"));

    const result = await runZ3Query({ smtlib: toSmtlibContent("(check-sat)"), z3Path: "/nonexistent/z3" });
    expect(result.kind).toBe("error");
    expect(result.stderr).toContain("ENOENT");
  });
});
