module semantic_batching

/**
 * Formal model of the semantic-batching change for spec-check: the temp
 * context file lifecycle, attached-batch attempt outcomes, and the
 * claim-partition (terminal outcome) property.
 *
 * This is a behavioral (temporal) model. Each PhysicalBatch models one
 * first-sample LLM attempt over a chunk of one logical group. The temp
 * context directory for an attached batch moves through the explicit
 * lifecycle not_created -> dir_created -> file_written -> cleanup_succeeded |
 * cleanup_failed. Attempts resolve to success, model failure, or
 * infrastructure/transport failure; model failures may degrade to bounded
 * per-claim retry. Claims are partitioned into terminal outcomes (candidate
 * or claim error) once their batch resolves.
 *
 * Spec references:
 *   [FLA-TEMP-LIFECYCLE], [FLA-CLAIM-PARTITION], [FLA-DEGRADE-KIND],
 *   [FLA-BATCH-EVIDENCE], [FLA-ATTACH-TRANSPORT], [FLA-SUBBATCH]
 *
 * Safety/liveness traceability:
 *   SAFE: no temp context file intentionally retained after handled terminal
 *         states   (assert cleanup_attempted_after_handled_terminal_states)
 *   SAFE: cleanup failure after success never discards candidates
 *         (assert cleanup_failure_preserves_candidates)
 *   SAFE: evidence recorded for every attached attempt
 *         (assert evidence_recorded_for_every_attached_attempt)
 *   LIVE: every eligible claim reaches candidate or claim error
 *         (assert all_claims_reach_terminal_outcome, under fairness)
 *   LIVE: temp cleanup attempted after all handled terminal states
 *         (assert cleanup_attempted_after_handled_terminal_states)
 */

// --- Domain vocabulary ---

sig Claim {}

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

// Whether the batch attaches a context file [FLA-ATTACH-TRANSPORT].
abstract sig AttachedKind {}
one sig Attached, Inline extends AttachedKind {}

abstract sig DegradedKind {}
one sig NotDegraded, Degraded extends DegradedKind {}

abstract sig EvidenceKind {}
one sig NoEvidence, EvidenceRecorded extends EvidenceKind {}

// --- Domain facts ---

// Every claim belongs to exactly one physical batch: grouping + sub-batching
// partition the eligible claim set [FLA-SEMANTIC-GROUPING, FLA-SUBBATCH].
fact claims_partitioned_across_batches {
  Claim in PhysicalBatch.claims
  all disj b1, b2 : PhysicalBatch | no (b1.claims & b2.claims)
}

// Transport decision: multi-claim physical batches attach a context file;
// single-claim batches stay inline [FLA-ATTACH-TRANSPORT].
fact transport_matches_arity {
  all b : PhysicalBatch |
    (#b.claims >= 2) iff b.attached = Attached
}

// Only attached batches have a temp context lifecycle; inline batches never
// create temp directories.
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
    b.outcomes = Claim -> NoOutcome   // overridden per batch below
  }
  // No claim has an outcome initially.
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
  // physical batch. No temp dir exists, so no cleanup is owed.
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
  // attempted in cleanup_* events. Claim errors after cleanup completes.
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

// Attached batch: prompt too large. Degrade only when every per-claim inline
// prompt fits the adapter prompt-size limit; otherwise immediate claim errors
// [FLA-DEGRADE-TOOLARGE]. Modeled as: transport resolution PromptTooLarge is
// folded into ModelFailure; the pre-check result is fallbackFits.
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

// Cleanup after a terminal attempt state. Cleanup is attempted for every
// attached batch that created a directory, regardless of resolution
// [FLA-TEMP-LIFECYCLE]. On success with failed cleanup, candidates are
// preserved and a warning is recorded (modeled as cleanup state only; the
// outcomes relation is untouched) [FLA-TEMP-CLEANUP-WARN].
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

// Degradation decisions after cleanup, and terminal outcome assignment
// [FLA-DEGRADE-KIND, FLA-CLAIM-PARTITION].

