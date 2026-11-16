/** Typed source formalization with one frozen discovery pass and durable attempt evidence. */
import type { Claim } from "../claim-graph.js";
import type { Finding } from "../findings.js";
import type { FormalizationCandidate, FormalizationError, FormalizationOutput } from "./formalization-types.js";
import type { BatchAttemptEvidence } from "./batch-transport.js";
import { groupFormalizationClaims, selectClaimLogicalFile, splitPhysicalBatches, type IndexedFormalizationClaim, type SemanticClaimGroup, type PhysicalBatch } from "./grouping.js";
import { DEFAULT_ANALYSIS, isRecord, type AnalysisConfig } from "./analysis-config.js";
import { discoverGroup, type DiscoveryInvoker } from "./concept-discovery.js";
import { createDiscoveryInvoker } from "../../adapters/concept-discovery.js";
import { invokePredicates, type PredicateInvocation } from "../../adapters/predicate-formalization.js";
import { lowerPredicates, predicateSlots, PredicatePreparation } from "./predicate-lowering.js";
import type { FrozenRegistry } from "./concepts.js";
import { EvidenceBudgetError, type EvidenceRecorder } from "./evidence.js";
import { err, ok, type Result } from "../result.js";
import { invariant } from "../assert.js";
import type { LogicIrClaim } from "../logic-ir.js";

const RECOVERY_ATTEMPTS_PER_SAMPLE = 3;

/** Run-confined writer state; immutable settings/preparation are owned separately by the caller. */
interface FormalizationResults {
  readonly candidates: Map<number, FormalizationCandidate>;
  readonly rejected: Map<number, { readonly raw: unknown; readonly reason: string }[]>;
  readonly errors: Map<number, FormalizationError>;
  readonly findings: Finding[];
  readonly batchAttempts: BatchAttemptEvidence[];
}

/** Per-run services and effective controls. Never stored globally or shared between invocations. */
interface FormalizationContext {
  readonly input: SourceFormalizationInput;
  readonly analysis: AnalysisConfig;
  readonly preparation: PredicatePreparation;
  readonly side: FrozenRegistry["side"];
}

/** Source call inputs; effects remain injectable for independent contract verification. */
export interface SourceFormalizationInput {
  readonly claims: readonly Claim[]; readonly model: string; readonly samplesPerClaim: number; readonly timeoutMs: number;
  readonly logicalFileByCapability: ReadonlyMap<string, string>; readonly maxBatchSize: number;
  readonly analysis?: AnalysisConfig; readonly evidence?: EvidenceRecorder; readonly side?: FrozenRegistry["side"]; readonly ordinal?: number;
  readonly discover?: DiscoveryInvoker;
  readonly configSource?: string;
  readonly invoke?: (context: string, scope: string) => Promise<PredicateInvocation>;
}

/**
 * Process source groups in fixed order. Serial evidence-producing admission makes
 * remaining-capacity outcomes independent of response completion scheduling.
 * Actual model/solver ceiling is a maximum, not a requirement to saturate it.
 * @returns Candidate/error partition and ordered findings/attempts; no model work for empty admission.
 * @throws Required persistence failures and broken programmer invariants, not model failures.
 * @remarks Controls/source eligibility are validated by formalizeClaims. Group-local capacity
 * refusal is retained as scope; candidate persistence precedes publication. Retries are bounded.
 * @example await formalizeSourceClaims({ ...input, maxBatchSize: 32 });
 */
export async function formalizeSourceClaims(input: SourceFormalizationInput): Promise<Result<FormalizationOutput, readonly FormalizationError[]>> {
  const context: FormalizationContext = { input, analysis: input.analysis ?? DEFAULT_ANALYSIS, preparation: new PredicatePreparation(), side: input.side ?? "specs_forward" };
  const initialAttempts = input.evidence?.modelAttempts() ?? 0;
  const initialSkipped = input.evidence?.skipped.length ?? 0;
  const results: FormalizationResults = { candidates: new Map(), rejected: new Map(), errors: new Map(), findings: [], batchAttempts: [] };
  let blockedModelGroups = 0;
  const groups = groupFormalizationClaims(input.claims, input.logicalFileByCapability);
  for (const group of groups) {
    try { if (!await processGroup(context, group, results)) blockedModelGroups += 1; }
    catch (error: unknown) {
      if (!(error instanceof EvidenceBudgetError)) throw error;
      for (const work of group.claims) if (!results.candidates.has(work.index)) results.errors.set(work.index, claimError(work, error.message));
      results.findings.push(finding(group.claims[0]!.claim, "formalization.capacity_limited", error.message));
    }
  }
  return ok({ candidates: [...results.candidates.values()].sort((a, b) => a.eligibleIndex - b.eligibleIndex), errors: [...results.errors.values()].sort((a, b) => (a.eligibleIndex ?? 0) - (b.eligibleIndex ?? 0)), findings: results.findings, batchAttempts: results.batchAttempts,
    allModelsSkipped: (blockedModelGroups > 0 && blockedModelGroups === groups.length) || (input.evidence !== undefined && input.evidence.modelAttempts() === initialAttempts && input.evidence.skipped.length > initialSkipped),
    ...(input.evidence === undefined ? {} : { evidenceFiles: input.evidence.files() }) });
}

