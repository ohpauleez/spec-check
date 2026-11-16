# Verification Evidence

## Verification Boundary Remediation — 2026-11-15

The user authorized the five confirmed repairs after a second fresh source-based
analysis. C1 and W1–W4 in `implementation-verification.md` are historical findings;
the current implementation contains their repairs and focused regressions.

### Direct dependability evidence

| Claim | Evidence |
| --- | --- |
| Generated-only checks retain run ownership | Actual compiled and bundled CLI tests observe real Z3 separately from the ledger: one configured script, one execution, one recorded exact input; remaining work is skipped scope. Empty generation runs no queries. |
| Source subject reaches the interpreter | Explicit server/client concepts and opaque IDs produce different requests when subjects swap; batch/recovery/additional requests preserve subject/form and one registry hash. |
| Unstable samples earn no unqualified matching credit | Real-Z3 either-side ambiguity tests preserve warning-scoped selected-sample relations and assessments, with no matched cross-implication. A mandatory permission baseline propagates its unstable assessment independently of mapped scope. |
| Generation identifies the actual independent input | Private source copies retain captured bytes across original-file edits, caller-buffer mutation and retries. Different code bytes change request identity even for identical model replies. Raw/classified attempts survive complete failure. |
| Evidence admission precedes new work | Selection/comparison metadata is reserved before solver work. Generation input refusal starts no model attempt; required generation-input persistence failure is CLI OutputError and leaves no manifest. |
| Mapping comments preserve inspectability without changing semantics | Typed constants/functions/enums with Unicode, CR/LF and command-looking names retain reversible JSON mapping comments; real Z3 still returns SAT. Exact script/cache fixtures include the comments explicitly. |

Focused checks are mapped in `verification-map.md` and the JSON boundary-remediation
index. The completed full suite in `/tmp/opencode/remediation-check-final.log`
passed **1,153 tests in 127 files**, with three existing opt-in skips in two files.
It includes strict TypeScript/ESLint, complete canonical trace accounting, real-Z3
properties/integration, compiled/bundled parity and wired-in model checks. The last
adapter-owned-buffer hardening additionally passed its focused source-generation
suite (`/tmp/opencode/remediation-owned-bytes.log`) and the repeated full acceptance
in `/tmp/opencode/remediation-acceptance.log` also passed 1,153 tests.

Final fingerprint review added modular source-backed coordinator and generated-
logic code to runtime identity, so changing routing alone changes the recorded
contract hash. After that identity-only adjustment, strict TypeScript/ESLint and
`make dist` passed, followed by the new routing-mutation identity regression and
all three compiled/bundled generated-only CLI cases (four tests total) in
`/tmp/opencode/remediation-identity-parity-final.log`. This focused final verification
does not represent the earlier 1,153-test run as having included the added test.

Final bundle SHA-256:
`62b02696f18c64cedd7e2980bce1e4076b66ff92bb3a69b3151ab923c45e5bfb`.
Compiled CLI entry SHA-256:
`d7150916745923528410d34c38320256ed0d2b88bc50e85703cdfe749099c831`.
These identify the rebuilt remediation artifacts, not the prior Terra impact
measurement. All 79 implementation/audit tasks are checked. Strict active-change
validation and `git diff --check` pass; no commit or archive was performed.

### Bounded models and snapshot provenance

- Lifecycle rerun: five positive witnesses; no counterexamples to twelve assertions
  at the declared step/atom bounds. Receipt:
  `/tmp/opencode/remediation-lifecycle-final/receipt.json`.
- Boundary-remediation model: three positive witnesses and no counterexamples to
  four assertions (four-atom upper scope, 4/8/10-step commands; generated-only
  witness uses exactly one allowance token). Receipt:
  `/tmp/opencode/remediation-boundary-final/receipt.json`.
