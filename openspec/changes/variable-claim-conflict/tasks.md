## 1. Validation and Identifier Safety

- [x] 1.1 Update `src/domain/formal/validate.ts` to reject raw variable/function name overlap within one claim.
- [x] 1.2 Update `src/domain/formal/validate.ts` to reject duplicate variable declarations whose raw names sanitize to the same variable symbol.
- [x] 1.3 Update `src/domain/formal/validate.ts` to reject duplicate function declarations whose raw names sanitize to the same function symbol.
- [x] 1.4 Preserve sanitizer-induced same-claim variable/function cross-kind collisions as compiler-level `symbol_kind_collision` cases rather than validation failures.
- [x] 1.5 Extract `sanitizeIdentifier()` into a new `src/domain/formal/identifiers.ts` module and re-export it from `src/domain/formal/smtlib.ts` as a compatibility shim so existing importers keep working, then make the sanitizer injective: pass through only ASCII letters and digits `[A-Za-z0-9]`, reserve `_` as the escape lead, and escape every other code point — including a literal underscore (`U+005F` becomes `_00005F`) — as `_` followed by exactly six uppercase hexadecimal digits of the Unicode code point. Iterate the raw string by Unicode code point (`for…of`/`codePointAt`), never by UTF-16 code unit (`charCodeAt`), so a supplementary-plane character such as `😀` (`U+1F600`) maps to a single six-digit escape (`_01F600`) and an unpaired surrogate escapes to its own six-digit form. Escape a leading raw digit as its six-digit hex form (a bare `_` prefix would break unique decodability), map the empty string to `_`, and perform no Unicode normalization.
- [x] 1.6 Preserve assertion-label invariants for `<sanitizedClaimId>__a<index>`; ensure the new sanitizer cannot place raw `__` inside sanitized IDs and that label mapping remains collision-free.
- [x] 1.7 Update the single escape-output-sensitive golden assertion in `test/contract/smtlib.test.ts` (the `sanitizeIdentifier("REQ(1)|A")` expectation) from `/^REQ_28/` to `/^REQ_000028/` to match fixed-width-6 output. No many-to-one raw-dedup characterization test exists to invert: the old sanitizer's collisions were latent (never asserted), and all other sanitizer tests assert the shape `/^[A-Za-z_][A-Za-z0-9_]*$/` or `sanitizeIdentifier("") === "_"`, which the injective sanitizer still satisfies.
- [x] 1.8 Add `validate.test.ts` cases for raw variable/function overlap, duplicate sanitized variables, and duplicate sanitized functions.
- [x] 1.9 Add sanitizer contract/property tests proving formerly colliding identifiers such as `REQ(1)` and `REQ_281_29` now produce distinct sanitized symbols and distinct assertion labels.
- [x] 1.10 Correct the stale sanitizer documentation that still describes the old two-digit `_XX` escape: update the `SanitizedClaimId` doc comment in `src/domain/branded.ts` and the sanitizer/module JSDoc in `src/domain/formal/smtlib.ts` to describe the injective fixed-width-6 encoding, so no doc comment contradicts the new `identifiers.ts` contract.

### Validation and Identifier Safety change summary

**What changed:**
- Extracted identifier sanitization into a new module `src/domain/formal/identifiers.ts` and made it injective. `sanitizeIdentifier()` now passes through only `[A-Za-z0-9]`, reserves `_` as the escape lead, and escapes every other Unicode code point — including a literal underscore (`U+005F` → `_00005F`) — as `_` followed by exactly six uppercase hex digits (`encodeCodePointEscape` at `identifiers.ts:42`). Iteration is by code point (`for…of` + `codePointAt`, `identifiers.ts:99`), so `😀` (`U+1F600`) maps to a single `_01F600`; a leading raw digit is escaped; empty input maps to `_`; no Unicode normalization is applied.
- `src/domain/formal/smtlib.ts:85` re-exports `sanitizeIdentifier` from the new module (`export const sanitizeIdentifier = sanitizeIdentifierImpl`) as a compatibility shim so existing importers keep working.
- Added same-claim declaration-collision validation in `src/domain/formal/validate.ts` (`validateDeclarationCollisions`, wired into `validateFormalizationSample`): rejects raw variable/function name overlap, duplicate variables that sanitize to one symbol, and duplicate functions that sanitize to one symbol. Same-claim sanitizer-induced cross-kind collisions are intentionally NOT rejected here.
- Updated stale `_XX` two-digit-escape documentation: the `SanitizedClaimId` doc in `src/domain/branded.ts` and the sanitizer/module JSDoc now describe the injective fixed-width-6 encoding.

