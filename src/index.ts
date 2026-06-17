import { parseArgv } from "./cli/parse-argv.js";
import { resolveRunConfig } from "./cli/config.js";
import { runCli, PipelineAbortError } from "./cli/run-cli.js";
import {
  EXIT_CODE_FINDINGS,
  EXIT_CODE_SUCCESS,
  exitCodeForError,
  formatError,
  makeTypedError,
  type SpecCheckError,
} from "./domain/errors.js";
import { SPEC_CHECK_VERSION } from "./version.js";

/**
 * CLI entrypoint.
 *
 * @remarks
 * Orchestrates argument parsing, config resolution, pipeline execution,
 * and exit code determination. Maps all failure paths into structured
 * `SpecCheckError` values before rendering to stderr.
 *
 * Postcondition: process exit code is set to 0 (success), 1 (findings),
 * or 2-11 (category-specific error).
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
 * Postcondition: error message has been written to stderr.
 */
function failWithError(error: SpecCheckError): number {
  process.stderr.write(`${formatError(error)}\n`);
  return exitCodeForError(error);
}

/**
 * Convert an argument parse error into a structured SpecCheckError.
 *
 * @param error - raw parse error from `parseArgv`
 * @returns structured ArgumentError with human-readable message
 *
 * @remarks
 * Precondition: `error` has a `kind` field from the ArgError union.
 * Postcondition: returned error has category `"ArgumentError"`.
 */
function parseArgParseError(error: { readonly kind: string; readonly flag?: string }): SpecCheckError {
  switch (error.kind) {
    case "unknown_flag":
      return makeTypedError("ArgumentError", `unrecognized flag: ${error.flag ?? "<unknown>"}`);
    case "missing_flag_value":
      return makeTypedError("ArgumentError", `missing value for flag: ${error.flag ?? "<unknown>"}`);
    default:
      return makeTypedError("ArgumentError", "invalid arguments");
  }
}

/**
 * Convert a config error into a structured SpecCheckError.
 *
 * @param error - raw config error from `resolveRunConfig`
 * @returns structured ConfigError with human-readable message
 *
 * @remarks
 * Precondition: `error` has a `kind` field from the ConfigError union.
 * Postcondition: returned error has category `"ConfigError"`.
 */
function parseConfigError(error: { readonly kind: string; readonly path?: string; readonly message?: string }): SpecCheckError {
  switch (error.kind) {
    case "missing_inputs":
      return makeTypedError("ConfigError", "missing required input paths");
    case "config_read_error":
      return makeTypedError("ConfigError", `config file is unreadable: ${error.path ?? "<unknown>"}`);
    case "config_parse_error":
      return makeTypedError("ConfigError", `config file is invalid JSON: ${error.path ?? "<unknown>"}`);
    case "config_validation_error":
      return makeTypedError(
        "ConfigError",
        `config file failed validation: ${error.path ?? "<unknown>"}${error.message === undefined ? "" : ` (${error.message})`}`,
      );
    default:
      return makeTypedError("ConfigError", "invalid configuration");
  }
}

/**
 * Print CLI usage information to stdout.
 *
 * @remarks
 * Postcondition: help text is written to stdout without trailing extra newline.
 */
function printHelp(): void {
  process.stdout.write(
    [
      `spec-check v${SPEC_CHECK_VERSION}`,
      "",
      "Usage:",
      "  spec-check <input...> [--output <dir>] [--src <dir>] [--caps <path>] [--z3 <path>] [--config <path>]",
      "  spec-check --help",
      "  spec-check --version",
      "",
      "Options:",
      "  --output <dir>   Output directory for reports and evidence",
      "  --src <dir>      Source directory for traceability mode",
      "  --caps <path>    Optional capability selection file",
      "  --z3 <path>      Path to z3 binary",
      "  --config <path>  Path to JSON config file",
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
