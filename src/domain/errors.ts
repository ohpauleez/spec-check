/**
 * Structured error hierarchy for spec-check.
 *
 * @remarks
 * Follows the ErrorBase\<C\> discriminated union pattern. Each error category
 * maps to a fixed process exit code. All error values are plain readonly objects
 * with no class inheritance.
 *
 * Invariant: `category` is always one of the `ErrorCategory` literals.
 * Invariant: `message` is always a non-empty human-readable summary.
 * Invariant: `details`, when present, is a non-empty array of diagnostic strings.
 * Mutability: all fields are readonly.
 *
 * This module provides:
 * - `ErrorCategory` — closed union of all error categories
 * - `ErrorBase<C>` — generic error shape parameterized by category
 * - Category-specific type aliases (e.g., `ArgumentError`, `ConfigError`)
 * - `SpecCheckError` — full union of all error types
 * - Narrowed boundary unions for specific subsystems
 * - `makeError()` and `makeTypedError()` factory functions
 * - `renderErrorLines()` for formatted stderr output
 * - `exitCodeForError()` for process exit code resolution
 * - `isError()` type guard for Result failure branch
 */

import type { Result } from "./result.js";
import { assertNever } from "./assert.js";

/**
 * Stable error categories for CLI contracts.
 *
 * @remarks
 * Each category maps to a fixed process exit code via `EXIT_CODE_BY_CATEGORY`.
 * New categories require updating the exit code map and CLI documentation.
 * Categories are ordered by severity/specificity for documentation clarity.
 */
export type ErrorCategory =
  | "ArgumentError"
  | "ConfigError"
  | "DependencyError"
  | "CatalogError"
  | "ValidationError"
  | "AdapterError"
  | "QualitativeError"
  | "FormalizationError"
  | "PipelineError"
  | "OutputError";

/**
 * Base shape for all structured error values.
 *
 * @typeParam C - the specific error category this error belongs to
 *
 * @remarks
 * The `category` field serves as the discriminant for exhaustive switch handling.
 * The `details` field carries optional diagnostic context (stack traces, file paths,
 * validation messages) that supplements the human-readable `message`.
 */
interface ErrorBase<C extends ErrorCategory> {
  readonly category: C;
  readonly message: string;
  readonly details?: readonly string[];
}

/** CLI argument parsing failure (unrecognized flags, missing values). */
export type ArgumentError = ErrorBase<"ArgumentError">;

/** Configuration loading or validation failure. */
export type ConfigError = ErrorBase<"ConfigError">;

/** Missing external binary dependency (z3, opencode). */
export type DependencyError = ErrorBase<"DependencyError">;

/** Input document discovery or reading failure. */
export type CatalogError = ErrorBase<"CatalogError">;

/** Schema or structure validation failure (formalization samples, responses). */
export type ValidationError = ErrorBase<"ValidationError">;

/** External process adapter failure (spawn, timeout, invalid response). */
export type AdapterError = ErrorBase<"AdapterError">;

/** LLM-backed qualitative review failure. */
export type QualitativeError = ErrorBase<"QualitativeError">;

/** LLM-backed formalization failure. */
export type FormalizationError = ErrorBase<"FormalizationError">;

/** Pipeline phase orchestration failure. */
export type PipelineError = ErrorBase<"PipelineError">;

/** File or manifest output failure. */
export type OutputError = ErrorBase<"OutputError">;

/**
 * Lookup table mapping category literals to their typed error aliases.
 *
 * @remarks
 * Used internally by `makeTypedError` to preserve the specific category type
 * through the factory function without requiring the caller to cast.
 */
type ErrorByCategory = {
  readonly ArgumentError: ArgumentError;
  readonly ConfigError: ConfigError;
  readonly DependencyError: DependencyError;
  readonly CatalogError: CatalogError;
  readonly ValidationError: ValidationError;
  readonly AdapterError: AdapterError;
  readonly QualitativeError: QualitativeError;
  readonly FormalizationError: FormalizationError;
  readonly PipelineError: PipelineError;
  readonly OutputError: OutputError;
};

/**
 * Full union of all structured error values in spec-check.
 *
 * @remarks
 * Discriminated on the `category` field. Use `switch (error.category)` with
 * `assertNever` for exhaustive handling.
 */
