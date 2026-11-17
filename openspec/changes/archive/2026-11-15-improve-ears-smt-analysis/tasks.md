## 1. Contract Baseline And Verification Models

**Post-completion enhancement (2026-11-15):** The original 63-task audit below is
retained as historical implementation evidence. The subsequently requested
`enhance_plan.md` is implemented with strict verdict/value decoding, completion-time
semantic reconciliation, truthful weighted scope/diagnostic categories and uniform
effective expression limits. Candidate-pair budget semantics are retained and made
explicit. The plan's implementation record and `verification.md` enhancement section
record decisions, changed expectations and final acceptance: `make check` passed
1,071 tests, strict OpenSpec validation passed, and `git diff --check` passed.

- [x] 1.1 Inventory changed canonical identifiers and map each to a meaningful contract, property, oracle, integration, or model check; retain existing scenario identifiers whose semantics change and update their expectations explicitly.
- [x] 1.2 Review the supplied `models/analysis-lifecycle.als` against production state transitions, extend it where necessary, and record satisfiable witnesses plus bounded assertion results in `verification.md`.
- [x] 1.3 Revise affected existing capability Alloy fragments that assume substring classification, severity-only modality, solver-only dangling references, unconditional coverage suppression, vacuous clustering, or fallback equivalence; ensure properties are not assumed as transition facts.
- [x] 1.4 Establish the hand-derived semantic acceptance fixtures for guarded/unconditional conflict, self/three-rule conflict, advisory/permission behavior, scoped coverage, examples, inconsistent premises, and duplicate declarations before replacing production query code.

### Contract baseline and verification models change summary

**Task 1.1 — verification inventory:** Added `verification-map.json` and `verification-map.md` in this change. All 199 tagged headers map to 34 enclosing requirement groups with planned contract/property/oracle/integration/model checks and explicit behavioral expectations. Existing scenario identifiers are retained; the Markdown table records intentional old-to-new expectation changes. This makes verification scope explicit before production changes without claiming planned test paths already pass. An independent inventory scan validated unique identifiers, total mapping, nonempty expectations, and existing change-local model/evidence references. Later tasks implement the planned executable checks and trace declarations.

**Task 1.2 — lifecycle refinement:** Reviewed current formalization/solver control boundaries and extended `models/analysis-lifecycle.als` with issued/captured/resolved attempts, candidate registry snapshots, additional-sample failure, and group-scoped ownerless queries. This models evidence-before-validation, immutable registry use, and background queries without inventing a claim owner. Every action has explicit frames. An initial Alloy relation-arity error was corrected using a binary empty relation; the final run found all five requested witnesses and no counterexamples to twelve assertions within the declared scopes (12 steps, with the additional-failure check/witness at 16). `verification.md` records the final hash and command. These checks validate the control abstraction, not production implementation or expression semantics.

**Resolved decision:** The user selected separate permission-set verdicts. `design-issues.md`, design, source-backed delta specs, and verification map now distinguish permission-equivalent/broader/narrower/different from obligation strength; differing or missing permission scope qualifies aggregate alignment. Implementation resumed with this explicit polarity.

**Task 1.3 — replacement capability models:** Updated the MODIFIED requirement-model sections (which replace their canonical blocks at archive time) to use a checked independent `models/static-semantics.als` alongside the control model. The finite model has all eight Boolean assignments, mandatory-only allowed valuations, activation feasibility, nonvacuous equivalence, scoped guard gaps, and strict permission-set inclusion. Three positive witnesses and four assertions passed Alloy 6.2.0/SAT4J at the declared finite scopes. Grammar/type validity remains an explicit external boundary rather than an invented proof from model flags; raw evidence and early dependency validity are represented in the revised lifecycle model. Existing canonical files are not prematurely overwritten while the delta remains active.

**Task 1.4 — hand-derived corpus:** Added `test/fixtures/ears-to-logic/static-query-cases.json` and `test/oracle/static-semantics.oracle.test.ts`. Scripts are authored independently of production compilation/query planning and distinguish global SAT from activation conflict, three-way incompatibility, modal tracks, scoped coverage, scenario witnesses, vacuous implication, exact large integers, and permission-set inclusion. A separate malformed-script case verifies that Z3 errors override a printed UNSAT verdict. All twelve oracle tests passed with real Z3; the test passed ESLint and the change passed strict OpenSpec validation. Later tasks compare production-generated queries to this reference rather than making the fixture mirror production.
<!-- Remove this comment when the change summary is supplied.
     The change summay is a full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 2. Source Extraction And Strict EARS Parsing

- [x] 2.1 Add immutable source references, original/normalized span mapping, structured statements, scenario fields, and eligible/excluded dispositions to `src/domain/model.ts` with boundary validators and TSDoc.
- [x] 2.2 Separate statement text, references, justifications, scenario metadata/postconditions, fenced models, evidence, and supplementary/unparsed content in the line-oriented parser; verify CRLF, multiline, and no-silent-loss behavior.
- [x] 2.3 Implement the bounded pure strict EARS parser for the five project core forms, structural SHALL/MUST/SHOULD/MAY and response negation; reject malformed order, substring traps, missing delimiters, ambiguous MAY NOT, and trailing normative statements with precise spans.
- [x] 2.4 Add default-disabled `where` extension recognition and explicit unsupported/justified-alternative dispositions; verify unsupported prose is retained rather than guessed.
- [x] 2.5 Parse refinement/example/prohibited-example kinds, source-spanned Input/Expected/Forbidden fields, and scenario-scoped postconditions; diagnose missing/duplicate/contradictory metadata.
- [x] 2.6 Preserve enriched source structure and dispositions through finalized/delta merge without changing selected-view policy; prove removed/replaced blocks cannot feed discovery.
- [x] 2.7 Propagate clauses, modality, source-local identities, and dispositions through `claim-graph.ts`; assign authoritative eligible indexes after admission and retain excluded statements for qualitative/coverage reporting.

### Source extraction and strict EARS parsing change summary

