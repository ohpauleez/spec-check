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
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Failure Modes`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Make JSON extraction tolerant but keep schema validation strict`

#### Scenario: Accept Markdown-Fenced JSON [FLA-JSON-FENCE]
WHEN an external LLM response wraps a valid JSON payload in markdown code fences, THE spec-check tool SHALL strip the outer fence markers and SHALL parse the enclosed JSON payload.

**Postcondition:** Common markdown formatting does not cause an otherwise valid payload to be rejected.

#### Scenario: Accept Prefixed Or Suffixed JSON [FLA-JSON-WRAP]
WHEN an external LLM response contains explanatory text before or after a valid JSON object or array, THE spec-check tool SHALL extract the first balanced JSON value and SHALL parse it.

**Postcondition:** Recoverable wrapper text does not prevent downstream schema validation.

#### Scenario: Reject Irrecoverable JSON [FLA-JSON-FAIL]
IF an external LLM response does not contain a recoverable valid JSON payload, THEN THE spec-check tool SHALL reject the response with a diagnostic parse error.

**Postcondition:** Malformed payloads are surfaced explicitly rather than accepted silently.

### Requirement: Formalize Requirement And Scenario Claims Into Logic Artifacts [FLA-FORMALIZE-CLAIMS]
WHEN requirement and scenario claims are available for formal analysis, THE spec-check tool SHALL translate each claim into a typed logic representation and generated SMT-LIB artifacts that preserve the claim identifier, source provenance, obligation level, and supporting declarations needed for solver analysis, and SHALL use the run-configured universal timeout for every external LLM formalization invocation.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Make JSON extraction tolerant but keep schema validation strict`

#### Scenario: Generate Inspectable Logic Artifacts [FLA-FORMAL-ARTS]
WHEN a claim is selected for formalization, THE spec-check tool SHALL emit inspectable logic and SMT artifacts that let a reviewer trace the formal result back to the originating requirement or scenario.

**Postcondition:** Formal analysis inputs are available as reviewable evidence linked to their source claims.

##### Evidence
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154), [formalize.ts:467 buildFormalizationPrompt()](/src/domain/formal/formalize.ts#L467)
- Test: [formalize.test.ts:45 formalizeClaims produces valid candidates](/test/contract/formalize.test.ts#L45), [formalize.test.ts:152 buildFormalizationPrompt fences claim text as untrusted](/test/contract/formalize.test.ts#L152)
- Test (invariant): [safety-liveness.invariant.test.ts:176 LIVE-11: formalization completes with valid output](/test/invariant/safety-liveness.invariant.test.ts#L176)

#### Scenario: Abort On Complete Formalization Failure [FLA-FORMAL-FAIL]
IF no formalization candidates are produced for the entire phase after bounded retries, THEN THE spec-check tool SHALL abort the run with exit code `2` rather than continue with zero formal evidence.

**Postcondition:** No solver conclusion is produced when the formalization phase yields zero candidates.

##### Evidence
- Implementation: [formalize.ts:395 sampleFormalizationsForClaim()](/src/domain/formal/formalize.ts#L395)
- Test: [formalize.test.ts:86 returns error when all samples invalid after max attempts](/test/contract/formalize.test.ts#L86), [formalize.test.ts:108 returns error when callOpencode fails fatally](/test/contract/formalize.test.ts#L108)

#### Scenario: Continue With Partial Formalization Results [FLA-FORMAL-PARTIAL]
IF some claims fail formalization but at least one claim succeeds, THEN THE spec-check tool SHALL continue with the successful candidates, SHALL collect per-claim failures as errors in the formalization output, and SHALL let callers decide severity based on the ratio of successes to failures.

**Postcondition:** Partial formalization results are preserved and downstream phases proceed with available candidates.

##### Evidence
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154)
- Test: [formalize.test.ts:162 returns successful candidates alongside errors on partial failure](/test/contract/formalize.test.ts#L162)

#### Scenario: Universal LLM Timeout For Formalization [FLA-FORMAL-TIMEOUT]
WHEN the spec-check tool invokes an external LLM to formalize a claim or claim batch, THE spec-check tool SHALL use the run-configured universal timeout budget for that invocation.

**Postcondition:** Formalization timeout behavior is consistent with every other LLM-backed phase in the same run.

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
WHEN the spec-check tool receives a formalization sample from `opencode`, THE spec-check tool SHALL validate the sample against the logic IR schema including sort consistency, assertion well-formedness, and identifier format before accepting it into clustering.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Valid Sample Accepted [FLA-SAMPLE-ACCEPT]
WHEN a formalization sample passes schema validation for sort consistency, assertion well-formedness, and identifier format, THE spec-check tool SHALL accept it as a clustering candidate.

**Postcondition:** Only structurally valid samples enter the clustering phase.

##### Evidence
- Implementation: [validate.ts:52 validateFormalizationSample()](/src/domain/formal/validate.ts#L52)
- Test: [validate.test.ts:14 accepts valid sample](/test/contract/validate.test.ts#L14), [validate.test.ts:62 accepts nested balanced parentheses](/test/contract/validate.test.ts#L62)
- Test (invariant): [safety-liveness.invariant.test.ts:68 SAFE-3: no sample enters clustering without validation](/test/invariant/safety-liveness.invariant.test.ts#L68)
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
- Test: [validate.test.ts:20 rejects non-object input](/test/contract/validate.test.ts#L20), [validate.test.ts:26 rejects missing claimId](/test/contract/validate.test.ts#L26), [validate.test.ts:32 rejects invalid obligation](/test/contract/validate.test.ts#L32), [validate.test.ts:38 rejects unbalanced assertion parentheses](/test/contract/validate.test.ts#L38), [validate.test.ts:47 rejects function with undeclared sort](/test/contract/validate.test.ts#L47)
- Test (invariant): [safety-liveness.invariant.test.ts:68 SAFE-3: no sample enters clustering without validation](/test/invariant/safety-liveness.invariant.test.ts#L68)
- Example:
```typescript
const { validateFormalizationSample } = await import("./src/domain/formal/validate.ts");
const result = validateFormalizationSample({ claimId: "", obligation: "mandatory", variables: [], functions: [], assertions: [] }); //=> type Object
result.ok; //=> false
```

#### Scenario: All Samples Invalid After Retries [FLA-SAMPLE-EXHAUST]
IF all formalization samples for a claim are invalid after bounded retries, THEN THE spec-check tool SHALL record the failure as an error in the formalization output and SHALL exclude that claim from clustering. THE tool SHALL NOT abort the entire phase unless no claims produce valid candidates.

**Postcondition:** Per-claim formalization failures are collected as errors; remaining valid claims proceed to clustering.

##### Evidence
- Implementation: [formalize.ts:395 sampleFormalizationsForClaim()](/src/domain/formal/formalize.ts#L395)
- Test: [formalize.test.ts:86 returns error when all samples invalid after max attempts](/test/contract/formalize.test.ts#L86)

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
WHEN the spec-check tool compiles logic IR into SMT-LIB artifacts, THE spec-check tool SHALL sanitize user-derived identifiers to prevent solver syntax collisions, SHALL include reversible mapping comments that link sanitized identifiers back to their original claim identifiers, SHALL emit only declarations and assertions without solver commands (`(check-sat)`), and SHALL expose decomposed assertion expressions alongside the compiled text for downstream query construction.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Unsafe Identifier Sanitized [FLA-SMTLIB-SANITIZE]
WHEN a claim identifier contains characters that conflict with SMT-LIB syntax (parentheses, pipe characters, whitespace, or special SMT-LIB reserved characters), THE spec-check tool SHALL replace them with a deterministic encoding (underscore plus hex escape) and emit a mapping comment.

**Postcondition:** The SMT-LIB file is syntactically valid and the original identifier is recoverable from the mapping comment.

##### Evidence
- Implementation: [smtlib.ts:134 sanitizeIdentifier()](/src/domain/formal/smtlib.ts#L134)
- Test: [smtlib.test.ts:22 sanitizes unsafe identifiers](/test/contract/smtlib.test.ts#L22)
- Test (property): [logic.property.test.ts:9 sanitized identifiers remain SMT-safe](/test/property/logic.property.test.ts#L9)
- Test (integration): [z3-smtlib.integration.test.ts:31 golden samples compile to Z3-accepted SMT-LIB](/test/integration/z3-smtlib.integration.test.ts#L31)
- Example:
```typescript
const { sanitizeIdentifier } = await import("./src/domain/formal/smtlib.ts");
const safe = sanitizeIdentifier("REQ_VALID_1"); //=> type String
safe; //=> REQ_VALID_1
const unsafe = sanitizeIdentifier("REQ(1)|A"); //=> type String
unsafe.includes("("); //=> false
unsafe.includes("|"); //=> false
```

#### Scenario: Valid Identifier Preserved [FLA-SMTLIB-PRESERVE]
WHEN a claim identifier contains only SMT-LIB-safe characters, THE spec-check tool SHALL use the identifier unchanged in the SMT-LIB output.

**Postcondition:** No unnecessary transformation is applied to safe identifiers.

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
- Test: [smtlib.test.ts:27 compiles logic IR with mapping comments](/test/contract/smtlib.test.ts#L27), [smtlib.test.ts:45 produces single smt2 without solver commands](/test/contract/smtlib.test.ts#L45)
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
WHEN the spec-check tool performs logic analysis, THE spec-check tool SHALL combine all formalized claims from a single spec file into exactly one SMT-LIB file, SHALL deduplicate variable and function declarations across claims, and SHALL use named assertions (`(assert (! expr :named label))`) to enable unsat-core identification. The compiled output SHALL NOT include solver commands (`check-sat`, `set-option`, `get-unsat-core`) — the logic analysis orchestrator appends these at query time using a two-phase approach (Phase 1: satisfiability check only; Phase 2: re-run with `(set-option :produce-unsat-cores true)` and `(get-unsat-core)` only when UNSAT is detected).

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Variable And Function Deduplication [FLA-SPEC-DEDUP]
WHEN multiple claims from the same spec declare identical variable or function names with identical sorts or signatures, THE spec-check tool SHALL emit only one declaration in the combined output.

**Postcondition:** The combined SMT-LIB file has no duplicate declarations from compatible claims.

##### Evidence
- Implementation: [smtlib.ts:265 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L265)
- Test: [smtlib.test.ts:67 deduplicates identical variable declarations](/test/contract/smtlib.test.ts#L67), [smtlib.test.ts:79 deduplicates identical function declarations](/test/contract/smtlib.test.ts#L79)

#### Scenario: Function Signature Conflict Detection [FLA-SPEC-CONFLICT]
IF two claims from the same spec declare the same function name with incompatible signatures, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding, SHALL exclude the conflicting claim from the combined file, and SHALL preserve both claim identifiers in the finding evidence.

**Postcondition:** Signature conflicts are surfaced as findings rather than producing malformed solver input.

##### Evidence
- Implementation: [smtlib.ts:265 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L265)
- Test: [smtlib.test.ts:92 detects function signature conflicts and excludes conflicting claims](/test/contract/smtlib.test.ts#L92)

#### Scenario: Named Assertion Labels Map To Claims [FLA-SPEC-NAMED]
WHEN the spec-check tool generates named assertions in the combined SMT-LIB, THE label for each assertion SHALL encode the source claim identifier and assertion index so that unsat-core results can be mapped back to specific claims.

**Postcondition:** The assertion-name-to-claim-ID mapping is deterministic and reversible.

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
- Test (property): [logic.property.test.ts:20 cluster construction is deterministic and symmetric](/test/property/logic.property.test.ts#L20)
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
- Test (property): [logic.property.test.ts:20 cluster construction is deterministic and symmetric](/test/property/logic.property.test.ts#L20)

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
WHEN formal artifacts are available, THE spec-check tool SHALL group representative claims by source spec file, SHALL compile each group into a single combined SMT-LIB file with named assertions, SHALL invoke Z3 per spec group using a two-phase approach (Phase 1: satisfiability check only; Phase 2: re-invoke with unsat-core support only when contradiction is detected), and SHALL classify contradictions with severity derived from the highest-obligation claim in the unsat core.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Report Contradiction With Unsat-Core Identification [FLA-LOGIC-CORE]
WHEN a per-spec combined query returns unsat, THE spec-check tool SHALL parse the unsat core to identify the specific conflicting claims, SHALL report a `logic.contradiction` finding referencing those claims, and SHALL derive severity from the highest-obligation claim in the core (mandatory → error, advisory → warning, informational → info).

**Postcondition:** Reviewers can identify which specific claims within a spec are mutually contradictory.

##### Evidence
- Implementation: [logic-analysis.ts:208 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L208)
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
IF the solver returns timeout or unknown for a per-spec query, THEN THE spec-check tool SHALL preserve the inconclusive result as evidence and SHALL emit a `logic.inconclusive` finding at warning severity.

**Postcondition:** Inconclusive logic results remain visible to reviewers and do not masquerade as success.

##### Evidence
- Implementation: [logic-analysis.ts:293 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L293)
- Test: [logic-analysis.test.ts:76 timeout/unknown result preserved as inconclusive finding](/test/contract/logic-analysis.test.ts#L76)

#### Scenario: Sat Result Triggers Deeper Analysis [FLA-LOGIC-SAT]
WHEN a per-spec combined query returns sat, THE spec-check tool SHALL NOT emit a global contradiction finding for that spec, but SHALL proceed with pairwise guard-activation contradiction checks and completeness gap detection to identify conditional contradictions and unspecified states that the global satisfiability check cannot surface.

**Postcondition:** A globally satisfiable spec is not assumed free of all issues; deeper conditional analysis follows.

##### Evidence
- Implementation: [logic-analysis.ts:324 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L324)
- Test: [logic-analysis.test.ts:140 sat result does not generate contradiction finding](/test/contract/logic-analysis.test.ts#L140)

#### Scenario: Solver Error Produces Finding [FLA-LOGIC-ERROR]
IF the solver emits error diagnostics (such as `(error ...)` lines in stdout) indicating malformed input, THEN THE spec-check tool SHALL emit a `logic.solver_error` finding at error severity referencing all claims in the affected spec group, and SHALL persist the solver input and output as evidence.

**Postcondition:** Solver errors are surfaced as explicit findings rather than silently treated as successful analysis.

##### Evidence
- Implementation: [logic-analysis.ts:258 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L258)
- Test: [logic-analysis.test.ts:232 solver error produces logic.solver_error finding](/test/contract/logic-analysis.test.ts#L232)

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
WHEN the global satisfiability check for a spec group returns sat, THE spec-check tool SHALL extract conditional assertions (implications of the form `(=> guard consequent)`), SHALL identify pairs from different claims, SHALL check each pair by forcing both guards active and asserting both consequents simultaneously, and SHALL emit a `logic.conditional_contradiction` finding when the resulting query is unsatisfiable (indicating the consequents genuinely conflict when both guards hold).

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
WHEN the number of candidate pairs exceeds the configured `--pair-budget` (default 200), THE spec-check tool SHALL check only up to the limit and SHALL NOT block indefinitely on quadratic pair explosion. The `--pair-budget` controls pairwise bounds for both specs-forward guard-activation checks and code-backwards cross-side implication checks.

**Postcondition:** Pairwise analysis completes in bounded time regardless of claim count.

##### Evidence
- Implementation: [logic-analysis-checks.ts:111 runPairwiseContradictionChecks()](/src/domain/formal/logic-analysis-checks.ts#L111)
- Test: [logic-analysis.test.ts:331 pairwise checks bounded by pair count limit](/test/contract/logic-analysis.test.ts#L331)

#### Scenario: Severity Derived From Paired Claims [FLA-PAIRWISE-SEV]
WHEN the spec-check tool emits a pairwise contradiction finding, THE severity SHALL be derived from the highest obligation level among the two conflicting claims (mandatory → error, advisory → warning, informational → info).

**Postcondition:** Pairwise contradiction severity is consistent with the obligation-aware severity model used by the global contradiction check.

##### Evidence
- Implementation: [logic-analysis-checks.ts:131 deriveSeverityFromClaims()](/src/domain/formal/logic-analysis-checks.ts#L131)
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
WHEN the global satisfiability check for a spec group returns sat AND all assertions in the spec group are conditional (implications), THE spec-check tool SHALL negate all guards simultaneously and check satisfiability. IF the result is sat, THE tool SHALL emit a `logic.completeness_gap` warning finding indicating that there exist reachable states where no conditional rule applies and behavior is unspecified.

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
- Implementation: [logic-analysis.ts:335 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L335)
- Test: [logic-analysis.test.ts:96 persists SMT-LIB input, stdout, stderr](/test/contract/logic-analysis.test.ts#L96)

#### Scenario: Unsat Core Persisted [FLA-PERSIST-UNSAT]
WHEN a per-spec solver query returns unsat, THE spec-check tool SHALL persist the combined SMT-LIB input file, the solver stdout (containing the unsat core), and the solver stderr.

**Postcondition:** The contradictory assertion subset (unsat core) is available for reviewer inspection and maps back to specific claims via named assertion labels.

##### Evidence
- Implementation: [logic-analysis.ts:226 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L226)
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
// --- Failure mode summary ---
// 1. Total formalization failure: abort with exit code 2
// 2. Partial formalization failure: continue with available candidates
// 3. Schema validation failure: exclude bad samples, preserve as evidence
// 4. Signature conflicts: exclude conflicting claim, emit merge_conflict finding
// 5. Clustering ambiguity: emit ambiguity finding, no representative selected
// 6. Solver timeout: classify as inconclusive, emit warning, continue
// 7. Solver error: emit solver_error finding at error severity, persist evidence
// 8. Pair budget exhaustion: stop checking, no indefinite block

// --- Transition system ---

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
    // Formalization events
    formalize_success or formalize_abort or formalize_partial
    // Validation events
    or (some s : Sample | validate_accept[s] or validate_reject[s])
    or validation_complete
    // Clustering events
    or (some c : Claim, cl : Cluster | cluster_select_representative[c, cl])
    or (some c : Claim | cluster_divergent[c])
    // Compilation events
    or (some disj c1, c2 : Claim | emit_merge_conflict[c1, c2])
    // Phase transitions
    or advance_to_compilation or advance_to_analysis or advance_to_reporting
    // Solver analysis events
    or (some sqr : SpecQueryResult |
        solver_reports_contradiction[sqr] or solver_inconclusive[sqr] or
        solver_sat_deeper[sqr] or solver_error_found[sqr])
    // Pairwise events
    or (some pc : PairwiseCheck | pairwise_contradiction[pc] or pairwise_compatible[pc])
    // Completeness events
    or (some gc : GapCheck | completeness_gap_detected[gc] or exhaustive_guards[gc])
    or (some sp : Spec | completeness_gap_skipped[sp])
    // Stutter
    or stutter
  )
}

// --- Global safety properties ---

// Phases only advance forward (monotonic)
assert phase_monotonic {
  always (Pipeline.phase = AbortedPh implies after always Pipeline.phase = AbortedPh)
}

// Findings accumulate monotonically (never removed)
assert findings_monotonic {
  always (Pipeline.findings in Pipeline.findings')
}

// Evidence accumulates monotonically (never removed)
assert evidence_monotonic {
  always (Pipeline.evidence in Pipeline.evidence')
}

// --- Liveness properties ---

// Pipeline eventually terminates given fair scheduling
pred pipeline_fairness {
  always eventually (Pipeline.phase' != Pipeline.phase or
                     Pipeline.phase in (ReportingPh + AbortedPh))
}

assert pipeline_terminates {
  pipeline_fairness implies eventually (Pipeline.phase in (ReportingPh + AbortedPh))
}

// --- Commands ---

run show_pipeline {} for 3 Claim, 1 Spec, 4 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck, 5 Int, 8 steps

run scenario_contradiction {
  eventually (some f : Pipeline.findings | f.findingType = Contradiction)
} for 3 Claim, 1 Spec, 3 Sample, 2 Cluster, 2 Finding,
  2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion, 2 Declaration,
  2 DeclName, 2 DeclSignature, 1 CombinedSpec, 1 CompiledArtifact,
  2 ClaimId, 2 ImplicationResult, 1 GapCheck, 5 Int, 10 steps

run scenario_abort {
  eventually (Pipeline.phase = AbortedPh and Pipeline.exitCode = 2)
} for 2 Claim, 1 Spec, 2 Sample, 1 Cluster, 1 Finding,
  1 SpecQueryResult, 0 PairwiseCheck, 1 Assertion, 1 Declaration,
  1 DeclName, 1 DeclSignature, 0 CombinedSpec, 0 CompiledArtifact,
  1 ClaimId, 0 ImplicationResult, 0 GapCheck, 5 Int, 5 steps

check abort_no_conclusions for 2 Claim, 1 Spec, 3 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 0 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck, 5 Int, 12 steps expect 0

check only_valid_in_candidates for 3 Claim, 1 Spec, 4 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck, 5 Int, 12 steps expect 0

check symmetric_implication_same_cluster for 3 Claim, 1 Spec, 5 Sample, 3 Cluster,
  1 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 4 ImplicationResult, 0 GapCheck, 5 Int, 1 steps expect 0

check sat_no_global_contradiction for 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck, 5 Int, 12 steps expect 0

check compatible_no_false_positive for 3 Claim, 1 Spec, 3 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 2 PairwiseCheck, 3 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck, 5 Int, 10 steps expect 0

check ubiquitous_no_spurious_gap for 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 3 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck, 5 Int, 10 steps expect 0

check findings_monotonic for 3 Claim, 1 Spec, 3 Sample, 2 Cluster,
  3 Finding, 2 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck, 5 Int, 15 steps expect 0

check phase_monotonic for 2 Claim, 1 Spec, 3 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck, 5 Int, 15 steps expect 0

check all_queries_persisted for 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 3 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck, 5 Int, 12 steps expect 0

check timeout_never_contradiction for 3 Claim, 2 Spec, 3 Sample, 2 Cluster,
  3 Finding, 3 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  2 Declaration, 2 DeclName, 2 DeclSignature, 1 CombinedSpec,
  1 CompiledArtifact, 2 ClaimId, 2 ImplicationResult, 1 GapCheck, 5 Int, 12 steps expect 0

check pipeline_terminates for 2 Claim, 1 Spec, 2 Sample, 1 Cluster,
  2 Finding, 1 SpecQueryResult, 1 PairwiseCheck, 2 Assertion,
  1 Declaration, 1 DeclName, 1 DeclSignature, 0 CombinedSpec,
  0 CompiledArtifact, 1 ClaimId, 1 ImplicationResult, 0 GapCheck, 5 Int, 20 steps
```
