/**
 * Deterministic context transport for multi-claim formalization batches.
 *
 * The JSON document is an ephemeral adapter input. Durable evidence stores only
 * claim pointers and a hash of the exact bytes sent to the adapter.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeErrorKind } from "../../adapters/opencode.js";
import type { IndexedFormalizationClaim } from "./grouping.js";

/** Schema version of the attached batch context document. */
export const BATCH_CONTEXT_SCHEMA_VERSION = 1 as const;

/** Dedicated prompt version recorded in batch-attempt evidence. */
export const ATTACHED_BATCH_PROMPT_VARIANT = "attached-context-v1";

/**
 * JSON schema carried by one attached first-sample physical batch.
 *
 * @remarks
 * Key insertion order is part of the serialization contract. `index` is the
 * original eligible claim index, not array position in an arbitrary response.
 */
export interface BatchContextFile {
  readonly schemaVersion: typeof BATCH_CONTEXT_SCHEMA_VERSION;
  readonly batchKey: string;
  readonly claims: readonly {
    readonly index: number;
    readonly id: string | null;
    readonly obligation: string;
    readonly provenance: { readonly file: string };
    readonly text: string;
  }[];
}

/** Classification of an attached attempt after adapter and cleanup handling. */
export type BatchAttemptOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "model_failure"; readonly errorKind: OpencodeErrorKind }
  | { readonly kind: "infrastructure_failure"; readonly errorKind: OpencodeErrorKind }
  | { readonly kind: "transport_failure"; readonly detail: string };

/** Terminal cleanup state recorded for an attached attempt. */
export type BatchCleanupOutcome = "succeeded" | "failed" | "not_attempted";

/**
 * Durable metadata for an attached attempt.
 *
 * @remarks
 * This record deliberately contains no claim text. `claimIndexes` point back
 * to preserved eligible claims, while `contextSha256` verifies reconstruction.
 */
export interface BatchAttemptEvidence {
  readonly schemaVersion: typeof BATCH_CONTEXT_SCHEMA_VERSION;
  readonly batchKey: string;
  readonly claimIndexes: readonly number[];
  readonly claimIds: readonly (string | null)[];
  readonly provenanceFiles: readonly string[];
  readonly contextSha256: string;
  readonly promptVariant: string;
  readonly model: string;
  readonly subBatchOrdinal: number;
  readonly outcome: BatchAttemptOutcome;
  readonly cleanup: BatchCleanupOutcome;
}

/** A successfully created and written ephemeral context file. */
export interface BatchContextHandle {
  readonly directoryPath: string;
  readonly filePath: string;
}

/**
 * Build one durable attempt record from a physical batch and terminal outcome.
 *
 * @param input - batch identity, exact context hash, adapter metadata, and lifecycle state
 * @returns pointer-only evidence record
 *
 * @remarks
 * Preconditions: `contextSha256` hashes the exact serialized context bytes and
 * parallel claim arrays follow the batch order. Postconditions: the record
 * contains no claim text and is deterministic for identical metadata. Failure
 * form: none; this is a pure value construction.
 */
export function buildBatchAttemptEvidence(input: {
  readonly batch: { readonly logicalFile: string; readonly ordinal: number; readonly claims: readonly IndexedFormalizationClaim[] };
  readonly contextSha256: string;
  readonly model: string;
  readonly outcome: BatchAttemptOutcome;
  readonly cleanup: BatchCleanupOutcome;
}): BatchAttemptEvidence {
  return {
    schemaVersion: BATCH_CONTEXT_SCHEMA_VERSION,
    batchKey: input.batch.logicalFile,
    claimIndexes: input.batch.claims.map((claim) => claim.eligibleIndex),
    claimIds: input.batch.claims.map((claim) => claim.claim.id ?? null),
    provenanceFiles: input.batch.claims.map((claim) => claim.claim.provenance.file),
    contextSha256: input.contextSha256,
    promptVariant: ATTACHED_BATCH_PROMPT_VARIANT,
    model: input.model,
    subBatchOrdinal: input.batch.ordinal,
    outcome: input.outcome,
    cleanup: input.cleanup,
  };
}