**Tasks 2.1–2.5:** Added source span/reference/disposition and clause/scenario types in `model.ts`, pure source normalization and span validation in `parser/source.ts`, bounded strict recognition in `parser/ears.ts`, loss-aware fenced/metadata scanning in `parser/surface-block.ts`, and pure `parseSpecText` composition in `parser/spec.ts`. Source offsets/columns are explicitly UTF-16 and ranges are half-open; CRLF and synthetic join-space mappings remain reversible. Large statements are retained but excluded before allocating per-character maps. Protected literals do not trigger EARS keywords; WHERE structure is recognized but eligibility requires the explicit parser extension. Duplicate metadata is diagnosed and both values retained without overwriting the first field. `test/contract/ears-surface.test.ts` exercises grammar, exclusions, protected content, spans, fences, bounds and scenario forms. The 22 new tests and 15 existing parser tests passed; strict TypeScript and focused ESLint passed. Configuration transport of the extension remains task 4.1/phase wiring, rather than introducing a separate strictness mode.

**Tasks 2.6–2.7:** Existing merge operations already preserve the immutable parsed objects; source/merge contract tests now prove replacement/removal behavior and unchanged source spans/dispositions without changing selection policy. `claim-graph.ts` propagates surface metadata and derives source-owned SHALL/MUST/SHOULD/MAY obligations, while shared formalization admission excludes parser-ineligible statements before eligible-index assignment. Excluded claims remain in the graph. `surface-claims.test.ts` and generated source/admission histories verify provenance, duplicate display-ID isolation, and exhaustive admission accounting. All sixty focused parser/merge/claim/property tests, TypeScript, and focused ESLint passed. Generated-source construction and full batch-context transport are intentionally completed in later tasks.
<!-- Remove this comment when the change summary is supplied.
     The change summay is a full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 3. Typed Expression And Signature Kernel

- [x] 3.1 Define discriminated static semantic IR and exact Bool/Int/rational/enum expression nodes with concept references, typed applications, source slots, and separate modal/scenario/background variants.
- [x] 3.2 Implement a bounded single-expression S-expression lexer/parser with literal-aware handling, explicit depth/node/byte limits, and rejection of trailing forms or solver commands.
- [x] 3.3 Implement pure symbol/arity/sort checking, explicit integer/real coercion, exact unit conversion, and path-attributed validation errors; reject declaration shadowing and unknown references.
- [x] 3.4 Implement the conservative assembled-query fragment classifier, admitting only the specified quantifier-free linear/enum/UF combinations and reporting unsupported strings, nonlinear products, division/remainder, quantifiers, collections, recursive datatypes, and temporal meaning.
- [x] 3.5 Implement namespaced signature assembly with datatype/constructor ordering, compatible deduplication, explicit conflicts, and builtin/generated-name isolation across compilation and implication queries.
- [x] 3.6 Replace regex identifier substitution with typed rendering, preserve the injective encoder and inert comments, and expose typed assertions plus rendered expressions without solver commands.
- [x] 3.7 Add an independent Boolean/enum evaluator and generated expression/query differential checks, plus exact arithmetic/unit fixtures and real-Z3 declaration/type acceptance cases.

### Typed expression and signature kernel change summary

**Tasks 3.1–3.5 and 3.7:** Added typed scalar/static-model contracts, bounded literal-aware syntax parsing, pure signature/sort/arity/unit checking, exact rational arithmetic, safe namespaced declaration assembly, canonical typed rendering, and whole-query feature classification in `src/domain/formal/`. Explicit `quantity`/`convert` annotations lower to scalar SMT arithmetic and are documented in the design; literals are dimensionless unless annotated, avoiding invented conversions. Numerals have a separate 4,096-digit bound. Quoted symbol identity is distinct from numeric/string literal syntax, and enum sort objects are copied/frozen to prevent caller mutation. Added independent finite Bool/enum evaluation in `test/support/static-evaluator.ts`, differential real-Z3 tests over every finite valuation, exact 199/200/201-ms conversion fixtures, generated literal/numeral/signature properties, and typed-expression contracts. All 43 focused tests, strict TypeScript and focused ESLint passed. Task 3.6 remains pending because binding the typed renderer into existing production compilation is coupled to predicate formalization/signature transport; the new kernel is validated independently first.

**Task 3.6:** `typed-smtlib.ts` and the existing compiler now project accepted AST nodes with checked signatures. Standalone reusable artifacts contain no solver commands; permissions/examples retain their distinct semantics. The raw compiler/oracle boundary uses the bounded syntax lexer, preserving string values and quoted symbols instead of regex substitution. Typed expression, SMT compilation and generated identifier properties verify literal safety and injective encoding. A generated counterexample (`_` as a constant) exposed inappropriate builtin-token treatment; that token is now encoded as an identifier. CLI source analysis has one typed engine; reusable raw domain/oracle compilation is not a separately selectable user profile.
<!-- Remove this comment when the change summary is supplied.
     The change summay is a full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 4. Explicit Analysis Configuration And Frozen Concepts

- [x] 4.1 Extend `src/cli/config.ts` with validated optional analysis extensions, per-group explicit concepts/background/coverage models, and named limits; distinguish invalid config shapes from localized model-validation findings.
- [x] 4.2 Implement deterministic concept IDs, source aliases, signatures, roles, units, explicit/grounded-proposal/unresolved states, registry serialization/hashing, and source/configuration authority checks.
- [x] 4.3 Implement one bounded discovery pass per selected semantic group/source side with stable chunks and existing LLM timeout/retry policy; preserve partial failures and discovered-but-unresolved scope.
- [x] 4.4 Implement source-order reconciliation and the freeze barrier; reject conflicting explicit bindings and prevent positivity, exclusivity, exhaustive enums, or other plausible inferred facts from becoming admitted premises without authority.
- [x] 4.5 Persist discovery attempts, candidate/frozen registries, mapping decisions, proposed assumptions, and effective context fingerprints; verify identical fixed responses produce identical outcomes under completion permutations.
- [x] 4.6 Test missing-concept proposals, post-freeze mutation attempts, duplicate keys, incompatible units/scopes, input limits, and independent invocation isolation without an automatic rediscovery cycle.

