/**
 * Resolves a fully-typed run configuration from CLI arguments and an optional
 * on-disk config file, applying defaults and validation.
 *
 * Acts as the bridge between raw CLI parsing and the pipeline's typed config.
 * Exports: `resolveRunConfig`, `RunConfig`, `ConfigError`.
 */
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

import { toModelName, toOutputDirPath, type ModelName, type OutputDirPath } from "../domain/branded.js";
import { err, ok, type Result } from "../domain/result.js";
import { DEFAULT_TIMEOUT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS } from "../domain/timeout.js";
import type { CliArgs } from "./parse-argv.js";

/**
 * Fully resolved run configuration with all required fields populated.
 *
 * @remarks
 * Invariant: `inputs` is non-empty (at least one input path).
 * Invariant: `output` is a branded `OutputDirPath` for filesystem confinement.
 * Invariant: `model` is a branded `ModelName` identifying the LLM to use.
 * Optional fields (`src`, `caps`, `z3`) are undefined when not provided via CLI or config.
 */
export interface RunConfig {
  readonly inputs: readonly string[];
  readonly output: OutputDirPath;
  readonly src: string | undefined;
  readonly caps: string | undefined;
  readonly z3: string | undefined;
  readonly model: ModelName;
  readonly pairBudget: number;
  readonly timeoutMs: number;
  readonly allowArchive: boolean;
}

interface ConfigFileShape {
  readonly inputs?: readonly string[];
  readonly output?: string;
  readonly src?: string;
  readonly caps?: string;
  readonly z3?: string;
  readonly model?: string;
  readonly pairBudget?: number;
  readonly timeoutMs?: number;
  readonly allowArchive?: boolean;
}

/**
 * Internal alias for timeout parsing results. Uses the project-wide `Result`
 * type rather than a bespoke one-off discriminated union.
 *
 * - Ok branch: validated timeout in milliseconds (safe integer in range).
 * - Err branch: human-readable diagnostic message describing the constraint violation.
 */
type TimeoutParseResult = Result<number, string>;

/**
 * Discriminated union of configuration resolution errors.
 *
 * @remarks
 * Invariant: the `kind` discriminant is exhaustive — consumers must handle all seven variants.
 * Invariant: file-related variants carry the offending `path` for diagnostic output.
 *
 * Variants:
 * - `config_read_error` — the config file at `path` could not be read (missing, permission denied, etc.).
 * - `config_parse_error` — the config file at `path` is not valid JSON.
 * - `config_validation_error` — the config file at `path` parsed as JSON but failed shape validation;
 *   `message` describes the structural expectation that was violated.
 * - `timeout_validation_error` — the resolved timeout value (from CLI `--timeout-ms` or config file
 *   `timeoutMs`) failed range or type validation; `message` includes the source and constraint.
 * - `pair_budget_validation_error` — the resolved pair budget value (from CLI `--pair-budget` or config
 *   file `pairBudget`) failed validation; `message` includes the source and constraint.
 * - `missing_inputs` — neither CLI positional arguments nor the config file supplied any input paths.
 * - `output_inside_src` — the resolved output directory is equal to or nested inside the source
 *   directory, violating the [CAT-CLI-OUTSRC] confinement rule.
 *
 * @example
 * ```ts
 * const result = await resolveRunConfig(args);
 * if (!result.ok) {
 *   switch (result.error.kind) {
 *     case "config_read_error":
 *       console.error(`Cannot read config: ${result.error.path}`);
 *       break;
 *     case "timeout_validation_error":
 *       console.error(`Invalid timeout: ${result.error.message}`);
 *       break;
 *     case "pair_budget_validation_error":
 *       console.error(`Invalid pair budget: ${result.error.message}`);
 *       break;
 *     case "missing_inputs":
 *       console.error("No input paths provided");
 *       break;
 *     // ... handle remaining variants
 *   }
 * }
 * ```
 */
export type ConfigError =
  | { readonly kind: "config_read_error"; readonly path: string }
  | { readonly kind: "config_parse_error"; readonly path: string }
  | { readonly kind: "config_validation_error"; readonly path: string; readonly message: string }
  | { readonly kind: "timeout_validation_error"; readonly message: string }
  | { readonly kind: "pair_budget_validation_error"; readonly message: string }
  | { readonly kind: "missing_inputs" }
  | { readonly kind: "output_inside_src" };

/** Default pair budget for bounded pairwise cross-implication. */
const DEFAULT_PAIR_BUDGET = 200;

