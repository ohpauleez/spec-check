/** Single-writer bounded evidence coordination; filesystem effects are injected. */
import { createHash } from "node:crypto";
import type { OpencodeCallOptions, OpencodeEvidenceEvent } from "../../adapters/opencode.js";

/** Required persistence failures are fatal output errors, never model retries. */
export class EvidencePersistenceError extends Error {
  readonly category = "OutputError";
  constructor(readonly path: string, cause?: unknown) {
    super(`Required evidence could not be finalized: ${path}`, { cause });
    this.name = "EvidencePersistenceError";
  }
}

/** Expected admission refusal; work must be skipped before an unrecordable attempt. */
export class EvidenceBudgetError extends Error {
  constructor(readonly scope: string) { super(`Evidence capacity exhausted for ${scope}`); this.name = "EvidenceBudgetError"; }
}

/** Ordinary manifest descriptor for a completed confined artifact. */
export interface SemanticEvidenceFile { readonly path: string; readonly checksum: string; readonly phase: string }

/** Injection point for existing confined atomic filesystem writes. */
export type EvidenceWrite = (path: string, content: string | Uint8Array) => Promise<void>;

/** Maximum serialized capture envelope from the bounded 8-MiB raw process output. */
const MODEL_ATTEMPT_RESERVATION = 16_777_216;

/** Run-local ledger owns reservations and descriptor ordering; no mutable global state. */
export class EvidenceRecorder {
  private readonly descriptors = new Map<string, SemanticEvidenceFile>();
  private readonly tickets = new Map<string, number>();
  private readonly scopes = new Map<string, Set<string>>();
  private reservedTotal = 0;
  private used = 0;
  private capturedAttempts = 0;
  private readonly recordOrdinals = new Map<string, number>();
  readonly skipped: { readonly scope: string; readonly reason: string }[] = [];

  constructor(readonly maxBytes: number, private readonly write: EvidenceWrite) {}

  /** Reserve an upper bound before a process is spawned. */
  reserve(scope: string, bytes: number): boolean {
    if (this.tickets.has(scope) || !Number.isSafeInteger(bytes) || bytes < 0 || this.used + this.reservedTotal + bytes > this.maxBytes) {
      this.skipped.push({ scope, reason: "evidence capacity" }); return false;
    }
    this.tickets.set(scope, bytes); this.reservedTotal += bytes; return true;
  }

  /** Release unused reservation after all required attempt status is finalized. */
  release(scope: string): void {
    this.reservedTotal -= this.tickets.get(scope) ?? 0;
    this.tickets.delete(scope);
  }
  /** Count actual spawn attempts, distinct from budget-refused logical calls. */
  modelAttempts(): number { return this.capturedAttempts; }

  /** Stable artifact descriptors are ordered by path, not worker completion time. */
  files(): readonly SemanticEvidenceFile[] { return [...this.descriptors.values()].sort((a, b) => a.path.localeCompare(b.path)); }
  /** Resolve captured attempts back to their source-owned logical call scope. */
  filesForScope(scope: string): readonly string[] { return [...(this.scopes.get(scope) ?? [])].sort(); }

  /** Allocate metadata-only identity in run admission order, without charging solver plans.
   * @remarks Callers bound records by admitted work. Separate invocations never share counters.
   */
  nextRecordScope(scope: string): string {
    const ordinal = this.recordOrdinals.get(scope) ?? 0;
    this.recordOrdinals.set(scope, ordinal + 1);
    return `${scope}:record:${ordinal}`;
  }

  /** Serialize normalized semantic data separately from exact text artifacts. */
  async json(scope: string, kind: string, value: unknown, phase = "formalization", ticket?: string): Promise<SemanticEvidenceFile> {
    return await this.text(scope, kind, JSON.stringify(value, null, 2) + "\n", phase, ticket, "json");
  }

  /** Finalize one exact artifact; duplicate logical keys may not overwrite evidence. */
  async text(scope: string, kind: string, content: string, phase = "logic", ticket?: string, extension = "txt"): Promise<SemanticEvidenceFile> {
    return await this.artifact(scope, kind, content, phase, ticket, extension);
  }