### Explicit analysis configuration and frozen concepts change summary

**Tasks 4.1–4.4:** Added immutable global analysis controls and separate original/generated authored model maps, wired EARS extension/statement bounds through CLI parsing, and localized semantic model decoding in `formal/concepts.ts`. The registry assigns stable side/group/source identities, exact configuration JSON-pointer authority, grounded-proposal status, explicit unresolved collisions, and deterministic hashes; untrusted proposals cannot introduce enums, positive ranges, or other hard background facts. Source-order freeze occurs only after the bounded discovery pass. `formal/concept-discovery.ts` uses injected effects and stable byte/count-limited chunks; `adapters/concept-discovery.ts` reuses private attached-context lifecycle and existing model timeout/retries with cleanup warnings separate from model payload. Raw model failures remain explicit scope. Configuration/model/registry/discovery tests, existing adapter tests, TypeScript and focused ESLint passed. Durable registry/pointer persistence and production formalization wiring remain task 4.5/phase 5, not falsely claimed as complete here.

**Tasks 4.5–4.6:** `source-formalize.ts` persists exact discovery contexts/attempts, registry decisions, proposed assumptions and hashes through the run-local recorder. Registry source scope counts excluded statements, which qualify cross-side alignment. Duplicate explicit keys reject even when type-compatible; unknown scope/model fields are diagnosed instead of silently ignored. Sorted alias/evidence reconciliation and copied/frozen arrays prevent completion order or caller mutation from changing a registry. Concept registry/discovery contracts and generated permutation histories passed, including missing/removed source terms, conflicting units, independent original/generated hashes and authority pointers. No rediscovery cycle is introduced by a rejected expression.
<!-- Remove this comment when the change summary is supplied.
     The change summay is a full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 5. Predicate Formalization And Complete Attempt Capture

- [x] 5.1 Replace assertion-producing prompts with source-owned clause-slot predicate contracts and pinned registry hashes for attached, inline, fallback, and additional-sample paths; update adapter phase-schema validation.
- [x] 5.2 Construct guards, response negation, modality, and scenario semantics deterministically from the surface AST; reject model attempts to override identity, clause slots, registry, or modality.
- [x] 5.3 Add injected/adapter-owned capture of every raw discovery/formalization response before extraction/validation, including retries, rejected responses, complete failures, overflow status, and inline calls.
- [x] 5.4 Extend pointer-only invocation evidence with references to separate bounded response/normalized-IR artifacts while retaining claimSet-local indexes, private temp context cleanup, and current version identifiers.
- [x] 5.5 Preserve candidate/error partition and additional-sample candidate retention; implement no-model-call diagnostic completion for all-ineligible inputs and retain FormalizationError exit 9 for attempted eligible phase-wide failure.
- [x] 5.6 Exercise all transport/retry/degradation and stale prompt-override paths with captured request/response fixtures; verify raw evidence survives invalid/all-failed samples and persistence failures propagate as OutputError.

### Predicate formalization and complete attempt capture change summary

**Task 5.3:** Added an injected OpenCode evidence callback for capture-before-JSON-validation and separate classification events on every actual attempt, including spawn failures, retries and overflow. Optional process `captureBytes` retains immutable base64 of exact stdout/stderr bytes alongside diagnostic text; invalid stdout UTF-8 rejects transport on every model phase. Required capture callback failures propagate outside the spawn/model catch and do not trigger a model retry. `model-evidence.test.ts` verifies ordering, rejected/successful attempts, persistence failure propagation and terminal overflow; existing OpenCode/process contracts still pass. Durable sink and domain/CLI OutputError propagation are completed in tasks 5.4–5.6 rather than conflated with this capture boundary.

**Tasks 5.2, 5.4–5.5:** `predicate-lowering.ts` establishes source slot keys before model work, verifies exact index/hash/slot attribution, validates Bool predicates, and composes guard/NOT/modal/scenario meaning deterministically. `source-formalize.ts` uses the same frozen context for physical batches and additional/single-claim recovery; type-valid inconsistency remains accepted diagnostic IR. Each accepted sample is persisted before becoming a candidate. Pointer-only attempt envelopes refer to context, registry and raw response artifacts; generated sets retain ordinal namespaces. No candidates are revoked on later sample failure or evidence-capacity shortfall. Entirely ineligible/capacity-skipped source yields diagnostic completion; attempted total failure remains FormalizationError. Typed predicate contracts, raw capture faults, complete-failure and required-write CLI histories passed. Required persistence propagates as OutputError outside model retry catches.

**Tasks 5.1 and 5.6 — transport integration and measured correction:** Source-based calls use one immutable predicate instruction contract and private attached contexts for physical batches, singleton recovery and additional samples. Reusing the attached mechanism for singleton work avoids competing inline schemas and ensures the exact registry/source context is preserved; no source-path prompt override or assertion-producing instruction is used. Legacy raw-domain provider fixtures continue to exercise their isolated adapter boundaries, not a selectable CLI profile. Expected model timeout/invalid-JSON/schema failures may recover; terminal overflow/file/runtime failures do not launch identical fallback work. The first live run found a real defect in the illustrative response-only prompt: all four inputs lost their trigger slot. The example now includes trigger plus response, enumerates all input keys explicitly, and carries deterministic validation feedback in bounded recovery. `formalization-predicates.test.ts` verifies missing-key rejection, feedback, retained rejected samples and candidate shortfalls. Separate domain-validation artifacts are persisted for accepted/rejected envelopes; decoded envelopes have their own bound. CLI all-invalid and required-write histories and V1/V2 compiled/bundled fake-provider runs passed. The second live run accepted all four and found the intended activation conflict; no validator was relaxed to obtain that result.
<!-- Remove this comment when the change summary is supplied.
     The change summay is a full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 6. Bounded Static Query Planning And Execution