/**
 * Build a context object from indexed claims without mutating source claims.
 *
 * @param batchKey - exact semantic grouping key for the physical batch
 * @param claims - ordered indexed claims in the physical batch
 * @returns schema-versioned context object with explicit null IDs
 *
 * @remarks
 * Preconditions: claims belong to one semantic group and indexes are safe
 * integers. Postconditions: output order matches input order, provenance paths
 * are copied verbatim, and no claim object is mutated. Failure form: none; this
 * is a pure transformation.
 */
export function buildBatchContextFile(
  batchKey: string,
  claims: readonly IndexedFormalizationClaim[],
): BatchContextFile {
  return {
    schemaVersion: BATCH_CONTEXT_SCHEMA_VERSION,
    batchKey,
    claims: claims.map(({ claim, eligibleIndex }) => ({
      index: eligibleIndex,
      id: claim.id ?? null,
      obligation: claim.obligation,
      provenance: { file: claim.provenance.file },
      text: claim.text,
    })),
  };
}

/**
 * Serialize a batch context with the exact byte contract used for evidence.
 *
 * @param context - schema-valid context object
 * @returns JSON text encoded as UTF-8 by callers, with LF and one trailing LF
 *
 * @remarks
 * Preconditions: context uses the declared insertion order. Postconditions:
 * identical values yield identical text and exactly one trailing newline is
 * present. Failure form: JSON serialization exceptions are exceptional input
 * failures and are allowed to propagate.
 */
export function serializeBatchContext(context: BatchContextFile): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

/**
 * Compute the lowercase SHA-256 digest over exact serialized context bytes.
 *
 * @param serializedContext - serialized UTF-8 context text
 * @returns 64-character lowercase hexadecimal digest
 *
 * @remarks
 * Preconditions: serializedContext is the output of
 * {@link serializeBatchContext}. Postcondition: hashing the returned bytes
 * again produces the same digest. Failure form: none for valid strings.
 */
export function hashBatchContext(serializedContext: string): string {
  return createHash("sha256").update(Buffer.from(serializedContext, "utf8")).digest("hex");
}

/**
 * Create a fresh OS-temp directory for one physical batch.
 *
 * @returns absolute directory path or a diagnostic string
 *
 * @remarks
 * Preconditions: the OS temp directory is available and writable.
 * Postconditions: success returns a newly created directory using the required
 * prefix; failure performs no cleanup because no directory was created.
 * Failure form: expected filesystem failures are returned as data.
 */
export async function createBatchContextDirectory(): Promise<
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string }
> {
  try {
    return { ok: true, value: await mkdtemp(join(tmpdir(), "spec-check-batch-")) };
  } catch (error: unknown) {
    return { ok: false, error: describeUnknownError(error, "temporary batch directory creation failed") };
  }
}

/**
 * Write the fixed context filename with exclusive owner-only permissions.
 *
 * @param directoryPath - directory returned by createBatchContextDirectory
 * @param serializedContext - exact UTF-8 content to write
 * @returns handle or a diagnostic string
 *
 * @remarks
 * Preconditions: directoryPath names an existing fresh directory and the
 * fixed filename does not exist. Postcondition: success creates
 * `batch-context.json` with `wx` and mode `0600`. Failure form: write errors
 * are returned as data; callers remain responsible for directory cleanup.
 */
export async function writeBatchContextFile(
  directoryPath: string,
  serializedContext: string,
): Promise<{ readonly ok: true; readonly value: BatchContextHandle } | { readonly ok: false; readonly error: string }> {
  const filePath = join(directoryPath, "batch-context.json");
  try {
    await writeFile(filePath, serializedContext, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { ok: true, value: { directoryPath, filePath } };
  } catch (error: unknown) {
    return { ok: false, error: describeUnknownError(error, "temporary batch context write failed") };
  }
}

/**
 * Remove a temporary batch directory recursively.
 *
 * @param directoryPath - directory created for one attached batch
 * @returns success or cleanup diagnostic
 *
 * @remarks
 * Preconditions: directoryPath is a temp directory owned by this attempt.
 * Postconditions: success removes the directory and its fixed context file;
 * failure leaves the OS state unchanged from the failed removal attempt.
 * Failure form: cleanup failures are returned so callers can preserve the
 * primary model or write failure.
 */
export async function cleanupBatchContextDirectory(
  directoryPath: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  try {
    await rm(directoryPath, { recursive: true, force: true });
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: describeUnknownError(error, "temporary batch cleanup failed") };
  }
}

function describeUnknownError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
