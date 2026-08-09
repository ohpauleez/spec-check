---
title: FormalizationAndLogicAnalysis
---

## Purpose

Define the formalization and solver-backed logic analysis behavior for the spec-check tool: translating claims into formal artifacts, clustering alternate interpretations, and using solver-backed analysis to detect conflicts, gaps, and surprising behaviors.

```alloy
module FormalizationAndLogicAnalysis
open util/boolean

// --- Domain vocabulary ---

// A Claim is a requirement or scenario from a spec file. `claimId` is the
// sanitized claim identity used for compile-group preflight; two claims
// sharing one `claimId` are a duplicate-identity collision [FLA-SPEC-DUPLICATE-CLAIM-ID].
sig Claim {
  obligation : one Obligation,
  spec : one Spec,
  claimId : one ClaimId
}

// Obligation levels (strict total order: Mandatory > Advisory > Informational)
abstract sig Obligation {}
one sig Mandatory, Advisory, Informational extends Obligation {}

// Ordering on obligation levels
fun higherObligation : Obligation -> Obligation {
  Advisory -> Mandatory +
  Informational -> Mandatory +
  Informational -> Advisory
}

fun maxObligation [claims : set Claim] : lone Obligation {
  { o : claims.obligation | no (claims.obligation & o.higherObligation) }
}

// A Spec is a single spec file being analyzed
sig Spec {}

// A Sample is one formalization attempt for a claim
// Validity is an inherent property (determined by schema), not mutable
sig Sample {
  claim : one Claim,
  schemaValid : one Bool      // whether it passes schema validation
}

// An equivalence cluster groups semantically equivalent samples
sig Cluster {
  members : set Sample,
  representative : lone Sample
}

// Implication check result between two samples
sig ImplicationResult {
  from : one Sample,
  to : one Sample,
  result : one SolverResult
}

// Solver result classifications
abstract sig SolverResult {}
one sig Sat, Unsat, Timeout, Unknown, SolverError extends SolverResult {}

// Finding types produced by analysis
abstract sig FindingType {}
one sig Contradiction, ConditionalContradiction, CompletenessGap,
       Ambiguity, Inconclusive, MergeConflict, SolverErrType,
       InvalidGroup extends FindingType {}

// Finding severity levels
abstract sig Severity {}
one sig ErrorSev, WarningSev, InfoSev extends Severity {}

sig Finding {
  findingType : one FindingType,
  severity : one Severity,
  involvedClaims : set Claim
}

// Identifier safety classification for SMT-LIB compilation
abstract sig IdSafety {}
one sig Safe, Unsafe extends IdSafety {}

sig ClaimId {
  safety : one IdSafety
}

// Assertion structure for conditional analysis
abstract sig AssertionKind {}
one sig Conditional, Unconditional extends AssertionKind {}

sig Assertion {
  kind : one AssertionKind,
  sourceClaim : one Claim
}

// Declaration identity (for deduplication and conflict detection)
sig DeclName {}
sig DeclSignature {}
// Symbol type: a sanitized symbol is bound either as a variable
// (declare-const) or a function (declare-fun). This is the declaration
// KIND, distinct from its signature/sort (declSig).
abstract sig DeclKind {}
one sig VarDecl, FunDecl extends DeclKind {}
sig Declaration {
  declName : one DeclName,
  declKind : one DeclKind,
  declSig : one DeclSignature,
  declClaim : one Claim
}

// --- Pipeline phase state ---

abstract sig Phase {}
one sig FormalizationPh, ValidationPh, ClusteringPh, CompilationPh,
       AnalysisPh, ReportingPh, AbortedPh extends Phase {}

one sig Pipeline {
  var phase : one Phase,
  var candidates : set Sample,                // validated samples
  var representatives : Claim -> lone Sample, // selected reps per claim
  var findings : set Finding,                 // accumulated findings
  var evidence : set Spec,                    // specs with persisted evidence
  var attemptEvidence : set PhysicalBatch,    // attached attempts with persisted evidence
  var exitCode : lone Int                     // exit code (2 = abort)
}

// --- Structural facts (non-temporal invariants) ---

// Cluster well-formedness: respects equivalence, representative is a member
fact cluster_wellformed {
  all cl : Cluster | cl.representative in cl.members or no cl.representative
  all disj cl1, cl2 : Cluster | no (cl1.members & cl2.members)
  // A cluster always groups at least one sample (empty clusters are not
  // materialized). Together with pairwise disjointness this makes distinct
  // clusters have distinct member sets.
  all cl : Cluster | some cl.members
}

// Implication results are between distinct samples of the same claim
fact implication_wellformed {
  all ir : ImplicationResult | ir.from != ir.to
  all ir : ImplicationResult | ir.from.claim = ir.to.claim
  // Each ordered (from, to) pair resolves to exactly one solver result:
  // a single query is issued per direction, so a pair cannot simultaneously
  // carry (e.g.) an Unsat and a Timeout result.
  all disj ir1, ir2 : ImplicationResult |
    not (ir1.from = ir2.from and ir1.to = ir2.to)
}

// Equivalence via mutual implication (unsat means entailment holds)
pred samples_equivalent [a, b : Sample] {
  some ir1 : ImplicationResult | ir1.from = a and ir1.to = b and ir1.result = Unsat
  some ir2 : ImplicationResult | ir2.from = b and ir2.to = a and ir2.result = Unsat
}

// Cluster membership respects equivalence
fact clusters_respect_equivalence {
  all disj a, b : Sample, cl : Cluster |
    (samples_equivalent[a, b] and a in cl.members) implies b in cl.members
}

// --- Semantic batching: shared key helper, grouping, physical batches ---
// Structural layer for the semantic-batching requirements [FLA-SEMANTIC-GROUPING,
// FLA-SUBBATCH, FLA-ATTACH-TRANSPORT, FLA-CLAIM-PARTITION, FLA-BATCH-EVIDENCE,
// FLA-TEMP-LIFECYCLE, FLA-DEGRADE-KIND].

// Whether a merged spec has requirements / scenarios.
abstract sig Presence {}
one sig NoneP, SomeP extends Presence {}

sig Capability {}
sig ProvFile {}
sig LogicalFile {}
sig SyntheticKey { cap : one Capability }

// Semantic key space: provenance files, mapped logical files, and synthetic
// fallback keys all inhabit one space.
sig SemanticKey {
  fromProv  : lone ProvFile,
  fromMap   : lone LogicalFile,
  fromSynth : lone SyntheticKey
} {
  one (fromProv + fromMap + fromSynth)
}

// Genuinely universal: key construction is injective across sources and total
// over source values. This is an axiom of the key space, not a pipeline condition.
fact key_sources_injective {
  all disj k1, k2 : SemanticKey |
    k1.fromProv != k2.fromProv
    and k1.fromMap != k2.fromMap
    and k1.fromSynth != k2.fromSynth
  SemanticKey.fromProv = ProvFile
  SemanticKey.fromMap = LogicalFile
  SemanticKey.fromSynth = SyntheticKey
}

// A claim carries zero or one capability and exactly one provenance file.
sig ClaimProvenance {
  claim : one Claim,
  cap : lone Capability,
  provFile : one ProvFile
}

// The logical-file map built by the pipeline: capability -> logical file
// (partial; may be empty).
sig GroupingMap {
  mapping : Capability -> lone LogicalFile
}

// The shared key helper [FLA-SEMGRP-MAPPED/PROVENANCE/FALLBACK].
// Total: every claim gets exactly one key under any map.
fun keyFor [c : Claim, m : GroupingMap] : one SemanticKey {
  { k : SemanticKey |
    some cp : ClaimProvenance | cp.claim = c and
    ((no cp.cap and k.fromProv = cp.provFile)
     or (some cp.cap and some m.mapping[cp.cap]
         and k.fromMap = m.mapping[cp.cap])
     or (some cp.cap and no m.mapping[cp.cap]
         and k.fromSynth.cap = cp.cap))
  }
}

// A logical group: claims partitioned by semantic key.
sig SemanticLogicalGroup {
  groupKey : one SemanticKey,
  groupMembers : set Claim
}

// Genuinely universal: logical groups partition the claim set by key.
fact groups_partition_by_key {
  all g : SemanticLogicalGroup | some g.groupMembers
  all g : SemanticLogicalGroup | all c : g.groupMembers |
    g.groupKey = keyFor[c, GroupingMap]
  all disj g1, g2 : SemanticLogicalGroup | g1.groupKey != g2.groupKey
  all c : Claim | one g : SemanticLogicalGroup | c in g.groupMembers
}

// Adapter terminal error kinds (post adapter-internal retries) [FLA-DEGRADE-KIND].
abstract sig ErrorKind {}
one sig SpawnError, InvalidFiles, InvalidTimeout,       // infrastructure: no per-claim fallback
        TimeoutErr, InvalidJson, SchemaValidation,      // model response: degrade to per-claim retry
        PromptTooLarge                                  // degrade only if inline fallback fits
        extends ErrorKind {}

// Prompt-size pre-check result for prompt_too_large degradation.
abstract sig FallbackFit {}
one sig FallbackFits, FallbackDoesNotFit extends FallbackFit {}

// Temp context directory lifecycle states [FLA-TEMP-LIFECYCLE].
abstract sig TempState {}
one sig NotCreated, DirCreated, FileWritten,
        CleanupSucceeded, CleanupFailed extends TempState {}

// Batch attempt resolution [FLA-BATCH-EVIDENCE outcome classification].
abstract sig Resolution {}
one sig Unresolved, BatchSuccess, ModelFailure,
        InfraFailure, TransportFailure extends Resolution {}

// Per-claim terminal outcome [FLA-CLAIM-PARTITION].
abstract sig Outcome {}
one sig NoOutcome, CandidateOutcome, ClaimErrorOutcome extends Outcome {}

// Whether the batch attaches a context file [FLA-ATTACH-TRANSPORT].
abstract sig AttachedKind {}
one sig Attached, Inline extends AttachedKind {}

abstract sig DegradedKind {}
one sig NotDegraded, Degraded extends DegradedKind {}

// A physical batch: one first-sample attempt over a chunk of one logical group.
sig PhysicalBatch {
  claims            : set Claim,          // non-empty chunk of one logical group
  attached          : one AttachedKind,   // Attached iff two or more claims
  fallbackFits      : one FallbackFit,    // pre-computed inline-fits pre-check
  var tempState     : one TempState,
  var resolution    : one Resolution,
  var degraded      : one DegradedKind,
  var outcomes      : Claim -> one Outcome
}

// Genuinely universal: grouping + sub-batching partition the eligible claim
// set across physical batches [FLA-SEMANTIC-GROUPING, FLA-SUBBATCH].
fact claims_partitioned_across_batches {
  Claim in PhysicalBatch.claims
  all disj b1, b2 : PhysicalBatch | no (b1.claims & b2.claims)
}

// Genuinely universal: a physical batch never spans logical groups
// (sub-batching never changes semantic key) [FLA-SUBBATCH].
fact batches_stay_within_groups {
  all b : PhysicalBatch | one g : SemanticLogicalGroup | b.claims in g.groupMembers
}

// Genuinely universal: transport matches arity — multi-claim physical batches
// attach a context file; single-claim batches stay inline [FLA-ATTACH-TRANSPORT].
fact transport_matches_arity {
  all b : PhysicalBatch |
    (#b.claims >= 2) iff b.attached = Attached
}

// Genuinely universal: only attached batches have a temp context lifecycle;
// inline batches never create temp directories.
fact inline_batches_have_no_temp {
  all b : PhysicalBatch |
    b.attached = Inline implies always b.tempState = NotCreated
}

// --- Structural assertions (conditional claims) ---

// Under the pipeline's grouping construction, every claim is in exactly one
// group (re-stated as an assertion so the check shows it holds whenever the
// grouping conditions are in force).
assert groupingPartitioned {
  all c : Claim | one g : SemanticLogicalGroup | c in g.groupMembers
}

// No key drift: claims with equal keys co-group, so solver and formalization
// (which share the helper) agree [FLA-SEMGRP-PARITY].
assert parityBySharedKey {
  all disj c1, c2 : Claim |
    keyFor[c1, GroupingMap] = keyFor[c2, GroupingMap]
    implies (some g : SemanticLogicalGroup | c1 + c2 in g.groupMembers)
}

// Kind is irrelevant: capability-less claims key by provenance file
// regardless of claim kind [FLA-SEMGRP-KINDS].
assert kindIrrelevant {
  all c : Claim, cp : ClaimProvenance |
    (cp.claim = c and no cp.cap) implies keyFor[c, GroupingMap].fromProv = cp.provFile
}

// Every claim obtains a deterministic key even when its capability is
// unmapped [FLA-SEMGRP-COVERAGE, FLA-SEMGRP-FALLBACK].
assert fallbackTotal {
  all c : Claim | one keyFor[c, GroupingMap]
}

// Grouping-map authority
sig MergedSpec {
  cap : one Capability,
  reqs : one Presence,
  scens : one Presence
}

// Genuinely universal: distinct merged specs have distinct capabilities.
fact capability_unique {
  all disj s1, s2 : MergedSpec | s1.cap != s2.cap
}

// Active for grouping: requirements present OR scenarios present.
fun activeForGrouping : set MergedSpec {
  { s : MergedSpec | s.reqs = SomeP or s.scens = SomeP }
}

// Solver-input activity filter (unchanged): requirements only.
fun activeForSolverInput : set MergedSpec {
  { s : MergedSpec | s.reqs = SomeP }
}

sig BuiltMap {
  entries : Capability -> lone LogicalFile
}

// Conditional domain assumptions, stated as predicates rather than facts.
pred scenariosImplyRequirements {
  all s : MergedSpec | s.scens = SomeP implies s.reqs = SomeP
}

// The map-builder contract: the built map covers exactly the
// active-for-grouping capabilities.
pred mapCoversActiveSpecs [m : BuiltMap] {
  m.entries.LogicalFile = activeForGrouping.cap
}

// The grouping map is never narrower than the solver-input set.
pred groupingMapCoversSolverInputs [m : BuiltMap] {
  activeForSolverInput.cap in m.entries.LogicalFile
}

// Scenario-only specs get map entries.
pred scenarioOnlySpecsMapped [m : BuiltMap] {
  all s : MergedSpec |
    (s.scens = SomeP and s.reqs = NoneP)
    implies s.cap in m.entries.LogicalFile
}

// Empty specs contribute no entries.
pred emptySpecsExcluded [m : BuiltMap] {
  all s : MergedSpec |
    (s.reqs = NoneP and s.scens = NoneP)
    implies s.cap not in m.entries.LogicalFile
}
```

## Requirements

### Requirement: Extract Recoverable JSON Payloads [FLA-JSON-RECOVER]
WHEN an external LLM call returns text that contains a valid JSON payload wrapped in markdown fences or explanatory text, THE spec-check tool SHALL recover the payload deterministically before schema validation.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Make JSON extraction tolerant but keep schema validation strict`

#### Scenario: Accept Markdown-Fenced JSON [FLA-JSON-FENCE]
WHEN an external LLM response wraps a valid JSON payload in markdown code fences, THE spec-check tool SHALL strip the outer fence markers and SHALL parse the enclosed JSON payload.

**Postcondition:** Common markdown formatting does not cause an otherwise valid payload to be rejected.

##### Evidence
- Implementation: [opencode.ts:406 extractJsonPayload()](/src/adapters/opencode.ts#L406), [opencode.ts:434 stripMarkdownFences()](/src/adapters/opencode.ts#L434)
- Test: [opencode.test.ts:147 accepts markdown-fenced JSON payloads](/test/contract/opencode.test.ts#L147)
- Example:
```typescript
const { extractJsonPayload } = await import("./src/adapters/opencode.ts");
const result = extractJsonPayload('```json\n{"findings":[]}\n```'); //=> type Object
result.findings.length; //=> 0
```

#### Scenario: Accept Prefixed Or Suffixed JSON [FLA-JSON-WRAP]
WHEN an external LLM response contains explanatory text before or after a valid JSON object or array, THE spec-check tool SHALL extract the first balanced JSON value and SHALL parse it.

**Postcondition:** Recoverable wrapper text does not prevent downstream schema validation.

##### Evidence
- Implementation: [opencode.ts:406 extractJsonPayload()](/src/adapters/opencode.ts#L406), [opencode.ts:467 extractFirstJsonValue()](/src/adapters/opencode.ts#L467)
- Test: [opencode.test.ts:168 accepts wrapped prefixed/suffixed JSON payloads](/test/contract/opencode.test.ts#L168)
- Test (property): [opencode.test.ts:189 property: accepts prefix+json wrappers when prefix excludes braces/brackets](/test/contract/opencode.test.ts#L189)
- Example:
```typescript
const { extractJsonPayload } = await import("./src/adapters/opencode.ts");
const result = extractJsonPayload('analysis follows\n{"findings":[]}\nthanks'); //=> type Object
result.findings.length; //=> 0
```

#### Scenario: Reject Irrecoverable JSON [FLA-JSON-FAIL]
IF an external LLM response does not contain a recoverable valid JSON payload, THEN THE spec-check tool SHALL reject the response with a diagnostic parse error.

**Postcondition:** Malformed payloads are surfaced explicitly rather than accepted silently.

##### Evidence
- Implementation: [opencode.ts:406 extractJsonPayload()](/src/adapters/opencode.ts#L406)
- Test: [opencode.test.ts:692 throws on truncated JSON (unbalanced braces)](/test/contract/opencode.test.ts#L692), [opencode.test.ts:698 throws on input with only prose text](/test/contract/opencode.test.ts#L698)
- Example:
```typescript
const { extractJsonPayload } = await import("./src/adapters/opencode.ts");
extractJsonPayload("I cannot provide a JSON response"); //=> throws Error
```

#### Requirement model

```alloy
// --- JSON payload extraction: structural invariants (pure function) ---
// JSON extraction is deterministic and total: every input is either
// recoverable (fenced, wrapped, pure) or irrecoverable (rejected with error).

abstract sig JsonInput {}
sig MarkdownFenced, PrefixedSuffixed, PureJson, Irrecoverable extends JsonInput {}

sig JsonExtraction {
  input : one JsonInput,
  recovered : one Bool
}

// Precondition: input is raw LLM response text (always available after call)
// Postconditions by input type:
fact fenced_accepted {
  all je : JsonExtraction | je.input in MarkdownFenced implies je.recovered = True
}
fact wrapped_accepted {
  all je : JsonExtraction | je.input in PrefixedSuffixed implies je.recovered = True
}
fact pure_accepted {
  all je : JsonExtraction | je.input in PureJson implies je.recovered = True
}
fact irrecoverable_rejected {
  all je : JsonExtraction | je.input in Irrecoverable implies je.recovered = False
}

// Safety: recovered payloads are never from irrecoverable inputs
assert recovered_implies_valid_input {
  all je : JsonExtraction | je.recovered = True implies je.input not in Irrecoverable
}

// Safety: irrecoverable inputs are explicitly rejected (no silent acceptance)
assert irrecoverable_never_silent {
  all je : JsonExtraction | je.input in Irrecoverable implies je.recovered = False
}

// Invariant: extraction is a total function (every input maps to exactly one result)
assert extraction_total {
  all je : JsonExtraction | je.recovered = True or je.recovered = False
}
```

### Requirement: Formalize Requirement And Scenario Claims Into Logic Artifacts [FLA-FORMALIZE-CLAIMS]
WHEN requirement and scenario claims are available for formal analysis, THE spec-check tool SHALL translate each claim into a typed logic representation and generated SMT-LIB artifacts that preserve the claim identifier, source provenance, obligation level, and supporting declarations needed for solver analysis, SHALL use the run-configured universal timeout for every external LLM formalization invocation, and SHALL group claims into formalization batches using the shared semantic logical-file grouping rather than raw source-spec file paths.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Make JSON extraction tolerant but keep schema validation strict`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Scope`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Proposed Design`

#### Requirement model

