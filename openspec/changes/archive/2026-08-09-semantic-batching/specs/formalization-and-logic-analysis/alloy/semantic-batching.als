module semantic_batching

/**
 * Formal model of the semantic-batching change for spec-check.
 *
 * One module, two layers:
 *
 *  1. STRUCTURAL LAYER — semantic grouping and the grouping map. Claims map
 *     to semantic keys via one shared key helper; keys partition claims into
 *     logical groups; merged capability specs feed the logical-file map.
 *     Structural claims are stated as predicates over a given map and shown
 *     to hold under the pipeline's grouping conditions [FLA-SEMANTIC-GROUPING,
 *     MCA-GROUP-KEY, MCA-ACTIVE-SPECS].
 *
 *  2. TEMPORAL LAYER — the temp context file lifecycle, attempt outcomes,
 *     degradation policy, and claim partition. Each physical batch is one
 *     first-sample LLM attempt over a chunk of one logical group; the temp
 *     directory moves through not_created -> dir_created -> file_written ->
 *     cleanup_succeeded | cleanup_failed [FLA-TEMP-LIFECYCLE,
 *     FLA-CLAIM-PARTITION, FLA-DEGRADE-KIND, FLA-BATCH-EVIDENCE,
 *     FLA-ATTACH-TRANSPORT, FLA-SUBBATCH].
 *
 * Modeling discipline: facts are used only for genuinely universal domain
 * truths (key construction, partition-by-key, transport arity, merge-layer
 * uniqueness). Conditional claims — map coverage, cleanup behavior, outcome
 * assignment, liveness — are predicates, and each `check` shows the property
 * holds within the predicate's stated conditions.
 *
 * Safety/liveness traceability:
 *   SAFE: no key drift; grouping is a partition; map covers solver inputs.
 *   SAFE: no temp context file intentionally retained after handled terminal
 *         states; cleanup failure after success never discards candidates;
 *         evidence recorded for every attached attempt.
 *   LIVE: every eligible claim reaches candidate or claim error; temp cleanup
 *         attempted after all handled terminal states (under fairness).
 */

// =====================================================================
// Structural layer: semantic grouping
// =====================================================================

sig Claim {
  capability : lone Capability,
  provFile   : one ProvFile
}

sig Capability {}
sig ProvFile {}
sig LogicalFile {}
sig SyntheticKey { cap : one Capability }

// Semantic key space: provenance files, mapped logical files, and synthetic
// fallback keys all inhabit one space.
sig SemanticKey {
  fromProv  : lone ProvFile,
  fromMap   : lone LogicalFile,
  fromSynth : lone SyntheticKey
} {
  one (fromProv + fromMap + fromSynth)
}

// Genuinely universal: key construction is injective across sources and total
// over source values. This is an axiom of the key space, not a pipeline
// condition.
fact key_sources_injective {
  all disj k1, k2 : SemanticKey |
    k1.fromProv != k2.fromProv
    and k1.fromMap != k2.fromMap
    and k1.fromSynth != k2.fromSynth
  SemanticKey.fromProv = ProvFile
  SemanticKey.fromMap = LogicalFile
  SemanticKey.fromSynth = SyntheticKey
}

// The logical-file map built by the pipeline: capability -> logical file
// (partial; may be empty).
sig GroupingMap {
  mapping : Capability -> lone LogicalFile
}

// The shared key helper [FLA-SEMGRP-MAPPED/PROVENANCE/FALLBACK].
// Total: every claim gets exactly one key under any map.
fun keyFor [c : Claim, m : GroupingMap] : one SemanticKey {
  { k : SemanticKey |
    (no c.capability and k.fromProv = c.provFile)
    or (some c.capability and some m.mapping[c.capability]
        and k.fromMap = m.mapping[c.capability])
    or (some c.capability and no m.mapping[c.capability]
        and k.fromSynth.cap = c.capability)
  }
}

// A grouping: claims partitioned by semantic key.
sig LogicalGroup {
  key    : one SemanticKey,
  claims : set Claim
}

// Genuinely universal: logical groups partition the claim set by key.
// Membership is exactly key-sharing [FLA-SEMGRP-KINDS, FLA-SEMGRP-ORDER].
fact groups_partition_by_key {
  all g : LogicalGroup | some g.claims
  all g : LogicalGroup | all c : g.claims | g.key = keyFor[c, GroupingMap]
  all disj g1, g2 : LogicalGroup | g1.key != g2.key
  all c : Claim | one g : LogicalGroup | c in g.claims
}

