/**
 * Deterministic attached-context transport for multi-claim formalization.
 *
 * @remarks
 * Pure context construction, serialization, and hashing are separated from
 * filesystem transitions. A caller owns each returned temp directory until it
 * calls {@link cleanupBatchContext}; cleanup is safe after either directory
 * creation or successful file writing.
 *
 * @example
 * ```ts
 * const context = buildBatchContextFile("<merged-spec/auth>", indexedClaims);
 * const prepared = await prepareBatchContext(context);
 * if (prepared.ok) {
 *   try {
 *     await invokeModel(prepared.value.filePath);
 *   } finally {
 *     await cleanupBatchContext(prepared.value);
 *   }
 * }
 * ```
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeError } from "../../adapters/opencode.js";
import type { Claim } from "../claim-graph.js";
import { err, ok, type Result } from "../result.js";

/** Schema version written into every attached batch context. */
export const BATCH_CONTEXT_SCHEMA_VERSION = 1;

/** Fixed file name inside a private batch temp directory. */
export const BATCH_CONTEXT_FILENAME = "batch-context.json";

/** Prefix used by `mkdtemp` for identifiable, collision-resistant directories. */
export const BATCH_CONTEXT_TEMP_PREFIX = "spec-check-batch-";

/**
 * A formalizable claim paired with its authoritative eligible-input index.
 *
 * @remarks
 * `index` must be a unique non-negative safe integer within one physical
 * batch. The claim is borrowed and is never mutated by this module.
 */
export interface IndexedBatchClaim {
  readonly index: number;
  readonly claim: Pick<Claim, "id" | "obligation" | "provenance" | "text">;
}

/**
 * Claim data serialized into a schema-v1 attached context.
 *
 * @remarks
 * `id` is informational and may be `null` or duplicated. `index` is the only
 * response-matching authority. Provenance paths and claim text are verbatim.
 */
export interface BatchContextClaim {
  readonly index: number;
  readonly id: string | null;
  readonly obligation: string;
  readonly provenance: {
    readonly file: string;
  };
  readonly text: string;
}

/**
 * Versioned JSON document attached to one physical formalization batch.
 *
 * @remarks
 * Claims preserve eligible input order. Declared property order is part of the
 * serialization contract and must not be changed without a schema version bump.
 */
export interface BatchContextFile {
  readonly schemaVersion: 1;
  readonly batchKey: string;
  readonly claims: readonly BatchContextClaim[];
}

/**
 * Temp lifecycle state after a directory exists but before its context file is
 * known to have been written completely.
 */
export interface BatchContextDirectory {
  readonly state: "dir_created";
  readonly directoryPath: string;
}

/**
 * Temp lifecycle state containing an exclusively written attachment.
 *
 * @remarks
 * `contextSha256` hashes the exact UTF-8 bytes in `serializedContext`.
 */
export interface WrittenBatchContext {
  readonly state: "file_written";
  readonly directoryPath: string;
  readonly filePath: string;
  readonly serializedContext: string;
  readonly contextSha256: string;
}

/**
 * Canonical in-memory representation prepared before attached-context I/O.
 *
 * @remarks
 * `contextSha256` hashes the exact UTF-8 bytes in `serializedContext`. The
 * object is immutable and can be retained as evidence when directory creation
 * fails. Preparing it is deterministic, side-effect free, and concurrency-safe.
 */
export interface PreparedBatchContext {
  readonly serializedContext: string;
  readonly contextSha256: string;
}

/** A temp context state that owns a directory and therefore requires cleanup. */
export type CleanupEligibleBatchContext = BatchContextDirectory | WrittenBatchContext;

/**
 * Terminal cleanup state for a temp context directory.
 *
 * @remarks
 * Cleanup failure is data so a successful model result is not discarded. The
 * caller must surface `detail` as diagnostic evidence when cleanup fails.
 */