/** Discover/freeze exactly once before group batches. False means invalid authored model scope.
 * @throws Required writes or capacity refusal; the parent owns per-group capacity handling.
 */
async function processGroup(context: FormalizationContext, group: SemanticClaimGroup<IndexedFormalizationClaim>, results: FormalizationResults): Promise<boolean> {
  const { input, side, analysis } = context;
  const root = `${side}:${input.ordinal ?? 0}:${group.logicalFile}`;
  const sourceClaims = input.claims.filter((claim) => (claim.kind === "requirement" || claim.kind === "scenario") && selectClaimLogicalFile(claim, input.logicalFileByCapability) === group.logicalFile);
  await input.evidence?.json(root, "sources", sourceClaims);
  const discovered = await discoverGroup({ group: group.logicalFile, side, claims: sourceClaims, analysis,
      ...(input.configSource === undefined ? {} : { configSource: input.configSource }),
      invoke: input.discover ?? createDiscoveryInvoker({ model: input.model, timeoutMs: input.timeoutMs,
        hooksForRequest: (request) => input.evidence?.modelHooks(`${root}:discovery:${request.ordinal}`) ?? {} }),
  });
  await input.evidence?.json(root, "registry", discovered.registry);
  await input.evidence?.json(root, "discovery", discovered.attempts);
  // Semantic groups are nonempty by admission; the first source anchors group diagnostics.
  const first = group.claims[0]!;
  for (const message of discovered.registry.issues) results.findings.push(finding(first.claim, "formalization.registry_issue", message));
  if (!discovered.authoredModelValid) {
    for (const work of group.claims) results.errors.set(work.index, claimError(work, "Invalid explicit group model blocks dependent formalization"));
    return false;
  }
  for (const batch of splitPhysicalBatches(group, input.maxBatchSize)) await processBatch(context, results, root, discovered.registry, batch);
  return true;
}

/** One physical batch followed by claim-local bounded recovery; publication order is stable. */
async function processBatch(context: FormalizationContext, results: FormalizationResults, root: string, registry: FrozenRegistry, batch: PhysicalBatch<IndexedFormalizationClaim>): Promise<void> {
  const scope = `${root}:batch:${batch.ordinal}`;
  const invoked = await perform(batch.claims, registry, scope, context.input);
  results.batchAttempts.push(invoked.evidence);
  const entries = indexedEntries(invoked.result, batch.claims);
  const mayRecover = invoked.result.ok || ["timeout", "invalid_json", "schema_validation_error"].includes(invoked.result.error.kind);
  for (const work of batch.claims) {
    const entryScope = `${scope}:claim:${work.index}`;
    if (entries.ok) {
      const raw = entries.value.get(work.index);
      const typed = lowerPredicates(raw, work.claim, work.index, registry, context.analysis.limits, context.preparation);
      await recordValidation(context.input.evidence, entryScope, work.index, registry.hash, typed);
      if (typed.ok) await acceptSample(context.input, results, entryScope, work, registry, typed.value, "initial");
      else rejectSample(results, work, raw, typed.error, "initial");
    } else await recordValidation(context.input.evidence, entryScope, work.index, registry.hash, err(entries.error));
    const have = results.candidates.get(work.index);
    const feedback = entries.ok ? "Return every required source predicate key, including trigger/guard keys, with the exact registry hash." : entries.error;
    await recoverClaimSamples(context, results, root, registry, work, mayRecover, feedback);
    const candidate = results.candidates.get(work.index);
    if (candidate === undefined) results.errors.set(work.index, claimError(work, "No valid typed source interpretation after bounded attempts"));
    else if (candidate.samples.length < context.input.samplesPerClaim) results.findings.push(finding(work.claim, "formalization.sample_shortfall", `Only ${candidate.samples.length} of ${context.input.samplesPerClaim} requested samples available`));
    invariant(have === undefined || results.candidates.get(work.index) !== undefined, "Existing candidate was revoked");
  }
}

