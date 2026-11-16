import { mkdtemp, mkdir, writeFile, readdir, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/adapters/process.js";

describe("experiment live transport capture without paid provider calls", () => {
  it.each(["model-timeout", "outer-timeout"])("retains request and exact partial bytes during %s", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "spec-check-impact-capture-"));
    const fake = join(root, "provider.mjs");
    await writeFile(fake, `#!${process.execPath}\nprocess.stdout.write(Buffer.from([255,65,10])); setInterval(() => {}, 1000);\n`);
    await chmod(fake, 0o700);
    const transport = join(root, "capture"); await mkdir(transport);
    const attachment = join(root, "batch-context.json"); await writeFile(attachment, '{"registry":{"hash":"test"},"claims":[]}');
    const config = join(root, "config.json"); await writeFile(config, JSON.stringify({ mode: "live", opencode: fake, workspace: root, transport, modelTimeoutMs: mode === "model-timeout" ? 1000 : 10000 }));
    const result = await runProcess(process.execPath, ["experiments/smt-impact/provider.mjs", "run", "prompt", "--file", attachment], {
      timeoutMs: mode === "model-timeout" ? 5000 : 1500, maxOutputBytes: 8192, envOverrides: { SMT_IMPACT_RUN: config },
    });
    expect(result.timedOut).toBe(mode === "outer-timeout");
    const names = await readdir(transport);
    const receipt = JSON.parse(await readFile(join(transport, names.find((name) => name.endsWith(".request.json"))!), "utf8"));
    expect(receipt.phase).toBe("predicate"); expect(receipt.complete).toBe(false);
    expect(receipt.context.registry.hash).toBe("test");
    expect(await readFile(join(transport, names.find((name) => name.endsWith(".stdout"))!))).toEqual(Buffer.from([255, 65, 10]));
    if (mode === "outer-timeout") expect(receipt.elapsedMs).toBeNull();
    else { expect(receipt.status).not.toBe(0); expect(receipt.elapsedMs).toBeGreaterThanOrEqual(1000); }
  }, 10_000);
});
