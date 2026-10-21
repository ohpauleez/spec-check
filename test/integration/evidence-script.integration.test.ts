import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const evidenceScript = join(repositoryRoot, "scripts/evidence.sh");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runEvidence(markdown: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const directory = await mkdtemp(join(tmpdir(), "spec-check-evidence-"));
  temporaryDirectories.push(directory);
  const specFile = join(directory, "spec.md");
  await writeFile(specFile, markdown, "utf8");
  return execFileAsync("bash", [evidenceScript, specFile], { cwd: repositoryRoot });
}

describe("evidence script link validation", () => {
  it("accepts exact implementation and test targets, including brackets and multiple links", async () => {
    const result = await runEvidence(`#### Scenario: Valid links
##### Evidence
- Implementation: [evidence-target.ts:3 exactImplementation()](/test/fixtures/evidence/evidence-target.ts#L3)
- Test: [evidence-target.ts:7 handles [A-Z] descriptions](/test/fixtures/evidence/evidence-target.ts#L7), [evidence-target.ts:8 runs through integration](/test/fixtures/evidence/evidence-target.ts#L8)
`);

    expect(result.stdout).toContain("Evidence checks passed");
    expect(result.stderr).toBe("Evidence link warnings: 0\n");
  });

  it("warns without failing for stale metadata and target content", async () => {
    const result = await runEvidence(`#### Scenario: Stale links
##### Evidence
- Implementation: [wrong.ts:4 exactImplementation()](/test/fixtures/evidence/evidence-target.ts#L3)
- Test (integration): [evidence-target.ts:7 stale test title](/test/fixtures/evidence/evidence-target.ts#L7)
`);

    expect(result.stdout).toContain("Evidence checks passed");
    expect(result.stderr).toContain("Type: Implementation");
    expect(result.stderr).toContain("Expected: filename evidence-target.ts");
    expect(result.stderr).toContain("Expected: line 3");
    expect(result.stderr).toContain("Type: Test (integration)");
    expect(result.stderr).toContain("Expected: stale test title");
    expect(result.stderr).toContain("Evidence link warnings: 3");
  });

  it("warns for missing files and lines while structurally checking prose implementation labels", async () => {
    const result = await runEvidence(`#### Scenario: Missing targets
##### Evidence
- Implementation: [evidence-target.ts:4 implementation return statement](/test/fixtures/evidence/evidence-target.ts#L4)
- Test (property): [missing.test.ts:1 missing test](/test/fixtures/evidence/missing.test.ts#L1)
- Test: [evidence-target.ts:99 absent line](/test/fixtures/evidence/evidence-target.ts#L99)
`);

    expect(result.stdout).toContain("Evidence checks passed");
    expect(result.stderr).toContain("Actual: file not found");
    expect(result.stderr).toContain("Actual: line not found");
    expect(result.stderr).toContain("Evidence link warnings: 2");
  });
});
