/**
 * Branded types for compile-time prevention of value confusion.
 *
 * @remarks
 * Each branded type wraps a primitive (typically `string`) with a phantom
 * `__brand` field that exists only at the type level. This prevents accidental
 * interchange of semantically distinct values that share the same runtime
 * representation.
 *
 * Construction functions validate and brand values at trust boundaries.
 * Interior code passes branded values through without casting. The unsafe
 * `as` cast is confined exclusively to the construction functions below.
 *
 * Invariant: no branded value is constructed without passing through its
 * corresponding validation/construction function.
 * Invariant: the `__brand` field never exists at runtime; it is purely a
 * compile-time discriminant.
 *
 * @example
 * ```ts
 * import { toClaimId, toCapabilityName, type ClaimId, type CapabilityName } from "./branded.js";
 *
 * function match(claim: ClaimId, cap: CapabilityName): boolean {
 *   // TypeScript prevents: match(cap, claim) — argument types are incompatible
 *   return claim.startsWith(cap);
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Path types
// ---------------------------------------------------------------------------

/**
 * Absolute directory path used as the root for all artifact output.
 *
 * @remarks
 * Invariant: always an absolute path (starts with `/` on POSIX).
 * Invariant: represents a directory, not a file.
 * All write operations resolve relative paths against this root.
 */
export type OutputDirPath = string & { readonly __brand: "OutputDirPath" };

/**
 * Path relative to an OutputDirPath, used for artifact file placement.
 *
 * @remarks
 * Invariant: never starts with `/` or contains `..` traversal.
 * Invariant: when resolved against an OutputDirPath, the result stays
 * confined within the output directory.
 */
export type RelativePath = string & { readonly __brand: "RelativePath" };

/**
 * Relative path to an SMT-LIB artifact file within the output directory.
 *
 * @remarks
 * Invariant: ends with `.smt2` extension.
 * Invariant: satisfies all RelativePath constraints.
 * Used to distinguish solver artifact paths from general relative paths.
 */
export type SmtlibFilePath = string & { readonly __brand: "SmtlibFilePath" };

// ---------------------------------------------------------------------------
// Identifier types
// ---------------------------------------------------------------------------

/**
 * Canonical requirement or scenario identifier (e.g., "CAT-PARSE-EARS").
 *
 * @remarks
 * Invariant: matches the pattern `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`.
 * Invariant: uniquely identifies a requirement or scenario across the spec corpus.
 * Used for claim graph construction, cross-implication matching, and traceability.
 */
export type ClaimId = string & { readonly __brand: "ClaimId" };

/**
 * Capability name derived from path segments or identifier prefixes
 * (e.g., "catalog-and-parse", "formalization-and-logic-analysis").
 *
 * @remarks
 * Invariant: a non-empty lowercase kebab-case string.
 * Invariant: corresponds to a directory name under `openspec/changes/` or `openspec/specs/`.
 * Used for grouping claims, routing findings, and cross-implication pairing.
 */
export type CapabilityName = string & { readonly __brand: "CapabilityName" };

/**
 * SMT-safe identifier derived from a ClaimId via sanitization.
 *
 * @remarks
 * Invariant: matches `^[A-Za-z_][A-Za-z0-9_]*$` (valid SMT-LIB identifier).
 * Invariant: produced only by the `sanitizeIdentifier()` function.
 * Invariant: a reversible mapping comment is emitted alongside for traceability.
 * Used exclusively for SMT-LIB file naming and symbol generation.
 */
export type SanitizedClaimId = string & { readonly __brand: "SanitizedClaimId" };

// ---------------------------------------------------------------------------
// Semantic string types
// ---------------------------------------------------------------------------

/**
 * LLM model identifier (e.g., "gpt-5.3-codex").
 *
 * @remarks
 * Invariant: a non-empty string.
 * Invariant: passed verbatim to the `opencode` adapter as `--model` argument.
 * Branded to prevent confusion with capability names, claim IDs, or paths.
 */
export type ModelName = string & { readonly __brand: "ModelName" };

