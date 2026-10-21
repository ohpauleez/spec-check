/** Inspect an owned, disposable server's effective agent policy without inference. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { OpencodeRuntime } from "../../src/adapters/opencode-runtime.js";
import { runProcess } from "../../src/adapters/process.js";

/** Normalized actual-server permission observation, independent of serializers. */
export interface ObservedPermission {
  readonly action: string;
  readonly resource: string;
  readonly effect: string;
}

/** Start only an owned private server, wait for real agent activation, and inspect it.
 * @param runtime - Explicitly selected installed binary/release.
 * @param root - Existing private fixture execution/config directory.
 * @param env - Credential-free config overrides; provider env remains inherited.
 * @returns Actual effective rules after a no-inference unavailable-model barrier.
 * @remarks The random local-server password is never placed in argv, config,
 * returned observations, or logs. Cleanup never targets a shared service.
 * @example await inspectEffectiveReportAgent(runtime, privateRoot, overrides);
 */
export async function inspectEffectiveReportAgent(
  runtime: OpencodeRuntime, root: string, env: Readonly<NodeJS.ProcessEnv>,
): Promise<readonly ObservedPermission[]> {
  const password = randomUUID();
  const envOverrides = { ...env, PWD: root, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password };
  const server = spawn(runtime.binaryPath, runtime.major === 2
    ? ["serve", "--stdio", "--port", "0"] : ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: root, env: { ...process.env, ...envOverrides }, shell: false,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: server.stdout });
  let observed: readonly ObservedPermission[] | undefined;
  let cleanupFailure: unknown;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned policy-observation server did not become ready")), 10_000);
      server.once("error", (error) => { clearTimeout(timer); reject(error); });
      server.once("exit", () => { clearTimeout(timer); reject(new Error("Owned server exited before readiness")); });
      lines.on("line", (line) => {
        let ready: string | undefined;
        if (runtime.major === 2) {
          try { ready = (JSON.parse(line) as { readonly url?: string }).url; } catch { /* Non-readiness output is not authority evidence. */ }
        } else ready = /http:\/\/127\.0\.0\.1:\d+/u.exec(line)?.[0];
        if (ready !== undefined) { clearTimeout(timer); resolve(ready); }
      });
    });
    const barrier = await runProcess(runtime.binaryPath, ["run", "fixture", runtime.major === 2 ? "--server" : "--attach", url,
      ...(runtime.major === 1 ? ["--dir", root] : []), "--agent", "spec-check-final-report", "--model", "spec-check-no-provider/model", "--format", "json"], {
      cwd: root, envOverrides, timeoutMs: 15_000, maxOutputBytes: 1_048_576,
    });
    if (barrier.timedOut || barrier.exitCode === 0 || (!/Model (?:unavailable|not found)/u.test(barrier.stdout)
        && !(runtime.major === 1 && barrier.stdout.includes('"type":"error"')))) throw new Error("No-inference agent-activation barrier failed");
    const query = new URLSearchParams(runtime.major === 2 ? { "location[directory]": root } : { directory: root });
    const response = await fetch(`${url}${runtime.major === 2 ? "/api/agent" : "/agent"}?${query}`, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Owned agent inventory failed with HTTP ${String(response.status)}`);
    const body: unknown = await response.json();
    const data = Array.isArray(body) ? body : (body as { readonly data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error("Invalid actual agent inventory");
    const agent = data.find((item: { readonly id?: string; readonly name?: string }) => (item.id ?? item.name) === "spec-check-final-report") as { readonly permissions?: readonly unknown[]; readonly permission?: readonly unknown[] } | undefined;
    if (agent === undefined) throw new Error("Restricted agent missing from actual inventory");
    observed = (agent.permissions ?? agent.permission ?? []).map(normalizeObservedPermission);
  } finally {
    lines.close();
    server.stdin.destroy();
    server.stdout.destroy();
    if (server.pid !== undefined) {
      try { if (process.platform === "win32") server.kill("SIGKILL"); else process.kill(-server.pid, "SIGKILL"); }
      catch (error: unknown) { if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ESRCH") cleanupFailure = error; }
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure instanceof Error ? cleanupFailure : new Error("Owned inventory server cleanup failed");
  if (observed === undefined) throw new Error("No actual permission inventory observed");
  return observed;
}

/** Normalize observed wire formats only; do not derive policy from generated input. */
function normalizeObservedPermission(value: unknown): ObservedPermission {
  const rule = value as { readonly permission?: string; readonly pattern?: string; readonly action?: string; readonly resource?: string; readonly effect?: string };
  const action = rule.permission ?? rule.action ?? "";
  return { action: action === "bash" ? "shell" : action === "task" ? "subagent" : action,
    resource: rule.pattern ?? rule.resource ?? "", effect: rule.effect ?? rule.action ?? "" };
}

/** Independent last-match oracle for actual built-in wildcard permission rules.
 * @param rules - Normalized rules returned by the owned server, in effective order.
 * @param action - Normalized capability, such as shell or external_directory.
 * @param resource - Canonical path/boundary or command under evaluation.
 * @returns Last matching effect or undefined; bounded by rules.length, no mutation.
 * @example observedEffect(rules, "edit", "/tmp/disposable/sentinel.txt");
 */
export function observedEffect(rules: readonly ObservedPermission[], action: string, resource: string): string | undefined {
  const matches = (pattern: string): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "u").test(resource);
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule !== undefined && (rule.action === "*" || rule.action === action) && matches(rule.resource)) return rule.effect;
  }
  return undefined;
}
