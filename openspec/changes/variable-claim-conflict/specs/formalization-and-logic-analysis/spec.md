## MODIFIED Requirements

### Requirement: Per-Spec Combined SMT-LIB Compilation [FLA-SPEC-COMBINE]
WHEN the spec-check tool performs specs-forward logic analysis, THE spec-check tool SHALL combine all formalized claims from a single merged capability analysis unit into exactly one SMT-LIB file, SHALL deduplicate compatible variable and function declarations across claims by final sanitized symbol identity, SHALL exclude later claims that introduce incompatible declaration bindings for an already-established sanitized symbol, SHALL reject compile groups whose claim identifiers are not unique before solver execution, SHALL use `compiled.claimIds` as the authoritative surviving-claim set for downstream checks, and SHALL use named assertions (`(assert (! expr :named label))`) to enable unsat-core identification. The compiled output SHALL NOT include solver commands (`check-sat`, `set-option`, `get-unsat-core`) — the logic analysis orchestrator appends these at query time using a two-phase approach (Phase 1: satisfiability check only; Phase 2: re-run with `(set-option :produce-unsat-cores true)` and `(get-unsat-core)` only when UNSAT is detected).

**References:**
- `openspec/changes/variable-claim-conflict/proposal.md#Scope`
- `openspec/changes/variable-claim-conflict/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/variable-claim-conflict/proposal.md#Failure Modes`
- `openspec/changes/variable-claim-conflict/proposal.md#Quality Attributes`
- `openspec/changes/variable-claim-conflict/design.md#Architecture Decisions`
- `openspec/changes/variable-claim-conflict/design.md#Component Design`
- `openspec/changes/variable-claim-conflict/design.md#Implementation Plan`
- `openspec/changes/variable-claim-conflict/design.md#Verification Plan`

**Preconditions:**
- The compile group is finite, ordered, and not mutated during compilation.
- Each claim has passed structural Logic IR validation.
- Raw claim IDs are unique within a compile group; sanitized claim IDs are also unique as a defense-in-depth preflight.
- Same-claim duplicate variable declarations and duplicate function declarations by sanitized name are rejected during validation.
- Same-claim raw variable/function name overlap is rejected during validation.
- Residual same-claim sanitizer-induced variable/function collisions remain valid compiler inputs and are represented as `symbol_kind_collision` merge conflicts.
- Assertion-reference resolution is not added by this change; references that become dangling after merge exclusion may still surface as `logic.solver_error`.

**Postconditions:**
- `compiled.claimIds` contains exactly non-excluded claims in original input order.
- Every excluded claim has exactly one conflict reason under the fixed precedence `variable_sort_mismatch`, then `function_signature_mismatch`, then `symbol_kind_collision`.
- Every conflict records `existingClaimId`, `excludedClaimId`, and `claimIds: [existingClaimId, excludedClaimId]` in that order.
- `assertionNameMap` contains labels only for included claims.
- Excluded claims contribute no assertions and no unique declarations to emitted SMT-LIB.
- No surviving sanitized variable symbol has more than one sort.
- No surviving sanitized function symbol has more than one signature.
- No surviving sanitized symbol is declared as both a variable and a function.
- No group with duplicate raw or sanitized claim IDs reaches query construction or solver execution.
- SMT-LIB comments generated from untrusted strings cannot introduce executable commands on following lines.

**Safety, Liveness, And Determinism:**
- VSC-1: A surviving sanitized variable symbol never has multiple sorts.
- VSC-2: Assertions from merge-excluded claims are never emitted.
- VSC-3: Variable-sort mismatches are recorded, not hidden behind first-wins deduplication.
- VSC-4: Deeper checks derive inclusion from `compiled.claimIds`, not from conflict evidence tuples.
- VSC-5: Compatible variable declarations remain included and analyzable.
- VSC-6: Compatible function declarations preserve existing behavior when no higher-precedence conflict exists.
- VSC-7: Conflict detection terminates for every finite claim list.
- VSC-8: Same ordered input produces the same included claims, conflicts, assertion maps, and SMT-LIB text.
- VSC-9: One sanitized symbol is never emitted as both `declare-const` and `declare-fun`.
- VSC-10: Duplicate raw claim IDs never reach solver query construction.
- VSC-10b: Duplicate sanitized claim IDs never reach solver query construction, even as a sanitizer-regression safety net.
- VSC-11: Untrusted SMT-LIB comments cannot inject commands by introducing new lines.
- VSC-12: Raw evidence remains inert data across compiler output and rendered reports.

#### Scenario: Variable And Function Deduplication [FLA-SPEC-DEDUP]
WHEN multiple claims from the same merged capability analysis unit declare identical variable or function names with identical sorts or signatures after sanitization, THE spec-check tool SHALL emit only one declaration in the combined output and SHALL keep all compatible claims included.