  /** Persist exact raw bytes, including non-UTF-8 process output. */
  async bytes(scope: string, kind: string, content: Uint8Array, phase = "formalization", ticket?: string): Promise<SemanticEvidenceFile> {
    return await this.artifact(scope, kind, content, phase, ticket, "bin");
  }

  /** Account in-flight bytes before awaiting a write so concurrent admission is safe. */
  private async artifact(scope: string, kind: string, content: string | Uint8Array, phase: string, ticket: string | undefined, extension: string): Promise<SemanticEvidenceFile> {
    const key = createHash("sha256").update(scope, "utf8").digest("hex");
    const path = `semantic_evidence/${key}.${kind.replace(/[^a-z0-9-]/giu, "_")}.${extension}`;
    const checksum = typeof content === "string" ? createHash("sha256").update(content, "utf8").digest("hex") : createHash("sha256").update(content).digest("hex");
    const old = this.descriptors.get(path);
    if (old !== undefined) {
      if (old.checksum !== checksum) throw new EvidencePersistenceError(path, new Error("Logical evidence key reused with different bytes"));
      return old;
    }
    const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
    if (ticket !== undefined) {
      const remaining = this.tickets.get(ticket);
      if (remaining === undefined || remaining < bytes) throw new EvidencePersistenceError(path, new Error("Reserved capture capacity was insufficient"));
      this.tickets.set(ticket, remaining - bytes);
      this.reservedTotal -= bytes;
      this.used += bytes;
    } else if (!this.reserve(path, bytes)) throw new EvidenceBudgetError(scope);
    try { await this.write(path, content); }
    catch (cause: unknown) { throw new EvidencePersistenceError(path, cause); }
    if (ticket === undefined) { this.used += bytes; this.release(path); }
    const descriptor = Object.freeze({ path, checksum, phase });
    this.descriptors.set(path, descriptor);
    // Index every literal colon-delimited prefix: preserve exact descendant
    // semantics even when a group/file name itself contains colons.
    const prefixes = [scope];
    for (let index = 0; index < scope.length; index += 1) if (scope[index] === ":") prefixes.push(scope.slice(0, index));
    for (const prefix of prefixes) {
      let paths = this.scopes.get(prefix);
      if (paths === undefined) { paths = new Set(); this.scopes.set(prefix, paths); }
      paths.add(path);
    }
    return descriptor;
  }

  /** Capture every attempt before validation and release its reservation after status. */
  modelHooks(scope: string, phase = "formalization"): Pick<OpencodeCallOptions, "beforeAttempt" | "captureEvidence"> {
    const ticket = (attempt: number): string => `${scope}:attempt:${attempt}`;
    return {
      beforeAttempt: (attempt) => this.reserve(ticket(attempt), MODEL_ATTEMPT_RESERVATION),
      captureEvidence: async (event: OpencodeEvidenceEvent) => {
        const id = ticket(event.attempt);
        if (event.kind === "captured") {
          this.capturedAttempts += 1;
          const prompt = await this.text(id, "prompt", event.prompt, phase, id);
          if (event.process !== undefined) {
            const { stdout, stderr, stdoutBase64, stderrBase64, ...status } = event.process;
            const out = await this.bytes(id, "stdout", Buffer.from(stdoutBase64 ?? Buffer.from(stdout, "utf8").toString("base64"), "base64"), phase, id);
            const error = await this.bytes(id, "stderr", Buffer.from(stderrBase64 ?? Buffer.from(stderr, "utf8").toString("base64"), "base64"), phase, id);
            await this.json(id, "captured", { kind: event.kind, attempt: event.attempt, phase: event.phase, model: event.model, runtime: event.runtime,
              scope: id, prompt: prompt.path, process: status, stdout: out.path, stderr: error.path,
              exactBytes: stdoutBase64 !== undefined && stderrBase64 !== undefined,
            }, phase, id);
          } else await this.json(id, "captured", { ...event, scope: id, prompt: prompt.path }, phase, id);
        } else await this.json(id, event.kind, { ...event, scope: id }, phase, id);
        if (event.kind === "classified") this.release(id);
      },
    };
  }
}
