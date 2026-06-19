/**
 * Parses raw process.argv strings into a typed `CliArgs` structure using a
 * hand-rolled flag parser (no external dependencies).
 *
 * First stage of the CLI pipeline, producing structured options for config resolution.
 * Exports: `parseArgv`, `CliArgs`, `ArgError`.
 */
import { err, ok, type Result } from "../domain/result.js";
import { assertNever } from "../domain/assert.js";

/**
 * Parsed CLI arguments representing user-provided options and positional inputs.
 *
 * @remarks
 * Invariant: `inputs` contains positional arguments (file/directory paths).
 * Invariant: optional flag fields are present only when explicitly provided by the user.
 * Invariant: `help` and `version` are always defined as boolean flags.
 */
export interface CliArgs {
  readonly inputs: readonly string[];
  readonly output?: string;
  readonly src?: string;
  readonly caps?: string;
  readonly z3?: string;
  readonly model?: string;
  readonly config?: string;
  readonly pairBudget?: string;
  readonly help: boolean;
  readonly version: boolean;
}

/**
 * Discriminated union of CLI argument parsing errors.
 *
 * @remarks
 * Invariant: every variant carries the offending `flag` string for diagnostic messages.
 * Invariant: the `kind` discriminant is exhaustive — consumers must handle all variants.
 *
 * Variants:
 * - `unknown_flag` — the user passed a flag not in the recognized {@link FlagKey} set.
 * - `missing_flag_value` — a recognized flag was provided without its required value argument
 *   (e.g., `--output` at end-of-argv or immediately followed by another flag).
 *
 * @example
 * ```ts
 * const result = parseArgv(["--bogus"]);
 * if (!result.ok && result.error.kind === "unknown_flag") {
 *   console.error(`Unrecognized flag: ${result.error.flag}`);
 * }
 * ```
 */
export type ArgError =
  | { readonly kind: "unknown_flag"; readonly flag: string }
  | { readonly kind: "missing_flag_value"; readonly flag: string };

/** Closed domain of recognized CLI flag keys. */
export type FlagKey = "--output" | "--src" | "--caps" | "--z3" | "--model" | "--config" | "--pair-budget";

const FLAG_KEYS: ReadonlySet<string> = new Set<FlagKey>(["--output", "--src", "--caps", "--z3", "--model", "--config", "--pair-budget"]);

/**
 * Narrow a validated flag string to the {@link FlagKey} union type.
 *
 * @param flag - a string that has already been validated against `FLAG_KEYS`
 * @returns the same string narrowed to the `FlagKey` type
 *
 * @remarks
 * Precondition: `flag` has already passed `FLAG_KEYS.has()` validation.
 * Postcondition: returned value is narrowed to `FlagKey`.
 *
 * Failure modes: none — pure type-level cast with no runtime validation.
 * If called with a string not in `FLAG_KEYS`, the type assertion is unsound
 * (caller responsibility to guard).
 */
function asFlagKey(flag: string): FlagKey {
  return flag as FlagKey;
}

