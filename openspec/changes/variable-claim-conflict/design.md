## Context

### Current State

`compileSpecSmtlib()` currently detects one declaration-conflict class when merging claims into combined SMT-LIB: if two claims declare the same sanitized function symbol with different signatures, the later claimant is excluded and a `SpecMergeConflict` is recorded. Two adjacent declaration hazards remain:

1. Variable-sort gap: two claims can declare the same SMT-LIB variable symbol with different sorts, for example `State: Bool` and `State: Int`. The emission pass deduplicates variables by sanitized name, so the first sort is emitted and the mismatch is ignored. The solver then analyzes assertions under the wrong declaration.
2. Symbol-kind gap: a sanitized symbol can be declared as a variable by one claim and as a function by another. Variables and functions are tracked separately, both declarations are emitted, and Z3 rejects the redeclaration as an opaque `logic.solver_error` instead of a precise claim-attributed finding.

Separately, `analyzeSpecGroup()` builds its deeper-check exclusion set from every claim ID in every conflict tuple. That removes the surviving first claimant from pairwise and completeness checks even though its assertions were emitted into the combined SMT-LIB. This change makes `compiled.claimIds` the single source of truth for downstream inclusion.

The reporting layer renders evidence into Markdown. Raw evidence values are security-sensitive data and must be neutralized so they cannot become links, emphasis, inline code, headings, list items, block quotes, or extra table cells. The merged-capability layer supplies synthetic logical grouping keys; those keys are correct grouping identities but are not raw source paths and must be treated as untrusted strings.

### Goals

- Detect variable-sort mismatches, function-signature mismatches, and symbol-kind collisions at the deterministic SMT-LIB merge boundary.
- Preserve first-wins claim inclusion semantics while making the excluded claim and conflict reason explicit.
- Make `compiled.claimIds` the authoritative surviving-claim set for all downstream logic checks.
- Reject duplicate raw or sanitized claim identifiers before compilation, artifact writes, or solver calls for a group.
- Make solver-facing identifier sanitization injective.
- Keep security-sensitive compiler comments and Markdown report evidence inert.
- Capture implementation, analysis, invariants, validation, verification, and traceability in the OpenSpec artifacts for this change.

### Non-Goals

- Introducing user-defined sorts.
- Replacing first-wins precedence or adding a different arbitration model.
- Adding full assertion-reference parsing or unresolved-reference diagnostics.
- Redesigning merged-capability selection or requirement-block delta semantics.
- Introducing new solver result categories beyond existing invalid-group, merge-conflict, contradiction, solver-error, and inconclusive flows.

## Inputs, Outputs, And Data Domains

### Domain Model

The relevant domain consists of five conceptual entities:

- Compile Group: the ordered set of claims analyzed together under one logical analysis unit. It defines the declaration namespace, assertion-label namespace, and solver submission boundary.
- Claim: a single formalized statement with a human-meaningful claim identifier, declarations, and assertions. Claim order within a compile group is semantically significant because merge conflicts use first-wins precedence.
- Declaration Symbol: the solver-facing identity produced after identifier sanitization. Multiple raw names may map into the same declaration symbol if sanitization is not injective; this change removes that ambiguity.
- Declaration Binding: the first surviving claim's interpretation of a declaration symbol as a variable of one sort or a function of one signature. Later compatible claims may reuse the binding; later incompatible claims are excluded.
- Conflict Finding: structured evidence that records why a claim was excluded or why a compile group is invalid before solver work begins.

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

| Item | Domain / Encoding |
|------|-------------------|
| `specFile` | Raw UTF-16 JavaScript string identifying the analysis unit. In the specs-forward path this is the merged-capability `logicalFile` group key, not necessarily a raw source path. It is sanitized with `sanitizeIdentifier()` before use in artifact keys or SMT-LIB-derived labels, and comment-escaped before comment emission. No Unicode normalization is performed. |
| `claims` | `readonly LogicIrClaim[]`. Claims are processed in array order, which defines first-wins conflict semantics. |
| `claimId` | Raw claim identifier string carried as evidence and sanitized only when encoded into SMT-LIB labels. It must be unique within one compile group because compiled inclusion, exclusions, assertion labels, unsat-core mapping, and findings are keyed by claim ID. Raw uniqueness is the primary check; sanitized uniqueness is a defense-in-depth check. |
| Variable symbol identity | Final sanitized SMT-LIB symbol from `sanitizeIdentifier(variable.name)`. This matches the emitted declaration namespace and catches sanitizer collisions. |
| Function symbol identity | Final sanitized SMT-LIB symbol from `sanitizeIdentifier(fn.name)`, matching existing function-merge behavior. |
| Sorts | Closed `LogicSort` union: `Bool`, `Int`, `Real`, and `String`. Comparison is exact and case-sensitive. User-defined sorts are out of scope unless `LogicSort` is extended. |
| SMT-LIB text | UTF-16 JavaScript string containing SMT-LIB keywords, sanitized declaration symbols, sanitized assertion labels, sanitized identifier-like assertion tokens, and escaped comments. Non-identifier assertion content remains verbatim after assertion validation; assertion text is not globally ASCII. |
| Conflict evidence | Existing-side and conflicting-side raw names, shared sanitized symbol, both claim IDs, and per-kind details such as sorts or declaration kinds. Raw names may differ while the sanitized symbol matches. |
| SMT-LIB comments | Raw `specFile`, `claimId`, assertion IDs, and conflict evidence are untrusted. Comments must escape CR/LF so untrusted content cannot introduce executable SMT-LIB lines. Markdown renderers must separately neutralize evidence for report output. |