The base module models semantic grouping, physical-batch containment, handled formalization outcomes, and attached-attempt evidence. Logic IR generation, timeout values, and emitted artifact formats remain outside the model. The full temporal batch lifecycle is captured in the [state machine and invariant checks](#state-machine-and-invariant-checks) section below.

#### Scenario: Generate Inspectable Logic Artifacts [FLA-FORMAL-ARTS]
WHEN a claim is selected for formalization, THE spec-check tool SHALL emit inspectable logic and SMT artifacts that let a reviewer trace the formal result back to the originating requirement or scenario.

**Postcondition:** Formal analysis inputs are available as reviewable evidence linked to their source claims.

##### Evidence
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154), [formalize.ts:476 buildFormalizationPrompt()](/src/domain/formal/formalize.ts#L476)
- Test: [formalize.test.ts:45 formalizeClaims produces valid candidates from mock responses](/test/contract/formalize.test.ts#L45), [formalize.test.ts:159 buildFormalizationPrompt fences claim text as untrusted](/test/contract/formalize.test.ts#L159), [safety-liveness.invariant.test.ts:177 LIVE-11: if opencode responds with valid output, formalization completes](/test/invariant/safety-liveness.invariant.test.ts#L177)

#### Scenario: Abort On Complete Formalization Failure [FLA-FORMAL-FAIL]
IF no formalization candidates are produced for the entire phase after bounded retries, THEN THE spec-check tool SHALL abort the run with exit code `2` rather than continue with zero formal evidence.

**Postcondition:** No solver conclusion is produced when the formalization phase yields zero candidates.

##### Evidence
- Implementation: [formalize.ts:402 sampleFormalizationsForClaim()](/src/domain/formal/formalize.ts#L402)
- Test: [formalize.test.ts:90 returns error when all samples invalid after max attempts](/test/contract/formalize.test.ts#L90), [formalize.test.ts:113 returns error when callOpencode fails fatally](/test/contract/formalize.test.ts#L113)

#### Scenario: Continue With Partial Formalization Results [FLA-FORMAL-PARTIAL]
IF some claims fail formalization but at least one claim succeeds, THEN THE spec-check tool SHALL continue with the successful candidates, SHALL collect per-claim failures as errors in the formalization output, and SHALL let callers decide severity based on the ratio of successes to failures.

**Postcondition:** Partial formalization results are preserved and downstream phases proceed with available candidates.

##### Evidence
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154)
- Test: [formalize.test.ts:169 returns successful candidates alongside errors on partial failure](/test/contract/formalize.test.ts#L169)

#### Scenario: Universal LLM Timeout For Formalization [FLA-FORMAL-TIMEOUT]
WHEN the spec-check tool invokes an external LLM to formalize a claim or claim batch, THE spec-check tool SHALL use the run-configured universal timeout budget for that invocation.

**Postcondition:** Formalization timeout behavior is consistent with every other LLM-backed phase in the same run.

##### Evidence
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154), [opencode.ts:86 callOpencode()](/src/adapters/opencode.ts#L86), [timeout.ts:16 DEFAULT_TIMEOUT_MS](/src/domain/timeout.ts#L16)
- Test: [formalize.test.ts:45 formalizeClaims produces valid candidates from mock responses](/test/contract/formalize.test.ts#L45), [opencode.test.ts:403 retries on timeout up to retry limit then returns timeout error](/test/contract/opencode.test.ts#L403)

#### Scenario: Semantic Groups May Span Provenance Files [FLA-FORMAL-SPAN]
WHEN a merged capability's claims originate from more than one provenance file, THE spec-check tool SHALL place all such claims in one formalization logical group under the shared semantic key.

**Postcondition:** Formalization batches reflect the merged capability structure, not raw file layout.

#### Requirement model

```alloy
// --- Formalization phase: claim -> samples with abort/partial semantics ---

pred formalize_success {
  // Guard: in formalization phase with claims available
  Pipeline.phase = FormalizationPh
  some Claim
  some s : Sample | s.schemaValid = True
  // Effect: advance to validation
  Pipeline.phase' = ValidationPh
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred formalize_abort {
  // Guard: in formalization phase, zero valid samples exist
  Pipeline.phase = FormalizationPh
  no s : Sample | s.schemaValid = True
  // Effect: abort with exit code 2
  Pipeline.phase' = AbortedPh
  Pipeline.exitCode' = 2
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
}

pred formalize_partial {
  // Guard: some claims have valid samples, some don't
  Pipeline.phase = FormalizationPh
  some s : Sample | s.schemaValid = True
  some c : Claim | no s : Sample | s.claim = c and s.schemaValid = True
  // Effect: continue with available candidates
  Pipeline.phase' = ValidationPh
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// Safety: abort implies no solver conclusions ever produced
assert abort_no_conclusions {
  always (Pipeline.phase' = AbortedPh implies
    after always no f : Pipeline.findings | f.findingType = Contradiction)
}

// Safety: zero valid samples always triggers abort (not silent continuation)
assert zero_candidates_implies_abort {
  always (
    (Pipeline.phase = FormalizationPh and
     (no s : Sample | s.schemaValid = True) and
     Pipeline.phase' != FormalizationPh)
    implies Pipeline.phase' = AbortedPh)
}
```

### Requirement: Formalization Sample Schema Validation [FLA-VALIDATE-SAMPLE]
WHEN the spec-check tool receives a formalization sample from `opencode`, THE spec-check tool SHALL validate the sample against the logic IR schema including sort consistency, assertion well-formedness, identifier format, and same-claim declaration uniqueness before accepting it into clustering.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Valid Sample Accepted [FLA-SAMPLE-ACCEPT]
WHEN a formalization sample passes schema validation for sort consistency, assertion well-formedness, and identifier format, THE spec-check tool SHALL accept it as a clustering candidate.

**Postcondition:** Only structurally valid samples enter the clustering phase.

##### Evidence
- Implementation: [validate.ts:53 validateFormalizationSample()](/src/domain/formal/validate.ts#L53)
- Test: [validate.test.ts:14 accepts valid sample](/test/contract/validate.test.ts#L14), [validate.test.ts:62 accepts nested balanced parentheses](/test/contract/validate.test.ts#L62), [safety-liveness.invariant.test.ts:68 SAFE-3: no formalization sample enters clustering without schema validation](/test/invariant/safety-liveness.invariant.test.ts#L68)
- Example:
```typescript
const { validateFormalizationSample } = await import("./src/domain/formal/validate.ts");
const result = validateFormalizationSample({ claimId: "REQ-VALID", obligation: "mandatory", variables: [{ name: "State", sort: "Bool" }], functions: [{ name: "ok", args: ["Bool"], returns: "Bool" }], assertions: [{ id: "ASSERT-1", expr: "(ok true)" }] }); //=> type Object
result.ok; //=> true
```

#### Scenario: Invalid Sample Rejected [FLA-SAMPLE-REJECT]
IF a formalization sample violates the logic IR schema, THEN THE spec-check tool SHALL reject it from clustering and preserve the invalid sample as evidence.

**Postcondition:** Invalid formalizations are visible to reviewers without corrupting downstream analysis.

##### Evidence
- Implementation: [validate.ts:53 validateFormalizationSample()](/src/domain/formal/validate.ts#L53)
- Test: [validate.test.ts:20 rejects non-object input](/test/contract/validate.test.ts#L20), [validate.test.ts:26 rejects missing claimId](/test/contract/validate.test.ts#L26), [validate.test.ts:32 rejects invalid obligation](/test/contract/validate.test.ts#L32), [validate.test.ts:38 rejects unbalanced assertion parentheses](/test/contract/validate.test.ts#L38), [validate.test.ts:47 rejects function with undeclared sort](/test/contract/validate.test.ts#L47), [safety-liveness.invariant.test.ts:68 SAFE-3: no formalization sample enters clustering without schema validation](/test/invariant/safety-liveness.invariant.test.ts#L68)
- Example:
```typescript
const { validateFormalizationSample } = await import("./src/domain/formal/validate.ts");
const result = validateFormalizationSample({ claimId: "", obligation: "mandatory", variables: [], functions: [], assertions: [] }); //=> type Object
result.ok; //=> false
```

#### Scenario: Same-Claim Declaration Collisions Rejected [FLA-SAMPLE-SAMECLAIM]
IF a single claim declares overlapping raw variable and function names, OR declares duplicate same-kind variables or functions whose raw names sanitize to one symbol, THEN THE spec-check tool SHALL reject that sample during schema validation before it enters clustering.

**Postcondition:** Same-claim structural declaration collisions that do not depend on merge order are rejected at validation; residual same-claim cross-kind sanitizer collisions are deferred to compiler-level `symbol_kind_collision` detection.

##### Evidence
- Implementation: [validate.ts:133 validateDeclarationCollisions()](/src/domain/formal/validate.ts#L133)
- Test: [validate.test.ts:71 rejects raw variable/function name overlap within one claim](/test/contract/validate.test.ts#L71), [validate.test.ts:84 rejects duplicate variables that sanitize to the same symbol](/test/contract/validate.test.ts#L84), [validate.test.ts:101 rejects duplicate functions that sanitize to the same symbol](/test/contract/validate.test.ts#L101)
- Example:
```typescript
const { validateFormalizationSample } = await import("./src/domain/formal/validate.ts");
const result = validateFormalizationSample({ claimId: "REQ-X", obligation: "mandatory", variables: [{ name: "foo", sort: "Bool" }], functions: [{ name: "foo", args: ["Bool"], returns: "Bool" }], assertions: [{ id: "A1", expr: "(foo true)" }] }); //=> type Object
result.ok; //=> false
```

#### Scenario: All Samples Invalid After Retries [FLA-SAMPLE-EXHAUST]
IF all formalization samples for a claim are invalid after bounded retries, THEN THE spec-check tool SHALL record the failure as an error in the formalization output and SHALL exclude that claim from clustering. THE tool SHALL NOT abort the entire phase unless no claims produce valid candidates.

**Postcondition:** Per-claim formalization failures are collected as errors; remaining valid claims proceed to clustering.

##### Evidence
- Implementation: [formalize.ts:402 sampleFormalizationsForClaim()](/src/domain/formal/formalize.ts#L402)
- Test: [formalize.test.ts:90 returns error when all samples invalid after max attempts](/test/contract/formalize.test.ts#L90)

#### Requirement model

```alloy
// --- Schema validation: gate between formalization and clustering ---

pred validate_accept [s : Sample] {
  // Guard: in validation phase, sample passes schema checks
  Pipeline.phase = ValidationPh
  s.schemaValid = True
  // Effect: sample enters candidates
  Pipeline.candidates' = Pipeline.candidates + s
  Pipeline.phase' = Pipeline.phase
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred validate_reject [s : Sample] {
  // Guard: in validation phase, sample fails schema checks
  Pipeline.phase = ValidationPh
  s.schemaValid = False
  s not in Pipeline.candidates
  // Effect: sample excluded (preserved as evidence externally)
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.phase' = Pipeline.phase
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred validation_complete {
  // Guard: validation phase done
  Pipeline.phase = ValidationPh
  // Effect: advance to clustering if candidates exist, else abort
  some Pipeline.candidates implies Pipeline.phase' = ClusteringPh
  no Pipeline.candidates implies Pipeline.phase' = AbortedPh
  Pipeline.exitCode' = (no Pipeline.candidates implies 2 else Pipeline.exitCode)
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
}

// Safety: only valid samples ever enter the candidates set
assert only_valid_in_candidates {
  always (all s : Pipeline.candidates | s.schemaValid = True)
}

// Safety: invalid samples never corrupt downstream analysis
assert invalid_never_in_candidates {
  always (all s : Sample |
    s.schemaValid = False implies s not in Pipeline.candidates)
}
```

### Requirement: SMT-LIB Compilation And Identifier Sanitization [FLA-SMTLIB-COMPILE]
WHEN the spec-check tool compiles logic IR into SMT-LIB artifacts, THE spec-check tool SHALL sanitize user-derived identifiers with an injective encoding to prevent solver syntax collisions and identifier aliasing, SHALL include reversible mapping comments that link sanitized identifiers back to their original claim identifiers, SHALL emit only declarations and assertions without solver commands (`(check-sat)`), and SHALL expose decomposed assertion expressions alongside the compiled text for downstream query construction.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Unsafe Identifier Sanitized [FLA-SMTLIB-SANITIZE]
WHEN a claim identifier contains any code point outside the pass-through set of ASCII letters and digits `[A-Za-z0-9]` (for example parentheses, pipe characters, whitespace, a literal underscore, or a supplementary-plane character), THE spec-check tool SHALL iterate the identifier by Unicode code point, SHALL replace each such code point with `_` followed by exactly six uppercase hexadecimal digits of the Unicode code point, and SHALL emit a mapping comment.

**Postcondition:** The SMT-LIB file is syntactically valid, the encoding is uniquely decodable, and the original identifier is recoverable from the mapping comment.

##### Evidence
- Implementation: [smtlib.ts:142 sanitizeIdentifier()](/src/domain/formal/smtlib.ts#L142)
- Test: [smtlib.test.ts:34 sanitizes unsafe identifiers](/test/contract/smtlib.test.ts#L34)
- Test (property): [logic.property.test.ts:448 sanitized identifiers remain SMT-safe](/test/property/logic.property.test.ts#L448)
- Test (integration): [z3-smtlib.integration.test.ts:31 each golden sample compiles to Z3-accepted SMT-LIB (sat, no errors)](/test/integration/z3-smtlib.integration.test.ts#L31)
- Example:
```typescript
const { sanitizeIdentifier } = await import("./src/domain/formal/smtlib.ts");
const safe = sanitizeIdentifier("REQ_VALID_1"); //=> type String
safe; //=> REQ_00005FVALID_00005F1
const unsafe = sanitizeIdentifier("REQ(1)|A"); //=> type String
unsafe.includes("("); //=> false
unsafe.includes("|"); //=> false
```

#### Scenario: Valid Identifier Preserved [FLA-SMTLIB-PRESERVE]
WHEN a claim identifier contains only pass-through characters `[A-Za-z0-9]` and does not begin with a digit, THE spec-check tool SHALL use the identifier unchanged in the SMT-LIB output.

**Postcondition:** No unnecessary transformation is applied to identifiers already drawn entirely from the pass-through set.

##### Evidence
- Implementation: [smtlib.ts:142 sanitizeIdentifier()](/src/domain/formal/smtlib.ts#L142)
- Test: [smtlib.test.ts:39 compiles logic IR with mapping comments](/test/contract/smtlib.test.ts#L39)
- Test (property): [logic.property.test.ts:448 sanitized identifiers remain SMT-safe](/test/property/logic.property.test.ts#L448)
- Example:
```typescript
const { sanitizeIdentifier } = await import("./src/domain/formal/smtlib.ts");
sanitizeIdentifier("CLAIMID42"); //=> CLAIMID42
```

#### Scenario: Compiled Output Excludes Solver Commands [FLA-SMTLIB-QUERYSAT]
WHEN the spec-check tool compiles logic IR into SMT-LIB text, THE compiled output SHALL contain variable declarations (`declare-const`), function declarations (`declare-fun`), and assertions (`assert`) but SHALL NOT include `(check-sat)`. THE spec-check tool SHALL append `(check-sat)` at query execution time when submitting the compiled output to the solver.

**Postcondition:** Compiled SMT-LIB is a reusable component that can be composed into different query types (satisfiability, implication) without stripping embedded solver commands.

##### Evidence
- Implementation: [smtlib.ts:204 compileSmtlib()](/src/domain/formal/smtlib.ts#L204)
- Test: [smtlib.test.ts:39 compiles logic IR with mapping comments](/test/contract/smtlib.test.ts#L39), [smtlib.test.ts:57 produces a single smt2 without solver commands (callers append them)](/test/contract/smtlib.test.ts#L57)
- Example:
```typescript
const { compileSmtlib } = await import("./src/domain/formal/smtlib.ts");
const { toClaimId } = await import("./src/domain/branded.ts");
const compiled = compileSmtlib({ claimId: toClaimId("R1"), obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A1", expr: "S" }] }); //*
compiled.smtlib.includes("(check-sat)"); //=> false
compiled.smtlib.includes("(assert"); //=> true
```

#### Scenario: Assertion Expressions Exposed [FLA-SMTLIB-ASSERTEXPRS]
WHEN the spec-check tool compiles logic IR into SMT-LIB, THE compiled output SHALL include the decomposed inner assertion expressions (without the `(assert ...)` wrapper) for use in downstream implication query construction.

**Postcondition:** Downstream consumers can construct negated or combined assertions from the compiled output without re-parsing the SMT-LIB text.

##### Evidence
- Implementation: [smtlib.ts:204 compileSmtlib()](/src/domain/formal/smtlib.ts#L204)
- Test: [smtlib.test.ts:39 compiles logic IR with mapping comments](/test/contract/smtlib.test.ts#L39)
- Example:
```typescript
const { compileSmtlib } = await import("./src/domain/formal/smtlib.ts");
const { toClaimId } = await import("./src/domain/branded.ts");
const compiled = compileSmtlib({ claimId: toClaimId("R1"), obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A1", expr: "S" }] }); //*
compiled.assertionExprs.length; //=> 1
```

#### Requirement model

```alloy
// --- SMT-LIB compilation: sanitization and structural properties ---
// Compilation is a pure function (no state transitions). Its properties are
// structural invariants on the compiled output.

sig CompiledArtifact {
  declarations : set Claim,
  assertions : set Assertion,
  hasCheckSat : one Bool,
  hasMappingComments : one Bool,
  exposedExprs : set Assertion
}

// Compilation postconditions (structural invariants)
fact compilation_valid {
  all art : CompiledArtifact {
    // No solver commands in compiled output
    art.hasCheckSat = False
    // Mapping comments present for traceability
    art.hasMappingComments = True
    // All assertions have exposed inner expressions
    art.assertions in art.exposedExprs
  }
}

// Sanitization: deterministic, reversible, and identity-preserving for safe IDs
pred sanitize_id [cid : ClaimId, outputSafe : Bool] {
  outputSafe = True   // result is always safe (sanitized or preserved)
}

// Safety: compiled output never contains check-sat
assert no_checksat_in_compiled {
  all art : CompiledArtifact | art.hasCheckSat = False
}

// Safety: safe identifiers are preserved unchanged
assert safe_ids_preserved {
  all cid : ClaimId | cid.safety = Safe implies sanitize_id[cid, True]
}
```

### Requirement: Per-Spec Combined SMT-LIB Compilation [FLA-SPEC-COMBINE]
WHEN the spec-check tool performs specs-forward logic analysis, THE spec-check tool SHALL combine all formalized claims from a single merged capability analysis unit into exactly one SMT-LIB file, SHALL deduplicate compatible variable and function declarations across claims by final sanitized symbol identity, and SHALL use named assertions (`(assert (! expr :named label))`) to enable unsat-core identification. The compiled output SHALL NOT include solver commands (`check-sat`, `set-option`, `get-unsat-core`) — the logic analysis orchestrator appends these at query time using a two-phase approach (Phase 1: satisfiability check only; Phase 2: re-run with `(set-option :produce-unsat-cores true)` and `(get-unsat-core)` only when UNSAT is detected).

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Scope`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Interaction Protocols`

#### Scenario: Variable And Function Deduplication [FLA-SPEC-DEDUP]
WHEN multiple claims from the same merged capability analysis unit declare identical variable or function names with identical sorts or signatures after sanitization, THE spec-check tool SHALL emit only one declaration in the combined output and SHALL keep all compatible claims included.

**Postcondition:** The combined SMT-LIB file has no duplicate declarations from compatible claims, and compatible redeclarations do not re-anchor declaration ownership to a later claim.

##### Evidence
- Implementation: [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278)
- Test: [smtlib.test.ts:90 deduplicates identical variable declarations](/test/contract/smtlib.test.ts#L90), [smtlib.test.ts:102 deduplicates identical function declarations](/test/contract/smtlib.test.ts#L102)

#### Scenario: Function Signature Conflict Detection [FLA-SPEC-CONFLICT]
IF two claims from the same merged capability analysis unit declare the same sanitized function symbol with incompatible signatures, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding, SHALL exclude the later conflicting claim from the combined file, and SHALL preserve both claim identifiers, both raw function names, and the shared sanitized symbol in the finding evidence.

**Postcondition:** Function-signature conflicts are surfaced as findings rather than producing malformed solver input; no surviving sanitized function symbol has more than one signature, and the excluded claim contributes no assertions or declarations to the combined file.

##### Evidence
- Implementation: [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278), [logic-analysis.ts:315 conflictToFinding()](/src/domain/formal/logic-analysis.ts#L315)
- Test: [smtlib.test.ts:115 detects function signature conflicts and excludes conflicting claims](/test/contract/smtlib.test.ts#L115), [logic-analysis.test.ts:575 maps each merge conflict kind to merge_conflict finding with stable evidence](/test/contract/logic-analysis.test.ts#L575)
- Test (property): [logic.property.test.ts:700 function-signature conflict histories keep function-conflict-only scope](/test/property/logic.property.test.ts#L700)
- Example:
```typescript
const { compileSpecSmtlib } = await import("./src/domain/formal/smtlib.ts");
const { toClaimId } = await import("./src/domain/branded.ts");
const result = compileSpecSmtlib("spec.md", [{ claimId: toClaimId("R1"), obligation: "mandatory", variables: [], functions: [{ name: "f", args: ["Bool"], returns: "Bool" }], assertions: [{ id: "A1", expr: "(f true)" }] }, { claimId: toClaimId("R2"), obligation: "mandatory", variables: [], functions: [{ name: "f", args: ["Bool", "Bool"], returns: "Bool" }], assertions: [{ id: "A1", expr: "true" }] }]); //*
result.conflicts[0].kind; //=> function_signature_mismatch
result.claimIds.includes("R2"); //=> false
```

#### Scenario: Variable Sort Conflict Detection [FLA-SPEC-VARSORT-CONFLICT]
IF two claims from the same merged capability analysis unit declare the same sanitized variable symbol with incompatible sorts, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding for `variable_sort_mismatch`, SHALL exclude the later conflicting claim from the combined file, and SHALL preserve both claim identifiers, both raw variable names, the shared sanitized symbol, and both sorts in the finding evidence.

**Postcondition:** No surviving combined SMT-LIB artifact contains one sanitized variable symbol with more than one sort.

##### Evidence
- Implementation: [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278), [logic-analysis.ts:315 conflictToFinding()](/src/domain/formal/logic-analysis.ts#L315)
- Test: [smtlib.test.ts:135 detects variable sort mismatch and excludes later claim](/test/contract/smtlib.test.ts#L135), [logic-analysis.test.ts:575 maps each merge conflict kind to merge_conflict finding with stable evidence](/test/contract/logic-analysis.test.ts#L575)
- Test (property): [logic.property.test.ts:864 regression FLA-SPEC-CONFLICT-ORDER preserves first claimant after reorder](/test/property/logic.property.test.ts#L864)
- Example:
```typescript
const { compileSpecSmtlib } = await import("./src/domain/formal/smtlib.ts");
const { toClaimId } = await import("./src/domain/branded.ts");
const vsc = compileSpecSmtlib("spec.md", [{ claimId: toClaimId("R1"), obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A1", expr: "S" }] }, { claimId: toClaimId("R2"), obligation: "mandatory", variables: [{ name: "S", sort: "Int" }], functions: [], assertions: [{ id: "A1", expr: "(> S 0)" }] }]); //*
vsc.conflicts[0].kind; //=> variable_sort_mismatch
vsc.claimIds.join(","); //=> R1
```

#### Scenario: Symbol Kind Collision Detection [FLA-SPEC-SYMKIND-CONFLICT]
IF one claim declares a sanitized symbol as a variable and another claim declares the same sanitized symbol as a function, OR IF one claim contains distinct raw names that sanitize to the same symbol with opposite declaration kinds, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding for `symbol_kind_collision`, SHALL exclude the offending claim from the combined file, and SHALL preserve both claim identifiers, both raw names, both declaration kinds, and the shared sanitized symbol in the finding evidence.

**Postcondition:** No surviving combined SMT-LIB artifact contains one sanitized symbol declared as both `declare-const` and `declare-fun`.

##### Evidence
- Implementation: [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278), [logic-analysis.ts:315 conflictToFinding()](/src/domain/formal/logic-analysis.ts#L315)
- Test: [smtlib.test.ts:155 detects symbol kind collision across claims](/test/contract/smtlib.test.ts#L155), [smtlib.test.ts:175 detects same-claim symbol kind collision](/test/contract/smtlib.test.ts#L175)
- Test (property): [logic.property.test.ts:877 regression FLA-SPEC-SYMKIND-CONFLICT same-claim cross-kind collision excludes claim](/test/property/logic.property.test.ts#L877), [logic.property.test.ts:894 regression FLA-SPEC-SYMKIND-CONFLICT same-claim collision can cite excluded existing claim](/test/property/logic.property.test.ts#L894)
- Example:
```typescript
const { compileSpecSmtlib } = await import("./src/domain/formal/smtlib.ts");
const { toClaimId } = await import("./src/domain/branded.ts");
const skc = compileSpecSmtlib("spec.md", [{ claimId: toClaimId("R1"), obligation: "mandatory", variables: [{ name: "P", sort: "Bool" }], functions: [], assertions: [{ id: "A1", expr: "P" }] }, { claimId: toClaimId("R2"), obligation: "mandatory", variables: [], functions: [{ name: "P", args: ["Bool"], returns: "Bool" }], assertions: [{ id: "A1", expr: "(P true)" }] }]); //*
skc.conflicts[0].kind; //=> symbol_kind_collision
```

#### Scenario: Single Conflict Reason With Fixed Precedence [FLA-SPEC-CONFLICT-ORDER]
IF a claim introduces more than one kind of incompatible declaration binding relative to already-established sanitized symbols, THEN THE spec-check tool SHALL record exactly one conflict reason for that excluded claim under the fixed precedence `variable_sort_mismatch`, then `function_signature_mismatch`, then `symbol_kind_collision`.

**Postcondition:** Every excluded claim carries exactly one conflict reason, and the highest-precedence conflict is the reason reported.

##### Evidence
- Implementation: [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278)
- Test: [smtlib.test.ts:196 uses conflict precedence variable before function before symbol-kind](/test/contract/smtlib.test.ts#L196)
- Test (property): [logic.property.test.ts:864 regression FLA-SPEC-CONFLICT-ORDER preserves first claimant after reorder](/test/property/logic.property.test.ts#L864)

#### Scenario: Surviving Claim Set Is Authoritative [FLA-SPEC-CLAIMIDS]
WHEN the spec-check tool finishes combining a compile group, THE spec-check tool SHALL expose `compiled.claimIds` as the authoritative surviving-claim set containing exactly the non-excluded claims in original input order, and downstream checks SHALL derive claim inclusion from `compiled.claimIds` rather than from conflict evidence tuples.

**Postcondition:** Excluded claims contribute no assertions and no unique declarations to the emitted SMT-LIB, and `compiled.claimIds` is the single source of truth for inclusion across deeper checks, assertion labels, and unsat-core resolution.

##### Evidence
- Implementation: [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278)
- Test: [smtlib.test.ts:115 detects function signature conflicts and excludes conflicting claims](/test/contract/smtlib.test.ts#L115)
- Test (property): [logic.property.test.ts:655 compile is deterministic for the same generated state](/test/property/logic.property.test.ts#L655), [logic.property.test.ts:675 append-compatible histories are monotonic when no reorders/removals occur](/test/property/logic.property.test.ts#L675)
- Example:
```typescript
const { compileSpecSmtlib } = await import("./src/domain/formal/smtlib.ts");
const { toClaimId } = await import("./src/domain/branded.ts");
const surv = compileSpecSmtlib("spec.md", [{ claimId: toClaimId("R1"), obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A1", expr: "S" }] }, { claimId: toClaimId("R2"), obligation: "mandatory", variables: [{ name: "S", sort: "Int" }], functions: [], assertions: [{ id: "A1", expr: "(> S 0)" }] }]); //*
surv.claimIds.join(","); //=> R1
```

#### Scenario: Duplicate Claim Identifier Rejected Before Solver Execution [FLA-SPEC-DUPLICATE-CLAIM-ID]
IF a compile group contains duplicate raw claim identifiers or duplicate sanitized claim identifiers, THEN THE spec-check tool SHALL emit `logic.invalid_group`, SHALL skip combined SMT-LIB compilation for that group, and SHALL NOT invoke the solver for that group.

**Postcondition:** Claim identity remains one-to-one across included claims, assertion labels, unsat-core resolution, and finding evidence.

##### Evidence
- Implementation: [logic-analysis.ts:200 preflightGroupClaimIds()](/src/domain/formal/logic-analysis.ts#L200), [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:556 rejects duplicate raw claim IDs as invalid group before compile and solver work](/test/contract/logic-analysis.test.ts#L556), [logic-analysis.test.ts:619 detects constructed sanitized-id collision in preflight](/test/contract/logic-analysis.test.ts#L619)
- Test (property): [logic.property.test.ts:717 constructed sanitized collisions reject with duplicate_sanitized_claim_id](/test/property/logic.property.test.ts#L717), [logic.property.test.ts:733 logic analysis performs zero solver and write work for invalid groups](/test/property/logic.property.test.ts#L733)
- Example:
```typescript
const { preflightGroupClaimIds } = await import("./src/domain/formal/logic-analysis.ts");
const { toClaimId } = await import("./src/domain/branded.ts");
const dup = preflightGroupClaimIds([{ claimId: toClaimId("R1"), obligation: "mandatory", variables: [], functions: [], assertions: [{ id: "A1", expr: "true" }] }, { claimId: toClaimId("R1"), obligation: "mandatory", variables: [], functions: [], assertions: [{ id: "A1", expr: "true" }] }]); //=> type Object
dup.kind; //=> duplicate_raw_claim_id
```

#### Scenario: Oversized Compile Group Rejected Before Solver Execution [FLA-SPEC-GROUP-BOUNDS]
IF a compile group contains more claims than `CLAIMS_PER_GROUP_MAX`, OR any single claim declares more variable-plus-function symbols than `DECLARATIONS_PER_CLAIM_MAX`, THEN THE spec-check tool SHALL emit `logic.invalid_group`, SHALL skip combined SMT-LIB compilation for that group, and SHALL NOT invoke the solver or write solver artifacts for that group.

**Postcondition:** An oversized group is rejected as a graceful finding rather than aborting the run; valid sibling groups in the same analysis still compile and run to completion.

##### Evidence
- Implementation: [logic-analysis.ts:267 preflightGroupBounds()](/src/domain/formal/logic-analysis.ts#L267), [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278)
- Test: [smtlib.test.ts:68 throws its size precondition as an unreachable backstop when called directly past a bound](/test/contract/smtlib.test.ts#L68), [logic-analysis.test.ts:631 rejects an oversized compile group as invalid group before compile and solver work](/test/contract/logic-analysis.test.ts#L631), [logic-analysis.test.ts:651 rejects a claim with too many declarations as invalid group scoped to that claim](/test/contract/logic-analysis.test.ts#L651), [logic-analysis.test.ts:681 rejects only the oversized group while a valid sibling group still runs](/test/contract/logic-analysis.test.ts#L681)
- Test (property): [logic.property.test.ts:761 preflightGroupBounds accepts group cardinality at the limit and flags it one past the limit](/test/property/logic.property.test.ts#L761), [logic.property.test.ts:780 preflightGroupBounds counts variables plus functions against the per-claim limit](/test/property/logic.property.test.ts#L780)
- Example:
```typescript
const { preflightGroupBounds } = await import("./src/domain/formal/logic-analysis.ts");
const { toClaimId } = await import("./src/domain/branded.ts");
preflightGroupBounds([{ claimId: toClaimId("R1"), obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A1", expr: "S" }] }]); //=> null
```

#### Scenario: Dangling Assertion Reference Becomes Solver Error [FLA-SPEC-DANGLING-REF]
IF a claim assertion references a declaration that becomes undefined after another claim is merge-excluded, THEN THE spec-check tool SHALL surface the unresolved reference through the `logic.solver_error` path rather than silently emitting malformed solver input.

**Postcondition:** Assertion-reference resolution is out of scope for merge exclusion; any resulting dangling reference is reported as a solver error with preserved solver input and output as evidence.

##### Evidence
- Implementation: [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:318 solver error produces logic.solver_error finding](/test/contract/logic-analysis.test.ts#L318)

#### Scenario: Untrusted Comment Text Stays Inert [FLA-SPEC-COMMENT-SAFE]
WHEN the spec-check tool emits SMT-LIB mapping comments generated from untrusted strings such as claim identifiers, raw symbol names, or source paths, THE spec-check tool SHALL escape line-breaking characters so the comment text cannot introduce executable solver commands on following lines.

**Postcondition:** Raw evidence embedded in compiler output remains inert comment data and cannot inject SMT-LIB commands by starting a new line.

##### Evidence
- Implementation: [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278)
- Test (property): [logic.property.test.ts:812 compiler comment emission neutralizes newline-based SMT command injection](/test/property/logic.property.test.ts#L812)

#### Scenario: Named Assertion Labels Map To Claims [FLA-SPEC-NAMED]
WHEN the spec-check tool generates named assertions in the combined SMT-LIB, THE label for each assertion SHALL encode the source claim identifier and assertion index so that unsat-core results can be mapped back to specific included claims.

**Postcondition:** The assertion-name-to-claim-ID mapping is deterministic and reversible, and `assertionNameMap` contains labels for included claims only.

##### Evidence
- Implementation: [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278)
- Test: [smtlib.test.ts:79 uses named assertions with :named labels](/test/contract/smtlib.test.ts#L79), [smtlib.test.ts:214 maps assertion labels back to claim IDs](/test/contract/smtlib.test.ts#L214)
- Example:
```typescript
const { compileSpecSmtlib } = await import("./src/domain/formal/smtlib.ts");
const { toClaimId } = await import("./src/domain/branded.ts");
const result = compileSpecSmtlib("spec.md", [{ claimId: toClaimId("R1"), obligation: "mandatory", variables: [{ name: "S", sort: "Bool" }], functions: [], assertions: [{ id: "A1", expr: "S" }] }]); //*
result.smtlib.includes(":named R1__a0"); //=> true
result.assertionNameMap.get("R1__a0"); //=> R1
```

#### Scenario: Assertion Label Encoding Is Injective [FLA-SPEC-LABEL-ENCODE]
WHEN the spec-check tool encodes a named-assertion label, THE spec-check tool SHALL form the label as `<sanitizedClaimId>__a<index>`, where `sanitizeIdentifier()` is injective: it passes through only ASCII letters and digits `[A-Za-z0-9]`, reserves `_` as the escape lead, and escapes every other code point, including a literal underscore, as `_` followed by exactly six uppercase hexadecimal digits of the Unicode code point. It SHALL escape a leading raw digit, SHALL map the empty string to `_`, and SHALL perform no Unicode normalization.

**Postcondition:** The `__a<index>` separator remains unambiguous and distinct raw claim IDs cannot produce colliding assertion labels.

##### Evidence
- Implementation: [smtlib.ts:142 sanitizeIdentifier()](/src/domain/formal/smtlib.ts#L142), [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278)
- Test: [smtlib.test.ts:226 keeps assertion labels distinct for formerly colliding identifiers](/test/contract/smtlib.test.ts#L226)
- Test (property): [logic.property.test.ts:459 sanitizer is injective for generated distinct raw identifiers](/test/property/logic.property.test.ts#L459), [logic.property.test.ts:470 sanitizeIdentifier is uniquely decodable, proving injectivity over full Unicode](/test/property/logic.property.test.ts#L470)
- Example:
```typescript
const { sanitizeIdentifier } = await import("./src/domain/formal/smtlib.ts");
sanitizeIdentifier("A_B"); //=> A_00005FB
sanitizeIdentifier(""); //=> _
sanitizeIdentifier("1X"); //=> _000031X
```

#### Requirement model

```alloy
// --- Per-spec combination: deduplication, conflict detection, named assertions ---

sig CombinedSpec {
  specRef : one Spec,
  includedClaims : set Claim,
  excludedClaims : set Claim,
  namedAssertions : Assertion -> one Claim
}

// Domain axioms: structural facts defining what a CombinedSpec IS. A claim of
// the spec is included xor excluded, and named assertions belong to included
// claims. Declaration AGREEMENT (no surviving symbol with two sorts/kinds) is
// deliberately NOT a fact here: it is the safety property to be verified,
// modeled below as the predicate combined_wellformed and proven from the
// exclusion policy rather than assumed.
fact combined_structure {
  all cs : CombinedSpec {
    // Included and excluded claims partition exactly the claims of specRef.
    cs.includedClaims + cs.excludedClaims =
      { c : Claim | c.spec = cs.specRef }
    no (cs.includedClaims & cs.excludedClaims)
    // Named assertions map to included claims only
    all a : cs.namedAssertions.Claim | a.sourceClaim in cs.includedClaims
  }
}

// Same-claim same-name declarations survive validation only as residual
// cross-kind sanitizer collisions (opposite kinds); same-kind same-name
// duplicates are rejected earlier at validation.
fact validated_same_claim_declarations {
  all c : Claim, disj d1, d2 : Declaration |
    (d1.declClaim = c and d2.declClaim = c and d1.declName = d2.declName)
      implies d1.declKind != d2.declKind
}

// Safety property (a PREDICATE, not a fact): every pair of included
// declarations sharing one sanitized name agrees on both declaration kind and
// signature -- i.e. no surviving symbol is bound to two sorts, or to both a
// variable and a function. Because this is not asserted as a fact, the model
// CAN exhibit a malformed combined artifact; the theorems below prove the
// exclusion policy prevents it.
pred combined_wellformed [cs : CombinedSpec] {
  all disj d1, d2 : Declaration |
    (d1.declClaim in cs.includedClaims and d2.declClaim in cs.includedClaims and
     d1.declName = d2.declName) implies
       (d1.declKind = d2.declKind and d1.declSig = d2.declSig)
}

// A conflict: two declarations (possibly of the same claim when c1 = c2) share
// a sanitized name but disagree on declaration kind or signature. Passing
// c1 = c2 models a same-claim variable/function sanitizer collision.
pred conflict_detected [c1, c2 : Claim, sp : Spec] {
  c1.spec = sp and c2.spec = sp
  some disj d1, d2 : Declaration |
    d1.declClaim = c1 and d2.declClaim = c2 and
    d1.declName = d2.declName and
    (d1.declKind != d2.declKind or d1.declSig != d2.declSig)
}

// The exclusion policy: every detected conflict has at least one of its two
// claims excluded. For a same-claim conflict (c1 = c2) this reduces to
// excluding that single claim.
pred conflicts_excluded [cs : CombinedSpec] {
  all c1, c2 : Claim |
    conflict_detected[c1, c2, cs.specRef] implies
      (c1 in cs.excludedClaims or c2 in cs.excludedClaims)
}

pred emit_merge_conflict [c1, c2 : Claim] {
  Pipeline.phase = CompilationPh
  conflict_detected[c1, c2, c1.spec]
  some f : Finding |
    f.findingType = MergeConflict and
    f.severity = ErrorSev and
    c1 + c2 in f.involvedClaims and
    Pipeline.findings' = Pipeline.findings + f
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// Safety theorem: applying the exclusion policy is SUFFICIENT to make the
// combined artifact wellformed. Wellformedness is proven from the policy, not
// assumed -- the honest direction (exclusion => wellformed), in contrast to a
// fact-imposed invariant which would only let us derive the converse.
assert exclusion_implies_wellformed {
  all cs : CombinedSpec |
    conflicts_excluded[cs] implies combined_wellformed[cs]
}

// A same-claim sanitizer collision forces that claim's own exclusion once the
// exclusion policy is applied.
assert same_claim_collision_excluded {
  all cs : CombinedSpec, c : Claim |
    (conflicts_excluded[cs] and conflict_detected[c, c, cs.specRef])
      implies c in cs.excludedClaims
}

// NOTE: two additional group-level rejections that also gate compilation --
// duplicate claim identity [FLA-SPEC-DUPLICATE-CLAIM-ID] and oversized compile
// groups [FLA-SPEC-GROUP-BOUNDS] -- are preflight failures rather than merge
// exclusions. They emit a `logic.invalid_group` finding (the InvalidGroup
// finding type) and skip the solver entirely; both are modeled as the events
// duplicate_claim_id_rejected / oversized_group_rejected in the
// [state machine and invariant checks](#state-machine-and-invariant-checks)
// section below.
```

### Requirement: Surface Ambiguity Through Sample Clustering [FLA-CLUSTER-AMBIG]
WHEN multiple formalization samples are produced for the same claim, THE spec-check tool SHALL compare the samples for semantic equivalence using solver-backed implication checks, select a stable interpretation only when it meets the configured stability threshold, and SHALL surface divergent interpretations as ambiguity findings with rationale.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Select Stable Interpretation [FLA-CLUSTER-STABLE]
WHEN one equivalence cluster exceeds the configured stability threshold, THE spec-check tool SHALL select the highest-confidence sample from that cluster as the representative formalization for the claim.

**Postcondition:** Downstream solver analysis uses one explicit representative interpretation with preserved clustering evidence.

##### Evidence
- Implementation: [clustering.ts:97 clusterFormalizationSamples()](/src/domain/formal/clustering.ts#L97)
- Test: [clustering.test.ts:30 selects representative from stable cluster when threshold met](/test/contract/clustering.test.ts#L30)

#### Scenario: Surface Divergent Interpretations [FLA-CLUSTER-DIVERGE]
IF no equivalence cluster meets the configured stability threshold, THEN THE spec-check tool SHALL emit an ambiguity finding that preserves the distinct surviving interpretations for reviewer inspection.

**Postcondition:** Weak or unstable claim meaning becomes a surfaced finding instead of a hidden assumption.

##### Evidence
- Implementation: [clustering.ts:97 clusterFormalizationSamples()](/src/domain/formal/clustering.ts#L97)
- Test: [clustering.test.ts:53 emits ambiguity finding when no cluster meets stability threshold](/test/contract/clustering.test.ts#L53), [clustering.test.ts:122 with two non-equivalent samples (sat both) produces two clusters](/test/contract/clustering.test.ts#L122)

#### Scenario: Inconclusive Implication Check Preserved [FLA-CLUSTER-INCON]
IF the solver returns timeout or unknown for a pairwise implication check, THE spec-check tool SHALL record the inconclusive pair as evidence and SHALL NOT treat the pair as either equivalent or distinct.

**Postcondition:** Inconclusive solver results do not corrupt cluster construction.

##### Evidence
- Implementation: [clustering.ts:290 classifyImplication()](/src/domain/formal/clustering.ts#L290)
- Test: [clustering.test.ts:79 records inconclusive pairwise result when z3 returns timeout](/test/contract/clustering.test.ts#L79)

#### Scenario: Single Solver Command Per Implication Query [FLA-CLUSTER-QUERY]
WHEN the spec-check tool constructs a pairwise implication query to test whether sample A entails sample B, THE query SHALL assert A's declarations and assertions as the premise, SHALL assert the negation of the conjunction of B's assertions (i.e., `(assert (not (and b1 b2 ...)))`) as the consequent test, and SHALL contain exactly one `(check-sat)` command at the end. A result of `unsat` means A entails B; a result of `sat` means A does not entail B.

**Postcondition:** Each implication query produces exactly one solver result with unambiguous interpretation; the negation applies to the conjunction of all target assertions jointly.

##### Evidence
- Implementation: [clustering.ts:244 buildImplicationQuery()](/src/domain/formal/clustering.ts#L244)
- Test: [implication-query.test.ts:20 contains exactly one (check-sat) command](/test/contract/implication-query.test.ts#L20), [implication-query.test.ts:31 does not directly assert right-side claim expressions](/test/contract/implication-query.test.ts#L31), [implication-query.test.ts:48 encodes implication as assert-left + negate-right](/test/contract/implication-query.test.ts#L48)

#### Requirement model

```alloy
// --- Clustering: equivalence via implication, stability, ambiguity ---

pred cluster_stable [cl : Cluster] {
  // Cluster has enough members to meet threshold
  #cl.members >= 2
  some cl.representative
}

pred cluster_select_representative [c : Claim, cl : Cluster] {
  // Guard: clustering phase, cluster is stable for this claim
  Pipeline.phase = ClusteringPh
  cluster_stable[cl]
  cl.representative.claim = c
  // Effect: representative selected for this claim
  Pipeline.representatives' = Pipeline.representatives + (c -> cl.representative)
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred cluster_divergent [c : Claim] {
  // Guard: no stable cluster for this claim
  Pipeline.phase = ClusteringPh
  no cl : Cluster | cluster_stable[cl] and cl.representative.claim = c
  // Effect: ambiguity finding emitted
  some f : Finding |
    f.findingType = Ambiguity and
    f.severity = WarningSev and
    c in f.involvedClaims and
    Pipeline.findings' = Pipeline.findings + f
  // No representative selected for this claim
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// Inconclusive implication: pair neither equivalent nor proven distinct
pred implication_inconclusive [a, b : Sample] {
  some ir : ImplicationResult | ir.from = a and ir.to = b and ir.result in (Timeout + Unknown)
}

// Safety: inconclusive checks do not corrupt cluster membership
// (guaranteed by fact: clusters_respect_equivalence only uses Unsat results)
assert inconclusive_no_cluster_corruption {
  all disj a, b : Sample |
    implication_inconclusive[a, b] implies not samples_equivalent[a, b]
}

// Safety: each implication query produces exactly one result
assert single_result_per_query {
  all ir : ImplicationResult | one ir.result
}

// Safety: divergent claims surface ambiguity findings
assert divergent_produces_finding {
  always (all c : Claim |
    cluster_divergent[c] implies
      (some f : Pipeline.findings' | f.findingType = Ambiguity and c in f.involvedClaims))
}
```

### Requirement: Clustering Determinism And Symmetry [FLA-CLUSTER-PROPERTIES]
WHEN the spec-check tool performs equivalence clustering on the same set of formalization samples with the same solver results, THE spec-check tool SHALL produce identical clusters.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Symmetric Implication Produces Same Cluster [FLA-CLUSTER-SYMM]
WHEN sample A implies sample B and sample B implies sample A, THE spec-check tool SHALL place both samples in the same equivalence cluster.

**Postcondition:** Mutual implication is correctly classified as equivalence.

##### Evidence
- Implementation: [clustering.ts:313 buildEquivalenceClusters()](/src/domain/formal/clustering.ts#L313)
- Test: [clustering.test.ts:101 with two equivalent samples (mutual unsat) produces single cluster](/test/contract/clustering.test.ts#L101)
- Test (property): [logic.property.test.ts:492 cluster construction is deterministic and symmetric for mutual pairs](/test/property/logic.property.test.ts#L492)
- Example:
```typescript
const { buildEquivalenceClusters } = await import("./src/domain/formal/clustering.ts");
const clusters = buildEquivalenceClusters(2, [{ leftIndex: 0, rightIndex: 1, leftImpliesRight: "yes", rightImpliesLeft: "yes", evidence: { leftToRightQuery: "", rightToLeftQuery: "", leftToRightResult: "", rightToLeftResult: "" } }]); //*
clusters.length; //=> 1
clusters[0].members.length; //=> 2
```

#### Scenario: Deterministic Clustering [FLA-CLUSTER-DETERM]
WHEN the same formalization samples and solver results are processed on two separate runs, THE spec-check tool SHALL produce identical equivalence clusters and identical representative selections.

**Postcondition:** Clustering is a deterministic function of its inputs.

##### Evidence
- Implementation: [clustering.ts:313 buildEquivalenceClusters()](/src/domain/formal/clustering.ts#L313)
- Test (property): [logic.property.test.ts:492 cluster construction is deterministic and symmetric for mutual pairs](/test/property/logic.property.test.ts#L492)

#### Requirement model

```alloy
// --- Clustering properties: symmetry and determinism ---
// Symmetry is guaranteed by the structural fact clusters_respect_equivalence.
// Determinism is a meta-property: same inputs -> same clusters (enforced by
// the clustering algorithm being a deterministic function of ImplicationResults).
// That meta-property is established over two runs which a single-instance structural
// assertion cannot express; it is verified by the property-based test logic.property.test.ts:492 (cited in evidence).
// What we CAN state structurally is the consequence that distinct clusters
// carry distinct member sets (from pairwise disjointness + non-emptiness).

// Verify: mutual implication places samples in same cluster
assert symmetric_implication_same_cluster {
  all disj a, b : Sample, cl : Cluster |
    (samples_equivalent[a, b] and a in cl.members) implies b in cl.members
}

// Verify: distinct clusters have distinct member sets. This is the structural
// footprint of a deterministic clustering (no two cluster identities collapse
// to the same membership), following from disjoint + non-empty clusters.
assert clusters_have_distinct_members {
  all disj cl1, cl2 : Cluster | cl1.members != cl2.members
}
```

### Requirement: Run Per-Spec Combined Solver Analysis [FLA-RUN-LOGIC]
WHEN formal artifacts are available, THE spec-check tool SHALL group representative spec-derived claims by merged capability analysis unit, SHALL compile each group into a single combined SMT-LIB file with named assertions, SHALL invoke Z3 per merged capability group using a two-phase approach (Phase 1: satisfiability check only; Phase 2: re-invoke with unsat-core support only when contradiction is detected), and SHALL classify contradictions with severity derived from the highest-obligation claim in the unsat core.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Interaction Protocols`

#### Scenario: Report Contradiction With Unsat-Core Identification [FLA-LOGIC-CORE]
WHEN a per-merged-capability combined query returns unsat, THE spec-check tool SHALL parse the unsat core to identify the specific conflicting claims, SHALL report a `logic.contradiction` finding referencing those claims, and SHALL derive severity from the highest-obligation claim in the core (mandatory → error, advisory → warning, informational → info).

**Postcondition:** Reviewers can identify which specific claims within a merged capability view are mutually contradictory.

##### Evidence
- Implementation: [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:122 mandatory contradiction (unsat) reported at severity error](/test/contract/logic-analysis.test.ts#L122), [logic-analysis.test.ts:267 unsat core identifies specific conflicting claims](/test/contract/logic-analysis.test.ts#L267)
- Test (integration): [z3-smtlib.integration.test.ts:75 directly contradictory bare assertions produce UNSAT](/test/integration/z3-smtlib.integration.test.ts#L75)

#### Scenario: Advisory-Only Core Reported At Lower Severity [FLA-LOGIC-ADVISORY]
WHEN the unsat core contains only advisory or informational claims with no mandatory claims, THE spec-check tool SHALL report the contradiction at warning or info severity respectively.

**Postcondition:** Contradictions among advisory claims are visible but clearly distinguished from mandatory violations.

##### Evidence
- Implementation: [logic-analysis-sexpr.ts:402 deriveSeverityFromClaims()](/src/domain/formal/logic-analysis-sexpr.ts#L402), [logic-analysis-sexpr.ts:443 obligationToSeverity()](/src/domain/formal/logic-analysis-sexpr.ts#L443)
- Test: [logic-analysis.test.ts:142 advisory-only contradiction (unsat) reported at severity warning](/test/contract/logic-analysis.test.ts#L142), [logic-analysis.test.ts:297 severity derived from highest-obligation in core (advisory when no mandatory in core)](/test/contract/logic-analysis.test.ts#L297)
- Example:
```typescript
const { obligationToSeverity } = await import("./src/domain/formal/logic-analysis.ts");
obligationToSeverity("mandatory"); //=> error
obligationToSeverity("advisory"); //=> warning
obligationToSeverity("informational"); //=> info
```

#### Scenario: Preserve Inconclusive Solver Result [FLA-LOGIC-TIMEOUT]
IF the solver returns timeout or unknown for a per-merged-capability query, THEN THE spec-check tool SHALL preserve the inconclusive result as evidence and SHALL emit a `logic.inconclusive` finding at warning severity.

**Postcondition:** Inconclusive logic results remain visible to reviewers and do not masquerade as success.

##### Evidence
- Implementation: [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:162 timeout/unknown result preserved as inconclusive finding](/test/contract/logic-analysis.test.ts#L162)

#### Scenario: Sat Result Triggers Deeper Analysis [FLA-LOGIC-SAT]
WHEN a per-merged-capability combined query returns sat, THE spec-check tool SHALL NOT emit a global contradiction finding for that merged capability, but SHALL proceed with pairwise guard-activation contradiction checks and completeness gap detection to identify conditional contradictions and unspecified states that the global satisfiability check cannot surface.

**Postcondition:** A globally satisfiable merged capability is not assumed free of all issues; deeper conditional analysis follows.

##### Evidence
- Implementation: [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:226 sat result does not generate contradiction finding](/test/contract/logic-analysis.test.ts#L226)

#### Scenario: Solver Error Produces Finding [FLA-LOGIC-ERROR]
IF the solver emits error diagnostics (such as `(error ...)` lines in stdout) indicating malformed input, THEN THE spec-check tool SHALL emit a `logic.solver_error` finding at error severity referencing all claims in the affected merged capability group, and SHALL persist the solver input and output as evidence.

**Postcondition:** Solver errors are surfaced as explicit findings rather than silently treated as successful analysis.

##### Evidence
- Implementation: [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:318 solver error produces logic.solver_error finding](/test/contract/logic-analysis.test.ts#L318)

### Requirement: Group Specs-Forward Logic By Merged Capability [FLA-GROUP-MERGED]
WHEN the spec-check tool prepares specs-forward logical analysis, THE spec-check tool SHALL group spec-derived claims by merged capability identity rather than by raw source-spec file path, SHALL use the merged capability `logicalFile` as the artifact-naming and report-grouping key, SHALL exclude non-spec claims from this capability-grouped logic path, and SHALL derive grouping keys from the same shared semantic key helper that formalization grouping uses.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Postconditions`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Provenance And Grouping Contract`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Verification Strategy`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Scope`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Interface Contracts`

#### Requirement model

The base module models shared semantic key selection and checks grouping parity and one-group physical-batch containment. Solver-specific filtering and artifact naming remain implementation and test obligations outside the model.

#### Scenario: One Logic Group Per Merged Capability [FLA-GROUP-ONE]
WHEN one capability has finalized-plus-delta inputs that merge into one active capability view, THE spec-check tool SHALL produce exactly one specs-forward logical-analysis group for that capability.

**Postcondition:** Base and delta files for the same capability are no longer analyzed as separate solver groups.

##### Evidence
- Implementation: [pipeline-helpers.ts:345 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L345)
- Test: [pipeline-helpers.test.ts:77 produces one logic group per non-empty merged capability with no omissions](/test/contract/pipeline-helpers.test.ts#L77), [merge-logic-routing.test.ts:35 runs one logic group per merged capability and detects contradictions in one run](/test/contract/merge-logic-routing.test.ts#L35)

#### Scenario: Synthetic Logical Key Drives Artifact Naming [FLA-GROUP-LOGICAL]
WHEN the spec-check tool persists solver artifacts or reports for a merged capability logic group, THE spec-check tool SHALL derive those artifact names from the merged capability `logicalFile` key rather than from the original base or delta source file paths.

**Postcondition:** Capability-scoped logic artifacts align with merged capability semantics while original claim provenance remains unchanged.

##### Evidence
- Implementation: [pipeline-helpers.ts:345 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L345), [pipeline-helpers.ts:403 sanitizeLogicalFileForArtifacts()](/src/cli/pipeline-helpers.ts#L403), [logic-analysis.ts:414 artifactBase computation in analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L414)
- Test: [pipeline-helpers.test.ts:126 groups by Claim.capability instead of provenance.file](/test/contract/pipeline-helpers.test.ts#L126), [merge-logic-routing.test.ts:57 writes logic artifacts under synthetic merged logicalFile artifact key](/test/contract/merge-logic-routing.test.ts#L57)

#### Scenario: Sanitized Logical Key Collision Aborts Pipeline [FLA-GROUP-COLLISION]
IF two merged capability logical keys would sanitize to the same artifact-path key, THEN THE spec-check tool SHALL abort the pipeline before writing any logic artifacts.

**Postcondition:** Persisted solver evidence remains deterministic and collision-free.

##### Evidence
- Implementation: [pipeline-helpers.ts:386 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L386), [pipeline-helpers.ts:403 sanitizeLogicalFileForArtifacts()](/src/cli/pipeline-helpers.ts#L403)
- Test: [pipeline-helpers.test.ts:150 fails on sanitized logicalFile collisions](/test/contract/pipeline-helpers.test.ts#L150)

#### Scenario: Solver Grouping Uses Shared Key Helper [FLA-GROUP-SHARED]
WHEN the spec-check tool groups claims for solver analysis, THE solver grouping path SHALL call the shared semantic key helper and SHALL NOT duplicate capability fallback logic locally.

**Postcondition:** Any solver-specific filtering happens before grouping and is documented independently of the key function.

#### Requirement model

```alloy
// --- Merged capability grouping: logical keys and collision detection ---

sig LogicalKey {
  sanitizedForm : one LogicalKey    // self-referencing: the sanitized version
}

sig LogicalGroup {
  groupCap : one Spec,              // the merged capability this group represents
  logicalKey : one LogicalKey,      // derived from merged capability identity
  groupClaims : set Claim           // claims in this group (spec-derived only)
}

// Invariant: one logic group per merged capability [FLA-GROUP-ONE]
fact one_group_per_capability {
  all disj lg1, lg2 : LogicalGroup | lg1.groupCap != lg2.groupCap
}

// Invariant: groups only contain claims from their capability
fact group_claims_from_capability {
  all lg : LogicalGroup | lg.groupClaims in { c : Claim | c.spec = lg.groupCap }
}

// Invariant: non-spec claims excluded from capability-grouped logic path
fact non_spec_excluded {
  all lg : LogicalGroup, c : lg.groupClaims | c.spec = lg.groupCap
}

// Invariant: logical key drives artifact naming (not source file)
fact logical_key_drives_naming {
  all lg : LogicalGroup | some lg.logicalKey.sanitizedForm
}

// Collision predicate: two groups sanitize to same key [FLA-GROUP-COLLISION]
pred logical_key_collision {
  some disj lg1, lg2 : LogicalGroup |
    lg1.logicalKey.sanitizedForm = lg2.logicalKey.sanitizedForm
}

// Failure mode: collision aborts pipeline before writing artifacts
pred collision_aborts_pipeline {
  Pipeline.phase = CompilationPh
  logical_key_collision
  // Effect: abort immediately
  Pipeline.phase' = AbortedPh
  Pipeline.exitCode' = 2
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
}

// Safety: collision always aborts (never silently overwrites)
assert collision_implies_abort {
  always (collision_aborts_pipeline implies Pipeline.phase' = AbortedPh)
}

// Safety: without collision, compilation phase does not abort from this path
assert no_collision_no_grouping_abort {
  always (
    (Pipeline.phase = CompilationPh and not logical_key_collision)
    implies not collision_aborts_pipeline)
}

// Safety: during compilation without a key collision, each merged capability
// is represented by at most one logic group (the structural footprint of
// "exactly one group per capability" from fact one_group_per_capability).
// The eventual FORMATION of that group is the liveness property stated below
// as merged_cap_group_formation; this assertion is its safety counterpart.
assert group_formation_complete {
  always (
    (Pipeline.phase = CompilationPh and not logical_key_collision)
    implies (all sp : Spec | lone { lg : LogicalGroup | lg.groupCap = sp }))
}
```

#### Requirement model

```alloy
// --- Solver analysis: two-phase approach with severity derivation ---

// Obligation -> Severity mapping
fun obligationToSeverity [o : Obligation] : one Severity {
  (o = Mandatory) implies ErrorSev
  else (o = Advisory) implies WarningSev
  else InfoSev
}

// Per-spec solver query result
sig SpecQueryResult {
  querySpec : one Spec,
  globalResult : one SolverResult,
  unsatCore : set Claim
}

// Unsat core only populated when result is Unsat
fact unsat_core_constraint {
  all sqr : SpecQueryResult |
    sqr.globalResult != Unsat implies no sqr.unsatCore
  all sqr : SpecQueryResult |
    sqr.globalResult = Unsat implies some sqr.unsatCore
  all sqr : SpecQueryResult |
    sqr.unsatCore in { c : Claim | c.spec = sqr.querySpec }
}

pred solver_reports_contradiction [sqr : SpecQueryResult] {
  // Guard: analysis phase, global result is unsat
  Pipeline.phase = AnalysisPh
  sqr.globalResult = Unsat
  // Effect: contradiction finding with severity from max obligation in core
  some f : Finding {
    f.findingType = Contradiction
    f.severity = obligationToSeverity[maxObligation[sqr.unsatCore]]
    f.involvedClaims = sqr.unsatCore
    Pipeline.findings' = Pipeline.findings + f
  }
  Pipeline.evidence' = Pipeline.evidence + sqr.querySpec
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.exitCode' = Pipeline.exitCode
}

pred solver_inconclusive [sqr : SpecQueryResult] {
  // Guard: analysis phase, timeout or unknown
  Pipeline.phase = AnalysisPh
  sqr.globalResult in (Timeout + Unknown)
  // Effect: inconclusive finding at warning severity
  some f : Finding {
    f.findingType = Inconclusive
    f.severity = WarningSev
    f.involvedClaims = { c : Claim | c.spec = sqr.querySpec }
    Pipeline.findings' = Pipeline.findings + f
  }
  Pipeline.evidence' = Pipeline.evidence + sqr.querySpec
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.exitCode' = Pipeline.exitCode
}

pred solver_sat_deeper [sqr : SpecQueryResult] {
  // Guard: analysis phase, global result is sat
  Pipeline.phase = AnalysisPh
  sqr.globalResult = Sat
  // Effect: no global contradiction, proceed to deeper analysis
  Pipeline.findings' = Pipeline.findings  // no new contradiction finding
  Pipeline.evidence' = Pipeline.evidence + sqr.querySpec
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.exitCode' = Pipeline.exitCode
}

pred solver_error_found [sqr : SpecQueryResult] {
  // Guard: solver emits error diagnostics
  Pipeline.phase = AnalysisPh
  sqr.globalResult = SolverError
  // Effect: solver_error finding at error severity
  some f : Finding {
    f.findingType = SolverErrType
    f.severity = ErrorSev
    f.involvedClaims = { c : Claim | c.spec = sqr.querySpec }
    Pipeline.findings' = Pipeline.findings + f
  }
  Pipeline.evidence' = Pipeline.evidence + sqr.querySpec
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.exitCode' = Pipeline.exitCode
}

// Safety: severity correctly derived from highest obligation in unsat core
assert contradiction_severity_correct {
  always (all sqr : SpecQueryResult |
    solver_reports_contradiction[sqr] implies
      (some f : Pipeline.findings' - Pipeline.findings |
        f.findingType = Contradiction and
        f.severity = obligationToSeverity[maxObligation[sqr.unsatCore]]))
}

// Safety: advisory-only cores never produce error severity
assert advisory_only_not_error {
  always (all sqr : SpecQueryResult |
    (solver_reports_contradiction[sqr] and
     no c : sqr.unsatCore | c.obligation = Mandatory)
    implies
      (all f : Pipeline.findings' - Pipeline.findings |
        f.findingType = Contradiction implies f.severity != ErrorSev))
}

// Safety: sat result never produces global contradiction finding
assert sat_no_global_contradiction {
  always (all sqr : SpecQueryResult |
    solver_sat_deeper[sqr] implies
      no f : Pipeline.findings' - Pipeline.findings | f.findingType = Contradiction)
}

// Safety: inconclusive results never masquerade as success
assert inconclusive_never_silent {
  always (all sqr : SpecQueryResult |
    solver_inconclusive[sqr] implies
      some f : Pipeline.findings' - Pipeline.findings | f.findingType = Inconclusive)
}

// Safety: solver errors are surfaced explicitly
assert solver_error_surfaced {
  always (all sqr : SpecQueryResult |
    solver_error_found[sqr] implies
      some f : Pipeline.findings' - Pipeline.findings |
        f.findingType = SolverErrType and f.severity = ErrorSev)
}
```

### Requirement: Pairwise Guard-Activation Contradiction Checking [FLA-PAIRWISE]
WHEN the global satisfiability check for a spec group returns sat, THE spec-check tool SHALL extract conditional assertions (implications of the form `(=> guard consequent)`), SHALL identify pairs from different claims, SHALL check each pair by forcing both guards active and asserting both consequents simultaneously, SHALL emit a `logic.conditional_contradiction` finding when the resulting query is unsatisfiable, and SHALL surface any pairwise `timeout` or `unknown` verdicts as one aggregated `logic.inconclusive` warning carrying counts and sampled claim IDs.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Conditional Contradiction Detected [FLA-PAIRWISE-CONTRA]
WHEN two claims from the same spec have conditional assertions whose guards can coexist but whose consequents conflict (the combined query of both guards and both consequents is unsatisfiable), THE spec-check tool SHALL emit a `logic.conditional_contradiction` finding identifying both claims and their respective guards.

**Postcondition:** Contradictions hidden by vacuous truth in the global check are surfaced with specific guard and claim evidence.

##### Evidence
- Implementation: [logic-analysis-checks.ts:218 runPairwiseContradictionChecks()](/src/domain/formal/logic-analysis-checks.ts#L218), [logic-analysis-checks.ts:361 checkPairContradiction()](/src/domain/formal/logic-analysis-checks.ts#L361)
- Test: [logic-analysis.test.ts:339 sat with conditional assertions from different claims triggers pairwise checks](/test/contract/logic-analysis.test.ts#L339)
- Test (integration): [z3-smtlib.integration.test.ts:149 conditional contradiction detected by pairwise check (guards forced)](/test/integration/z3-smtlib.integration.test.ts#L149)

#### Scenario: Compatible Conditional Assertions Produce No Finding [FLA-PAIRWISE-COMPAT]
WHEN two conditional assertions have guards that can coexist and consequents that are mutually satisfiable, THE spec-check tool SHALL NOT emit a pairwise contradiction finding for that pair.

**Postcondition:** Compatible conditional rules do not produce false-positive contradiction findings.

##### Evidence
- Implementation: [logic-analysis-checks.ts:361 checkPairContradiction()](/src/domain/formal/logic-analysis-checks.ts#L361)
- Test: [logic-analysis.test.ts:383 compatible conditional assertions produce no pairwise finding](/test/contract/logic-analysis.test.ts#L383)

#### Scenario: Pairwise Check Bounded By Pair Count [FLA-PAIRWISE-BOUND]
WHEN the number of candidate pairs exceeds the configured `--pair-budget` (default 200), THE spec-check tool SHALL check only up to the limit, SHALL cap pairwise Z3 fan-out at `PAIRWISE_SOLVER_CONCURRENCY` (`3`), and SHALL NOT block indefinitely on quadratic pair explosion. The `--pair-budget` controls pairwise bounds for both specs-forward guard-activation checks and code-backwards cross-side implication checks.

**Postcondition:** Pairwise analysis completes in bounded time regardless of claim count, and with the one concurrent completeness query the per-group deeper-check solver peak remains `4` and the global peak remains bounded by group concurrency.

##### Evidence
- Implementation: [logic-analysis-checks.ts:218 runPairwiseContradictionChecks()](/src/domain/formal/logic-analysis-checks.ts#L218)
- Test: [logic-analysis.test.ts:420 pairwise checks bounded by pair count limit](/test/contract/logic-analysis.test.ts#L420)

#### Scenario: Severity Derived From Paired Claims [FLA-PAIRWISE-SEV]
WHEN the spec-check tool emits a pairwise contradiction finding, THE severity SHALL be derived from the highest obligation level among the two conflicting claims (mandatory → error, advisory → warning, informational → info).

**Postcondition:** Pairwise contradiction severity is consistent with the obligation-aware severity model used by the global contradiction check.

##### Evidence
- Implementation: [logic-analysis-sexpr.ts:402 deriveSeverityFromClaims()](/src/domain/formal/logic-analysis-sexpr.ts#L402)
- Test: [logic-analysis.test.ts:339 sat with conditional assertions from different claims triggers pairwise checks](/test/contract/logic-analysis.test.ts#L339)

#### Requirement model

```alloy
// --- Pairwise guard-activation: conditional contradiction detection ---

sig PairwiseCheck {
  pairAssertion1 : one Assertion,
  pairAssertion2 : one Assertion,
  pairResult : one SolverResult
}

// Pairwise checks involve conditional assertions from different claims
fact pairwise_wellformed {
  all pc : PairwiseCheck {
    pc.pairAssertion1.kind = Conditional
    pc.pairAssertion2.kind = Conditional
    pc.pairAssertion1.sourceClaim != pc.pairAssertion2.sourceClaim
    pc.pairAssertion1.sourceClaim.spec = pc.pairAssertion2.sourceClaim.spec
  }
}

pred pairwise_contradiction [pc : PairwiseCheck] {
  // Guard: analysis phase, guards coexist but consequents conflict (unsat)
  Pipeline.phase = AnalysisPh
  pc.pairResult = Unsat
  // Effect: emit conditional_contradiction finding
  let c1 = pc.pairAssertion1.sourceClaim, c2 = pc.pairAssertion2.sourceClaim |
    some f : Finding {
      f.findingType = ConditionalContradiction
      f.severity = obligationToSeverity[maxObligation[c1 + c2]]
      f.involvedClaims = c1 + c2
      Pipeline.findings' = Pipeline.findings + f
    }
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred pairwise_compatible [pc : PairwiseCheck] {
  // Guard: consequents are mutually satisfiable (sat)
  Pipeline.phase = AnalysisPh
  pc.pairResult = Sat
  // Effect: no finding emitted
  Pipeline.findings' = Pipeline.findings
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// Safety: compatible pairs never produce false-positive contradiction findings
assert compatible_no_false_positive {
  always (all pc : PairwiseCheck |
    pairwise_compatible[pc] implies
      Pipeline.findings' = Pipeline.findings)
}

// Safety: pairwise severity consistent with obligation model
assert pairwise_severity_correct {
  always (all pc : PairwiseCheck |
    pairwise_contradiction[pc] implies
      (some f : Pipeline.findings' - Pipeline.findings |
        f.findingType = ConditionalContradiction and
        f.severity = obligationToSeverity[maxObligation[
          pc.pairAssertion1.sourceClaim + pc.pairAssertion2.sourceClaim]]))
}

// Liveness: pairwise analysis terminates (bounded by pair budget)
// The budget is a finite natural number, and each check consumes one unit.
// This is not modeled as a temporal property since the budget is static.
```

### Requirement: Completeness Gap Detection [FLA-COMPLETENESS]
WHEN the global satisfiability check for a spec group returns sat AND all assertions in the spec group are conditional (implications), THE spec-check tool SHALL negate all guards simultaneously and check satisfiability. IF the result is sat, THE tool SHALL emit a `logic.completeness_gap` warning finding indicating that there exist reachable states where no conditional rule applies and behavior is unspecified. IF the completeness query returns `timeout` or `unknown`, THE tool SHALL surface that outcome as one aggregated `logic.inconclusive` warning carrying counts and sampled claim IDs.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Gap Detected In All-Conditional Spec [FLA-COMPLETENESS-GAP]
WHEN all assertions in a spec group are conditional implications and there exists a satisfying assignment where no guard holds, THE spec-check tool SHALL emit a `logic.completeness_gap` warning finding identifying the number of guards and the affected claim identifiers.

**Postcondition:** Specifications with unguarded state gaps are surfaced for reviewer attention.

##### Evidence
- Implementation: [logic-analysis-checks.ts:518 runCompletenessCheck()](/src/domain/formal/logic-analysis-checks.ts#L518)
- Test: [logic-analysis.test.ts:446 completeness gap detected when all assertions are conditional](/test/contract/logic-analysis.test.ts#L446)
- Test (integration): [z3-smtlib.integration.test.ts:173 completeness gap: all-conditional spec has unreachable states](/test/integration/z3-smtlib.integration.test.ts#L173)

#### Scenario: No Gap When Ubiquitous Assertions Exist [FLA-COMPLETENESS-UBIQ]
WHEN a spec group contains at least one unconditional (ubiquitous) assertion, THE spec-check tool SHALL skip the completeness gap check for that group.

**Postcondition:** Specs with ubiquitous rules that provide baseline coverage in all states do not produce spurious completeness gap findings.

##### Evidence
- Implementation: [logic-analysis-checks.ts:518 runCompletenessCheck()](/src/domain/formal/logic-analysis-checks.ts#L518)
- Test: [logic-analysis.test.ts:484 completeness check skipped when ubiquitous assertions exist](/test/contract/logic-analysis.test.ts#L484)

#### Scenario: Exhaustive Guards Produce No Gap Finding [FLA-COMPLETENESS-EXHAUST]
WHEN the negation of all guards is unsatisfiable (the guards are exhaustive), THE spec-check tool SHALL NOT emit a completeness gap finding.

**Postcondition:** Specifications whose conditional rules cover all reachable states are confirmed complete without false positives.

##### Evidence
- Implementation: [logic-analysis-checks.ts:518 runCompletenessCheck()](/src/domain/formal/logic-analysis-checks.ts#L518)
- Test: [logic-analysis.test.ts:516 exhaustive guards produce no completeness gap finding](/test/contract/logic-analysis.test.ts#L516)
- Test (integration): [z3-smtlib.integration.test.ts:445 exhaustive guards leave no completeness gap](/test/integration/z3-smtlib.integration.test.ts#L445)

#### Requirement model

```alloy
// --- Completeness gap detection: conditional coverage analysis ---

pred all_conditional [sp : Spec] {
  all a : Assertion | a.sourceClaim.spec = sp implies a.kind = Conditional
}

pred has_unconditional [sp : Spec] {
  some a : Assertion | a.sourceClaim.spec = sp and a.kind = Unconditional
}

// Gap check result for a spec group
abstract sig GapResult {}
one sig GapSat, GapUnsat extends GapResult {}

sig GapCheck {
  gapSpec : one Spec,
  gapResult : one GapResult
}

pred completeness_gap_detected [gc : GapCheck] {
  // Guard: analysis phase, all conditional, negated guards sat
  Pipeline.phase = AnalysisPh
  all_conditional[gc.gapSpec]
  gc.gapResult = GapSat
  // Effect: emit completeness_gap warning
  some f : Finding {
    f.findingType = CompletenessGap
    f.severity = WarningSev
    f.involvedClaims = { c : Claim | c.spec = gc.gapSpec }
    Pipeline.findings' = Pipeline.findings + f
  }
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred completeness_gap_skipped [sp : Spec] {
  // Guard: spec has unconditional assertions
  Pipeline.phase = AnalysisPh
  has_unconditional[sp]
  // Effect: no gap check, no finding
  Pipeline.findings' = Pipeline.findings
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred exhaustive_guards [gc : GapCheck] {
  // Guard: all conditional, but negated guards unsat (exhaustive)
  Pipeline.phase = AnalysisPh
  all_conditional[gc.gapSpec]
  gc.gapResult = GapUnsat
  // Effect: no gap finding
  Pipeline.findings' = Pipeline.findings
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// Safety: ubiquitous assertions skip gap check (no spurious gap findings)
assert ubiquitous_no_spurious_gap {
  always (all sp : Spec |
    completeness_gap_skipped[sp] implies
      no f : Pipeline.findings' - Pipeline.findings | f.findingType = CompletenessGap)
}

// Safety: exhaustive guards produce no gap finding
assert exhaustive_no_gap {
  always (all gc : GapCheck |
    exhaustive_guards[gc] implies
      no f : Pipeline.findings' - Pipeline.findings | f.findingType = CompletenessGap)
}

// Safety: gap detection requires all-conditional precondition
assert gap_requires_all_conditional {
  always (all gc : GapCheck |
    completeness_gap_detected[gc] implies all_conditional[gc.gapSpec])
}
```

### Requirement: Bounded Solver Timeouts [FLA-SOLVER-TIMEOUT]
WHEN the spec-check tool submits a query to `z3`, THE spec-check tool SHALL enforce a per-query timeout (default 30 seconds) and SHALL classify timeout results as inconclusive rather than as success or failure.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Query Completes Within Timeout [FLA-TIMEOUT-PASS]
WHEN the solver returns a definitive result (sat or unsat) within the per-query timeout, THE spec-check tool SHALL use the result for finding classification.

**Postcondition:** Timely solver results are used normally.

##### Evidence
- Implementation: [z3.ts:67 runZ3Query()](/src/adapters/z3.ts#L67)
- Test: [z3.test.ts:16 pipes SMT-LIB via stdin and captures stdout/stderr](/test/contract/z3.test.ts#L16), [z3.test.ts:37 classifies sat stdout as sat](/test/contract/z3.test.ts#L37), [z3.test.ts:53 classifies unsat stdout as unsat](/test/contract/z3.test.ts#L53)

#### Scenario: Query Exceeds Timeout [FLA-TIMEOUT-EXCEED]
IF the solver does not return a result within the per-query timeout, THEN THE spec-check tool SHALL terminate the query, record the timeout as evidence, and continue with remaining queries.

**Postcondition:** A single slow query does not block the entire solver analysis phase.

##### Evidence
- Implementation: [z3.ts:88 runZ3Query()](/src/adapters/z3.ts#L88)
- Test: [z3.test.ts:99 returns timeout when process timed out](/test/contract/z3.test.ts#L99), [fault-injection.test.ts:26 classifies timedOut process as timeout regardless of signal](/test/contract/fault-injection.test.ts#L26)

#### Requirement model

```alloy
// --- Bounded solver timeouts: inconclusive classification ---

// Safety: timeout is never classified as success (sat) or failure (unsat)
// Timeout always produces an Inconclusive finding, never a Contradiction
assert timeout_never_contradiction {
  always (all sqr : SpecQueryResult |
    (Pipeline.phase = AnalysisPh and sqr.globalResult = Timeout) implies
      (solver_inconclusive[sqr] implies
        no f : Pipeline.findings' - Pipeline.findings | f.findingType = Contradiction))
}

// Safety: timeout never blocks remaining analysis (pipeline continues)
assert timeout_no_block {
  always (all sqr : SpecQueryResult |
    solver_inconclusive[sqr] implies Pipeline.phase' != AbortedPh)
}

// Liveness: every query eventually resolves (completes or times out)
// Guaranteed by the timeout mechanism: no query runs longer than the budget.
```

### Requirement: Solver Evidence Persistence [FLA-SOLVER-PERSIST]
WHEN the spec-check tool runs solver analysis, THE spec-check tool SHALL persist all solver inputs (combined per-spec SMT-LIB files) and outputs (stdout including unsat core, stderr, exit classification) verbatim under the output directory with one artifact set per spec group.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Sat Result Persisted [FLA-PERSIST-SAT]
WHEN a per-spec solver query returns sat, THE spec-check tool SHALL persist the combined SMT-LIB input file and the solver stdout/stderr.

**Postcondition:** The satisfiable result is available for reviewer inspection.

##### Evidence
- Implementation: [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:182 persists SMT-LIB input, stdout, stderr for each spec group](/test/contract/logic-analysis.test.ts#L182)

#### Scenario: Unsat Core Persisted [FLA-PERSIST-UNSAT]
WHEN a per-spec solver query returns unsat, THE spec-check tool SHALL persist the combined SMT-LIB input file, the solver stdout (containing the unsat core), and the solver stderr.

**Postcondition:** The contradictory assertion subset (unsat core) is available for reviewer inspection and maps back to specific claims via named assertion labels.

##### Evidence
- Implementation: [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:182 persists SMT-LIB input, stdout, stderr for each spec group](/test/contract/logic-analysis.test.ts#L182)

#### Requirement model

```alloy
// --- Solver evidence persistence: all inputs and outputs persisted ---

// Safety: every solver analysis event persists evidence for the spec
assert all_queries_persisted {
  always (all sqr : SpecQueryResult |
    (solver_reports_contradiction[sqr] or solver_inconclusive[sqr] or
     solver_sat_deeper[sqr] or solver_error_found[sqr])
    implies sqr.querySpec in Pipeline.evidence')
}

// Safety: unsat results always have a non-empty unsat core
assert unsat_has_core {
  all sqr : SpecQueryResult |
    sqr.globalResult = Unsat implies some sqr.unsatCore
}
```

### Requirement: Shared Semantic Logical-File Grouping [FLA-SEMANTIC-GROUPING]
WHEN the spec-check tool groups formalizable claims (claims with `kind` equal to `requirement` or `scenario`) for formalization or for solver analysis, THE spec-check tool SHALL derive each claim's semantic grouping key from one shared key helper, where a capability-bearing claim keys to the mapped merged capability `logicalFile` or to the synthetic fallback `<merged-spec/{capability}>` when unmapped, and a capability-less claim keys to its `claim.provenance.file`. Semantic keys SHALL be compared by exact string equality without normalization, logical groups SHALL be ordered by first occurrence of the semantic key in eligible-claim order, and claims within each logical group SHALL preserve eligible input order.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Domain Model`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Interface Contracts`

#### Requirement model

The base module models shared key selection, grouping partition, fallback totality, phase parity, and the cross-layer constraint that physical batches stay within one logical group. First-occurrence ordering remains a sequence-level test obligation outside the model.

#### Scenario: Mapped Capability Groups By Logical File [FLA-SEMGRP-MAPPED]
WHEN a formalizable claim carries a capability that is present in the logical-file map, THE spec-check tool SHALL group that claim under the mapped `logicalFile` value.

**Postcondition:** The claim's semantic key equals the mapped `logicalFile` string exactly.

#### Scenario: Capability-Less Claim Groups By Provenance File [FLA-SEMGRP-PROVENANCE]
WHEN a formalizable claim has no capability, THE spec-check tool SHALL group that claim under its `claim.provenance.file` string, stored verbatim without normalization or resolution.

**Postcondition:** The claim's semantic key equals its provenance file string exactly.

#### Scenario: Unmapped Capability Uses Synthetic Fallback [FLA-SEMGRP-FALLBACK]
WHEN a formalizable claim carries a capability that is absent from the logical-file map (including when the map is empty), THE spec-check tool SHALL group that claim under the synthetic key `<merged-spec/{capability}>`.

**Postcondition:** Capability-bearing claims never fall back to provenance-file grouping merely because the map lacks an entry.

#### Scenario: Historical File Grouping Is Emergent Only [FLA-SEMGRP-EMERGENT]
WHEN the semantic keys of the input claims equal their provenance files, THE spec-check tool SHALL produce groups identical to historical file grouping as an emergent outcome, and SHALL NOT provide file grouping as a selectable mode.

**Postcondition:** There is exactly one production grouping path; legacy-style grouping is an output equivalence, not a configuration.

#### Scenario: Requirements And Scenarios Share Grouping Semantics [FLA-SEMGRP-KINDS]
WHEN a logical group contains both requirement claims and scenario claims, THE spec-check tool SHALL compute their semantic keys with the same shared key helper and SHALL place them in the same logical group when their keys are equal.

**Postcondition:** Requirement and scenario claims with equal semantic keys are never split into separate logical groups by kind.

#### Scenario: Grouping Map Covers All Eligible Capabilities [FLA-SEMGRP-COVERAGE]
WHEN the grouping map is constructed from active merged specs and an eligible claim carries a capability, THE map SHALL contain an entry for that capability, or the claim SHALL receive the synthetic fallback key `<merged-spec/{capability}>`.

**Postcondition:** No capability-bearing claim ever fails to obtain a deterministic semantic key.

#### Scenario: Solver And Formalization Grouping Parity [FLA-SEMGRP-PARITY]
WHEN solver grouping and formalization grouping process the same claims after the same explicit pre-grouping filtering, THE spec-check tool SHALL produce the same semantic key for the same claim inputs in both phases.

**Postcondition:** No key drift exists between formalization groups and solver groups.

#### Scenario: Deterministic Group And Claim Ordering [FLA-SEMGRP-ORDER]
WHEN the spec-check tool forms logical groups, THE groups SHALL be ordered by first occurrence of each semantic key in eligible-claim order, and the claims inside each group SHALL preserve eligible input order.

**Postcondition:** Identical eligible inputs always produce identically ordered groups and group members.

### Requirement: Deterministic Physical Sub-Batching [FLA-SUBBATCH]
WHILE `maxBatchSize` is resolved from `--max-batch-size`, the config file `maxBatchSize`, or the built-in default of `32`, WHEN the spec-check tool forms first-sample physical batches from one logical group, THE spec-check tool SHALL split the group by pure, deterministic, stable slicing such that `maxBatchSize` of `0` yields exactly one physical batch per logical group regardless of group size (unbounded), `maxBatchSize` of `1` yields single-claim inline batches, and `maxBatchSize` greater than `1` yields chunks of size at most `maxBatchSize`, and sub-batching SHALL never change a claim's semantic key. The default of `32` bounds each attached `formalizations` response below the model output-token threshold that otherwise truncates the JSON into `invalid_json` and forces a full per-claim inline fallback.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Scope`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Component Design`

#### Requirement model

The base module models claim partition across physical batches and checks `batches_within_one_group`; numeric chunk bounds, stable slicing order, and `maxBatchSize` validation remain test obligations outside the model.

#### Scenario: Explicit Zero Disables Splitting [FLA-SUBBATCH-ZERO]
WHEN `maxBatchSize` is `0` (an explicit opt-in, not the default), THE spec-check tool SHALL issue exactly one first-sample physical batch per logical group regardless of how many claims the group contains.

**Postcondition:** No physical sub-batching occurs, and the single chunk is unbounded in size.

#### Scenario: Default Caps Batch Size [FLA-SUBBATCH-DEFAULT]
WHEN `maxBatchSize` is not provided by CLI flag or config file, THE spec-check tool SHALL use the default of `32`, so a logical group larger than `32` claims is split into chunks of size at most `32` and a group of `32` or fewer claims stays a single batch.

**Postcondition:** Physical sub-batching is bounded by default; the unbounded single-chunk behavior requires an explicit `maxBatchSize` of `0`.

#### Scenario: Single-Claim Batches When Size One [FLA-SUBBATCH-ONE]
WHEN `maxBatchSize` is `1`, THE spec-check tool SHALL issue every first-sample physical batch as a single-claim inline call.

**Postcondition:** No multi-claim attached batches are issued.

#### Scenario: Stable Chunk Sizes [FLA-SUBBATCH-CHUNKS]
WHEN `maxBatchSize` is `5` and a logical group contains 12 claims, THE spec-check tool SHALL produce physical sub-batches of sizes `[5, 5, 2]` in stable claim order.

**Postcondition:** Chunk sizes never exceed `maxBatchSize`, chunk sizes sum to the group size, and claim order is preserved.

#### Scenario: Invalid Batch Size Rejected [FLA-SUBBATCH-INVALID]
IF `maxBatchSize`, `samplesPerClaim`, or `concurrency` is not a safe integer within its domain (`maxBatchSize >= 0`; `samplesPerClaim >= 1`; `concurrency >= 1`), THEN THE spec-check tool SHALL reject the input with `err(readonly FormalizationError[])` before any LLM or filesystem work.

**Postcondition:** Negative, `NaN`, infinite, or fractional control values never reach grouping, sub-batching, or `mapBounded`.

### Requirement: File-Attached Batch Context Transport [FLA-ATTACH-TRANSPORT]
WHEN a first-sample physical batch contains two or more claims, THE spec-check tool SHALL attach a deterministic JSON context file to the LLM invocation instead of embedding claim bodies in the prompt, and WHEN a first-sample attempt contains exactly one claim, THE spec-check tool SHALL use the inline prompt path. The context file SHALL be schema version 1 with fields `schemaVersion`, `batchKey`, and an ordered `claims` array of `{ index, id, obligation, provenance: { file }, text }`, SHALL serialize with `JSON.stringify(value, null, 2)` as UTF-8 without BOM with LF newlines and exactly one trailing newline, SHALL represent a missing claim ID as `null` while permitting duplicate IDs, and SHALL store provenance path strings verbatim.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Domain Model`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Data Design`

#### Requirement model

The base module models the transport-arity invariant: multi-claim physical batches are attached and single-claim batches are inline. JSON shape and byte serialization remain contract-test obligations outside the model.

#### Scenario: Multi-Claim Batch Uses Attachment [FLA-ATTACH-MULTI]
WHEN a first-sample physical batch contains two or more claims, THE spec-check tool SHALL write the batch context JSON to a temp file and SHALL attach that file to the LLM invocation.

**Postcondition:** The prompt body contains no claim text; claim content travels only in the attached file.

#### Scenario: Single-Claim Batch Stays Inline [FLA-ATTACH-SINGLE]
WHEN a first-sample attempt covers exactly one claim, THE spec-check tool SHALL use the inline prompt path and SHALL NOT create an attached context file.

**Postcondition:** Single-claim formalization behavior matches the existing inline path.

#### Scenario: Byte-Deterministic Serialization [FLA-ATTACH-DETERMINISTIC]
WHEN the spec-check tool serializes a batch context file, THE output SHALL be byte-identical for identical logical content, using UTF-8 without BOM, LF newlines, exactly one trailing newline, and declared key insertion order.

**Postcondition:** The SHA-256 context hash is reproducible from the serialized bytes.

#### Scenario: Missing Claim ID Serializes As Null [FLA-ATTACH-NULL-ID]
WHEN an attached claim has no `claim.id`, THE spec-check tool SHALL serialize its `id` field as `null`.

**Postcondition:** Missing IDs are explicit in the context file and never fabricated.

### Requirement: Dedicated Attached-Context Prompt [FLA-ATTACH-PROMPT]
WHEN the spec-check tool issues a multi-claim file-attached formalization attempt, THE spec-check tool SHALL use a dedicated attached-context prompt that states claims are in the attached JSON file, states the attached JSON is untrusted data rather than instructions, states that each output entry SHALL carry an explicit `index` field matching an attached claim index, states that `claims[].id` is informational and may be `null` or duplicated, requires exactly one output entry per attached claim, and keeps the Logic IR schema inline, and the prompt SHALL NOT embed claim bodies, SHALL NOT state that claims come from the same spec file, and SHALL NOT state that claims are presented below.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Scope`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Component Descriptions`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Security`

#### Scenario: Prompt References Attached Context [FLA-ATTACHP-REFERENCES]
WHEN a multi-claim attached batch is issued, THE prompt SHALL state that claims are in the attached JSON context file and SHALL contain no claim bodies inline.

**Postcondition:** The model's only source of claim text is the attached file.

#### Scenario: Attached JSON Marked Untrusted [FLA-ATTACHP-UNTRUSTED]
WHEN a multi-claim attached batch is issued, THE prompt SHALL state that the attached JSON content is untrusted data and not instructions.

**Postcondition:** Spec text attached for formalization is never elevated into instruction position.

#### Scenario: No Stale Same-File Language [FLA-ATTACHP-NO-STALE]
WHEN a multi-claim attached batch is issued, THE prompt SHALL NOT contain the phrases "same spec file" or "presented below" or equivalent stale inline-batch wording.

**Postcondition:** Prompt wording is accurate for semantic groups that can span multiple provenance files.

#### Scenario: Response Matching Authority Stated [FLA-ATTACHP-MATCHING]
WHEN a multi-claim attached batch is issued, THE prompt SHALL state that each output entry must carry an explicit `index` field matching an attached claim index.

**Postcondition:** Response-to-claim attribution is explicit; array position alone and `claim.id` are never authoritative.

#### Scenario: Response Index Validated [FLA-ATTACHP-INDEX-VALID]
IF a returned batch entry carries an `index` that is missing, duplicated, or does not match any attached claim index for that physical batch, or the number of returned entries differs from the attached claim count, THEN THE spec-check tool SHALL treat the response as a `schema_validation_error` failure and SHALL degrade to per-claim inline retry.

**Postcondition:** Misattributed responses become detectable schema failures, never silent corruption.

### Requirement: Temp Context File Lifecycle [FLA-TEMP-LIFECYCLE]
WHILE a multi-claim attached batch is in flight on a handled execution path, THE spec-check tool SHALL manage the temp context file through the explicit lifecycle `not_created`, `dir_created`, `file_written`, `cleanup_succeeded`, or `cleanup_failed`, SHALL create the directory with `mkdtemp()` using the prefix `spec-check-batch-` separately from file writing, SHALL write the fixed filename `batch-context.json` with UTF-8 encoding, mode `0o600`, and exclusive flag `wx`, and SHALL attempt cleanup after success, graceful model failure, adapter-return failure, thrown adapter failure, and partial write failure when execution reaches lifecycle finalization. THE spec-check tool SHALL NOT claim a SIGINT or SIGTERM cleanup guarantee; process termination MAY leave temp artifacts, and the absent final manifest SHALL identify the run as incomplete.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Domain Model`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Key Components`

#### Requirement model

The base module models handled temp lifecycle states, outcome-after-cleanup ordering, cleanup-terminal safety, cleanup liveness under explicit fairness, and the process-termination boundary.

#### Scenario: Successful Batch Cleans Up [FLA-TEMP-SUCCESS]
WHEN an attached batch attempt completes successfully, THE spec-check tool SHALL remove the temp context directory before returning results.

**Postcondition:** No temp context directory survives a successful attempt.

#### Scenario: Directory Creation Failure Yields Claim Errors [FLA-TEMP-DIRFAIL]
IF temp directory creation fails for a physical batch, THEN THE spec-check tool SHALL return claim-level `FormalizationError` values for every claim in that physical batch.

**Postcondition:** The failure surfaces as claim errors; no claim is silently dropped.

#### Scenario: Write Failure After Directory Creation Cleans Up [FLA-TEMP-WRITEFAIL]
IF the context file write fails after the temp directory was created, THEN THE spec-check tool SHALL attempt cleanup of the created directory before returning claim-level `FormalizationError` values for the physical batch.

**Postcondition:** A `dir_created` state never leaks when writing fails.

#### Scenario: Cleanup Failure After Partial Write Does Not Mask [FLA-TEMP-WRITEFAIL-CLEANUP]
IF cleanup after a partial write failure also fails, THEN THE spec-check tool SHALL include the cleanup failure detail without masking the original write failure.

**Postcondition:** The primary failure remains the reported cause.

#### Scenario: Thrown Adapter Failure Still Cleans Up [FLA-TEMP-THROW]
IF `callOpencode()` throws during an attached batch attempt, THEN THE spec-check tool SHALL attempt temp directory cleanup in a `finally` path and SHALL normalize the thrown failure to claim-level `FormalizationError` values.

**Postcondition:** Temp cleanup does not depend on the adapter returning normally.

#### Scenario: Cleanup Failure After Success Is A Warning [FLA-TEMP-CLEANUP-WARN]
IF cleanup fails after a successful model response, THEN THE spec-check tool SHALL record a warning `Finding` with category `formalization.temp_cleanup_failed` (provenance: batch key and sub-batch ordinal; evidence: cleanup error detail and context hash) and SHALL NOT discard the successful candidates.

**Postcondition:** Successful formalization evidence is never discarded due to cleanup failure, and the failure is diagnosable.

#### Scenario: OS Temp Unwritable Yields Claim Errors [FLA-TEMP-OSUNWRITABLE]
IF the OS temp directory is not writable and `mkdtemp()` fails, THEN THE spec-check tool SHALL return claim-level `FormalizationError` values for every claim in the physical batch.

**Postcondition:** Environment failures surface as ordinary claim errors, not crashes.

#### Scenario: Outcomes Assigned After Cleanup Terminal State [FLA-TEMP-ORDER]
WHEN an attached batch attempt resolves (success, model failure, or infrastructure failure), THE spec-check tool SHALL assign claim outcomes only after the temp lifecycle reaches a terminal cleanup state (`cleanup_succeeded` or `cleanup_failed`). IF no temp directory was created (directory creation failure), THEN claim errors MAY be assigned immediately since no cleanup is owed.

**Postcondition:** On handled paths, the temp lifecycle always precedes outcome assignment when a directory exists. Process termination can bypass this postcondition and is governed by [FLA-TEMP-TERMINATION]; any already finalized evidence audits attempts but does not prove completion.

#### Scenario: Process Termination May Leave Temp Artifacts [FLA-TEMP-TERMINATION]
IF the process terminates before an attached batch lifecycle reaches its handled `finally` path, THEN THE spec-check tool MAY leave the temp directory or context file and SHALL NOT leave a final manifest that implies successful completion.

**Postcondition:** No cleanup guarantee is attributed to SIGINT, SIGTERM, or other process termination; manifest absence distinguishes the incomplete run from success.

### Requirement: Graceful Degradation By Adapter Error Kind [FLA-DEGRADE-KIND]
WHEN a multi-claim attached batch attempt fails with a terminal adapter error (an `OpencodeError.kind` returned after the adapter's internal retry budget is exhausted), THE spec-check tool SHALL select per-claim handling from the existing taxonomy without introducing new public error categories: `timeout`, `invalid_json`, and `schema_validation_error` SHALL degrade to bounded per-claim inline retry; `spawn_error`, `invalid_files`, and `invalid_timeout` SHALL produce claim-level `FormalizationError` values for the affected physical batch with no per-claim fallback; and `prompt_too_large` SHALL degrade only when every per-claim inline prompt (inline template plus claim text, measured in UTF-8 bytes) fits the adapter prompt-size limit, and SHALL otherwise produce claim-level errors immediately.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Scope`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Interface Contracts`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Failure Mode Analysis`

#### Requirement model

The base module models terminal model, infrastructure, and transport resolutions, conditional `prompt_too_large` degradation, and bounded-path assignment to candidate or claim-error outcomes.

#### Scenario: Batch Timeout Degrades Per Claim [FLA-DEGRADE-TIMEOUT]
IF an attached batch attempt fails with `timeout`, THEN THE spec-check tool SHALL retry each claim of that physical batch individually through the inline path.

**Postcondition:** Smaller work is attempted before claims are declared failed.

#### Scenario: Invalid JSON Degrades Per Claim [FLA-DEGRADE-JSON]
IF an attached batch attempt fails with `invalid_json`, THEN THE spec-check tool SHALL retry each claim of that physical batch individually through the inline path.

**Postcondition:** Model response failures consume the existing bounded retry budget per claim.

#### Scenario: Schema Validation Error Degrades Per Claim [FLA-DEGRADE-SCHEMA]
IF an attached batch attempt fails with `schema_validation_error`, THEN THE spec-check tool SHALL retry each claim of that physical batch individually through the inline path.

**Postcondition:** Model response failures consume the existing bounded retry budget per claim.

#### Scenario: Spawn Error Does Not Degrade [FLA-DEGRADE-SPAWN]
IF an attached batch attempt fails with `spawn_error`, THEN THE spec-check tool SHALL produce claim-level `FormalizationError` values for every claim in the physical batch and SHALL NOT attempt per-claim fallback.

**Postcondition:** OS/process boundary failures are not retried per claim.

#### Scenario: Invalid Files Does Not Degrade [FLA-DEGRADE-FILES]
IF an attached batch attempt fails with `invalid_files`, THEN THE spec-check tool SHALL produce claim-level `FormalizationError` values for every claim in the physical batch and SHALL NOT attempt per-claim fallback.

**Postcondition:** Attachment validation failures surface immediately as claim errors.

#### Scenario: Invalid Timeout Does Not Degrade [FLA-DEGRADE-INVTIMEOUT]
IF an attached batch attempt fails with `invalid_timeout`, THEN THE spec-check tool SHALL produce claim-level `FormalizationError` values for every claim in the physical batch and SHALL NOT attempt per-claim fallback.

**Postcondition:** Invalid invocation options are never retried.

#### Scenario: Prompt Too Large Degrades Conditionally [FLA-DEGRADE-TOOLARGE]
IF an attached batch attempt fails with `prompt_too_large`, THEN THE spec-check tool SHALL degrade to per-claim inline calls only when every per-claim inline prompt (inline template plus that claim's text, measured in UTF-8 bytes) fits the adapter prompt-size limit, and SHALL otherwise produce claim-level `FormalizationError` values for the physical batch without attempting any fallback call.

**Postcondition:** Fallback is attempted only when it can succeed; no budget is spent on fallback calls guaranteed to fail.

### Requirement: Claim Partition And Terminal Outcomes [FLA-CLAIM-PARTITION]
UNDER all handled failure modes, THE spec-check tool SHALL deliver every eligible claim (claims with `kind` equal to `requirement` or `scenario`) to exactly one terminal formalization outcome. Let `E` be the set of eligible claim indexes, `C` the set of candidate indexes, and `R` the set of explicit claim-level `FormalizationError` indexes. THE spec-check tool SHALL maintain `C ⊆ E`, `R ⊆ E`, `C ∩ R = ∅`, and `C ∪ R = E`. No eligible claim SHALL be lost or assigned both outcomes because of grouping, sub-batching, temp-file failure, invalid attachments, model-response failure, graceful degradation, additional-sample failure, or worker-thrown failures.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Failure Mode Analysis`

#### Requirement model

The base module models stable, disjoint physical-batch claim partition, stable terminal outcomes, and eventual candidate-or-claim-error assignment under handled-execution fairness.

#### Scenario: Worker Failure Drops No Claims [FLA-PARTITION-WORKER]
IF a `mapBounded` worker throws while processing a physical batch, THEN THE spec-check tool SHALL convert the failure into claim-level errors for every claim of the affected physical batch, and sibling physical batches SHALL continue processing.

**Postcondition:** Every eligible claim in the failed batch reaches a terminal outcome, and one batch's failure never abandons unstarted claims in other batches.

#### Scenario: Single-Claim Thrown Adapter Failure Normalized [FLA-PARTITION-THROW]
IF the adapter throws during a single-claim inline attempt, THEN THE spec-check tool SHALL catch the thrown value as `unknown` and SHALL normalize it to a claim-level `FormalizationError`.

**Postcondition:** Thrown infrastructure failures become ordinary claim outcomes.

#### Scenario: All-Error Output Aborts Pipeline [FLA-PARTITION-ABORT]
IF formalization returns zero candidates and one or more errors, THEN THE spec-check tool SHALL abort the run with `PipelineAbortError("FormalizationError", ...)` at the CLI boundary.

**Postcondition:** Existing abort behavior for total formalization failure is preserved.

#### Scenario: Additional-Sample Failure Preserves Candidate [FLA-PARTITION-ADDITIONAL-WARN]
IF a claim already has a valid candidate and a later additional-sample attempt fails or exhausts its bounded retry budget, THEN THE spec-check tool SHALL preserve the candidate and all samples already collected, SHALL emit a warning finding describing the sample shortfall, and SHALL NOT emit a claim-level `FormalizationError` for that additional-sample failure.

**Postcondition:** The claim remains in `C` and not in `R`; additional sampling can reduce confidence but cannot revoke a valid candidate or violate the disjoint partition.

### Requirement: Original Eligible Index Is Authoritative Identity [FLA-IDENTITY-INDEX]
THE spec-check tool SHALL use the original eligible index (the stable zero-based index of a formalizable claim in eligible-claim order) or claim object identity as the authoritative internal identity for grouping, sub-batching, response matching, and additional-sample merging, and SHALL NOT use `claim.id` alone as internal identity because IDs can be missing or duplicated.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Interface Contracts`

#### Scenario: Duplicate IDs Do Not Merge Samples [FLA-IDENTITY-DUP]
WHEN two distinct claims share the same `claim.id` and `samplesPerClaim` is greater than `1`, THE spec-check tool SHALL merge additional samples per claim using original eligible index or object identity so that samples never merge into the wrong candidate.

**Postcondition:** Duplicate IDs cannot corrupt candidate identity.

#### Scenario: Missing IDs Do Not Merge Samples [FLA-IDENTITY-MISSING]
WHEN one or more claims lack `claim.id` and `samplesPerClaim` is greater than `1`, THE spec-check tool SHALL merge additional samples per claim using original eligible index or object identity.

**Postcondition:** Missing IDs are ordinary input, not an identity hazard.

#### Scenario: Output Carries Claim Attribution [FLA-IDENTITY-ORDER]
WHEN formalization emits candidates and errors, THE spec-check tool SHALL emit them in eligible input order where practical, and SHALL otherwise attach explicit claim/index identity to each output so downstream consumers and tests never assume array order.

**Postcondition:** Output attribution is always recoverable independent of emission order.

### Requirement: Batch Attempt Evidence Preservation [FLA-BATCH-EVIDENCE]
WHEN the spec-check tool performs a formalization invocation, THE spec-check tool SHALL produce one `FormalizationAttemptSet` envelope containing schema version, an invocation `claimSet`, and the invocation's attached attempt entries. The `claimSet` SHALL be either `specs_forward` or `generated_spec` with a zero-based invocation ordinal and capability. Each attempt entry SHALL contain batch key, ordered claim indexes local to that `claimSet`, claim IDs when present, claim provenance files, the SHA-256 hash over the exact serialized UTF-8 context bytes, prompt variant/version, model, the physical sub-batch ordinal within the logical group, the response/failure classification, and the cleanup outcome. Evidence SHALL NOT duplicate claim text; each envelope SHALL be persisted as a separate atomically finalized evidence file.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Domain Model`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Data Design`

#### Requirement model

The base module checks that evidence is recorded for every attached attempt reaching a terminal resolution. Invocation envelopes, hashes, atomic file persistence, and manifest semantics remain evidence-contract obligations outside the model.

#### Scenario: Attempt Metadata Is Complete [FLA-EVIDENCE-METADATA]
WHEN an attached batch attempt terminates in any handled state, THE preserved evidence SHALL include the enclosing envelope's schema version and `claimSet`, plus the attempt's batch key, ordered claim-set-local indexes, claim IDs when present, provenance files, context SHA-256, prompt variant/version, model, sub-batch ordinal, response/failure classification, and cleanup outcome.

**Postcondition:** Every attached attempt is auditable without the temp file.

#### Scenario: Hash Covers Exact Serialized Bytes [FLA-EVIDENCE-HASH]
WHEN the spec-check tool computes the context hash, THE hash SHALL be SHA-256 over the exact UTF-8 serialized bytes of the context file.

**Postcondition:** The hash is reproducible from the deterministic serialization.

#### Scenario: Deleted Context Is Byte-Reconstructable [FLA-EVIDENCE-RECONSTRUCT]
WHEN a temp context file has been deleted, selecting the claim array identified by the enclosing `FormalizationAttemptSet.claimSet`, resolving the recorded local indexes only against that claim array, rebuilding the context object, and re-serializing deterministically SHALL yield bytes whose SHA-256 equals the recorded context hash.

**Postcondition:** Auditability survives temp-file deletion without duplicating claim text, and indexes from one invocation are never resolved against another invocation's claim set.

#### Scenario: Attempt Evidence Does Not Mark Completion [FLA-EVIDENCE-NOT-COMPLETE]
IF a run fails or the process terminates after one or more `FormalizationAttemptSet` files are atomically finalized, THEN those files MAY remain and SHALL NOT imply successful run completion.

**Postcondition:** Attempt evidence audits work performed; only a successful final manifest marks completion.

### State machine and invariant checks

```alloy
// ============================================================
// FAILURE MODES — Explicit predicates with guard/effect/frame
// ============================================================
//
// Each failure mode is modeled as a named predicate with:
//   - Guard: phase and condition that triggers the failure
//   - Effect: state changes (phase transition, findings, exit code)
//   - Frame: all mutable relations not affected are preserved
//
// FM-1: Total formalization failure -> abort with exit code 2
// (Already modeled above as formalize_abort)
//
// FM-2: Partial formalization failure -> continue with available candidates
// (Already modeled above as formalize_partial)
//
// FM-3: Schema validation failure -> exclude bad sample, preserve as evidence
// (Already modeled above as validate_reject)
//
// FM-4: Signature conflicts -> exclude conflicting claim, emit merge_conflict
// (Already modeled above as emit_merge_conflict)
//
// FM-5: Clustering ambiguity -> emit ambiguity finding, no representative
// (Already modeled above as cluster_divergent)
//
// FM-6: Solver timeout -> classify as inconclusive, emit warning, continue
// (Already modeled above as solver_inconclusive)
//
// FM-7: Solver error -> emit solver_error finding, persist evidence
// (Already modeled above as solver_error_found)

// FM-8: Pair budget exhaustion -> stop checking, bounded termination
pred pair_budget_exhausted {
  // Guard: analysis phase, pairwise checks in progress
  Pipeline.phase = AnalysisPh
  // Effect: no additional pairwise findings emitted (budget spent)
  // The pipeline continues to the next analysis step
  Pipeline.findings' = Pipeline.findings
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// FM-9: Logical key collision -> abort pipeline before writing artifacts
// (Already modeled above as collision_aborts_pipeline)

// --- Compile-group preflight (FM-11, FM-12) ------------------------------
// A compile group is the set of surviving claims for one merged capability
// that the orchestrator preflights BEFORE combined SMT-LIB compilation and
// before any solver invocation. Preflight rejection is a genuinely distinct
// failure mode from merge-conflict exclusion (emit_merge_conflict): it emits
// a `logic.invalid_group` finding (modeled by the InvalidGroup finding type),
// skips compilation AND the solver for that group, and writes no solver
// artifacts/evidence for it [FLA-SPEC-DUPLICATE-CLAIM-ID, FLA-SPEC-GROUP-BOUNDS].
sig CompileGroup {
  groupSpec  : one Spec,
  members    : set Claim,
  oversized  : one Bool     // group- or per-claim cardinality bound exceeded
} {
  some members
  all c : members | c.spec = groupSpec
}

// A group has a duplicate-identity collision when two distinct member claims
// share one sanitized claimId.
pred hasDuplicateClaimId [g : CompileGroup] {
  some disj c1, c2 : g.members | c1.claimId = c2.claimId
}

// A group is well-formed for the solver: distinct claim identities and within
// cardinality bounds.
pred groupPreflightOk [g : CompileGroup] {
  not hasDuplicateClaimId[g]
  g.oversized = False
}

// Shared rejection effect: emit one InvalidGroup finding over the group's
// members, skip the solver (no evidence persisted for the group), and leave
// every other pipeline relation fixed.
pred reject_invalid_group [g : CompileGroup] {
  Pipeline.phase = CompilationPh
  some f : Finding {
    f not in Pipeline.findings
    f.findingType = InvalidGroup
    f.severity = ErrorSev
    f.involvedClaims = g.members
    Pipeline.findings' = Pipeline.findings + f
  }
  // Solver skipped for this group: no evidence written for its spec on this
  // event. (Sibling groups persist their own evidence via solver_* events.)
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// FM-11: Duplicate claim IDs -> invalid group, skip solver [FLA-SPEC-DUPLICATE-CLAIM-ID]
pred duplicate_claim_id_rejected [g : CompileGroup] {
  hasDuplicateClaimId[g]
  reject_invalid_group[g]
}

// FM-12: Oversized compile group -> invalid group, skip solver [FLA-SPEC-GROUP-BOUNDS]
pred oversized_group_rejected [g : CompileGroup] {
  g.oversized = True
  reject_invalid_group[g]
}

// FM-13: Dangling assertion reference -> solver error [FLA-SPEC-DANGLING-REF].
// SUBSET of an already-modeled failure mode: a dangling reference (an assertion
// pointing at a declaration made undefined by merge exclusion) surfaces through
// the SAME handling as any other solver error -- a `logic.solver_error` finding
// at error severity with persisted solver input/output. Its causal origin
// (merge exclusion, an assertion-resolution detail below this model's
// abstraction) does not change the state transition, so it is covered by
// solver_error_found[sqr] above rather than duplicated as a distinct event.

// FM-14: Comment injection -> sanitization keeps mapping comments inert
// [FLA-SPEC-COMMENT-SAFE]. SUBSET / structural: this is not a distinct runtime
// transition but a pure-function invariant on compiled output, already captured
// by fact compilation_valid (art.hasMappingComments = True with an injective,
// newline-escaping sanitizer). No separate event is warranted.

// FM-15: Pairwise/completeness inconclusive -> aggregated warning
// [FLA-PAIRWISE, FLA-COMPLETENESS]. SUBSET of solver_inconclusive: aggregating
// several timeout/unknown verdicts into one `logic.inconclusive` warning is the
// same state transition as the global inconclusive case (one Inconclusive
// warning finding, evidence preserved, pipeline continues). The aggregation
// bookkeeping (counts, sampled claim IDs) is below this model's abstraction, so
// solver_inconclusive[sqr] above provides the coverage.

// --- Semantic batching: temp lifecycle and batch resolution events ---
// [FLA-TEMP-LIFECYCLE, FLA-CLAIM-PARTITION, FLA-DEGRADE-KIND, FLA-BATCH-EVIDENCE]

// Frame-condition helper: batch state unchanged
pred batch_frame [b : PhysicalBatch] {
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// Attached batch: create the temp directory (may fail, e.g. OS temp
// unwritable) [FLA-TEMP-DIRFAIL, FLA-TEMP-OSUNWRITABLE].
pred create_dir_ok [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = NotCreated
  tempState' = tempState ++ b -> DirCreated
  resolution' = resolution
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred create_dir_fail [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = NotCreated
  // Directory creation failed: transport failure, claim errors for the whole
  // physical batch. No temp dir exists, so no cleanup is owed and outcomes
  // may be assigned immediately [FLA-TEMP-ORDER].
  tempState' = tempState
  resolution' = resolution ++ b -> TransportFailure
  degraded' = degraded
  all c : b.claims |
    b.outcomes[c] = NoOutcome implies b.outcomes'[c] = ClaimErrorOutcome
  all c : b.claims |
    b.outcomes[c] != NoOutcome implies b.outcomes'[c] = b.outcomes[c]
  all c : Claim - b.claims | b.outcomes'[c] = b.outcomes[c]
  all b2 : PhysicalBatch - b, c : Claim | b2.outcomes'[c] = b2.outcomes[c]
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence + b
  Pipeline.exitCode' = Pipeline.exitCode
}

// Attached batch: write the context file (may fail after dir creation)
// [FLA-TEMP-WRITEFAIL].
pred write_file_ok [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = DirCreated
  tempState' = tempState ++ b -> FileWritten
  resolution' = resolution
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred write_file_fail [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = DirCreated
  // Write failed: transport failure; cleanup of the created directory is
  // attempted in cleanup_* events. Claim errors after cleanup completes
  // [FLA-TEMP-ORDER].
  tempState' = tempState
  resolution' = resolution ++ b -> TransportFailure
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence + b
  Pipeline.exitCode' = Pipeline.exitCode
}

// Attached batch: invoke the model with the attached context; terminal
// outcomes cover success, model failure (degradable), and infrastructure
// failure (no fallback) [FLA-DEGRADE-KIND].
pred attempt_success [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = FileWritten
  b.resolution = Unresolved
  tempState' = tempState
  resolution' = resolution ++ b -> BatchSuccess
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence + b
  Pipeline.exitCode' = Pipeline.exitCode
}

pred attempt_model_failure [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = FileWritten
  b.resolution = Unresolved
  tempState' = tempState
  resolution' = resolution ++ b -> ModelFailure
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence + b
  Pipeline.exitCode' = Pipeline.exitCode
}

pred attempt_infra_failure [b : PhysicalBatch, k : ErrorKind] {
  b.attached = Attached
  b.tempState = FileWritten
  b.resolution = Unresolved
  k in SpawnError + InvalidFiles + InvalidTimeout
  tempState' = tempState
  resolution' = resolution ++ b -> InfraFailure
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence + b
  Pipeline.exitCode' = Pipeline.exitCode
}

// Attached batch: prompt too large. Modeled as a ModelFailure whose
// degradation is gated by fallbackFits [FLA-DEGRADE-TOOLARGE].
pred attempt_prompt_too_large [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState = FileWritten
  b.resolution = Unresolved
  tempState' = tempState
  resolution' = resolution ++ b -> ModelFailure
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence + b
  Pipeline.exitCode' = Pipeline.exitCode
}

// Cleanup after a terminal attempt state. Attempted for every attached batch
// that created a directory, regardless of resolution [FLA-TEMP-LIFECYCLE].
// On success with failed cleanup, candidates are preserved (outcomes
// untouched) [FLA-TEMP-CLEANUP-WARN].
pred cleanup_succeeds [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState in DirCreated + FileWritten
  b.resolution != Unresolved
  tempState' = tempState ++ b -> CleanupSucceeded
  resolution' = resolution
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred cleanup_fails [b : PhysicalBatch] {
  b.attached = Attached
  b.tempState in DirCreated + FileWritten
  b.resolution != Unresolved
  tempState' = tempState ++ b -> CleanupFailed
  resolution' = resolution
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// Degradation and terminal outcome assignment [FLA-DEGRADE-KIND,
// FLA-CLAIM-PARTITION, FLA-TEMP-ORDER].

// Model failure degrades to per-claim inline retry when the fallback fits.
pred degrade_to_per_claim [b : PhysicalBatch] {
  b.resolution = ModelFailure
  b.degraded = NotDegraded
  b.tempState in CleanupSucceeded + CleanupFailed
  b.fallbackFits = FallbackFits
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded ++ b -> Degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// Per-claim retry resolves each claim independently to candidate or error.
pred resolve_degraded_claims [b : PhysicalBatch] {
  b.degraded = Degraded
  some c : b.claims | b.outcomes[c] = NoOutcome
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  all c : b.claims |
    b.outcomes[c] = NoOutcome implies
      (b.outcomes'[c] = CandidateOutcome or b.outcomes'[c] = ClaimErrorOutcome)
  all c : b.claims |
    b.outcomes[c] != NoOutcome implies b.outcomes'[c] = b.outcomes[c]
  all c : Claim - b.claims | b.outcomes'[c] = b.outcomes[c]
  all b2 : PhysicalBatch - b, c : Claim | b2.outcomes'[c] = b2.outcomes[c]
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// No degradation: all claims of the batch become claim errors. Applies to
// infra failure, transport failure after cleanup (or with no dir created),
// and model failure whose fallback does not fit.
pred resolve_batch_errors [b : PhysicalBatch] {
  b.degraded = NotDegraded
  some c : b.claims | b.outcomes[c] = NoOutcome
  {
    b.resolution = InfraFailure
    or (b.resolution = TransportFailure and b.tempState in CleanupSucceeded + CleanupFailed + NotCreated)
    or (b.resolution = ModelFailure and b.fallbackFits = FallbackDoesNotFit
        and b.tempState in CleanupSucceeded + CleanupFailed)
  }
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  all c : b.claims |
    b.outcomes[c] = NoOutcome implies b.outcomes'[c] = ClaimErrorOutcome
  all c : b.claims |
    b.outcomes[c] != NoOutcome implies b.outcomes'[c] = b.outcomes[c]
  all c : Claim - b.claims | b.outcomes'[c] = b.outcomes[c]
  all b2 : PhysicalBatch - b, c : Claim | b2.outcomes'[c] = b2.outcomes[c]
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// Successful batch: all claims become candidates, even if cleanup failed
// [FLA-TEMP-CLEANUP-WARN]. Outcomes assigned only after a terminal cleanup
// state [FLA-TEMP-ORDER].
pred resolve_batch_success [b : PhysicalBatch] {
  b.resolution = BatchSuccess
  b.degraded = NotDegraded
  some c : b.claims | b.outcomes[c] = NoOutcome
  b.tempState in CleanupSucceeded + CleanupFailed
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  all c : b.claims |
    b.outcomes[c] = NoOutcome implies b.outcomes'[c] = CandidateOutcome
  all c : b.claims |
    b.outcomes[c] != NoOutcome implies b.outcomes'[c] = b.outcomes[c]
  all c : Claim - b.claims | b.outcomes'[c] = b.outcomes[c]
  all b2 : PhysicalBatch - b, c : Claim | b2.outcomes'[c] = b2.outcomes[c]
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// Inline (single-claim) batch: resolve directly; no temp lifecycle.
pred resolve_inline [b : PhysicalBatch] {
  b.attached = Inline
  b.resolution = Unresolved
  tempState' = tempState
  one r : BatchSuccess + ModelFailure + InfraFailure |
    resolution' = resolution ++ b -> r
  degraded' = degraded
  outcomes' = outcomes
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred resolve_inline_outcome [b : PhysicalBatch] {
  b.attached = Inline
  b.resolution != Unresolved
  some c : b.claims | b.outcomes[c] = NoOutcome
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  all c : b.claims |
    b.outcomes[c] = NoOutcome implies
      (b.outcomes'[c] = CandidateOutcome or b.outcomes'[c] = ClaimErrorOutcome)
  all c : b.claims |
    b.outcomes[c] != NoOutcome implies b.outcomes'[c] = b.outcomes[c]
  all c : Claim - b.claims | b.outcomes'[c] = b.outcomes[c]
  all b2 : PhysicalBatch - b, c : Claim | b2.outcomes'[c] = b2.outcomes[c]
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// FM-10: JSON extraction failure -> sample rejected before schema validation
pred json_extraction_failure {
  // Guard: formalization phase, LLM response is irrecoverable
  Pipeline.phase = FormalizationPh
  // Effect: no sample created from this response (state unchanged)
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

// --- Failure mode safety assertions ---

// FM-8: pair budget exhaustion never produces false findings
assert budget_exhaustion_no_false_findings {
  always (pair_budget_exhausted implies Pipeline.findings' = Pipeline.findings)
}

// FM-9: collision abort always sets exit code 2
assert collision_abort_sets_exit_code {
  always (collision_aborts_pipeline implies Pipeline.exitCode' = 2)
}

// FM-10: JSON failures never corrupt pipeline state
assert json_failure_no_state_corruption {
  always (json_extraction_failure implies (
    Pipeline.candidates' = Pipeline.candidates and
    Pipeline.findings' = Pipeline.findings))
}

// Cross-cutting: every abort sets exit code 2
assert all_aborts_set_exit_code {
  always (Pipeline.phase' = AbortedPh implies Pipeline.exitCode' = 2)
}

// Cross-cutting: non-abort failures preserve phase
assert non_abort_failures_preserve_phase {
  always (
    (pair_budget_exhausted or json_extraction_failure)
    implies Pipeline.phase' != AbortedPh)
}

// FM-11: a duplicate-claim-id group always yields an InvalidGroup error
// finding over exactly the group's members (and, by reject_invalid_group's
// frame, persists no solver evidence -- the solver is skipped).
assert duplicate_id_rejected_with_finding {
  always (all g : CompileGroup |
    duplicate_claim_id_rejected[g] implies
      (some f : Pipeline.findings' - Pipeline.findings |
        f.findingType = InvalidGroup and f.severity = ErrorSev and
        f.involvedClaims = g.members))
}

// FM-12: an oversized group always yields an InvalidGroup error finding and
// skips the solver.
assert oversized_group_rejected_with_finding {
  always (all g : CompileGroup |
    oversized_group_rejected[g] implies
      (some f : Pipeline.findings' - Pipeline.findings |
        f.findingType = InvalidGroup and f.severity = ErrorSev and
        f.involvedClaims = g.members))
}

// FM-11/FM-12 safety: an invalid-group rejection never invokes the solver, so
// it persists no new evidence for the rejected group on that event.
assert invalid_group_skips_solver {
  always (all g : CompileGroup |
    reject_invalid_group[g] implies Pipeline.evidence' = Pipeline.evidence)
}

// FM-11 safety: a solver-bound group never carries a duplicate claim identity.
// (A well-formed group has one-to-one claim identity across its members.)
assert solver_group_ids_unique {
  all g : CompileGroup | groupPreflightOk[g] implies not hasDuplicateClaimId[g]
}

// Semantic batching safety: evidence recorded for every attached attempt
assert evidence_recorded_for_every_attached_attempt {
  always (all b : PhysicalBatch |
    (b.attached = Attached and b.resolution != Unresolved)
    implies b in Pipeline.attemptEvidence)
}

// Semantic batching safety: outcomes are stable once assigned.
// An outcome only transitions from NoOutcome to a terminal value, never back
// or between terminal values. This is DERIVED, not assumed: batch resolution
// events only rewrite claims whose outcome is NoOutcome and otherwise frame
// outcomes, and every non-batch event freezes batch state via batchStateFrozen.
// (No `fact` imposes this -- the check would fail if any event violated it.)
assert outcomes_are_stable {
  always (all b : PhysicalBatch, c : b.claims |
    b.outcomes[c] != NoOutcome implies b.outcomes'[c] = b.outcomes[c])
}

// Semantic batching safety: no cross-batch claim partition violation
assert no_cross_batch_outcomes {
  always (all disj b1, b2 : PhysicalBatch, c : Claim |
    not (c in b1.claims and c in b2.claims))
}

// Semantic batching safety: cleanup failure after success preserves candidates
assert cleanup_failure_preserves_candidates {
  always (all b : PhysicalBatch, c : b.claims |
    (b.resolution = BatchSuccess and b.outcomes[c] = CandidateOutcome)
    implies b.outcomes'[c] = CandidateOutcome)
}

// Semantic batching liveness: cleanup is attempted after every handled terminal state
pred cleanupOwed [b : PhysicalBatch] {
  b.attached = Attached
  b.resolution != Unresolved
  b.tempState in DirCreated + FileWritten
}

pred cleanupTerminal [b : PhysicalBatch] {
  b.tempState in CleanupSucceeded + CleanupFailed
}

pred cleanupFairness {
  all b : PhysicalBatch |
    (eventually always cleanupOwed[b])
    implies
    (always eventually (cleanup_succeeds[b] or cleanup_fails[b]))
}

assert cleanup_attempted_after_terminal {
  cleanupFairness implies
    always (all b : PhysicalBatch |
      cleanupOwed[b] implies eventually cleanupTerminal[b])
}

// Semantic batching liveness: every eligible claim reaches a terminal outcome
pred progressFairness {
  all b : PhysicalBatch |
    (eventually always (
      (b.attached = Attached and
        ( (b.tempState = NotCreated and b.resolution = Unresolved)
          or (b.tempState = DirCreated)
          or (b.tempState = FileWritten and b.resolution = Unresolved)
          or (b.tempState in DirCreated + FileWritten and b.resolution != Unresolved)
          or (b.degraded = Degraded and some c : b.claims | b.outcomes[c] = NoOutcome)
          or (b.degraded = NotDegraded and b.resolution != Unresolved
              and some c : b.claims | b.outcomes[c] = NoOutcome)))
      or (b.attached = Inline and
        (b.resolution = Unresolved
         or (b.resolution != Unresolved and some c : b.claims | b.outcomes[c] = NoOutcome)))
    ))
    implies
    (always eventually not stutter)
}

assert all_claims_reach_terminal_outcome {
  progressFairness implies
    always eventually (all b : PhysicalBatch, c : b.claims |
      b.outcomes[c] != NoOutcome)
}

// ============================================================
// TRANSITION SYSTEM
// ============================================================

pred advance_to_compilation {
  Pipeline.phase = ClusteringPh
  Pipeline.phase' = CompilationPh
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred advance_to_analysis {
  Pipeline.phase = CompilationPh
  not logical_key_collision
  Pipeline.phase' = AnalysisPh
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred advance_to_reporting {
  Pipeline.phase = AnalysisPh
  Pipeline.phase' = ReportingPh
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred stutter {
  batchStateFrozen
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.attemptEvidence' = Pipeline.attemptEvidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred init_state {
  Pipeline.phase = FormalizationPh
  no Pipeline.candidates
  no Pipeline.representatives
  no Pipeline.findings
  no Pipeline.evidence
  no Pipeline.attemptEvidence
  no Pipeline.exitCode
  // Semantic batching initial state
  all b : PhysicalBatch | {
    b.tempState = NotCreated
    b.resolution = Unresolved
    b.degraded = NotDegraded
  }
  all b : PhysicalBatch, c : b.claims | b.outcomes[c] = NoOutcome
}

// Frame helper: every physical batch's mutable state is frozen. Conjoined with
// each non-batch (pipeline/analysis) event so batch outcomes cannot float
// during phase, formalization, clustering, or solver transitions. This makes
// outcome stability a DERIVED property (proven from frame conditions) rather
// than an imposed fact.
pred batchStateFrozen {
  tempState' = tempState
  resolution' = resolution
  degraded' = degraded
  outcomes' = outcomes
}

fact transitions {
  init_state and always (
    // --- Pipeline / analysis events (batch state frozen) ---
    (batchStateFrozen and (
      // Formalization events (including FM-1, FM-2, FM-10)
      formalize_success or formalize_abort or formalize_partial
      or json_extraction_failure
      // Validation events (including FM-3)
      or (some s : Sample | validate_accept[s] or validate_reject[s])
      or validation_complete
      // Clustering events (including FM-5)
      or (some c : Claim, cl : Cluster | cluster_select_representative[c, cl])
      or (some c : Claim | cluster_divergent[c])
      // Compilation events (including FM-4, FM-9)
      or (some disj c1, c2 : Claim | emit_merge_conflict[c1, c2])
      or collision_aborts_pipeline
      // Phase transitions
      or advance_to_compilation or advance_to_analysis or advance_to_reporting
      // Solver analysis events (including FM-6, FM-7; FM-13 covered here)
      or (some sqr : SpecQueryResult |
          solver_reports_contradiction[sqr] or solver_inconclusive[sqr] or
          solver_sat_deeper[sqr] or solver_error_found[sqr])
      // Pairwise events (including FM-8; FM-15 aggregation covered here)
      or (some pc : PairwiseCheck | pairwise_contradiction[pc] or pairwise_compatible[pc])
      or pair_budget_exhausted
      // Completeness events
      or (some gc : GapCheck | completeness_gap_detected[gc] or exhaustive_guards[gc])
      or (some sp : Spec | completeness_gap_skipped[sp])
      // Invalid-group preflight events (FM-11, FM-12)
      or (some g : CompileGroup | duplicate_claim_id_rejected[g] or oversized_group_rejected[g])
    ))
    // --- Semantic batching: temp lifecycle and batch resolution events ---
    // (each already freezes all Pipeline relations internally)
    or (some b : PhysicalBatch | create_dir_ok[b] or create_dir_fail[b])
    or (some b : PhysicalBatch | write_file_ok[b] or write_file_fail[b])
    or (some b : PhysicalBatch |
          attempt_success[b] or attempt_model_failure[b] or attempt_prompt_too_large[b])
    or (some b : PhysicalBatch, k : ErrorKind | attempt_infra_failure[b, k])
    or (some b : PhysicalBatch | cleanup_succeeds[b] or cleanup_fails[b])
    or (some b : PhysicalBatch | degrade_to_per_claim[b])
    or (some b : PhysicalBatch |
          resolve_degraded_claims[b] or resolve_batch_errors[b] or resolve_batch_success[b])
    or (some b : PhysicalBatch | resolve_inline[b] or resolve_inline_outcome[b])
    // Stutter (required for deadlock-free infinite traces)
    or stutter
  )
}

// ============================================================
// GLOBAL SAFETY PROPERTIES
// ============================================================

// S1: Phases only advance forward (monotonic); abort is absorbing
assert phase_monotonic {
  always (Pipeline.phase = AbortedPh implies after always Pipeline.phase = AbortedPh)
}

// S2: Reporting is also absorbing (terminal state)
assert reporting_absorbing {
  always (Pipeline.phase = ReportingPh implies after always Pipeline.phase = ReportingPh)
}

// S3: Findings accumulate monotonically (never removed)
assert findings_monotonic {
  always (Pipeline.findings in Pipeline.findings')
}

// S4: Evidence accumulates monotonically (never removed)
assert evidence_monotonic {
  always (Pipeline.evidence in Pipeline.evidence')
}

// S5: Candidates accumulate monotonically during validation
assert candidates_monotonic_in_validation {
  always (Pipeline.phase = ValidationPh implies
    Pipeline.candidates in Pipeline.candidates')
}

// S6: Representatives accumulate monotonically during clustering
assert representatives_monotonic_in_clustering {
  always (Pipeline.phase = ClusteringPh implies
    Pipeline.representatives in Pipeline.representatives')
}

// S7: Pipeline reaches at most one terminal state
assert single_terminal_state {
  always (Pipeline.phase in (ReportingPh + AbortedPh) implies
    after always Pipeline.phase' = Pipeline.phase)
}

// S8: No finding can reference a claim not in the pipeline domain
assert findings_reference_valid_claims {
  always (all f : Pipeline.findings | f.involvedClaims in Claim)
}

// S9: Exit code is only set when aborting
assert exit_code_only_on_abort {
  always (some Pipeline.exitCode' implies
    (Pipeline.phase' = AbortedPh or some Pipeline.exitCode))
}

// ============================================================
// LIVENESS PROPERTIES
// ============================================================

// L1: Pipeline eventually terminates given fair scheduling
pred pipeline_fairness {
  always eventually (Pipeline.phase' != Pipeline.phase or
                     Pipeline.phase in (ReportingPh + AbortedPh))
}

assert pipeline_terminates {
  pipeline_fairness implies eventually (Pipeline.phase in (ReportingPh + AbortedPh))
}

// L2: Every submitted solver query eventually resolves
// Guaranteed by bounded timeout: no query runs longer than its budget.
pred solver_fairness {
  always (Pipeline.phase = AnalysisPh implies
    eventually Pipeline.phase != AnalysisPh)
}

assert solver_queries_resolve {
  (pipeline_fairness and solver_fairness) implies eventually (
    Pipeline.phase in (ReportingPh + AbortedPh))
}

// L3: Merged capabilities eventually produce exactly one logic group
// (given compilation phase is reached without collision)
assert merged_cap_group_formation {
  pipeline_fairness implies always (
    (Pipeline.phase = CompilationPh and not logical_key_collision)
    implies eventually Pipeline.phase = AnalysisPh)
}

// L4: Evidence is eventually persisted for every analysis event
assert evidence_eventually_persisted {
  pipeline_fairness implies always (
    Pipeline.phase = AnalysisPh implies
      eventually (Pipeline.evidence' != Pipeline.evidence or
                  Pipeline.phase != AnalysisPh))
}

// L5: Collision detection terminates finitely. Like every liveness property
// this needs a fairness premise: without it, infinite stuttering could pin the
// pipeline in CompilationPh forever (and vacuously falsify termination).
assert collision_check_terminates {
  pipeline_fairness implies always (Pipeline.phase = CompilationPh implies
    eventually (Pipeline.phase != CompilationPh))
}

// L6: Formalization phase eventually completes
pred formalization_fairness {
  always (Pipeline.phase = FormalizationPh implies
    eventually Pipeline.phase != FormalizationPh)
}

assert formalization_eventually_resolves {
  formalization_fairness implies eventually (
    Pipeline.phase in (ValidationPh + AbortedPh))
}

// L7: Pairwise analysis terminates (bounded by pair budget)
assert pairwise_terminates {
  solver_fairness implies always (
    Pipeline.phase = AnalysisPh implies
      eventually (Pipeline.phase != AnalysisPh or pair_budget_exhausted))
}

// ============================================================
// COMMANDS — Scenario exploration
// ============================================================

run show_pipeline {} for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 4 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 2 JsonExtraction, 4 JsonInput, 5 Int, 8 steps

run scenario_contradiction {
  eventually (some f : Pipeline.findings | f.findingType = Contradiction)
} for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 3 Sample, 2 Cluster, 2 Finding,
  2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion, 2 Declaration,
  2 DeclName, 2 DeclSignature, 1 CombinedSpec, 1 CompiledArtifact,
  2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 10 steps

run scenario_abort {
  eventually (Pipeline.phase = AbortedPh and Pipeline.exitCode = 2)
} for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 2 Claim, 1 Spec, 2 Sample, 1 Cluster, 1 Finding,
  1 SpecQueryResult, 0 PairwiseCheck, 1 Assertion, 1 Declaration,
  1 DeclName, 1 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact,
  1 ClaimId, 0 ImplicationResult, 0 GapCheck,
  0 LogicalGroup, 0 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 5 steps

run scenario_collision_abort {
  eventually collision_aborts_pipeline
} for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 2 Claim, 2 Spec, 2 Sample, 1 Cluster, 1 Finding,
  0 SpecQueryResult, 0 PairwiseCheck, 1 Assertion, 1 Declaration,
  1 DeclName, 1 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact,
  1 ClaimId, 0 ImplicationResult, 0 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 8 steps

run scenario_json_recovery {
  some je : JsonExtraction | je.input in MarkdownFenced and je.recovered = True
  some je : JsonExtraction | je.input in Irrecoverable and je.recovered = False
} for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 0 Claim, 0 Spec, 0 Sample, 0 Cluster, 0 Finding,
  0 SpecQueryResult, 0 PairwiseCheck, 0 Assertion, 0 Declaration,
  0 DeclName, 0 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact,
  0 ClaimId, 0 ImplicationResult, 0 GapCheck,
  0 LogicalGroup, 0 LogicalKey, 3 JsonExtraction, 4 JsonInput, 5 Int, 1 steps

run scenario_pairwise_budget {
  eventually pair_budget_exhausted
} for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 3 Sample, 2 Cluster, 2 Finding,
  1 SpecQueryResult, 2 PairwiseCheck, 3 Assertion, 2 Declaration,
  2 DeclName, 2 DeclSignature, 1 CombinedSpec, 1 CompiledArtifact,
  2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps

// Witness: without the exclusion policy a malformed combined artifact (one
// sanitized symbol bound with two sorts/kinds among included claims) is
// representable. This is the failure mode the merge fix prevents; the
// invariant-as-fact style could not exhibit it as an instance at all.
run combined_malformed_witness {
  some cs : CombinedSpec | not combined_wellformed[cs]
} for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 4 Sample, 2 Cluster, 2 Finding,
  1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion, 2 Declaration,
  2 DeclName, 2 DeclSignature, 1 CombinedSpec, 1 CompiledArtifact,
  2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 2 JsonExtraction, 4 JsonInput, 5 Int, 8 steps expect 1

// Witness: a cross-claim conflict where the later claim is excluded leaves the
// combined artifact wellformed (the intended merge outcome).
run combined_conflict_with_exclusion {
  some cs : CombinedSpec, disj c1, c2 : Claim |
    conflict_detected[c1, c2, cs.specRef] and
    c1 in cs.includedClaims and c2 in cs.excludedClaims and
    conflicts_excluded[cs] and combined_wellformed[cs]
} for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 4 Sample, 2 Cluster, 2 Finding,
  1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion, 3 Declaration,
  2 DeclName, 2 DeclSignature, 1 CombinedSpec, 1 CompiledArtifact,
  2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 2 JsonExtraction, 4 JsonInput, 5 Int, 8 steps expect 0

// Witness: a same-claim variable/function sanitizer collision (c1 = c2) is
// representable and forces that claim's own exclusion.
run same_claim_collision_witness {
  some cs : CombinedSpec, c : Claim |
    conflict_detected[c, c, cs.specRef] and c in cs.excludedClaims
} for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 4 Sample, 2 Cluster, 2 Finding,
  1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion, 2 Declaration,
  2 DeclName, 2 DeclSignature, 1 CombinedSpec, 1 CompiledArtifact,
  2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 2 JsonExtraction, 4 JsonInput, 5 Int, 8 steps expect 1

// --- Non-vacuity witnesses for the invalid-group preflight (FM-11, FM-12) ---
// Proving the guarded antecedents are reachable, so the *_with_finding checks
// above are not vacuously true.

// FM-11: a compile group with two claims sharing one claimId is representable
// and its rejection fires, emitting an InvalidGroup finding.
run duplicate_claim_id_witness {
  some g : CompileGroup | hasDuplicateClaimId[g]
  eventually (some g : CompileGroup | duplicate_claim_id_rejected[g])
} for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 2 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 2 Claim, 2 ClaimId, 1 CompileGroup, 2 Finding, 6 steps expect 1

// FM-12: an oversized compile group is representable and its rejection fires.
run oversized_group_witness {
  some g : CompileGroup | g.oversized = True
  eventually (some g : CompileGroup | oversized_group_rejected[g])
} for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 2 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 2 Claim, 2 ClaimId, 1 CompileGroup, 2 Finding, 6 steps expect 1

// --- Batch-lifecycle reachability witnesses (ported from the reference model) ---
// Each proves a distinct handled path through the temp lifecycle is reachable,
// so the batch safety/liveness checks below are not vacuously satisfied.

// A single attached batch succeeds, cleans up, and all claims become candidates.
run attached_success_witness {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = BatchSuccess
                    and b.tempState = CleanupSucceeded
                    and (all c : b.claims | b.outcomes[c] = CandidateOutcome))
} for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 2 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 2 Claim, 1 Spec, 1 ClaimId, 0 CompileGroup, 2 Finding, 0 Sample, 0 Cluster, 0 SpecQueryResult, 0 PairwiseCheck, 0 Assertion, 0 Declaration, 0 DeclName, 0 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact, 0 ImplicationResult, 0 GapCheck, 0 LogicalGroup, 0 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 10 steps expect 1

// Write failure after directory creation still reaches a terminal cleanup and
// assigns claim errors [FLA-TEMP-WRITEFAIL, FLA-TEMP-ORDER].
run write_failure_then_cleanup_witness {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = TransportFailure
                    and once b.tempState = DirCreated
                    and eventually (b.tempState = CleanupSucceeded
                                    and (all c : b.claims | b.outcomes[c] = ClaimErrorOutcome)))
} for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 2 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 2 Claim, 1 Spec, 1 ClaimId, 0 CompileGroup, 2 Finding, 0 Sample, 0 Cluster, 0 SpecQueryResult, 0 PairwiseCheck, 0 Assertion, 0 Declaration, 0 DeclName, 0 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact, 0 ImplicationResult, 0 GapCheck, 0 LogicalGroup, 0 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 1

// Cleanup failure after a successful attempt keeps candidates [FLA-TEMP-CLEANUP-WARN].
run cleanup_failure_after_success_witness {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.resolution = BatchSuccess
                    and b.tempState = CleanupFailed
                    and (all c : b.claims | b.outcomes[c] = CandidateOutcome))
} for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 2 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 2 Claim, 1 Spec, 1 ClaimId, 0 CompileGroup, 2 Finding, 0 Sample, 0 Cluster, 0 SpecQueryResult, 0 PairwiseCheck, 0 Assertion, 0 Declaration, 0 DeclName, 0 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact, 0 ImplicationResult, 0 GapCheck, 0 LogicalGroup, 0 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 1

// Model failure with a fitting fallback degrades to per-claim retry [FLA-DEGRADE-TOOLARGE].
run model_failure_degrades_witness {
  some b : PhysicalBatch |
    b.attached = Attached
    and eventually (b.degraded = Degraded and once b.resolution = ModelFailure)
} for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 2 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 2 Claim, 1 Spec, 1 ClaimId, 0 CompileGroup, 2 Finding, 0 Sample, 0 Cluster, 0 SpecQueryResult, 0 PairwiseCheck, 0 Assertion, 0 Declaration, 0 DeclName, 0 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact, 0 ImplicationResult, 0 GapCheck, 0 LogicalGroup, 0 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 14 steps expect 1

// ============================================================
// COMMANDS — Property verification (check)
// ============================================================

check abort_no_conclusions for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 2 Claim, 1 Spec, 3 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 0 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check only_valid_in_candidates for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 4 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check symmetric_implication_same_cluster for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 5 Sample, 3 Cluster,
  1 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 4 ImplicationResult, 0 GapCheck,
  0 LogicalGroup, 0 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 1 steps expect 0

check sat_no_global_contradiction for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check compatible_no_false_positive for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 3 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 2 PairwiseCheck, 3 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 10 steps expect 0

check ubiquitous_no_spurious_gap for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 3 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 10 steps expect 0

check findings_monotonic for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 3 Sample, 2 Cluster,
  3 Finding, 2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 15 steps expect 0

check phase_monotonic for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 2 Claim, 1 Spec, 3 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 15 steps expect 0

check reporting_absorbing for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 2 Claim, 1 Spec, 3 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 15 steps expect 0

check all_queries_persisted for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 3 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check timeout_never_contradiction for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 3 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check collision_implies_abort for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 2 Claim, 2 Spec, 2 Sample, 1 Cluster,
  1 Finding, 0 SpecQueryResult, 0 PairwiseCheck, 1 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 0 ImplicationResult, 0 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check all_aborts_set_exit_code for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 15 steps expect 0

check budget_exhaustion_no_false_findings for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 3 Claim, 1 Spec, 3 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 2 PairwiseCheck, 3 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check pipeline_terminates for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 2 Claim, 1 Spec, 2 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 20 steps

check solver_queries_resolve for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 2 Claim, 1 Spec, 2 Sample, 1 Cluster,
  2 Finding, 2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 20 steps

check formalization_eventually_resolves for 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 2 Claim, 1 Spec, 3 Sample, 1 Cluster,
  1 Finding, 0 SpecQueryResult, 0 PairwiseCheck, 1 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 0 ImplicationResult, 0 GapCheck,
  0 LogicalGroup, 0 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 15 steps

// ============================================================
// COMMANDS — Remaining assertion coverage (every assert is checked)
// ============================================================
// The commands above check a representative subset. The commands below close
// the gap so that ALL assertions declared in this module are machine-verified,
// preventing silent drift (four assertions previously here were only fixed
// because these checks were added). Scopes use the compact `for N` form; each
// was chosen large enough for the relevant antecedent to be reachable (the run
// scenarios above witness reachability of contradiction/abort/collision paths).

// --- Structural (pure-function) assertions: no temporal unrolling ---
check recovered_implies_valid_input for 4 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check irrecoverable_never_silent for 4 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check extraction_total for 4 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check no_checksat_in_compiled for 4 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check safe_ids_preserved for 4 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check exclusion_implies_wellformed for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check same_claim_collision_excluded for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check inconclusive_no_cluster_corruption for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check single_result_per_query for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check clusters_have_distinct_members for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check unsat_has_core for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0

// --- Temporal safety assertions: single-transition properties ---
check zero_candidates_implies_abort for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check invalid_never_in_candidates for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check divergent_produces_finding for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check no_collision_no_grouping_abort for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check group_formation_complete for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check contradiction_severity_correct for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check advisory_only_not_error for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check inconclusive_never_silent for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check solver_error_surfaced for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check pairwise_severity_correct for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check exhaustive_no_gap for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check gap_requires_all_conditional for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check timeout_no_block for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check collision_abort_sets_exit_code for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check json_failure_no_state_corruption for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check non_abort_failures_preserve_phase for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check evidence_monotonic for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check candidates_monotonic_in_validation for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check representatives_monotonic_in_clustering for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check single_terminal_state for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check findings_reference_valid_claims for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0
check exit_code_only_on_abort for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 6 steps expect 0

// --- Liveness assertions: require fairness premises (checked, no expect) ---
check merged_cap_group_formation for 2 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 12 steps
check evidence_eventually_persisted for 2 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 12 steps
check collision_check_terminates for 2 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 12 steps
check pairwise_terminates for 2 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 12 steps

// --- Semantic batching structural checks ---
check groupingPartitioned for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check parityBySharedKey for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check kindIrrelevant for 3 but 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 5 Int expect 0
check fallbackTotal for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup expect 0

// --- Semantic batching safety checks ---
check evidence_recorded_for_every_attached_attempt for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 10 steps expect 0
check outcomes_are_stable for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 10 steps expect 0
check no_cross_batch_outcomes for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 10 steps expect 0
check cleanup_failure_preserves_candidates for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 10 steps expect 0

// --- New failure-mode checks (FM-11, FM-12 invalid-group preflight) ---
check duplicate_id_rejected_with_finding for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 2 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 2 Claim, 2 ClaimId, 1 CompileGroup, 6 steps expect 0
check oversized_group_rejected_with_finding for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 2 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 2 Claim, 2 ClaimId, 1 CompileGroup, 6 steps expect 0
check invalid_group_skips_solver for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 2 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 2 Claim, 2 ClaimId, 1 CompileGroup, 6 steps expect 0
check solver_group_ids_unique for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 2 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 2 Claim, 3 ClaimId, 2 CompileGroup expect 0

// --- Semantic batching liveness (under fairness) ---
check cleanup_attempted_after_terminal for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 15 steps expect 0
check all_claims_reach_terminal_outcome for 3 but 5 Int, 1 Capability, 1 ProvFile, 1 LogicalFile, 1 SyntheticKey, 1 SemanticKey, 1 ClaimProvenance, 1 GroupingMap, 1 SemanticLogicalGroup, 1 ErrorKind, 1 FallbackFit, 1 TempState, 1 Resolution, 1 Outcome, 1 AttachedKind, 1 DegradedKind, 1 Presence, 1 MergedSpec, 1 BuiltMap, 1 PhysicalBatch, 0 CompileGroup, 20 steps
```
