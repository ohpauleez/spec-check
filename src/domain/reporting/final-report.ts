/** Post-completion final-report generation, validation, cleanup, and lifecycle. */
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { callOpencode, type OpencodeError } from "../../adapters/opencode.js";
import { removeOutputTree, resolveConfinedOutputPath } from "../../adapters/fs.js";
import { assertNever, postcondition, precondition } from "../assert.js";
import { toRelativePath, type ModelName, type OutputDirPath, type RelativePath } from "../branded.js";
import {
  buildFinalReportAgentConfig,
  buildFinalReportPrompt,
  isPermissionLiteralPath,
} from "../prompts/final-report.js";
import { err, ok, type Result } from "../result.js";

/** Stable unmanifested final-report path. */
export const FINAL_REPORT_PATH: RelativePath = toRelativePath("report.md");
/** Maximum accepted report size in bytes. */
export const FINAL_REPORT_MAX_BYTES = 1_048_576;

/** Closed expected failure domain for one final-report attempt. */
export type FinalReportErrorKind =
  | "agent_failed"
  | "acknowledgment_invalid"
  | "path_unsupported"
  | "path_mismatch"
  | "report_missing"
  | "report_symlink"
  | "report_not_regular"
  | "report_empty"
  | "report_too_large"
  | "report_unreadable";

/** Expected final-report failure represented as data. */
export interface FinalReportError {
  readonly kind: FinalReportErrorKind;
  readonly message: string;
}

/** Validated report returned after the agent process has terminated. */
export interface FinalReportFile {
  readonly path: RelativePath;
  readonly content: string;
}

/** Dependencies isolated for deterministic and fault-injection tests. */
export interface FinalReportDependencies {
  readonly invoke: typeof callOpencode;
  readonly inspect: typeof lstat;
  readonly read: typeof readFile;
}

const productionDependencies: FinalReportDependencies = {
  invoke: callOpencode,
  inspect: lstat,
  read: readFile,
};

/** Lifecycle states mirrored by the Alloy model. */
export type FinalReportLifecycleStage =
  | "preparing"
  | "core_reporting"
  | "core_complete"
  | "generating"
  | "validating"
  | "cleaning"
  | "cleaned"
  | "marker_invalidated"
  | "summary_rewritten"
  | "manifest_refreshing"
  | "report_available"
  | "warning_persisted"
  | "output_failed";

/** Complete executable state corresponding to mutable Alloy relations. */
export interface FinalReportLifecycleState {
  readonly stage: FinalReportLifecycleStage;
  readonly coreComplete: boolean;
  readonly reportPresent: boolean;
  readonly reportValid: boolean;
  readonly warningPresent: boolean;
  readonly summaryCurrent: boolean;
  readonly manifestCurrent: boolean;
  readonly reportManifested: boolean;
}

/** Initial lifecycle state shared by production-independent verification. */
export const INITIAL_FINAL_REPORT_LIFECYCLE: FinalReportLifecycleState = Object.freeze({
  stage: "preparing",
  coreComplete: false,
  reportPresent: false,
  reportValid: false,
  warningPresent: false,
  summaryCurrent: false,
  manifestCurrent: false,
  reportManifested: false,
});

/** Events accepted by the pure lifecycle reference model. */
export type FinalReportLifecycleEvent =
  | "begin_core_reporting"
  | "complete_core"
  | "start_report"
  | "generation_returns"
  | "generation_fails"
  | "validation_succeeds"
  | "validation_fails"
  | "cleanup_succeeds"
  | "marker_invalidation_succeeds"
  | "summary_rewrite_succeeds"
  | "begin_manifest_refresh"
  | "manifest_refresh_succeeds"
  | "output_fails"
  | "stutter";

/** Terminal outcomes observable at the orchestration boundary. */
/** Actual terminal facts compared with the executable lifecycle model. */
export interface FinalReportTerminalObservation {
  readonly reportPresent: boolean;
  readonly warningPresent: boolean;
  readonly summaryCurrent: boolean;
  readonly manifestCurrent: boolean;
  readonly reportManifested: boolean;
}

