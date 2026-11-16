# Implementation Verification: improve-ears-smt-analysis

> **Historical review:** The issues and measurements below describe the pre-remediation
> workspace. The user subsequently authorized repairs after a second fresh analysis.
> Current remediation acceptance is recorded in `verification.md` and tasks section 13.
> The canonical level-three state-machine heading is retained by explicit user request.
> **Current disposition:** C1 and W1–W4 are resolved with focused regressions and
> acceptance evidence; S1 is the accepted user-required validation exception.

## Scope and Method

- Schema: `srs-driven`; selected explicitly by the user.
- Read all context artifacts returned by `openspec instructions apply`: proposal,
  design, tasks and all six delta specs.
- Checked all requirement groups against implementation/test evidence, inspected
  scenario conditions, reran the full acceptance suite and change validation, and
  used isolated counterexample probes for uncovered boundary cases.
- This is a verification report, not a remediation. Production code, tests, task
  checkboxes and normative artifacts were not changed during verification.
- The conclusions concern the current workspace, including the later Sol/high
  default. Historical Terra/provider and CPU measurements were checked as retained
  snapshots, not presented as fresh measurements of the current default.

## Summary Scorecard

| Dimension | Status |
| --- | --- |
| Completeness | 73/73 tasks checked; implementation evidence for 35/35 requirements; one required runtime branch is incomplete |
| Correctness | All 171 scenario IDs exercised by the traced suite; 1 critical gap and 4 concrete warnings remain |
| Coherence | Main layered/static design is followed; source-only fallback, subject transport and stability propagation diverge at boundaries |

Inventory: 35 requirements, 171 scenarios, 206 unique tagged headers. All requirement
groups have verification-map entries. Trace coverage is evidence that identifiers
were exercised, not proof that every scenario condition is correctly handled.
Several cases below are missing integration/edge-condition regressions despite
existing trace declarations.

## Fresh Verification Results

| Check | Result |
| --- | --- |
| `make check` | Passed: 1,128 tests, 124 passing files; 3 opt-in skips in 2 files |
| Strict TypeScript / ESLint | Passed as part of `make check` |
| Full canonical trace accounting | Passed as part of `make check` |
| Real-Z3 integration and compiled/bundled CLI parity | Passed in the suite |
| `openspec validate improve-ears-smt-analysis --strict` | Passed |
| `git diff --check` | Passed |
| Lifecycle Alloy rerun | 5 positive witnesses; no counterexamples to 12 assertions within declared bounds |
| Finite static Alloy model | 3 witnesses / 4 assertions pass in the wired-in model test |
| Retained controlled impact evidence | 5,812 artifact checksums verified; stored result digest matched |
| Retained live impact evidence | 1,960 artifact checksums verified; stored result digest matched |
| Canonical `catalog-and-parse` strict validation | Existing missing-scenario error; reproduced in pre-change HEAD snapshot, see S1 |

Fresh logs/artifacts:

- `/tmp/opencode/opsx-verify-ears-smt-check.log`
- `/tmp/opencode/opsx-verify-ears-smt-lifecycle/receipt.json`
- `/tmp/opencode/opsx-verify-ears-smt-lifecycle.log`
- `/tmp/opencode/opsx-verify-canonical-validation.json`
- Critical-path reproduction: `/tmp/opencode/verify-no-original-tZ5ysL/repro-summary.json`

Lifecycle model SHA-256:
`bd40b9a01a8347b3a38ee0fb09d665e993a8cb8c8d82aaf4913b0b4e8e1df292`.
Static model SHA-256:
`1737c500e1dd31f01a126f690539e0eb56a4fe65ffe186d7413cdb8f9c34bd0b`.
These are bounded abstraction checks, not production-refinement or English-fidelity
proofs. All new probes used fixed/injected model responses; no paid live-model
evaluation was repeated during this verification.

## CRITICAL — Must Fix Before Archive

