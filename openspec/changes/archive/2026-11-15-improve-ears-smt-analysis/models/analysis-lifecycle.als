module analysis_lifecycle

// Small analyzer-control model, not an EARS/Alloy translation or proof of
// expression typing, registry identity correctness, or SMT query semantics.
abstract sig Bool {}
one sig Yes, No extends Bool {}
abstract sig Stage {}
one sig Discover, Sample, Solve, Complete, Failed extends Stage {}
abstract sig Modal {}
one sig Mandatory, Advisory, Permission extends Modal {}
abstract sig Verdict {}
one sig Sat, Unsat, Unknown, SolverError extends Verdict {}

sig Concept {}
sig Claim { modal: one Modal }
one sig Admission { eligible: set Claim }
sig Attempt {
  claim: one Claim,
  accepted: one Bool,
  terminal: one Bool
}
sig Query {
  // Background/signature queries have group provenance but no claim owner.
  owners: set Claim,
  typed: one Bool,
  compatible: one Bool,
  backgroundSat: one Bool,
  premiseSat: one Bool,
  verdict: one Verdict
}

one sig Run {
  var stage: one Stage,
  var registry: set Concept,
  var frozen: one Bool,
  var candidates: set Claim,
  var errors: set Claim,
  var issued: set Attempt,
  var attemptEvidence: set Attempt,
  var resolved: set Attempt,
  var usedRegistry: Claim -> Concept,
  var executed: set Query,
  var persisted: set Query,
  var skipped: set Query,
  var favorable: set Query
}

fun mandatoryBaseline: set Claim {
  { c: Run.candidates | c.modal = Mandatory }
}

pred init {
  Run.stage = Discover
  no Run.registry
  Run.frozen = No
  no Run.candidates + Run.errors
  no Run.issued + Run.attemptEvidence + Run.resolved
  no Run.usedRegistry
  no Run.executed + Run.persisted + Run.skipped + Run.favorable
}

pred keepClaims {
  Run.candidates' = Run.candidates
  Run.errors' = Run.errors
  Run.issued' = Run.issued
  Run.attemptEvidence' = Run.attemptEvidence
  Run.resolved' = Run.resolved
  Run.usedRegistry' = Run.usedRegistry
}

pred keepQueries {
  Run.executed' = Run.executed
  Run.persisted' = Run.persisted
  Run.skipped' = Run.skipped
  Run.favorable' = Run.favorable
}

pred discover[c: Concept] {
  Run.stage = Discover
  Run.registry' = Run.registry + c
  Run.stage' = Run.stage
  Run.frozen' = Run.frozen
  keepClaims
  keepQueries
}

pred freeze {
  Run.stage = Discover
  Run.stage' = Sample
  Run.frozen' = Yes
  Run.registry' = Run.registry
  keepClaims
  keepQueries
}

pred issueAttempt[a: Attempt] {
  Run.stage = Sample
  a not in Run.issued
  a.claim in Admission.eligible - Run.errors
  Run.issued' = Run.issued + a
  Run.attemptEvidence' = Run.attemptEvidence
  Run.resolved' = Run.resolved
  Run.candidates' = Run.candidates
  Run.errors' = Run.errors
  Run.usedRegistry' = Run.usedRegistry
  Run.stage' = Run.stage
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepQueries
}

pred captureAttempt[a: Attempt] {
  Run.stage = Sample
  a in Run.issued - Run.attemptEvidence
  Run.attemptEvidence' = Run.attemptEvidence + a
  Run.issued' = Run.issued
  Run.resolved' = Run.resolved
  Run.candidates' = Run.candidates
  Run.errors' = Run.errors
  Run.usedRegistry' = Run.usedRegistry
  Run.stage' = Run.stage
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepQueries
}

pred resolveAttempt[a: Attempt] {
  Run.stage = Sample
  a in Run.attemptEvidence - Run.resolved
  a.claim not in Run.errors
  Run.candidates' = Run.candidates + (a.accepted = Yes => a.claim else none)
  Run.errors' = Run.errors +
    (a.accepted = No and a.terminal = Yes and a.claim not in Run.candidates => a.claim else none)
  Run.usedRegistry' = Run.usedRegistry +
    (a.accepted = Yes => a.claim -> Run.registry else none -> none)
  Run.resolved' = Run.resolved + a
  Run.issued' = Run.issued
  Run.attemptEvidence' = Run.attemptEvidence
  Run.stage' = Run.stage
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepQueries
}

pred beginQueries {
  Run.stage = Sample
  Run.candidates + Run.errors = Admission.eligible
  some Run.candidates or no Admission.eligible
  Run.issued = Run.attemptEvidence
  Run.issued = Run.resolved
  Run.stage' = Solve
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepClaims
  keepQueries
}

pred execute[q: Query] {
  Run.stage = Solve
  q not in Run.executed + Run.skipped
  q.owners in Run.candidates
  q.typed = Yes
  q.compatible = Yes
  Run.executed' = Run.executed + q
  Run.persisted' = Run.persisted
  Run.skipped' = Run.skipped
  Run.favorable' = Run.favorable
  Run.stage' = Run.stage
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepClaims
}

pred persist[q: Query] {
  Run.stage = Solve
  q in Run.executed - Run.persisted
  Run.persisted' = Run.persisted + q
  Run.executed' = Run.executed
  Run.skipped' = Run.skipped
  Run.favorable' = Run.favorable
  Run.stage' = Run.stage
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepClaims
}