`sanitizeIdentifier()` MUST be injective. `_` is the reserved escape lead rather than a pass-through character; literal underscore is escaped as `_5F`. Hex escapes are self-delimiting, either fixed-width per code point or delimited, so variable-width escapes such as `_1F600` remain uniquely decodable. Unsafe code points are uppercase hexadecimal prefixed with `_`. No Unicode normalization is performed.

## Preconditions, Postconditions, And Invariants

### Preconditions

- Each claim has passed structural Logic IR validation before compilation.
- `claims` is finite and is not mutated during compilation.
- Claim IDs are unique within the compile group as raw strings; because `sanitizeIdentifier()` is injective they are equivalently unique as sanitized SMT-LIB symbols.
- Raw claim-ID uniqueness and sanitized claim-ID uniqueness are enforced before or at the compile boundary.
- Variable names are unique within a single claim after sanitization, enforced by `validate.ts`.
- Function names are unique within a single claim after sanitization, enforced by `validate.ts`.
- No raw variable name equals a raw function name within a single claim, enforced by `validate.ts`.
- Residual sanitizer-induced same-claim variable/function collisions remain compiler-detected `symbol_kind_collision` conflicts rather than validation errors.
- Assertion expressions reference declarations present in the same claim or compatible declarations from earlier included claims. This change does not enforce references that become dangling after another claim is excluded.
- Formalization input is untrusted until validation and identifier sanitization have run; comment and Markdown rendering boundaries still need separate escaping.

If a precondition other than claim-ID uniqueness is violated, the merge step remains deterministic but the result is outside the soundness guarantee. Duplicate claim IDs are rejected before compilation or solver execution.

### Postconditions

- `claimIds` contains exactly non-excluded claims in original input order and is the authoritative record of emitted claims.
- Each excluded claim has exactly one recorded merge-conflict reason under first-conflict-wins and the fixed precedence order.
- Each conflict records `existingClaimId`, `excludedClaimId`, and `claimIds: [existingClaimId, excludedClaimId]` in that order.
- `assertionNameMap` contains labels only for included claims.
- The emitted combined SMT-LIB contains no surviving sanitized variable symbol with more than one sort.
- The emitted combined SMT-LIB contains no surviving sanitized function symbol with more than one signature.
- The emitted combined SMT-LIB contains no sanitized symbol declared as both a variable and a function.
- Assertions from excluded claims are absent from emitted SMT-LIB.
- Unique declarations from excluded claims are absent from emitted SMT-LIB.
- Duplicate raw or sanitized claim IDs are rejected before solver execution. No solver query may be built for such a group.
- SMT-LIB comments generated from untrusted strings cannot introduce executable commands on following lines.

### Safety, Liveness, And Determinism Claims

| ID | Kind | Property |
|----|------|----------|
| VSC-1 | Safety | Never emit a combined SMT-LIB file where one surviving sanitized variable symbol has multiple sorts. |
| VSC-2 | Safety | Never include assertions from a claim excluded by a merge conflict. |
| VSC-3 | Safety | Never hide a variable-sort mismatch behind first-wins deduplication; record `variable_sort_mismatch` for the later incompatible claimant. |
| VSC-4 | Safety | Deeper checks derive inclusion directly from emitted `compiled.claimIds`; conflict evidence can never imply a different exclusion outcome than compilation used. |
| VSC-5 | Liveness | Compatible variable declarations remain included and analyzable. |
| VSC-6 | Liveness | Compatible function declarations retain existing behavior for inputs without variable-sort or symbol-kind conflicts. |
| VSC-7 | Liveness | Conflict detection terminates for any finite claim list. |
| VSC-8 | Determinism | Same input claims in the same order produce the same included claims, conflicts, assertion maps, and emitted SMT-LIB. This relies on insertion-ordered `Map`/`Set` iteration. |
| VSC-9 | Safety | Never emit a combined SMT-LIB file where one sanitized symbol is declared as both a variable and a function. |
| VSC-10 | Safety | Never build or consume a solver query for duplicate raw `claimId` values. |
| VSC-10b | Safety | Never build a query for two claims whose sanitized claim IDs collide; sanitized-ID uniqueness preflight enforces this even if sanitizer injectivity regresses. |
| VSC-11 | Safety | Untrusted strings emitted in SMT-LIB comments cannot inject commands by introducing new SMT-LIB lines. |
| VSC-12 | Safety | Security-sensitive evidence values remain data across compiler output and reports; raw names, claim IDs, assertion IDs, and paths cannot create executable SMT-LIB commands or synthetic rendered findings. |