/**
 * Apply one guarded final-report lifecycle event.
 *
 * @param state - current explicit lifecycle state
 * @param event - requested transition
 * @returns next state, or `err` when the event is illegal from `state`
 *
 * @remarks
 * Postcondition: terminal states accept only stuttering. The function is pure,
 * total over both closed unions, and mirrors `alloy/final-report.als`.
 */
export function reduceFinalReportLifecycle(
  state: FinalReportLifecycleState,
  event: FinalReportLifecycleEvent,
): Result<FinalReportLifecycleState, "invalid_transition"> {
  if (event === "stutter") {
    return ok(state);
  }
  if (event === "output_fails") {
    return state.stage === "cleaning" || state.stage === "cleaned"
      || state.stage === "marker_invalidated" || state.stage === "summary_rewritten"
      || state.stage === "manifest_refreshing"
      ? ok({ ...state, stage: "output_failed" })
      : err("invalid_transition");
  }
  const expected: Readonly<Record<Exclude<FinalReportLifecycleEvent, "stutter" | "output_fails">, readonly [FinalReportLifecycleStage, FinalReportLifecycleStage]>> = {
    begin_core_reporting: ["preparing", "core_reporting"],
    complete_core: ["core_reporting", "core_complete"],
    start_report: ["core_complete", "generating"],
    generation_returns: ["generating", "validating"],
    generation_fails: ["generating", "cleaning"],
    validation_succeeds: ["validating", "report_available"],
    validation_fails: ["validating", "cleaning"],
    cleanup_succeeds: ["cleaning", "cleaned"],
    marker_invalidation_succeeds: ["cleaned", "marker_invalidated"],
    summary_rewrite_succeeds: ["marker_invalidated", "summary_rewritten"],
    begin_manifest_refresh: ["summary_rewritten", "manifest_refreshing"],
    manifest_refresh_succeeds: ["manifest_refreshing", "warning_persisted"],
  };
  const transition = expected[event];
  if (transition[0] !== state.stage) return err("invalid_transition");
  return ok(applyLifecycleEffects(state, event, transition[1]));
}

/** Apply mutable-relation effects after a transition guard succeeds. */
function applyLifecycleEffects(
  state: FinalReportLifecycleState,
  event: Exclude<FinalReportLifecycleEvent, "stutter" | "output_fails">,
  stage: FinalReportLifecycleStage,
): FinalReportLifecycleState {
  switch (event) {
    case "complete_core":
      return { ...state, stage, coreComplete: true, summaryCurrent: true, manifestCurrent: true };
    case "generation_returns":
      return { ...state, stage };
    case "generation_fails":
    case "validation_fails":
      return { ...state, stage, reportValid: false };
    case "validation_succeeds":
      return { ...state, stage, reportPresent: true, reportValid: true };
    case "cleanup_succeeds":
      return {
        ...state, stage, reportPresent: false, reportValid: false,
        warningPresent: true,
      };
    case "marker_invalidation_succeeds":
      return { ...state, stage, summaryCurrent: false, manifestCurrent: false };
    case "summary_rewrite_succeeds":
      return { ...state, stage, summaryCurrent: true };
    case "manifest_refresh_succeeds":
      return { ...state, stage, manifestCurrent: true };
    case "begin_core_reporting":
    case "start_report":
    case "begin_manifest_refresh":
      return { ...state, stage };
    default:
      return assertNever(event);
  }
}

/**
 * Compare orchestration-observable terminal facts with the executable model.
 *
 * @param modeled - terminal state produced by the reference transition kernel
 * @param observed - facts established by real filesystem/run-state operations
 * @throws {Error} when implementation and model disagree
 */