/** Default LLM model used when no --model flag or config is provided. */
const DEFAULT_MODEL = "github-copilot/gpt-5.4";

/**
 * Resolve a complete {@link RunConfig} by merging CLI flags, an optional JSON
 * config file, and built-in defaults.
 *
 * @param args - A validated {@link CliArgs} object produced by `parseArgv`.
 *   If `args.config` is defined it must be a readable filesystem path to a
 *   JSON file conforming to {@link ConfigFileShape}.
 *
 * @returns On success, an `Ok<RunConfig>` satisfying:
 *   - `inputs` is non-empty (at least one input path).
 *   - `output` is a branded {@link OutputDirPath} resolved from CLI, config
 *     file, or the default `"spec-check-output"`.
 *   - `model` is a branded {@link ModelName}.
 *   - `pairBudget` is a positive integer.
 *   - `output` is **not** equal to or nested inside `src` (the
 *     [CAT-CLI-OUTSRC] confinement rule).
 *
 *   On failure, an `Err<ConfigError>` where:
 *   - `{ kind: "config_read_error", path }` — the file at `args.config`
 *     could not be read (missing, permission denied, etc.).
 *   - `{ kind: "config_parse_error", path }` — the config file is not valid
 *     JSON.
 *   - `{ kind: "config_validation_error", path, message }` — the config file
 *     parsed as JSON but failed shape validation.
 *   - `{ kind: "missing_inputs" }` — neither CLI positional arguments nor the
 *     config file supplied any input paths.
 *   - `{ kind: "output_inside_src" }` — the resolved output directory is
 *     equal to or nested inside the source directory.
 *
 * @remarks
 * Precondition: `args` was produced by a successful `parseArgv` call (i.e.,
 * structural invariants of {@link CliArgs} hold).
 *
 * Postcondition — merge priority (highest wins):
 *   1. CLI flags (`args.*`)
 *   2. Config file values (`args.config` JSON contents)
 *   3. Built-in defaults (`"spec-check-output"`, `"github-copilot/gpt-5.4"`,
 *      pair budget of 200)
 *
 * For every field in the returned {@link RunConfig}, the value is taken from
 * the highest-priority source that supplied a defined value. Lower-priority
 * sources are never consulted once a higher-priority source provides a value.
 *
 * Invariant: this function performs filesystem I/O only when `args.config` is
 * defined. It never writes to the filesystem.
 *
 * @throws This function does not throw. All error conditions are represented
 * in the returned `Result`.
 *
 * @example
 * ```ts
 * import { parseArgv } from "./parse-argv.js";
 * import { resolveRunConfig } from "./config.js";
 *
 * const argv = parseArgv(["specs/", "--output", "out/", "--model", "gpt-4"]);
 * if (!argv.ok) throw new Error("bad args");
 *
 * const config = await resolveRunConfig(argv.value);
 * if (config.ok) {
 *   console.log(config.value.inputs);     // ["specs/"]
 *   console.log(config.value.output);     // "out/" (branded OutputDirPath)
 *   console.log(config.value.model);      // "gpt-4" (branded ModelName)
 *   console.log(config.value.pairBudget); // 200 (default)
 * }
 * ```
 */
export async function resolveRunConfig(args: CliArgs): Promise<Result<RunConfig, ConfigError>> {
  const fromFile: Result<ConfigFileShape, ConfigError> = args.config === undefined ? ok({}) : await loadConfigFile(args.config);
  if (!fromFile.ok) {
    return fromFile;
  }

  const mergedInputs = args.inputs.length > 0 ? args.inputs : fromFile.value.inputs ?? [];
  if (mergedInputs.length === 0) {
    return err({ kind: "missing_inputs" });
  }

  const rawOutput = args.output ?? fromFile.value.output ?? "spec-check-output";
  const resolvedSrc = args.src ?? fromFile.value.src;

  // [CAT-CLI-OUTSRC] Reject output directory inside source directory.
  if (resolvedSrc !== undefined) {
    const resolvedOutputAbs = resolve(rawOutput);
    const resolvedSrcAbs = resolve(resolvedSrc);
    const rel = relative(resolvedSrcAbs, resolvedOutputAbs);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) {
      return err({ kind: "output_inside_src" });
    }
  }

  const timeoutMsResult = parseTimeoutMs(args.timeoutMs, fromFile.value.timeoutMs);
  if (!timeoutMsResult.ok) {
    return err({ kind: "timeout_validation_error", message: timeoutMsResult.error });
  }

  const pairBudgetResult = parsePairBudget(args.pairBudget, fromFile.value.pairBudget);
  if (!pairBudgetResult.ok) {
    return pairBudgetResult;
  }

  return ok({
    inputs: mergedInputs,
    output: toOutputDirPath(rawOutput),
    src: resolvedSrc,
    caps: args.caps ?? fromFile.value.caps,
    z3: args.z3 ?? fromFile.value.z3,
    model: toModelName(args.model ?? fromFile.value.model ?? DEFAULT_MODEL),
    pairBudget: pairBudgetResult.value,
    timeoutMs: timeoutMsResult.value,
    // allowArchive is additive: either CLI --allow-archive presence OR config file
    // allowArchive: true activates admission. This differs from other flags where CLI
    // overrides config — for a boolean opt-in, both sources contribute.
    allowArchive: args.allowArchive || fromFile.value.allowArchive === true,
  });
}