// Model failure degrades to per-claim inline retry when allowed.
pred degrade_to_per_claim [b : PhysicalBatch] {
  b.resolution = ModelFailure
  b.degraded = NotDegraded
  b.tempState in CleanupSucceeded + CleanupFailed
  // prompt_too_large degrades only when the inline fallback fits; other model
  // failures always degrade. We do not distinguish which model failure kind
  // occurred; the fallbackFits field conservatively gates degradation.
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
  // Each unresolved claim gets a terminal outcome (candidate or claim error).
  all c : b.claims |
    b.outcomes[c] = NoOutcome implies
      (b.outcomes'[c] = CandidateOutcome or b.outcomes'[c] = ClaimErrorOutcome)
  all c : Claim - b.claims | b.outcomes'[c] = b.outcomes[c]
  all b2 : PhysicalBatch - b, c : Claim | b2.outcomes'[c] = b2.outcomes[c]
}

// No degradation (infra failure, transport failure after cleanup, prompt too
// large without fitting fallback, or model failure where fallback does not
// fit): all claims of the batch become claim errors.
pred resolve_batch_errors [b : PhysicalBatch] {
  b.degraded = NotDegraded
  some c : b.claims | b.outcomes[c] = NoOutcome
  {
    // Terminal states that resolve directly to claim errors:
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

// Successful batch: all claims become candidates (invalid samples are a
// validation-phase concern, out of scope here).
pred resolve_batch_success [b : PhysicalBatch] {
  b.resolution = BatchSuccess
  b.degraded = NotDegraded
  some c : b.claims | b.outcomes[c] = NoOutcome
  // Candidates are assigned even if cleanup failed [FLA-TEMP-CLEANUP-WARN].
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
  // Inline batches still produce a resolution classification for evidence.
  resolution' = resolution ++ b ->
    (BatchSuccess + ModelFailure + InfraFailure)
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

// --- Safety assertions ---

// [SAFE: FLA-TEMP-LIFECYCLE] Structural safety: an attached batch that has
// reached a terminal resolution is never in NotCreated (a directory was
// created for every resolved attached batch except dir-creation transport
// failures, which owe no cleanup).
assert resolved_attached_batches_created_dir_or_failed_at_creation {
  always (all b : PhysicalBatch |
    (b.attached = Attached and b.resolution != Unresolved)
    implies
      (b.tempState != NotCreated
       or once (b.resolution = TransportFailure and b.tempState = NotCreated)))
}

// [SAFE: FLA-TEMP-LIFECYCLE] A context file never survives a completed
// cleanup: once cleanup succeeds, the batch never returns to a live temp
// state. (Cleanup failure is a terminal handled state, retained as
// diagnostic evidence.)
assert cleanup_is_terminal {
  always (all b : PhysicalBatch |
    b.tempState in CleanupSucceeded + CleanupFailed
    implies always (b.tempState in CleanupSucceeded + CleanupFailed))
}

// [SAFE: FLA-TEMP-CLEANUP-WARN] Cleanup failure after success never discards
// candidates: outcomes assigned under BatchSuccess survive regardless of the
// final cleanup state.
assert cleanup_failure_preserves_candidates {
  always (all b : PhysicalBatch, c : b.claims |
    (b.resolution = BatchSuccess and b.outcomes[c] = CandidateOutcome)
    implies always b.outcomes[c] = CandidateOutcome)
}

// [SAFE: FLA-BATCH-EVIDENCE] Every attached batch that reaches any terminal
// resolution has its evidence recorded.
assert evidence_recorded_for_every_attached_attempt {
  always (all b : PhysicalBatch |
    (b.attached = Attached and b.resolution != Unresolved)
    implies b.evidence = EvidenceRecorded)
}

// [SAFE: FLA-CLAIM-PARTITION] A claim's terminal outcome, once assigned, is
// stable.
assert outcomes_are_stable {
  always (all b : PhysicalBatch, c : b.claims |
    b.outcomes[c] != NoOutcome implies b.outcomes'[c] = b.outcomes[c])
}

// [SAFE: FLA-CLAIM-PARTITION] No claim ever holds an outcome in two batches
// (partition across batches) — implied by claims_partitioned_across_batches
// plus per-batch outcome scoping; stated explicitly as a check target.
assert no_cross_batch_outcomes {
  always (all disj b1, b2 : PhysicalBatch, c : Claim |
    not (c in b1.claims and c in b2.claims))
}

// --- Liveness assertions ---

// [LIVE: FLA-TEMP-LIFECYCLE] Cleanup is attempted after every handled
// terminal state: an attached batch holding a live temp directory at
// resolution eventually releases it (cleanup succeeds or fails), provided
// enabled cleanup events are not starved forever. The implementation
// guarantees this with cleanup in `finally`; the model states the fairness
// premise explicitly rather than assuming it.
pred cleanup_fairness {
  all b : PhysicalBatch |
    (eventually always (b.tempState in DirCreated + FileWritten
                        and b.resolution != Unresolved))
    implies
    (always eventually (cleanup_succeeds[b] or cleanup_fails[b]))
}

assert cleanup_attempted_after_handled_terminal_states {
  cleanup_fairness implies
    always (all b : PhysicalBatch |
      (b.attached = Attached
       and b.resolution != Unresolved
       and b.tempState in DirCreated + FileWritten)
      implies eventually (b.tempState in CleanupSucceeded + CleanupFailed))
}

// [LIVE: FLA-CLAIM-PARTITION] Every eligible claim eventually reaches a
// terminal outcome, under the fairness assumption that enabled progress
// events are not starved forever.
pred progress_fairness {
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

assert all_claims_reach_terminal_outcome {
  progress_fairness implies
    always eventually (all b : PhysicalBatch, c : b.claims |
      b.outcomes[c] != NoOutcome)
}

// --- Commands ---

// Sanity: a non-trivial instance exists.
run sanity {
  some PhysicalBatch
} for 3 but 6 steps expect 1

// Scenario: attached multi-claim batch succeeds and cleans up.
run attached_success {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = BatchSuccess
                    and b.tempState = CleanupSucceeded
                    and (all c : b.claims | b.outcomes[c] = CandidateOutcome))
} for 3 but 10 steps expect 1

// Scenario: write failure after dir creation, then cleanup succeeds
// [FLA-TEMP-WRITEFAIL].
run write_failure_then_cleanup {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = TransportFailure
                    and once b.tempState = DirCreated
                    and eventually b.tempState = CleanupSucceeded
                    and (all c : b.claims | b.outcomes[c] = ClaimErrorOutcome))
} for 3 but 12 steps expect 1

// Scenario: cleanup failure after success preserves candidates and is a
// terminal handled state [FLA-TEMP-CLEANUP-WARN].
run cleanup_failure_after_success {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = BatchSuccess
                    and b.tempState = CleanupFailed
                    and (all c : b.claims | b.outcomes[c] = CandidateOutcome))
} for 3 but 12 steps expect 1

// Scenario: model failure degrades to per-claim retry [FLA-DEGRADE-KIND].
run model_failure_degrades {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.degraded = Degraded
                    and once b.resolution = ModelFailure)
} for 3 but 14 steps expect 1

// Scenario: prompt too large with non-fitting fallback yields immediate claim
// errors, no degradation [FLA-DEGRADE-TOOLARGE].
run prompt_too_large_no_fallback {
  some b : PhysicalBatch |
    b.attached = Attached
    and b.fallbackFits = FallbackDoesNotFit
    and eventually (b.resolution = ModelFailure
                    and always b.degraded = NotDegraded
                    and eventually (all c : b.claims | b.outcomes[c] = ClaimErrorOutcome))
} for 3 but 12 steps expect 1

// Scenario: infra failure produces claim errors with no per-claim fallback
// [FLA-DEGRADE-SPAWN, FLA-DEGRADE-FILES, FLA-DEGRADE-INVTIMEOUT].
run infra_failure_no_fallback {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = InfraFailure
                    and always b.degraded = NotDegraded
                    and eventually (all c : b.claims | b.outcomes[c] = ClaimErrorOutcome))
} for 3 but 12 steps expect 1

// Checks: safety properties must hold (no counterexample expected).
check resolved_attached_batches_created_dir_or_failed_at_creation for 4 but 15 steps expect 0
check cleanup_is_terminal for 4 but 15 steps expect 0
check cleanup_failure_preserves_candidates for 4 but 15 steps expect 0
check evidence_recorded_for_every_attached_attempt for 4 but 15 steps expect 0
check outcomes_are_stable for 4 but 15 steps expect 0
check no_cross_batch_outcomes for 4 but 10 steps expect 0

// Checks: liveness under fairness.
check cleanup_attempted_after_handled_terminal_states for 3 but 20 steps expect 0
check all_claims_reach_terminal_outcome for 3 but 20 steps expect 0