/**
 * Parse a raw CLI argument vector into a strongly-typed {@link CliArgs} structure.
 *
 * Supports `--flag value`, `--flag=value`, and positional arguments. Boolean
 * flags (`--help`/`-h`, `--version`/`-v`) are consumed without a trailing value.
 *
 * @param argv - The argument vector to parse, typically `process.argv.slice(2)`.
 *   Must not include the Node executable or script path.
 *
 * @returns On success, an `Ok<CliArgs>` satisfying:
 *   - `inputs` contains only positional arguments — never flag-like strings
 *     (nothing starting with `-`).
 *   - Optional flag fields (`output`, `src`, `caps`, `z3`, `model`, `config`,
 *     `pairBudget`) are present in the object **only** when explicitly provided
 *     by the user; absent keys are omitted rather than set to `undefined`.
 *   - `help` and `version` are always defined booleans.
 *
 *   On failure, an `Err<ArgError>` where:
 *   - `{ kind: "unknown_flag", flag }` — `flag` is not in the recognized
 *     {@link FlagKey} set and is not `--help`/`-h`/`--version`/`-v`.
 *   - `{ kind: "missing_flag_value", flag }` — a recognized value-bearing flag
 *     appeared at the end of `argv` with no subsequent token to consume as its
 *     value.
 *
 * @remarks
 * Precondition: `argv` elements are individual shell-split tokens (no quoted
 * multi-word strings that haven't been split by the shell).
 *
 * Postcondition: every element in `inputs` satisfies
 * `!element.startsWith("-")`.
 *
 * Postcondition: optional fields are structurally absent (not `undefined`)
 * when the user did not supply the corresponding flag.
 *
 * Ordering: flags and positional arguments may appear in any order; the
 * `inputs` array preserves the relative order of positional tokens.
 *
 * Failure modes: none — this function does not throw. All error conditions
 * are represented in the returned `Result` (see `@returns` above).
 *
 * @example
 * ```ts
 * import { parseArgv } from "./parse-argv.js";
 *
 * const result = parseArgv(["src/", "--output", "out/", "--model", "gpt-4"]);
 * if (result.ok) {
 *   console.log(result.value.inputs);  // ["src/"]
 *   console.log(result.value.output);  // "out/"
 *   console.log(result.value.model);   // "gpt-4"
 *   console.log(result.value.help);    // false
 * }
 * ```
 */
export function parseArgv(argv: readonly string[]): Result<CliArgs, ArgError> {
  const inputs: string[] = [];
  let output: string | undefined;
  let src: string | undefined;
  let caps: string | undefined;
  let z3: string | undefined;
  let model: string | undefined;
  let config: string | undefined;
  let pairBudget: string | undefined;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("-")) {
      inputs.push(token);
      continue;
    }

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    if (token === "--version" || token === "-v") {
      version = true;
      continue;
    }

    // Support --flag=value syntax.
    const eqIndex = token.indexOf("=");
    if (eqIndex !== -1) {
      const flag = token.slice(0, eqIndex);
      const value = token.slice(eqIndex + 1);
      if (!FLAG_KEYS.has(flag)) {
        return err({ kind: "unknown_flag", flag });
      }
      const narrowedFlag = asFlagKey(flag);
      switch (narrowedFlag) {
        case "--output":
          output = value;
          break;
        case "--src":
          src = value;
          break;
        case "--caps":
          caps = value;
          break;
        case "--z3":
          z3 = value;
          break;
        case "--model":
          model = value;
          break;
        case "--config":
          config = value;
          break;
        case "--pair-budget":
          pairBudget = value;
          break;
        default:
          assertNever(narrowedFlag);
      }
      continue;
    }

    if (!FLAG_KEYS.has(token)) {
      return err({ kind: "unknown_flag", flag: token });
    }

    const value = argv[index + 1];
    if (value === undefined) {
      return err({ kind: "missing_flag_value", flag: token });
    }

    index += 1;
    const narrowedToken = asFlagKey(token);
    switch (narrowedToken) {
      case "--output":
        output = value;
        break;
      case "--src":
        src = value;
        break;
      case "--caps":
        caps = value;
        break;
      case "--z3":
        z3 = value;
        break;
      case "--model":
        model = value;
        break;
      case "--config":
        config = value;
        break;
      case "--pair-budget":
        pairBudget = value;
        break;
      default:
        assertNever(narrowedToken);
    }
  }

  return ok({
    inputs,
    help,
    version,
    ...(output === undefined ? {} : { output }),
    ...(src === undefined ? {} : { src }),
    ...(caps === undefined ? {} : { caps }),
    ...(z3 === undefined ? {} : { z3 }),
    ...(model === undefined ? {} : { model }),
    ...(config === undefined ? {} : { config }),
    ...(pairBudget === undefined ? {} : { pairBudget }),
  });
}