**Why this was done:**
- The previous sanitizer was many-to-one: distinct raw IDs such as `REQ(1)` and `REQ_281_29` could collapse to one symbol, silently aliasing declarations and assertion labels. Injectivity is the precondition for VSC-8 (determinism), VSC-10b (sanitized claim-ID uniqueness), and collision-free assertion labels `<sanitizedClaimId>__a<index>`.
- Same-claim duplicate/overlap rejection closes the schema-layer gap (tasks 1.1–1.3) so malformed samples fail fast, while cross-kind sanitizer collisions are deferred to the compiler as `symbol_kind_collision` (task 1.4, VSC-9) because they are a merge-namespace property, not a schema property.

**Implementation details / evidence:**
- Fixed-width-6 escape: `encodeCodePointEscape` uses `codePoint.toString(16).toUpperCase().padStart(6, "0")` (`identifiers.ts:43`); output always matches `SanitizedClaimId`'s `^[A-Za-z_][A-Za-z0-9_]*$`.
- `validateDeclarationCollisions` returns `Result` errors (never throws), consistent with the validation layer's `Result` contract.
- Assertion-label invariant preserved: injective output for non-empty input never contains a raw `__`, so the `__a` separator stays unambiguous (documented in the sanitizer JSDoc invariants).

**Under-specified decision:**
- Operational bounds are out of scope for Section 1; the sanitizer stays total for all JavaScript strings. The single `throw` in `sanitizeIdentifier` guards the unreachable `codePointAt() === undefined` internal invariant only, per style-guide "throw on broken invariant".

**Developer handoff notes:**
- `identifiers.ts` is now the sole owner of solver-facing identifier encoding; import from there for new code and treat the `smtlib.ts` export purely as a backward-compat shim.
- Fixed-width-6 escapes widen sanitized output, so any test asserting exact escape shape must use the six-digit form (`_000028`, not `_28`).

**Validation evidence:**
- `test/contract/validate.test.ts` (11 tests): "rejects raw variable/function name overlap within one claim", "rejects duplicate variables that sanitize to the same symbol", "rejects duplicate functions that sanitize to the same symbol".
- `test/contract/smtlib.test.ts`: golden `sanitizeIdentifier("REQ(1)|A")` updated to `/^REQ_000028/`; new "sanitizer distinguishes formerly colliding identifiers" and "keeps assertion labels distinct for formerly colliding identifiers".
- `npm run lint:types` clean; targeted suite 61/61 passing.

## 2. Combined SMT-LIB Conflict Detection