### C1. Source-only typed analysis bypasses the shared executor, evidence and configured limits

**Implementation:** `src/cli/pipeline-helpers.ts:533–568`,
`src/domain/code-backwards/gen-logic.ts:40–52`,
`src/domain/formal/logic-analysis.ts:160–165`.

The typed source-backed branch is conditional on at least one original
representative having a signature. All-ineligible original input legitimately
produces zero representatives, so a `--src` run with valid generated artifacts
falls through to the older coordinator branch. `analyzeGeneratedLogic` then calls
`runLogicAnalysis` without the run's executor, evidence recorder, effective analysis
limits or pair budget. A fresh default executor runs typed checks without durable
query capture, and the CLI's actual-script ledger does not see those executions.

**Reproduced:** one original excluded prose requirement; one eligible generated
MAY rule; explicit generated concepts; `analysis.limits.queryScripts = 1`.

```text
actual solver queries:          4
recorded executed queries:      0
exact .input.smt2 artifacts:    0
current manifest published: true
CLI result: exit 1, code-derived logic report says "No findings."
```

Every actual query was observed by an external real-Z3 proxy. The original source
and generated formalization were not modified to obtain the discrepancy. A second
run without the one-script setting likewise executed four unrecorded queries.
The reproduction bundle includes source, fake provider, exact solver executions,
both output directories and the limited-run summary.

**Artifacts violated:** `FLA-SOLVER-PERSIST`, `FLA-PERSIST-ALL`,
`FLA-ANALYSIS-BOUNDS`, `FLA-BOUNDS-QUERIES`, `RAE-QUERY-EXACT`,
`RAE-SCOPE-LEDGER`; design interaction steps 7–9 and shared-executor/evidence
invariants. Tasks 6.1/6.9/8.4/9.3 are checked, but this valid CLI branch does not
implement their required behavior.

**Required action:** choose the typed coordinator from the invocation/available
generated typed artifacts, not the existence of an original representative. Route
generated logic through the supplied run executor/recorder/effective limits even
when original scope is empty; retain the missing-original comparison qualification.
Add an actual CLI regression combining all-ineligible originals, `--src`, valid
generated output and a one-script ceiling. Assert external actual executions equal
the ledger, stay within the ceiling, and each has required executable-query evidence.

## WARNING — Should Fix

### W1. Source subject semantics disappear from predicate-formalization requests

**Implementation:** `src/domain/formal/predicate-lowering.ts:15–25`,
`src/domain/formal/source-formalize.ts:192–196`.

The parser preserves the subject, and discovery receives it, but the subsequent
predicate request contains only index, display ID, source reference and predicate
slot text. Subject/form context is absent. Registry provenance sometimes helps a
model infer the actor, but explicit configured concepts need not carry per-source
bindings, and repeated explicit concepts do not acquire such bindings automatically.

**Reproduced with valid explicit configuration and an empty discovery proposal:**

```text
First input:  THE server SHALL respond. / THE client SHALL respond.
Second input: THE client SHALL respond. / THE server SHALL respond.
```

With unchanged opaque IDs/ordinals and configured ServerResponse/ClientResponse
concepts, the two distinct inputs produce byte-identical formalization contexts.
Both claim entries contain only `predicates: { response: "respond" }`; the explicit
registry/hash is identical as well. The response interpreter cannot reliably
associate the correct actor from those supplied bytes. This is information lost
at the request boundary, not a demonstrated model-quality problem.

**Artifacts affected:** `CGC-CLAIM-CLAUSES`, `FLA-FORMALIZE-CLAIMS`,
`CAT-EARS-MATCH`; design source-structure preservation and clause-interpretation
contracts.

**Action:** include parser-owned subject/context with each claim in the attached
request while retaining the exact response-predicate keys and deterministic source
modality/NOT lowering. Add a two-actor same-response regression with opaque IDs and
explicit concepts; swapping subjects must change the supplied semantic context.

