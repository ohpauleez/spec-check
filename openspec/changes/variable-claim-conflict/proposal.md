## Motivation

Specs-forward logic analysis currently handles one declaration-conflict class precisely and lets two adjacent declaration hazards slip through. If two claims declare the same sanitized variable symbol with different sorts, the merge path silently keeps the first declaration and analyzes later assertions under the wrong sort. If one claim declares a sanitized symbol as a variable and another declares the same symbol as a function, the combined SMT-LIB is emitted with both declarations and the solver rejects it later with an opaque error. In both cases the user loses claim-attributed diagnostics at the point where the system already has enough information to explain the problem.

There is also a downstream coherence defect: deeper pairwise and completeness checks currently derive exclusion from conflict evidence tuples rather than from the claims that actually survived compilation. That can suppress analysis for a surviving claim whose assertions were emitted, creating a false negative between the compiled SMT-LIB and the findings built from it.

This change is needed now because the merge boundary is the last deterministic place where the tool still knows which claim introduced a declaration, which claim conflicted, and what symbol identity the solver will see. If the system keeps deferring these cases to solver rejection or to imprecise downstream filtering, correctness and traceability both degrade.

## Scope

### In Scope
- Detect declaration conflicts across merged claims when the same sanitized symbol is reused with incompatible variable sorts.
- Detect declaration conflicts across merged claims when the same sanitized symbol is reused across declaration kinds (variable versus function).
- Preserve first-wins claim inclusion semantics while making the excluded claim and conflict reason explicit.
- Make `compiled.claimIds` the authoritative record of which claims survived combined SMT-LIB compilation.
- Reject duplicate raw claim identifiers before solver execution for a compile group.
- Add a defense-in-depth check for colliding sanitized claim identifiers before solver execution for a compile group.
- Tighten the identifier-sanitization contract so distinct raw identifiers cannot silently collapse to the same solver-facing symbol.
- Update report-side evidence rendering expectations so raw conflict evidence remains inert data in Markdown output.
- Capture the requirements deltas in the existing `formalization-and-logic-analysis`, `reporting-and-evidence`, and `merged-capability-analysis` capability specs.

### Out of Scope
- Adding arbitrary user-defined logic sorts.
- Parsing assertions deeply enough to resolve all identifier references before solver execution.
- Replacing the current first-wins merge policy with a different precedence or arbitration model.
- Changing merge-layer capability selection or requirement-block delta semantics.
- Implementing new solver result categories beyond the existing structural-invalid-group, merge-conflict, contradiction, solver-error, and inconclusive flows.

## Context

### Background
The tool merges claims from one logical analysis unit into one combined SMT-LIB artifact. That merge already deduplicates compatible declarations and detects incompatible function signatures, excluding the later conflicting claim. The current behavior assumes that variable declarations are safe to deduplicate by sanitized name and that variable and function namespaces can be tracked independently. Those assumptions break once distinct raw declarations sanitize to the same solver-facing symbol or once claims disagree about whether a symbol is a constant or a function.

The specs-forward pipeline also groups claims under merged capability logical keys rather than under raw source paths. That grouping is correct for analysis, but it increases the importance of claim-identity uniqueness because multiple claims from merged inputs now share one compile group, one assertion-label namespace, and one set of downstream findings.

### Affected Systems and Stakeholders
- The specs-forward logic compilation and analysis pipeline.
- The reporting pipeline that renders solver findings and evidence into Markdown reports.
- Maintainers of the formalization, merge, and reporting subsystems.
- Reviewers who rely on merged SMT-LIB artifacts and claim-attributed findings to diagnose spec defects.

### Assumptions and Dependencies
- Formalization samples continue to pass structural validation before they reach combined SMT-LIB compilation.
- Merged capability grouping remains the upstream source of compile groups for specs-forward logic analysis.
- The identifier sanitization routine is the shared boundary for solver-facing symbol identity and assertion-label generation.
- Existing OpenSpec trace coverage remains enforced, so any new scenario identifiers must land with their covering tests.

### Constraints
- This is a delta to existing capabilities, not a new capability introduction.
- The change must preserve deterministic first-wins merge behavior for compatible inputs.
- Security-sensitive evidence values remain untrusted across compiler and reporting boundaries.
- The current change must not broaden into full unresolved-reference analysis; dangling references may continue to surface through the existing solver-error path.

### References
- `01_variable_sort_conflict_plan_b.md`
- `openspec/specs/formalization-and-logic-analysis/spec.md`
- `openspec/specs/reporting-and-evidence/spec.md`
- `openspec/specs/merged-capability-analysis/spec.md`