export type BatchContextCleanup =
  | {
    readonly state: "cleanup_succeeded";
    readonly directoryPath: string;
  }
  | {
    readonly state: "cleanup_failed";
    readonly directoryPath: string;
    readonly detail: string;
  };

/**
 * Expected failure while preparing an attached context.
 *
 * @remarks
 * A write failure retains the primary write diagnostic. If best-effort cleanup
 * also fails, `cleanupDetail` records that secondary failure without masking it.
 */
export type BatchTransportError =
  | {
    readonly kind: "directory_creation_failed";
    readonly message: string;
  }
  | {
    readonly kind: "file_write_failed";
    readonly message: string;
    readonly directoryPath: string;
    readonly cleanupDetail?: string;
  };

/**
 * Durable, claim-text-free evidence for one attached batch attempt.
 *
 * @remarks
 * The three claim metadata arrays are parallel and preserve context order.
 * `claimIndexes` are pointers into preserved eligible source claims; claim text
 * is intentionally omitted. `contextSha256` is computed over the exact canonical
 * context bytes, allowing reconstruction to be verified after temp cleanup.
 * `cleanup: "not_attempted"` is valid only when no directory was created.
 */
export interface BatchAttemptEvidence {
  readonly batchKey: string;
  readonly claimIndexes: readonly number[];
  readonly claimIds: readonly (string | null)[];
  readonly provenanceFiles: readonly string[];
  readonly contextSha256: string;
  readonly promptVariant: string;
  readonly model: string;
  readonly subBatchOrdinal: number;
  readonly outcome:
    | {
      readonly kind: "success";
    }
    | {
      readonly kind: "model_failure";
      readonly errorKind: OpencodeError["kind"];
    }
    | {
      readonly kind: "infrastructure_failure";
      readonly errorKind: OpencodeError["kind"];
    }
    | {
      readonly kind: "transport_failure";
      readonly detail: string;
    };
  readonly cleanup: "succeeded" | "failed" | "not_attempted";
}

/**
 * Build a schema-v1 context from indexed claims without mutating input values.
 *
 * @param batchKey - exact semantic logical-file key for the physical batch
 * @param claims - claims in stable eligible-input order with unique indexes
 * @returns a context with explicit null IDs and verbatim source data
 * @throws {Error} if the key is empty or an index is unsafe, negative, or duplicated
 *
 * @remarks
 * Preconditions are enforced as programmer-contract failures because indexed
 * claims are internal validated data. The output preserves claim order and has
 * a stable object-property insertion order. The function performs no I/O and is
 * deterministic and concurrency-safe.
 *
 * @example
 * ```ts
 * const context = buildBatchContextFile("specs/auth.md", [
 *   { index: 0, claim },
 * ]);
 * ```
 */
export function buildBatchContextFile(
  batchKey: string,
  claims: readonly IndexedBatchClaim[],
): BatchContextFile {
  if (batchKey.length === 0) {
    throw new Error("batch context key must be non-empty");
  }

  const indexes = new Set<number>();
  const contextClaims: BatchContextClaim[] = [];
  for (const entry of claims) {
    if (!Number.isSafeInteger(entry.index) || entry.index < 0) {
      throw new Error(`batch claim index must be a non-negative safe integer: ${String(entry.index)}`);
    }
    if (indexes.has(entry.index)) {
      throw new Error(`batch claim index must be unique: ${String(entry.index)}`);
    }
    indexes.add(entry.index);
    contextClaims.push({
      index: entry.index,
      id: entry.claim.id ?? null,
      obligation: entry.claim.obligation,
      provenance: { file: entry.claim.provenance.file },
      text: entry.claim.text,
    });
  }

  return {
    schemaVersion: BATCH_CONTEXT_SCHEMA_VERSION,
    batchKey,
    claims: contextClaims,
  };
}