**Postcondition:** The combined SMT-LIB file has no duplicate declarations from compatible claims, and compatible redeclarations do not re-anchor declaration ownership to a later claim.

**Trace Properties:** VSC-5, VSC-6, VSC-8.

#### Scenario: Function Signature Conflict Detection [FLA-SPEC-CONFLICT]
IF two claims from the same merged capability analysis unit declare the same sanitized function symbol with incompatible signatures, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding, SHALL exclude the later conflicting claim from the combined file, and SHALL preserve both claim identifiers, both raw function names, and the shared sanitized symbol in the finding evidence.

**Postcondition:** Function-signature conflicts are surfaced as findings rather than producing malformed solver input.

**Evidence:** The compiler conflict SHALL use kind `function_signature_mismatch`, SHALL expose `existingFunctionName`, `conflictingFunctionName`, `existingClaimId`, `excludedClaimId`, and `claimIds: [existingClaimId, excludedClaimId]`, and SHALL preserve the first surviving declaration as the authoritative binding.

**Trace Properties:** VSC-2, VSC-4, VSC-6, VSC-8.

#### Scenario: Variable Sort Conflict Detection [FLA-SPEC-VARSORT-CONFLICT]
IF two claims from the same merged capability analysis unit declare the same sanitized variable symbol with incompatible sorts, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding for `variable_sort_mismatch`, SHALL exclude the later conflicting claim from the combined file, and SHALL preserve both claim identifiers, both raw variable names, the shared sanitized symbol, and both sorts in the finding evidence.

**Postcondition:** No surviving combined SMT-LIB artifact contains one sanitized variable symbol with more than one sort.

**Evidence:** The compiler conflict SHALL expose `existingVariableName`, `conflictingVariableName`, `expectedSort`, `conflictingSort`, `existingClaimId`, `excludedClaimId`, and `claimIds: [existingClaimId, excludedClaimId]`. Sort comparison SHALL be exact and case-sensitive over `Bool`, `Int`, `Real`, and `String`.

**Trace Properties:** VSC-1, VSC-2, VSC-3, VSC-4, VSC-8.

#### Scenario: Symbol Kind Collision Detection [FLA-SPEC-SYMKIND-CONFLICT]
IF one claim declares a sanitized symbol as a variable and another claim declares the same sanitized symbol as a function, OR IF one claim contains distinct raw names that sanitize to the same symbol with opposite declaration kinds, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding for `symbol_kind_collision`, SHALL exclude the offending claim from the combined file, and SHALL preserve both claim identifiers, both raw names, both declaration kinds, and the shared sanitized symbol in the finding evidence.

**Postcondition:** No surviving combined SMT-LIB artifact contains one sanitized symbol declared as both `declare-const` and `declare-fun`.

**Evidence:** The compiler conflict SHALL expose `existingSymbolName`, `existingSymbolKind`, `conflictingSymbolName`, `conflictingSymbolKind`, `existingClaimId`, `excludedClaimId`, and `claimIds: [existingClaimId, excludedClaimId]`. For same-claim sanitizer collisions, `existingClaimId` SHALL equal `excludedClaimId`, and `claimIds` SHALL be `[claimId, claimId]`.

**Trace Properties:** VSC-2, VSC-4, VSC-8, VSC-9.

#### Scenario: Duplicate Claim Identifier Rejected Before Solver Execution [FLA-SPEC-DUPLICATE-CLAIM-ID]
IF a compile group contains duplicate raw claim identifiers or duplicate sanitized claim identifiers, THEN THE spec-check tool SHALL emit `logic.invalid_group`, SHALL skip combined SMT-LIB compilation for that group, and SHALL NOT invoke the solver for that group.

**Postcondition:** Claim identity remains one-to-one across included claims, assertion labels, unsat-core resolution, and finding evidence.

**Evidence:** Raw duplicate evidence SHALL list duplicated raw IDs and affected claims. Sanitized duplicate evidence SHALL list colliding raw IDs and the shared sanitized ID. Invalid-group rejection is structural and SHALL NOT be reported as a merge conflict.

**Trace Properties:** VSC-10, VSC-10b.

#### Scenario: Named Assertion Labels Map To Claims [FLA-SPEC-NAMED]
WHEN the spec-check tool generates named assertions in the combined SMT-LIB, THE label for each assertion SHALL encode the source claim identifier and assertion index so that unsat-core results can be mapped back to specific included claims.

**Postcondition:** The assertion-name-to-claim-ID mapping is deterministic and reversible for every included claim.

**Identifier Contract:** The label form SHALL be `<sanitizedClaimId>__a<index>`. `sanitizeIdentifier()` SHALL be injective, SHALL reserve `_` as the escape lead, SHALL escape literal underscores such as `_5F`, SHALL use self-delimiting uppercase hexadecimal escapes, and SHALL perform no Unicode normalization. Under this contract, the `__a<index>` separator remains unambiguous and distinct raw claim IDs cannot produce colliding assertion labels.