## Domain Model

The relevant domain consists of five conceptual entities:

- **Compile Group**: The ordered set of claims analyzed together under one logical analysis unit. It defines the declaration namespace, assertion-label namespace, and solver submission boundary.
- **Claim**: A single formalized statement with a human-meaningful claim identifier, declarations, and assertions. Claim order within a compile group is semantically significant because merge conflicts use first-wins precedence.
- **Declaration Symbol**: The solver-facing identity produced after identifier sanitization. Multiple raw names may map into the same declaration symbol if sanitization is not injective; this change removes that ambiguity.
- **Declaration Binding**: The first surviving claim’s interpretation of a declaration symbol as a variable of one sort or a function of one signature. Later compatible claims may reuse the binding; later incompatible claims are excluded.
- **Conflict Finding**: Structured evidence that records why a claim was excluded or why a compile group is invalid before solver work begins.

Relationships:

```text
Merged Capability / Source Group
              |
              v
        Compile Group
              |
      +-------+-------+
      |               |
      v               v
    Claim --------> Assertion Labels
      |
      v
 Raw Declarations
      |
 sanitizeIdentifier()
      v
Declaration Symbols
      |
 first surviving binding
      v
Variable Sort / Function Signature / Symbol Kind
```

The core correctness boundary is the mapping from ordered claims to surviving declaration bindings and included claim identifiers. Reporting and downstream checks must derive their view of inclusion from that same surviving set.

## Inputs, Outputs, And Data Domains

| Item | Domain / Encoding |
|------|-------------------|
| `specFile` | Raw UTF-16 JavaScript string identifying the analysis unit. In the specs-forward path this is the merged-capability `logicalFile` group key, not necessarily a raw source path. It is sanitized with `sanitizeIdentifier()` before use in artifact keys or SMT-LIB-derived labels, and comment-escaped before comment emission. No Unicode normalization is performed. |
| `claims` | `readonly LogicIrClaim[]`, processed in array order. Input order defines first-wins conflict semantics. |
| `claimId` | Raw claim identifier string carried as evidence and sanitized only when encoded into SMT-LIB labels. It must be unique within one compile group because compiled inclusion, exclusions, assertion labels, unsat-core mapping, and findings are keyed by claim ID. Raw uniqueness is the primary check; sanitized uniqueness is a defense-in-depth check. |
| Variable symbol identity | Final sanitized SMT-LIB symbol from `sanitizeIdentifier(variable.name)`. This matches the emitted declaration namespace and catches sanitizer collisions. |
| Function symbol identity | Final sanitized SMT-LIB symbol from `sanitizeIdentifier(fn.name)`, matching existing function-merge behavior. |
| Sorts | Closed `LogicSort` union: `Bool`, `Int`, `Real`, and `String`. Comparison is exact and case-sensitive. User-defined sorts are out of scope unless `LogicSort` is extended. |
| SMT-LIB text | UTF-16 JavaScript string containing SMT-LIB keywords, sanitized declaration symbols, sanitized assertion labels, sanitized identifier-like assertion tokens, and escaped comments. Non-identifier assertion content remains verbatim after assertion validation; assertion text is not globally ASCII. |
| Conflict evidence | Existing-side and conflicting-side raw names, shared sanitized symbol, both claim IDs, and per-kind details such as sorts or declaration kinds. Raw names may differ while the sanitized symbol matches. |
| SMT-LIB comments | Raw `specFile`, `claimId`, assertion IDs, and conflict evidence are untrusted. Comments must escape CR/LF so untrusted content cannot introduce executable SMT-LIB lines. Markdown renderers must separately neutralize evidence for report output. |

`sanitizeIdentifier()` MUST be injective: distinct raw identifiers must never share a sanitized form. `_` is the reserved escape lead rather than a pass-through character; a literal underscore is escaped like any other reserved code point, for example `_5F`. Hex escapes are self-delimiting, either fixed-width per code point or delimited, so variable-width escapes such as `_1F600` remain uniquely decodable. Unsafe code points are emitted as uppercase hexadecimal prefixed with `_`.

## Preconditions, Postconditions, and Invariants

### Preconditions
- Each compile group is finite and ordered.
- Each claim has passed structural validation before compilation.
- Claim identifiers are intended to be unique within a compile group.
- Variable and function declarations are interpreted through the final sanitized symbol identity seen by the solver.
- Variable names are unique within a single claim after sanitization, enforced by validation.
- Function names are unique within a single claim after sanitization, enforced by validation.
- No raw variable name equals a raw function name within a single claim, enforced by validation.
- Residual sanitizer-induced same-claim variable/function collisions remain representable and are detected during compilation as `symbol_kind_collision`.
- Assertion expressions may still contain references that become dangling after another claim is excluded; this change deliberately keeps those cases on the existing solver-error path rather than adding assertion-reference resolution.
- Formalization input, names, claim IDs, paths, assertion IDs, and evidence values are untrusted until validation, sanitization, comment escaping, and report rendering have applied their respective boundaries.