`VSC-*` identifiers are change-local property tags, not canonical trace IDs. Canonical traceability uses OpenSpec scenario IDs such as `FLA-SPEC-VARSORT-CONFLICT`, `FLA-SPEC-SYMKIND-CONFLICT`, `FLA-SPEC-DUPLICATE-CLAIM-ID`, `RAE-EVID-RENDER-SAFE`, and `MCA-MERGE-GROUP-KEY`.

## Architecture Decisions

### Decision: Detect All Merge-Local Declaration Conflicts In `compileSpecSmtlib()`

- Context and objective: the compiler already has ordered claims, sanitized declaration identity, and knowledge of the first surviving declaration. It is the narrowest place to produce precise claim-attributed declaration conflict findings without depending on solver rejection.
- Options considered: leave variable/kind cases to Z3; add merge-local variable-sort and symbol-kind detection; perform all declaration validation in a preflight outside compilation.
- Decision: extend `SpecMergeConflict` into a discriminated union and detect variable-sort mismatch, function-signature mismatch, and symbol-kind collision with precedence `variable-sort -> function-signature -> symbol-kind`.
- Consequences: the compiler owns declaration-conflict semantics; tests must cover precedence, same-claim sanitizer collisions, and first-conflict-wins behavior.

### Decision: Treat `compiled.claimIds` As The Downstream Source Of Truth

- Context and objective: deriving exclusions from conflict evidence removes the surviving claimant from deeper checks. The compiler already returns the emitted claim list.
- Options considered: continue deriving exclusions from evidence tuples; add another exclusion encoding; use `compiled.claimIds` directly.
- Decision: pairwise and completeness checks filter claims using `new Set(compiled.claimIds)`.
- Consequences: conflict records remain evidence only, and future post-merge structural checks must derive their domain from `compiled.claimIds`.

### Decision: Reject Duplicate Claim Identity Before Solver Work

- Context and objective: claim IDs are identity keys for inclusion accounting, assertion labels, unsat-core resolution, and related-claim evidence. Duplicate IDs are not recoverable through merge precedence.
- Options considered: permit duplicates; treat duplicates as merge conflicts; reject invalid groups structurally before compilation.
- Decision: `logic-analysis.ts` preflights raw claim-ID uniqueness and sanitized claim-ID uniqueness before `compileSpecSmtlib()`, artifact writes, or `runZ3Query()`.
- Consequences: `logic.invalid_group` becomes part of the logic-analysis contract; tests assert zero compiler, writer, and solver work for rejected groups.

### Decision: Make `sanitizeIdentifier()` Injective

- Context and objective: current encoding treats `_` as both literal safe character and escape leader, allowing distinct raw identifiers to collapse to one sanitized form, for example `REQ(1)` and `REQ_281_29`.
- Options considered: preserve current encoding and add more collision checks; adopt an injective escape encoding.
- Decision: reserve `_` as escape lead, escape literal underscores, and keep escapes self-delimiting.
- Consequences: sanitized output changes for identifiers containing `_`; fixtures and golden artifacts keyed on sanitized names must be updated. The branded `SanitizedClaimId` type is unchanged.

### Decision: Split Security Responsibility Across Compiler And Renderer Boundaries

- Context and objective: SMT-LIB comment safety and Markdown evidence-rendering safety live in different layers.
- Options considered: treat all escaping as compiler concern; treat all escaping as renderer concern; specify both boundaries explicitly.
- Decision: compiler comment escaping prevents SMT-LIB line injection, and renderer-side Markdown neutralization prevents report-structure injection.
- Consequences: verification must include compiler tests, property tests, and renderer tests.

### Decision: Keep Dangling Assertion References On The Solver-Error Path

The merge phase can exclude a claim that declares a symbol used by a later included claim's assertion. The current implementation does not resolve assertion identifiers; malformed references fall through to Z3 and usually surface as `logic.solver_error`.

| Option | Outcome | Implications |
|--------|---------|--------------|
| Reject during `validate.ts` | Validation fails if an assertion token does not resolve to a declaration in the same claim. | Strong local safety boundary but cannot support intended cross-claim references and requires a real assertion parser or conservative token resolver. |
| Reject during group preflight | Group builder or logic analysis rejects assertions whose identifier-like tokens do not resolve against declarations in the full compile group. | Preserves cross-claim references but needs a group-level symbol table and SMT-LIB builtin allowlist. |
| Dedicated post-merge structural finding | Compile and exclude first, then scan included assertions against surviving declarations only; unresolved references produce a dedicated finding and skip Z3. | Best alignment with merge semantics but introduces a new finding category and parser/token-resolution work. |
| Keep solver-error fallback | Do not add identifier resolution; if Z3 rejects the emitted SMT-LIB, report `logic.solver_error`. | Minimal scope and preserves current behavior, but diagnostics remain weak for unresolved references. |

Decision for this change: keep solver-error fallback. Dangling-reference cases are documented limitations and are not mandatory VSC verification for this change.

Follow-up change: add a dedicated post-merge unresolved-reference check that compiles and excludes first, builds the declaration domain from `compiled.claimIds`, scans included assertions against surviving declarations, emits `logic.unresolved_reference`, and skips Z3 for affected groups.

