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

**Identifier Contract:** The label form SHALL be `<sanitizedClaimId>__a<index>`. `sanitizeIdentifier()` SHALL be injective. It SHALL pass through only ASCII letters and digits `[A-Za-z0-9]`, SHALL reserve `_` as the escape lead, and SHALL escape every other code point — including a literal underscore (`U+005F` becomes `_00005F`) — as `_` followed by exactly six uppercase hexadecimal digits of the Unicode code point. It SHALL escape a leading raw digit, SHALL map the empty string to `_`, and SHALL perform no Unicode normalization. Because every escape is a fixed six-digit width, the encoding is uniquely decodable; because `_` occurs only as an escape lead followed by six hex digits, the literal sequence `__` never appears inside a sanitized claim identifier produced from a non-empty raw string, so the `__a<index>` separator remains unambiguous and distinct raw claim IDs cannot produce colliding assertion labels.

**Trace Properties:** VSC-8, VSC-10b.

### Requirement: SMT-LIB Compilation And Identifier Sanitization [FLA-SMTLIB-COMPILE]
WHEN the spec-check tool compiles logic IR into SMT-LIB artifacts, THE spec-check tool SHALL sanitize user-derived identifiers with an injective encoding to prevent solver syntax collisions and identifier aliasing, SHALL include reversible mapping comments that link sanitized identifiers back to their original claim identifiers, SHALL emit only declarations and assertions without solver commands (`(check-sat)`), and SHALL expose decomposed assertion expressions alongside the compiled text for downstream query construction.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/variable-claim-conflict/proposal.md#Inputs, Outputs, And Data Domains`
- `openspec/changes/variable-claim-conflict/design.md#Identifier Injectivity Design`

#### Scenario: Unsafe Identifier Sanitized [FLA-SMTLIB-SANITIZE]
WHEN a claim identifier contains any code point outside the pass-through set of ASCII letters and digits `[A-Za-z0-9]` (for example parentheses, pipe characters, whitespace, a literal underscore, or a supplementary-plane character such as `😀`), THE spec-check tool SHALL iterate the identifier by Unicode code point — not by UTF-16 code unit — and SHALL replace each such code point with a deterministic, injective encoding — `_` followed by exactly six uppercase hexadecimal digits of the Unicode code point — and emit a mapping comment.

**Postcondition:** The SMT-LIB file is syntactically valid, the encoding is uniquely decodable, and the original identifier is recoverable from the mapping comment. A supplementary-plane code point encodes to exactly one six-digit escape rather than a surrogate pair of escapes.

#### Scenario: Valid Identifier Preserved [FLA-SMTLIB-PRESERVE]
WHEN a claim identifier contains only pass-through characters — ASCII letters and digits `[A-Za-z0-9]` — and does not begin with a digit, THE spec-check tool SHALL use the identifier unchanged in the SMT-LIB output.

**Postcondition:** No unnecessary transformation is applied to identifiers already drawn entirely from the pass-through set.

#### Scenario: Compiled Output Excludes Solver Commands [FLA-SMTLIB-QUERYSAT]
WHEN the spec-check tool compiles logic IR into SMT-LIB text, THE compiled output SHALL contain variable declarations (`declare-const`), function declarations (`declare-fun`), and assertions (`assert`) but SHALL NOT include `(check-sat)`. THE spec-check tool SHALL append `(check-sat)` at query execution time when submitting the compiled output to the solver.

**Postcondition:** Compiled SMT-LIB is a reusable component that can be composed into different query types (satisfiability, implication) without stripping embedded solver commands.

#### Scenario: Assertion Expressions Exposed [FLA-SMTLIB-ASSERTEXPRS]
WHEN the spec-check tool compiles logic IR into SMT-LIB, THE compiled output SHALL include the decomposed inner assertion expressions (without the `(assert ...)` wrapper) for use in downstream implication query construction.

**Postcondition:** Downstream consumers can construct negated or combined assertions from the compiled output without re-parsing the SMT-LIB text.