- [x] 6.1 Add typed query plans, stable query IDs, admitted/blocked/skipped statuses, shared signature/context identity, per-group script accounting, and a shared run-wide solver pool covering clustering, auxiliary queries, and comparison.
- [x] 6.2 Implement admission-time query/evidence capacity reservation and explicit limit findings; wire effective pairBudget through static analysis and keep maxBatchSize=0 independent of semantic/resource bounds.
- [x] 6.3 Implement background consistency and mandatory-only global consistency with source-mapped sufficient cores; preserve primary outcomes when auxiliary core/model extraction fails.
- [x] 6.4 Implement per-rule guard, self-response, and full-set activation checks that detect guarded-versus-unconditional and multi-rule conflicts without requiring a pair.
- [x] 6.5 Replace string implication extraction with typed co-activation checks over B and the mandatory set; attribute the actual sufficient core and disclose candidate filtering/budget scope.
- [x] 6.6 Implement advisory checks against the mandatory baseline and separately budgeted advisory combinations; implement permission feasibility without requiring permitted responses.
- [x] 6.7 Implement behavior-family/applicability-scoped guard coverage, potential-gap suggestions without explicit expectations, and decoded witnesses; remove group-wide unconditional suppression and reachability wording.
- [x] 6.8 Implement refinement, concrete positive-example, and prohibited-example query semantics without promoting concrete inputs into global assertions.
- [x] 6.9 Persist exact executable scripts, solver version/options, captured stdout/stderr/status, and decoded model/core results for every primary/deeper/auxiliary execution; keep solver errors authoritative over printed verdicts.
- [x] 6.10 Differential-check the query families against the independent finite-domain evaluator and real-Z3 arithmetic fixtures, including a SAT region with an infeasible individual input to verify honest existential result wording.

### Bounded static query planning and execution change summary

**Tasks 6.1–6.8 and 6.10:** `query-executor.ts` owns typed plans, monotonic IDs, per-capability script accounting, byte/fragment admission, storage reservations and a run-shared semaphore. The CLI admits typed work in fixed order; direct concurrent executor calls obey the configured ceiling. Blocked prerequisites are explicit ledger entries, not successful skipped checks. `static-analysis.ts` implements B, mandatory C, guard/self/activation, full-set co-activation, advisory and permission checks, example queries and explicit family/applicability coverage. Dependency closure in `dependencies.ts` includes third-party constraints, preserving three-rule conflicts that direct intersection would miss. Core reruns use distinct labels and preserve primary UNSAT when extraction fails; attribution is sufficient, never automatically minimal. Scoped witnesses use exact scalar decoding; potential gaps without expectations are suggestions. `static-queries.test.ts` compares every production query to independent finite evaluation and real Z3, tests sufficient-core attribution, scoped witnesses, budgets/concurrency and failed auxiliaries. The hand-derived arithmetic corpus includes a feasible region with an infeasible individual input, so SAT wording is existential. Focused solver/CLI integration and strict lint passed.

**Task 6.9:** Every typed solver path, including clustering/comparison/core/model reruns, uses the shared executor. Output artifacts retain exact scripts, typed fragment/signature identity, query options, solver version, all captured status/byte fields and exact decoded scalar/core representations where available. Unknown or failed decoding remains null/unavailable, never a fabricated witness. The Z3 adapter retains byte capture and UTF-8/termination/overflow status on success and failure; errors override printed verdicts. Sufficient cores carry an explicit not-minimized strength label. Exact script checks, independent Z3 differential queries, auxiliary failure injection and manifest checksum tests passed; the measured live run recorded 37 definite queries with no inconclusive outcomes.
<!-- Remove this comment when the change summary is supplied.
     The change summay is a full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 7. Nonvacuous Clustering

- [x] 7.1 Build clustering queries through the shared signature/typed IR, with background/premise satisfiability checks and no duplicate declarations or textual SMT reparsing.
- [x] 7.2 Separate logically inconsistent candidates from invalid schemas and nonvacuous equivalence clusters; retain inconclusive relationships and prevent vacuous agreement from becoming stable meaning.
- [x] 7.3 Apply the specified deterministic representative-quality ordering and threshold; label single samples, shortfalls, model-proposed mappings, and unstable diagnostic representatives explicitly.
- [x] 7.4 Verify symmetry/determinism, inconsistent/unknown samples, largest-cluster selection, partial evidence, and interpretation-dependent downstream reporting using independent oracle and real-Z3 cases.

### Nonvacuous clustering change summary

**Tasks 7.1–7.3:** `typed-clustering.ts` uses the shared signature and background/premise checks before pairwise entailment. Inconsistent samples remain diagnostic alternatives and cannot form stable clusters through vacuity. Single samples are selected rather than measured stable. Stable selection orders eligible clusters by size, then minimizes model-proposed mappings, prefers more source slots, and uses source index for ties. Registry identities and assumptions must match; unknown pairs stay unknown. CLI representatives from unstable clusters explicitly carry interpretation dependence. `semantic-clustering.test.ts` verifies single/impossible/unknown cases and largest-cluster quality selection with real Z3; repeated fixed samples preserve cluster/pair outcomes.

**Task 7.4:** Real-Z3 tests verify singleton status, two impossible samples, unknown premises, deterministic repeated bidirectional relationships and largest-cluster selection with quality tie-breaking. Independent finite-expression/query evaluation verifies entailment formulas, while generated signature/registry histories exercise immutability and order isolation. Downstream unstable representatives remain qualified and all rejected/shortfall samples have separate validation evidence. The cluster-size ordering was corrected explicitly rather than relying on traversal order.
<!-- Remove this comment when the change summary is supplied.
     The change summay is a full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 8. Independent Source-Backed Analysis And Alignment

