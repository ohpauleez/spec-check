import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { parseTaskDocument } from "../../src/domain/parser/task.js";

describe("task parser contracts", () => {
  it("extracts task groups with headings", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-check-task-"));
    const file = join(root, "tasks.md");
    await writeFile(file, "## 1. Setup\n\n- [x] 1.1 Do thing A\n- [ ] 1.2 Do thing B\n", "utf8");
    const parsed = await parseTaskDocument(file);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.title).toContain("Setup");
    expect(parsed.groups[0]?.tasks).toHaveLength(2);
    expect(parsed.groups[0]?.tasks[0]?.done).toBe(true);
    expect(parsed.groups[0]?.tasks[1]?.done).toBe(false);
  });

  it("extracts change summaries from h3 sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-check-task-"));
    const file = join(root, "tasks.md");
    const content = [
      "## 1. Setup",
      "",
      "- [x] 1.1 Do thing",
      "",
      "### Setup change summary",
      "- What changed: added files",
      "",
    ].join("\n");
    await writeFile(file, content, "utf8");
    const parsed = await parseTaskDocument(file);
    expect(parsed.changeSummaries.size).toBe(1);
  });

  it("handles empty task document", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-check-task-"));
    const file = join(root, "tasks.md");
    await writeFile(file, "", "utf8");
    const parsed = await parseTaskDocument(file);
    expect(parsed.groups).toHaveLength(0);
  });
});
