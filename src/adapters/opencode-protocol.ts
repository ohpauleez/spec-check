/** Deterministic OpenCode v1/v2 wire encoding. No subprocess or config discovery.
 * @example buildOpencodeArgs(options, runtime, selection);
 */
import type { OpencodeCallOptions } from "./opencode.js";
import type { OpencodeRuntime } from "./opencode-runtime.js";
import type { OpencodeModelSelection } from "../domain/opencode-model.js";
import { precondition } from "../domain/assert.js";
import { buildFinalReportAgentPolicy, type FinalReportAgentPolicy } from "../domain/prompts/final-report.js";

/** Encode a validated call without changing prompt or attachment identities.
 * @param options - Validated request; report calls require an absolute workspace.
 * @param runtime - Immutable protocol identity resolved before retries.
 * @param selection - Normalized semantic base model and optional variant.
 * @returns Fresh argv; pure, bounded by the supplied file list, and shell-free.
 * @example buildOpencodeArgs(options, { binaryPath: "opencode", version: "2.0.15", major: 2 }, selection);
 */
export function buildOpencodeArgs(options: OpencodeCallOptions, runtime: OpencodeRuntime, selection: OpencodeModelSelection): string[] {
  const report = options.phase === "final-report";
  const args = ["run"];
  if (report) args.push(runtime.major === 1 ? "--pure" : "--standalone");
  const model = runtime.major === 2 && selection.variant !== undefined
    ? `${selection.model}#${selection.variant}` : selection.model;
  args.push(options.prompt, "--model", model, "--format", "json");
  if (runtime.major === 1 && selection.variant !== undefined) args.push("--variant", selection.variant);
  for (const file of options.files ?? []) args.push("--file", file);
  if (report) {
    precondition(options.workspaceRoot !== undefined, "validated report call requires workspace");
    args.push("--agent", "spec-check-final-report");
    if (runtime.major === 1) args.push("--dir", options.workspaceRoot);
  }
  return args;
}

/** Build per-child overrides while retaining credentials in inherited data/env.
 * @param options - Call controls; generated report config contains no secrets.
 * @param runtime - Resolved protocol family.
 * @returns Fresh environment overrides; never mutates process.env.
 * @remarks Native v2 project exclusion must override inherited values and the
 * legacy alias. It excludes server sources, not terminal-only plugin settings.
 * @example buildOpencodeEnvironment(options, runtime);
 */
export function buildOpencodeEnvironment(options: OpencodeCallOptions, runtime: OpencodeRuntime): NodeJS.ProcessEnv {
  return {
    ...(options.opencodeConfigContent === undefined ? {} : { OPENCODE_CONFIG_CONTENT: options.opencodeConfigContent }),
    ...(options.opencodeConfigDir === undefined ? {} : {
      OPENCODE_CONFIG_DIR: options.opencodeConfigDir, XDG_CONFIG_HOME: options.opencodeConfigDir,
    }),
    ...(options.opencodeConfigPath === undefined ? {} : { OPENCODE_CONFIG: options.opencodeConfigPath }),
    ...(runtime.major === 2 && options.phase === "final-report" ? {
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      // V2's run target prefers PWD to process.cwd(); both must name the
      // isolated root, rather than inheriting the analyzed repository's PWD.
      PWD: options.workspaceRoot,
    } : {}),
  };
}

/** Serialize semantic report authority using a release's native config shape.
 * @param policy - Validated, deny-first report authority.
 * @param major - Supported protocol family.
 * @returns Credential-free JSON; preserves ordered rule semantics.
 * @remarks V1 aliases shell/subagent as bash/task. No generic config migration
 * or ambient-file merging is performed here.
 * @example serializeFinalReportPolicy(policy, 2);
 */
export function serializeFinalReportPolicy(policy: FinalReportAgentPolicy, major: 1 | 2): string {
  const metadata = { description: policy.description, mode: "primary" };
  if (major === 2) {
    return JSON.stringify({
      $schema: "https://opencode.ai/config.json", formatter: false, mcp: { servers: {} },
      agents: { [policy.name]: { ...metadata, system: policy.system, permissions: policy.rules } },
    });
  }
  const permission: Record<string, string | Record<string, string>> = {};
  for (const rule of policy.rules) {
    const action = rule.action === "shell" ? "bash" : rule.action === "subagent" ? "task" : rule.action;
    if (rule.resource === "*" && action !== "read" && action !== "external_directory") {
      permission[action] = rule.effect;
    } else {
      const existing = permission[action];
      const resources = typeof existing === "object" ? existing : {};
      resources[rule.resource] = rule.effect;
      permission[action] = resources;
    }
  }
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json", formatter: false, lsp: false, mcp: {},
    agent: { [policy.name]: { ...metadata, prompt: policy.system, permission } },
  });
}

/** Compatibility builder for callers needing a serialized report policy.
 * @param workspaceRoot - Absolute isolated execution root.
 * @param evidenceDir - Absolute evidence directory.
 * @param reportPath - Exact designated publication path.
 * @param additionalReadPaths - Additional approved absolute read boundaries.
 * @param major - Native encoding, defaulting to the historical v1 API.
 * @returns Credential-free JSON; invalid paths throw assertion errors.
 * @example buildFinalReportAgentConfig("/private", "/evidence", "/evidence/report.md", [], 2);
 */
export function buildFinalReportAgentConfig(
  workspaceRoot: string, evidenceDir: string, reportPath: string,
  additionalReadPaths: readonly string[] = [], major: 1 | 2 = 1,
): string {
  return serializeFinalReportPolicy(buildFinalReportAgentPolicy(workspaceRoot, evidenceDir, reportPath, additionalReadPaths), major);
}
