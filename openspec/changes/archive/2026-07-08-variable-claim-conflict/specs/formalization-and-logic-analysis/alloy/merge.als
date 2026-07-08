module merge

/**
 * External Alloy model documenting and verifying the structural invariants of
 * the per-spec combined SMT-LIB merge phase for spec-check.
 *
 * Models the structural invariants and safety properties of combining all
 * formalized claims from a single merged capability analysis unit into one
 * SMT-LIB artifact: claim identity, declaration kind, declaration signature,
 * conflict detection, and combined-SMT wellformedness. This is a structural
 * (non-temporal) model because compilation is a pure, synchronous,
 * deterministic function of an ordered claim list. This model has no claim
 * ordering, so positional first-wins exclusion (the later claimant loses) is
 * verified by contract and property tests, not encoded here.
 *
 * This model is external documentation and verification only: it is NOT part of
 * the spec-check test/integration harness and is NOT a condition of any spec.md
 * requirement. It provides an independent, machine-checkable justification for
 * the safety properties behind requirement [FLA-SPEC-COMBINE]
 * (formalization-and-logic-analysis). The author runs the Alloy Analyzer over
 * the run/check commands below and records the SAT/UNSAT transcript in the
 * change summary; no automated test harness consumes this file.
 *
 * VSC-10b (sanitized claim-ID uniqueness), VSC-11, and VSC-12 concern concrete
 * string encodings rather than merge state and are evidence obligations tested
 * over concrete strings, not encoded here.
 */

// --- Signatures ---

sig Obligation {}
sig Spec {}
sig ClaimId {}
sig DeclName {}
sig DeclSignature {}

sig Claim {
  obligation : one Obligation,
  spec       : one Spec,
  claimId    : one ClaimId
}

abstract sig DeclKind {}
one sig VarDecl, FunDecl extends DeclKind {}

sig Declaration {
  declName  : one DeclName,
  declKind  : one DeclKind,
  declSig   : one DeclSignature,
  declClaim : one Claim
}

// Combined SMT-LIB compilation of the claims belonging to one spec.
// includedClaims survive the merge; excludedClaims lost a conflict.
sig CombinedSmt {
  smtSpec        : one Spec,
  includedClaims : set Claim,
  excludedClaims : set Claim
}

// --- Facts (domain and compile-group constraints) ---

// Raw claim IDs are unique within a compile group
// (one spec's claims). Sanitized-ID uniqueness (VSC-10b) is a separate
// executable preflight, not modeled here.
fact unique_claim_ids_per_spec {
  all disj c1, c2 : Claim |
    c1.spec = c2.spec implies c1.claimId != c2.claimId
}

// Same-kind sanitized duplicates within one claim
// are rejected by validation; a same-claim variable/function sanitizer
// collision (opposite kinds, same sanitized name) stays representable as a
// compile conflict.
fact validated_same_claim_declarations {
  all c : Claim, disj d1, d2 : Declaration |
    (d1.declClaim = c and d2.declClaim = c and d1.declName = d2.declName) implies
      d1.declKind != d2.declKind
}

// At most one combined artifact per spec.
fact lone_combined_per_spec {
  all sp : Spec | lone cs : CombinedSmt | cs.smtSpec = sp
}

// Included and excluded claims partition exactly the claims of the combined
// artifact's spec, and no claim is both included and excluded.
fact combined_partitions_spec_claims {
  all cs : CombinedSmt |
    cs.includedClaims + cs.excludedClaims = { c : Claim | c.spec = cs.smtSpec }
    and no (cs.includedClaims & cs.excludedClaims)
}

// --- Predicates ---

// Two claims (possibly the same claim) conflict in a
// spec when they contribute two distinct declarations of one sanitized name
// that disagree on declaration kind or signature. Passing c1 = c2 represents a
// same-claim sanitizer collision.
pred conflict_detected [c1, c2 : Claim, sp : Spec] {
  c1.spec = sp and c2.spec = sp
  some disj d1, d2 : Declaration |
    d1.declClaim = c1 and d2.declClaim = c2 and
    d1.declName = d2.declName and
    (d1.declKind != d2.declKind or d1.declSig != d2.declSig)
}

// Every pair of included declarations sharing
// one sanitized name agrees on both declaration kind and declaration signature.
pred combined_wellformed [cs : CombinedSmt] {
  all disj d1, d2 : Declaration |
    (d1.declClaim in cs.includedClaims and d2.declClaim in cs.includedClaims and
     d1.declName = d2.declName) implies
       (d1.declKind = d2.declKind and d1.declSig = d2.declSig)
}

// Every detected conflict has at least one of
// its two claims excluded. The disjunction `c1 in excludedClaims or c2 in
// excludedClaims` reduces to `c1 in excludedClaims` when c1 = c2.
pred conflicts_excluded [cs : CombinedSmt] {
  all c1, c2 : Claim |
    conflict_detected[c1, c2, cs.smtSpec] implies
      (c1 in cs.excludedClaims or c2 in cs.excludedClaims)
}

// --- Safety assertions ---

// Excluding every detected conflict is
// sufficient to make the combined artifact wellformed.
assert exclusion_implies_wellformed {
  all cs : CombinedSmt |
    conflicts_excluded[cs] implies combined_wellformed[cs]
}

// A same-claim sanitizer collision forces that
// claim itself to be excluded once all conflicts are excluded.
assert same_claim_collision_excluded {
  all cs : CombinedSmt, c : Claim |
    (conflicts_excluded[cs] and conflict_detected[c, c, cs.smtSpec])
      implies c in cs.excludedClaims
}

// --- Commands ---

// Sanity: a non-trivial instance with claims, declarations, and a combined
// artifact exists.
run sanity {
  some Claim
  some Declaration
  some CombinedSmt
} for 4 expect 1

// A cross-claim declaration conflict is detected, the conflicting claim is
// excluded, the surviving claim is included, and the result is wellformed.
run conflict_with_exclusion {
  some cs : CombinedSmt, disj c1, c2 : Claim |
    conflict_detected[c1, c2, cs.smtSpec] and
    c1 in cs.includedClaims and
    c2 in cs.excludedClaims and
    conflicts_excluded[cs] and
    combined_wellformed[cs]
} for 4 expect 1

// A same-claim variable/function sanitizer collision is representable and
// excludes its own claim.
run same_claim_collision {
  some cs : CombinedSmt, c : Claim |
    conflict_detected[c, c, cs.smtSpec] and
    conflicts_excluded[cs] and
    c in cs.excludedClaims
} for 4 expect 1

// --- Safety checks ---

check exclusion_implies_wellformed for 6 expect 0
check same_claim_collision_excluded for 6 expect 0