## Component Design

### Key Components

- `src/domain/formal/smtlib.ts`: owns sanitized declaration identity, merge-local declaration registries, conflict detection, SMT-LIB emission, included claim IDs, named assertions, and conflict evidence.
- `src/domain/formal/logic-analysis.ts`: owns compile-group preflight, compiler conflict to finding conversion, solver orchestration, artifact writes, and deeper pairwise/completeness inclusion filtering.
- `src/domain/formal/validate.ts`: rejects same-claim raw variable/function overlap and same-kind duplicate declarations after sanitization.
- `src/domain/reporting/render.ts`: owns Markdown-safe formatting of descriptions, provenance, related claims, and evidence values.
- Merged-capability grouping and `merged-capability-analysis`: define compile-group membership through synthetic logical keys and make group-scoped claim-ID uniqueness mandatory.

### Data Design

- Compile group identity: merged logical file or raw spec file key used by specs-forward grouping.
- Sanitized claim identity: `sanitizeIdentifier(rawClaimId)`, pairwise unique as a defense-in-depth safety net.
- Declaration symbol identity: `sanitizeIdentifier(variable.name | function.name)`.
- Conflict record union: `function_signature_mismatch`, `variable_sort_mismatch`, `symbol_kind_collision`.
- Assertion label form: `<sanitizedClaimId>__a<index>`. Label uniqueness follows from sanitized claim-ID uniqueness and per-claim assertion index uniqueness.

### Interface Contracts

- Compiler input: ordered `LogicIrClaim[]` for one compile group.
- Compiler output: combined SMT-LIB text, included `claimIds`, assertion label map, and conflict records.
- Compiler invariant: excluded claims contribute neither declarations nor assertions.
- Logic-analysis preflight input: compile group before compilation.
- Logic-analysis preflight output: either a valid group passed to compilation or a `logic.invalid_group` finding with no compilation, artifact-writing, or solver work.
- Renderer input: finding descriptions, provenance, related claims, and evidence values that may contain untrusted text.
- Renderer output: Markdown where those values remain inert data.

## Implementation Plan

### Type Design

Extend `SpecMergeConflict` to a three-kind discriminated union. Behavioral inclusion is derived from `compiled.claimIds`; claim-ID fields are evidence only for human-readable findings.

```typescript
export type SpecMergeConflict =
  | {
      readonly kind: "function_signature_mismatch";
      readonly sanitizedName: string;
      readonly existingFunctionName: string;
      readonly conflictingFunctionName: string;
      readonly existingClaimId: string;
      readonly excludedClaimId: string;
      readonly claimIds: readonly [string, string];
    }
  | {
      readonly kind: "variable_sort_mismatch";
      readonly sanitizedName: string;
      readonly existingVariableName: string;
      readonly conflictingVariableName: string;
      readonly expectedSort: LogicSort;
      readonly conflictingSort: LogicSort;
      readonly existingClaimId: string;
      readonly excludedClaimId: string;
      readonly claimIds: readonly [string, string];
    }
  | {
      readonly kind: "symbol_kind_collision";
      readonly sanitizedName: string;
      readonly existingSymbolName: string;
      readonly existingSymbolKind: "variable" | "function";
      readonly conflictingSymbolName: string;
      readonly conflictingSymbolKind: "variable" | "function";
      readonly existingClaimId: string;
      readonly excludedClaimId: string;
      readonly claimIds: readonly [string, string];
    };
```

`claimIds` remains `[existingClaimId, excludedClaimId]` for report compatibility. The existing function-conflict `functionName` field is renamed to `existingFunctionName` and `conflictingFunctionName`; known consumers and tests must be updated.

### Detection Design

In `compileSpecSmtlib()` first pass, maintain two insertion-ordered registries of included claims only, keyed by sanitized symbol:

- `declaredVariables: Map<string, { variableName: string; sort: LogicSort; claimId: string }>`
- `declaredFunctions: Map<string, { functionName: string; fn: LogicFunctionSymbol; claimId: string }>`

For each claim, apply the fixed precedence and break on the first conflict:

1. Variable-sort: for each variable, compute `sanName = sanitizeIdentifier(variable.name)`. If `declaredVariables.has(sanName)` and its `sort` differs, record `variable_sort_mismatch` with `expectedSort` from the first claimant and `conflictingSort` from the current claim, then exclude the current claim.
2. Function-signature: otherwise, for each function, if `declaredFunctions.has(sanName)` and `!signaturesMatch(...)`, record `function_signature_mismatch`, then exclude the current claim.
3. Symbol-kind: otherwise, detect a symbol used as both variable and function if the current claim's variable `sanName` is present in `declaredFunctions`, if the current claim's function `sanName` is present in `declaredVariables`, or if a `sanName` appears in both this claim's variable set and function set through same-claim sanitizer collision. Record `symbol_kind_collision`, then exclude the current claim.
4. Register: if no conflict, register variables and functions with first-wins guards: `if (!declaredVariables.has(sanName))` and `if (!declaredFunctions.has(sanName))`. These guards are mandatory because compatible redeclarations must not re-anchor ownership or overwrite the established sort/signature.
5. Emit: the second emission pass emits declarations, assertions, `claimIds`, and assertion-name map entries only for non-excluded claims.