### W2. Unstable interpretation status can become an unqualified complete comparison

**Implementation:** `src/cli/pipeline-helpers.ts:322–334`,
`src/domain/code-backwards/semantic-comparison.ts:117–129`,
`src/domain/code-backwards/gen-formal.ts:165–184`.

Original-side clustering reduces ambiguity to `staticRule.interpretationDependent`.
Capability comparison checks registry identity and source counts, but does not
carry cluster stability into scope. Generated-side propagation also publishes the
representative without preserving an explicit stability status.

**Reproduced through public helpers with real Z3:** explicit matching registries;
original samples `X` and `(not X)`; threshold 0.6; generated sample `X`.

```text
clustering: formalization.ambiguity
representative interpretationDependent: true
aggregate: info — same (complete mapped scope)
pairwise:  info — same (complete mapped scope)
```

The representative's logical relation is valid as a conditional selected-sample
result, but the instability qualification is lost from comparison scope. Ordinary
CLI calls currently request a single sample, so this is a supported multiple-sample
API/composition gap rather than a claim that every current CLI run is unstable.

**Artifacts affected:** `FLA-CLUSTER-DIVERGE`, `STC-FORMAL-AMBIG`,
`STC-IMPLY-AGGREGATE`, `RAE-STRENGTH-PARTIAL`; design explicitly requires unstable
alternatives and diagnostic-only representatives to qualify downstream assessment.

**Action:** propagate explicit cluster stability/representative provenance on both
sides, distinct from grounded-proposal dependence. Preserve scoped conditional
relations but prevent unstable representatives earning complete/favorable capability
alignment or matching credit. Extend the existing ambiguity test through capability
comparison, rather than stopping at the clustering result.

### W3. Source-derived generation does not persist its exact code inputs or request identity

**Implementation:** `src/domain/code-backwards/derive.ts:106–155`,
`src/cli/pipeline-helpers.ts:510–517`, `src/cli/run-cli.ts:207–210`.

The derivation call receives original source file paths through attachments. The
implementation persists generated Markdown, but does not persist/hash the selected
code attachment bytes or exact generation request at that boundary. Registry/source
evidence later hashes generated Markdown; it does not identify which version of
the implementation source produced it. Effective input-file metadata lists original
spec inputs, not an immutable generation-input snapshot.

No original-text leakage was observed: the generation prompt construction does
separate original requirements from source evidence. The missing piece is durable
evidence identifying the actual independent generation inputs.

**Artifacts affected:** `STC-ALIGN-BLIND`, `RAE-SEMANTIC-EVIDENCE`,
`RAE-EVIDENCE-IDENTITY`; tasks 8.2/9.4 and the design's independent input-hash contract.

**Action:** finalize source-generation request/attachment hashes (and selected byte
snapshots or immutable private attachments where needed) before invocation, with
model/runtime/prompt identity and admitted capability-name suggestions. Register
them with the evidence coordinator/manifest. Test that changing only implementation
source changes generation-input identity even when a fixed model returns identical
Markdown; verify original-spec content is still absent.

### W4. Typed compilation omits the mapping comments required by the retained scenario

**Implementation:** `src/domain/formal/signature.ts:134–143`,
`src/domain/formal/typed-smtlib.ts:20–35`.

`FLA-SMTLIB-SANITIZE` expressly requires reversible mapping comments. The typed
compiler correctly encodes identifiers and has separate registry evidence, but
does not emit those comments. A typed assertion over `a_b` produces:

```smt2
; claim MAP-CLAIM
; obligation mandatory
; registry unrecorded
(declare-const va_00005Fb Bool)
(assert va_00005Fb)
```

The encoder is injective; this is an inspectability/scenario alignment gap, not
an identifier-collision or injection finding. Existing raw-compiler tests do not
establish that the typed source path emits the specified mapping comments.