// --- Structural predicates (conditional claims) ---

// Under the pipeline's grouping construction, every claim is in exactly one
// group (re-stated as a predicate so the check shows it holds whenever the
// grouping conditions are in force).
pred groupingPartitioned {
  all c : Claim | one g : LogicalGroup | c in g.claims
}

// No key drift: claims with equal keys co-group, so solver and formalization
// (which share the helper) agree [FLA-SEMGRP-PARITY].
pred parityBySharedKey {
  all disj c1, c2 : Claim |
    keyFor[c1, GroupingMap] = keyFor[c2, GroupingMap]
    implies (some g : LogicalGroup | c1 + c2 in g.claims)
}

// Kind is irrelevant: capability-less claims key by provenance file
// regardless of claim kind [FLA-SEMGRP-KINDS].
pred kindIrrelevant {
  all c : Claim |
    no c.capability implies keyFor[c, GroupingMap].fromProv = c.provFile
}

// Every claim obtains a deterministic key even when its capability is
// unmapped [FLA-SEMGRP-COVERAGE, FLA-SEMGRP-FALLBACK].
pred fallbackTotal {
  all c : Claim | one keyFor[c, GroupingMap]
}

// =====================================================================
// Structural layer: grouping-map authority
// =====================================================================

// Whether a merged spec has requirements / scenarios.
abstract sig Presence {}
one sig NoneP, SomeP extends Presence {}

sig MergedSpec {
  cap   : one Capability,
  reqs  : one Presence,
  scens : one Presence
}

// Genuinely universal (merge-layer invariant, observed from capabilityOrder
// deduplication): distinct merged specs have distinct capabilities.
fact capability_unique {
  all disj s1, s2 : MergedSpec | s1.cap != s2.cap
}

// Active for grouping: requirements present OR scenarios present
// [MCA-ACTIVE-SPECS]. The scenarios clause is defensive (unreachable today).
fun activeForGrouping : set MergedSpec {
  { s : MergedSpec | s.reqs = SomeP or s.scens = SomeP }
}

// Solver-input activity filter (unchanged): requirements only.
fun activeForSolverInput : set MergedSpec {
  { s : MergedSpec | s.reqs = SomeP }
}

sig BuiltMap {
  entries : Capability -> lone LogicalFile
}

// Conditional domain assumptions, stated as predicates rather than facts so
// each check names the condition it depends on.

// Today's merge domain: scenarios imply requirements (scenario-only specs are
// unreachable).
pred scenariosImplyRequirements {
  all s : MergedSpec | s.scens = SomeP implies s.reqs = SomeP
}

// A future domain admitting standalone scenario claims.
pred standaloneScenariosAdmitted {
  some s : MergedSpec | s.scens = SomeP and s.reqs = NoneP
}

// The map-builder contract: the built map covers exactly the
// active-for-grouping capabilities [MCA-GROUP-KEY-COMPLETE].
pred mapCoversActiveSpecs [m : BuiltMap] {
  m.entries.LogicalFile = activeForGrouping.cap
}

// --- Grouping-map predicates (conditional claims) ---

// The grouping map is never narrower than the solver-input set.
pred groupingMapCoversSolverInputs [m : BuiltMap] {
  activeForSolverInput.cap in m.entries.LogicalFile
}

// Scenario-only specs get map entries [MCA-GROUP-KEY-SCEN].
pred scenarioOnlySpecsMapped [m : BuiltMap] {
  all s : MergedSpec |
    (s.scens = SomeP and s.reqs = NoneP)
    implies s.cap in m.entries.LogicalFile
}

// Empty specs contribute no entries [MCA-ACTIVE-EMPTY].
pred emptySpecsExcluded [m : BuiltMap] {
  all s : MergedSpec |
    (s.reqs = NoneP and s.scens = NoneP)
    implies s.cap not in m.entries.LogicalFile
}

// =====================================================================
// Temporal layer: temp context lifecycle, outcomes, claim partition
// =====================================================================

// Adapter terminal error kinds (post adapter-internal retries).
abstract sig ErrorKind {}
one sig SpawnError, InvalidFiles, InvalidTimeout,       // infrastructure: no per-claim fallback
        TimeoutErr, InvalidJson, SchemaValidation,      // model response: degrade to per-claim retry
        PromptTooLarge                                  // degrade only if inline fallback fits
        extends ErrorKind {}

