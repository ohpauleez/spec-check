module static_semantics

// Independent finite valuation model of the new contracts. Valuations describe
// possible assignments, not traces. Source interpretation/type checking are
// separate boundaries; no desired query verdict is assumed as a fact.
abstract sig Bool {}
one sig Yes, No extends Bool {}
abstract sig Modal {}
one sig Mandatory, Advisory, Permission extends Modal {}
sig Valuation { g: one Bool, x: one Bool, y: one Bool }
sig Rule { guard: set Valuation, response: set Valuation, modal: one Modal }
one sig Domain { background: set Valuation }

// The explicit finite domain has all eight Boolean assignments, exactly once.
fact BooleanUniverse {
  all gv, xv, yv: Bool | one v: Valuation | v.g = gv and v.x = xv and v.y = yv
}

fun allowed[rs: set Rule]: set Valuation {
  { v: Valuation | all r: rs | r.modal = Mandatory implies
      (v in r.guard implies v in r.response) }
}
fun activated[r: Rule, rs: set Rule]: set Valuation {
  Domain.background & r.guard & allowed[rs]
}
fun permitted[r: Rule, rs: set Rule]: set Valuation {
  activated[r, rs] & r.response
}
pred nonvacuousEquivalent[a, b: set Valuation] {
  some Domain.background & a
  some Domain.background & b
  Domain.background & a = Domain.background & b
}
pred permissionBroader[original, generated: Rule, rs: set Rule] {
  some permitted[original, rs]
  some permitted[generated, rs]
  permitted[original, rs] in permitted[generated, rs]
  permitted[original, rs] != permitted[generated, rs]
}
fun gap[applicable: set Valuation, rs: set Rule]: set Valuation {
  Domain.background & applicable - rs.guard
}

assert OtherModesDoNotConstrainMandatoryBaseline {
  all rs: set Rule | allowed[rs] = allowed[{ r: rs | r.modal = Mandatory }]
}
assert EmptyPremisesCannotEstablishEquivalence {
  all a, b: set Valuation | nonvacuousEquivalent[a, b] implies
    some Domain.background & a and some Domain.background & b
}
assert BroaderPermissionHasDistinguishingValuation {
  all original, generated: Rule, rs: set Rule |
    permissionBroader[original, generated, rs] implies
      some permitted[generated, rs] - permitted[original, rs]
}
assert UnrelatedInvariantDoesNotCoverBehaviorFamily {
  all applicable: set Valuation, behavior: set Rule, unrelated: Rule |
    unrelated not in behavior implies
      gap[applicable, behavior] = Domain.background & applicable - behavior.guard
}

run GuardedUnconditionalConflict {
  Domain.background = Valuation
  some disj event, invariant: Rule {
    event.modal = Mandatory
    invariant.modal = Mandatory
    event.guard = { v: Valuation | v.g = Yes }
    event.response = { v: Valuation | v.x = Yes }
    invariant.guard = Valuation
    invariant.response = { v: Valuation | v.x = No }
    some allowed[event + invariant]
    no activated[event, event + invariant]
  }
} for 4 but exactly 8 Valuation, exactly 2 Rule expect 1

run ThreeRulesConflictWithoutConflictingResponsePair {
  Domain.background = Valuation
  some disj a, b, c: Rule {
    (a + b + c).modal = Mandatory
    a.guard = { v: Valuation | v.g = Yes }
    b.guard = a.guard
    c.guard = a.guard
    a.response = { v: Valuation | v.x = Yes }
    b.response = { v: Valuation | v.y = Yes }
    c.response = { v: Valuation | v.x = No or v.y = No }
    some a.guard & a.response & b.response
    some a.guard & a.response & c.response
    some a.guard & b.response & c.response
    no activated[a, a + b + c]
  }
} for 4 but exactly 8 Valuation, exactly 3 Rule expect 1

run GeneratedPermissionIsBroader {
  Domain.background = Valuation
  some disj original, generated: Rule {
    original.modal = Permission
    generated.modal = Permission
    original.guard = Valuation
    generated.guard = Valuation
    original.response = { v: Valuation | v.x = Yes }
    generated.response = Valuation
    permissionBroader[original, generated, original + generated]
  }
} for 4 but exactly 8 Valuation, exactly 2 Rule expect 1

check OtherModesDoNotConstrainMandatoryBaseline for 4 but exactly 8 Valuation, 3 Rule expect 0
check EmptyPremisesCannotEstablishEquivalence for 4 but exactly 8 Valuation, 3 Rule expect 0
check BroaderPermissionHasDistinguishingValuation for 4 but exactly 8 Valuation, 3 Rule expect 0
check UnrelatedInvariantDoesNotCoverBehaviorFamily for 4 but exactly 8 Valuation, 3 Rule expect 0
