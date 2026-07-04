## 1. Validation and Identifier Safety

- [ ] 1.1 Update `src/domain/formal/validate.ts` to reject raw variable/function name overlap within one claim.
- [ ] 1.2 Update `src/domain/formal/validate.ts` to reject duplicate variable declarations whose raw names sanitize to the same variable symbol.
- [ ] 1.3 Update `src/domain/formal/validate.ts` to reject duplicate function declarations whose raw names sanitize to the same function symbol.
- [ ] 1.4 Preserve sanitizer-induced same-claim variable/function cross-kind collisions as compiler-level `symbol_kind_collision` cases rather than validation failures.
- [ ] 1.5 Update `src/domain/formal/smtlib.ts` `sanitizeIdentifier()` to be injective: reserve `_` as escape lead, escape literal underscore as `_5F`, use self-delimiting uppercase hexadecimal escapes, and perform no Unicode normalization.
- [ ] 1.6 Preserve assertion-label invariants for `<sanitizedClaimId>__a<index>`; ensure the new sanitizer cannot place raw `__` inside sanitized IDs and that label mapping remains collision-free.
- [ ] 1.7 Update underscore-sensitive fixtures, examples, and golden expectations, including inverting any existing raw-dedup characterization test that expected the old many-to-one sanitizer behavior.
- [ ] 1.8 Add `validate.test.ts` cases for raw variable/function overlap, duplicate sanitized variables, and duplicate sanitized functions.
- [ ] 1.9 Add sanitizer contract/property tests proving formerly colliding identifiers such as `REQ(1)` and `REQ_281_29` now produce distinct sanitized symbols and distinct assertion labels.

### Validation and Identifier Safety change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 2. Combined SMT-LIB Conflict Detection

- [ ] 2.1 Extend `SpecMergeConflict` in `src/domain/formal/smtlib.ts` to the three-kind discriminated union: `function_signature_mismatch`, `variable_sort_mismatch`, and `symbol_kind_collision`.
- [ ] 2.2 Rename function-conflict evidence from the old `functionName` shape to explicit `existingFunctionName` and `conflictingFunctionName`, preserving `claimIds: [existingClaimId, excludedClaimId]`.
- [ ] 2.3 Add explicit `existingClaimId` and `excludedClaimId` to all conflict kinds and treat `claimIds` as evidence only, not downstream inclusion state.
- [ ] 2.4 Add `declaredVariables: Map<string, { variableName: string; sort: LogicSort; claimId: string }>` and extend `declaredFunctions` to retain `{ functionName, fn, claimId }` for evidence.
- [ ] 2.5 Implement variable-sort mismatch detection first, comparing exact closed `LogicSort` values and recording `expectedSort` and `conflictingSort`.
- [ ] 2.6 Preserve and update function-signature mismatch detection second, including new evidence fields and first surviving declaration ownership.
- [ ] 2.7 Implement symbol-kind collision detection third for cross-claim variable/function reuse and same-claim sanitizer-induced cross-kind collisions.
- [ ] 2.8 Enforce first-conflict-wins per claim: scan variables before functions before cross-kind checks, record one conflict, and break on first hit.
- [ ] 2.9 Register only included claims; use first-wins guards for both variable and function registries so compatible redeclarations never re-anchor ownership or overwrite sort/signature.
- [ ] 2.10 Ensure the second emission pass excludes declarations, assertions, `claimIds`, and `assertionNameMap` entries for every conflicted claim.
- [ ] 2.11 Add `smtlib.test.ts` coverage for compatible variable deduplication, variable-sort mismatch, multiple later mismatches, excluded assertion absence, excluded unique declaration absence, function-conflict regression, mixed conflict kinds, precedence boundaries, cross-claim symbol-kind collision, same-claim sanitizer collision, raw names colliding after sanitization, empty claim lists, and no-variable compatible-function claims.

### Combined SMT-LIB Conflict Detection change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 3. Logic Analysis Group Preflight and Inclusion Coherence

