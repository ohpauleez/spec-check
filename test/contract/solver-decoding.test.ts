import { describe, expect, it } from "vitest";
import { ModelValueDecoder } from "../../src/domain/formal/model-values.js";
import { locateSolverVerdict } from "../../src/domain/formal/solver-verdict.js";
import { QueryExecutor } from "../../src/domain/formal/query-executor.js";
import { EvidenceRecorder } from "../../src/domain/formal/evidence.js";
import { ANALYSIS_LIMITS } from "../../src/domain/formal/analysis-config.js";
import type { ExpressionSignature } from "../../src/domain/formal/expression-types.js";
import { traceSpec } from "../support/spec-trace.js";

const signature: ExpressionSignature = { symbols: [{ name: "x", sort: "Bool" }, { name: "n", sort: "Int" }, { name: "r", sort: "Real" }, { name: "mode", sort: { enum: "Mode" } }],
  enums: [{ name: "Mode", constructors: ["Ready", "Off"] }], units: [] };

describe("strict single-query verdict and scalar values", () => {
  it.each(["\n", "\r\n"])("decodes exact requested assignments with %j lines and whitespace", (newline) => {
    traceSpec("RAE-QUERY-EXACT", "RAE-QUERY-AUX-FAIL");
    const stdout = ['(:version "4.8.12")', ' \tsat \t', '((vx true) (vn (- 9007199254740993)) (vr (- (/ 1.0 3.0))) (vmode kMode__Ready))', ""].join(newline);
    const decoded = new ModelValueDecoder().decodeResult(stdout, signature);
    expect(decoded).toEqual({ status: "complete", missing: [], assignments: { x: "true", n: "(- 9007199254740993)", r: "(- (/ 1.0 3.0))", mode: "kMode__Ready" } });
    expect(locateSolverVerdict(stdout)?.kind).toBe("sat");
  });

  it.each([
    "unsat\n((vx true))\n", "unknown\n((vx true))\n", "123((vx true))\n", '"sat"\n((vx true))\n',
    '(error "message\nsat\n")\n((vx true))\n', '; sat\n((vx true))\n', '(:version "sat")\n((vx true))\n',
    '(error "bad input")\nsat\n((vx true))\n',
    "sat\nsat\n((vx true))\n", "sat\n((vx true) (vx false))\n", "sat\n((vx 1))\n", "sat\n((vx true)) garbage\n",
    "sat\n((vn (/ 1 2)))\n", "sat\n((vr (/ 1 0)))\n", "sat\n((vmode Unknown))\n", "sat\n((vx true) (notRequested false))\n",
  ])("rejects misleading/malformed values: %s", (stdout) => {
    expect(new ModelValueDecoder().decodeResult(stdout, signature).status).toBe("unavailable");
  });

  it("distinguishes partial values and exact requested subsets", () => {
    const decoder = new ModelValueDecoder();
    expect(decoder.decodeResult("sat\n((vx false))\n", signature)).toEqual({ status: "partial", assignments: { x: "false" }, missing: ["n", "r", "mode"] });
    expect(decoder.decode("sat\n((vx false))\n", signature)).toBeUndefined();
    expect(decoder.decodeResult("sat\n((vx false))\n", signature, ["vx"]).status).toBe("complete");
    expect(decoder.decodeResult("sat\n((vx false))\n", signature, ["vx", "vx"]).status).toBe("unavailable");
    expect(decoder.decodeResult("sat\n()\n", signature).status).toBe("unavailable");
  });

  it.each([["vn", "n", "(- 0)"], ["vr", "r", "(- 0.0)"], ["vr", "r", "(/ 0 5)"], ["vr", "r", "(- (/ 0.0 5.0))"]])("retains exact supported zero representation %s = %s (%s)", (emitted, name, representation) => {
    traceSpec("FLA-TYPED-EXACT", "RAE-QUERY-EXACT");
    expect(new ModelValueDecoder().decodeResult(`sat\n((${emitted} ${representation}))\n`, signature, [emitted])).toEqual({ status: "complete", missing: [], assignments: { [name]: representation } });
  });

  it("preserves a SAT auxiliary outcome and raw CRLF bytes even when requested assignments are incomplete", async () => {
    const writes = new Map<string, string | Uint8Array>();
    const evidence = new EvidenceRecorder(ANALYSIS_LIMITS.evidenceBytes, async (path, content) => { writes.set(path, content); });
    const stdout = '(:version "4.8.12")\r\nsat\r\n((vx true))\r\n';
    const executor = new QueryExecutor(ANALYSIS_LIMITS, evidence, undefined, async () => ({ kind: "sat", stdout, stderr: "", exitCode: 0 }));
    const outcome = await executor.execute("values", "witness", signature, [], { values: ["vx", "vn"] });
    expect(outcome.result?.kind).toBe("sat");
    expect(outcome.decodedValues).toBeNull();
    expect(outcome.valueDecoding).toEqual({ status: "partial", assignments: { x: "true" }, missing: ["n"] });
    const output = JSON.parse(writes.get(outcome.outputPath!) as string);
    expect(output.result.stdout).toBe(stdout);
    expect(output.valueDecoding.status).toBe("partial");
  });
});