export function assertFinalReportTerminalCorrespondence(
  modeled: FinalReportLifecycleState,
  observed: FinalReportTerminalObservation,
): void {
  postcondition(modeled.reportPresent === observed.reportPresent, "report-presence model drift");
  postcondition(modeled.warningPresent === observed.warningPresent, "warning model drift");
  postcondition(modeled.summaryCurrent === observed.summaryCurrent, "summary model drift");
  postcondition(modeled.manifestCurrent === observed.manifestCurrent, "manifest model drift");
  postcondition(modeled.reportManifested === observed.reportManifested, "manifest-exclusion model drift");
}

/**
 * Generate and independently validate the optional final report.
 *
 * @param input - resolved model, timeout, output, and workspace values
 * @param dependencies - injectable OpenCode and filesystem boundaries
 * @returns a validated report or a stable expected failure
 *
 * @remarks
 * Preconditions: output and workspace paths are absolute; the core manifest
 * already exists; stale report cleanup already ran. Validation reads only the
 * precomputed confined destination, never the model-selected acknowledgment
 * path. Work is bounded by adapter retries/timeout and 1 MiB report size.
 */
export async function generateFinalReport(
  input: {
    readonly model: ModelName;
    readonly timeoutMs: number;
    readonly outputDir: OutputDirPath;
    readonly workspaceRoot: string;
    readonly additionalReadPaths?: readonly string[];
  },
  dependencies: FinalReportDependencies = productionDependencies,
): Promise<Result<FinalReportFile, FinalReportError>> {
  precondition(isAbsolute(input.outputDir), "final-report output directory must be absolute");
  precondition(isAbsolute(input.workspaceRoot), "final-report workspace root must be absolute");
  const reportPath = resolveConfinedOutputPath(input.outputDir, FINAL_REPORT_PATH);
  if (!isPermissionLiteralPath(input.workspaceRoot)
      || !isPermissionLiteralPath(input.outputDir)
      || !isPermissionLiteralPath(reportPath)) {
    return err({ kind: "path_unsupported", message: "final-report paths must not contain `*` or `?`" });
  }

  const prompt = buildFinalReportPrompt(input.outputDir, reportPath, input.workspaceRoot);
  const readPaths = input.additionalReadPaths ?? [];
  if (readPaths.some((path) => !isAbsolute(path) || !isPermissionLiteralPath(path))) {
    return err({ kind: "path_unsupported", message: "final-report read paths must be absolute and contain no `*` or `?`" });
  }
  let isolatedRoot: string;
  try {
    isolatedRoot = await mkdtemp(join(tmpdir(), "spec-check-final-report-"));
  } catch {
    return err({ kind: "agent_failed", message: "unable to create isolated final-report workspace" });
  }
  const configContent = buildFinalReportAgentConfig(
    isolatedRoot, input.outputDir, reportPath, [input.workspaceRoot, ...readPaths],
  );
  const configPath = join(isolatedRoot, "opencode.json");
  try {
    await writeFile(configPath, configContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    await cleanupIsolatedConfig(isolatedRoot);
    return err({ kind: "agent_failed", message: "unable to write isolated final-report configuration" });
  }
  let invoked: Awaited<ReturnType<typeof callOpencode>>;
  try {
    invoked = await dependencies.invoke({
      model: input.model,
      phase: "final-report",
      prompt,
      timeoutMs: input.timeoutMs,
      workspaceRoot: isolatedRoot,
      opencodeConfigContent: configContent,
      opencodeConfigDir: isolatedRoot,
      opencodeConfigPath: configPath,
    });
  } catch (error: unknown) {
    return err({
      kind: "agent_failed",
      message: error instanceof Error ? error.message : "final-report agent threw an unknown failure",
    });
  } finally {
    await cleanupIsolatedConfig(isolatedRoot);
  }
  if (!invoked.ok) {
    return err(agentError(invoked.error));
  }
  const acknowledgment = parseAcknowledgment(invoked.value);
  if (!acknowledgment.ok) {
    return acknowledgment;
  }
  if (acknowledgment.value.reportPath !== reportPath) {
    return err({ kind: "path_mismatch", message: "final-report acknowledgment path does not match the designated destination" });
  }
  return await validateFinalReport(reportPath, dependencies);
}

/** Best-effort deletion of transient policy/configuration state. */
async function cleanupIsolatedConfig(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // The directory contains no report evidence or credentials.
  }
}