**Action:** emit inert original-to-generated mapping comments in typed declaration
output and add a typed-path assertion, or explicitly revise this scenario to make
the registry/mapping artifact the required reversible evidence instead. Preserve
newline neutralization and source identity in either contract.

## SUGGESTION — Existing Repository Validation Issue

### S1. Canonical catalog spec still fails its own strict validation

`openspec validate catalog-and-parse --type spec --strict` reports
`requirements.15.scenarios: Requirement must have at least one scenario`.
The file includes a non-requirement level-three state-machine heading at
`openspec/specs/catalog-and-parse/spec.md:1894`. The same error was reproduced from
the pre-edit HEAD version in an isolated temporary OpenSpec root during the earlier
default-model check; it was not introduced by the SMT delta or Sol model policy.

**Action:** correct the canonical non-requirement heading/scenario structure and
rerun strict spec validation separately from change validation. Do not treat the
green active-change validator as a green repository-wide spec validation result.

## Requirement-to-Implementation Map

Every requirement has implementation evidence; this table does not override the
boundary counterexamples above or assert exhaustive behavioral correctness.
The existing verification map supplies the detailed test-path inventory.

| Requirement | Primary implementation evidence | Representative checks |
| --- | --- | --- |
| CAT-PARSE-EARS | `parser/ears.ts:46–94`, `parser/spec.ts:28–80` | ears-surface, parser, merge contracts |
| CAT-STATEMENT-SPANS | `parser/source.ts:51–78`, `parser/surface-block.ts:37–79` | surface properties, CRLF/fence contracts |
| CAT-FORMAL-DISPOSITION | `parser/surface-block.ts:49–77` | alternative/example/metadata cases |
| CGC-NORMALIZE-CLAIMS | `claim-graph.ts:159`, requirement/scenario builders | surface-claims; W1 transport boundary |
| CGC-OBLIGATION-LEVEL | `claim-graph.ts:447–458`, `predicate-lowering.ts` | modal/parser/independent oracle cases |
| CGC-FORMAL-SCOPE | `formal/grouping.ts:208`, claim surface metadata | admission/source identity histories |
| FLA-FORMALIZE-CLAIMS | `formal/source-formalize.ts:57–149` | predicate/characterization/CLI histories; W1 |
| FLA-VALIDATE-SAMPLE | `formal/predicate-lowering.ts:89`, `formal/expressions.ts:24` | typed expressions, rational/slot rejection |
| FLA-SMTLIB-COMPILE | `formal/expression-render.ts`, `formal/typed-smtlib.ts:20` | renderer properties and real Z3; W4 |
| FLA-SPEC-COMBINE | `formal/signature.ts:39`, `formal/smtlib.ts`, typed group compiler | declaration/identity/conflict contracts |
| FLA-CLUSTER-AMBIG | `formal/typed-clustering.ts:24–74` | nonvacuity/unknown/quality selection; W2 |
| FLA-RUN-LOGIC | `formal/static-analysis.ts:26–103` | static query/oracle/CLI integration |
| FLA-PAIRWISE | `formal/static-analysis.ts:107–131` | dependency/core/pair-prefix/budget cases |
| FLA-COMPLETENESS | `formal/static-analysis.ts:142–159` | family scope, unrelated invariants, witnesses |
| FLA-SOLVER-PERSIST | `formal/query-executor.ts`, `formal/static-context.ts` | evidence/capture/fault histories; C1 missing branch |
| FLA-ATTACH-PROMPT | `adapters/predicate-formalization.ts`, source `perform` | predicate-slot/hash/context cases |
| FLA-CONCEPT-FREEZE | `formal/concept-discovery.ts:35`, `formal/concepts.ts:126` | registry/permutation/immutability histories |
| FLA-PREMISE-AUTHORITY | `formal/concepts.ts:85–180` | inferred assumptions/explicit authority/enums |
| FLA-TYPED-FRAGMENT | `formal/expressions.ts`, `formal/fragment.ts:29` | sort-directed/exact-unit/UF/unsupported cases |
| FLA-MODAL-TRACKS | `formal/static-analysis.ts`, `formal/predicate-lowering.ts` | modality oracle and paired impact corpus |
| FLA-RULE-ACTIVATION | `formal/static-analysis.ts:85–103` | guarded/self/three-rule core tests |
| FLA-SCENARIO-MEANING | `formal/predicate-lowering.ts`, `formal/static-analysis.ts:134` | JSON semantic fixtures and example queries |
| FLA-ANALYSIS-BOUNDS | config/kernel/executor admission boundaries | count/concurrency/limit tests; C1 missing branch |
| MCA-MERGE-PROVEN | `parser/merge.ts:24`, claim/statement payload propagation | source-claims/merge properties |
| MCA-CONCEPT-ACTIVE | selected merged claim preparation in source formalization | replacement/removal/discovery fixtures |
| RAE-FORMAL-ATTEMPT-SETS | `reporting/formalization-evidence.ts:58`, source `perform` | ordinal namespaces/raw-response pointers |
| RAE-SEMANTIC-EVIDENCE | `formal/evidence.ts`, CLI identity/inventory | exact-byte/hash/manifest tests; C1/W3 |
| RAE-FORMAL-STRENGTH | `query-executor.ts:44`, `run-cli.ts:249–257` | scope/strength/failure qualification; C1/W2 |
| RAE-EVIDENCE-ADMISSION | evidence reservations and core reconciliation | timeout/write/capacity/manifest histories; C1 |
| RAE-SEMANTIC-VERIFY | oracle/property/model suites and impact experiment | fresh 1,128-test suite and retained measurements |
| STC-GEN-FORMAL | `code-backwards/gen-formal.ts:77–194` | generated parser/modality/failure tests |
| STC-CROSS-IMPLY | `code-backwards/semantic-comparison.ts:30–155` | compatibility/nonvacuity/direction cases; C1/W2 |
| STC-BLIND-COMPARE | `derive.ts:121–132`, typed coordinator explanation | isolation/terminal qualification cases; W3 evidence |
| STC-CONCEPT-ALIGNMENT | `code-backwards/alignment.ts:28`, comparison map persistence | renamed meanings/unit/assumption/partial tests |
| STC-PERMISSION-RELATION | `semantic-comparison.ts:46–90` | equivalent/broader/narrower/different/absent cases |