- Finite static model: existing three witnesses/four assertions pass in the suite.
- Lifecycle SHA-256:
  `bd40b9a01a8347b3a38ee0fb09d665e993a8cb8c8d82aaf4913b0b4e8e1df292`.
- Boundary model SHA-256:
  `af206dc0ebe2af730bd1b49913ae7c781966546ab5aadad79681d06a1e9f1ac9`.
- Finite static model SHA-256:
  `1737c500e1dd31f01a126f690539e0eb56a4fe65ffe186d7413cdb8f9c34bd0b`.
- Original sixteen pre-refactor snapshots moved without content edits to
  `verification-evidence/pre-remediation-characterization.snap`, SHA-256
  `1474bb2e5b75ca918b98036973d5173dd3ff3caea6f4ac9005bfcf0693ed12fb`.
- Current sixteen snapshots explicitly include actor context/mapping comments,
  preserving call counts, query order and evidence accounting; SHA-256
  `3df0dbe44ed5dac7851c66638de362a41c1e84b95c33c2e81b49569a0ec29998`.

Models check their abstractions, not production refinement, filesystem atomicity,
unbounded execution or natural-language fidelity. No paid-provider experiment was
repeated, and prior Terra impact measurements remain historical snapshots.

### Accepted canonical validation exception

`openspec validate improve-ears-smt-analysis --strict` passes. Canonical
`catalog-and-parse` strict validation still reports
`requirements.15.scenarios: Requirement must have at least one scenario`.
The user explicitly requires `### State machine and invariant checks` to remain
level three. Its pre-existing error is retained as an accepted exception, not
represented as a passing canonical check. Recorded output:
`/tmp/opencode/remediation-canonical-exception.json`.

## Paired SMT Impact Experiment — 2026-11-15

The requested previous-stable comparison is implemented and measured; this is
separate from the earlier single-corpus evaluation and CPU microbenchmarks.

- Protocol: [experiment README](../../../../experiments/smt-impact/README.md).
- Conclusions/trade-offs: [RESULTS.md](../../../../experiments/smt-impact/RESULTS.md).
- Exact identities/metrics/digests: [measurement.json](../../../../experiments/smt-impact/measurement.json).
- Previous stable bytes: `pasture/spec-check.older`, SHA-256
  `12fe9a3ffb3be5469eea30cda295c14b036a801836d22d5d03647977621a6730`.
- Measured current bundle: SHA-256
  `88ad9e6413aef62cbefdbde9801b043dc42b7e87422eb17f5980d39aa9dd3b66`.
- Runtime: Node 22.23.2, Z3 4.8.12, OpenCode 2.0.15; live model
  `github-copilot/gpt-5.6-terra#high` in both arms.

Verified measurement commands:

```sh
make dist
node dist/build/smt-impact.js --mode controlled --output /tmp/opencode/smt-impact-controlled-verified
node dist/build/smt-impact.js --mode live --output /tmp/opencode/smt-impact-live-verified
```

The primary mechanism comparison fixes semantic interpretations and runs both
unmodified CLI binaries with real Z3. An independent exhaustive Boolean oracle
imports no production semantics. The live subset uses each CLI's own prompts and
discovery/formalization with identical model/input/budget controls. Qualitative
reviews and optional narrative are excluded equally; scored output is core static
diagnosis and evidence. Opaque source IDs/paths omit defect/control labels.

The 64 controlled runs and 24 live runs retain all selected outcomes. Repetitions
are averaged within cases, not treated as independent samples. Fourteen shared-
source controlled cases improved positive recall from 14.3% to 100%, clean-control
success from 85.7% to 100%, and exact useful diagnosis from 50% to 100%. The six-case
live subset improved positive recall from 0% to 100% while both arms retained 100%
clean-control success and assessed completion. Two context-enabled controlled
cases demonstrate scoped coverage separately, not equal-context engine superiority.