- [x] 2.1 Extend `SpecMergeConflict` in `src/domain/formal/smtlib.ts` to the three-kind discriminated union: `function_signature_mismatch`, `variable_sort_mismatch`, and `symbol_kind_collision`. Type each variant's `sanitizedName` as the branded `SanitizedClaimId` from `src/domain/branded.ts` (not raw `string`) so solver-facing symbol identity is compiler-enforced; keep the raw `existing*`/`conflicting*` name and `claimId` evidence fields as `string`.
- [x] 2.2 Rename function-conflict evidence from the old `functionName` shape to explicit `existingFunctionName` and `conflictingFunctionName`, preserving `claimIds: [existingClaimId, excludedClaimId]`.
- [x] 2.3 Add explicit `existingClaimId` and `excludedClaimId` to all conflict kinds and treat `claimIds` as evidence only, not downstream inclusion state.
- [x] 2.4 Add `declaredVariables: Map<SanitizedClaimId, { variableName: string; sort: LogicSort; claimId: string }>` and extend `declaredFunctions` to `Map<SanitizedClaimId, { functionName, fn, claimId }>` for evidence, keying both registries on the branded sanitized symbol returned by `sanitizeIdentifier()`.
- [x] 2.5 Implement variable-sort mismatch detection first, comparing exact closed `LogicSort` values and recording `expectedSort` and `conflictingSort`.
- [x] 2.6 Preserve and update function-signature mismatch detection second, including new evidence fields and first surviving declaration ownership.
- [x] 2.7 Implement symbol-kind collision detection third for cross-claim variable/function reuse and same-claim sanitizer-induced cross-kind collisions.
- [x] 2.8 Enforce first-conflict-wins per claim: scan variables before functions before cross-kind checks, record one conflict, and break on first hit.
- [x] 2.9 Register only included claims; use first-wins guards for both variable and function registries so compatible redeclarations never re-anchor ownership or overwrite sort/signature.
- [x] 2.10 Ensure the second emission pass excludes declarations, assertions, `claimIds`, and `assertionNameMap` entries for every conflicted claim.
- [x] 2.11 Add `smtlib.test.ts` coverage for compatible variable deduplication, variable-sort mismatch, multiple later mismatches, excluded assertion absence, excluded unique declaration absence, function-conflict regression, mixed conflict kinds, precedence boundaries, cross-claim symbol-kind collision, same-claim sanitizer collision, raw names colliding after sanitization, empty claim lists, and no-variable compatible-function claims.
- [x] 2.12 Encode the merge-core contracts as in-code assertions using `precondition`/`invariant`/`postcondition` from `src/domain/assert.ts`: precondition that the claim list is finite and within the declared bounds; a post-detection invariant that no registry symbol maps to two sorts, two signatures, or two declaration kinds; and postconditions that `compiled.claimIds` is an order-preserving subsequence of the input claim IDs, that no `excludedClaimId` appears in `compiled.claimIds`, and that `assertionNameMap` keys are a subset of `compiled.claimIds`. Keep expected structural outcomes (duplicate IDs, declaration conflicts) as `Result`-style findings, never thrown errors; split assertions into small single-fact checks so a failure names the exact violated contract.
- [x] 2.13 Introduce named operational bounds `CLAIMS_PER_GROUP_MAX` (claims per compile group) and `DECLARATIONS_PER_CLAIM_MAX` (variable-plus-function declarations per claim) and fail fast with a `precondition` — a thrown `Error`, not a `Result` finding — when a group or claim exceeds them; iterate both detection passes over these bounded collections with `for…of` and break on the first conflict so control flow stays bounded and visible at the call site.

### Combined SMT-LIB Conflict Detection change summary

**What changed:**
- `SpecMergeConflict` in `src/domain/formal/smtlib.ts:36` is now a three-kind discriminated union: `function_signature_mismatch`, `variable_sort_mismatch`, and `symbol_kind_collision`. Every variant's `sanitizedName` is the branded `SanitizedClaimId`; raw `existing*`/`conflicting*` names and claim-ID evidence stay `string`. Function evidence was renamed from `functionName` to explicit `existingFunctionName` / `conflictingFunctionName`.
- All variants carry explicit `existingClaimId`, `excludedClaimId`, and `claimIds: readonly [string, string]` (evidence only, never inclusion state).
- Added two evidence registries keyed on the branded sanitized symbol (`smtlib.ts:171-172`): `declaredVariables: Map<SanitizedClaimId, {variableName, sort, claimId}>` and `declaredFunctions: Map<SanitizedClaimId, {functionName, fn, claimId}>`.
- Detection runs in fixed per-claim precedence and stops on the first hit (`conflictForClaim`, `break`): variable-sort mismatch first (`smtlib.ts:188`), function-signature mismatch second (`:208`), then symbol-kind collisions third (`:226`) covering cross-claim variable↔function reuse plus same-claim sanitizer-induced cross-kind collisions.
- First-wins ownership: registries record a symbol only when absent (`!has` guards, `smtlib.ts:298-318`), and only included claims register, so compatible redeclarations never re-anchor ownership or overwrite sort/signature. A second emission pass (`:330`) skips every excluded claim, so their declarations, assertions, `claimIds`, and `assertionNameMap` entries are all absent.
- Named operational bounds `CLAIMS_PER_GROUP_MAX` (1024) and `DECLARATIONS_PER_CLAIM_MAX` (2048) fail fast via `precondition` — a thrown `Error`, not a `Result` (`smtlib.ts:17-21`, `:142-155`).
- Merge-core contracts encoded as small single-fact `precondition`/`invariant`/`postcondition` checks: finite bounded claim list precondition; post-detection invariants that no symbol maps to two sorts or to both a variable and function (`:321-328`); postconditions that `claimIds` is an order-preserving subsequence of the input (`:363-372`), no `excludedClaimId` appears in `claimIds` (`:374`), and `assertionNameMap` values reference only included claims (`:379`).

