/**
 * Invocation-scoped durable evidence for attached formalization attempts.
 *
 * Evidence contains local claim references and context hashes, but never claim
 * text. Each invocation is serialized deterministically and atomically written
 * before its caller handles formalization failure.
 */
import { sha256Hex, writeOutputAtomic } from "../../adapters/fs.js";
import { assertNever, precondition } from "../assert.js";
import { toRelativePath, type OutputDirPath, type RelativePath } from "../branded.js";
import type { BatchAttemptEvidence } from "../formal/batch-transport.js";

/** Directory containing invocation-scoped formalization evidence. */
export const FORMALIZATION_EVIDENCE_DIRECTORY = toRelativePath("formalization_evidence");

/** The source claim-array namespace for one formalization invocation. */
export type FormalizationClaimSet =
  | {
    readonly kind: "specs_forward";
  }
  | {
    readonly kind: "generated_spec";
    /** Zero-based position among generated-spec formalization invocations. */
    readonly ordinal: number;
    readonly capability: string;
  };

/** Durable envelope containing attempts from exactly one claim-index namespace. */
export interface FormalizationAttemptSet {
  readonly schemaVersion: 1;
  readonly claimSet: FormalizationClaimSet;
  readonly attempts: readonly BatchAttemptEvidence[];
}

/** Ordinary output-file descriptor retained for the successful manifest. */
export interface FormalizationEvidenceFile {
  readonly path: RelativePath;
  readonly checksum: string;
  readonly phase: "formalization";
}

/**
 * Construct an immutable invocation evidence envelope.
 *
 * @param claimSet - claim-array namespace that owns every local attempt index
 * @param attempts - attached attempts produced by this invocation, in stable order
 * @returns a frozen schema-v1 envelope that contains no claim text
 *
 * @remarks
 * Preconditions: generated-spec ordinals are non-negative safe integers and
 * capabilities are non-empty. Attempt metadata must use indexes local to the
 * selected claim set. Postcondition: the returned envelope has fresh, frozen
 * arrays and projects every attempt onto the declared pointer-only schema, so
 * undeclared runtime properties cannot enter durable output. Broken claim-set,
 * index, or parallel-array contracts throw. The function is pure,
 * deterministic, and safe for concurrent use.
 */
export function buildFormalizationAttemptSet(
  claimSet: FormalizationClaimSet,
  attempts: readonly BatchAttemptEvidence[],
): FormalizationAttemptSet {
  if (claimSet.kind === "generated_spec") {
    precondition(
      Number.isSafeInteger(claimSet.ordinal) && claimSet.ordinal >= 0,
      "generated-spec formalization ordinal must be a non-negative safe integer",
    );
    precondition(claimSet.capability.length > 0, "generated-spec capability must be non-empty");
  }
  return Object.freeze({
    schemaVersion: 1,
    claimSet: Object.freeze({ ...claimSet }),
    attempts: Object.freeze(attempts.map(copyAttemptEvidence)),
  });
}

function copyAttemptEvidence(attempt: BatchAttemptEvidence): BatchAttemptEvidence {
  precondition(
    attempt.claimIndexes.length === attempt.claimIds.length
      && attempt.claimIndexes.length === attempt.provenanceFiles.length,
    "formalization attempt claim reference arrays must be parallel",
  );
  precondition(
    attempt.claimIndexes.every((index) => Number.isSafeInteger(index) && index >= 0),
    "formalization attempt claim indexes must be non-negative safe integers",
  );
  return Object.freeze({
    batchKey: attempt.batchKey,
    claimIndexes: Object.freeze([...attempt.claimIndexes]),
    claimIds: Object.freeze([...attempt.claimIds]),
    provenanceFiles: Object.freeze([...attempt.provenanceFiles]),
    contextSha256: attempt.contextSha256,
    promptVariant: attempt.promptVariant,
    model: attempt.model,
    subBatchOrdinal: attempt.subBatchOrdinal,
    outcome: copyAttemptOutcome(attempt.outcome),
    cleanup: attempt.cleanup,
  });
}

