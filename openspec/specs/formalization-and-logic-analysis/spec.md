---
title: FormalizationAndLogicAnalysis
---

## Purpose

Define the formalization and solver-backed logic analysis behavior for the spec-check tool: translating claims into formal artifacts, clustering alternate interpretations, and using solver-backed analysis to detect conflicts, gaps, and surprising behaviors.

```alloy
module FormalizationAndLogicAnalysis
open util/boolean

// --- Domain vocabulary ---

// A Claim is a requirement or scenario from a spec file
sig Claim {
  obligation : one Obligation,
  spec : one Spec
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
       Ambiguity, Inconclusive, MergeConflict, SolverErrType extends FindingType {}

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
sig Declaration {
  declName : one DeclName,
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
  var exitCode : lone Int                     // exit code (2 = abort)
}

// --- Structural facts (non-temporal invariants) ---

// Cluster well-formedness: respects equivalence, representative is a member
fact cluster_wellformed {
  all cl : Cluster | cl.representative in cl.members or no cl.representative
  all disj cl1, cl2 : Cluster | no (cl1.members & cl2.members)
}

// Implication results are between distinct samples of the same claim
fact implication_wellformed {
  all ir : ImplicationResult | ir.from != ir.to
  all ir : ImplicationResult | ir.from.claim = ir.to.claim
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
- Test (property): [opencode.test.ts:189 accepts prefix+json wrappers when prefix excludes braces/brackets](/test/contract/opencode.test.ts#L189)
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
- Test: [opencode.test.ts:664 throws on truncated JSON (unbalanced braces)](/test/contract/opencode.test.ts#L664), [opencode.test.ts:670 throws on input with only prose text](/test/contract/opencode.test.ts#L670)
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
WHEN requirement and scenario claims are available for formal analysis, THE spec-check tool SHALL translate each claim into a typed logic representation and generated SMT-LIB artifacts that preserve the claim identifier, source provenance, obligation level, and supporting declarations needed for solver analysis, and SHALL use the run-configured universal timeout for every external LLM formalization invocation.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Make JSON extraction tolerant but keep schema validation strict`

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
- Test: [formalize.test.ts:45 formalizeClaims produces valid candidates](/test/contract/formalize.test.ts#L45), [opencode.test.ts:403 retries on timeout up to retry limit then returns timeout error](/test/contract/opencode.test.ts#L403)

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
- Implementation: [validate.ts:52 validateFormalizationSample()](/src/domain/formal/validate.ts#L52)
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
- Implementation: [validate.ts:52 validateFormalizationSample()](/src/domain/formal/validate.ts#L52)
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
- Implementation: [smtlib.ts:134 sanitizeIdentifier()](/src/domain/formal/smtlib.ts#L134)
- Test: [smtlib.test.ts:22 sanitizes unsafe identifiers](/test/contract/smtlib.test.ts#L22)
- Test (property): [logic.property.test.ts:9 sanitized identifiers remain SMT-safe](/test/property/logic.property.test.ts#L9)
- Test (integration): [z3-smtlib.integration.test.ts:31 golden samples compile to Z3-accepted SMT-LIB](/test/integration/z3-smtlib.integration.test.ts#L31)
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
- Implementation: [smtlib.ts:134 sanitizeIdentifier()](/src/domain/formal/smtlib.ts#L134)
- Test: [smtlib.test.ts:27 compiles logic IR with mapping comments](/test/contract/smtlib.test.ts#L27)
- Test (property): [logic.property.test.ts:9 sanitized identifiers remain SMT-safe](/test/property/logic.property.test.ts#L9)
- Example:
```typescript
const { sanitizeIdentifier } = await import("./src/domain/formal/smtlib.ts");
sanitizeIdentifier("CLAIM_ID_42"); //=> CLAIM_ID_42
```

#### Scenario: Compiled Output Excludes Solver Commands [FLA-SMTLIB-QUERYSAT]
WHEN the spec-check tool compiles logic IR into SMT-LIB text, THE compiled output SHALL contain variable declarations (`declare-const`), function declarations (`declare-fun`), and assertions (`assert`) but SHALL NOT include `(check-sat)`. THE spec-check tool SHALL append `(check-sat)` at query execution time when submitting the compiled output to the solver.

**Postcondition:** Compiled SMT-LIB is a reusable component that can be composed into different query types (satisfiability, implication) without stripping embedded solver commands.

##### Evidence
- Implementation: [smtlib.ts:41 compileSmtlib()](/src/domain/formal/smtlib.ts#L41)
- Test: [smtlib.test.ts:27 compiles logic IR with mapping comments](/test/contract/smtlib.test.ts#L27), [smtlib.test.ts:45 produces a single smt2 without solver commands (callers append them)](/test/contract/smtlib.test.ts#L45)
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
- Implementation: [smtlib.ts:41 compileSmtlib()](/src/domain/formal/smtlib.ts#L41)
- Test: [smtlib.test.ts:27 compiles logic IR with mapping comments](/test/contract/smtlib.test.ts#L27)
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
- Implementation: [smtlib.ts:265 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L265)
- Test: [smtlib.test.ts:67 deduplicates identical variable declarations](/test/contract/smtlib.test.ts#L67), [smtlib.test.ts:79 deduplicates identical function declarations](/test/contract/smtlib.test.ts#L79)

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
- Implementation: [smtlib.ts:265 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L265)
- Test: [smtlib.test.ts:92 detects function signature conflicts and excludes conflicting claims](/test/contract/smtlib.test.ts#L92)

#### Scenario: Named Assertion Labels Map To Claims [FLA-SPEC-NAMED]
WHEN the spec-check tool generates named assertions in the combined SMT-LIB, THE label for each assertion SHALL encode the source claim identifier and assertion index so that unsat-core results can be mapped back to specific included claims.

**Postcondition:** The assertion-name-to-claim-ID mapping is deterministic and reversible, and `assertionNameMap` contains labels for included claims only.

##### Evidence
- Implementation: [smtlib.ts:265 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L265)
- Test: [smtlib.test.ts:56 uses named assertions with :named labels](/test/contract/smtlib.test.ts#L56), [smtlib.test.ts:107 maps assertion labels back to claim IDs](/test/contract/smtlib.test.ts#L107)
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

#### Requirement model

```alloy
// --- Per-spec combination: deduplication, conflict detection, named assertions ---

sig CombinedSpec {
  specRef : one Spec,
  includedClaims : set Claim,
  excludedClaims : set Claim,
  namedAssertions : Assertion -> one Claim
}

// Well-formedness of combined specs
fact combined_wellformed {
  all cs : CombinedSpec {
    // All claims from the spec are either included or excluded
    all c : Claim | c.spec = cs.specRef implies
      (c in cs.includedClaims or c in cs.excludedClaims)
    no (cs.includedClaims & cs.excludedClaims)
    // Deduplication: no duplicate declarations among included claims
    all disj d1, d2 : Declaration |
      (d1.declClaim in cs.includedClaims and d2.declClaim in cs.includedClaims and
       d1.declName = d2.declName) implies d1.declSig = d2.declSig
    // Named assertions map to included claims only
    all a : cs.namedAssertions.Claim | a.sourceClaim in cs.includedClaims
  }
}

pred conflict_detected [c1, c2 : Claim, sp : Spec] {
  c1.spec = sp and c2.spec = sp and c1 != c2
  some disj d1, d2 : Declaration |
    d1.declClaim = c1 and d2.declClaim = c2 and
    d1.declName = d2.declName and d1.declSig != d2.declSig
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
  Pipeline.exitCode' = Pipeline.exitCode
}

// Safety: conflicts produce findings, never malformed solver input
assert conflict_excluded_from_combined {
  all cs : CombinedSpec, disj c1, c2 : Claim |
    conflict_detected[c1, c2, cs.specRef] implies
      (c1 in cs.excludedClaims or c2 in cs.excludedClaims)
}
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
- Test: [clustering.test.ts:53 emits ambiguity finding when no cluster meets stability threshold](/test/contract/clustering.test.ts#L53), [clustering.test.ts:122 two non-equivalent samples produces two clusters](/test/contract/clustering.test.ts#L122)

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
- Test: [implication-query.test.ts:20 contains exactly one check-sat](/test/contract/implication-query.test.ts#L20), [implication-query.test.ts:31 does not directly assert right-side](/test/contract/implication-query.test.ts#L31), [implication-query.test.ts:48 encodes as assert-left + negate-right](/test/contract/implication-query.test.ts#L48)

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
- Test: [clustering.test.ts:101 mutual unsat produces single cluster](/test/contract/clustering.test.ts#L101)
- Test (property): [logic.property.test.ts:20 cluster construction is deterministic and symmetric for mutual pairs](/test/property/logic.property.test.ts#L20)
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
- Test (property): [logic.property.test.ts:20 cluster construction is deterministic and symmetric for mutual pairs](/test/property/logic.property.test.ts#L20)

#### Requirement model

```alloy
// --- Clustering properties: symmetry and determinism ---
// Symmetry is guaranteed by the structural fact clusters_respect_equivalence.
// Determinism is a meta-property: same inputs -> same clusters (enforced by
// the clustering algorithm being a deterministic function of ImplicationResults).

// Verify: mutual implication places samples in same cluster
assert symmetric_implication_same_cluster {
  all disj a, b : Sample, cl : Cluster |
    (samples_equivalent[a, b] and a in cl.members) implies b in cl.members
}

// Determinism modeled as: cluster membership is uniquely determined by members
assert clustering_deterministic {
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
- Implementation: [logic-analysis.ts:135 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L135)
- Test: [logic-analysis.test.ts:36 mandatory contradiction reported at severity error](/test/contract/logic-analysis.test.ts#L36), [logic-analysis.test.ts:181 unsat core identifies specific conflicting claims](/test/contract/logic-analysis.test.ts#L181)
- Test (integration): [z3-smtlib.integration.test.ts:75 directly contradictory bare assertions produce UNSAT](/test/integration/z3-smtlib.integration.test.ts#L75)

#### Scenario: Advisory-Only Core Reported At Lower Severity [FLA-LOGIC-ADVISORY]
WHEN the unsat core contains only advisory or informational claims with no mandatory claims, THE spec-check tool SHALL report the contradiction at warning or info severity respectively.

**Postcondition:** Contradictions among advisory claims are visible but clearly distinguished from mandatory violations.

##### Evidence
- Implementation: [logic-analysis-sexpr.ts:309 deriveSeverityFromClaims()](/src/domain/formal/logic-analysis-sexpr.ts#L309), [logic-analysis-sexpr.ts:347 obligationToSeverity()](/src/domain/formal/logic-analysis-sexpr.ts#L347)
- Test: [logic-analysis.test.ts:56 advisory-only contradiction reported at warning](/test/contract/logic-analysis.test.ts#L56), [logic-analysis.test.ts:211 severity derived from highest-obligation in core](/test/contract/logic-analysis.test.ts#L211)
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
- Implementation: [logic-analysis.ts:135 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L135)
- Test: [logic-analysis.test.ts:76 timeout/unknown result preserved as inconclusive finding](/test/contract/logic-analysis.test.ts#L76)

#### Scenario: Sat Result Triggers Deeper Analysis [FLA-LOGIC-SAT]
WHEN a per-merged-capability combined query returns sat, THE spec-check tool SHALL NOT emit a global contradiction finding for that merged capability, but SHALL proceed with pairwise guard-activation contradiction checks and completeness gap detection to identify conditional contradictions and unspecified states that the global satisfiability check cannot surface.

**Postcondition:** A globally satisfiable merged capability is not assumed free of all issues; deeper conditional analysis follows.

##### Evidence
- Implementation: [logic-analysis.ts:135 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L135)
- Test: [logic-analysis.test.ts:140 sat result does not generate contradiction finding](/test/contract/logic-analysis.test.ts#L140)

#### Scenario: Solver Error Produces Finding [FLA-LOGIC-ERROR]
IF the solver emits error diagnostics (such as `(error ...)` lines in stdout) indicating malformed input, THEN THE spec-check tool SHALL emit a `logic.solver_error` finding at error severity referencing all claims in the affected merged capability group, and SHALL persist the solver input and output as evidence.

**Postcondition:** Solver errors are surfaced as explicit findings rather than silently treated as successful analysis.

##### Evidence
- Implementation: [logic-analysis.ts:135 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L135)
- Test: [logic-analysis.test.ts:232 solver error produces logic.solver_error finding](/test/contract/logic-analysis.test.ts#L232)

### Requirement: Group Specs-Forward Logic By Merged Capability [FLA-GROUP-MERGED]
WHEN the spec-check tool prepares specs-forward logical analysis, THE spec-check tool SHALL group spec-derived claims by merged capability identity rather than by raw source-spec file path, SHALL use the merged capability `logicalFile` as the artifact-naming and report-grouping key, and SHALL exclude non-spec claims from this capability-grouped logic path.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Postconditions`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Provenance And Grouping Contract`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Verification Strategy`

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
- Implementation: [pipeline-helpers.ts:345 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L345), [pipeline-helpers.ts:403 sanitizeLogicalFileForArtifacts()](/src/cli/pipeline-helpers.ts#L403), [logic-analysis.ts:207 artifactBase computation in analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L207)
- Test: [pipeline-helpers.test.ts:126 groups by Claim.capability instead of provenance.file](/test/contract/pipeline-helpers.test.ts#L126), [merge-logic-routing.test.ts:57 writes logic artifacts under synthetic merged logicalFile artifact key](/test/contract/merge-logic-routing.test.ts#L57)

#### Scenario: Sanitized Logical Key Collision Aborts Pipeline [FLA-GROUP-COLLISION]
IF two merged capability logical keys would sanitize to the same artifact-path key, THEN THE spec-check tool SHALL abort the pipeline before writing any logic artifacts.

**Postcondition:** Persisted solver evidence remains deterministic and collision-free.

##### Evidence
- Implementation: [pipeline-helpers.ts:386 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L386), [pipeline-helpers.ts:403 sanitizeLogicalFileForArtifacts()](/src/cli/pipeline-helpers.ts#L403)
- Test: [pipeline-helpers.test.ts:150 fails on sanitized logicalFile collisions](/test/contract/pipeline-helpers.test.ts#L150)

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
}

// Safety: collision always aborts (never silently overwrites)
assert collision_implies_abort {
  always (
    (Pipeline.phase = CompilationPh and logical_key_collision and
     Pipeline.phase' != CompilationPh)
    implies Pipeline.phase' = AbortedPh)
}

// Safety: without collision, compilation phase does not abort from this path
assert no_collision_no_grouping_abort {
  always (
    (Pipeline.phase = CompilationPh and not logical_key_collision)
    implies not collision_aborts_pipeline)
}

// Liveness: every merged capability eventually produces exactly one logic group
// (given that compilation phase is reached and no collision)
assert group_formation_complete {
  always (
    (Pipeline.phase = CompilationPh and not logical_key_collision)
    implies (all sp : Spec | some lg : LogicalGroup | lg.groupCap = sp
      implies one lg2 : LogicalGroup | lg2.groupCap = sp))
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
- Implementation: [logic-analysis-checks.ts:95 runPairwiseContradictionChecks()](/src/domain/formal/logic-analysis-checks.ts#L95), [logic-analysis-checks.ts:211 checkPairContradiction()](/src/domain/formal/logic-analysis-checks.ts#L211)
- Test: [logic-analysis.test.ts:253 sat with conditional assertions triggers pairwise checks](/test/contract/logic-analysis.test.ts#L253)
- Test (integration): [z3-smtlib.integration.test.ts:149 conditional contradiction detected by pairwise check](/test/integration/z3-smtlib.integration.test.ts#L149)

#### Scenario: Compatible Conditional Assertions Produce No Finding [FLA-PAIRWISE-COMPAT]
WHEN two conditional assertions have guards that can coexist and consequents that are mutually satisfiable, THE spec-check tool SHALL NOT emit a pairwise contradiction finding for that pair.

**Postcondition:** Compatible conditional rules do not produce false-positive contradiction findings.

##### Evidence
- Implementation: [logic-analysis-checks.ts:211 checkPairContradiction()](/src/domain/formal/logic-analysis-checks.ts#L211)
- Test: [logic-analysis.test.ts:294 compatible conditional assertions produce no pairwise finding](/test/contract/logic-analysis.test.ts#L294)

#### Scenario: Pairwise Check Bounded By Pair Count [FLA-PAIRWISE-BOUND]
WHEN the number of candidate pairs exceeds the configured `--pair-budget` (default 200), THE spec-check tool SHALL check only up to the limit, SHALL cap pairwise Z3 fan-out at `PAIRWISE_SOLVER_CONCURRENCY` (`3`), and SHALL NOT block indefinitely on quadratic pair explosion. The `--pair-budget` controls pairwise bounds for both specs-forward guard-activation checks and code-backwards cross-side implication checks.

**Postcondition:** Pairwise analysis completes in bounded time regardless of claim count, and with the one concurrent completeness query the per-group deeper-check solver peak remains `4` and the global peak remains bounded by group concurrency.

##### Evidence
- Implementation: [logic-analysis-checks.ts:111 runPairwiseContradictionChecks()](/src/domain/formal/logic-analysis-checks.ts#L111)
- Test: [logic-analysis.test.ts:331 pairwise checks bounded by pair count limit](/test/contract/logic-analysis.test.ts#L331)

#### Scenario: Severity Derived From Paired Claims [FLA-PAIRWISE-SEV]
WHEN the spec-check tool emits a pairwise contradiction finding, THE severity SHALL be derived from the highest obligation level among the two conflicting claims (mandatory → error, advisory → warning, informational → info).

**Postcondition:** Pairwise contradiction severity is consistent with the obligation-aware severity model used by the global contradiction check.

##### Evidence
- Implementation: [logic-analysis-sexpr.ts:309 deriveSeverityFromClaims()](/src/domain/formal/logic-analysis-sexpr.ts#L309)
- Test: [logic-analysis.test.ts:253 pairwise severity derived from highest-obligation claim](/test/contract/logic-analysis.test.ts#L253)

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
- Implementation: [logic-analysis-checks.ts:302 runCompletenessCheck()](/src/domain/formal/logic-analysis-checks.ts#L302)
- Test: [logic-analysis.test.ts:357 completeness gap detected when all assertions are conditional](/test/contract/logic-analysis.test.ts#L357)
- Test (integration): [z3-smtlib.integration.test.ts:173 completeness gap: all-conditional spec has unreachable states](/test/integration/z3-smtlib.integration.test.ts#L173)

#### Scenario: No Gap When Ubiquitous Assertions Exist [FLA-COMPLETENESS-UBIQ]
WHEN a spec group contains at least one unconditional (ubiquitous) assertion, THE spec-check tool SHALL skip the completeness gap check for that group.

**Postcondition:** Specs with ubiquitous rules that provide baseline coverage in all states do not produce spurious completeness gap findings.

##### Evidence
- Implementation: [logic-analysis-checks.ts:314 runCompletenessCheck()](/src/domain/formal/logic-analysis-checks.ts#L314)
- Test: [logic-analysis.test.ts:395 completeness check skipped when ubiquitous assertions exist](/test/contract/logic-analysis.test.ts#L395)

#### Scenario: Exhaustive Guards Produce No Gap Finding [FLA-COMPLETENESS-EXHAUST]
WHEN the negation of all guards is unsatisfiable (the guards are exhaustive), THE spec-check tool SHALL NOT emit a completeness gap finding.

**Postcondition:** Specifications whose conditional rules cover all reachable states are confirmed complete without false positives.

##### Evidence
- Implementation: [logic-analysis-checks.ts:302 runCompletenessCheck()](/src/domain/formal/logic-analysis-checks.ts#L302)
- Test: [logic-analysis.test.ts:427 exhaustive guards produce no completeness gap finding](/test/contract/logic-analysis.test.ts#L427)
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
- Test: [logic-analysis.test.ts:36 mandatory contradiction reported at severity error](/test/contract/logic-analysis.test.ts#L36)

#### Scenario: Query Exceeds Timeout [FLA-TIMEOUT-EXCEED]
IF the solver does not return a result within the per-query timeout, THEN THE spec-check tool SHALL terminate the query, record the timeout as evidence, and continue with remaining queries.

**Postcondition:** A single slow query does not block the entire solver analysis phase.

##### Evidence
- Implementation: [z3.ts:88 runZ3Query()](/src/adapters/z3.ts#L88)
- Test: [logic-analysis.test.ts:76 timeout/unknown preserved as inconclusive](/test/contract/logic-analysis.test.ts#L76)

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
- Implementation: [logic-analysis.ts:135 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L135)
- Test: [logic-analysis.test.ts:96 persists SMT-LIB input, stdout, stderr](/test/contract/logic-analysis.test.ts#L96)

#### Scenario: Unsat Core Persisted [FLA-PERSIST-UNSAT]
WHEN a per-spec solver query returns unsat, THE spec-check tool SHALL persist the combined SMT-LIB input file, the solver stdout (containing the unsat core), and the solver stderr.

**Postcondition:** The contradictory assertion subset (unsat core) is available for reviewer inspection and maps back to specific claims via named assertion labels.

##### Evidence
- Implementation: [logic-analysis.ts:135 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L135)
- Test: [logic-analysis.test.ts:96 persists SMT-LIB input, stdout, stderr](/test/contract/logic-analysis.test.ts#L96)

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
  Pipeline.exitCode' = Pipeline.exitCode
}

// FM-9: Logical key collision -> abort pipeline before writing artifacts
// (Already modeled above as collision_aborts_pipeline)

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
  Pipeline.exitCode' = Pipeline.exitCode
}

pred advance_to_reporting {
  Pipeline.phase = AnalysisPh
  Pipeline.phase' = ReportingPh
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred stutter {
  Pipeline.phase' = Pipeline.phase
  Pipeline.candidates' = Pipeline.candidates
  Pipeline.representatives' = Pipeline.representatives
  Pipeline.findings' = Pipeline.findings
  Pipeline.evidence' = Pipeline.evidence
  Pipeline.exitCode' = Pipeline.exitCode
}

pred init_state {
  Pipeline.phase = FormalizationPh
  no Pipeline.candidates
  no Pipeline.representatives
  no Pipeline.findings
  no Pipeline.evidence
  no Pipeline.exitCode
}

fact transitions {
  init_state and always (
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
    // Solver analysis events (including FM-6, FM-7)
    or (some sqr : SpecQueryResult |
        solver_reports_contradiction[sqr] or solver_inconclusive[sqr] or
        solver_sat_deeper[sqr] or solver_error_found[sqr])
    // Pairwise events (including FM-8)
    or (some pc : PairwiseCheck | pairwise_contradiction[pc] or pairwise_compatible[pc])
    or pair_budget_exhausted
    // Completeness events
    or (some gc : GapCheck | completeness_gap_detected[gc] or exhaustive_guards[gc])
    or (some sp : Spec | completeness_gap_skipped[sp])
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

// L5: Collision detection terminates finitely
assert collision_check_terminates {
  always (Pipeline.phase = CompilationPh implies
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

run show_pipeline {} for 3 Claim, 1 Spec, 4 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 2 JsonExtraction, 4 JsonInput, 5 Int, 8 steps

run scenario_contradiction {
  eventually (some f : Pipeline.findings | f.findingType = Contradiction)
} for 3 Claim, 1 Spec, 3 Sample, 2 Cluster, 2 Finding,
  2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion, 2 Declaration,
  2 DeclName, 2 DeclSignature, 1 CombinedSpec, 1 CompiledArtifact,
  2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 10 steps

run scenario_abort {
  eventually (Pipeline.phase = AbortedPh and Pipeline.exitCode = 2)
} for 2 Claim, 1 Spec, 2 Sample, 1 Cluster, 1 Finding,
  1 SpecQueryResult, 0 PairwiseCheck, 1 Assertion, 1 Declaration,
  1 DeclName, 1 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact,
  1 ClaimId, 0 ImplicationResult, 0 GapCheck,
  0 LogicalGroup, 0 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 5 steps

run scenario_collision_abort {
  eventually collision_aborts_pipeline
} for 2 Claim, 2 Spec, 2 Sample, 1 Cluster, 1 Finding,
  0 SpecQueryResult, 0 PairwiseCheck, 1 Assertion, 1 Declaration,
  1 DeclName, 1 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact,
  1 ClaimId, 0 ImplicationResult, 0 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 8 steps

run scenario_json_recovery {
  some je : JsonExtraction | je.input in MarkdownFenced and je.recovered = True
  some je : JsonExtraction | je.input in Irrecoverable and je.recovered = False
} for 0 Claim, 0 Spec, 0 Sample, 0 Cluster, 0 Finding,
  0 SpecQueryResult, 0 PairwiseCheck, 0 Assertion, 0 Declaration,
  0 DeclName, 0 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact,
  0 ClaimId, 0 ImplicationResult, 0 GapCheck,
  0 LogicalGroup, 0 LogicalKey, 3 JsonExtraction, 4 JsonInput, 5 Int, 1 steps

run scenario_pairwise_budget {
  eventually pair_budget_exhausted
} for 3 Claim, 1 Spec, 3 Sample, 2 Cluster, 2 Finding,
  1 SpecQueryResult, 2 PairwiseCheck, 3 Assertion, 2 Declaration,
  2 DeclName, 2 DeclSignature, 1 CombinedSpec, 1 CompiledArtifact,
  2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps

// ============================================================
// COMMANDS — Property verification (check)
// ============================================================

check abort_no_conclusions for 2 Claim, 1 Spec, 3 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 0 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check only_valid_in_candidates for 3 Claim, 1 Spec, 4 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check symmetric_implication_same_cluster for 3 Claim, 1 Spec, 5 Sample, 3 Cluster,
  1 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 4 ImplicationResult, 0 GapCheck,
  0 LogicalGroup, 0 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 1 steps expect 0

check sat_no_global_contradiction for 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check compatible_no_false_positive for 3 Claim, 1 Spec, 3 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 2 PairwiseCheck, 3 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 10 steps expect 0

check ubiquitous_no_spurious_gap for 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 3 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 10 steps expect 0

check findings_monotonic for 3 Claim, 1 Spec, 3 Sample, 2 Cluster,
  3 Finding, 2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 15 steps expect 0

check phase_monotonic for 2 Claim, 1 Spec, 3 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 15 steps expect 0

check reporting_absorbing for 2 Claim, 1 Spec, 3 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 15 steps expect 0

check all_queries_persisted for 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 3 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check timeout_never_contradiction for 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 3 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check collision_implies_abort for 2 Claim, 2 Spec, 2 Sample, 1 Cluster,
  1 Finding, 0 SpecQueryResult, 0 PairwiseCheck, 1 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 0 ImplicationResult, 0 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check all_aborts_set_exit_code for 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  2 LogicalGroup, 2 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 15 steps expect 0

check budget_exhaustion_no_false_findings for 3 Claim, 1 Spec, 3 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 2 PairwiseCheck, 3 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 12 steps expect 0

check pipeline_terminates for 2 Claim, 1 Spec, 2 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 20 steps

check solver_queries_resolve for 2 Claim, 1 Spec, 2 Sample, 1 Cluster,
  2 Finding, 2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck,
  1 LogicalGroup, 1 LogicalKey, 0 JsonExtraction, 4 JsonInput, 5 Int, 20 steps

check formalization_eventually_resolves for 2 Claim, 1 Spec, 3 Sample, 1 Cluster,
  1 Finding, 0 SpecQueryResult, 0 PairwiseCheck, 1 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 0 ImplicationResult, 0 GapCheck,
  0 LogicalGroup, 0 LogicalKey, 1 JsonExtraction, 4 JsonInput, 5 Int, 15 steps
```