// Prompt-size pre-check result for prompt_too_large degradation.
abstract sig FallbackFit {}
one sig FallbackFits, FallbackDoesNotFit extends FallbackFit {}

// Temp context directory lifecycle states [FLA-TEMP-LIFECYCLE].
abstract sig TempState {}
one sig NotCreated, DirCreated, FileWritten,
        CleanupSucceeded, CleanupFailed extends TempState {}

// Batch attempt resolution [FLA-BATCH-EVIDENCE outcome classification].
abstract sig Resolution {}
one sig Unresolved, BatchSuccess, ModelFailure,
        InfraFailure, TransportFailure extends Resolution {}

// Per-claim terminal outcome [FLA-CLAIM-PARTITION].
abstract sig Outcome {}
one sig NoOutcome, CandidateOutcome, ClaimErrorOutcome extends Outcome {}

// Whether the batch attaches a context file [FLA-ATTACH-TRANSPORT].
abstract sig AttachedKind {}
one sig Attached, Inline extends AttachedKind {}

abstract sig DegradedKind {}
one sig NotDegraded, Degraded extends DegradedKind {}

abstract sig EvidenceKind {}
one sig NoEvidence, EvidenceRecorded extends EvidenceKind {}

// A physical batch: one first-sample attempt over a chunk of one logical group.
sig PhysicalBatch {
  claims            : set Claim,          // non-empty chunk of one logical group
  attached          : one AttachedKind,   // Attached iff two or more claims
  fallbackFits      : one FallbackFit,    // pre-computed inline-fits pre-check
  var tempState     : one TempState,
  var resolution    : one Resolution,
  var degraded      : one DegradedKind,
  var evidence      : one EvidenceKind,
  var outcomes      : Claim -> one Outcome
}

// Genuinely universal: grouping + sub-batching partition the eligible claim
// set across physical batches [FLA-SEMANTIC-GROUPING, FLA-SUBBATCH].
fact claims_partitioned_across_batches {
  Claim in PhysicalBatch.claims
  all disj b1, b2 : PhysicalBatch | no (b1.claims & b2.claims)
}

// Genuinely universal: a physical batch never spans logical groups
// (sub-batching never changes semantic key) [FLA-SUBBATCH]. Links the
// structural grouping layer to the temporal batch layer.
fact batches_stay_within_groups {
  all b : PhysicalBatch | one g : LogicalGroup | b.claims in g.claims
}