The predeclared practical criterion is met on this corpus. Real trade-offs include
live mean core latency 3.649 → 8.892 seconds, model calls 1 → 2 and actual solver
scripts 1.17 → 8.67 per run. Most model attempts omitted usage events; total token/
monetary comparisons are unavailable, not zero. Hand-selected diagnostic cases do
not establish population precision/recall, temporal correctness, source-backed
comparison quality or human prose actionability. Review packets are unscored.

Every collected artifact checksum was verified. Requests, native responses, actual
solver inputs/outputs/status and both core bundles are retained under the verified
directories. The exact pre-run protocol bytes match their recorded digest. Later
review-label/context publication corrections left primary result/report bytes
unchanged. A scorer clarification affects no acquired observation; re-scoring all
88 verified runs reproduces every stored score. Dedicated provenance files retain
these publication boundaries. Initial pilot/preliminary batches remain separate,
not silently discarded or pooled to inflate sample size.

Acceptance: `make check` passed **1,127 tests across 124 passing files**, with three
existing opt-in skips in two files. Includes strict TypeScript/ESLint, full trace
coverage, independent experiment oracle/scorer checks, actual old/current CLI runs
with real Z3, and fake-provider timeout tests preserving exact partial bytes.
Disposable log: `/tmp/opencode/smt-impact-release-check.log`.

## TypeScript Guideline Remediation Acceptance

Implementation scope: WS0–WS4 of [`align_plan.md`](../../../../align_plan.md), addressing
the verified `align_report.md` findings against `docs/typescript_style.md`.
The original implementation and subsequent correctness-enhancement acceptance
records below remain historical; their provider and CPU measurements were not
rerun or repurposed as measurements of this refactor.

### Characterize before extraction

Before production changes, `alignment-characterization.test.ts` captured sixteen
static/source histories. Checked-in snapshots retain SHA-256 digests of complete
deterministic scripts/order, ledger entries, findings, model contexts/feedback,
evidence paths/payloads, candidate/error outputs and terminal failures, alongside
readable query-order/count summaries. Scenarios cover success, inconsistent and
conflicting premises, unknown/timeout, pair/script/evidence limits, all-invalid
samples, recovery, shortfalls and required-write failures. Expectations were
captured before the refactor and not regenerated afterward; all sixteen still match.
This is bounded regression evidence, not proof for all programs or LLM fidelity.

### Structural and contract changes

- `static-analysis.ts` preserves the visible phase sequence and shared preparation.
  `static-context.ts` centralizes query, attribution, witness and prerequisite-scope
  mechanics while results remain a separate invocation-owned writer. B/C node
  identities are preserved, not replaced with rendered-text aliases.
- `source-formalize.ts` separates group discovery, physical batches, initial entry
  handling, bounded claim recovery and validation/acceptance publication. Source
  preparation lifetime, retry budget, capacity catch boundary and candidate-retention
  rules are unchanged; required evidence still precedes candidate publication.
- Function/rational operands use locally checked values. Semantic comparison
  collects all rebound expressions or reports unmapped rather than filtering missing
  nodes. Broken joint-name maps now raise an explicit invariant, and public lowering
  without parsed source returns a validation error. These are intentional diagnostics
  for malformed inputs, with valid-input query/evidence behavior preserved.
- Pair-counter effects leave conditional expressions without changing the existing
  candidate prefix or skip threshold. Named constants replace embedded operational
  limits; module runtime identity includes the extracted context implementation.
- Touched API contracts document failures, ownership, bounds and examples. Parser
  assertions explain their structural justification. Budget-key fallback and pattern
  precedence are explicit. `formal-style.test.ts` checks the 70-line function and
  500-line file targets in touched production modules; it checks the coding guide,
  not an invented canonical behavior, so it has no fabricated trace tags.

### Additional verification

