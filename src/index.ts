/**
 * CLI entrypoint for spec-check. Orchestrates argument parsing, configuration
 * resolution, pipeline execution, and process exit code determination.
 *
 * Serves as the top-level script invoked by the user's shell.
 * Exports: nothing (side-effectful entrypoint).
 */
import { parseArgv, type ArgError } from "./cli/parse-argv.js";
import { resolveRunConfig, type ConfigError } from "./cli/config.js";
import { runCli, PipelineAbortError } from "./cli/run-cli.js";
import {
  EXIT_CODE_FINDINGS,
  EXIT_CODE_SUCCESS,
  exitCodeForError,
  formatError,
  makeTypedError,
  type SpecCheckError,
} from "./domain/errors.js";
import { assertNever } from "./domain/assert.js";
import { SPEC_CHECK_VERSION } from "./version.js";

/**
 * CLI entrypoint.
 *
 * @returns process exit code: 0 (success), 1 (findings detected), or 2-11 (category-specific error)
 *
 * @remarks
 * Orchestrates argument parsing, config resolution, pipeline execution,
 * and exit code determination. Maps all failure paths into structured
 * `SpecCheckError` values before rendering to stderr.
 *
 * Precondition: `process.argv` contains the raw CLI arguments.
 * Postcondition: process exit code is set to 0 (success), 1 (findings),
 * or 2-11 (category-specific error).
 *
 * Failure modes:
 * - Invalid CLI arguments → returns exit code for ArgumentError.
 * - Invalid or missing config → returns exit code for ConfigError.
 * - Pipeline execution failure → propagated as PipelineAbortError (caught in top-level `.catch`).
 * - Unexpected runtime error → caught by top-level `.catch`, rendered as PipelineError.
 */
async function main(): Promise<number> {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.ok) {
    return failWithError(parseArgParseError(parsed.error));
  }

  if (parsed.value.help) {
    printHelp();
    return EXIT_CODE_SUCCESS;
  }

  if (parsed.value.version) {
    process.stdout.write(`${SPEC_CHECK_VERSION}\n`);
    return EXIT_CODE_SUCCESS;
  }

  const config = await resolveRunConfig(parsed.value);
  if (!config.ok) {
    return failWithError(parseConfigError(config.error));
  }

  const state = await runCli(config.value);
  if (state.findings.length > 0) {
    return EXIT_CODE_FINDINGS;
  }

  return EXIT_CODE_SUCCESS;
}

/**
 * Render a structured error to stderr and return its exit code.
 *
 * @param error - structured error to render
 * @returns process exit code for this error category
 *
 * @remarks
 * Precondition: `error` is a well-formed `SpecCheckError`.
 * Postcondition: error message has been written to stderr; returned code is
 * the deterministic exit code for `error`'s category.
 *
 * Failure modes: none — pure computation over the error value followed by a
 * synchronous write to stderr. Cannot fail under normal process conditions.
 */
function failWithError(error: SpecCheckError): number {
  process.stderr.write(`${formatError(error)}\n`);
  return exitCodeForError(error);
}

/**
 * Convert an argument parse error into a structured SpecCheckError.
 *
 * @param error - typed parse error from `parseArgv`
 * @returns structured ArgumentError with human-readable message
 *
 * @remarks
 * Precondition: `error` is a member of the `ArgError` discriminated union.
 * Postcondition: returned error has category `"ArgumentError"`.
 * Exhaustiveness: all `ArgError` variants are handled; new variants produce compile error.
 *
 * Failure modes: none — pure computation over a discriminated union.
 */
function parseArgParseError(error: ArgError): SpecCheckError {
  switch (error.kind) {
    case "unknown_flag":
      return makeTypedError("ArgumentError", `unrecognized flag: ${error.flag}`);
    case "missing_flag_value":
      return makeTypedError("ArgumentError", `missing value for flag: ${error.flag}`);
    default:
      return assertNever(error);
  }
}

/**
 * Convert a config error into a structured SpecCheckError.
 *
 * @param error - typed config error from `resolveRunConfig`
 * @returns structured ConfigError with human-readable message
 *
 * @remarks
 * Precondition: `error` is a member of the `ConfigError` discriminated union.
 * Postcondition: returned error has category `"ConfigError"`.
 * Exhaustiveness: all `ConfigError` variants are handled; new variants produce compile error.
 *
 * Failure modes: none — pure computation over a discriminated union.
 */
function parseConfigError(error: ConfigError): SpecCheckError {
  switch (error.kind) {
    case "missing_inputs":
      return makeTypedError("ConfigError", "missing required input paths");
    case "output_inside_src":
      return makeTypedError("ConfigError", "output directory must not reside within the source directory");
    case "config_read_error":
      return makeTypedError("ConfigError", `config file is unreadable: ${error.path}`);
    case "config_parse_error":
      return makeTypedError("ConfigError", `config file is invalid JSON: ${error.path}`);
    case "config_validation_error":
      return makeTypedError(
        "ConfigError",
        `config file failed validation: ${error.path}${error.message.length > 0 ? ` (${error.message})` : ""}`,
      );
    case "timeout_validation_error":
      return makeTypedError("ConfigError", error.message);
    default:
      return assertNever(error);
  }
}

/**
 * Print CLI usage information to stdout.
 *
 * @remarks
 * Precondition: none.
 * Postcondition: help text is written to stdout without trailing extra newline.
 *
 * Failure modes: none — synchronous write to stdout. Cannot fail under normal
 * process conditions.
 */
function printHelp(): void {
  process.stdout.write(
    [
      `spec-check v${SPEC_CHECK_VERSION}`,
      "",
      "Usage:",
      "  spec-check <input...> [--output <dir>] [--src <dir>] [--model <name>] [--caps <path>] [--z3 <path>] [--config <path>] [--timeout-ms <ms>] [--allow-archive]",
      "  spec-check --help",
      "  spec-check --version",
      "",
      "Options:",
      "  --output <dir>   Output directory for reports and evidence",
      "  --src <dir>      Source directory for traceability mode",
      "  --model <name>   LLM model to use (e.g. github-copilot/gpt-5.4)",
      "  --caps <path>    Optional capability selection file",
      "  --z3 <path>      Path to z3 binary",
      "  --config <path>  Path to JSON config file",
      "  --timeout-ms <n> Universal timeout for external LLM calls (30000-900000)",
      "  --allow-archive  Admit explicitly provided archived inputs",
      "  --help, -h       Print help and exit",
      "  --version, -v    Print version and exit",
      "",
    ].join("\n"),
  );
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // PipelineAbortError carries a typed category for specific exit codes.
    if (error instanceof PipelineAbortError) {
      const specCheckError = makeTypedError(error.category, error.message);
      process.stderr.write(`${formatError(specCheckError)}\n`);
      process.exitCode = exitCodeForError(specCheckError);
      return;
    }
    // Generic fallback for unexpected errors.
    const specCheckError = makeTypedError(
      "PipelineError",
      error instanceof Error ? error.message : "unexpected failure",
      error instanceof Error && error.stack !== undefined ? [error.stack] : undefined,
    );
    process.stderr.write(`${formatError(specCheckError)}\n`);
    process.exitCode = exitCodeForError(specCheckError);
  });
