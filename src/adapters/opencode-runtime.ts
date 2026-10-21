/** Bounded OpenCode discovery and immutable, run-owned protocol identity.
 * @example
 * const detected = await detectOpencodeRuntime("opencode");
 * if (detected.ok) await runWithOpencodeRuntime(detected.value, operation);
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { runProcess } from "./process.js";
import { err, ok, type Result } from "../domain/result.js";

/** Independent dependency-probe timeout, in milliseconds. */
export const OPENCODE_VERSION_TIMEOUT_MS = 5_000;
/** Combined stdout/stderr capture bound, in bytes. */
export const OPENCODE_VERSION_MAX_BYTES = 16_384;

/** Trusted release identity; immutable after dependency resolution. */
export interface OpencodeRuntime {
  readonly binaryPath: string;
  readonly version: string;
  readonly major: 1 | 2;
}

/** Expected release-probe failure. Diagnostic text is bounded and inert. */
export interface OpencodeDetectionError {
  readonly kind: "spawn_error" | "timeout" | "output_limit" | "invalid_version" | "unsupported_major";
  readonly message: string;
}

/** Runtime selection can additionally reject a mismatched explicit binary. */
export type OpencodeResolutionError = OpencodeDetectionError | {
  readonly kind: "runtime_mismatch";
  readonly message: string;
};

const runtimeScope = new AsyncLocalStorage<OpencodeRuntime>();
const VERSION_LINE = /^(?:opencode )?v?((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u;

/** Bound untrusted diagnostic text without allowing terminal control sequences.
 * @param text - Untrusted process/error output.
 * @returns At most 300 inert characters; pure and non-mutating.
 */
function preview(text: string): string {
  return Array.from(text.slice(0, 300), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029
      ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }).join("").slice(0, 300);
}

/** Bound a displayed version while keeping the complete runtime identity intact.
 * @param version - Canonical version or untrusted version presentation.
 * @returns At most 300 inert characters; no I/O or mutation.
 * @example formatOpencodeVersion("2.0.15+build.7");
 */
export function formatOpencodeVersion(version: string): string {
  return preview(version);
}

/** Parse the complete supported version-line grammar.
 * @param stdout - Strict-UTF-8 decoded stdout; byte validity is checked by discovery.
 * @returns Canonical semantic version and supported major, or a closed error.
 * @remarks Pure; rejects banners, multiple lines, unsafe core integers, and
 * numeric prerelease identifiers with leading zeroes. Both suffixes may coexist.
 * @example parseOpencodeVersion("opencode v2.0.15-rc.1+build.7\n");
 */
export function parseOpencodeVersion(stdout: string): Result<Omit<OpencodeRuntime, "binaryPath">, OpencodeDetectionError> {
  const line = stdout.replaceAll("\r\n", "\n").trim();
  const match = line.includes("\n") ? null : VERSION_LINE.exec(line);
  if (match === null || ![match[2], match[3], match[4]].every((n) => Number.isSafeInteger(Number(n)))
      || (match[5] ?? "").split(".").some((id) => /^[0-9]+$/u.test(id) && id.length > 1 && id.startsWith("0"))) {
    return err({ kind: "invalid_version", message: `Invalid OpenCode version output: ${preview(stdout)}` });
  }
  const version = match[1] ?? "";
  const major = Number(match[2]);
  if (major !== 1 && major !== 2) {
    return err({ kind: "unsupported_major", message: `OpenCode v${preview(version)} is unsupported; supported major versions are 1 and 2` });
  }
  return ok(Object.freeze({ version, major }));
}

/** Probe one executable with fixed dependency limits and no model retry work.
 * @param binaryPath - Selected command string, defaulting to PATH's opencode.
 * @returns Frozen supported runtime or a structured, bounded failure.
 * @remarks Exactly one argv-only child. Never throws for expected spawn/exit,
 * signal, timeout, overflow, or encoding failures. Does not cache between runs.
 * @example await detectOpencodeRuntime("/opt/opencode/bin/opencode");
 */
export async function detectOpencodeRuntime(binaryPath = "opencode"): Promise<Result<OpencodeRuntime, OpencodeDetectionError>> {
  try {
    const result = await runProcess(binaryPath, ["--version"], {
      timeoutMs: OPENCODE_VERSION_TIMEOUT_MS,
      maxOutputBytes: OPENCODE_VERSION_MAX_BYTES,
    });
    if (result.timedOut) return err({ kind: "timeout", message: "OpenCode version probe timed out after 5000ms" });
    if (result.outputLimitExceeded === true) return err({ kind: "output_limit", message: "OpenCode version probe exceeded 16384 captured bytes" });
    if (result.exitCode !== 0 || result.signal !== null) {
      return err({ kind: "spawn_error", message: `OpenCode version probe failed: ${preview(result.stderr || String(result.signal ?? result.exitCode))}` });
    }
    if (result.stdoutInvalidUtf8 === true) return err({ kind: "invalid_version", message: "OpenCode version output is not valid UTF-8" });
    const parsed = parseOpencodeVersion(result.stdout);
    return parsed.ok ? ok(Object.freeze({ binaryPath, ...parsed.value })) : parsed;
  } catch (error: unknown) {
    return err({ kind: "spawn_error", message: `Cannot execute OpenCode: ${preview(error instanceof Error ? error.message : String(error))}` });
  }
}

/** Bind an immutable descriptor to asynchronous work owned by one run.
 * @param runtime - Successfully detected or explicitly injected descriptor.
 * @param operation - Work including retries and optional final reporting.
 * @returns Operation result; operation exceptions propagate without losing scope cleanup.
 * @remarks Nested/concurrent scopes are independent and restored on exit.
 * @example await runWithOpencodeRuntime(runtime, async () => await analyze());
 */
export async function runWithOpencodeRuntime<T>(runtime: OpencodeRuntime, operation: () => Promise<T>): Promise<T> {
  return await runtimeScope.run(Object.freeze({ ...runtime }), operation);
}

/** Resolve one call's explicit, scoped, or directly detected runtime.
 * @param options - Optional test/direct-call descriptor and selected command.
 * @returns Descriptor or a terminal resolution error; no retry/fallback is performed.
 * @remarks Explicit descriptors override ambient scope. Without a descriptor,
 * detection happens once per logical direct call. A mismatched command never probes.
 * @example await resolveOpencodeRuntime({ runtime, binaryPath: runtime.binaryPath });
 */
export async function resolveOpencodeRuntime(options: {
  readonly runtime?: OpencodeRuntime;
  readonly binaryPath?: string;
} = {}): Promise<Result<OpencodeRuntime, OpencodeResolutionError>> {
  const runtime = options.runtime ?? runtimeScope.getStore();
  if (runtime !== undefined) {
    if (options.binaryPath !== undefined && options.binaryPath !== runtime.binaryPath) {
      return err({ kind: "runtime_mismatch", message: "Selected OpenCode binary does not match its runtime descriptor" });
    }
    return ok(Object.freeze({ ...runtime }));
  }
  return await detectOpencodeRuntime(options.binaryPath);
}
