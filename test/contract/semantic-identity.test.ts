import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { semanticRuntimeIdentity } from "../../src/adapters/semantic-identity.js";
import { traceSpec } from "../support/spec-trace.js";

describe("source coordinator runtime identity", () => {
  it("changing only source-backed routing changes runtime identity", async () => {
    traceSpec("RAE-EVIDENCE-IDENTITY");
    const root = await mkdtemp("/tmp/opencode/coordinator-identity-"); const cli = join(root, "cli"); await mkdir(cli);
    const entry = join(cli, "run-cli.js"); await writeFile(entry, "unchanged entry point");
    const routing = join(cli, "pipeline-helpers.js"); await writeFile(routing, "old routing");
    const before = await semanticRuntimeIdentity(pathToFileURL(entry).href);
    await writeFile(routing, "generated-only shared-executor routing");
    const after = await semanticRuntimeIdentity(pathToFileURL(entry).href);
    expect(after.hash).not.toBe(before.hash);
    expect(after.modules).toContain("cli/pipeline-helpers");
  });
});