- `generated-expressions.property.test.ts` and its independent support module
  generate bounded sort-directed descriptions with valid shrinking. Source syntax
  validates as Bool/Int/Real/enum. Real-Z3 results agree with independent exact
  fraction/Boolean/enum evaluation, including bijective adversarial identifier,
  enum and function-name renaming. SAT tautologies and UNSAT contradictions prevent
  vacuous all-SAT rename coverage. Solver properties stop on first failure to keep
  the call ceiling explicit; typed UF and exact unit/coercion fixtures supplement
  generated trees. Literal-only canonical rendering does not assume solver text
  inverts source names or unit annotations.
- Rational-literal regressions pin symbolic, Real-operand, unit-bearing and zero-
  denominator rejection without falsely labeling all general division nonlinear.
  Numeric witness tests retain exact supported negative-zero and zero-rational forms.
- `query-timeout-history.test.ts` uses deferred completions, no sleeps. It verifies
  at-most-once solver calls, timeout slot release, queued progress, exact partial
  output survival, artifact publication, and reservation release after later output
  failure independently of the ledger's own summarizer.
- Optimization history tests now declare canonical trace identifiers matching the
  actual discovery, evidence-admission, identity and failure properties verified.

### Final acceptance

```sh
make check
openspec validate improve-ears-smt-analysis --strict
git diff --check
```

All passed. The full check executed **1,118 passing tests across 121 passing files**,
with three existing opt-in skips in two files. Includes strict TypeScript/ESLint,
complete canonical trace coverage, real-Z3 semantic checks, bounded Alloy checks
already wired into the suite and compiled/bundled external-process CLI parity.
Disposable full log: `/tmp/opencode/align-check.log`.

### Explicitly separate follow-ups

This work does not claim complete style-guide compliance. Section 7 of align_plan.md
tracks stronger discriminated outcome/status types, read-only views over writer-
owned state, Result-style evidence-admission refusal, and bounded pending queues/
backpressure/cancellation semantics. Those are API/ownership design changes, not
hidden incidental refactors. No solver concurrency, cached result reuse, numeric
version, live-provider evaluation, commit or archive change was introduced here.

## Correctness Enhancement Acceptance — 2026-11-15

The follow-up implementation of [`enhance_plan.md`](../../../../enhance_plan.md)
supersedes the affected decoder, limit, scope and completion-boundary behavior in
earlier snapshots. Earlier provider/optimization measurements remain historical;
no new live-provider performance or accuracy measurement is claimed.

### Implemented contracts and decisions

- `formal/solver-verdict.ts` is shared by the adapter and decoder. Only one exact
  standalone top-level verdict can classify the response; LF/CRLF and surrounding
  whitespace are supported without modifying raw output. Quoted/comment/list
  verdict text, absent/multiple verdicts, malformed framing and error responses
  cannot produce decoded assignments.
- `ModelValueDecoder` checks exact scalar sorts, requested symbol identities and
  duplicate bindings. Complete/partial/unavailable refer to the explicit requested
  set. Partial values remain auditable but do not become complete witness evidence;
  raw stdout and primary SAT/UNSAT outcomes remain preserved independently.
- `core-artifacts.ts` reconciles the complete semantic evidence tree with recorder
  checksums before initial manifest publication and every warning-driven refresh.
  Missing, changed, unexpected, temporary, symlink and unsupported artifacts fail
  closed. Manifest paths are unique and original recorder phases remain authoritative.
  Report, enumeration and manifest publication failures map to OutputError exit 11.
- Executed outcomes and unissued scope are separate. UNSAT sample premises are
  inconsistent, unknown/timeout/error premises inconclusive, and admission-skipped
  premises unassessed. `plannedQueries = executedQueries + blockedQueries +
  skippedQueries`; `executedQueries = satQueries + unsatQueries +
  inconclusiveQueries`. `unestablishedQueries` explicitly aggregates all three
  nondefinitive scope categories. Compact unissued entries retain multiplicities.
- Effective expression byte/node/depth limits apply uniformly to foreground,
  background and coverage. Registry preparation caches also key on the limit tuple;
  permissive cached results cannot bypass restrictive limits.