- [x] 8.1 Route generated specifications through the same parser, source admission, modal assignment, registry discovery, typed formalization, and static analysis; remove unconditional mandatory synthetic-claim construction.
- [x] 8.2 Enforce independent generated contexts and frozen registries, permitting only the existing capability-name suggestions; test that original text, registry entries, and assumptions never enter generation/discovery inputs.
- [x] 8.3 Implement post-freeze alignment with explicit concept/signature/unit/scope mapping, checked joint renaming, unmapped/incompatible/partial statuses, and separate permission relation verdicts without mutating either source registry.
- [x] 8.4 Replace SMT-LIB line parsing in cross-side production queries with structured artifacts and shared signatures; require compatible modalities, matching aligned assumptions, admitted fragments, and satisfiable premises.
- [x] 8.5 Preserve aggregate-before-pairwise analysis, effective pair/total budgets, deterministic greedy matching and unmatched reporting while excluding scope-status results from semantic-difference or favorable-alignment scoring.
- [x] 8.6 Keep uncertain/incompatible/unmapped/partial formal outcomes terminal; attach qualitative explanations separately without converting them into solver-established equivalence or proof of implementation behavior.
- [x] 8.7 Verify alias alignment, same-name/different-concept isolation, unit/assumption mismatches, inconsistent generated premises, partially mapped capabilities, generated failures, and budget-limited comparisons.

### Independent source-backed analysis and alignment change summary

**Tasks 8.1–8.4 and 8.6:** Generated Markdown now carries requirement IDs/evidence separately and passes the same parser/admission/discovery/predicate kernel. Source namespace includes generated claim-set ordinal, preventing collisions between repeated capability names. Original and generated explicit model maps stay separate. `alignment.ts` matches supported exact definitions/roles/signatures/enum universes and exact unit representations after derivation; aliases are proposals, name equality alone is insufficient. Differing unit scales remain incompatible rather than silently conflating integer lattices. `semantic-comparison.ts` checks matching aligned assumptions, nonvacuous premises and typed direction formulas. Permission relations compare explicit allowed valuation sets including each side's mandatory baseline and use separate labels; absent permission is unmapped scope. Excluded/failed source scope qualifies aggregate alignment, and partial results cannot win semantic matching. Generated explanation remains supporting evidence without verdict promotion. Semantic-comparison contracts, generated-formalization tests and both source-backed CLI integrations passed. Legacy provider fixtures were updated to the new predicate wire contract rather than relaxing admission.

**Tasks 8.5 and 8.7:** Aggregates precede pairwise work per modal track. Pair-budget and shared total-script limits preserve explicit unassessed scope; deterministic scores/source positions yield at most one complete match per side. Partial/unmapped/incompatible results do not win matches. Satisfiable background and premises plus guard feasibility block favorable vacuity. SAT directional differences request separate witnesses without allowing auxiliary failure to change the relation. Comparison contracts test broader/narrower/equivalent/different permission sets, absent permissions, alias naming, same-name/different-definition isolation, explicit unit-scale and assumption mismatches, vacuous/inconsistent cases, partial source scope and pair-budget exhaustion. Generated unsupported-source and complete-failure fixtures preserve scope; source-backed CLI tests verify original text is absent from generated artifacts and separately authored contexts remain independent.
<!-- Remove this comment when the change summary is supplied.
     The change summay is a full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 9. Evidence Reports And Completion Integration

- [x] 9.1 Add managed output paths and manifest descriptors for source mappings/dispositions, concept discovery, raw responses, normalized IR, alignment, query ledgers, and exact solver executions.
- [x] 9.2 Extend ordered run-start cleanup, output confinement, atomic writes, checksum validation, and partial-run handling to every new artifact without changing the optional report's post-manifest lifecycle.
- [x] 9.3 Render statement/check scope ledgers and interpretation/assumption qualifications in phase reports, summaries, divergence calculations, and optional final-assessment input; remove unsupported reachability, completeness, stability, and all-input guarantees.
- [x] 9.4 Add effective source/config/prompt/compiler/registry identity and solver/runtime metadata while preserving current numeric versions and opt-in telemetry collection; reject historical/current-contract equivalence without matching fingerprints.
- [x] 9.5 Exercise evidence reservation exhaustion, captured overflow, write/rename failure, missing/failed auxiliary decoding, stale rerun cleanup, complete-failure evidence, and manifest/final-report fault histories.

### Evidence reports and completion integration change summary

**Tasks 9.1–9.2 and 9.4:** `semantic_evidence/` joins manifest-first invalidation and managed cleanup. `EvidenceRecorder` accounts in-flight reservations before asynchronous writes and stores exact model stdout/stderr bytes separately from pointer/status JSON. Typed solver executions preserve exact scripts and bounded result data. `core-artifacts.ts` enumerates only managed generated/SMT/comparison trees, rejects symlinks and hashes completed artifacts. `semantic-identity.ts` records active module/bundle hashes; source files reject invalid UTF-8 and preserve exact content hashes. Effective model/configuration/prompt/compiler/registry identities and solver/runtime version metadata accompany conclusions without a numeric version bump. Required write failures cannot finalize a manifest. Existing optional report.md remains outside the core manifest; failure refreshes summary/checksums. CLI fault histories verify raw evidence after all-invalid samples, OutputError, stale evidence removal, capacity-limited diagnostics and optional-report failure. Raw evidence intentionally retains source/model content; callers select the output location.

**Tasks 9.3 and 9.5:** Source inventory persists even when every statement is excluded; per-group source evidence remains mandatory before model interpretation. Ledgers count extracted/eligible/excluded/candidate/failed/unstable and executed/skipped/blocked/inconclusive scope. Phase/summary reports state valuation and interpretation strength, and optional final-report failure uses the same scope-preserving summary rewrite. Typed comparison findings retain partial scope rather than feeding it into favorable alignment/divergence scoring. The semantic CLI histories test 1-MiB evidence admission refusal, stale evidence cleanup, all-invalid raw attempts, required registry-write failure and optional final-report failure, checking every manifest checksum. Existing process-overflow and output atomic-write/rename/manifest fault tests remain in the full suite. Failed auxiliary extraction preserves primary UNSAT; missing decoded witnesses remain unavailable. Global mapping-capacity refusal is explicit, while actual required write failures are fatal.
<!-- Remove this comment when the change summary is supplied.
     The change summay is a full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->