/**
 * Validate one precomputed report destination without following symlinks.
 *
 * @param reportPath - trusted absolute confined destination
 * @param dependencies - injectable metadata and read boundaries
 * @returns validated UTF-8 content or a classified expected failure
 *
 * @remarks
 * Validation order is load-bearing: `lstat`, file type, metadata size, bounded
 * byte read, strict UTF-8 decode, then non-whitespace content. The post-read
 * byte check protects against growth between metadata and read under the
 * documented single-writer assumption.
 */
export async function validateFinalReport(
  reportPath: string,
  dependencies: Pick<FinalReportDependencies, "inspect" | "read"> = productionDependencies,
): Promise<Result<FinalReportFile, FinalReportError>> {
  precondition(isAbsolute(reportPath), "validated final-report path must be absolute");
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await dependencies.inspect(reportPath);
  } catch (error: unknown) {
    return err(metadataError(error));
  }
  if (metadata.isSymbolicLink()) {
    return err({ kind: "report_symlink", message: "final report must not be a symbolic link" });
  }
  if (!metadata.isFile()) {
    return err({ kind: "report_not_regular", message: "final report must be a regular file" });
  }
  if (metadata.size > FINAL_REPORT_MAX_BYTES) {
    return err({ kind: "report_too_large", message: `final report exceeds ${String(FINAL_REPORT_MAX_BYTES)} bytes` });
  }

  let bytes: Buffer;
  try {
    const raw = await dependencies.read(reportPath);
    bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  } catch {
    return err({ kind: "report_unreadable", message: "final report is unreadable" });
  }
  if (bytes.byteLength > FINAL_REPORT_MAX_BYTES) {
    return err({ kind: "report_too_large", message: `final report exceeds ${String(FINAL_REPORT_MAX_BYTES)} bytes` });
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return err({ kind: "report_unreadable", message: "final report is not valid UTF-8" });
  }
  if (content.trim().length === 0) {
    return err({ kind: "report_empty", message: "final report contains no non-whitespace content" });
  }
  postcondition(Buffer.byteLength(content, "utf8") <= FINAL_REPORT_MAX_BYTES, "validated report exceeds byte bound");
  return ok({ path: FINAL_REPORT_PATH, content });
}

/**
 * Remove stale or invalid report output, including directories and symlinks.
 *
 * @param outputDir - absolute configured output root
 * @returns after the report destination is absent; missing output is accepted
 * @throws {Error} when absence cannot be established due to filesystem failure
 */
export async function removeFinalReport(outputDir: OutputDirPath): Promise<void> {
  await removeOutputTree(outputDir, FINAL_REPORT_PATH);
}

/** Validate the schema-refined adapter acknowledgment without trusting its path. */
function parseAcknowledgment(value: unknown): Result<{ readonly reportPath: string }, FinalReportError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err({ kind: "acknowledgment_invalid", message: "final-report acknowledgment is not an object" });
  }
  const reportPath = Reflect.get(value, "report_path");
  if (typeof reportPath !== "string" || reportPath.trim().length === 0) {
    return err({ kind: "acknowledgment_invalid", message: "final-report acknowledgment has no report_path" });
  }
  return ok({ reportPath });
}

/** Map the adapter taxonomy into the stable final-report boundary. */
function agentError(error: OpencodeError): FinalReportError {
  return { kind: "agent_failed", message: `${error.kind}: ${error.message}` };
}

/** Distinguish an absent report from other metadata failures. */
function metadataError(error: unknown): FinalReportError {
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return { kind: "report_missing", message: "final report was not created" };
  }
  return { kind: "report_unreadable", message: "final report metadata is unreadable" };
}
