import { err, ok, type Result } from "../domain/result.js";

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
  readonly help: boolean;
  readonly version: boolean;
}

type ArgError =
  | { readonly kind: "unknown_flag"; readonly flag: string }
  | { readonly kind: "missing_flag_value"; readonly flag: string };

const FLAG_KEYS = new Set(["--output", "--src", "--caps", "--z3", "--model", "--config"]);

/**
 * Parse CLI argv into typed options.
 *
 * @param argv - `process.argv.slice(2)` style args
 * @returns typed CLI args or parse error
 */
export function parseArgv(argv: readonly string[]): Result<CliArgs, ArgError> {
  const inputs: string[] = [];
  let output: string | undefined;
  let src: string | undefined;
  let caps: string | undefined;
  let z3: string | undefined;
  let model: string | undefined;
  let config: string | undefined;
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
      switch (flag) {
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
        default:
          return err({ kind: "unknown_flag", flag });
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
    switch (token) {
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
      default:
        return err({ kind: "unknown_flag", flag: token });
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
  });
}