## 10. Release Verification And Documentation

- [x] 10.1 Complete traceSpec declarations for every new/changed contract and add parser, typing, registry, modality, activation, coverage, scenario, clustering, comparison, and failure cases to the semantic acceptance corpus.
- [x] 10.2 Run generated-history/metamorphic checks for fixed-response determinism under completion permutations, no silent claim loss, no post-freeze mutation, literal-safe rendering, exact units, and cross-invocation evidence isolation.
- [x] 10.3 Re-run the Alloy model and updated affected models with positive witnesses and explicit scopes; record results and model hashes in verification evidence without claiming unbounded proof.
- [x] 10.4 Evaluate the fixed corpus with real model/solver identities and record discovery token cost, latency, formal coverage, inconclusive rate, and semantic outcomes; distinguish improvements from mere increases in accepted samples.
- [x] 10.5 Update README.md, docs/design.md, ARCHITECTURE.md, current prompt/config examples, and affected assurance/traceability guidance to match the shipped in-place static semantics and explicit temporal follow-up boundary.
- [x] 10.6 Run strict OpenSpec validation, make check, real-Z3 integration checks, and compiled/bundled CLI parity; record commands/results and resolve failures before implementation completion.
- [x] 10.7 Reconcile proposal/design/spec/task/model evidence and document any approved deviations; confirm every implementation task has its what/why/decision/handoff/evidence audit entry before requesting archive.

### Release verification and documentation change summary

**Tasks 10.1–10.5:** All current change headers have executable trace declarations; verification-map paths now point to implemented tests and explicit model/evaluation artifacts. Generated source/admission, literal/number/signature and registry completion-permutation histories passed in the full suite. The lifecycle model was rerun with all five witnesses and twelve bounded assertions; the finite semantic model has three witnesses and four bounded assertions. Their hashes/commands/results are recorded in `verification.md`. `evaluation.json` records the fixed real-provider corpus, measured snapshot identity, partial usage/cost fields, latency, accepted scope, exact defect and optional-report outcome. It distinguishes a prompt correction from broad accuracy/performance claims. README, docs/design.md and ARCHITECTURE.md now describe strict grammar, typed expressions, modal tracks, explicit configuration/units, independent generated contexts, evidence, result strength and the temporal follow-up boundary. An unquoted explicit-duration/temporal-operator admission guard prevents obvious deadlines from becoming timeless predicates; protected display literals are retained, and other unsupported meaning remains a model-validation obligation. Later release checks validate source changes separately from the measured bundle snapshot.

**Tasks 10.6–10.7 — final acceptance:** `make check` passed the final semantic source snapshot with 1,009 tests in 112 files, complete canonical trace coverage, strict TypeScript/ESLint, builds and external-process compiled/bundled OpenCode v1/v2 parity. Three opt-in live/server tests were skipped; the real-model corpus was evaluated independently and real-Z3 tests were executed. Strict OpenSpec validation and `git diff --check` passed; the distribution was rebuilt after the final TSDoc-only edit. Inventory reconciliation found 35 requirement groups and 171 scenarios (206 unique tagged headers), every mapped check path and delta file link present. The resolved permission contract, singleton attached-context implementation choice, deterministic admission/concurrency ceiling, explicit unit alignment, conditional interpretation boundary and measured-snapshot limitation are documented in `verification.md`. All 63 tasks have section-level what/why/decision/handoff/verification audit entries; historical intermediate summaries remain identifiable as stage evidence. Current schema reported by OpenSpec is `srs-driven`. Implementation is complete and uncommitted; archive remains a separate user-directed action.

Record final verification commands and results, evaluation corpus/model/config hashes, measured cost/coverage trade-offs, documentation updates, residual limitations, and follow-up temporal work. Temporal BMC implementation is not a completion requirement of this change.

## 11. Post-Completion TypeScript Guideline Remediation

- [x] 11.1 Capture pre-refactor static/source orchestration histories with recording executor/model/evidence effects, including success, conflicting/inconsistent/unknown/timeout scope, limits, rejection/recovery/shortfalls, and required-write failures.
- [x] 11.2 Decompose static phases and source group/batch/recovery control flow into bounded cohesive helpers, preserving admission order, B/C provenance identity, evidence bytes, candidate retention and exception propagation.
- [x] 11.3 Narrow source/alignment/expression boundaries, remove avoidable assertions, document retained local invariants, expand touched API contracts/examples and name operational bounds; retain existing budgeting and scheduling behavior.
- [x] 11.4 Add bounded sort-directed generation, independent exact semantics and bijective SAT/UNSAT rename properties, rational/zero boundary regressions, optimization trace declarations and deterministic concurrent timeout/partial-evidence histories.
- [x] 11.5 Run full acceptance and document preservation evidence and intentionally separately scoped API/ownership follow-ups in verification.md and align_plan.md.

### TypeScript guideline remediation change summary

**11.1 — characterize first:** `alignment-characterization.test.ts` was executed
against the pre-refactor code before changing production orchestration. Sixteen
checked-in snapshots hash complete deterministic histories (scripts/order, ledger,
findings, model contexts/feedback, exact evidence paths/payloads, candidate/error
outputs), with readable query order/count summaries. These cover primary and
auxiliary outcomes, pair/script/evidence limits and persistence failure. Snapshot
expectations were not refreshed after the refactor; all match. Hashes are compact
regression evidence, not proof for every input or model fidelity.

**11.2 — extract responsibility, retain ownership:** `static-analysis.ts` now owns
the visible phase sequence and immutable group preparation. `static-context.ts`
owns query/diagnostic/attribution services with a separate run-confined result
writer. Source formalization separates group discovery, physical batches,
claim-local bounded recovery and validation/acceptance publication. No model or
solver call was eliminated/reordered. Prepared registry lifetime, first-index B/C
identity, artifact serialization and group-local capacity/error handling remain
unchanged. Existing focused tests and all characterization snapshots pass.