/**
 * Read, parse, and validate a JSON config file from disk.
 *
 * @param path - absolute or relative filesystem path to the JSON config file
 * @returns on success, a validated {@link ConfigFileShape}; on failure, a `ConfigError`
 *   describing why the file could not be loaded or validated
 *
 * @remarks
 * Precondition: `path` is a non-empty string (caller ensures this via CLI parsing).
 * Postcondition (Ok): the returned shape has been validated by `isConfigFileShape` —
 * all present fields have correct runtime types.
 * Postcondition (Err): the error carries the offending `path` for diagnostics.
 *
 * Failure modes (all represented in the returned Result, never thrown):
 * - `config_read_error` — file does not exist or is not readable.
 * - `config_parse_error` — file content is not valid JSON.
 * - `config_validation_error` — JSON parsed but does not conform to ConfigFileShape.
 *
 * Safety: performs filesystem I/O (read-only). Does not write to the filesystem.
 */
async function loadConfigFile(path: string): Promise<Result<ConfigFileShape, ConfigError>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return err({ kind: "config_read_error", path });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err({ kind: "config_parse_error", path });
  }

  if (!isConfigFileShape(parsed)) {
    return err({
      kind: "config_validation_error",
      path,
      message: "expected object with optional string fields, optional string[] inputs, optional numeric timeoutMs, and optional boolean allowArchive",
    });
  }

  return ok(parsed);
}

/**
 * Type-narrowing guard that validates an unknown parsed JSON value conforms to {@link ConfigFileShape}.
 *
 * @param value - an untrusted value (typically the result of `JSON.parse`) to validate
 * @returns `true` if `value` satisfies the {@link ConfigFileShape} contract, narrowing the type
 *   for the caller; `false` otherwise
 *
 * @remarks
 * Precondition: `value` is the direct output of `JSON.parse` (i.e., a JSON-representable value).
 * Postcondition (when `true`): all present fields have correct runtime types — string fields are
 * strings, `inputs` (if present) is a `string[]`, and `pairBudget` (if present) is a number.
 * Invariant: this function is pure and performs no I/O or mutation.
 *
 * Failure modes: none — pure computation, cannot throw.
 *
 * @example
 * ```ts
 * const parsed: unknown = JSON.parse(raw);
 * if (isConfigFileShape(parsed)) {
 *   // parsed is now ConfigFileShape — safe to destructure
 *   const { inputs, model } = parsed;
 * }
 * ```
 */
function isConfigFileShape(value: unknown): value is ConfigFileShape {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    readonly inputs?: unknown;
    readonly output?: unknown;
    readonly src?: unknown;
    readonly caps?: unknown;
    readonly z3?: unknown;
    readonly model?: unknown;
    readonly pairBudget?: unknown;
    readonly timeoutMs?: unknown;
    readonly allowArchive?: unknown;
  };

  if (candidate.inputs !== undefined) {
    if (!Array.isArray(candidate.inputs)) {
      return false;
    }
    if (candidate.inputs.some((entry) => typeof entry !== "string")) {
      return false;
    }
  }

  return (
    (candidate.output === undefined || typeof candidate.output === "string")
    && (candidate.src === undefined || typeof candidate.src === "string")
    && (candidate.caps === undefined || typeof candidate.caps === "string")
    && (candidate.z3 === undefined || typeof candidate.z3 === "string")
    && (candidate.model === undefined || typeof candidate.model === "string")
    && (candidate.pairBudget === undefined || typeof candidate.pairBudget === "number")
    && (candidate.timeoutMs === undefined || typeof candidate.timeoutMs === "number")
    && (candidate.allowArchive === undefined || typeof candidate.allowArchive === "boolean")
  );
}