**Why this was done:**
- VSC-1 / VSC-9: never emit a symbol with two sorts or as both variable and function → post-detection invariants.
- VSC-2: never include an excluded claim's assertions → second-pass exclusion + `assertionNameMap` postcondition.
- VSC-3: never hide a sort mismatch behind first-wins dedup → `variable_sort_mismatch` recorded for the later incompatible claimant with `expectedSort`/`conflictingSort`.
- VSC-4: inclusion authority is `compiled.claimIds`; explicit `excludedClaimId` plus the subsequence postcondition keep evidence from ever implying a different exclusion than compilation used.
- VSC-5 / VSC-6: compatible variable/function redeclarations stay included and analyzable.
- VSC-7: bounded `for…of` with break guarantees termination for any finite claim list.
- Branding `sanitizedName` makes solver-symbol identity compiler-enforced rather than a raw `string`.

**Implementation details / evidence:**
- Same-claim sanitizer cross-kind collision emits `existingClaimId === excludedClaimId` and `claimIds: [claimId, claimId]` (`smtlib.ts:254-268`), distinguishing it from cross-claim collisions.
- `signaturesMatch` (`:462`) compares return sort then arity then positional arg sorts for exact compatibility.

**Under-specified decision:**
- Concrete bound values 1024 / 2048 were not fixed by the spec; chosen as generous ceilings that fail fast on pathological groups but never trip on realistic specs. They are exported constants so callers and tests can reference them.
- Bound violations throw (broken-invariant class), whereas expected structural outcomes (duplicate IDs, declaration conflicts) remain `Result`-style findings, per the style guide.

**Developer handoff notes:**
- Adding a fourth conflict kind requires updating this union AND the `conflictToFinding` switch (Section 3); the `assertNever` default makes the omission a compile error.
- Treat `claimIds` as human-facing evidence only — never branch inclusion on it; use `compiled.claimIds`.

**Validation evidence:**
- `test/contract/smtlib.test.ts` (17 tests): "detects variable sort mismatch and excludes later claim", "detects symbol kind collision across claims", "detects same-claim symbol kind collision", "uses conflict precedence variable before function before symbol-kind", plus compatible-dedup and excluded-declaration/assertion-absence coverage.
- `npm run lint:types` clean (exhaustive union verified by the compiler).

## 3. Logic Analysis Group Preflight and Inclusion Coherence

- [x] 3.1 Add compile-group preflight in `src/domain/formal/logic-analysis.ts` that detects duplicate raw `claimId` values before `compileSpecSmtlib()`, artifact writes, or solver calls.
- [x] 3.2 Emit one `logic.invalid_group` finding with severity `error` for duplicate raw IDs, listing duplicated IDs and affected claims, and add an appropriate report line.
- [x] 3.3 Add sanitized-claim-ID uniqueness preflight using `sanitizeIdentifier(claimId)` as a defense-in-depth safety net for VSC-10b.
- [x] 3.4 Emit one `logic.invalid_group` finding with severity `error` for sanitized-ID collisions, listing colliding raw IDs and the shared sanitized ID, and skip all compiler/writer/solver work for that group.
- [x] 3.5 Keep invalid-group rejection group-scoped: sibling valid groups must still compile, write artifacts, and run solver queries.
- [x] 3.6 Convert all `SpecMergeConflict` variants to `logic.merge_conflict` findings using an exhaustive `switch (conflict.kind)` whose `default` branch calls `assertNever(conflict)` (from `src/domain/assert.ts`, matching the existing `src/domain/errors.ts` pattern) so adding a fourth conflict variant becomes a compile-time error.
- [x] 3.7 Preserve per-kind finding evidence: sanitized symbol, both raw names, both claim IDs, both sorts for variable conflicts, and both declaration kinds for symbol-kind conflicts.
- [x] 3.8 Keep merge-conflict severity hardcoded to `error`, independent of source obligation.
- [x] 3.9 Replace downstream pairwise/completeness filters based on conflict evidence tuples with `const includedClaimIds = new Set(compiled.claimIds)` and filter by inclusion.
- [x] 3.10 Add `logic-analysis.test.ts` coverage for invalid-group zero compiler/writer/solver work, sibling valid group continuation, per-kind merge-conflict finding shapes, surviving-claim false-negative regression, and downstream filtering by `compiled.claimIds`.
- [x] 3.11 Add a constructed sanitized-ID collision preflight test, even though injective sanitization makes it unreachable from distinct raw IDs in normal inputs.
- [x] 3.12 Assert in code, co-located with the preflight, that a group rejected as `logic.invalid_group` performs zero `compileSpecSmtlib()`, artifact-write, and `runZ3Query()` calls for that group, complementing the contract/property zero-work tests with a runtime fail-fast guard.