- Pair budgets remain candidate-examination allowances after dependency filtering,
  before guard/co-activation outcomes. Known-infeasible candidates retain their charge.
  This deliberately avoids the review's proposed redefinition as a conflict-query
  quota. Advisory omissions and dependent mandatory/equivalence plans now retain
  explicit blocked/skipped reasons without allocating one record per omitted pair.
- Normalized statement-edge whitespace, B/C object-identity provenance and shared
  executor composition are documented. The candidate-retention assertion uses the
  invariant helper; unexpected invariant errors remain PipelineError exit 10.
- Textual alignment remains trimmed-lowercase definition matching plus checked
  role/sort/unit/signature compatibility and ambiguity handling. No Unicode NFKC/
  casefold broadening or unmeasured byte ceiling is added. README/design describe
  the caller-owned single-writer output-directory and configured-executable trust
  boundaries; lexical atomic output is not claimed to be hostile-directory safe.

### Verification

Commands:

```sh
make check
openspec validate improve-ears-smt-analysis --strict
git diff --check
```

All passed. `make check` executed 1,071 passing tests across 117 passing files,
with three existing opt-in skips in two files, complete canonical trace coverage,
strict TypeScript/ESLint, real-Z3 integration and compiled/bundled CLI parity.
Full output: `/tmp/opencode/enhance-final-check.log` (disposable local log).

New/extended coverage includes:

- `solver-decoding.test.ts`: LF/CRLF, whitespace, misleading diagnostic/quoted
  verdicts, UNSAT/unknown/missing/multiple verdicts, duplicate/unexpected bindings,
  malformed numeric/enum/Boolean values, partial requested scope, raw-byte-preserving
  auxiliary evidence and unchanged primary result strength.
- `semantic-reconciliation.test.ts`: checksum/phase retention, missing/changed/
  unexpected/temporary files, directory substitution, artifact/tree symlinks, FIFO
  rejection, duplicate descriptors, path aliases and missing trees.
- `query-scope.test.ts`, `static-queries.test.ts`, `semantic-clustering.test.ts`:
  disjoint/weighted counts, candidate-prefix budget behavior, infeasible and
  unestablished co-activation, unknown/timeout/error/skipped premises and composed
  shared-executor actual-script accounting.
- `formal-preparation.test.ts`: exact background/coverage byte/node/depth boundaries
  and alternating restrictive/permissive reuse of the same prepared registry.
- `ears-surface.test.ts`: normalized whitespace and unchanged original response/end
  offsets under CRLF.
- `semantic-pipeline.integration.test.ts`: required output failure categories and
  no new completion marker for missing/changed/stray evidence, enumeration and
  manifest-write failures; unexpected semantic files during optional-report refresh
  invalidate the earlier marker and prevent replacement.

No Alloy transition/property abstraction was changed by these enhancements; prior
bounded model results remain scoped to their recorded models, not a proof of the
new protocol/filesystem implementation. OpenSpec scenarios retain their canonical
identifiers and add explicit postconditions for these changed expectations.

## Scope

The proposal-stage sections below are historical. Original implementation acceptance
and measured corpus results follow them; the latest correctness-enhancement acceptance
appears first in this document.

## OpenSpec Artifact Validation

Command:

```sh
openspec validate improve-ears-smt-analysis --strict
```

Result: `Change 'improve-ears-smt-analysis' is valid`.

The validator initially identified omitted `Requirement model` subsections in replaced requirement blocks. The completed deltas preserve those subsections and explicitly link the replacement abstraction and the independent verification needed beyond it. Existing behavioral scenario headings are retained, including cases whose old semantics are intentionally corrected.

Artifact inventory at proposal completion:

- `proposal.md`: motivation, scope, conceptual domain, invariants, failure modes, and affected capabilities.
- `design.md`: architecture, grammar, configuration, semantic/query contracts, resource bounds, interfaces, failure/recovery, rollout, and verification.
- Six capability delta specs, with 34 requirements and 165 behavioral scenarios.
- `tasks.md`: 63 unchecked implementation tasks with section-level audit-summary locations.
- `models/analysis-lifecycle.als`: bounded analyzer-control model.

A local structural check found no missing relative link targets or duplicate identifiers within the change's delta specs. All requirement/scenario headings have canonical identifiers.

## Alloy Model

Model: [analysis-lifecycle.als](models/analysis-lifecycle.als).

Model SHA-256:

```text
d8ca76d5d54605c93bfe767165aa357aab3d00d105a1e0d88da004ebc99cfce1
```

Tool: repository `tooling/alloy_v6.2.0.jar`, Alloy `6.2.0`, solver `sat4j`.

Executed command:

```sh
java -jar tooling/alloy_v6.2.0.jar exec -c '*' -t none \
  -o /tmp/opencode/ears-smt-analysis-alloy-ses-e2b434-final \
  openspec/changes/improve-ears-smt-analysis/models/analysis-lifecycle.als
```

The output directory is disposable analyzer output, not a required project artifact. Reproduction should use a fresh output directory or the analyzer's explicit force option for a disposable prior result directory.

### Positive Runs

| Command | Scope / bound | Result |
| --- | --- | --- |
| `CompletedWithEvidence` | Overall 4, up to 1 Query and 1 Concept, up to 12 steps | Instance found |
| `UncertainQueryIsRecorded` | Overall 3, up to 1 Query and 1 Concept, up to 10 steps | Instance found |
| `FailedRunMayKeepPartialEvidence` | Overall 3, up to 1 Query and 1 Concept, up to 10 steps | Instance found |

### Assertions

All assertions used overall scope 4 and up to 12 steps.

| Assertion | Result |
| --- | --- |
| `FrozenRegistryNeverChanges` | No counterexample within bounds |
| `ExcludedClaimsNeverEnterAnalysis` | No counterexample within bounds |
| `TerminalOutcomesAreDisjoint` | No counterexample within bounds |
| `QueriesRequireAdmission` | No counterexample within bounds |
| `FavorableOutcomesAreNonvacuous` | No counterexample within bounds |
| `CompletionRequiresEvidence` | No counterexample within bounds |
| `MandatoryBaselineExcludesOtherModes` | No counterexample within bounds |
| `EligibleTotalFailureCannotComplete` | No counterexample within bounds |
| `CandidatesAreNeverRevoked` | No counterexample within bounds |

### Interpretation Boundary

The model abstracts typed/compatible queries, premise satisfiability, and solver verdicts as boundary facts. Its `favorable` set models a published entailment-style result, not every possible SAT witness or report conclusion. It checks analyzer admission, immutability, partitioning, nonvacuous publication, and evidence ordering under those abstractions.

It does not establish expression/type-checker soundness, correct English parsing, concept identity, assumption fidelity, static formula correctness, blind prompt isolation, byte preservation, or production filesystem behavior. Those require the independent finite-domain evaluator, real-Z3 fixtures, boundary/fault-injection tests, and implementation evidence listed in `tasks.md`.

These are bounded model-checking results, not an unbounded or whole-system correctness proof. No fairness or unconditional eventual-completion property is claimed; stuttering and failure are permitted.

## Implementation Acceptance Still Required

Implementation must execute the task-list acceptance checks, including `make check`, real-Z3 semantic integration, production-boundary fault injection, compiled/bundled parity, affected capability model checks, and fixed-corpus cost/latency/coverage evaluation. Proposal validation and the lifecycle model do not substitute for those checks.

## Task 1.2: Reviewed Lifecycle Refinement

The proposal-stage record above is historical. The current model extends it with:

- Group-scoped background queries without claim owners.
- Explicit issued, raw-evidence-captured, and resolved attempts.
- Candidate registry snapshots and a check that they equal the frozen registry.
- Terminal rejected attempts versus nonterminal retry failures.
- Additional rejected samples preserving an existing candidate.
- Completion waiting for issued attempts to be captured and resolved.

Current model SHA-256: `bd40b9a01a8347b3a38ee0fb09d665e993a8cb8c8d82aaf4913b0b4e8e1df292`.

Executed with Alloy 6.2.0 / SAT4J:

```sh
java -jar tooling/alloy_v6.2.0.jar exec -c '*' -t none \
  -o /tmp/opencode/ears-smt-apply-lifecycle-checked \
  openspec/changes/improve-ears-smt-analysis/models/analysis-lifecycle.als
```

All five witness runs found instances: `CompletedWithEvidence`, `UncertainQueryIsRecorded`, `FailedRunMayKeepPartialEvidence`, `GroupScopedBackgroundQuery`, and `AdditionalSampleFailure`. The completed-work witness now exercises a nonempty discovered registry. Witness bounds are declared in the model; additional-sample failure uses 16 steps, the remaining witnesses at most 12.

The nine original assertions and three added assertions (`SampleOutcomesRequireRawEvidence`, `SamplesUseTheFrozenRegistry`, `AdditionalFailurePreservesCandidate`) had no counterexamples within overall scope 4 and at most 12 steps, except the additional-failure assertion checked through 16 steps.

Attempt acceptance, terminality, signature typing, compatibility, and solver outcomes remain abstract boundary inputs. The model does not establish LLM fidelity, exact byte persistence, or production refinement correctness. These remain independent implementation acceptance obligations.

## Final Implementation Acceptance

### Executable Checks

```sh
make check
openspec validate improve-ears-smt-analysis --strict
```

The final semantic release check (`/tmp/opencode/ears-smt-release-final.log`) passed:

- TypeScript build, bundled distribution, strict TypeScript and ESLint.
- 1,009 passing tests across 112 passing files; three opt-in tests in two files skipped.
- All canonical trace coverage, including 206 tagged headers in these deltas.
- Real-Z3 finite-valuation differential queries, exact arithmetic/unit fixtures,
  guarded/self/multi-rule activation, modal tracks, scenarios, scoped witnesses,
  nonvacuous clustering and permission alignment.
- Captured invalid/overflow/rejected model output, required-write failures,
  capacity-limited work, stale rerun cleanup and optional-report failure histories.
- Compiled/bundled CLI runs against external fake OpenCode v1 and v2 processes,
  including all generated artifacts and manifest checksum parity.

The skipped files are `test/contract/opencode.live.test.ts` and
`test/integration/opencode-server-exclusion.integration.test.ts`; real model
formalization was measured separately below. These opt-in skips are not solver
integration skips.

The inventory scan confirms 35 requirements and 171 scenarios, all identifiers
unique, each mapped to its enclosing requirement, each referenced check file
present, and all delta relative file links valid.

### Bounded Model Reruns

Lifecycle command:

```sh
java -jar tooling/alloy_v6.2.0.jar exec -c '*' -t none \
  -o /tmp/opencode/ears-smt-release-lifecycle \
  openspec/changes/improve-ears-smt-analysis/models/analysis-lifecycle.als
```

All five positive runs found witnesses and twelve assertions had no counterexample
within their declared scopes. Current hash:
`bd40b9a01a8347b3a38ee0fb09d665e993a8cb8c8d82aaf4913b0b4e8e1df292`.

The replacement finite valuation model was executed independently and is also
checked by `test/contract/semantic-models.test.ts` in the full suite:

```sh
java -jar tooling/alloy_v6.2.0.jar exec -c '*' -t none \
  -o /tmp/opencode/ears-smt-static-contract-model-checked \
  openspec/changes/improve-ears-smt-analysis/models/static-semantics.als
```

