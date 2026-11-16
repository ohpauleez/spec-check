import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const MODULES = ["formal/static-analysis", "formal/static-context", "formal/source-formalize", "formal/query-executor", "formal/expressions",
  "formal/expression-parser", "formal/expression-render", "formal/immutable", "formal/model-values", "formal/predicate-lowering", "formal/signature",
  "parser/ears", "code-backwards/alignment", "code-backwards/semantic-comparison", "formal/interpretation-assessment", "formal/selected-clustering", "code-backwards/comparison-qualification"];

describe("touched formal modules stay within style size targets", () => {
  it.each(MODULES)("%s: cohesive functions stay within 70 physical code lines", async (module) => {
    const path = `src/domain/${module}.ts`;
    const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    expect(source.getLineAndCharacterOfPosition(source.end).line + 1, path).toBeLessThanOrEqual(500);
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const length = source.getLineAndCharacterOfPosition(node.end).line - start + 2;
        if (length > 70) violations.push(`${path}:${start}: ${length} lines`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(violations).toEqual([]);
  });
});
