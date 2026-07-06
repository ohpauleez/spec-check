## MODIFIED Requirements

### Requirement: Per-Spec Combined SMT-LIB Compilation [FLA-SPEC-COMBINE]
WHEN the spec-check tool performs specs-forward logic analysis, THE spec-check tool SHALL combine all formalized claims from a single merged capability analysis unit into exactly one SMT-LIB file, SHALL deduplicate compatible variable and function declarations across claims by final sanitized symbol identity, and SHALL use named assertions (`(assert (! expr :named label))`) to enable unsat-core identification. The compiled output SHALL NOT include solver commands (`check-sat`, `set-option`, `get-unsat-core`); the logic analysis orchestrator appends these at query time using a two-phase approach (Phase 1: satisfiability check only; Phase 2: re-run with `(set-option :produce-unsat-cores true)` and `(get-unsat-core)` only when UNSAT is detected).

**References:**
- `openspec/changes/variable-claim-conflict/proposal.md#Scope`
- `openspec/changes/variable-claim-conflict/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/variable-claim-conflict/proposal.md#Failure Modes`
- `openspec/changes/variable-claim-conflict/proposal.md#Quality Attributes`
- `openspec/changes/variable-claim-conflict/design.md#Architecture Decisions`
- `openspec/changes/variable-claim-conflict/design.md#Component Design`
- `openspec/changes/variable-claim-conflict/design.md#Identifier Injectivity Design`
- `openspec/changes/variable-claim-conflict/design.md#Implementation Plan`
- `openspec/changes/variable-claim-conflict/design.md#Verification Plan`

#### Scenario: Variable And Function Deduplication [FLA-SPEC-DEDUP]
WHEN multiple claims from the same merged capability analysis unit declare identical variable or function names with identical sorts or signatures after sanitization, THE spec-check tool SHALL emit only one declaration in the combined output and SHALL keep all compatible claims included.

**Postcondition:** The combined SMT-LIB file has no duplicate declarations from compatible claims, and compatible redeclarations do not re-anchor declaration ownership to a later claim.

**Trace Properties:** VSC-5, VSC-6, VSC-8.

#### Scenario: Function Signature Conflict Detection [FLA-SPEC-CONFLICT]
IF two claims from the same merged capability analysis unit declare the same sanitized function symbol with incompatible signatures, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding, SHALL exclude the later conflicting claim from the combined file, and SHALL preserve both claim identifiers, both raw function names, and the shared sanitized symbol in the finding evidence.

**Postcondition:** Function-signature conflicts are surfaced as findings rather than producing malformed solver input; no surviving sanitized function symbol has more than one signature, and the excluded claim contributes no assertions or declarations to the combined file.

**Finding Evidence:** The compiler conflict SHALL use kind `function_signature_mismatch`, SHALL expose `existingFunctionName`, `conflictingFunctionName`, `existingClaimId`, `excludedClaimId`, and `claimIds: [existingClaimId, excludedClaimId]`, and SHALL preserve the first surviving declaration as the authoritative binding.

**Trace Properties:** VSC-2, VSC-4, VSC-6, VSC-8.

#### Scenario: Variable Sort Conflict Detection [FLA-SPEC-VARSORT-CONFLICT]
IF two claims from the same merged capability analysis unit declare the same sanitized variable symbol with incompatible sorts, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding for `variable_sort_mismatch`, SHALL exclude the later conflicting claim from the combined file, and SHALL preserve both claim identifiers, both raw variable names, the shared sanitized symbol, and both sorts in the finding evidence.

**Postcondition:** No surviving combined SMT-LIB artifact contains one sanitized variable symbol with more than one sort.

**Finding Evidence:** The compiler conflict SHALL expose `existingVariableName`, `conflictingVariableName`, `expectedSort`, `conflictingSort`, `existingClaimId`, `excludedClaimId`, and `claimIds: [existingClaimId, excludedClaimId]`. Sort comparison SHALL be exact and case-sensitive over `Bool`, `Int`, `Real`, and `String`.

**Trace Properties:** VSC-1, VSC-2, VSC-3, VSC-4, VSC-8.

#### Scenario: Symbol Kind Collision Detection [FLA-SPEC-SYMKIND-CONFLICT]
IF one claim declares a sanitized symbol as a variable and another claim declares the same sanitized symbol as a function, OR IF one claim contains distinct raw names that sanitize to the same symbol with opposite declaration kinds, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding for `symbol_kind_collision`, SHALL exclude the offending claim from the combined file, and SHALL preserve both claim identifiers, both raw names, both declaration kinds, and the shared sanitized symbol in the finding evidence.

