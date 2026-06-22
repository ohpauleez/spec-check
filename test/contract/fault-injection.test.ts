import { beforeEach, describe, expect, it, vi } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { runZ3Query } from "../../src/adapters/z3.js";
import { callOpencode } from "../../src/adapters/opencode.js";
import { writeOutputAtomic } from "../../src/adapters/fs.js";
import { toOutputDirPath, toRelativePath, toSmtlibContent } from "../../src/domain/branded.js";

vi.mock("../../src/adapters/process.js", () => ({
  runProcess: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

describe("fault injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Z3 adapter failures", () => {
    it("classifies timedOut process as timeout regardless of signal", async () => {
      traceSpec("FLA-SOLVER-TIMEOUT", "FLA-TIMEOUT-EXCEED");
      const { runProcess } = await import("../../src/adapters/process.js");
      vi.mocked(runProcess).mockResolvedValueOnce({
        exitCode: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        timedOut: true,
      });

      const result = await runZ3Query({ smtlib: toSmtlibContent("(check-sat)"), timeoutMs: 100 });

      expect(result.kind).toBe("timeout");
      expect(result.exitCode).toBeNull();
    });

    it("classifies non-zero exit with garbage stderr as error", async () => {
      traceSpec("FLA-SOLVER-TIMEOUT");
      const { runProcess } = await import("../../src/adapters/process.js");
      vi.mocked(runProcess).mockResolvedValueOnce({
        exitCode: 139,
        signal: "SIGSEGV",
        stdout: "\x00\xff\xfe garbage binary data",
        stderr: "segfault in z3::solver::check_core\nstack corrupted",
        timedOut: false,
      });

      const result = await runZ3Query({ smtlib: toSmtlibContent("(assert true)") });

      expect(result.kind).toBe("error");
      expect(result.exitCode).toBe(139);
      expect(result.stderr).toContain("segfault");
    });

    it("captures spawn failure as error with descriptive message", async () => {
      traceSpec("CAT-DEPS-Z3");
      const { runProcess } = await import("../../src/adapters/process.js");
      vi.mocked(runProcess).mockRejectedValueOnce(new Error("spawn ENOENT"));

      const result = await runZ3Query({ smtlib: toSmtlibContent("(check-sat)"), z3Path: "/missing/z3" });

      expect(result.kind).toBe("error");
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain("ENOENT");
    });
  });

  describe("filesystem failures", () => {
    it("propagates EACCES from writeFile as thrown error", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      vi.mocked(mkdir).mockResolvedValueOnce(undefined);
      const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
      vi.mocked(writeFile).mockRejectedValueOnce(eacces);

      const thrown = await writeOutputAtomic(
        toOutputDirPath("/tmp/out"),
        toRelativePath("report.json"),
        "{}",
      ).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("permission denied");
      expect((thrown as NodeJS.ErrnoException).code).toBe("EACCES");
    });

    it("propagates ENOSPC from writeFile as thrown error", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      vi.mocked(mkdir).mockResolvedValueOnce(undefined);
      const enospc = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      vi.mocked(writeFile).mockRejectedValueOnce(enospc);

      const thrown = await writeOutputAtomic(
        toOutputDirPath("/tmp/out"),
        toRelativePath("data.smt2"),
        "(check-sat)",
      ).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as NodeJS.ErrnoException).code).toBe("ENOSPC");
    });

    it("rejects path traversal at branding boundary", () => {
      traceSpec("RAE-CONFINE-FAIL");
      // Defense-in-depth: toRelativePath rejects traversal paths before they reach resolveConfinedOutputPath.
      expect(() => toRelativePath("../../../etc/shadow")).toThrow("invalid relative path");
    });
  });

  describe("OpenCode adapter failures", () => {
    it("returns schema_validation_error for null JSON payload", async () => {
      traceSpec("FLA-VALIDATE-SAMPLE");
      const { runProcess } = await import("../../src/adapters/process.js");
      vi.mocked(runProcess).mockResolvedValue({
        exitCode: 0,
        signal: null,
        stdout: "null",
        stderr: "",
        timedOut: false,
      });

      const result = await callOpencode({
        model: "test-model",
        phase: "qualitative-review",
        prompt: "test",
        retries: 1,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("schema_validation_error");
      expect(result.error.phase).toBe("qualitative-review");
      expect(result.error.message).toContain("object");
    });

    it("returns invalid_json for empty stdout", async () => {
      const { runProcess } = await import("../../src/adapters/process.js");
      vi.mocked(runProcess).mockResolvedValue({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
      });

      const result = await callOpencode({
        model: "test-model",
        phase: "formalization",
        prompt: "formalize this",
        retries: 1,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("invalid_json");
      expect(result.error.phase).toBe("formalization");
    });

    it("returns schema_validation_error when findings is not an array", async () => {
      traceSpec("FLA-VALIDATE-SAMPLE");
      const { runProcess } = await import("../../src/adapters/process.js");
      vi.mocked(runProcess).mockResolvedValue({
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({ findings: "should-be-array" }),
        stderr: "",
        timedOut: false,
      });

      const result = await callOpencode({
        model: "test-model",
        phase: "code-derived-formalization",
        prompt: "test",
        retries: 1,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("schema_validation_error");
      expect(result.error.phase).toBe("code-derived-formalization");
      expect(result.error.message).toContain("findings");
    });

    it("exhausts retries on repeated spawn failures then returns spawn_error", async () => {
      traceSpec("FLA-FORMAL-FAIL");
      const { runProcess } = await import("../../src/adapters/process.js");
      vi.mocked(runProcess).mockRejectedValue(new Error("connection refused"));

      const result = await callOpencode({
        model: "test-model",
        phase: "qualitative-properties",
        prompt: "test",
        retries: 3,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("spawn_error");
      expect(result.error.message).toContain("connection refused");
      expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(3);
    });
  });
});