function copyAttemptOutcome(
  outcome: BatchAttemptEvidence["outcome"],
): BatchAttemptEvidence["outcome"] {
  switch (outcome.kind) {
    case "success":
      return Object.freeze({ kind: "success" });
    case "model_failure":
      return Object.freeze({ kind: "model_failure", errorKind: outcome.errorKind });
    case "infrastructure_failure":
      return Object.freeze({ kind: "infrastructure_failure", errorKind: outcome.errorKind });
    case "transport_failure":
      return Object.freeze({ kind: "transport_failure", detail: outcome.detail });
    default:
      return assertNever(outcome);
  }
}

/**
 * Select the deterministic evidence path for an invocation claim set.
 *
 * @param claimSet - validated invocation namespace
 * @returns a confined relative JSON path unique within one run
 *
 * @remarks
 * Specs-forward has one fixed invocation path. Generated-spec paths begin with
 * a zero-padded ordinal, so repeated capabilities remain collision-free. The
 * capability suffix is encoded injectively by UTF-8 byte value. Invalid
 * generated ordinals or empty capabilities throw as precondition violations.
 * The function performs no I/O and is deterministic.
 */
export function formalizationAttemptSetPath(claimSet: FormalizationClaimSet): RelativePath {
  if (claimSet.kind === "specs_forward") {
    return toRelativePath(`${FORMALIZATION_EVIDENCE_DIRECTORY}/specs_forward.json`);
  }
  precondition(
    Number.isSafeInteger(claimSet.ordinal) && claimSet.ordinal >= 0,
    "generated-spec formalization ordinal must be a non-negative safe integer",
  );
  precondition(claimSet.capability.length > 0, "generated-spec capability must be non-empty");
  const ordinal = String(claimSet.ordinal).padStart(6, "0");
  const capability = Buffer.from(claimSet.capability, "utf8").toString("hex");
  return toRelativePath(
    `${FORMALIZATION_EVIDENCE_DIRECTORY}/generated_spec_${ordinal}_${capability}.json`,
  );
}

/**
 * Serialize an attempt set to canonical durable bytes.
 *
 * @param attemptSet - schema-v1 invocation evidence envelope
 * @returns pretty JSON with LF newlines and exactly one trailing newline
 *
 * @remarks
 * Declared property insertion order is preserved. Identical envelopes produce
 * byte-identical UTF-8 text. The function performs no I/O, does not mutate its
 * input, and has no expected failure for valid evidence values.
 */
export function serializeFormalizationAttemptSet(attemptSet: FormalizationAttemptSet): string {
  return `${JSON.stringify(attemptSet, null, 2)}\n`;
}

/**
 * Atomically persist one invocation envelope and return its manifest descriptor.
 *
 * @param outputDir - configured output root
 * @param attemptSet - complete invocation envelope, including an empty attempt array when applicable
 * @returns path/checksum metadata for ordinary manifest inclusion
 *
 * @remarks
 * Postcondition: on success, the deterministic final path contains exactly the
 * canonical serialized bytes and the returned checksum covers those bytes.
 * Filesystem creation, write, or rename failures propagate. Atomic replacement
 * and output confinement are delegated to `writeOutputAtomic`. Callers must
 * serialize invocations targeting one output directory rather than writing the
 * same deterministic path concurrently.
 */
export async function writeFormalizationAttemptSet(
  outputDir: OutputDirPath,
  attemptSet: FormalizationAttemptSet,
): Promise<FormalizationEvidenceFile> {
  const path = formalizationAttemptSetPath(attemptSet.claimSet);
  const content = serializeFormalizationAttemptSet(attemptSet);
  await writeOutputAtomic(outputDir, path, content);
  return Object.freeze({
    path,
    checksum: sha256Hex(content),
    phase: "formalization",
  });
}