/**
 * Parse and validate the timeout value from CLI string or config file number.
 *
 * @param cliValue - string from CLI `--timeout-ms` flag, or `undefined` if not provided
 * @param configValue - numeric value from config file's `timeoutMs` field, or `undefined` if absent
 * @returns validated timeout in milliseconds on success; diagnostic message on failure
 *
 * @remarks
 * Precondition: `cliValue`, when defined, is a raw user-supplied string (may be non-numeric).
 * Postcondition (Ok): returned value is a safe integer within [TIMEOUT_MIN_MS, TIMEOUT_MAX_MS].
 * Priority: CLI value wins over config file value; both win over DEFAULT_TIMEOUT_MS.
 *
 * Failure modes (represented in the discriminated result, never thrown):
 * - Non-numeric CLI string → `{ ok: false, message: "--timeout-ms must be a base-10 integer" }`
 * - Out-of-range value → `{ ok: false, message: "<source> must be in range [...]" }`
 */
function parseTimeoutMs(cliValue: string | undefined, configValue: number | undefined): TimeoutParseResult {
  if (cliValue !== undefined) {
    if (!/^\d+$/u.test(cliValue)) {
      return err("--timeout-ms must be a base-10 integer");
    }
    const parsed = Number(cliValue);
    return validateTimeoutMs(parsed, "--timeout-ms");
  }

  if (configValue !== undefined) {
    return validateTimeoutMs(configValue, "config timeoutMs");
  }

  return ok(DEFAULT_TIMEOUT_MS);
}

/**
 * Validate that a numeric timeout value is a safe integer within the allowed range.
 *
 * @param value - numeric timeout in milliseconds to validate
 * @param source - human-readable label identifying where the value originated (for diagnostics)
 * @returns validated timeout on success; diagnostic message on failure
 *
 * @remarks
 * Precondition: `value` is a finite number (may be non-integer or out of range).
 * Postcondition (Ok): returned value satisfies `Number.isSafeInteger(value)` and
 *   `TIMEOUT_MIN_MS <= value <= TIMEOUT_MAX_MS`.
 *
 * Failure modes (represented in the discriminated result, never thrown):
 * - Non-safe-integer → `"<source> must be a safe integer"`
 * - Out of range → `"<source> must be in range [30000, 900000]"`
 */
function validateTimeoutMs(value: number, source: string): TimeoutParseResult {
  if (!Number.isSafeInteger(value)) {
    return err(`${source} must be a safe integer`);
  }
  if (value < TIMEOUT_MIN_MS || value > TIMEOUT_MAX_MS) {
    return err(`${source} must be in range [${String(TIMEOUT_MIN_MS)}, ${String(TIMEOUT_MAX_MS)}]`);
  }
  return ok(value);
}

/**
 * Parse and validate the pair budget from CLI string or config file number.
 *
 * @param cliValue - string from CLI `--pair-budget` flag (e.g., "200"), or undefined if not provided
 * @param configValue - numeric value from config file's `pairBudget` field, or undefined if absent
 * @returns on success, a positive integer pair budget; on failure, a `ConfigError` describing
 *   why the value was rejected
 *
 * @remarks
 * Precondition: none — handles all edge cases (undefined, NaN, non-positive, non-finite).
 * Postcondition (Ok): returned value is a positive finite integer.
 * Priority: CLI value wins over config file value; both win over DEFAULT_PAIR_BUDGET.
 *
 * Failure modes (represented in the returned Result, never thrown):
 * - Non-numeric CLI string → `{ kind: "pair_budget_validation_error", message: "..." }`
 * - Zero or negative value → `{ kind: "pair_budget_validation_error", message: "..." }`
 * - Non-integer value → `{ kind: "pair_budget_validation_error", message: "..." }`
 */
function parsePairBudget(cliValue: string | undefined, configValue: number | undefined): Result<number, ConfigError> {
  if (cliValue !== undefined) {
    const parsed = Number.parseInt(cliValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return err({ kind: "pair_budget_validation_error", message: "--pair-budget must be a positive integer" });
    }
    return ok(parsed);
  }
  if (configValue !== undefined) {
    if (!Number.isFinite(configValue) || configValue <= 0 || !Number.isSafeInteger(configValue)) {
      return err({ kind: "pair_budget_validation_error", message: "config pairBudget must be a positive safe integer" });
    }
    return ok(configValue);
  }
  return ok(DEFAULT_PAIR_BUDGET);
}