- [ ] 3.1 Add compile-group preflight in `src/domain/formal/logic-analysis.ts` that detects duplicate raw `claimId` values before `compileSpecSmtlib()`, artifact writes, or solver calls.
- [ ] 3.2 Emit one `logic.invalid_group` finding with severity `error` for duplicate raw IDs, listing duplicated IDs and affected claims, and add an appropriate report line.
- [ ] 3.3 Add sanitized-claim-ID uniqueness preflight using `sanitizeIdentifier(claimId)` as a defense-in-depth safety net for VSC-10b.
- [ ] 3.4 Emit one `logic.invalid_group` finding with severity `error` for sanitized-ID collisions, listing colliding raw IDs and the shared sanitized ID, and skip all compiler/writer/solver work for that group.
- [ ] 3.5 Keep invalid-group rejection group-scoped: sibling valid groups must still compile, write artifacts, and run solver queries.
- [ ] 3.6 Convert all `SpecMergeConflict` variants to `logic.merge_conflict` findings using an exhaustive `switch (conflict.kind)`.
- [ ] 3.7 Preserve per-kind finding evidence: sanitized symbol, both raw names, both claim IDs, both sorts for variable conflicts, and both declaration kinds for symbol-kind conflicts.
- [ ] 3.8 Keep merge-conflict severity hardcoded to `error`, independent of source obligation.
- [ ] 3.9 Replace downstream pairwise/completeness filters based on conflict evidence tuples with `const includedClaimIds = new Set(compiled.claimIds)` and filter by inclusion.
- [ ] 3.10 Add `logic-analysis.test.ts` coverage for invalid-group zero compiler/writer/solver work, sibling valid group continuation, per-kind merge-conflict finding shapes, surviving-claim false-negative regression, and downstream filtering by `compiled.claimIds`.
- [ ] 3.11 Add a constructed sanitized-ID collision preflight test, even though injective sanitization makes it unreachable from distinct raw IDs in normal inputs.

### Logic Analysis Group Preflight and Inclusion Coherence change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 4. Reporting and Evidence Rendering Safety

- [ ] 4.1 Update `src/domain/reporting/render.ts` so finding descriptions, provenance, related claim IDs, and evidence values render as inert Markdown data rather than raw Markdown control content.
- [ ] 4.2 Neutralize inline Markdown links, emphasis, underscores used for emphasis, inline-code/backtick syntax, table-cell pipes, headings, block quotes, list markers, and other leading block markers in raw evidence.
- [ ] 4.3 Preserve evidence inspectability while preventing report structure changes such as synthetic anchors, emphasis spans, code spans, table cells, headings, block quotes, or list items.
- [ ] 4.4 Add reporting tests using concrete payloads `[x](http://evil)`, `**x**`, `_x_`, a backtick payload, `a | b`, leading `#`, leading `>`, and leading `-`.
- [ ] 4.5 Add merge-conflict and invalid-group report tests proving raw names, claim IDs, paths, and conflict evidence remain inert data.
- [ ] 4.6 Confirm existing reporting shape requirements still pass after renderer escaping changes.

### Reporting and Evidence Rendering Safety change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 5. Spec, Alloy, Property, and Regression Coverage

- [ ] 5.1 Update `openspec/specs/formalization-and-logic-analysis/spec.md` to add `FLA-SPEC-VARSORT-CONFLICT`, `FLA-SPEC-SYMKIND-CONFLICT`, and `FLA-SPEC-DUPLICATE-CLAIM-ID`.
- [ ] 5.2 Narrow `FLA-SPEC-CONFLICT` prose to function-signature conflicts and preserve both raw function names plus the shared sanitized symbol in evidence.
- [ ] 5.3 Update `FLA-SPEC-COMBINE` and `FLA-SPEC-NAMED` to document `compiled.claimIds`, duplicate raw/sanitized claim-ID rejection, injective sanitization, and assertion-label uniqueness.
- [ ] 5.4 Update the shared Alloy domain model with `claimId` on `Claim`, `DeclKind`, `declKind` on `Declaration`, and `DeclName` as final sanitized declaration identity.
- [ ] 5.5 Add Alloy facts `unique_claim_ids_per_spec` and `validated_same_claim_declarations` aligned with validation and preflight boundaries.
- [ ] 5.6 Extend Alloy `conflict_detected` to cover differing declaration kind or differing declaration signature for the same sanitized name, allowing `c1 = c2` for same-claim sanitizer collisions.
- [ ] 5.7 Strengthen Alloy `combined_wellformed` so included declarations sharing a name agree on both kind and signature.
- [ ] 5.8 Keep `conflict_excluded_from_combined` disjunctive and document that positional later-claim exclusion is verified by property tests rather than Alloy.
- [ ] 5.9 Document VSC-10b, VSC-11, and VSC-12 as encoding/rendering evidence obligations tested by concrete contract, property, and renderer tests rather than Alloy unless they affect merge state.
- [ ] 5.10 Update `openspec/specs/reporting-and-evidence/spec.md` with `RAE-EVID-RENDER-SAFE` and merge/invalid-group finding evidence details.
- [ ] 5.11 Update `openspec/specs/merged-capability-analysis/spec.md` with `MCA-MERGE-GROUP-KEY`, synthetic logical-key grouping semantics, and compile-group claim-ID uniqueness boundary.
- [ ] 5.12 Ensure every new or modified scenario ID has at least one covering trace in contract/property/reporting tests.