If a precondition other than claim-ID uniqueness is violated, merge behavior remains deterministic but the result is outside this change's soundness guarantee. Duplicate raw or sanitized claim IDs are rejected before compilation or solver execution.

### Postconditions
- Every surviving claim in the combined SMT-LIB appears in `compiled.claimIds`, in original input order.
- Every excluded claim has one explicit conflict reason under the fixed first-conflict-wins precedence.
- No compile group with duplicate raw claim identifiers or colliding sanitized claim identifiers reaches solver execution.
- Deeper logic checks consume the same surviving claim set that the compiler emitted.
- Reported merge findings preserve enough evidence to identify the existing declaration, the excluded declaration, and the shared sanitized symbol.
- Each conflict records `existingClaimId`, `excludedClaimId`, and the two-element evidence tuple `claimIds: [existingClaimId, excludedClaimId]` in that order.
- `assertionNameMap` contains labels only for included claims.
- No emitted combined SMT-LIB contains a surviving sanitized variable symbol with more than one sort.
- No emitted combined SMT-LIB contains a surviving sanitized function symbol with more than one signature.
- No emitted combined SMT-LIB contains one sanitized symbol declared as both `declare-const` and `declare-fun`.
- Assertions and unique declarations from excluded claims are absent from emitted SMT-LIB.
- SMT-LIB comments generated from untrusted strings cannot introduce executable commands on following lines.

### Invariants
- Combined SMT-LIB output never contains two surviving declarations for one sanitized symbol that disagree on variable sort, function signature, or declaration kind.
- Compatible redeclarations do not change the original authoritative binding for a symbol.
- Excluded claims do not contribute declarations or assertions to the combined SMT-LIB.
- Evidence remains data across compiler comments and rendered reports; untrusted values must not create executable SMT-LIB commands or synthetic rendered findings.
- Conflict detection terminates for every finite claim list.
- Same ordered input claims produce the same included claims, conflicts, assertion-name map, and emitted SMT-LIB.
- Compatible variable declarations remain included and analyzable.
- Compatible function declarations retain existing behavior for inputs without higher-precedence variable-sort or symbol-kind conflicts.
- Merge-conflict records are evidence only; behavioral inclusion is derived from `compiled.claimIds`.

## Safety And Liveness Claims

| ID | Kind | Claim |
|----|------|-------|
| VSC-1 | Safety | Never emit a combined SMT-LIB file where one surviving sanitized variable symbol has multiple sorts. |
| VSC-2 | Safety | Never include assertions from a claim excluded by a merge conflict. |
| VSC-3 | Safety | Never hide a variable-sort mismatch behind first-wins deduplication; record `variable_sort_mismatch` for the later incompatible claimant. |
| VSC-4 | Safety | Deeper checks derive inclusion directly from `compiled.claimIds`; conflict evidence can never imply a different exclusion outcome than compilation used. |
| VSC-5 | Liveness | Compatible variable declarations remain included and analyzable. |
| VSC-6 | Liveness | Compatible function declarations retain existing behavior for inputs without variable-sort or symbol-kind conflicts. |
| VSC-7 | Liveness | Conflict detection terminates for any finite claim list. |
| VSC-8 | Determinism | Same input claims in the same order produce the same included claims, conflicts, assertion maps, and emitted SMT-LIB. |
| VSC-9 | Safety | Never emit a combined SMT-LIB file where one sanitized symbol is declared as both a variable and a function. |
| VSC-10 | Safety | Never build or consume a solver query for duplicate raw `claimId` values. |
| VSC-10b | Safety | Never build a query for two claims whose sanitized claim IDs collide; sanitized-ID uniqueness preflight enforces this even if sanitizer injectivity regresses. |
| VSC-11 | Safety | Untrusted strings emitted in SMT-LIB comments cannot inject commands by introducing new SMT-LIB lines. |
| VSC-12 | Safety | Security-sensitive evidence values remain data across compiler output and reports; raw names, claim IDs, assertion IDs, and paths cannot create executable SMT-LIB commands or synthetic rendered findings. |

