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
}

interface ConfigFileShape {
  readonly inputs?: readonly string[];
  readonly output?: string;
  readonly src?: string;
  readonly caps?: string;
  readonly z3?: string;
  readonly model?: string;
  readonly pairBudget?: number;
}

/**
 * Discriminated union of configuration resolution errors.
 *
 * @remarks
 * Invariant: the `kind` discriminant is exhaustive — consumers must handle all five variants.
 * Invariant: file-related variants carry the offending `path` for diagnostic output.
 *
 * Variants:
 * - `config_read_error` — the config file at `path` could not be read (missing, permission denied, etc.).
 * - `config_parse_error` — the config file at `path` is not valid JSON.
 * - `config_validation_error` — the config file at `path` parsed as JSON but failed shape validation;
 *   `message` describes the structural expectation that was violated.
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

  return ok({
    inputs: mergedInputs,
    output: toOutputDirPath(rawOutput),
    src: resolvedSrc,
    caps: args.caps ?? fromFile.value.caps,
    z3: args.z3 ?? fromFile.value.z3,
    model: toModelName(args.model ?? fromFile.value.model ?? DEFAULT_MODEL),
    pairBudget: parsePairBudget(args.pairBudget, fromFile.value.pairBudget),
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
      message: "expected object with optional string fields and optional string[] inputs",
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
  );
}

/**
 * Parse the pair budget from CLI string or config file number, applying defaults.
 *
 * @param cliValue - string from CLI `--pair-budget` flag (e.g., "200"), or undefined if not provided
 * @param configValue - numeric value from config file's `pairBudget` field, or undefined if absent
 * @returns resolved pair budget as a positive integer; falls back to {@link DEFAULT_PAIR_BUDGET}
 *   when both inputs are undefined or invalid
 *
 * @remarks
 * Precondition: none — handles all edge cases (undefined, NaN, non-positive, non-finite).
 * Postcondition: returned value is always a positive finite integer.
 *
 * Priority: CLI value wins over config file value; both win over the default.
 * Invalid CLI values (NaN, zero, negative) silently fall back to the default rather
 * than propagating an error (matching the "lenient CLI, strict config" philosophy).
 *
 * Failure modes: none — pure computation, cannot throw.
 */
function parsePairBudget(cliValue: string | undefined, configValue: number | undefined): number {
  if (cliValue !== undefined) {
    const parsed = Number.parseInt(cliValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PAIR_BUDGET;
  }
  if (configValue !== undefined && Number.isFinite(configValue) && configValue > 0) {
    return configValue;
  }
  return DEFAULT_PAIR_BUDGET;
}