/** Add samples without revoking candidates. Terminal model failures stop only this recovery loop.
 * @remarks Attempt budget is samplesPerClaim * 3; registry/preparation remain the group's frozen ones.
 */
async function recoverClaimSamples(context: FormalizationContext, results: FormalizationResults, root: string, registry: FrozenRegistry, work: IndexedFormalizationClaim, mayRecover: boolean, initialFeedback: string): Promise<void> {
  const { input } = context;
  let feedback = initialFeedback;
  for (let attempt = 0; mayRecover && (results.candidates.get(work.index)?.samples.length ?? 0) < input.samplesPerClaim && attempt < input.samplesPerClaim * RECOVERY_ATTEMPTS_PER_SAMPLE; attempt += 1) {
    const scope = `${root}:claim:${work.index}:sample:${attempt}`;
    const sampled = await perform([work], registry, scope, input, feedback);
    results.batchAttempts.push(sampled.evidence);
    const matched = indexedEntries(sampled.result, [work]);
    const typed = matched.ok ? lowerPredicates(matched.value.get(work.index), work.claim, work.index, registry, context.analysis.limits, context.preparation) : err(matched.error);
    await recordValidation(input.evidence, scope, work.index, registry.hash, typed);
    if (typed.ok) await acceptSample(input, results, scope, work, registry, typed.value, "additional");
    else {
      feedback = typed.error;
      rejectSample(results, work, matched.ok ? matched.value.get(work.index) : null, typed.error, "additional");
      if (!sampled.result.ok) break;
    }
  }
}

/** Persist normalized acceptance before exposing a candidate; required write errors propagate. */
async function acceptSample(input: SourceFormalizationInput, results: FormalizationResults, scope: string, work: IndexedFormalizationClaim, registry: FrozenRegistry, typed: LogicIrClaim, kind: "initial" | "additional"): Promise<void> {
  const { signature: _signature, registry: _registry, ...sample } = typed;
  await input.evidence?.json(scope, "accepted-ir", { source: work.claim.surface?.source, registryHash: registry.hash, sample });
  const existing = kind === "additional" ? results.candidates.get(work.index)?.samples ?? [] : [];
  results.candidates.set(work.index, { claim: work.claim, eligibleIndex: work.index, samples: [...existing, typed], invalidSamples: results.rejected.get(work.index) ?? [], registry });
}

/** Retain a rejected interpretation and optionally attach it to the existing candidate; no I/O. */
function rejectSample(results: FormalizationResults, work: IndexedFormalizationClaim, raw: unknown, reason: string, kind: "initial" | "additional"): void {
  const rejected = [...(results.rejected.get(work.index) ?? []), { raw, reason }];
  results.rejected.set(work.index, rejected);
  const existing = results.candidates.get(work.index);
  if (kind === "additional" && existing !== undefined) results.candidates.set(work.index, { ...existing, invalidSamples: rejected });
  results.findings.push(finding(work.claim, "formalization.invalid_sample", reason));
}

/** Write domain-validation status separately from pre-validation raw capture. */
async function recordValidation(evidence: EvidenceRecorder | undefined, scope: string, index: number, registryHash: string, typed: Result<LogicIrClaim, string>): Promise<void> {
  await evidence?.json(scope, "validation", { index, registryHash, outcome: typed.ok ? "accepted" : "rejected", reason: typed.ok ? null : typed.error });
}

/** Preserve authoritative eligible index and optional authored display ID in one terminal error. */
function claimError(work: IndexedFormalizationClaim, message: string): FormalizationError {
  return { eligibleIndex: work.index, ...(work.claim.id === undefined ? {} : { claimId: work.claim.id }), message };
}