**Trace Properties:** VSC-8, VSC-10b.

### Requirement: Formal Merge Model Alignment [FLA-SPEC-MODEL]
WHEN the spec-check tool maintains or validates the formalization-and-logic-analysis capability model, THE model SHALL represent claim identity, declaration kind, declaration signature, conflict detection, and combined-SMT wellformedness consistently with the compiler merge semantics.

**References:**
- `openspec/changes/variable-claim-conflict/proposal.md#Safety And Liveness Claims`
- `openspec/changes/variable-claim-conflict/design.md#OpenSpec And Alloy Model Updates`
- `openspec/changes/variable-claim-conflict/design.md#Verification Plan`

#### Scenario: Claim And Declaration Model Includes Identity And Kind [FLA-MODEL-CLAIM-DECL-KIND]
WHEN the shared Alloy model describes claims and declarations, THE model SHALL include `claimId` on `Claim`, SHALL include `declKind` on `Declaration`, and SHALL keep `DeclName` as the final sanitized declaration identity used by SMT-LIB emission.

**Required Model Shape:**

```alloy
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
```

#### Scenario: Claim Identity And Same-Claim Declaration Facts [FLA-MODEL-VALIDATION-FACTS]
WHEN the shared Alloy model captures validation and preflight boundaries, THE model SHALL require unique claim IDs per spec and SHALL distinguish same-kind sanitized duplicates from same-claim cross-kind sanitizer collisions.

**Required Model Facts:**

```alloy
fact unique_claim_ids_per_spec {
  all disj c1, c2 : Claim |
    c1.spec = c2.spec implies c1.claimId != c2.claimId
}

fact validated_same_claim_declarations {
  all c : Claim, disj d1, d2 : Declaration |
    (d1.declClaim = c and d2.declClaim = c and d1.declName = d2.declName) implies
      d1.declKind != d2.declKind
}
```

**Clarification:** `validated_same_claim_declarations` mirrors validation: duplicate variables and duplicate functions sharing one sanitized name are invalid, while a same-claim variable/function sanitizer collision remains representable as a compile conflict.

#### Scenario: Conflict Predicate Covers All Declaration Conflicts [FLA-MODEL-CONFLICT-PRED]
WHEN the shared Alloy model identifies merge conflicts, THE predicate SHALL cover same sanitized name with differing declaration kind or differing declaration signature, and SHALL allow `c1 = c2` so same-claim sanitizer-induced variable/function collisions are representable.

**Required Predicate Shape:**

```alloy
pred conflict_detected [c1, c2 : Claim, sp : Spec] {
  c1.spec = sp and c2.spec = sp
  some disj d1, d2 : Declaration |
    d1.declClaim = c1 and d2.declClaim = c2 and
    d1.declName = d2.declName and
    (d1.declKind != d2.declKind or d1.declSig != d2.declSig)
}
```

#### Scenario: Combined Wellformedness Requires Kind And Signature Agreement [FLA-MODEL-COMBINED-WELLFORMED]
WHEN the shared Alloy model defines combined SMT-LIB wellformedness, THE model SHALL require every pair of included declarations sharing one sanitized name to agree on both declaration kind and declaration signature.

**Required Constraint Shape:**

```alloy
all disj d1, d2 : Declaration |
  (d1.declClaim in cs.includedClaims and d2.declClaim in cs.includedClaims and
   d1.declName = d2.declName) implies
     (d1.declKind = d2.declKind and d1.declSig = d2.declSig)
```

#### Scenario: Model Keeps Disjunctive Conflict Exclusion [FLA-MODEL-CONFLICT-EXCLUSION]
WHEN the shared Alloy model states that detected conflicts are excluded from a combined SMT-LIB artifact, THE model SHALL keep the exclusion assertion disjunctive (`c1 in excludedClaims or c2 in excludedClaims`).

**Clarification:** For same-claim conflicts this reduces to `c1 in excludedClaims`, matching `[claimId, claimId]` evidence. The Alloy model has no claim ordering, so the positional guarantee that the later claimant is excluded SHALL be verified by contract and property tests rather than encoded in Alloy.

#### Scenario: Encoding And Security Claims Are Test Evidence Obligations [FLA-MODEL-SECURITY-EVIDENCE]
WHEN safety claims concern concrete string encodings or report rendering rather than merge-state transitions, THE spec-check tool SHALL verify those claims through contract, property, and renderer tests rather than encoding them directly in Alloy.

**Clarification:** VSC-10b follows from unique raw claim IDs under injective `sanitizeIdentifier()`, with a sanitized-ID preflight as an executable safety net. VSC-11 and VSC-12 concern comment and Markdown encoding boundaries and remain evidence obligations unless future rules change declaration identity, conflict detection, or inclusion/exclusion state.