### Logic Analysis Group Preflight and Inclusion Coherence change summary

**What changed:**
- Added `preflightGroupClaimIds(claims, sanitizeClaimId = sanitizeIdentifier)` in `src/domain/formal/logic-analysis.ts:114`, run before `compileSpecSmtlib()`, artifact writes, or solver calls (`analyzeSpecGroup`, `:237`). It detects duplicate raw claim IDs first, then duplicate sanitized claim IDs (defense-in-depth for VSC-10b), returning at most one issue per group.
- Invalid groups emit one `logic.invalid_group` error finding via `buildInvalidGroupFinding` (`:401`) — listing duplicated/colliding raw IDs, affected claims, and the shared sanitized ID — plus a report line, and skip all compile/write/solver work for that group only. Rejection stays group-scoped: sibling valid groups still compile, write, and run under `mapBounded` (`:75`).
- `conflictToFinding` (`:160`) converts every `SpecMergeConflict` to a `logic.merge_conflict` error finding through an exhaustive `switch (conflict.kind)` whose `default` calls `assertNever(conflict)`, matching the `errors.ts` pattern. Per-kind evidence is preserved: sanitized symbol, both raw names, both claim IDs, both sorts for variable conflicts, both declaration kinds for symbol-kind conflicts. Severity is hardcoded `error`, independent of source obligation.
- Downstream pairwise/completeness now filter by `const includedClaimIds = new Set(compiled.claimIds)` (`:375`) instead of reconstructing exclusion from conflict evidence tuples.
- A runtime fail-fast zero-work guard co-located with the preflight (`compileInvoked` / `artifactWriteInvoked` / `solverInvoked` booleans asserted `false` via `postcondition`, `:243-245`) complements the contract/property zero-work tests.

**Why this was done:**
- VSC-10: never build or consume a solver query for duplicate raw claim IDs → raw preflight rejects before any compile/solver call.
- VSC-10b: enforce sanitized claim-ID uniqueness even if sanitizer injectivity ever regresses → sanitized preflight, made testable by the injectable `sanitizeClaimId` seam.
- VSC-4: a single inclusion authority (`compiled.claimIds`) prevents deeper checks from disagreeing with compilation → `Set` filter over `compiled.claimIds`.
- `assertNever` provides compile-time exhaustiveness so a future fourth conflict kind cannot silently drop a finding.

**Implementation details / evidence:**
- The `sanitizeClaimId` default parameter is a dependency-injection test seam: a forced-collision function lets `test/contract/logic-analysis.test.ts` exercise the sanitized-collision branch that injective sanitization otherwise makes unreachable.
- `resolveCoreToClaims` (`:443`) maps unsat-core labels back to claim IDs through `assertionNameMap`, which now only ever contains included claims (Section 2 postcondition).

**Under-specified decision:**
- Preflight returns at most one issue per group and prefers the raw-duplicate check over the sanitized check (raw duplication is the stronger, simpler signal). This keeps findings deterministic and minimal.
- Report-line wording (`invalid compile group (<kind>)`, `merge conflict (<kind>) between <ids>`) is implementation-chosen and not spec-fixed.

**Developer handoff notes:**
- The zero-work booleans are a runtime complement to the property/contract tests; keep them accurate if new solver/write calls are added to `analyzeSpecGroup`.
- Preflight must stay inside the per-group analysis; do not hoist it above the group loop or group-scoping (sibling continuation) breaks.

**Validation evidence:**
- `test/contract/logic-analysis.test.ts` (19 tests): "rejects duplicate raw claim IDs as invalid group before compile and solver work", "maps each merge conflict kind to merge_conflict finding with stable evidence", "detects constructed sanitized-id collision in preflight", plus sibling-continuation and downstream-filtering coverage.
- `npm run lint:types` clean (exhaustive switch verified).

## 4. Reporting and Evidence Rendering Safety