### Validation Design

`validate.ts` enforces same-claim structural constraints that do not depend on group merge order:

- Reject raw variable/function name overlap within one claim.
- Reject duplicate variables whose raw names sanitize to one variable symbol.
- Reject duplicate functions whose raw names sanitize to one function symbol.
- Do not reject sanitizer-induced cross-kind collisions within one claim; those remain compiler-level `symbol_kind_collision` conflicts because they depend on final sanitized SMT-LIB identity.

### Identifier Injectivity Design

`sanitizeIdentifier()` changes from many-to-one to injective:

- Remove `_` from the pass-through set; `_` becomes the reserved escape lead.
- Escape literal `_` as `_5F`.
- Ensure all escapes are self-delimiting, either fixed-width per code point or delimited.
- Keep unsafe code points as uppercase hexadecimal prefixed with `_`.
- Perform no Unicode normalization.

Consequences: no `__` appears inside a sanitized identifier under the new scheme, so the reserved `__a<index>` assertion-label separator remains unambiguous. Sanitized output changes for underscore-containing identifiers; tests and fixtures must be updated.

### Finding Conversion And Group Preflight

In `logic-analysis.ts`:

- Before `compileSpecSmtlib()`, check duplicate raw `claimId` values within each group. If duplicates exist, emit one `logic.invalid_group` finding with severity `error`, list duplicated IDs and affected claims, skip compilation, skip artifact writes, skip solver execution, and add a report line.
- Then verify sanitized claim IDs are pairwise unique. If two claims share a sanitized ID, emit `logic.invalid_group`, list colliding raw IDs and the shared sanitized ID, skip compilation, skip artifact writes, skip solver execution, and add a report line.
- Replace exclusion-set construction from conflict tuples with `const includedClaimIds = new Set(compiled.claimIds)` and filter deeper checks by inclusion.
- Convert all conflict kinds into `logic.merge_conflict` findings with an exhaustive `switch (conflict.kind)`.
- Keep severity hardcoded to `error` for all merge-conflict and invalid-group findings, independent of obligation.
- Preserve both claim IDs in evidence. Include per-kind sanitized symbol, both raw names, both raw kinds where relevant, and both sorts for variable-sort conflicts.

### Reporting Design

`src/domain/reporting/render.ts` must neutralize raw Markdown control syntax in finding descriptions, provenance, related claim identifiers, and evidence values. The renderer must cover links, emphasis, inline code spans and backticks, table pipes, headings, block quotes, list items, and table-cell breakout. Escaping must preserve inspectability while preventing evidence from changing report structure.

### Files Touched

| File | Change |
|------|--------|
| `src/domain/formal/smtlib.ts` | Extend `SpecMergeConflict`; add `declaredVariables`; add `functionName` to `declaredFunctions`; detect variable-sort and symbol-kind conflicts; preserve function-signature behavior; add first-wins registration guards; make `sanitizeIdentifier()` injective; update JSDoc invariants. |
| `src/domain/formal/logic-analysis.ts` | Reject duplicate raw and sanitized claim IDs with `logic.invalid_group`; skip compile, write, and solver work for invalid groups; exhaustively convert conflict kinds; derive downstream inclusion from `compiled.claimIds`; keep structural severity `error`. |
| `src/domain/formal/validate.ts` | Reject raw variable/function overlap and duplicate same-kind declarations by sanitized symbol; leave same-claim cross-kind sanitizer collisions for compiler conflicts. |
| `src/domain/reporting/render.ts` | Neutralize Markdown control syntax in evidence-bearing report content. |
| `test/contract/smtlib.test.ts` | Add variable-sort, symbol-kind, sanitizer-collision, precedence, first-conflict-wins, excluded-declaration/assertion, and injective-sanitizer tests; update function-conflict field expectations. |
| `test/contract/logic-analysis.test.ts` | Add per-kind finding tests, downstream-inclusion regression tests, duplicate raw ID rejection, sanitized-ID rejection, and zero-work assertions. |
| `test/contract/validate.test.ts` | Add same-claim raw var/fn overlap, duplicate sanitized-variable, and duplicate sanitized-function rejections. |
| `test/contract/reporting.test.ts` or existing reporting tests | Add Markdown inertness tests for merge-conflict and invalid-group evidence. |
| `test/property/logic.property.test.ts` | Add state-machine and security properties described below. |
| `openspec/specs/formalization-and-logic-analysis/spec.md` | Add and narrow scenarios; update model with claim identity and declaration kind; document VSC evidence obligations. |
| `openspec/specs/reporting-and-evidence/spec.md` | Add evidence-rendering safety and merge/invalid-group evidence requirements. |
| `openspec/specs/merged-capability-analysis/spec.md` | Clarify synthetic logical key as compile-group boundary and claim-ID uniqueness scope. |

### Ordered Implementation Steps