### Spec, Alloy, Property, and Regression Coverage change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 6. State-Machine and Security Property Tests

- [ ] 6.1 Expand `test/property/logic.property.test.ts` to model an ordered claim-list state, reference declaration registry keyed by sanitized symbol, included/excluded IDs, first-conflict evidence, and duplicate-ID preflight state.
- [ ] 6.2 Implement generated commands `appendCompatibleClaim`, `appendVariableSortConflict`, `appendFunctionSignatureConflict`, `appendSymbolKindConflict`, `appendSameClaimSanitizerCollision`, `appendDuplicateClaimId`, `removeClaim`, and `reorderClaims`.
- [ ] 6.3 Assert determinism by comparing two `compileSpecSmtlib()` calls on the same generated state for identical conflicts, `claimIds`, assertion maps, and SMT-LIB text.
- [ ] 6.4 Assert model/implementation agreement for included IDs, excluded IDs, conflict kinds, first-conflict evidence, and surviving declaration table.
- [ ] 6.5 Assert inclusion partition: with unique raw claim IDs, each claim is either included or appears as a conflict's `excludedClaimId`, never both and never neither.
- [ ] 6.6 Assert no surviving disagreement: included claims never have one sanitized symbol with two sorts, two signatures, or two declaration kinds.
- [ ] 6.7 Assert positional first-wins by lowest-index scan: the surviving declaration for each symbol is contributed by the lowest-index compatible claimant, and every later incompatible declarant points back to that first claimant.
- [ ] 6.8 Assert append-compatible monotonicity while allowing insertion/reorder histories to be non-monotonic because first-wins is positional.
- [ ] 6.9 Assert function-conflict regression scope for histories with function conflicts and no variable/kind conflicts.
- [ ] 6.10 Assert duplicate raw claim IDs reject as `logic.invalid_group` before compile/solver work, with zero `compileSpecSmtlib()` and `runZ3Query` calls.
- [ ] 6.11 Assert sanitizer injectivity across generated distinct raw IDs and assert constructed sanitized-ID collision input is rejected with zero solver calls.
- [ ] 6.12 Promote every minimized failing command history to a named regression test with the covering `FLA-*`, `RAE-*`, or `MCA-*` scenario ID.
- [ ] 6.13 Add security property tests for SMT-LIB comment injection using CR, LF, semicolons, parentheses, and command fragments such as `(check-sat)` and `(set-option ...)`.
- [ ] 6.14 Add security property tests proving declaration names and assertion identifier-like tokens pass through `sanitizeIdentifier()` before declaration or named-assertion emission.
- [ ] 6.15 Add security property tests proving evidence rendering cannot create synthetic Markdown findings, links, emphasis, inline code spans, headings, block quotes, list items, or extra table cells.
- [ ] 6.16 Tag VSC-11 and VSC-12 security tests through relevant `FLA-*` and `RAE-*` scenario IDs or add a dedicated security scenario if needed.

### State-Machine and Security Property Tests change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 7. Final Verification

- [ ] 7.1 Run targeted contract tests for SMT-LIB compilation, logic analysis, validation, and reporting.
- [ ] 7.2 Run the state-machine and security property suite.
- [ ] 7.3 Run TypeScript strict compilation or repository typecheck to catch missing union fields and non-exhaustive switches.
- [ ] 7.4 Run OpenSpec/trace coverage so new scenario IDs exist in non-archived specs and every new catalog ID is covered.
- [ ] 7.5 Run the full test suite to catch consumers of old conflict shapes, old sanitizer output, old downstream filtering, and report rendering changes.
- [ ] 7.6 Record exact commands, results, and any residual risks in the task summaries.

### Final Verification change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->
