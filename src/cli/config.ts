import { readFile } from "node:fs/promises";

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
}

interface ConfigFileShape {
  readonly inputs?: readonly string[];
  readonly output?: string;
  readonly src?: string;
  readonly caps?: string;
  readonly z3?: string;
  readonly model?: string;
}

type ConfigError =
  | { readonly kind: "config_read_error"; readonly path: string }
  | { readonly kind: "config_parse_error"; readonly path: string }
  | { readonly kind: "config_validation_error"; readonly path: string; readonly message: string }
  | { readonly kind: "missing_inputs" };

/** Default LLM model used when no --model flag or config is provided. */
const DEFAULT_MODEL = "github-copilot/gpt-5.4";

/**
 * Load optional config and merge with CLI flags where CLI wins.
 *
 * @param args - parsed CLI args
 * @returns resolved run configuration or config/validation error
 *
 * @remarks
 * Precondition: `args` is a valid parsed CLI args object.
 * Postcondition: returned config has all required fields populated with
 * CLI values, config file values, or defaults (in that priority order).
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

  return ok({
    inputs: mergedInputs,
    output: toOutputDirPath(args.output ?? fromFile.value.output ?? "spec-check-output"),
    src: args.src ?? fromFile.value.src,
    caps: args.caps ?? fromFile.value.caps,
    z3: args.z3 ?? fromFile.value.z3,
    model: toModelName(args.model ?? fromFile.value.model ?? DEFAULT_MODEL),
  });
}

/**
 * Read and validate a JSON config file.
 *
 * @param path - config file path
 * @returns validated config shape or error
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
  );
}