**Postcondition:** No surviving combined SMT-LIB artifact contains one sanitized symbol declared as both `declare-const` and `declare-fun`.

**Finding Evidence:** The compiler conflict SHALL expose `existingSymbolName`, `existingSymbolKind`, `conflictingSymbolName`, `conflictingSymbolKind`, `existingClaimId`, `excludedClaimId`, and `claimIds: [existingClaimId, excludedClaimId]`. For same-claim sanitizer collisions, `existingClaimId` SHALL equal `excludedClaimId`, and `claimIds` SHALL be `[claimId, claimId]`.

**Trace Properties:** VSC-2, VSC-4, VSC-8, VSC-9.

#### Scenario: Single Conflict Reason With Fixed Precedence [FLA-SPEC-CONFLICT-ORDER]
IF a claim introduces more than one kind of incompatible declaration binding relative to already-established sanitized symbols, THEN THE spec-check tool SHALL record exactly one conflict reason for that excluded claim under the fixed precedence `variable_sort_mismatch`, then `function_signature_mismatch`, then `symbol_kind_collision`.

**Postcondition:** Every excluded claim carries exactly one conflict reason, and the highest-precedence conflict is the reason reported. Conflict detection terminates for every finite claim list.

**Trace Properties:** VSC-3, VSC-4, VSC-7, VSC-8.

#### Scenario: Surviving Claim Set Is Authoritative [FLA-SPEC-CLAIMIDS]
WHEN the spec-check tool finishes combining a compile group, THE spec-check tool SHALL expose `compiled.claimIds` as the authoritative surviving-claim set containing exactly the non-excluded claims in original input order, and downstream checks SHALL derive claim inclusion from `compiled.claimIds` rather than from conflict evidence tuples.

**Postcondition:** Excluded claims contribute no assertions and no unique declarations to the emitted SMT-LIB, and `compiled.claimIds` is the single source of truth for inclusion across deeper checks, assertion labels, and unsat-core resolution.

**Trace Properties:** VSC-2, VSC-4, VSC-8.

#### Scenario: Duplicate Claim Identifier Rejected Before Solver Execution [FLA-SPEC-DUPLICATE-CLAIM-ID]
IF a compile group contains duplicate raw claim identifiers or duplicate sanitized claim identifiers, THEN THE spec-check tool SHALL emit `logic.invalid_group`, SHALL skip combined SMT-LIB compilation for that group, and SHALL NOT invoke the solver for that group.

**Postcondition:** Claim identity remains one-to-one across included claims, assertion labels, unsat-core resolution, and finding evidence.

**Finding Evidence:** Raw duplicate evidence SHALL list duplicated raw IDs and affected claims. Sanitized duplicate evidence SHALL list colliding raw IDs and the shared sanitized ID. Invalid-group rejection is structural and SHALL NOT be reported as a merge conflict.

**Trace Properties:** VSC-10, VSC-10b.

#### Scenario: Oversized Compile Group Rejected Before Solver Execution [FLA-SPEC-GROUP-BOUNDS]
IF a compile group contains more claims than `CLAIMS_PER_GROUP_MAX`, OR any single claim declares more variable-plus-function symbols than `DECLARATIONS_PER_CLAIM_MAX`, THEN THE spec-check tool SHALL emit `logic.invalid_group`, SHALL skip combined SMT-LIB compilation for that group, and SHALL NOT invoke the solver or write solver artifacts for that group.

**Postcondition:** An oversized group is rejected as a graceful finding rather than aborting the run; valid sibling groups in the same analysis still compile and run to completion.

**Finding Evidence:** Group-cardinality rejection SHALL use reason `group_too_large` and list the observed claim count and the limit. Per-claim declaration rejection SHALL use reason `claim_too_many_declarations` and list the offending claim ID, the observed declaration count, the limit, and SHALL relate the finding to that claim ID. Size rejection is structural and SHALL NOT be reported as a merge conflict. The `compileSpecSmtlib()` size `precondition` checks remain as unreachable backstops that defend the caller contract when this preflight is bypassed.

**Trace Properties:** VSC-10c.

#### Scenario: Dangling Assertion Reference Becomes Solver Error [FLA-SPEC-DANGLING-REF]
IF a claim assertion references a declaration that becomes undefined after another claim is merge-excluded, THEN THE spec-check tool SHALL surface the unresolved reference through the `logic.solver_error` path rather than silently emitting malformed solver input.