export type SpecCheckError = ErrorByCategory[keyof ErrorByCategory];

// ---------------------------------------------------------------------------
// Narrowed boundary unions for specific subsystems
// ---------------------------------------------------------------------------

/** Errors that can occur during pipeline phase execution. */
export type PipelinePhaseError =
  | DependencyError
  | CatalogError
  | QualitativeError
  | FormalizationError
  | PipelineError;

/** Errors that can occur at adapter boundaries. */
export type AdapterBoundaryError = AdapterError | DependencyError;

/** Errors that can occur during CLI argument and config resolution. */
export type CliResolutionError = ArgumentError | ConfigError;

// ---------------------------------------------------------------------------
// Exit code mapping
// ---------------------------------------------------------------------------

/**
 * Exit code map required by the specification.
 *
 * @remarks
 * Invariant: all `ErrorCategory` values have a corresponding non-zero exit code.
 * Codes 2–11 are reserved for error categories. Code 0 is success. Code 1 is
 * "findings present" (non-fatal analysis results).
 */
export const EXIT_CODE_BY_CATEGORY: Readonly<Record<ErrorCategory, number>> = {
  ArgumentError: 2,
  ConfigError: 3,
  DependencyError: 4,
  CatalogError: 5,
  AdapterError: 6,
  ValidationError: 7,
  QualitativeError: 8,
  FormalizationError: 9,
  PipelineError: 10,
  OutputError: 11,
};

/** Process exit code for successful completion with no findings. */
export const EXIT_CODE_SUCCESS = 0;

/** Process exit code when analysis findings are present (non-fatal). */
export const EXIT_CODE_FINDINGS = 1;

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Build a structured SpecCheckError value.
 *
 * @param category - error category used for user contract and exit code
 * @param message - concise human-readable summary
 * @param details - optional diagnostic detail lines
 * @returns structured error object with the provided fields
 *
 * @remarks
 * Precondition: `category` is a valid `ErrorCategory`; `message` is non-empty.
 * Postcondition: returned object has `details` key only when `details` argument is defined.
 * Invariant: does not throw; always returns a well-formed `SpecCheckError`.
 *
 * @example
 * ```ts
 * import { makeError } from "./errors.js";
 *
 * const error = makeError("ValidationError", "formalization sample invalid", [
 *   "sort entry must include name and known sort",
 * ]);
 * // error.category === "ValidationError"
 * // error.details?.length === 1
 * ```
 */
export function makeError(
  category: ErrorCategory,
  message: string,
  details?: readonly string[],
): SpecCheckError {
  if (details === undefined) {
    return { category, message };
  }
  return { category, message, details };
}

/**
 * Build a typed error preserving the specific category in the return type.
 *
 * @typeParam C - the specific error category literal type
 * @param category - error category (type-level and runtime discriminant)
 * @param message - concise human-readable summary
 * @param details - optional diagnostic detail lines
 * @returns error object with the category type preserved for narrowing
 *
 * @remarks
 * Precondition: `category` is a valid `ErrorCategory`; `message` is non-empty.
 * Postcondition: returned object satisfies `ErrorByCategory[C]`.
 * Invariant: the single `as` cast is safe because the object literal satisfies
 * the shape of `ErrorBase<C>` structurally.
 *
 * @example
 * ```ts
 * import { makeTypedError } from "./errors.js";
 *
 * const error = makeTypedError("DependencyError", "z3 not found on PATH");
 * // TypeScript infers: DependencyError
 * ```
 */
export function makeTypedError<C extends ErrorCategory>(
  category: C,
  message: string,
  details?: readonly string[],
): ErrorByCategory[C] {
  if (details === undefined) {
    return { category, message } as ErrorByCategory[C];
  }
  return { category, message, details } as ErrorByCategory[C];
}

// ---------------------------------------------------------------------------
// Rendering and exit code resolution
// ---------------------------------------------------------------------------

