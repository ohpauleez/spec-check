import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { toSmtlibContent } from "../../src/domain/branded.js";
import { runZ3Query } from "../../src/adapters/z3.js";
import { traceSpec } from "../support/spec-trace.js";

/** Hand-derived scripts are independent of production compilation/query planning. */
interface SemanticFixture {
  readonly name: string;
  readonly identifiers: readonly string[];
  readonly declarations: readonly string[];
  readonly queries: readonly { readonly name: string; readonly expr: string; readonly expected: "sat" | "unsat" }[];
}

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/ears-to-logic/static-query-cases.json", import.meta.url), "utf8")) as readonly SemanticFixture[];
const hasZ3 = spawnSync("z3", ["--version"], { timeout: 5_000, encoding: "utf8" }).status === 0;

describe.skipIf(!hasZ3)("hand-derived static semantics: real Z3 oracle", () => {
  it.each(fixtures)("$name", async (fixture) => {
    traceSpec("RAE-SEMANTIC-VERIFY", ...fixture.identifiers);
    for (const query of fixture.queries) {
      const script = [...fixture.declarations, `(assert ${query.expr})`, "(check-sat)", ""].join("\n");
      const result = await runZ3Query({ smtlib: toSmtlibContent(script), timeoutMs: 5_000 });
      expect(result.kind, `${fixture.name}: ${query.name}: ${result.stdout} ${result.stderr}`).toBe(query.expected);
    }
  });

  it("rejects a duplicated declaration despite a printed unsat verdict", async () => {
    traceSpec("FLA-SPEC-DEDUP", "FLA-LOGIC-ERROR");
    const script = "(declare-const x Bool)\n(assert x)\n(declare-const x Bool)\n(assert (not x))\n(check-sat)\n";
    const result = await runZ3Query({ smtlib: toSmtlibContent(script), timeoutMs: 5_000 });
    expect(result.kind).toBe("error");
    expect(result.stdout).toContain("unsat");
  });
});