/**
 * SMT-LIB formula text content (not a file path).
 *
 * @remarks
 * Invariant: a non-empty string containing valid SMT-LIB syntax.
 * Invariant: piped to Z3 via stdin, never used as a file path.
 * Branded to prevent confusion with SmtlibFilePath.
 */
export type SmtlibContent = string & { readonly __brand: "SmtlibContent" };

// ---------------------------------------------------------------------------
// Construction functions
// ---------------------------------------------------------------------------

/**
 * Brand a string as an OutputDirPath after validation.
 *
 * @param raw - path string to validate and brand
 * @returns branded OutputDirPath
 *
 * @remarks
 * Precondition: `raw` is a non-empty string (resolution to absolute is handled
 * by callers via `path.resolve`).
 * Postcondition: returned value carries the `OutputDirPath` brand.
 * The caller is responsible for ensuring the path is absolute before use;
 * this function brands the value for type-level tracking.
 */
export function toOutputDirPath(raw: string): OutputDirPath {
  return raw as OutputDirPath;
}

/**
 * Brand a string as a RelativePath after validation.
 *
 * @param raw - path string to validate and brand
 * @returns branded RelativePath
 *
 * @remarks
 * Precondition: `raw` does not start with `/` and does not contain `..` traversal
 * that would escape the parent directory. Runtime confinement checking is performed
 * separately by `resolveConfinedOutputPath`.
 * Postcondition: returned value carries the `RelativePath` brand.
 */
export function toRelativePath(raw: string): RelativePath {
  return raw as RelativePath;
}

/**
 * Brand a string as a SmtlibFilePath.
 *
 * @param raw - relative path string ending with `.smt2`
 * @returns branded SmtlibFilePath
 *
 * @remarks
 * Precondition: `raw` ends with `.smt2` and satisfies RelativePath constraints.
 * Postcondition: returned value carries the `SmtlibFilePath` brand.
 */
export function toSmtlibFilePath(raw: string): SmtlibFilePath {
  return raw as SmtlibFilePath;
}

/**
 * Brand a string as a ClaimId after format validation.
 *
 * @param raw - identifier string to brand
 * @returns branded ClaimId
 *
 * @remarks
 * Precondition: `raw` matches the canonical identifier pattern
 * `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`. Callers are responsible for validation
 * (typically via the parser's identifier extraction logic).
 * Postcondition: returned value carries the `ClaimId` brand.
 */
export function toClaimId(raw: string): ClaimId {
  return raw as ClaimId;
}

/**
 * Brand a string as a CapabilityName.
 *
 * @param raw - capability name string to brand
 * @returns branded CapabilityName
 *
 * @remarks
 * Precondition: `raw` is a non-empty lowercase kebab-case string.
 * Postcondition: returned value carries the `CapabilityName` brand.
 */
export function toCapabilityName(raw: string): CapabilityName {
  return raw as CapabilityName;
}

/**
 * Brand a string as a SanitizedClaimId.
 *
 * @param raw - sanitized identifier string
 * @returns branded SanitizedClaimId
 *
 * @remarks
 * Precondition: `raw` matches `^[A-Za-z_][A-Za-z0-9_]*$`.
 * Postcondition: returned value carries the `SanitizedClaimId` brand.
 * This function should only be called from `sanitizeIdentifier()`.
 */
export function toSanitizedClaimId(raw: string): SanitizedClaimId {
  return raw as SanitizedClaimId;
}

/**
 * Brand a string as a ModelName.
 *
 * @param raw - model identifier string
 * @returns branded ModelName
 *
 * @remarks
 * Precondition: `raw` is a non-empty string.
 * Postcondition: returned value carries the `ModelName` brand.
 */
export function toModelName(raw: string): ModelName {
  return raw as ModelName;
}

/**
 * Brand a string as SmtlibContent.
 *
 * @param raw - SMT-LIB formula text
 * @returns branded SmtlibContent
 *
 * @remarks
 * Precondition: `raw` is a non-empty string containing SMT-LIB syntax.
 * Postcondition: returned value carries the `SmtlibContent` brand.
 */
export function toSmtlibContent(raw: string): SmtlibContent {
  return raw as SmtlibContent;
}