/** Source-index envelope validation; malformed attribution never becomes a silent match. */
function indexedEntries(response: PredicateInvocation["result"], claims: readonly IndexedFormalizationClaim[]): Result<ReadonlyMap<number, unknown>, string> {
  if (!response.ok) return err(response.error.message);
  if (!isRecord(response.value) || !Array.isArray(response.value.formalizations) || response.value.formalizations.length !== claims.length) return err("Predicate envelope claim count mismatch");
  const allowed = new Set(claims.map((claim) => claim.index));
  const entries = new Map<number, unknown>();
  for (const entry of response.value.formalizations) {
    if (!isRecord(entry) || typeof entry.index !== "number" || !allowed.has(entry.index) || entries.has(entry.index)) return err("Missing, duplicate or unknown predicate index");
    entries.set(entry.index, entry);
  }
  return ok(entries);
}

/** Invoke a deterministic attached context and retain pointer-only attempt attribution. */
async function perform(claims: readonly IndexedFormalizationClaim[], registry: FrozenRegistry, scope: string, input: SourceFormalizationInput, feedback?: string): Promise<PredicateInvocation & { evidence: BatchAttemptEvidence }> {
  const context = JSON.stringify({ schemaVersion: 1, registry: { hash: registry.hash, signature: registry.signature, concepts: registry.concepts, background: registry.background },
    ...(feedback === undefined ? {} : { validationFeedback: feedback }),
    claims: claims.map((work) => ({ index: work.index, id: work.claim.id ?? null, source: work.claim.surface?.source,
      sourceContext: { subject: work.claim.surface?.clauses?.subject, form: work.claim.surface?.clauses?.form, scenarioKind: work.claim.surface?.scenarioKind },
      predicates: predicateSlots(work.claim) })),
  }, null, 2) + "\n";
  const contextFile = await input.evidence?.text(scope, "context", context, "formalization", undefined, "json");
  const invoked = input.invoke !== undefined ? await input.invoke(context, scope) : await invokePredicates(context, { model: input.model, timeoutMs: input.timeoutMs, ...input.evidence?.modelHooks(scope) });
  if (invoked.result.ok && Buffer.byteLength(JSON.stringify(invoked.result.value), "utf8") > (input.analysis ?? DEFAULT_ANALYSIS).limits.decodedBytes) {
    return { ...invoked, result: err({ kind: "output_limit", phase: "formalization", message: "Decoded predicate envelope exceeds analysis bounds" }), evidence: {
      batchKey: registry.group, claimIndexes: claims.map((work) => work.index), claimIds: claims.map((work) => work.claim.id ?? null), provenanceFiles: claims.map((work) => work.claim.provenance.file),
      contextSha256: invoked.contextSha256, promptVariant: "attached-context-v1", model: input.model, subBatchOrdinal: claims[0]?.index ?? 0, registryHash: registry.hash,
      ...(contextFile === undefined ? {} : { contextArtifact: contextFile.path }), ...(input.evidence === undefined ? {} : { responseArtifacts: input.evidence.filesForScope(scope) }),
      cleanup: invoked.cleanup, outcome: { kind: "model_failure", errorKind: "output_limit" },
    } };
  }
  const outcome: BatchAttemptEvidence["outcome"] = invoked.result.ok ? { kind: "success" } : { kind: "model_failure", errorKind: invoked.result.error.kind };
  const metadata: BatchAttemptEvidence = Object.freeze({ batchKey: registry.group, claimIndexes: Object.freeze(claims.map((work) => work.index)),
    claimIds: Object.freeze(claims.map((work) => work.claim.id ?? null)), provenanceFiles: Object.freeze(claims.map((work) => work.claim.provenance.file)),
    contextSha256: invoked.contextSha256, promptVariant: "attached-context-v1", model: input.model, subBatchOrdinal: claims[0]?.index ?? 0,
    registryHash: registry.hash, ...(contextFile === undefined ? {} : { contextArtifact: contextFile.path }),
    ...(input.evidence === undefined ? {} : { responseArtifacts: input.evidence.filesForScope(scope) }), cleanup: invoked.cleanup,
    outcome,
  });
  return { ...invoked, evidence: metadata };
}

/** Surface-linked formalization diagnostics preserve partial or unresolved analysis scope. */
function finding(claim: Claim, category: string, message: string): Finding {
  return { severity: "warning", category, provenance: claim.provenance, description: message,
    rationale: "Typed formalization or registry scope is incomplete; absence of solver findings is not evidence of correctness.", evidence: [{ kind: "source", value: claim.text }],
    ...(claim.id === undefined ? {} : { relatedClaimIdentifiers: [claim.id] }) };
}
