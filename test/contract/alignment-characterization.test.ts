import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ANALYSIS_LIMITS, DEFAULT_ANALYSIS } from "../../src/domain/formal/analysis-config.js";
import { EvidenceRecorder } from "../../src/domain/formal/evidence.js";
import { QueryExecutor } from "../../src/domain/formal/query-executor.js";
import { analyzeStaticGroup } from "../../src/domain/formal/static-analysis.js";
import { formalizeSourceClaims } from "../../src/domain/formal/source-formalize.js";
import { validateExpression } from "../../src/domain/formal/expressions.js";
import { buildClaimGraph } from "../../src/domain/claim-graph.js";
import { parseSpecText } from "../../src/domain/parser/spec.js";
import { toClaimId } from "../../src/domain/branded.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";
import type { ExpressionSignature, LogicExpression, StaticRule } from "../../src/domain/formal/expression-types.js";
import { traceSpec } from "../support/spec-trace.js";

/** Hash exact evidence/output bytes while retaining scripts, call order and ledger for review. */
const digest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const signature: ExpressionSignature = { symbols: ["g", "x"].map((name) => ({ name, sort: "Bool" })), enums: [], units: [] };

function expression(text: string): LogicExpression {
  const parsed = validateExpression(text, signature);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function rule(index: number, kind: StaticRule["kind"]): LogicIrClaim {
  return { claimId: toClaimId(`CHAR-${index}`), obligation: kind === "mandatory" ? "mandatory" : kind === "advisory" ? "advisory" : "informational", variables: [], functions: [], assertions: [], signature, background: [],
    staticRule: { source: { file: "source.md", ordinal: index }, claimId: `CHAR-${index}`, kind, guard: expression("g"), response: expression(index === 1 ? "(not x)" : "x"), interpretationDependent: index === 1 } };
}

/** Exercise orchestration, not solver fidelity: explicit query kinds select controlled replies. */
async function staticHistory(mode: string) {
  const writes: unknown[] = []; const scripts: { kind: string; script: string }[] = []; let current = "";
  const evidence = new EvidenceRecorder(mode === "capacity" ? 1024 : ANALYSIS_LIMITS.evidenceBytes, async (path, content) => {
    if (mode === "write-failure") throw new Error("injected persistence failure");
    writes.push({ path, hash: digest(typeof content === "string" ? content : Buffer.from(content).toString("base64")) });
  });
  const executor = new QueryExecutor({ ...ANALYSIS_LIMITS, queryScripts: mode === "script-limit" ? 4 : 1000 }, evidence, undefined, async (input) => {
    scripts.push({ kind: current, script: input.smtlib });
    const kind = mode === "background-unsat" && current === "background" ? "unsat"
      : mode === "baseline-unsat" && current === "global" ? "unsat"
        : mode === "unknown" && current.startsWith("guard:") ? "unknown"
          : mode === "timeout" && current.startsWith("activation:") ? "timeout"
            : mode === "conflicts" && /activation:|pair-conflict:|advisory-/u.test(current) ? "unsat"
              : current.endsWith(":core") ? "unsat" : "sat";
    return { kind, stdout: kind === "unsat" && input.smtlib.includes("get-unsat-core") ? "unsat\n(rule__0 rule__1)\n"
      : current.endsWith(":witness") ? "sat\n((vg false) (vx true))\n" : `${kind}\n`, stderr: "", exitCode: 0 };
  });
  const execute = executor.execute.bind(executor);
  executor.execute = async (group, kind, sig, predicates, options) => { current = kind; return await execute(group, kind, sig, predicates, options); };
  const claims = [rule(0, "mandatory"), rule(1, "mandatory"), rule(2, "advisory"), rule(3, "advisory"), rule(4, "permission")];
  claims[0] = { ...claims[0]!, coverage: [{ name: "family", applicability: expression("true"), sources: [{ file: "source.md", ordinal: 0 }], explicit: true }],
    staticScenario: { source: { file: "source.md", ordinal: 5 }, kind: "example", input: expression("g"), outcome: expression("x") } };
  let outcome: unknown;
  try { outcome = await analyzeStaticGroup("group", claims, executor, mode === "pair-limit" ? 0 : 20); }
  catch (error: unknown) { outcome = error instanceof Error ? { name: error.name, message: error.message } : { unexpected: String(error) }; }
  return { scripts, ledger: executor.ledger, writes, outcome };
}

/** Fixed provider histories preserve validation/persistence order and later candidate retention. */
async function formalHistory(mode: string) {
  const writes: unknown[] = []; const contexts: unknown[] = []; let calls = 0;
  const evidence = new EvidenceRecorder(mode === "capacity" ? 1 : ANALYSIS_LIMITS.evidenceBytes, async (path, content) => {
    if (mode === "write-failure" && path.endsWith(".accepted-ir.json")) throw new Error("injected persistence failure");
    writes.push({ path, hash: digest(typeof content === "string" ? content : Buffer.from(content).toString("base64")) });
  });
  const claims = buildClaimGraph({ specs: [parseSpecText("source.md", "### Requirement: First [CHAR-FIRST]\nWHEN called, THE engine SHALL respond.\n\n### Requirement: Second [CHAR-SECOND]\nTHE engine MAY respond.\n")] }).graph.claims;
  let outcome: unknown;
  try {
    outcome = await formalizeSourceClaims({ claims, model: "characterization", samplesPerClaim: mode === "shortfall" ? 2 : 1, timeoutMs: 1000, logicalFileByCapability: new Map(), maxBatchSize: 32, evidence,
      analysis: DEFAULT_ANALYSIS, discover: async (request) => { contexts.push({ discovery: request.context }); return { ok: true, value: { payload: { concepts: [] }, warnings: [] } }; },
      invoke: async (context) => {
        contexts.push({ predicates: context }); calls += 1;
        const data = JSON.parse(context) as { registry: { hash: string }; claims: { index: number; predicates: Record<string, string> }[] };
        return { cleanup: "succeeded", contextSha256: digest(context), result: mode === "shortfall" && calls > 1
          ? { ok: false, error: { kind: "timeout", phase: "formalization", message: "injected timeout" } }
          : { ok: true, value: { formalizations: data.claims.map((claim) => ({ index: claim.index, registryHash: data.registry.hash,
            predicates: Object.fromEntries(Object.keys(claim.predicates).map((slot) => [slot, mode === "invalid" || (mode === "recovery" && calls === 1) ? "undeclared" : "true"])) })) } } };
      },
    });
  } catch (error: unknown) { outcome = error instanceof Error ? { name: error.name, message: error.message } : { unexpected: String(error) }; }
  return { contexts, writes, calls, outputHash: digest(outcome) };
}

// The original sixteen byte snapshots remain in the change's verification-evidence/.
// Current snapshots intentionally add subject context and inert typed mapping comments.
describe("boundary-remediated orchestration characterization", () => {
  it.each(["success", "conflicts", "background-unsat", "baseline-unsat", "unknown", "timeout", "pair-limit", "script-limit", "capacity", "write-failure"])("static %s preserves protocol and exact evidence", async (mode) => {
    traceSpec("FLA-RULE-ACTIVATION", "FLA-PERSIST-ALL", "RAE-SCOPE-LEDGER");
    const history = await staticHistory(mode);
    expect({ protocolHash: digest(history), queries: history.scripts.map((query) => query.kind).join(", "), ledgerEntries: history.ledger.length, artifacts: history.writes.length }).toMatchSnapshot();
  });
  it.each(["success", "invalid", "recovery", "shortfall", "capacity", "write-failure"])("formalization %s preserves attribution, recovery and evidence", async (mode) => {
    traceSpec("FLA-FORMAL-PARTIAL", "RAE-FORMAL-ATTEMPT-SETS");
    const history = await formalHistory(mode);
    expect({ protocolHash: digest(history), calls: history.calls, outputHash: history.outputHash }).toMatchSnapshot();
  });
});
