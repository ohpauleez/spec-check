import { mkdtemp, mkdir, writeFile, readFile, chmod, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/adapters/process.js";
import { traceSpec } from "../support/spec-trace.js";

/** Observe real subprocess executions independently of the CLI's own evidence accounting. */
async function fixture(empty: boolean) {
  const root = await mkdtemp("/tmp/opencode/generated-only-cli-");
  const bin = join(root, "bin"); const src = join(root, "src"); const spec = join(root, "openspec/specs/surface");
  for (const path of [bin, src, spec]) await mkdir(path, { recursive: true });
  await writeFile(join(src, "engine.ts"), "export function respond() { return true; }\n");
  const input = join(spec, "spec.md"); await writeFile(input, "### Requirement: Retained prose [SOURCE-PROSE]\nUnsupported prose.\n");
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ analysis: { limits: { queryScripts: 1 }, generatedModels: { surface: { concepts: [
    { name: "Called", definition: "Called", role: "event", sort: "Bool" }, { name: "Responded", definition: "Responded", role: "output", sort: "Bool" },
  ] } } } }));
  await writeFile(join(bin, "opencode"), `#!${process.execPath}
import {readFileSync} from 'node:fs';
const a=process.argv.slice(2);if(a[0]==='--version'){console.log('opencode v2.0.15');process.exit(0);}
if(a.includes('--agent'))process.exit(65);
const i=a.indexOf('--file'),f=i<0?'':a[i+1];let p={findings:[]};
if(f.endsWith('.ts'))p={capabilities:${empty ? "[]" : "[{name:'surface',description:'Independent source response',requirements:[{id:'GEN-RESPONSE',text:'WHEN called, THE engine MAY respond.',evidence:['engine.ts']}]}]"}};
if(f.endsWith('batch-context.json')){const c=JSON.parse(readFileSync(f,'utf8'));p=c.registry?{formalizations:c.claims.map(x=>({index:x.index,registryHash:c.registry.hash,predicates:{trigger:'Called',response:'Responded'}}))}:{concepts:[],proposedAssumptions:[]};}
console.log(JSON.stringify({type:'text',part:{text:JSON.stringify(p)}}));
`);
  const observed = join(root, "queries.jsonl");
  await writeFile(observed, "");
  await writeFile(join(bin, "z3"), `#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2);const input=a.includes('-in')?readFileSync(0):undefined;
if(input)appendFileSync(${JSON.stringify(observed)},JSON.stringify({script:input.toString('utf8')})+'\\n');
const r=spawnSync('/usr/bin/z3',a,{input});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);
`);
  for (const name of ["opencode", "z3"]) await chmod(join(bin, name), 0o700);
  return { root, bin, src, input, config, observed };
}

describe("generated-only actual CLI execution", () => {
  it.each(["dist/spec-check.js", "dist/src/index.js"])("%s shares evidence and capability budget when all originals are excluded", async (entry) => {
    traceSpec("FLA-FORMAL-NO-ELIGIBLE", "FLA-BOUNDS-QUERIES", "RAE-QUERY-EXACT", "RAE-SCOPE-LEDGER", "STC-IMPLY-UNMATCHED-CAP");
    const f = await fixture(false); const output = join(f.root, "out");
    const result = await runProcess(process.execPath, [entry, "--model", "fixture", "--config", f.config, "--src", f.src, "--z3", join(f.bin, "z3"), "--output", output, f.input],
      { timeoutMs: 30_000, maxOutputBytes: 1_048_576, envOverrides: { PATH: `${f.bin}:${process.env.PATH ?? ""}` } });
    expect(result.timedOut).toBe(false); expect(result.exitCode, result.stderr).toBe(1);
    const names = await readdir(join(output, "semantic_evidence"));
    const ledger = JSON.parse(await readFile(join(output, "semantic_evidence", names.find((name) => name.endsWith(".ledger.json"))!), "utf8"));
    const observed = (await readFile(f.observed, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(observed).toHaveLength(1);
    expect(ledger.scopeCounts.executedQueries).toBe(observed.length);
    expect(ledger.scopeCounts.skippedQueries).toBeGreaterThan(0);
    const scripts = await Promise.all(names.filter((name) => name.endsWith(".input.smt2")).map(async (name) => await readFile(join(output, "semantic_evidence", name), "utf8")));
    expect(scripts).toEqual(observed.map((query: { script: string }) => query.script));
    expect(await readFile(join(output, "report_2.logic.md"), "utf8")).toContain("solver script count bound");
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    expect(manifest.files.some((file: { path: string }) => file.path.endsWith(".input.smt2"))).toBe(true);
  }, 40_000);

  it("empty independent generation executes no solver queries", async () => {
    traceSpec("FLA-FORMAL-NO-ELIGIBLE", "STC-IMPLY-UNMATCHED-CAP");
    const f = await fixture(true); const output = join(f.root, "out");
    const result = await runProcess(process.execPath, ["dist/spec-check.js", "--model", "fixture", "--config", f.config, "--src", f.src, "--z3", join(f.bin, "z3"), "--output", output, f.input],
      { timeoutMs: 30_000, maxOutputBytes: 1_048_576, envOverrides: { PATH: `${f.bin}:${process.env.PATH ?? ""}` } });
    expect(result.timedOut).toBe(false);
    expect(await readFile(f.observed, "utf8")).toBe("");
    const names = await readdir(join(output, "semantic_evidence"));
    const ledger = JSON.parse(await readFile(join(output, "semantic_evidence", names.find((name) => name.endsWith(".ledger.json"))!), "utf8"));
    expect(ledger.scopeCounts.executedQueries).toBe(0);
    expect(names.some((name) => name.endsWith(".request.json"))).toBe(true);
  }, 40_000);
});