**11.3 — contracts and narrowing:** Joint name/signature mismatch now fails an
explicit invariant; public predicate lowering without source structure returns a
typed validation error. Valid-input behavior is unchanged; malformed-input
diagnostics are intentional. Function argument and rational-literal validation
use checked locals rather than tuple/non-null casts. Semantic comparison collects
all rebound nodes or returns unmapped (never filters scope). Parser assertions have
local structural explanations. Pair counters leave conditional expressions without
changing the admitted prefix/skip threshold. Touched API contracts now describe
failures, bounds, ownership and examples; operational constants replace embedded
group/cache/concurrency/timeout limits. The new static-context module joins runtime
fingerprinting. `formal-style.test.ts` checks physical function/file size targets;
it is a coding-guide check, not fabricated canonical behavioral coverage.

**11.4 — correct-boundary properties:** Independent bounded source descriptions and
exact fraction/Boolean/enum evaluation live in `test/support/generated-expressions.ts`.
Each solver-property sample includes numeric and enum comparisons. Bijective
renaming changes source identifiers, enum sorts/constructors and typed function
names consistently, with SAT tautologies and UNSAT contradictions included. Depth,
sample counts and real-Z3 calls are bounded; first failure stops solver shrinking.
Literal-only canonical-rendering stability avoids assuming source/solver namespaces
are inverses. Exact quantity/coercion and typed UF fixtures supplement the generated
trees. Rational-literal rejection, supported zero-value forms and trace declarations
pin the reviewed boundaries. Deferred-promise histories prove timeout slot release,
queued progress, at-most-once execution, partial evidence survival and reservation
release after required output failure without sleeps or incidental scheduling.

**11.5 — acceptance and remaining scope:** `make check` passed 1,118 tests in
121 files with complete canonical trace coverage, strict TypeScript/ESLint,
real-Z3 properties/integration, wired-in bounded Alloy checks and external-process
compiled/bundled CLI parity. Three opt-in tests in two files remain skipped.
Strict OpenSpec validation and `git diff --check` passed. Sixteen pre-refactor
snapshot expectations match without regeneration. Functions in touched production
modules are checked against the 70-line target; all such files remain below 500
lines. `align_plan.md` records all WS0–WS4 completion and four deliberately separate
follow-ups: stronger outcome/status unions, read-only writer views, typed evidence
admission and pending-queue/backpressure/cancellation design. These remain guide-
alignment gaps, not silently claimed compliance. No scheduling, numeric version,
live-provider measurement, commit or archive change accompanies this remediation.

## 12. Paired SMT Impact Experiment

This section records a completed one-off evaluation from 2026-11-15. The paired
harness, experiment proxies, measurement fixtures, experiment-only tests and older
binary were retired on 2026-11-17. They are no longer build, test or release
dependencies. The completed tasks and measurements below remain historical.

- [x] 12.1 Predeclare a bounded paired corpus, independent oracle, negative controls, strata, failure-inclusive rubric and practical improvement criterion before measured runs.
- [x] 12.2 Implement an actual old/current CLI harness with exact binary/input identity, native-schema fixed interpretations, live model mode, counterbalanced repetitions, bounded subprocesses and complete experiment artifacts.
- [x] 12.3 Execute controlled and live paired batches against pasture/spec-check.older with the same Z3/model controls; retain all selected outcomes and keep context-capability cases separate.
- [x] 12.4 Verify oracle/scorer, true-negative failure handling, actual binary comparison, partial-byte transport under inner/outer timeout, checksum integrity and final full-suite acceptance.
- [x] 12.5 Publish reproducible measured results, explicit cost/latency/coverage trade-offs, publication provenance and limits without claiming population accuracy or unperformed human review.

### Paired experiment change summary

**12.1–12.2 — protocol and harness:** The experiment predeclared the
hypothesis/thresholds, sixteen defect/control specimens and a six-case live subset.
Opaque model-visible identities prevented answer-label leakage. The retired
harness included the corpus, an independent eight-valuation oracle, report
parser/scorer, collector and paired aggregation. Both actual executables were
copied byte-for-byte, hashed and run with real Z3. The old file's nonstandard
extension was adapted only by the copy's `.mjs` filename. Fixed interpretation
replies encoded identical hand-authored meaning in each native schema; live mode
used each engine's own prompts/discovery against the same model. Qualitative review
and optional narrative were excluded identically so their prose could not mask
solver insight differences. Query capture made the older tool's unpersisted deep
scripts auditable during the evaluation.

**12.3 — measured outcomes:** Verified batches contained 64 controlled CLI runs
(16 cases, two repeats, two arms) and 24 live CLI runs (six cases, two repeats,
two arms), with case-level averaging and counterbalanced order. Shared-source
controlled recall improved from 14.3% to 100%; clean controls from 85.7% to 100%.
The live subset improved positive recall from 0% to 100%, with clean controls and
assessed completion at 100% for both. Added scoped-context capability is reported
separately because the old CLI could not consume that configuration. These met the
predeclared practical criterion on this diagnostic corpus, not a population test.

**12.4 — credibility and bounds:** Independent expected signals never entered the
provider fixture or live prompt. Failures/missing coverage could not earn clean-negative
credit; duplicate findings could not inflate recall. Every experiment artifact checksum
was verified. The live proxy recorded requests before spawn and streamed bounded exact
output to both engine and disk; fake provider tests checked partial bytes under
model and outer timeouts without paid calls. Oracle/scorer, actual binary/Z3 and
blinded-label independence tests were included in that acceptance run. At the time,
`make check` passed 1,127 tests across 124 passing files with three existing opt-in
skips, including strict TypeScript/ESLint, canonical trace coverage and
compiled/bundled parity. These historical counts include the retired experiment
tests and do not describe the current suite.