1. Extend `SpecMergeConflict` to the three-kind union with both raw names and explicit `existingClaimId`/`excludedClaimId`.
2. Update function-conflict creation to populate the renamed explicit fields while preserving `claimIds` tuple order.
3. Add `functionName` to `declaredFunctions` entries and introduce `declaredVariables`.
4. Add variable-sort detection, then function-signature detection, then symbol-kind detection, each breaking on first hit.
5. Add first-wins registration guards for both registries and ensure excluded claims are never registered.
6. Make `sanitizeIdentifier()` injective by escaping `_` and using self-delimiting escapes. Update underscore-sensitive fixtures and invert the previous raw-dedup characterization test.
7. Add validation rejections for raw var/fn name overlap, duplicate sanitized variables, and duplicate sanitized functions.
8. Add group preflight for duplicate raw claim IDs and colliding sanitized claim IDs, each emitting `logic.invalid_group` and skipping compile, write, and solver work.
9. Rewrite downstream filtering to use `new Set(compiled.claimIds)` and add exhaustive conflict conversion.
10. Update reporting rendering to neutralize Markdown control syntax in evidence-bearing values.
11. Update OpenSpec requirement text and the shared Alloy model with `claimId`, `declKind`, validation/preflight facts, generalized conflict detection, and strengthened wellformedness.
12. Add contract, property, security, renderer, trace, and regression tests with covering scenario IDs.

## OpenSpec And Alloy Model Updates

The formalization-and-logic-analysis spec must include scenarios `FLA-SPEC-VARSORT-CONFLICT`, `FLA-SPEC-SYMKIND-CONFLICT`, and `FLA-SPEC-DUPLICATE-CLAIM-ID`, narrow `FLA-SPEC-CONFLICT` to function signatures, and document `compiled.claimIds` as authoritative for downstream inclusion.

The shared Alloy model must add `claimId` to `Claim`, add `declKind` to `Declaration`, and keep `DeclName` as final sanitized declaration identity:

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

Add structural facts aligned with validation and compile-group preconditions:

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

Extend `conflict_detected` to unify all three declaration-conflict classes and allow `c1 = c2` for same-claim sanitizer collisions:

```alloy
pred conflict_detected [c1, c2 : Claim, sp : Spec] {
  c1.spec = sp and c2.spec = sp
  some disj d1, d2 : Declaration |
    d1.declClaim = c1 and d2.declClaim = c2 and
    d1.declName = d2.declName and
    (d1.declKind != d2.declKind or d1.declSig != d2.declSig)
}
```

Strengthen combined wellformedness so included claims agree on both kind and signature per name:

```alloy
all disj d1, d2 : Declaration |
  (d1.declClaim in cs.includedClaims and d2.declClaim in cs.includedClaims and
   d1.declName = d2.declName) implies
     (d1.declKind = d2.declKind and d1.declSig = d2.declSig)
```

Keep conflict exclusion disjunctive: `c1 in excludedClaims or c2 in excludedClaims`. For same-claim conflicts this reduces to `c1 in excludedClaims`, matching `[claimId, claimId]` evidence. The Alloy model has no claim ordering, so positional later-claim exclusion is verified by property tests.

Security properties VSC-11 and VSC-12 are documented beside the model as evidence obligations, not encoded in Alloy, because they concern concrete string encodings rather than the merge state machine. Sanitized-claim-ID uniqueness VSC-10b follows from `unique_claim_ids_per_spec` under injective `sanitizeIdentifier()` and is enforced by executable preflight.

## Security And Safety Considerations

- Treat formalization-derived names, claim IDs, assertion IDs, assertion strings, paths, and evidence as untrusted.
- Identifier-based SMT-LIB injection is mitigated only when declaration symbols, claim IDs in labels, and assertion identifier-like tokens pass through `sanitizeIdentifier()`.
- Injective `sanitizeIdentifier()` prevents distinct raw claim IDs, declaration names, and paths from aliasing to one sanitized symbol.
- Sort injection is mitigated by the closed `LogicSort` domain.
- Assertion expressions remain string-based SMT-LIB fragments; this change does not make arbitrary assertion text safe.
- SMT-LIB comment injection is mitigated by escaping CR and LF before comment emission; tests must prove raw comments cannot introduce commands such as `(check-sat)` or `(set-option ...)`.
- Markdown/report injection is mitigated by renderer neutralization of inline links, emphasis, code spans, pipes, and leading block markers.
- Merge-conflict detection and duplicate-ID preflight are pure and do not invoke Z3.
- Security properties remain evidence obligations validated with concrete contract, renderer, and property tests unless future rules alter declaration identity, conflict detection, or inclusion/exclusion state.

## Risks And Mitigations

| Risk | Mitigation |
|------|------------|
| Sanitized-name collisions surprise users expecting raw-name identity. | Define SMT-LIB symbol identity explicitly and include both raw names plus sanitized symbol in evidence. |
| Injective sanitizer changes output for identifiers containing `_`, breaking golden artifacts or keys. | Treat as a documented compatibility break for internal artifacts; update fixtures; injectivity is required for assertion-label soundness. |
| Unified variable/function registry adds detection complexity. | Keep precedence explicit and break on first conflict; cover ordering with contract and property tests. |
| Function-conflict behavior appears changed when higher-precedence conflicts exist. | Scope regression guarantee to inputs without higher-precedence conflicts; document first-conflict-wins. |
| Downstream checks exclude wrong claims. | Derive inclusion from `compiled.claimIds`; add surviving-claim regression tests. |
| Field rename breaks consumers. | Update all known consumers and add runtime tests for finding/report text. |
| Same-claim sanitizer collision has unusual `[claimId, claimId]` evidence. | Document and assert in contract tests and specs. |
| Exact sort comparison rejects intended aliases. | Keep exact comparison; revisit only if user-defined sorts are added. |