/**
 * Serialize a context to its canonical attachment representation.
 *
 * @param context - schema-v1 context with properties in declared insertion order
 * @returns UTF-8-compatible JSON text with LF newlines and one trailing newline
 * @throws {TypeError} if a value cannot be represented by `JSON.stringify`
 *
 * @remarks
 * The output has no BOM. Identical context values produce byte-identical text.
 * No input object is mutated. Context size is bounded by available process
 * memory; callers control physical batch size before calling this function.
 *
 * @example
 * ```ts
 * const bytes = Buffer.from(serializeBatchContextFile(context), "utf8");
 * ```
 */
export function serializeBatchContextFile(context: BatchContextFile): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

/**
 * Compute the evidence hash for exact serialized context bytes.
 *
 * @param serializedContext - canonical context text to hash as UTF-8
 * @returns lowercase 64-character SHA-256 hexadecimal digest
 *
 * @remarks
 * The function is deterministic, has no expected failure form, does not mutate
 * input, and is safe for concurrent use.
 *
 * @example
 * ```ts
 * const digest = hashBatchContext(serializedContext);
 * ```
 */
export function hashBatchContext(serializedContext: string): string {
  return createHash("sha256").update(serializedContext, "utf8").digest("hex");
}

/**
 * Serialize and hash a context once before any filesystem operation.
 *
 * @param context - deterministic schema-v1 context to prepare
 * @returns frozen canonical text and its lowercase SHA-256 digest
 * @throws {TypeError} if the context cannot be represented by `JSON.stringify`
 *
 * @remarks
 * The digest covers the exact UTF-8 text returned in `serializedContext`.
 * Preparing bytes first lets callers retain evidence when directory creation
 * fails and pass the known digest through the write path without hashing again.
 * The function performs no I/O and does not mutate `context`.
 *
 * @example
 * ```ts
 * const data = prepareBatchContextData(context);
 * const prepared = await prepareBatchContext(context, undefined, data);
 * ```
 */
export function prepareBatchContextData(context: BatchContextFile): PreparedBatchContext {
  const serializedContext = serializeBatchContextFile(context);
  return Object.freeze({
    serializedContext,
    contextSha256: hashBatchContext(serializedContext),
  });
}

/**
 * Create a fresh private temp directory for one attached attempt.
 *
 * @param tempRoot - OS temp directory override; defaults to `tmpdir()`
 * @returns `ok` with `dir_created`, or `directory_creation_failed`
 *
 * @remarks
 * The directory name begins with `spec-check-batch-`. On success, ownership of
 * cleanup transfers to the caller. Filesystem failures are returned as data;
 * this function does not intentionally throw. Calls are independent and may run
 * concurrently.
 *
 * @example
 * ```ts
 * const created = await createBatchContextDirectory();
 * ```
 */
export async function createBatchContextDirectory(
  tempRoot: string = tmpdir(),
): Promise<Result<BatchContextDirectory, BatchTransportError>> {
  try {
    const directoryPath = await mkdtemp(join(tempRoot, BATCH_CONTEXT_TEMP_PREFIX));
    return ok({ state: "dir_created", directoryPath });
  } catch (error: unknown) {
    return err({
      kind: "directory_creation_failed",
      message: normalizeError(error, "failed to create batch context directory"),
    });
  }
}

/**
 * Exclusively write canonical context text into a created temp directory.
 *
 * @param directory - owned `dir_created` state returned by this module
 * @param serializedContext - canonical context text to write verbatim as UTF-8
 * @param contextSha256 - known hash of `serializedContext`; required so a
 *   caller that forgets to thread the prepared hash fails at compile time
 *   instead of silently recomputing it
 * @returns `ok` with `file_written`, or a primary `file_write_failed` error
 *
 * @remarks
 * The fixed file is created with mode `0o600` and flag `wx`; existing files are
 * never overwritten. On failure, this function does not clean the directory so
 * the directory-creation and write transitions remain independently testable.
 * The caller still owns cleanup. Expected filesystem failures are returned as
 * data; this function does not intentionally throw.
 *
 * @example
 * ```ts
 * const data = prepareBatchContextData(context);
 * const written = await writeBatchContextFile(created.value, data.serializedContext, data.contextSha256);
 * ```
 */
