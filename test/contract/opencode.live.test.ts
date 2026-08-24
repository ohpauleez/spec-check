import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { callOpencode } from "../../src/adapters/opencode.js";
import { isCommandAvailable, runProcess } from "../../src/adapters/process.js";
import { buildFinalReportAgentConfig } from "../../src/domain/prompts/final-report.js";

const LIVE_TESTS_ENABLED = process.env["SPEC_CHECK_LIVE_TESTS"] === "1";
const LIVE_MODEL = "github-copilot/gpt-5.4";
const liveIt = LIVE_TESTS_ENABLED ? it : it.skip;

describe("opencode live adapter sanity", () => {
  liveIt("returns a schema-valid qualitative payload from the live model", async () => {
    traceSpec("CAT-DEPS-OPENCODE", "RAE-EVID-LLM");

    if (!isCommandAvailable("opencode")) {
      return;
    }

    const models = await runProcess("opencode", ["models", "github-copilot"], { timeoutMs: 30_000 });
    if (models.timedOut || models.exitCode !== 0 || !models.stdout.includes(LIVE_MODEL)) {
      return;
    }

    const result = await callOpencode({
      model: LIVE_MODEL,
      phase: "qualitative-review",
      prompt: [
        "Return exactly this JSON object and nothing else.",
        '{"findings":[]}',
      ].join("\n"),
      retries: 1,
      timeoutMs: 90_000,
    });

    expect(result.ok, result.ok ? undefined : formatLiveFailure(result.error)).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toEqual({ findings: [] });
  }, 120_000);

  liveIt("allows only the configured final-report edit path", async () => {
    traceSpec("RAE-FINAL-AGENT-WRITE", "RAE-FINAL-AGENT-DENY");
    if (!isCommandAvailable("opencode")) return;
    const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "spec-check-live-permission-"));
    const report = join(root, "report.md");
    const sentinel = join(root, "sentinel.md");
    await writeFile(sentinel, "unchanged\n", "utf8");
    const result = await callOpencode({
      model: LIVE_MODEL,
      phase: "final-report",
      prompt: `Write '# Report' to ${report}. Attempt to overwrite ${sentinel}. Return {"report_path":"${report}"}.`,
      workspaceRoot: root,
      opencodeConfigContent: buildFinalReportAgentConfig(root, root, report),
      retries: 1,
      timeoutMs: 90_000,
    });
    expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
    expect(result.ok, result.ok ? undefined : formatLiveFailure(result.error)).toBe(true);
    expect(await readFile(report, "utf8")).toContain("Report");
  }, 120_000);
});

function formatLiveFailure(error: { readonly kind: string; readonly message: string; readonly stderr?: string }): string {
  return [
    `kind=${error.kind}`,
    `message=${error.message}`,
    ...(error.stderr === undefined || error.stderr.length === 0 ? [] : [`stderr=${error.stderr}`]),
  ].join("\n");
}