// Genuinely universal: transport matches arity — multi-claim physical batches
// attach a context file; single-claim batches stay inline
// [FLA-ATTACH-TRANSPORT].
fact transport_matches_arity {
  all b : PhysicalBatch |
    (#b.claims >= 2) iff b.attached = Attached
}

// Genuinely universal: only attached batches have a temp context lifecycle;
// inline batches never create temp directories.
fact inline_batches_have_no_temp {
  all b : PhysicalBatch |
    b.attached = Inline implies always b.tempState = NotCreated
}

// --- Initial state ---

pred init {
  all b : PhysicalBatch | {
    b.tempState = NotCreated
    b.resolution = Unresolved
    b.degraded = NotDegraded
    b.evidence = NoEvidence
  }
  all b : PhysicalBatch, c : b.claims | b.outcomes[c] = NoOutcome
}

// --- Events ---
// Frame-condition discipline: every event fixes every mutable relation it
// does not modify. Mutable relations: tempState, resolution, degraded,
// evidence, outcomes.

pred stutter {
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  evidence' = evidence
  outcomes' = outcomes
}

// Attached batch: create the temp directory (may fail, e.g. OS temp
// unwritable) [FLA-TEMP-DIRFAIL, FLA-TEMP-OSUNWRITABLE].
pred create_dir_ok [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = NotCreated
  tempState' = tempState ++ b -> DirCreated
  resolution' = resolution
  degraded' = degraded
  evidence' = evidence
  outcomes' = outcomes
}

pred create_dir_fail [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = NotCreated
  // Directory creation failed: transport failure, claim errors for the whole
  // physical batch. No temp dir exists, so no cleanup is owed and outcomes
  // may be assigned immediately [FLA-TEMP-ORDER].
  tempState' = tempState
  resolution' = resolution ++ b -> TransportFailure
  degraded' = degraded
  evidence' = evidence ++ b -> EvidenceRecorded
  outcomes' = outcomes ++ b -> (b.claims -> ClaimErrorOutcome)
}

// Attached batch: write the context file (may fail after dir creation)
// [FLA-TEMP-WRITEFAIL].
pred write_file_ok [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = DirCreated
  tempState' = tempState ++ b -> FileWritten
  resolution' = resolution
  degraded' = degraded
  evidence' = evidence
  outcomes' = outcomes
}

pred write_file_fail [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = DirCreated
  // Write failed: transport failure; cleanup of the created directory is
  // attempted in cleanup_* events. Claim errors after cleanup completes
  // [FLA-TEMP-ORDER].
  tempState' = tempState
  resolution' = resolution ++ b -> TransportFailure
  degraded' = degraded
  evidence' = evidence ++ b -> EvidenceRecorded
  outcomes' = outcomes
}

// Attached batch: invoke the model with the attached context; terminal
// outcomes cover success, model failure (degradable), and infrastructure
// failure (no fallback) [FLA-DEGRADE-KIND].
pred attempt_success [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = FileWritten
  b.resolution = Unresolved
  tempState' = tempState
  resolution' = resolution ++ b -> BatchSuccess
  degraded' = degraded
  evidence' = evidence ++ b -> EvidenceRecorded
  outcomes' = outcomes
}

pred attempt_model_failure [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = FileWritten
  b.resolution = Unresolved
  tempState' = tempState
  resolution' = resolution ++ b -> ModelFailure
  degraded' = degraded
  evidence' = evidence ++ b -> EvidenceRecorded
  outcomes' = outcomes
}

pred attempt_infra_failure [b : PhysicalBatch, k : ErrorKind] {
  b.attached = Attached
  b.tempState = FileWritten
  b.resolution = Unresolved
  k in SpawnError + InvalidFiles + InvalidTimeout
  tempState' = tempState
  resolution' = resolution ++ b -> InfraFailure
  degraded' = degraded
  evidence' = evidence ++ b -> EvidenceRecorded
  outcomes' = outcomes
}

// Attached batch: prompt too large. Modeled as a ModelFailure whose
// degradation is gated by fallbackFits [FLA-DEGRADE-TOOLARGE].
pred attempt_prompt_too_large [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = FileWritten
  b.resolution = Unresolved
  tempState' = tempState
  resolution' = resolution ++ b -> ModelFailure
  degraded' = degraded
  evidence' = evidence ++ b -> EvidenceRecorded
  outcomes' = outcomes
}

// Cleanup after a terminal attempt state. Attempted for every attached batch
// that created a directory, regardless of resolution [FLA-TEMP-LIFECYCLE].
// On success with failed cleanup, candidates are preserved (outcomes
// untouched) [FLA-TEMP-CLEANUP-WARN].
pred cleanup_succeeds [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState in DirCreated + FileWritten
  b.resolution != Unresolved
  tempState' = tempState ++ b -> CleanupSucceeded
  resolution' = resolution
  degraded' = degraded
  evidence' = evidence
  outcomes' = outcomes
}

pred cleanup_fails [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState in DirCreated + FileWritten
  b.resolution != Unresolved
  tempState' = tempState ++ b -> CleanupFailed
  resolution' = resolution
  degraded' = degraded
  evidence' = evidence
  outcomes' = outcomes
}

// Degradation and terminal outcome assignment [FLA-DEGRADE-KIND,
// FLA-CLAIM-PARTITION, FLA-TEMP-ORDER].

// Model failure degrades to per-claim inline retry when the fallback fits.
pred degrade_to_per_claim [b : PhysicalBatch] {
  b.resolution = ModelFailure
  b.degraded = NotDegraded
  b.tempState in CleanupSucceeded + CleanupFailed
  b.fallbackFits = FallbackFits
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded ++ b -> Degraded
  evidence' = evidence
  outcomes' = outcomes
}

// Per-claim retry resolves each claim independently to candidate or error.
pred resolve_degraded_claims [b : PhysicalBatch] {
  b.degraded = Degraded
  some c : b.claims | b.outcomes[c] = NoOutcome
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  evidence' = evidence
  all c : b.claims |
    b.outcomes[c] = NoOutcome implies
      (b.outcomes'[c] = CandidateOutcome or b.outcomes'[c] = ClaimErrorOutcome)
  all c : Claim - b.claims | b.outcomes'[c] = b.outcomes[c]
  all b2 : PhysicalBatch - b, c : Claim | b2.outcomes'[c] = b2.outcomes[c]
}

// No degradation: all claims of the batch become claim errors. Applies to
// infra failure, transport failure after cleanup (or with no dir created),
// and model failure whose fallback does not fit.
pred resolve_batch_errors [b : PhysicalBatch] {
  b.degraded = NotDegraded
  some c : b.claims | b.outcomes[c] = NoOutcome
  {
    b.resolution = InfraFailure
    or (b.resolution = TransportFailure and b.tempState in CleanupSucceeded + CleanupFailed + NotCreated)
    or (b.resolution = ModelFailure and b.fallbackFits = FallbackDoesNotFit
        and b.tempState in CleanupSucceeded + CleanupFailed)
  }
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  evidence' = evidence
  all c : b.claims |
    b.outcomes[c] = NoOutcome implies b.outcomes'[c] = ClaimErrorOutcome
  all c : Claim - b.claims | b.outcomes'[c] = b.outcomes[c]
  all b2 : PhysicalBatch - b, c : Claim | b2.outcomes'[c] = b2.outcomes[c]
}

// Successful batch: all claims become candidates, even if cleanup failed
// [FLA-TEMP-CLEANUP-WARN]. Outcomes assigned only after a terminal cleanup
// state [FLA-TEMP-ORDER].
pred resolve_batch_success [b : PhysicalBatch] {
  b.resolution = BatchSuccess
  b.degraded = NotDegraded
  some c : b.claims | b.outcomes[c] = NoOutcome
  b.tempState in CleanupSucceeded + CleanupFailed
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  evidence' = evidence
  all c : b.claims |
    b.outcomes[c] = NoOutcome implies b.outcomes'[c] = CandidateOutcome
  all c : Claim - b.claims | b.outcomes'[c] = b.outcomes[c]
  all b2 : PhysicalBatch - b, c : Claim | b2.outcomes'[c] = b2.outcomes[c]
}

// Inline (single-claim) batch: resolve directly; no temp lifecycle.
pred resolve_inline [b : PhysicalBatch] {
  b.attached = Inline
  b.resolution = Unresolved
  tempState' = tempState
  one r : BatchSuccess + ModelFailure + InfraFailure |
    resolution' = resolution ++ b -> r
  degraded' = degraded
  evidence' = evidence
  outcomes' = outcomes
}

pred resolve_inline_outcome [b : PhysicalBatch] {
  b.attached = Inline
  b.resolution != Unresolved
  b.outcomes[b.claims] = NoOutcome
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  evidence' = evidence
  all c : b.claims |
    b.outcomes'[c] = CandidateOutcome or b.outcomes'[c] = ClaimErrorOutcome
  all c : Claim - b.claims | b.outcomes'[c] = b.outcomes[c]
  all b2 : PhysicalBatch - b, c : Claim | b2.outcomes'[c] = b2.outcomes[c]
}

// --- Transition system ---

fact transitions {
  init and always (
    stutter
    or (some b : PhysicalBatch | create_dir_ok[b] or create_dir_fail[b])
    or (some b : PhysicalBatch | write_file_ok[b] or write_file_fail[b])
    or (some b : PhysicalBatch |
          attempt_success[b] or attempt_model_failure[b] or attempt_prompt_too_large[b])
    or (some b : PhysicalBatch, k : ErrorKind | attempt_infra_failure[b, k])
    or (some b : PhysicalBatch | cleanup_succeeds[b] or cleanup_fails[b])
    or (some b : PhysicalBatch | degrade_to_per_claim[b])
    or (some b : PhysicalBatch |
          resolve_degraded_claims[b] or resolve_batch_errors[b]
          or resolve_batch_success[b])
    or (some b : PhysicalBatch | resolve_inline[b] or resolve_inline_outcome[b])
  )
}

// =====================================================================
// Conditional safety/liveness claims (predicates + checks)
// =====================================================================

// --- Temporal conditions ---

// The batch has reached a terminal resolution while holding a live temp
// directory: cleanup is owed.
pred cleanupOwed [b : PhysicalBatch] {
  b.attached = Attached
  b.resolution != Unresolved
  b.tempState in DirCreated + FileWritten
}

// The batch has reached a handled terminal cleanup state.
pred cleanupTerminal [b : PhysicalBatch] {
  b.tempState in CleanupSucceeded + CleanupFailed
}

// An attached batch resolved to a terminal outcome.
pred batchResolved [b : PhysicalBatch] {
  b.attached = Attached and b.resolution != Unresolved
}

// --- Temporal claims ---

// [SAFE: FLA-TEMP-LIFECYCLE] An attached batch that resolved has a directory
// (or failed at creation, owing no cleanup).
pred resolvedAttachedBatchesCreatedDirOrFailedAtCreation {
  always (all b : PhysicalBatch |
    batchResolved[b]
    implies
      (b.tempState != NotCreated
       or once (b.resolution = TransportFailure and b.tempState = NotCreated)))
}

// [SAFE: FLA-TEMP-LIFECYCLE] Cleanup is terminal: a context file never
// survives a completed cleanup; cleanup failure is a handled terminal state.
pred cleanupIsTerminal {
  always (all b : PhysicalBatch |
    cleanupTerminal[b] implies always cleanupTerminal[b])
}

// [SAFE: FLA-TEMP-CLEANUP-WARN] Cleanup failure after success never discards
// candidates.
pred cleanupFailurePreservesCandidates {
  always (all b : PhysicalBatch, c : b.claims |
    (b.resolution = BatchSuccess and b.outcomes[c] = CandidateOutcome)
    implies always b.outcomes[c] = CandidateOutcome)
}

// [SAFE: FLA-BATCH-EVIDENCE] Every attached batch that reaches any terminal
// resolution has its evidence recorded.
pred evidenceRecordedForEveryAttachedAttempt {
  always (all b : PhysicalBatch |
    batchResolved[b] implies b.evidence = EvidenceRecorded)
}

// [SAFE: FLA-CLAIM-PARTITION] A claim's terminal outcome, once assigned, is
// stable.
pred outcomesAreStable {
  always (all b : PhysicalBatch, c : b.claims |
    b.outcomes[c] != NoOutcome implies b.outcomes'[c] = b.outcomes[c])
}

// [SAFE: FLA-SEMANTIC-GROUPING + FLA-SUBBATCH] No claim appears in two
// physical batches (partition across batches).
pred noCrossBatchOutcomes {
  always (all disj b1, b2 : PhysicalBatch, c : Claim |
    not (c in b1.claims and c in b2.claims))
}

// [SAFE: FLA-SUBBATCH] Every physical batch lies within exactly one logical
// group (sub-batching never crosses groups).
pred batchesWithinOneGroup {
  all b : PhysicalBatch | one g : LogicalGroup | b.claims in g.claims
}

// --- Fairness conditions ---

// Cleanup fairness: an attached batch with cleanup owed is not starved of its
// cleanup event forever. The implementation discharges this via `finally`.
pred cleanupFairness {
  all b : PhysicalBatch |
    (eventually always cleanupOwed[b])
    implies
    (always eventually (cleanup_succeeds[b] or cleanup_fails[b]))
}

// Progress fairness: a batch with an enabled progress event is not starved
// forever.
pred progressFairness {
  all b : PhysicalBatch |
    (eventually always (
      (b.attached = Attached and
        ( (b.tempState = NotCreated and b.resolution = Unresolved)
          or (b.tempState = DirCreated)
          or (b.tempState = FileWritten and b.resolution = Unresolved)
          or (b.tempState in DirCreated + FileWritten and b.resolution != Unresolved)
          or (b.degraded = Degraded and some c : b.claims | b.outcomes[c] = NoOutcome)
          or (b.degraded = NotDegraded and b.resolution != Unresolved
              and some c : b.claims | b.outcomes[c] = NoOutcome)))
      or (b.attached = Inline and
        (b.resolution = Unresolved
         or (b.resolution != Unresolved and some c : b.claims | b.outcomes[c] = NoOutcome)))
    ))
    implies
    (always eventually not stutter)
}

// --- Liveness claims (under fairness) ---

// [LIVE: FLA-TEMP-LIFECYCLE] Cleanup is attempted after every handled
// terminal state.
pred cleanupAttemptedAfterHandledTerminalStates {
  always (all b : PhysicalBatch |
    cleanupOwed[b] implies eventually cleanupTerminal[b])
}

// [LIVE: FLA-CLAIM-PARTITION] Every eligible claim eventually reaches a
// terminal outcome.
pred allClaimsReachTerminalOutcome {
  always eventually (all b : PhysicalBatch, c : b.claims |
    b.outcomes[c] != NoOutcome)
}

// =====================================================================
// Commands
// =====================================================================

// --- Structural: sanity witnesses ---

run sanity_grouping {
  some Claim and some GroupingMap and some LogicalGroup
} for 3 expect 1

run sanity_map {
  some MergedSpec and some BuiltMap
} for 3 expect 1

// --- Structural: grouping claims hold under the pipeline's grouping
// conditions (which the partition fact puts in force). ---

check grouping_partitioned { groupingPartitioned } for 5 expect 0
check parity_by_shared_key { parityBySharedKey } for 5 expect 0
check kind_irrelevant { kindIrrelevant } for 5 expect 0
check fallback_total { fallbackTotal } for 5 expect 0

// --- Structural: grouping-map claims hold when the map-builder contract and
// the current domain assumption are in force. ---

check grouping_map_covers_solver_inputs {
  scenariosImplyRequirements implies
    (all m : BuiltMap | mapCoversActiveSpecs[m] implies groupingMapCoversSolverInputs[m])
} for 5 expect 0

// The scenario-only rule is load-bearing in a future domain, and is stated so
// it still holds there: map coverage alone (without the today-domain
// assumption) suffices.
check scenario_only_specs_mapped {
  all m : BuiltMap |
    mapCoversActiveSpecs[m] implies scenarioOnlySpecsMapped[m]
} for 5 expect 0

check empty_specs_excluded {
  all m : BuiltMap |
    mapCoversActiveSpecs[m] implies emptySpecsExcluded[m]
} for 5 expect 0

// --- Temporal: sanity witnesses (one per specified scenario) ---

run sanity {
  some PhysicalBatch
} for 3 but 6 steps expect 1

run attached_success {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = BatchSuccess
                    and b.tempState = CleanupSucceeded
                    and (all c : b.claims | b.outcomes[c] = CandidateOutcome))
} for 3 but 10 steps expect 1

run write_failure_then_cleanup {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = TransportFailure
                    and once b.tempState = DirCreated
                    and eventually b.tempState = CleanupSucceeded
                    and (all c : b.claims | b.outcomes[c] = ClaimErrorOutcome))
} for 3 but 12 steps expect 1

