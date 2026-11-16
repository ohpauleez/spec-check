module boundary_remediation

// One-capability abstraction. Tokens stand for its actual-script allowance.
// Logical typing, solver verdicts, filesystem atomicity and English fidelity
// remain external boundaries checked by implementation/oracle regressions.
abstract sig Side {}
one sig Original, Generated extends Side {}
abstract sig Stability {}
one sig Single, Stable, Unstable extends Stability {}
sig Artifact { side: one Side, stability: one Stability }
sig Query { owners: some Artifact }
sig Token {}
sig Version {}
one sig Source { var current: one Version }
one sig Run {
  var snapshot: lone Version,
  var generationIssued: set Side,
  var remaining: set Token,
  var charged: Query -> Token,
  var executed: set Query,
  var persisted: set Query,
  var complete: set Side
}

// Conditional relations remain available, but unstable contributors earn no credit.
fun credit: set Query { { q: Query | no q.owners & stability.Unstable } }

pred init {
  no Run.snapshot + Run.generationIssued + Run.complete
  Run.remaining = Token
  no Run.charged
  no Run.executed + Run.persisted
}
pred keepWork {
  Run.remaining' = Run.remaining
  Run.charged' = Run.charged
  Run.executed' = Run.executed
  Run.persisted' = Run.persisted
  Run.complete' = Run.complete
}
pred capture {
  no Run.snapshot
  Run.snapshot' = Source.current
  Run.generationIssued' = Run.generationIssued
  Source.current' = Source.current
  keepWork
}
pred edit[v: Version] {
  Source.current' = v
  Run.snapshot' = Run.snapshot
  Run.generationIssued' = Run.generationIssued
  keepWork
}
pred generate {
  some Run.snapshot
  no Run.generationIssued
  Run.generationIssued' = Generated
  Run.snapshot' = Run.snapshot
  Source.current' = Source.current
  keepWork
}
pred execute[q: Query, t: Token] {
  no Run.complete
  q not in Run.executed
  t in Run.remaining
  Run.executed' = Run.executed + q
  Run.charged' = Run.charged + q -> t
  Run.remaining' = Run.remaining - t
  Run.persisted' = Run.persisted
  Run.complete' = Run.complete
  Run.snapshot' = Run.snapshot
  Run.generationIssued' = Run.generationIssued
  Source.current' = Source.current
}
pred persist[q: Query] {
  q in Run.executed - Run.persisted
  Run.persisted' = Run.persisted + q
  Run.remaining' = Run.remaining
  Run.charged' = Run.charged
  Run.executed' = Run.executed
  Run.complete' = Run.complete
  Run.snapshot' = Run.snapshot
  Run.generationIssued' = Run.generationIssued
  Source.current' = Source.current
}
pred finish {
  Run.executed = Run.persisted
  Run.complete' = Side
  Run.remaining' = Run.remaining
  Run.charged' = Run.charged
  Run.executed' = Run.executed
  Run.persisted' = Run.persisted
  Run.snapshot' = Run.snapshot
  Run.generationIssued' = Run.generationIssued
  Source.current' = Source.current
}
pred stutter {
  keepWork
  Run.snapshot' = Run.snapshot
  Run.generationIssued' = Run.generationIssued
  Source.current' = Source.current
}
fact transitions {
  init
  always (capture or generate or finish or stutter or
    (some v: Version | edit[v]) or (some q: Query, t: Token | execute[q,t]) or
    (some q: Query | persist[q]))
}

assert budget_charges_every_execution {
  always (Run.charged.Token = Run.executed and
    all t: Token | lone Run.charged.t)
}
assert evidence_before_completion { always (some Run.complete implies Run.executed = Run.persisted) }
assert source_edits_do_not_replace_snapshot { always (some Run.snapshot implies Run.snapshot' = Run.snapshot) }
assert unstable_baselines_receive_no_credit { all q: credit | no q.owners & stability.Unstable }

run generated_only_completed {
  no side.Original
  eventually (some Run.executed and some Run.complete)
} for 4 but exactly 1 Token, 10 steps expect 1
run source_changes_after_capture {
  eventually (Generated in Run.generationIssued and Run.snapshot != Source.current)
} for 4 but 8 steps expect 1
run single_selected_relation {
  some q: credit | some q.owners & stability.Single
} for 4 but 4 steps expect 1
check budget_charges_every_execution for 4 but 10 steps expect 0
check evidence_before_completion for 4 but 10 steps expect 0
check source_edits_do_not_replace_snapshot for 4 but 10 steps expect 0
check unstable_baselines_receive_no_credit for 4 but 4 steps expect 0