export async function writeBatchContextFile(
  directory: BatchContextDirectory,
  serializedContext: string,
  contextSha256: string,
): Promise<Result<WrittenBatchContext, BatchTransportError>> {
  const filePath = join(directory.directoryPath, BATCH_CONTEXT_FILENAME);
  try {
    await writeFile(filePath, serializedContext, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error: unknown) {
    return err({
      kind: "file_write_failed",
      message: normalizeError(error, "failed to write batch context file"),
      directoryPath: directory.directoryPath,
    });
  }

  return ok({
    state: "file_written",
    directoryPath: directory.directoryPath,
    filePath,
    serializedContext,
    contextSha256,
  });
}

/**
 * Remove an owned temp context directory recursively.
 *
 * @param context - `dir_created` or `file_written` state owned by the caller
 * @returns terminal cleanup state, including diagnostic detail on failure
 *
 * @remarks
 * Cleanup is attempted once and never masks an earlier transport or model
 * outcome. Failure is returned as `cleanup_failed`, not thrown. The caller must
 * not reuse a context after this transition. Independent directories may be
 * cleaned concurrently.
 *
 * @example
 * ```ts
 * const cleanup = await cleanupBatchContext(written.value);
 * ```
 */
export async function cleanupBatchContext(
  context: CleanupEligibleBatchContext,
): Promise<BatchContextCleanup> {
  try {
    await rm(context.directoryPath, { recursive: true, force: false });
    return {
      state: "cleanup_succeeded",
      directoryPath: context.directoryPath,
    };
  } catch (error: unknown) {
    return {
      state: "cleanup_failed",
      directoryPath: context.directoryPath,
      detail: normalizeError(error, "failed to remove batch context directory"),
    };
  }
}

/**
 * Create and write one attached context, cleaning partial state on write failure.
 *
 * @param context - deterministic schema-v1 batch context
 * @param tempRoot - optional temp root used for fault injection or isolation
 * @param preparedData - optional canonical bytes and known hash; callers that
 *   need pre-I/O evidence can prepare these once with
 *   {@link prepareBatchContextData}
 * @returns `ok` with an owned written context, or an expected transport error
 *
 * @remarks
 * On success, the caller must invoke {@link cleanupBatchContext} in a `finally`
 * block after the model attempt. On write failure, cleanup is attempted before
 * return; a cleanup diagnostic is appended without replacing the write failure.
 * Directory creation and writing are sequential and bounded to one operation
 * each. The function does not intentionally throw.
 *
 * @example
 * ```ts
 * const prepared = await prepareBatchContext(context);
 * ```
 */
export async function prepareBatchContext(
  context: BatchContextFile,
  tempRoot: string = tmpdir(),
  preparedData?: PreparedBatchContext,
): Promise<Result<WrittenBatchContext, BatchTransportError>> {
  const created = await createBatchContextDirectory(tempRoot);
  if (!created.ok) {
    return created;
  }

  const data = preparedData ?? prepareBatchContextData(context);
  const written = await writeBatchContextFile(
    created.value,
    data.serializedContext,
    data.contextSha256,
  );
  if (written.ok) {
    return written;
  }

  const cleanup = await cleanupBatchContext(created.value);
  if (cleanup.state === "cleanup_succeeded") {
    return written;
  }

  return err({
    ...written.error,
    cleanupDetail: cleanup.detail,
  });
}

/**
 * Normalize an unknown thrown value at the filesystem boundary.
 *
 * @param value - unknown caught value
 * @param fallback - stable message used for non-Error throws
 * @returns the Error message or fallback text
 *
 * @remarks
 * Pure, total, and non-throwing. No sensitive context contents are included.
 */
function normalizeError(value: unknown, fallback: string): string {
  return value instanceof Error ? value.message : fallback;
}