**Postcondition:** Assertion-reference resolution is out of scope for merge exclusion; any resulting dangling reference is reported as a solver error with preserved solver input and output as evidence.

#### Scenario: Untrusted Comment Text Stays Inert [FLA-SPEC-COMMENT-SAFE]
WHEN the spec-check tool emits SMT-LIB mapping comments generated from untrusted strings such as claim identifiers, raw symbol names, or source paths, THE spec-check tool SHALL escape line-breaking characters so the comment text cannot introduce executable solver commands on following lines.

**Postcondition:** Raw evidence embedded in compiler output remains inert comment data and cannot inject SMT-LIB commands by starting a new line.

**Trace Properties:** VSC-11, VSC-12.

#### Scenario: Named Assertion Labels Map To Claims [FLA-SPEC-NAMED]
WHEN the spec-check tool generates named assertions in the combined SMT-LIB, THE label for each assertion SHALL encode the source claim identifier and assertion index so that unsat-core results can be mapped back to specific included claims.

**Postcondition:** The assertion-name-to-claim-ID mapping is deterministic and reversible, and `assertionNameMap` contains labels for included claims only.

**Trace Properties:** VSC-8.

#### Scenario: Assertion Label Encoding Is Injective [FLA-SPEC-LABEL-ENCODE]
WHEN the spec-check tool encodes a named-assertion label, THE spec-check tool SHALL form the label as `<sanitizedClaimId>__a<index>`, where `sanitizeIdentifier()` is injective: it passes through only ASCII letters and digits `[A-Za-z0-9]`, reserves `_` as the escape lead, and escapes every other code point — including a literal underscore (`U+005F` becomes `_00005F`) — as `_` followed by exactly six uppercase hexadecimal digits of the Unicode code point. It SHALL escape a leading raw digit, SHALL map the empty string to `_`, and SHALL perform no Unicode normalization.

**Postcondition:** Because every escape is a fixed six-digit width the encoding is uniquely decodable, and because `_` occurs only as an escape lead followed by six hex digits the literal sequence `__` never appears inside a sanitized claim identifier produced from a non-empty raw string; the `__a<index>` separator therefore remains unambiguous and distinct raw claim IDs cannot produce colliding assertion labels.

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

### Requirement: Formalization Sample Schema Validation [FLA-VALIDATE-SAMPLE]
WHEN the spec-check tool receives a formalization sample from `opencode`, THE spec-check tool SHALL validate the sample against the logic IR schema — including sort consistency, assertion well-formedness, identifier format, and same-claim declaration uniqueness — before accepting it into clustering.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`
- `openspec/changes/variable-claim-conflict/design.md#Validation Design`
- `openspec/changes/variable-claim-conflict/design.md#Identifier Injectivity Design`

#### Scenario: Valid Sample Accepted [FLA-SAMPLE-ACCEPT]
WHEN a formalization sample passes schema validation for sort consistency, assertion well-formedness, and identifier format, THE spec-check tool SHALL accept it as a clustering candidate.

**Postcondition:** Only structurally valid samples enter the clustering phase.

#### Scenario: Invalid Sample Rejected [FLA-SAMPLE-REJECT]
IF a formalization sample violates the logic IR schema, THEN THE spec-check tool SHALL reject it from clustering and preserve the invalid sample as evidence.

**Postcondition:** Invalid formalizations are visible to reviewers without corrupting downstream analysis.

#### Scenario: Same-Claim Declaration Collisions Rejected [FLA-SAMPLE-SAMECLAIM]
IF a single claim declares overlapping raw variable and function names, OR declares duplicate same-kind variables or functions whose raw names sanitize to one symbol, THEN THE spec-check tool SHALL reject that sample during schema validation before it enters clustering.

**Postcondition:** Same-claim structural declaration collisions that do not depend on merge order are rejected at validation; residual same-claim cross-kind sanitizer collisions are deferred to compiler-level `symbol_kind_collision` detection.

#### Scenario: All Samples Invalid After Retries [FLA-SAMPLE-EXHAUST]
IF all formalization samples for a claim are invalid after bounded retries, THEN THE spec-check tool SHALL record the failure as an error in the formalization output and SHALL exclude that claim from clustering. THE tool SHALL NOT abort the entire phase unless no claims produce valid candidates.

**Postcondition:** Per-claim formalization failures are collected as errors; remaining valid claims proceed to clustering.
