/** Private immutable code attachments and required independent generation evidence. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { createBatchContextDirectory, cleanupBatchContext } from "../domain/formal/batch-transport.js";
import { EvidenceBudgetError, type EvidenceRecorder } from "../domain/formal/evidence.js";
import { err, type Result } from "../domain/result.js";
import { callOpencode, type OpencodeError } from "./opencode.js";

/** Selected bytes are captured once by the bounded scanner; paths identify their original source. */
export interface SourceAttachment {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: Uint8Array;
}

/** Invoke generation only from private copies of the durably identified selected bytes.
 * @returns Model result plus cleanup status; expected transport/capacity failures remain data.
 * @throws Required evidence persistence failures, never retried as model failures.
 * @remarks Caller owns bounded attachment selection (30k/file, 100k total). Private copies are
 * written exclusively, used across adapter retries, and cleaned in finally on all outcomes.
 */
export async function invokeSourceGeneration(input: {
  readonly model: string; readonly timeoutMs: number; readonly prompt: string;
  readonly attachments: readonly SourceAttachment[]; readonly suggestedCapabilities: readonly string[];
  readonly evidence?: EvidenceRecorder;
}): Promise<{ readonly result: Result<unknown, OpencodeError>; readonly cleanup?: string }> {
  const scope = "generated-source";
  // Own byte copies across awaits; caller mutation cannot change the hashed attachments.
  const captured = { ...input, attachments: input.attachments.map((source) => ({ ...source, bytes: Uint8Array.from(source.bytes) })) };
  try { await recordGenerationInputs(captured, scope); }
  catch (error: unknown) {
    if (!(error instanceof EvidenceBudgetError)) throw error;
    return { result: err({ kind: "output_limit", phase: "code-derived-generation", message: "Generation input evidence capacity exhausted; no model attempt issued" }) };
  }
  const created = await createBatchContextDirectory();
  if (!created.ok) return { result: err({ kind: "invalid_files", phase: "code-derived-generation", message: created.error.message }) };
  let result: Result<unknown, OpencodeError>;
  let cleanup: Awaited<ReturnType<typeof cleanupBatchContext>>;
  try {
    const files = await writePrivateSources(created.value.directoryPath, captured.attachments);
    result = files.ok ? await callOpencode({ model: input.model, timeoutMs: input.timeoutMs, phase: "code-derived-generation",
      prompt: input.prompt, files: files.value, retries: 2, ...input.evidence?.modelHooks(scope, "code-derived-generation") }) : files;
    await input.evidence?.json(scope, "outcome", result.ok ? { kind: "success" } : { kind: "failure", error: result.error }, "code-derived-generation");
  } catch (error: unknown) {
    if (!(error instanceof EvidenceBudgetError)) throw error;
    result = err({ kind: "output_limit", phase: "code-derived-generation", message: "Generation outcome evidence capacity exhausted; generated scope withheld" });
  } finally { cleanup = await cleanupBatchContext(created.value); }
  return { result, ...(cleanup.state === "cleanup_failed" ? { cleanup: cleanup.detail } : {}) };
}

/** Evidence identities exclude randomized private paths; exact bytes are separately inspectable. */
async function recordGenerationInputs(input: {
  readonly model: string; readonly timeoutMs: number; readonly prompt: string;
  readonly attachments: readonly SourceAttachment[]; readonly suggestedCapabilities: readonly string[]; readonly evidence?: EvidenceRecorder;
}, scope: string): Promise<void> {
  const sources = [];
  for (let index = 0; index < input.attachments.length; index += 1) {
    const attachment = input.attachments[index]!;
    const file = await input.evidence?.bytes(`${scope}:source:${index}`, "source", attachment.bytes, "code-derived-generation");
    sources.push({ relativePath: attachment.relativePath, originalPath: attachment.absolutePath, bytes: attachment.bytes.byteLength,
      sha256: createHash("sha256").update(attachment.bytes).digest("hex"), ...(file === undefined ? {} : { artifact: file.path }) });
  }
  const request = { schemaVersion: 1, model: input.model, timeoutMs: input.timeoutMs, retries: 2, phase: "code-derived-generation",
    prompt: input.prompt, promptSha256: createHash("sha256").update(input.prompt, "utf8").digest("hex"), suggestedCapabilities: input.suggestedCapabilities, sources };
  await input.evidence?.json(scope, "request", { ...request, inputSha256: createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex") }, "code-derived-generation");
}

/** Exclusive private writes; malformed relative paths are expected transport failures. */
async function writePrivateSources(root: string, sources: readonly SourceAttachment[]): Promise<Result<readonly string[], OpencodeError>> {
  const files: string[] = [];
  try {
    for (const source of sources) {
      if (isAbsolute(source.relativePath) || source.relativePath.split(/[\\/]/u).some((part) => part === ".." || part === "")) throw new Error("Invalid relative source path");
      const path = join(root, source.relativePath);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, source.bytes, { flag: "wx", mode: 0o400 });
      files.push(path);
    }
    return { ok: true, value: files };
  } catch (error: unknown) {
    return err({ kind: "invalid_files", phase: "code-derived-generation", message: error instanceof Error ? error.message : "Private source attachment failed" });
  }
}