- [x] 4.1 Update `src/domain/reporting/render.ts` so finding descriptions, provenance, related claim IDs, and evidence values render as inert Markdown data rather than raw Markdown control content.
- [x] 4.2 Neutralize inline Markdown links, emphasis, underscores used for emphasis, inline-code/backtick syntax, table-cell pipes, headings, block quotes, list markers, and other leading block markers in raw evidence.
- [x] 4.3 Preserve evidence inspectability while preventing report structure changes such as synthetic anchors, emphasis spans, code spans, table cells, headings, block quotes, or list items.
- [x] 4.4 Add reporting tests using concrete payloads `[x](http://evil)`, `**x**`, `_x_`, a backtick payload, `a | b`, leading `#`, leading `>`, and leading `-`.
- [x] 4.5 Add merge-conflict and invalid-group report tests proving raw names, claim IDs, paths, and conflict evidence remain inert data.
- [x] 4.6 Confirm existing reporting shape requirements still pass after renderer escaping changes.

### Reporting and Evidence Rendering Safety change summary

**What changed:**
- Added exported `neutralizeMarkdownInline(value)` in `src/domain/reporting/render.ts` and applied it to every untrusted field rendered by `renderFindingsReport`: finding description, provenance file, provenance heading, each evidence `kind=value` pair, and related claim IDs.
- Neutralization escapes backslash first (`\` → `\\`), then inline Markdown controls (`[`, `]`, `(`, `)`, `*`, backtick, `_`, `|`), then per line neutralizes leading block markers (`#`, `>`, `-`, `+`, `*`) and ordered-list markers (digits followed by `.` or `)`) so raw evidence cannot open a new block structure.

**Why this was done:**
- VSC-12: security-sensitive evidence (raw names, claim IDs, assertion IDs, paths) must remain inert data across reports and cannot synthesize Markdown findings, links, emphasis, inline code spans, table cells, headings, block quotes, or list items. Merge-conflict and invalid-group findings (Sections 2–3) surface untrusted raw names and IDs directly into the report, so escaping at the render boundary is required.

**Implementation details / evidence:**
- Escape order matters and is fixed: backslash-escape first so subsequently inserted `\` prefixes are not themselves re-escaped, then the inline character class, then leading-marker handling line-by-line (`escapedInline.split("\n").map(...)`).
- The pipe `|` is escaped globally so evidence cannot inject extra table cells even if a future report uses Markdown tables.
- Inspectability is preserved: payloads remain literal, readable text — e.g. `[x](http://evil)` renders as `\[x\]\(http://evil\)`, not a live link.
- All five untrusted field categories in `renderFindingsReport` route through the helper (description, provenance file, provenance heading, evidence kind/value, related identifiers).

**Under-specified decision:**
- Chose per-line leading-marker neutralization plus global inline escaping rather than HTML-encoding or content stripping, to keep evidence human-readable while inert. This matches the task requirement to "preserve evidence inspectability while preventing report structure changes."

**Developer handoff notes:**
- Any new rendered field that carries untrusted data must be passed through `neutralizeMarkdownInline`; the helper is exported specifically so new render paths and unit tests can reuse it directly.

**Validation evidence:**
- `test/contract/reporting.test.ts` (11 tests): "neutralizes markdown control payloads in rendered evidence and provenance" (payloads `[x](http://evil)`, `**x**`, `_x_`, backtick, `a | b`, leading `#`, `>`, `-`), "neutralization helper escapes block and inline markdown controls", and "renders merge-conflict and invalid-group evidence as inert data". Pre-existing reporting shape tests still pass after the escaping changes.
- `npm run lint:types` clean; targeted suite 61/61 passing.

## 5. Spec, Alloy, Documentation, Property, and Regression Coverage

- [ ] 5.1 Create the standalone, compilable Alloy 6 file `openspec/changes/variable-claim-conflict/specs/formalization-and-logic-analysis/alloy/merge.als` (module `merge`) as an external documentation-and-verification model for the structural safety properties behind `FLA-SPEC-COMBINE` (not part of the test harness and not a spec condition), modeling claim identity (`claimId` on `Claim`), declaration kind (`DeclKind`, `declKind` on `Declaration`), and `DeclName` as the final sanitized declaration identity.
- [ ] 5.2 Add `merge.als` facts `unique_claim_ids_per_spec` and `validated_same_claim_declarations` aligned with validation and preflight boundaries.
- [ ] 5.3 Define `merge.als` `conflict_detected` to cover differing declaration kind or differing declaration signature for the same sanitized name, allowing `c1 = c2` for same-claim sanitizer collisions.
- [ ] 5.4 Define `merge.als` `combined_wellformed` so included declarations sharing a name agree on both kind and signature, plus `combined_partitions_spec_claims` so included/excluded claims partition the spec's claims disjointly.
- [ ] 5.5 Keep `merge.als` `conflicts_excluded` disjunctive (`c1 in excludedClaims or c2 in excludedClaims`) and document that positional later-claim exclusion is verified by property tests rather than Alloy.
- [ ] 5.6 Add `merge.als` safety assertions `exclusion_implies_wellformed` and `same_claim_collision_excluded` and `run` commands `sanity`, `conflict_with_exclusion`, and `same_claim_collision`, each with `expect` annotations, then run the Alloy Analyzer externally (`java -jar tooling/alloy_v6.0.2.jar exec -f …/alloy/merge.als`) to confirm the three runs are SAT and the two checks are UNSAT, and record the resulting transcript in this section's change summary. This is an external verification step, not part of the automated test suite.
- [ ] 5.7 Update `ARCHITECTURE.md` for formal-module accuracy: add the `merged-capability-analysis` capability to the Existing Specs list, add `identifiers.ts` (plus `logic-analysis-checks.ts` and `logic-analysis-sexpr.ts`) to the formal module inventory, and correct identifier-sanitization ownership from `smtlib.ts` to the new `identifiers.ts` module (with `smtlib.ts` re-exporting it as a compatibility shim).
- [ ] 5.8 Update `docs/design.md` for the injective sanitizer and external formal model: describe SMT-LIB identifier sanitization as the injective fixed-width-6 encoding owned by `identifiers.ts`, confirm the `SanitizedClaimId` shape `^[A-Za-z_][A-Za-z0-9_]*$`, update decision D-6 to fixed-width-6 injectivity, reframe the verification-pyramid formal-models tier as the external Alloy model verified by manual analyzer runs, and add the `compiled.claimIds`-authority and duplicate-claim-ID preflight invariants.
- [ ] 5.9 Add complete TSDoc to every new or changed exported function and type per `docs/typescript_style.md` (Documentation): state preconditions, postconditions, preserved invariants, all expected failure forms with `@throws`, ownership/mutability assumptions, and an `@example` for exported APIs and any subtle behavior — at minimum the injective `sanitizeIdentifier()`, the variable-sort/symbol-kind detection helpers, the group preflight, the conflict→finding conversion, and the renderer neutralization helper; for `Result`-returning functions document the meaning and invariants of both the success and error branches so TSDoc states the same contracts the assertions enforce.

### Tasks deferred until `/opsx-archive` is performed
-  Update `openspec/specs/formalization-and-logic-analysis/spec.md` to add `FLA-SPEC-VARSORT-CONFLICT`, `FLA-SPEC-SYMKIND-CONFLICT`, and `FLA-SPEC-DUPLICATE-CLAIM-ID`.
-  Narrow `FLA-SPEC-CONFLICT` prose to function-signature conflicts and preserve both raw function names plus the shared sanitized symbol in evidence.
-  Update `FLA-SPEC-COMBINE` and `FLA-SPEC-NAMED` to document `compiled.claimIds`, duplicate raw/sanitized claim-ID rejection, injective fixed-width-6 sanitization, and assertion-label uniqueness, and refresh the pre-existing `FLA-SMTLIB-COMPILE` requirement's `FLA-SMTLIB-SANITIZE`/`FLA-SMTLIB-PRESERVE` scenarios and worked examples to the fixed-width-6 encoding (as a `MODIFIED` delta restating the requirement's unchanged scenarios verbatim) so its outputs stay consistent with the new sanitizer.
-  Document VSC-10b, VSC-11, and VSC-12 as encoding/rendering evidence obligations tested by concrete contract, property, and renderer tests rather than Alloy unless they affect merge state.
-  Update `openspec/specs/reporting-and-evidence/spec.md` with `RAE-EVID-RENDER-SAFE` and merge/invalid-group finding evidence details.
-  Update `openspec/specs/merged-capability-analysis/spec.md` with `MCA-MERGE-GROUP-KEY`, synthetic logical-key grouping semantics, and compile-group claim-ID uniqueness boundary.
-  Ensure every new or modified scenario ID has at least one covering trace in contract/property/reporting tests.

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