Paths abbreviated to `src/domain/` except explicitly prefixed `adapters/` and CLI
paths. Source-generated request metadata, uncertainty propagation and source-only
execution require additional regressions identified above; an exercised trace ID
does not establish coverage of these combinations.

## Coherence and Scope Notes

- Strict source parsing, frozen registries, explicit premise authority, typed ASTs,
  modal separation, exact rational/unit handling, primary/auxiliary outcome separation
  and manifest-before-optional-report ordering are implemented and strongly tested.
- Attached singleton/recovery requests, deterministic serial admission and the
  configured-unit representation boundary are documented implementation choices,
  not newly discovered deviations.
- Stronger outcome unions/read-only views, Result-style capacity refusal and pending
  queue/cancellation ownership are already explicitly tracked as separate follow-ups
  in align_plan.md. They were not counted as incomplete implementation tasks here.
- Temporal BMC, unrestricted theories and external ontology import are explicit
  non-goals, not missing requirements.
- No fresh paid-provider benchmark was run; prior measurement copies/checksums were
  checked instead. Three opt-in provider/server tests remain skipped by the standard
  suite. No Windows-specific OS guarantees or unbounded model proof is claimed.

## Final Assessment

**1 critical issue found. Fix C1 before archiving.** Four warnings should also be
resolved or explicitly reconciled with the artifacts, with focused counterexample
regressions. Checked task completion, green trace coverage and a passing full suite
do not establish readiness while a valid CLI path executes unrecorded, over-budget
solver work and publishes a completion manifest.
