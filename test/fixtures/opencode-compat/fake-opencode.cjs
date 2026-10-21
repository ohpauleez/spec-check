#!/usr/bin/env node
// Deterministic external-process oracle; never calls a provider or edits inputs.
const fs = require("node:fs");
const args = process.argv.slice(2);
const major = Number(process.env.SPEC_CHECK_TEST_MAJOR || "2");
const log = (entry) => fs.appendFileSync(process.env.SPEC_CHECK_TEST_LOG, JSON.stringify(entry) + "\n");
if (args[0] === "--version") {
  log({ kind: "version", major });
  console.log(process.env.SPEC_CHECK_TEST_VERSION || (major === 1 ? "1.19.3" : `opencode v${major}.0.15`));
  process.exit(0);
}
const model = args[args.indexOf("--model") + 1];
const report = args.includes("--agent");
if (major === 2 && (args.includes("--variant") || args.includes("--dir") || args.includes("--pure"))) process.exit(71);
if (major === 1 && (model.includes("#") || args.includes("--standalone"))) process.exit(72);
const prompt = args[args[1]?.startsWith("--") ? 2 : 1];
const files = args.flatMap((arg, index) => arg === "--file" ? [args[index + 1]] : []);
let batch;
for (const file of files) {
  if (!file.endsWith("batch-context.json")) continue;
  batch = JSON.parse(fs.readFileSync(file, "utf8"));
}
log({ kind: "analysis", major, model, report, attachedBatch: batch !== undefined, cwd: process.cwd(), projectDisabled: process.env.OPENCODE_CONFIG_PROJECT_DISABLE });
const sample = (claimId) => ({ claimId, obligation: "mandatory", variables: [], functions: [], assertions: [{ id: "ASSERT-TRUE", expr: "(= true true)" }] });
let payload = { findings: [] };
if (report) {
  if (major === 1 && (!args.includes("--pure") || !args.includes("--dir"))) process.exit(73);
  if (major === 2 && (!args.includes("--standalone") || process.env.OPENCODE_CONFIG_PROJECT_DISABLE !== "1")) process.exit(74);
  const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));
  const agent = (major === 2 ? config.agents : config.agent)?.["spec-check-final-report"];
  if (!agent || (major === 2 && agent.permissions?.[0]?.effect !== "deny")) process.exit(75);
  const pathMatch = /"report_path":\s*("(?:\\.|[^"\\])*")/.exec(prompt);
  if (!pathMatch) process.exit(76);
  payload = {
    report_path: JSON.parse(pathMatch[1]),
    report_markdown: [
      "# Final spec-check Assessment", "## Executive Assessment", "## Prioritized Findings",
      "## Logical Analysis", "## Qualitative And Coverage Findings", "## Traceability And Code Alignment",
      "## Recurring Defect Patterns", "## Remediation Plan", "## Evidence And Count Reconciliation",
      "## Residual Uncertainty And Rerun Criteria", "Evidence: `spec-check-output/manifest.json`.", "",
    ].join("\n"),
  };
} else if (batch) {
  payload = { formalizations: batch.claims.map((claim) => ({ index: claim.index, sample: sample(claim.id) })) };
} else {
  const claim = /<claim id="([^"]+)"/.exec(prompt);
  if (claim) payload = { sample: sample(claim[1]) };
}
console.log(JSON.stringify({ type: "step_finish", part: { tokens: { total: 4, input: 1, output: 1, reasoning: 0, cache: { read: 1, write: 1 } }, cost: 0 } }));
console.log(JSON.stringify({ type: "text", part: { text: JSON.stringify(payload) } }));