`VSC-*` identifiers are change-local engineering property tags. Canonical traceability remains through OpenSpec scenario identifiers such as `FLA-SPEC-VARSORT-CONFLICT`, `FLA-SPEC-SYMKIND-CONFLICT`, `FLA-SPEC-DUPLICATE-CLAIM-ID`, `RAE-EVID-RENDER-SAFE`, and `MCA-MERGE-GROUP-KEY`.

## Conflict Semantics

The merge phase uses first-wins semantics over input order. Per claim, at most one conflict is recorded, selected by fixed precedence: `variable-sort -> function-signature -> symbol-kind`.

1. The first included claim to declare a sanitized variable symbol establishes that symbol's sort, and the first included claim to declare a sanitized function symbol establishes that function's signature.
2. A later claim redeclaring the same sanitized variable symbol with the same sort, or the same sanitized function symbol with the same signature, is compatible and remains included.
3. A later claim redeclaring the same sanitized variable symbol with a different sort is excluded with one `variable_sort_mismatch`.
4. Otherwise, a later claim redeclaring the same sanitized function symbol with a different signature is excluded with one `function_signature_mismatch`.
5. Otherwise, if a sanitized symbol is used as both a variable and a function, across claims or within one claim through a sanitizer collision, the offending later or single claim is excluded with one `symbol_kind_collision`.
6. Excluded claims are not registered, so they cannot poison later comparisons.
7. Detection scans variables before functions before cross-kind checks, then breaks on the first hit for the current claim.

Same-claim sanitizer collision edge case: when one claim declares two distinct raw names that sanitize to the same symbol with opposite kinds, the single claim is excluded and `existingClaimId === excludedClaimId`; the `claimIds` tuple is `[claimId, claimId]`.

## Failure Modes

- **Silent variable-sort aliasing**: Two claims reuse one sanitized variable symbol with different sorts, but the combined artifact silently keeps the first sort.
  - **Rationale**: This can make the solver analyze assertions under the wrong declaration, which is a correctness failure disguised as a successful compile.
- **Opaque symbol-kind redeclaration**: One claim treats a sanitized symbol as a variable and another as a function, and the solver rejects the emitted SMT-LIB later.
  - **Rationale**: Users receive an unhelpful solver error instead of a precise claim-attributed merge finding.
- **Compile-group identity aliasing**: Two claims share one raw or sanitized claim identifier within a compile group.
  - **Rationale**: Assertion labels, exclusion accounting, and related-claim evidence become ambiguous, so solver conclusions can no longer be trusted.
- **Downstream inclusion drift**: Deeper checks analyze a different claim set than the one emitted into the combined SMT-LIB.
  - **Rationale**: The tool can report false negatives or omit surviving behavior, undermining the trustworthiness of later findings.
- **Rendered evidence injection**: Raw conflict evidence changes report structure instead of remaining inert text.
  - **Rationale**: Reviewers can be misled by synthetic headings, links, list items, or table cells that were never intended as findings.

## Quality Attributes

- **Correctness**:
  - **Target/Threshold**: No surviving combined SMT-LIB artifact may contain conflicting bindings for one sanitized symbol.
  - **Influence**: Conflict detection must occur before solver submission and must align exactly with emitted claims.
- **Determinism**:
  - **Target/Threshold**: The same ordered compile group always yields the same included claims, conflicts, and emitted SMT-LIB.
  - **Influence**: Ordered first-wins semantics and insertion-ordered registries remain part of the contract.
- **Traceability**:
  - **Target/Threshold**: Every exclusion or invalid-group outcome preserves claim-attributed evidence and traceable scenario IDs.
  - **Influence**: Findings and spec deltas must explicitly distinguish existing versus excluded claims and symbols.
- **Security**:
  - **Target/Threshold**: Untrusted identifiers and evidence values must remain inert across SMT-LIB emission and Markdown rendering.
  - **Influence**: Sanitization and escaping contracts become part of the spec-level behavior, not just implementation detail.
- **Reliability**:
  - **Target/Threshold**: Invalid compile groups are rejected before any solver or artifact-writing side effects for that group.
  - **Influence**: Duplicate-claim preflight must happen before combined query construction and solver execution.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `formalization-and-logic-analysis`: Expand combined SMT-LIB merge semantics to cover variable-sort conflicts, symbol-kind conflicts, duplicate claim-ID preflight, injective identifier sanitization, and downstream inclusion derived from compiled surviving claims.
- `reporting-and-evidence`: Strengthen evidence-rendering requirements so merge-conflict evidence and related raw values remain inert data in Markdown reports.
- `merged-capability-analysis`: Clarify that merged capability logical grouping can place multiple source claims into one downstream compile group, making compile-group claim-identity uniqueness a required downstream safety boundary.