Current hash: `1737c500e1dd31f01a126f690539e0eb56a4fe65ffe186d7413cdb8f9c34bd0b`.
Exactly eight Boolean valuations are modeled. The three witnesses demonstrate a
globally satisfiable activation conflict, a three-rule conflict with every response
pair compatible, and a broader generated permission relation. Four assertions had
no counterexamples within the declared finite rule scopes. No assertion is added
as an action fact, and no unbounded correctness or production refinement is claimed.

### Measured Real-Model Corpus

Command (after building the evaluated bundle):

```sh
SPEC_CHECK_TELEMETRY=1 node dist/spec-check.js \
  --config test/fixtures/ears-to-logic/evaluation/config.json \
  --output /tmp/opencode/ears-smt-live-evaluation-revised \
  --timeout-ms 60000 \
  test/fixtures/ears-to-logic/evaluation/specs/evaluation/spec.md
```

[`evaluation.json`](evaluation.json) binds the corpus, prompts, model/runtime,
configuration and evaluated bundle to content hashes. OpenCode 2.0.15 used
`github-copilot/gpt-5.6-terra#high`; Z3 was 4.8.12.

- Four extracted/eligible statements produced four accepted candidates.
- 37 actual solver scripts: 17 SAT, 20 UNSAT, zero skipped/inconclusive.
- Global SAT coexists with the intended activation conflict; sufficient cores
  identify `EVAL-ACCEPT` and `EVAL-REJECT`.
- Core elapsed 45.612 seconds, including 14.285 seconds for discovery/formalization
  and 0.756 seconds for solver analysis.
- Discovery's reported usage: 7,402 input, 147 output and 232 reasoning tokens;
  reported cost 0.019352. Usage metadata is incomplete and is not treated as a
  complete billing/total-token record.
- Every completed manifest artifact checksum matched.
- Optional final assessment failed after bounded retries (180.867 seconds);
  refreshed core reports/manifest remained intact and report.md was absent.
  The command exited 1 because findings were present, not because core analysis
  aborted.

The first prompt run accepted no samples because its response-only example caused
the model to omit source trigger slots. Those attempts were rejected with raw
evidence, ending in exit 9 and no completion manifest. The corrected all-slot
example and validation feedback improved coverage **and** reproduced the intended
semantic defect; no schema/type validation was relaxed. One small corpus and one
run per prompt do not establish broad translation accuracy or production cost.
The measured bundle hash denotes that snapshot; subsequent bounded-evidence and
scope refinements are covered by the final executable release check, not falsely
represented as another provider measurement.

### Implementation Choices And Handoff

- The user resolved permission comparison as separate equivalent/broader/narrower/
  different allowed valuation relations. Missing permission remains unmapped, and
  permission differences qualify aggregate alignment.
- Source singleton/recovery calls use the private attached-context path, sharing
  the frozen registry and predicate wire schema with physical batches. This replaces
  the planned inline optimization without a second source analysis profile.
- Typed CLI work is admitted in fixed order so evidence-capacity outcomes are
  deterministic. A shared semaphore also caps direct concurrent solver callers.
  The configured concurrency is a ceiling, not a saturation promise.
- Unit annotations lower only explicit exact same-dimension scales; cross-side
  differing scalar representations remain incompatible rather than inventing an
  integer-lattice projection.
- Raw-domain fixture/compiler boundaries remain available for existing defensive
  tests. Parser-produced original/generated CLI sources use the typed engine and
  cannot select an older assertion-producing profile.
- Unquoted explicit duration/temporal operators are conservative admission
  limitations. The gate is not a complete temporal English classifier. Other
  unsupported predicate meaning remains an interpretation/validation obligation.
- Model-proposed identities and all SMT conclusions remain conditional on recorded
  interpretation and explicit premises. Static valuations do not prove reachability,
  all-input realizability, natural-language intent fidelity, or temporal guarantees.
- Current numeric versions and existing user edits are preserved. No archive or
  commit is performed by implementation completion.
