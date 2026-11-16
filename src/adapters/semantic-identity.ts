/** Runtime code identity for evidence replay across unchanged numeric versions. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

/** Fingerprint active source/compiled modules; bundled execution hashes the bundle. */
export async function semanticRuntimeIdentity(baseUrl: string): Promise<{ readonly hash: string; readonly modules: readonly string[] }> {
  const names = ["parser/spec", "parser/ears", "parser/source", "parser/surface-block", "claim-graph", "logic-ir", "formal/analysis-config", "formal/concepts", "formal/concept-discovery", "formal/evidence", "formal/immutable", "formal/expression-types", "formal/expressions", "formal/expression-parser", "formal/expression-render", "formal/rational", "formal/fragment", "formal/signature", "formal/grouping", "formal/predicate-lowering", "formal/source-formalize", "formal/dependencies", "formal/query-executor", "formal/solver-verdict", "formal/model-values", "formal/static-analysis", "formal/typed-smtlib", "formal/typed-clustering", "code-backwards/alignment", "code-backwards/semantic-comparison"];
  const hash = createHash("sha256");
  const modules: string[] = [];
  hash.update(await readFile(new URL(baseUrl)));
  for (const name of [...names, "formal/static-context", "formal/interpretation-assessment", "formal/selected-clustering", "code-backwards/comparison-qualification", "code-backwards/derive", "code-backwards/gen-formal", "code-backwards/gen-logic"]) {
    for (const extension of ["js", "ts"]) {
      try {
        const content = await readFile(new URL(`../domain/${name}.${extension}`, baseUrl));
        hash.update(name).update(content); modules.push(name); break;
      } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  for (const extension of ["js", "ts"]) {
    try { const content = await readFile(new URL(`../cli/pipeline-helpers.${extension}`, baseUrl)); hash.update("cli/pipeline-helpers").update(content); modules.push("cli/pipeline-helpers"); break; }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const name of ["source-generation", "predicate-formalization"]) {
    for (const extension of ["js", "ts"]) {
      try { const content = await readFile(new URL(`../adapters/${name}.${extension}`, baseUrl)); hash.update(name).update(content); modules.push(`adapters/${name}`); break; }
      catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  if (modules.length === 0) { hash.update(await readFile(new URL(baseUrl))); modules.push("active-bundle"); }
  return Object.freeze({ hash: hash.digest("hex"), modules: Object.freeze(modules) });
}