**12.5 — interpretation and handoff:** The [verification record](verification.md)
retains the principal measurements, binary hashes and evaluation limits. Live
core time increased from 3.649 s to 8.892 s/run, with model calls doubling (1 to 2)
and more solver scripts/evidence. Token/cost telemetry was incomplete for almost
all calls, so total monetary comparison remains unavailable. Preliminary batches
were retained separately and agreed on diagnosis scores; they were not pooled as
independent samples. Publication-only review-label/context corrections and a scorer
clarification did not alter any acquired score or primary report bytes; provenance
records and re-evaluation of all 88 verified runs established that boundary. Human
packets were unscored. No production analyzer, baseline bytes or normative
SMT semantics were changed for this experiment. Representative real-document and
source-backed/temporal quality remain outside the selected synthetic study.

## 13. Verification Boundary Remediation

- [x] 13.1 Route generated-only typed analysis through the run-owned executor/evidence/limits and verify actual CLI executions against budget and ledger, including empty generation.
- [x] 13.2 Preserve parser-owned subject/form context in every predicate request and verify actor swaps, batch/recovery/additional samples without changing source-owned lowering.
- [x] 13.3 Publish explicit single/stable/unstable interpretation assessments on both sides and preserve contributing baseline qualifications through comparison, reports and matching.
- [x] 13.4 Capture immutable independent generation inputs, exact request/attempt identity and raw outcomes through admitted managed evidence; verify mutations, capacity refusal, persistence failure and blindness.
- [x] 13.5 Emit reversible inert typed identifier mapping comments and verify constants/functions/enums/Unicode/newlines with real Z3.
- [x] 13.6 Retain the user-required level-three canonical state-machine heading and document its strict-validation exception; reconcile contracts, verification maps, lightweight models and documentation; complete focused/full acceptance and record remediation evidence.

The user authorized this section after a second fresh analysis confirmed C1 and
W1–W4 in `implementation-verification.md`. Earlier checked tasks and their stage
audits remain historical evidence. The approved plan preserves per-capability
actual-script accounting and separates mapping scope from stability/identity
qualifications; no numeric schema versions change.

**User correction:** `### State machine and invariant checks` must remain level 3,
despite the OpenSpec validation error. Canonical strict validation will report this
accepted exception; active-change validation remains required to pass.

### Verification boundary remediation change summary

**13.1 — execution ownership:** Typed source-backed coordination is selected by the
supplied run executor, not original representative presence. Generated-only checks
therefore share exact-query capture, capability script budget and process pool.
The lower-level generated-logic entry accepts explicit executor/evidence/config/pair
controls. `generated-only-cli.integration.test.ts` independently observes real Z3
subprocesses for compiled and bundled CLI: one configured script, one actual query,
one ledger execution and byte-identical saved script. Empty generation runs none.

**13.2 — context fidelity:** `source-formalize.ts` includes preserved subject spans,
form and scenario kind in every attached request. The predicate instruction treats
these as data, not additional slots or source-authority overrides. The actor-swap
contract uses opaque IDs and explicit server/client concepts, checks changed
requests, recovery/additional context and a constant registry hash. Existing
modal/NOT/postcondition tests still pass.

**13.3 — assessment publication:** Shared immutable assessment publication records
single/stable/unstable, valid sample count, selected index and cluster membership.
`selected-clustering.ts` reserves metadata before clustering; refusal issues no
solver work and retains diagnostic unassessed scope. Both source sides use it.
Comparison reserves/persists contributing assessments separately from mapping
scope and proposed identity; unstable permission baselines are included. Unstable
relations remain readable warnings but win no matching credit. Singleton agreement
is not invented. Original/generated ambiguity, baseline, capacity, persistence,
distinct unissued records and generated multi-sample publication tests pass.

**13.4 — independent generation identity:** Source scanning retains exact bounded
bytes. The generation adapter records managed byte snapshots, original paths and
exact request/prompt hashes before writing private exclusive attachments. Existing
model hooks admit/capture every attempt with its proper generation phase and
runtime/model/raw/status evidence. Original edits after capture cannot change
retries. Capacity refusal yields unissued scope; required write failure remains
OutputError. Copy cleanup runs in finally. Source mutation, changed byte identity,
retry/complete-failure, capacity and CLI required-input-write tests pass. Generation
input contains only source evidence and capability suggestions; alignment remains
post-derivation.

**13.5 — inspectable encoding:** Typed signatures include reversible JSON-escaped
mapping comments for constants/functions and enum sorts/constructors without
changing the injective encoder. Real Z3 accepts Unicode/newline/command-looking
comment content as inert. Exact declaration/script expectations were updated
explicitly. The original sixteen pre-refactor snapshots are preserved byte-for-byte
in `verification-evidence/pre-remediation-characterization.snap`; current snapshots
add actor context and mapping comments while retaining protocol/order accounting.

**13.6 — acceptance/handoff:** See the current verification entry for final full
suite/model/validator results. The level-three canonical state-machine heading
is an accepted user-required exception. Fingerprinting includes the new selection,
qualification, generation and predicate-boundary code. Models abstract one-capability
token charging, generated-only completion and immutable capture, with positive
witnesses; production refinement and English fidelity are not proved by them.
`make check` passed 1,153 tests in 127 files with three existing opt-in skips.
Final runtime-identity hardening adds the source-backed coordinator itself to
modular fingerprints; a routing-only mutation regression and compiled/bundled
generated-only parity checks passed after rebuilding, as did strict lint.
Strict active-change validation and `git diff --check` passed. All 79 tasks
are now complete; work remains uncommitted and unarchived.
<!-- Remove this comment when the change summary is supplied.
     The change summay is a full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed.
     Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision.
     Important information to pass on to other developers about the implementation of this task.
     For example:
     1. "What changed:" - factual description of what was implemented
     2. "Why this was done:" - rationale connecting implementation decisions to spec requirements
     3. Implementation details with specific file paths (why this change works successfully); Other evidence that the tasks were successfully completed
     4. "Under-specified decision:" - decisions not in the spec
     5. "Developer handoff notes:" - important info for other devs
     6. "Validation evidence:" - proof it works -->