pred skip[q: Query] {
  Run.stage = Solve
  q not in Run.executed + Run.skipped
  Run.skipped' = Run.skipped + q
  Run.executed' = Run.executed
  Run.persisted' = Run.persisted
  Run.favorable' = Run.favorable
  Run.stage' = Run.stage
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepClaims
}

pred publish[q: Query] {
  Run.stage = Solve
  q in Run.persisted
  q.backgroundSat = Yes
  q.premiseSat = Yes
  q.verdict = Unsat
  Run.favorable' = Run.favorable + q
  Run.executed' = Run.executed
  Run.persisted' = Run.persisted
  Run.skipped' = Run.skipped
  Run.stage' = Run.stage
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepClaims
}

pred complete {
  Run.stage = Solve
  Run.executed + Run.skipped = Query
  Run.persisted = Run.executed
  Run.stage' = Complete
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepClaims
  keepQueries
}

pred fail {
  Run.stage not in Complete + Failed
  Run.stage' = Failed
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepClaims
  keepQueries
}

pred stutter {
  Run.stage' = Run.stage
  Run.registry' = Run.registry
  Run.frozen' = Run.frozen
  keepClaims
  keepQueries
}

fact behavior {
  init
  always (
    (some c: Concept | discover[c]) or freeze or
    (some a: Attempt | issueAttempt[a] or captureAttempt[a] or resolveAttempt[a]) or
    beginQueries or (some q: Query | execute[q] or persist[q] or skip[q] or publish[q]) or
    complete or fail or stutter
  )
}

assert FrozenRegistryNeverChanges {
  always (Run.frozen = Yes implies Run.registry' = Run.registry)
}
assert ExcludedClaimsNeverEnterAnalysis {
  always (Run.candidates + Run.errors in Admission.eligible and
    all q: Run.executed | q.owners in Run.candidates)
}
assert TerminalOutcomesAreDisjoint {
  always (no Run.candidates & Run.errors)
}
assert QueriesRequireAdmission {
  always (all q: Run.executed |
    Run.frozen = Yes and q.typed = Yes and q.compatible = Yes)
}
assert FavorableOutcomesAreNonvacuous {
  always (all q: Run.favorable |
    q in Run.persisted and q.backgroundSat = Yes and
    q.premiseSat = Yes and q.verdict = Unsat)
}
assert CompletionRequiresEvidence {
  always (Run.stage = Complete implies
    Run.persisted = Run.executed and Run.executed + Run.skipped = Query and
    Run.candidates + Run.errors = Admission.eligible)
}
assert MandatoryBaselineExcludesOtherModes {
  always (no mandatoryBaseline & { c: Claim | c.modal in Advisory + Permission })
}
assert EligibleTotalFailureCannotComplete {
  always (Run.stage = Complete and some Admission.eligible implies some Run.candidates)
}
assert CandidatesAreNeverRevoked {
  always (Run.candidates in Run.candidates')
}
assert SampleOutcomesRequireRawEvidence {
  always (Run.resolved in Run.attemptEvidence and
    Run.attemptEvidence in Run.issued and
    Run.candidates + Run.errors in Run.resolved.claim)
}
assert SamplesUseTheFrozenRegistry {
  always (all c: Run.candidates | c.(Run.usedRegistry) = Run.registry)
}
assert AdditionalFailurePreservesCandidate {
  always (all a: Attempt | resolveAttempt[a] and a.claim in Run.candidates and
    a.accepted = No implies
      a.claim in Run.candidates' and a.claim not in Run.errors')
}

// Nonvacuity witnesses: exercise real work, exclusions, uncertainty, and failure.
run CompletedWithEvidence {
  some Admission.eligible
  some Claim - Admission.eligible
  eventually some Run.registry
  eventually (Run.stage = Complete and some Run.favorable)
} for 4 but 1 Query, 1 Concept, 12 steps expect 1
run UncertainQueryIsRecorded {
  some q: Query | q.verdict = Unknown and eventually
    (Run.stage = Complete and q in Run.persisted and q not in Run.favorable)
} for 3 but 1 Query, 1 Concept, 10 steps expect 1
run FailedRunMayKeepPartialEvidence {
  eventually (Run.stage = Failed and some Run.persisted)
} for 3 but 1 Query, 1 Concept, 12 steps expect 1
run GroupScopedBackgroundQuery {
  some q: Query | no q.owners and eventually q in Run.persisted
} for 3 but 1 Query, 1 Concept, 12 steps expect 1
run AdditionalSampleFailure {
  some a: Attempt | a.accepted = No and a.terminal = Yes and
    eventually (a.claim in Run.candidates and a in Run.resolved and
      Run.stage = Complete)
} for 3 but 1 Query, 1 Concept, 16 steps expect 1

check FrozenRegistryNeverChanges for 4 but 12 steps expect 0
check ExcludedClaimsNeverEnterAnalysis for 4 but 12 steps expect 0
check TerminalOutcomesAreDisjoint for 4 but 12 steps expect 0
check QueriesRequireAdmission for 4 but 12 steps expect 0
check FavorableOutcomesAreNonvacuous for 4 but 12 steps expect 0
check CompletionRequiresEvidence for 4 but 12 steps expect 0
check MandatoryBaselineExcludesOtherModes for 4 but 12 steps expect 0
check EligibleTotalFailureCannotComplete for 4 but 12 steps expect 0
check CandidatesAreNeverRevoked for 4 but 12 steps expect 0
check SampleOutcomesRequireRawEvidence for 4 but 12 steps expect 0
check SamplesUseTheFrozenRegistry for 4 but 12 steps expect 0
check AdditionalFailurePreservesCandidate for 4 but 16 steps expect 0