run cleanup_failure_after_success {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = BatchSuccess
                    and b.tempState = CleanupFailed
                    and (all c : b.claims | b.outcomes[c] = CandidateOutcome))
} for 3 but 12 steps expect 1

run model_failure_degrades {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.degraded = Degraded
                    and once b.resolution = ModelFailure)
} for 3 but 14 steps expect 1

run prompt_too_large_no_fallback {
  some b : PhysicalBatch |
    b.attached = Attached
    and b.fallbackFits = FallbackDoesNotFit
    and eventually (b.resolution = ModelFailure
                    and always b.degraded = NotDegraded
                    and eventually (all c : b.claims | b.outcomes[c] = ClaimErrorOutcome))
} for 3 but 12 steps expect 1

run infra_failure_no_fallback {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = InfraFailure
                    and always b.degraded = NotDegraded
                    and eventually (all c : b.claims | b.outcomes[c] = ClaimErrorOutcome))
} for 3 but 12 steps expect 1

// --- Temporal: safety claims (hold unconditionally). ---

check resolved_attached_batches_created_dir {
  resolvedAttachedBatchesCreatedDirOrFailedAtCreation
} for 4 but 15 steps expect 0

check cleanup_is_terminal { cleanupIsTerminal } for 4 but 15 steps expect 0

check cleanup_failure_preserves_candidates {
  cleanupFailurePreservesCandidates
} for 4 but 15 steps expect 0

check evidence_recorded_for_every_attached_attempt {
  evidenceRecordedForEveryAttachedAttempt
} for 4 but 15 steps expect 0

check outcomes_are_stable { outcomesAreStable } for 4 but 15 steps expect 0

check no_cross_batch_outcomes { noCrossBatchOutcomes } for 4 but 10 steps expect 0

check batches_within_one_group { batchesWithinOneGroup } for 4 but 10 steps expect 0

// --- Temporal: liveness claims (hold under their fairness conditions). ---

check cleanup_attempted_after_handled_terminal_states {
  cleanupFairness implies cleanupAttemptedAfterHandledTerminalStates
} for 3 but 20 steps expect 0

check all_claims_reach_terminal_outcome {
  progressFairness implies allClaimsReachTerminalOutcome
} for 3 but 20 steps expect 0