## Verification Plan

Trace-ID sequencing is a hard gate: new `traceSpec(...)` IDs throw if not present in a non-archived spec, and coverage-enforced runs fail on uncovered catalog IDs. New spec scenarios and their covering tests must land in the same change.

### Contract Tests

| Test | Properties / Scenarios |
|------|------------------------|
| Same variable name and same sort across two claims emits one declaration, zero conflicts, and both claims in `claimIds`. | VSC-5, VSC-8, `FLA-SPEC-DEDUP` |
| Same variable name and different sort records `variable_sort_mismatch` and excludes only the later claimant. | VSC-1, VSC-3, VSC-4, `FLA-SPEC-VARSORT-CONFLICT` |
| Three claims where the middle conflicts and the third is compatible with the first includes first and third only. | VSC-2, VSC-5 |
| Symbol declared by claim 1, compatibly redeclared by claim 2, then conflictingly by claim 3 anchors `existingClaimId` to claim 1. | VSC-3, VSC-8 |
| Same variable symbol with three sorts produces separate conflicts for later incompatible claimants. | VSC-3, VSC-8 |
| Assertions from an excluded claim are absent from SMT-LIB and `assertionNameMap`. | VSC-2 |
| An excluded claim's unique variable/function declaration is absent from emitted SMT-LIB. | VSC-2 |
| Existing function-conflict input with no variable/kind conflict has same inclusion outcome plus new explicit fields. | VSC-6, `FLA-SPEC-CONFLICT` |
| Surviving claim of a function conflict now yields pairwise/completeness findings previously suppressed; assert on findings and `compiled.claimIds`, not brittle SMT text. | VSC-4 |
| Mixed variable and function conflicts on different later claims records both kinds. | VSC-3, VSC-6 |
| One claim with both variable and function conflict records only `variable_sort_mismatch`. | VSC-3 |
| One later claim triggering function-signature mismatch on X and symbol-kind collision on Y records only `function_signature_mismatch`. | VSC-6, VSC-9 |
| Cross-claim symbol used as variable then function records `symbol_kind_collision` and excludes later claim. | VSC-9, `FLA-SPEC-SYMKIND-CONFLICT` |
| Same-claim sanitizer collision records `symbol_kind_collision` with `existingClaimId === excludedClaimId`. | VSC-9 |
| Duplicate raw `claimId` values in one group produce `logic.invalid_group` and zero `compileSpecSmtlib()`, `writeOutputAtomic`, and `runZ3Query` calls. | VSC-10, `FLA-SPEC-DUPLICATE-CLAIM-ID` |
| Duplicate raw `claimId` group alongside valid groups rejects only the offending group; valid sibling groups still compile and run. | VSC-10 |
| `sanitizeIdentifier()` is injective for formerly colliding `REQ(1)` and `REQ_281_29`, producing distinct sanitized IDs and labels. | VSC-10b, `FLA-SPEC-NAMED` |
| Sanitized-ID uniqueness preflight rejects a constructed collision with `logic.invalid_group` and zero compile/solver calls. | VSC-10b |
| Reordering conflicting claims changes the excluded claimant according to first-wins position. | VSC-8 |
| Raw variable names that sanitize to one symbol with different sorts record `variable_sort_mismatch`. | VSC-1, VSC-3 |
| Empty claim list emits no `declare-*` and no `assert` lines, aside from header/section comments. | VSC-7 |
| Claims with no variables but compatible functions compile and analyze normally. | VSC-6 |
| `logic-analysis.ts` emits per-kind merge-conflict findings and filters deeper checks by `compiled.claimIds`. | VSC-4 |
| `validate.ts` rejects raw variable/function name overlap. | Validation |
| `validate.ts` rejects duplicate variables whose raw names sanitize to one symbol. | Validation |
| `validate.ts` rejects duplicate functions whose raw names sanitize to one symbol. | Validation |
| SMT-LIB comments escape CR/LF in raw `specFile`, `claimId`, and assertion IDs so injected commands remain comments/text. | VSC-11, VSC-12 |
| Merge-conflict findings include raw names and claim IDs as data only; renderer tests cover `[x](http://evil)`, `**x**`, `_x_`, backticks, `a | b`, `#`, `>`, and `-`. | VSC-12, `RAE-EVID-RENDER-SAFE` |

### State-Machine Property-Based Tests

Property tests in `test/property/logic.property.test.ts` must exercise generated histories, not only isolated claim lists. Model merge behavior as a deterministic state machine and compare implementation against it after every transition.

State:

- Ordered claim list under construction.
- Reference-model declaration registry keyed by sanitized symbol.
- Reference-model included IDs, excluded IDs, and first-conflict evidence.
- Group preflight state for duplicate raw `claimId` values.

Commands:

- `appendCompatibleClaim`: add a claim whose declarations agree with the current surviving registry.
- `appendVariableSortConflict`: add a later claim with a conflicting variable sort for an existing sanitized symbol.
- `appendFunctionSignatureConflict`: add a later claim with a conflicting function signature for an existing sanitized symbol.
- `appendSymbolKindConflict`: add a later claim that uses an existing sanitized symbol as the opposite declaration kind.
- `appendSameClaimSanitizerCollision`: add one claim with distinct raw variable and function names that sanitize to the same symbol.
- `appendDuplicateClaimId`: add a claim with an already-used raw `claimId` and assert group analysis rejects before compilation and solver work.
- `removeClaim`: remove a generated claim and recompute expected first-wins results from remaining ordered list.
- `reorderClaims`: permute a generated prefix and verify positional first-wins results change only according to order.

Invariants checked after every command:

- Determinism: two `compileSpecSmtlib()` calls on current state produce identical conflicts, `claimIds`, assertion maps, and SMT-LIB text.
- Model/implementation agreement: implementation `claimIds`, conflict kinds, excluded IDs, and surviving declaration table match the executable reference state machine.
- Inclusion partition: after filtering histories to unique raw claim IDs, each claim ID is either in `claimIds` or is some conflict's `excludedClaimId`, never both and never neither.
- No surviving disagreement: among included claims, no sanitized symbol has two sorts, two signatures, or two kinds.
- Positional first-wins oracle: for every sanitized symbol, the surviving declaration equals the one contributed by the lowest-index claim that declares it, and every later incompatible declarant appears as a conflict whose `existingClaimId` is that first declarer and `excludedClaimId` is the later claim.
- Append-compatible monotonicity: appending a conflict-free claim never removes an already-included claim. Insertion or reorder histories are intentionally non-monotonic.
- Function regression scope: histories with function conflicts and no variable/kind conflicts preserve existing function-conflict behavior.
- Duplicate-ID preflight: any history introducing duplicate raw claim IDs is rejected as `logic.invalid_group` before solver execution, asserting zero `runZ3Query` and `compileSpecSmtlib` calls.
- Sanitizer injectivity: every pair of distinct raw claim IDs in a history sanitizes to distinct IDs; no two claims share a `<sanitizedClaimId>__a<index>` label. A separately constructed colliding-sanitized-ID input is rejected with zero solver calls.
- Counterexample preservation: every minimized failing command history is promoted to a named regression test with covering scenario ID.

### Security Property Tests And Evidence

Security properties are tested over concrete strings rather than encoded in Alloy unless they change merge state or declaration identity.

- Comment injection safety: generated raw `specFile`, `claimId`, assertion IDs, and names containing CR, LF, semicolons, parentheses, and SMT-LIB command fragments cannot create additional executable SMT-LIB commands in comments.
- Identifier injection safety: generated declaration names and assertion identifier-like tokens always pass through `sanitizeIdentifier()` before declaration or named-assertion emission.
- Identifier injectivity: generated distinct raw identifiers never collide after sanitization; the encoding is uniquely decodable.
- Evidence rendering safety: generated raw names, claim IDs, paths, and conflict evidence cannot create synthetic Markdown findings, links, emphasis, inline code spans, headings, block quotes, list items, or extra table cells.
- Solver boundary safety: merge-conflict detection and duplicate-ID preflight remain pure and never invoke Z3; rejected histories assert zero solver calls.
- Security traceability: tests tag VSC-11/VSC-12 through relevant `FLA-*` and `RAE-*` scenario IDs.

### Failure-Mode Coverage

Cover empty groups; claims with no variables; duplicate variables within one claim; duplicate functions within one claim; raw var/fn name overlap within one claim; sanitizer-induced same-claim collisions; duplicate claim IDs; multiple later conflicts against one first declaration; assertions referencing excluded declarations under the chosen solver-error policy; and invalid unchecked IR with sorts outside `LogicSort`.

### Static And Runtime Validation

- TypeScript strict compilation catches missing `SpecMergeConflict` fields and non-exhaustive `switch` handling.
- Run `smtlib.test.ts`, `logic-analysis.test.ts`, `validate.test.ts`, reporting tests, and the state-machine/security property suite.
- Run the full suite to catch consumers of the old conflict shape or old downstream filtering.
- Run OpenSpec/trace coverage so new scenario IDs and modified model obligations are included in non-archived specs before tests call `traceSpec()`.
- Promote every minimized property-test counterexample to a named regression test.

### Verification Commands

Use repository-standard commands for targeted and full verification. At minimum, run the affected contract tests, property tests, TypeScript checks, and OpenSpec/trace coverage. If exact script names differ, use the closest package scripts or test-runner filters for:

- `test/contract/smtlib.test.ts`
- `test/contract/logic-analysis.test.ts`
- `test/contract/validate.test.ts`
- reporting contract tests
- `test/property/logic.property.test.ts`
- OpenSpec trace coverage tests
- full test suite