/**
 * Render stderr lines in normalized format.
 *
 * @param error - structured error to render
 * @returns array with a summary line followed by optional indented detail lines
 *
 * @remarks
 * Precondition: `error` is a well-formed `SpecCheckError`.
 * Postcondition: first line matches `[spec-check] <category>: <message>`;
 * subsequent lines are indented with two spaces.
 * Invariant: returned array always has at least one element.
 *
 * @example
 * ```ts
 * import { makeError, renderErrorLines } from "./errors.js";
 *
 * const lines = renderErrorLines(makeError("ConfigError", "missing field", ["details here"]));
 * // lines[0] === "[spec-check] ConfigError: missing field"
 * // lines[1] === "  details here"
 * ```
 */
export function renderErrorLines(error: SpecCheckError): readonly string[] {
  const lines: string[] = [`[spec-check] ${error.category}: ${error.message}`];
  if (error.details !== undefined) {
    for (const detail of error.details) {
      lines.push(`  ${detail}`);
    }
  }
  return lines;
}

/**
 * Compute process exit code for a structured error.
 *
 * @param error - structured error with a valid category
 * @returns stable non-zero CLI exit code (2–11)
 *
 * @remarks
 * Precondition: `error.category` is a member of `ErrorCategory`.
 * Postcondition: returned value is in the range [2, 11].
 * Invariant: mapping is deterministic and stable across versions.
 *
 * @example
 * ```ts
 * import { makeError, exitCodeForError } from "./errors.js";
 *
 * const code = exitCodeForError(makeError("DependencyError", "z3 not found"));
 * // code === 4
 * ```
 */
export function exitCodeForError(error: SpecCheckError): number {
  return EXIT_CODE_BY_CATEGORY[error.category];
}

/**
 * Format a single-line error message for stderr output.
 *
 * @param error - structured error to format
 * @returns formatted string suitable for writing to stderr
 *
 * @remarks
 * Precondition: `error` is a well-formed `SpecCheckError`.
 * Postcondition: returned string matches `[spec-check] <category>: <message>`.
 * Invariant: does not include trailing newline; caller adds as needed.
 */
export function formatError(error: SpecCheckError): string {
  return `[spec-check] ${error.category}: ${error.message}`;
}

/**
 * Type guard for Result failure branch.
 *
 * @param value - Result value to test
 * @returns `true` when Result is in the failure branch (`ok === false`)
 *
 * @remarks
 * Precondition: `value` is a valid `Result<T, E>`.
 * Postcondition: when `true`, TypeScript narrows `value` to `{ ok: false; error: E }`.
 * Invariant: does not throw; pure predicate.
 *
 * @example
 * ```ts
 * import { isError } from "./errors.js";
 * import { err } from "./result.js";
 *
 * const result = err(makeTypedError("CatalogError", "unreadable"));
 * if (isError(result)) {
 *   // result.error is narrowed here
 * }
 * ```
 */
export function isError<T, E>(value: Result<T, E>): value is { readonly ok: false; readonly error: E } {
  return !value.ok;
}

/**
 * Exhaustive error category switch handler.
 *
 * @param error - error to compute exit code for using explicit category matching
 * @returns stable non-zero CLI exit code
 *
 * @remarks
 * Precondition: `error.category` is a member of `ErrorCategory`.
 * Postcondition: returned value equals `EXIT_CODE_BY_CATEGORY[error.category]`.
 * This function exists to demonstrate exhaustive handling with `assertNever`;
 * prefer `exitCodeForError` for production use.
 */
export function exitCodeFromCategory(category: ErrorCategory): number {
  switch (category) {
    case "ArgumentError":
      return EXIT_CODE_BY_CATEGORY.ArgumentError;
    case "ConfigError":
      return EXIT_CODE_BY_CATEGORY.ConfigError;
    case "DependencyError":
      return EXIT_CODE_BY_CATEGORY.DependencyError;
    case "CatalogError":
      return EXIT_CODE_BY_CATEGORY.CatalogError;
    case "ValidationError":
      return EXIT_CODE_BY_CATEGORY.ValidationError;
    case "AdapterError":
      return EXIT_CODE_BY_CATEGORY.AdapterError;
    case "QualitativeError":
      return EXIT_CODE_BY_CATEGORY.QualitativeError;
    case "FormalizationError":
      return EXIT_CODE_BY_CATEGORY.FormalizationError;
    case "PipelineError":
      return EXIT_CODE_BY_CATEGORY.PipelineError;
    case "OutputError":
      return EXIT_CODE_BY_CATEGORY.OutputError;
    default:
      return assertNever(category);
  }
}
