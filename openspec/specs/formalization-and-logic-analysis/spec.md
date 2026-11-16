---
title: FormalizationAndLogicAnalysis
---

## Purpose

Define the formalization and solver-backed logic analysis behavior for the spec-check tool: translating claims into formal artifacts, clustering alternate interpretations, and using solver-backed analysis to detect conflicts, gaps, and surprising behaviors.

All Alloy fences below form one Alloy 6 module in document order. Source bytes, lexical correctness, OS effects, and concrete serialization are explicit implementation-test boundaries; the model checks relational preservation and analyzer control. Safety assertions permit stuttering. Liveness is conditional on the stated action scheduling and resource premises.

```alloy
module FormalizationAndLogicAnalysis
open util/boolean
open util/ordering[Claim] as inputOrder

// --- Domain vocabulary: source-local identities, keys and structural modals ---
sig Key {}
sig Capability { fallback : one Key }
sig Index {}
sig Label {}
sig Registry {}
sig Concept {}
sig SourcePayload {}
abstract sig Modal {}
one sig Mandatory, Advisory, Permission extends Modal {}
abstract sig Form {}
one sig Refinement, Example, ProhibitedExample extends Form {}
sig Valuation {}
sig Claim {
  index : one Index, displayId : lone Label, cap : lone Capability,
  compileLabel : one Label, sanitizedLabel : one Label, dependencies : set Claim,
  provenance : one Key, payload : one SourcePayload,
  sourceEligible : one Bool, modal : one Modal, form : one Form,
  negated : one Bool, guard : set Valuation, positiveResponse : set Valuation,
  input : set Valuation, outcome : set Valuation, postcondition : set Valuation
}
one sig Config {
  mapping : Capability -> lone Key, thresholdNumerator : one Int,
  thresholdDenominator : one Int, batchLimit : one Int,
  pairBudget : one Int,
  controlsValid : one Bool, artifactKeyCollision : one Bool
}
fact input_identity {
  all disj a,b : Capability | a.fallback != b.fallback
  all disj a, b : Claim | a.index != b.index
  Config.thresholdNumerator > 0
  Config.thresholdDenominator >= Config.thresholdNumerator
  Config.thresholdDenominator <= 3
  Config.batchLimit >= 0
  Config.pairBudget >= 0
}
fun eligible : set Claim { { c : Claim | c.sourceEligible = True } }
fun key[c : Claim] : one Key {
  no c.cap => c.provenance else
    (some Config.mapping[c.cap] => Config.mapping[c.cap] else c.cap.fallback)
}
sig Group { key : one Key, registry : one Registry, concepts : set Concept, background : set Valuation }
fun members[g : Group] : set Claim { { c : eligible | key[c] = g.key } }
fact group_partition {
  all g : Group | some members[g]
  all disj g, h : Group | g.key != h.key
  all c : eligible | one g : Group | c in members[g]
}
sig Batch { group : one Group, claims : some Claim }
fact stable_batch_partition {
  all b : Batch | b.claims in members[b.group]
  all c : eligible | one b : Batch | c in b.claims
  all b : Batch | all a, c : b.claims | all middle : members[b.group] |
    middle in inputOrder/nexts[a] & inputOrder/prevs[c] implies middle in b.claims
  all b : Batch | Config.batchLimit > 0 implies #b.claims <= Config.batchLimit
  all g : Group | Config.batchLimit = 0 implies one b : Batch | b.group = g
}
abstract sig Transport {}
one sig Attached, Inline extends Transport {}
abstract sig ErrorKind {}
one sig GoodResponse, ModelFailure, InfrastructureFailure, PromptTooLarge, CaptureOverflow extends ErrorKind {}
abstract sig TempFailure {}
one sig NoTransportFailure, DirectoryFailure, WriteFailure extends TempFailure {}
sig Attempt {
  batch : one Batch, claims : some Claim, transport : one Transport,
  registry : one Registry, boundIndexes : Claim -> lone Index,
  jsonRecoverable : one Bool,
  shapeValid : one Bool, expressionsValid : one Bool, fragmentValid : one Bool,
  result : one ErrorKind, transportFailure : one TempFailure,
  fallbackFits : one Bool, cleanupFails : one Bool,
  recoveryOf : lone Attempt, earlier : set Attempt
}
fact attempt_shape {
  no iden & ^earlier
  earlier.earlier in earlier
  all disj a,b : Attempt | some a.claims & b.claims implies a in b.earlier or b in a.earlier
  all c : eligible | some a : Attempt | c in a.claims
  all a : Attempt | {
    a.claims in a.batch.claims
    (a.transport = Attached iff #a.claims >= 2)
    some a.recoveryOf implies {
      a.transport = Inline
      a.recoveryOf in a.earlier
      a.claims in a.recoveryOf.claims
      a.batch = a.recoveryOf.batch
      degradable[a.recoveryOf]
    }
    a.transport = Attached and degradable[a] implies all c : a.claims |
      one retry : Attempt | retry.recoveryOf = a and retry.claims = c
  }
}
sig Sample { attempt : one Attempt, claim : one Claim, positiveMeaning : set Valuation, confidence : one Int }
fact sample_ownership {
  all s : Sample | s.claim in s.attempt.claims
  all disj s, t : Sample | s.attempt != t.attempt or s.claim != t.claim
  all a : Attempt, c : a.claims | one s : Sample | s.attempt = a and s.claim = c
}
abstract sig TempStage {}
one sig NotCreated, DirCreated, FileWritten, ProcessSettled, CleanupSucceeded, CleanupFailed extends TempStage {}
abstract sig Phase {}
one sig Discover, Sampling, Selecting, Analyzing, Complete, Aborted extends Phase {}
abstract sig QueryKind {}
one sig Background, Global, Guard, SelfResponse, Activation, PairGuard, PairConflict, AdvisoryQuery,
  Coverage, PermissionQuery, PositiveExample, NegativeExample, PremiseCheck, Implication, AuxiliaryCore extends QueryKind {}
abstract sig QueryStage {}
one sig ClusteringQueries, AnalysisQueries extends QueryStage {}
abstract sig Verdict {}
one sig Sat, Unsat, Unknown, Timeout, SolverError extends Verdict {}
sig Query {
  group : one Group, owners : set Claim, kind : one QueryKind,
  stage : one QueryStage, premiseSample : lone Sample, conclusionSample : lone Sample,
  explicitCoverage : one Bool,
  first : lone Claim, second : lone Claim,
  applicability : set Valuation, family : set Claim,
  premise : set Valuation, conclusion : set Valuation,
  prerequisites : set Query, satPrerequisites : set Query,
  auxiliaryOf : lone Query, observed : one Verdict, errorDiagnostic : one Bool,
  pairOwner : lone Query,
  bytesWithinBound : one Bool, pairWithinBudget : one Bool, concurrencyAdmitted : one Bool,
  writeFails : one Bool
  , compilation : one CompileInput
}
sig ScriptToken {}
sig EvidenceToken {}
one sig Run {
  var phase : one Phase,
  var frozen : set Group,
  var stages : Attempt -> one TempStage,
  var spawned : set Attempt,
  var captured : set Attempt,
  var settled : set Attempt,
  var accepted : set Sample,
  var errors : set Claim,
  var selected : Claim -> lone Sample,
  var issued : set Query,
  var persisted : set Query,
  var skipped : set Query,
  var usedScripts : Query -> lone ScriptToken,
  var reservations : (Attempt + Query) -> lone EvidenceToken,
  var outputFailed : one Bool
}
fun candidates : set Claim { Run.accepted.claim }
fun ready_samples[c : Claim] : set Sample { { s : Run.accepted | s.claim = c } }
fun response[s : Sample] : set Valuation {
  s.claim.negated = True => Valuation - s.positiveMeaning else s.positiveMeaning
}
fun semantic_response[c : Claim] : set Valuation { response[c.(Run.selected)] }
fun mandatory[g : Group] : set Valuation {
  { v : Valuation | all c : candidates & members[g] | c.modal = Mandatory and c.form = Refinement implies
    (v in c.guard implies v in semantic_response[c] & c.postcondition) }
}
fun formula[q : Query] : set Valuation {
  let B = q.group.background, C = mandatory[q.group], a = q.first, b = q.second |
    q.kind = Background => B else
    (q.kind = Global => B & C else
    (q.kind = Guard => B & a.guard else
    (q.kind = SelfResponse => B & a.guard & semantic_response[a] & a.postcondition else
    (q.kind = Activation => B & a.guard & C else
    (q.kind = PairGuard => B & a.guard & b.guard else
    (q.kind = PairConflict => B & a.guard & b.guard & C else
    (q.kind = Coverage => (B & q.applicability) - q.family.guard else
    (q.kind in PermissionQuery + AdvisoryQuery => B & a.guard & C & semantic_response[a] else
    (q.kind in PositiveExample + NegativeExample => B & C & a.input & a.outcome & a.postcondition else
    (q.kind = PremiseCheck => B & q.premise else
    (q.kind = Implication => (B & q.premise) - q.conclusion else B & C)))))))))))
}
fun verdict[q : Query] : one Verdict { q.errorDiagnostic = True => SolverError else q.observed }
fact solver_observations {
  // Finite-valuation oracle for conclusive results. Errors/unknown/timeouts are
  // representable external observations, not guessed successful outcomes.
  all q : Query | {
    q.owners in members[q.group]
    q.premiseSample.claim + q.conclusionSample.claim in q.owners
    q.satPrerequisites in q.prerequisites
    q.auxiliaryOf in q.prerequisites
    q.stage = ClusteringQueries implies q.kind in Background + PremiseCheck + Implication
    q.stage = ClusteringQueries implies q.prerequisites.stage in ClusteringQueries
    some q.premiseSample implies q.premise = sample_meaning[q.premiseSample]
    some q.conclusionSample implies q.conclusion = sample_meaning[q.conclusionSample]
    q not in q.^prerequisites
    q.first + q.second + q.family in members[q.group]
    q.first + q.second in q.owners
    q.kind in Guard + SelfResponse + Activation + PermissionQuery + AdvisoryQuery + PositiveExample + NegativeExample implies one q.first
    q.kind in PairGuard + PairConflict implies one q.first and one q.second
    q.kind = PairConflict implies {
      q.first in inputOrder/prevs[q.second]
      (q.pairWithinBudget = True iff #prior_pair_candidates[q] < Config.pairBudget)
    }
    q.kind = PairGuard implies {
      one q.pairOwner
      q.pairOwner.kind = PairConflict
      q.pairOwner.group = q.group
      q.first = q.pairOwner.first and q.second = q.pairOwner.second
      q.pairWithinBudget = q.pairOwner.pairWithinBudget
    }
    q.kind not in PairGuard + PairConflict implies q.pairWithinBudget = True
  }
  all disj p,q : Query | p.kind = PairConflict and q.kind = PairConflict and p.group = q.group implies
    p.first != q.first or p.second != q.second
}
fun prior_pair_candidates[q : Query] : set Query {
  { p : Query | p.kind = PairConflict and p.group = q.group and
    (p.first in inputOrder/prevs[q.first] or
      (p.first = q.first and p.second in inputOrder/prevs[q.second])) }
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
// Lexer boundary: recovery observations distinguish malformed transport from
// valid typed content; concrete balanced JSON extraction is tested separately.
pred valid_attempt[a : Attempt] {
  a.result = GoodResponse
  a.jsonRecoverable = True
  a.transportFailure = NoTransportFailure
  a.shapeValid = True and a.expressionsValid = True and a.fragmentValid = True
  a.registry = a.batch.group.registry
  a.boundIndexes = { c : a.claims, i : Index | i = c.index }
}
// Safety: model/encoding failure never becomes an accepted sample.
assert rejected_response_not_accepted { always (all s : Run.accepted | valid_attempt[s.attempt]) }
```

### Requirement: Formalize Requirement And Scenario Claims Into Logic Artifacts [FLA-FORMALIZE-CLAIMS]
WHEN admitted requirement and scenario claims are available, THE spec-check tool SHALL formalize source-established clause predicates against a frozen semantic-group registry while preserving source identity, modality, provenance, and explicit analyzed scope.

**Postcondition:** Attached claim context retains parser-owned subject, form and scenario kind on batch, singleton recovery and additional-sample paths. Context is not an extra response predicate slot; source modality and negation remain deterministic.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Make JSON extraction tolerant but keep schema validation strict`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Scope`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Proposed Design`
- [Design: Interaction Protocols](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#interaction-protocols)
- [Design: Interface Contracts](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#interface-contracts)

#### Scenario: Generate Inspectable Logic Artifacts [FLA-FORMAL-ARTS]
WHEN a claim is formalized, THE spec-check tool SHALL persist raw attempts, accepted typed predicates, source-derived semantic rules, registry identity, and compiled artifacts linked to its source clauses.

#### Scenario: Abort On Complete Formalization Failure [FLA-FORMAL-FAIL]
IF attempted eligible claims produce zero candidates after bounded recovery, THEN THE spec-check tool SHALL preserve their attempt evidence and SHALL abort specs-forward formalization with `FormalizationError` exit `9`.

#### Scenario: Continue With Partial Formalization Results [FLA-FORMAL-PARTIAL]
IF some eligible claims fail while others produce candidates, THEN THE spec-check tool SHALL continue with candidates and SHALL report per-claim failures and incomplete analyzed scope.

#### Scenario: Universal LLM Timeout For Formalization [FLA-FORMAL-TIMEOUT]
WHEN discovery or formalization invokes the external model, THE spec-check tool SHALL use the run-configured universal LLM timeout and existing bounded retry policy.

#### Scenario: Semantic Groups May Span Provenance Files [FLA-FORMAL-SPAN]
WHEN one merged capability contains claims from multiple files, THE spec-check tool SHALL use one semantic group and frozen registry while preserving each source span.

#### Scenario: All-Ineligible Input Completes Diagnostics [FLA-FORMAL-NO-ELIGIBLE]
WHEN source admission yields no eligible claims, THE spec-check tool SHALL skip formalization model calls and SHALL complete diagnostic reporting with no formal verdict rather than fabricate candidates or treat source ineligibility as an adapter failure.

##### Historical verification evidence
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154), [formalize.ts:476 buildFormalizationPrompt()](/src/domain/formal/formalize.ts#L476)
- Test: [formalize.test.ts:45 formalizeClaims produces valid candidates from mock responses](/test/contract/formalize.test.ts#L45), [formalize.test.ts:159 buildFormalizationPrompt fences claim text as untrusted](/test/contract/formalize.test.ts#L159), [safety-liveness.invariant.test.ts:177 LIVE-11: if opencode responds with valid output, formalization completes](/test/invariant/safety-liveness.invariant.test.ts#L177)
- Implementation: [formalize.ts:402 sampleFormalizationsForClaim()](/src/domain/formal/formalize.ts#L402)
- Test: [formalize.test.ts:90 returns error when all samples invalid after max attempts](/test/contract/formalize.test.ts#L90), [formalize.test.ts:113 returns error when callOpencode fails fatally](/test/contract/formalize.test.ts#L113)
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154)
- Test: [formalize.test.ts:169 returns successful candidates alongside errors on partial failure](/test/contract/formalize.test.ts#L169)
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154), [opencode.ts:86 callOpencode()](/src/adapters/opencode.ts#L86), [timeout.ts:16 DEFAULT_TIMEOUT_MS](/src/domain/timeout.ts#L16)
- Test: [formalize.test.ts:45 formalizeClaims produces valid candidates from mock responses](/test/contract/formalize.test.ts#L45), [opencode.test.ts:403 retries on timeout up to retry limit then returns timeout error](/test/contract/opencode.test.ts#L403)
- Implementation: [formalize.ts:129 formalizeClaims()](/src/domain/formal/formalize.ts#L129), [grouping.ts:224 groupFormalizationClaims()](/src/domain/formal/grouping.ts#L224)
- Test (integration): [semantic-batching.integration.test.ts:173 aligns merged grouping, provenance, bounds, prompt, cleanup, and evidence](/test/integration/semantic-batching.integration.test.ts#L173)

#### Requirement model

```alloy
// Event: bounded discovery completes for one semantic group before sampling.
pred freeze[g : Group] {
  Run.phase = Discover and g not in Run.frozen
  Config.controlsValid = True
  Run.frozen' = Run.frozen + g
  keep_attempts
  keep_queries
  Run.phase' = Run.phase
}
pred begin_sampling {
  Run.phase = Discover and (Run.frozen = Group or Config.controlsValid = False)
  Run.phase' = (Config.controlsValid = False => Aborted else (no eligible => Complete else Sampling))
  Run.frozen' = Run.frozen
  keep_attempts
  keep_queries
}
// Safety: all-ineligible scope completes diagnostically without invented calls.
assert no_eligible_no_calls { always (no eligible implies no Run.spawned + Run.issued) }
// Total eligible failure maps to FormalizationError exit 9; invalid controls
// and artifact naming failures remain distinct preflight/input categories.
fun formalization_exit : lone Int {
  Run.phase = Aborted and some eligible and candidates + Run.errors = eligible and no candidates and
    Run.outputFailed = False => 9 else none
}
```

### Requirement: Formalization Sample Schema Validation [FLA-VALIDATE-SAMPLE]
WHEN a clause interpretation is received, THE spec-check tool SHALL validate its source index, registry hash, expected clause slots, complete expressions, symbol resolution, sorts, units, arity, and supported fragment before admitting it to clustering.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`
- [Design: Expression and semantic IR](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#expression-and-semantic-ir)

#### Scenario: Valid Sample Accepted [FLA-SAMPLE-ACCEPT]
WHEN every expected clause predicate validates against the frozen signature, THE spec-check tool SHALL construct the rule skeleton and modality from the source AST and SHALL accept the typed sample.

#### Scenario: Invalid Sample Rejected [FLA-SAMPLE-REJECT]
IF a sample has undeclared references, wrong sorts/units/arity, missing or duplicate clause slots, unsupported operators, trailing expressions, or solver commands, THEN THE spec-check tool SHALL reject it before solver execution and SHALL preserve the raw response and validation reason.

#### Scenario: Same-Claim Declaration Collisions Rejected [FLA-SAMPLE-SAMECLAIM]
IF a sample attempts conflicting or duplicate declarations or shadows a registry/builtin symbol, THEN THE spec-check tool SHALL reject it without changing the frozen signature.

#### Scenario: All Samples Invalid After Retries [FLA-SAMPLE-EXHAUST]
IF a claim exhausts bounded attempts without a valid sample, THEN THE spec-check tool SHALL return one claim error and SHALL preserve all rejected attempts while successful siblings continue.

#### Scenario: Logical Inconsistency Is Not Schema Invalidity [FLA-SAMPLE-INCONSISTENT]
WHEN a type-valid predicate is logically inconsistent, THE spec-check tool SHALL retain it for inconsistency diagnosis rather than discard it as a parsing or type error.

##### Historical verification evidence
- Implementation: [validate.ts:53 validateFormalizationSample()](/src/domain/formal/validate.ts#L53)
- Test: [validate.test.ts:14 accepts valid sample](/test/contract/validate.test.ts#L14), [validate.test.ts:62 accepts nested balanced parentheses](/test/contract/validate.test.ts#L62), [safety-liveness.invariant.test.ts:68 SAFE-3: no formalization sample enters clustering without schema validation](/test/invariant/safety-liveness.invariant.test.ts#L68)
- Test: [validate.test.ts:20 rejects non-object input](/test/contract/validate.test.ts#L20), [validate.test.ts:26 rejects missing claimId](/test/contract/validate.test.ts#L26), [validate.test.ts:32 rejects invalid obligation](/test/contract/validate.test.ts#L32), [validate.test.ts:38 rejects unbalanced assertion parentheses](/test/contract/validate.test.ts#L38), [validate.test.ts:47 rejects function with undeclared sort](/test/contract/validate.test.ts#L47), [safety-liveness.invariant.test.ts:68 SAFE-3: no formalization sample enters clustering without schema validation](/test/invariant/safety-liveness.invariant.test.ts#L68)
- Implementation: [validate.ts:133 validateDeclarationCollisions()](/src/domain/formal/validate.ts#L133)
- Test: [validate.test.ts:71 rejects raw variable/function name overlap within one claim](/test/contract/validate.test.ts#L71), [validate.test.ts:84 rejects duplicate variables that sanitize to the same symbol](/test/contract/validate.test.ts#L84), [validate.test.ts:101 rejects duplicate functions that sanitize to the same symbol](/test/contract/validate.test.ts#L101)
- Implementation: [formalize.ts:402 sampleFormalizationsForClaim()](/src/domain/formal/formalize.ts#L402)
- Test: [formalize.test.ts:90 returns error when all samples invalid after max attempts](/test/contract/formalize.test.ts#L90)

#### Requirement model

```alloy
// Event: accept typed source-index/registry-valid samples only after capture and
// terminal cleanup. Logical inconsistency is deliberately not schema invalidity.
pred settle[a : Attempt] {
  Run.phase = Sampling and a in Run.captured - Run.settled
  a.(Run.stages) in CleanupSucceeded + CleanupFailed
  Run.settled' = Run.settled + a
  Run.accepted' = Run.accepted + (valid_attempt[a] => { s : Sample | s.attempt = a } else none)
  Run.stages' = Run.stages
  Run.spawned' = Run.spawned
  Run.captured' = Run.captured
  Run.errors' = Run.errors
  Run.selected' = Run.selected
  Run.phase' = Run.phase
  Run.frozen' = Run.frozen
  keep_queries
}
```

### Requirement: SMT-LIB Compilation And Identifier Sanitization [FLA-SMTLIB-COMPILE]
WHEN typed semantic artifacts are compiled, THE spec-check tool SHALL render resolved AST nodes with injective namespaced identifiers, reversible source mappings, and declarations/assertions only.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- [Design: Expression and semantic IR](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#expression-and-semantic-ir)

#### Scenario: Unsafe Identifier Sanitized [FLA-SMTLIB-SANITIZE]
WHEN an identifier needs escaping, THE spec-check tool SHALL preserve the existing Unicode-code-point encoding using `_` and six uppercase hexadecimal digits with reversible mapping comments.

#### Scenario: Valid Identifier Preserved [FLA-SMTLIB-PRESERVE]
WHEN the injective identifier encoder receives a non-digit-leading ASCII alphanumeric identifier, THE spec-check tool SHALL preserve that identifier's characters within its assigned namespace.

#### Scenario: Compiled Output Excludes Solver Commands [FLA-SMTLIB-QUERYSAT]
WHEN reusable SMT-LIB is compiled, THE spec-check tool SHALL omit `check-sat`, `set-option`, model/core requests, and other query commands until query assembly.

#### Scenario: Assertion Expressions Exposed [FLA-SMTLIB-ASSERTEXPRS]
WHEN compilation completes, THE spec-check tool SHALL expose typed predicate/assertion structures and their rendered expressions so downstream builders do not reparse emitted SMT-LIB.

#### Scenario: Literal Contents Are Not Renamed [FLA-SMTLIB-LITERALS]
WHEN the expression parser encounters literal content, THE spec-check tool SHALL preserve its lexical meaning without identifier substitution and SHALL reject unsupported literal sorts before compilation.

##### Historical verification evidence
- Implementation: [smtlib.ts:142 sanitizeIdentifier()](/src/domain/formal/smtlib.ts#L142)
- Test: [smtlib.test.ts:34 sanitizes unsafe identifiers](/test/contract/smtlib.test.ts#L34)
- Test (property): [logic.property.test.ts:448 sanitized identifiers remain SMT-safe](/test/property/logic.property.test.ts#L448)
- Test (integration): [z3-smtlib.integration.test.ts:31 each golden sample compiles to Z3-accepted SMT-LIB (sat, no errors)](/test/integration/z3-smtlib.integration.test.ts#L31)
- Test: [smtlib.test.ts:39 compiles logic IR with mapping comments](/test/contract/smtlib.test.ts#L39)
- Implementation: [smtlib.ts:204 compileSmtlib()](/src/domain/formal/smtlib.ts#L204)
- Test: [smtlib.test.ts:39 compiles logic IR with mapping comments](/test/contract/smtlib.test.ts#L39), [smtlib.test.ts:57 produces a single smt2 without solver commands (callers append them)](/test/contract/smtlib.test.ts#L57)

#### Requirement model

```alloy
// Compiler observations are over resolved symbols, not string replacement.
sig Symbol { encoded : one Label }
fact symbol_encoding_injective { all disj a, b : Symbol | a.encoded != b.encoded }
sig Compilation { symbols : set Symbol, included : set Claim, commandsPresent : one Bool }
pred reusable_compilation[c : Compilation] { c.commandsPresent = False }
// Safety contract: reusable compilation cannot issue a solver query. Concrete
// Unicode encoding, inert mapping comments and literal preservation use tests.
// Safety: compiler names injective.
assert compiler_names_injective { all disj a, b : Symbol | a.encoded != b.encoded }
```

### Requirement: Per-Spec Combined SMT-LIB Compilation [FLA-SPEC-COMBINE]
WHEN a merged capability's admitted mandatory rules are compiled, THE spec-check tool SHALL construct a checked shared signature and named assertions with an authoritative surviving-claim set while separating reusable compilation from query commands.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Scope`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Interaction Protocols`
- [Design: Concepts and assumptions](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#concepts-and-assumptions)
- [Design: Expression and semantic IR](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#expression-and-semantic-ir)

#### Scenario: Variable And Function Deduplication [FLA-SPEC-DEDUP]
WHEN compatible declarations refer to the same resolved concept, THE spec-check tool SHALL emit one declaration and SHALL retain all compatible claims, including in clustering and cross-side queries.

#### Scenario: Function Signature Conflict Detection [FLA-SPEC-CONFLICT]
IF a residual compiler input conflicts with an established function signature, THEN THE spec-check tool SHALL emit `logic.merge_conflict`, exclude the later offending claim, and preserve both signatures and source identities.

#### Scenario: Variable Sort Conflict Detection [FLA-SPEC-VARSORT-CONFLICT]
IF a residual compiler input conflicts with an established variable sort, THEN THE spec-check tool SHALL emit `logic.merge_conflict` for `variable_sort_mismatch` and SHALL exclude the later offending claim with both sorts preserved.

#### Scenario: Symbol Kind Collision Detection [FLA-SPEC-SYMKIND-CONFLICT]
IF residual declarations bind one solver symbol as both constant and function, THEN THE spec-check tool SHALL report `symbol_kind_collision` and SHALL exclude the offending claim.

#### Scenario: Single Conflict Reason With Fixed Precedence [FLA-SPEC-CONFLICT-ORDER]
IF a residual offending claim has multiple declaration conflict kinds, THEN THE spec-check tool SHALL retain one compiler exclusion reason in the existing variable-sort, function-signature, then symbol-kind precedence.

**Postcondition:** These defensive compiler exclusions do not authorize first-wins resolution of ambiguous semantic identities during concept discovery.

#### Scenario: Surviving Claim Set Is Authoritative [FLA-SPEC-CLAIMIDS]
WHEN compilation excludes claims, THE spec-check tool SHALL expose the exact surviving set in input order and SHALL use that set for assertions, dependencies, labels, and downstream scope accounting.

#### Scenario: Duplicate Claim Identifier Rejected Before Solver Execution [FLA-SPEC-DUPLICATE-CLAIM-ID]
IF a compile group violates the existing raw or sanitized claim-label uniqueness precondition, THEN THE spec-check tool SHALL report `logic.invalid_group` before compilation or solver execution without merging distinct source-local claims.

#### Scenario: Oversized Compile Group Rejected Before Solver Execution [FLA-SPEC-GROUP-BOUNDS]
IF a compile group exceeds its claim or declaration bounds, THEN THE spec-check tool SHALL report `logic.invalid_group` before compilation, solver-artifact writing, or solver execution for that group while valid siblings proceed.

#### Scenario: Dangling Assertion Reference Becomes Solver Error [FLA-SPEC-DANGLING-REF]
IF a dependency becomes unresolved after exclusion, THEN THE spec-check tool SHALL mark dependent formal scope invalid before querying and SHALL preserve the unresolved-reference evidence rather than deliberately delegate detection to Z3.

**Postcondition:** The historical scenario identifier is retained, but its solver-error-only behavior is replaced by early dependency validation; unexpected solver rejection remains a backstop.

#### Scenario: Untrusted Comment Text Stays Inert [FLA-SPEC-COMMENT-SAFE]
WHEN mapping comments contain untrusted text, THE spec-check tool SHALL neutralize line breaks so the text cannot introduce solver commands.

#### Scenario: Named Assertion Labels Map To Claims [FLA-SPEC-NAMED]
WHEN assertions are named, THE spec-check tool SHALL map every unique label to an included source-local claim and assertion index with authored IDs retained as display metadata.

#### Scenario: Assertion Label Encoding Is Injective [FLA-SPEC-LABEL-ENCODE]
WHEN labels are encoded, THE spec-check tool SHALL preserve the existing injective identifier mapping and an unambiguous assertion-index separator while separating concept, constructor, and assertion namespaces.

##### Historical verification evidence
- Implementation: [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278)
- Test: [smtlib.test.ts:90 deduplicates identical variable declarations](/test/contract/smtlib.test.ts#L90), [smtlib.test.ts:102 deduplicates identical function declarations](/test/contract/smtlib.test.ts#L102)
- Implementation: [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278), [logic-analysis.ts:315 conflictToFinding()](/src/domain/formal/logic-analysis.ts#L315)
- Test: [smtlib.test.ts:115 detects function signature conflicts and excludes conflicting claims](/test/contract/smtlib.test.ts#L115), [logic-analysis.test.ts:575 maps each merge conflict kind to merge_conflict finding with stable evidence](/test/contract/logic-analysis.test.ts#L575)
- Test (property): [logic.property.test.ts:700 function-signature conflict histories keep function-conflict-only scope](/test/property/logic.property.test.ts#L700)
- Test: [smtlib.test.ts:135 detects variable sort mismatch and excludes later claim](/test/contract/smtlib.test.ts#L135), [logic-analysis.test.ts:575 maps each merge conflict kind to merge_conflict finding with stable evidence](/test/contract/logic-analysis.test.ts#L575)
- Test (property): [logic.property.test.ts:864 regression FLA-SPEC-CONFLICT-ORDER preserves first claimant after reorder](/test/property/logic.property.test.ts#L864)
- Test: [smtlib.test.ts:155 detects symbol kind collision across claims](/test/contract/smtlib.test.ts#L155), [smtlib.test.ts:175 detects same-claim symbol kind collision](/test/contract/smtlib.test.ts#L175)
- Test (property): [logic.property.test.ts:877 regression FLA-SPEC-SYMKIND-CONFLICT same-claim cross-kind collision excludes claim](/test/property/logic.property.test.ts#L877), [logic.property.test.ts:894 regression FLA-SPEC-SYMKIND-CONFLICT same-claim collision can cite excluded existing claim](/test/property/logic.property.test.ts#L894)
- Test: [smtlib.test.ts:196 uses conflict precedence variable before function before symbol-kind](/test/contract/smtlib.test.ts#L196)
- Test: [smtlib.test.ts:115 detects function signature conflicts and excludes conflicting claims](/test/contract/smtlib.test.ts#L115)
- Test (property): [logic.property.test.ts:655 compile is deterministic for the same generated state](/test/property/logic.property.test.ts#L655), [logic.property.test.ts:675 append-compatible histories are monotonic when no reorders/removals occur](/test/property/logic.property.test.ts#L675)
- Implementation: [logic-analysis.ts:200 preflightGroupClaimIds()](/src/domain/formal/logic-analysis.ts#L200), [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:556 rejects duplicate raw claim IDs as invalid group before compile and solver work](/test/contract/logic-analysis.test.ts#L556), [logic-analysis.test.ts:619 detects constructed sanitized-id collision in preflight](/test/contract/logic-analysis.test.ts#L619)
- Test (property): [logic.property.test.ts:717 constructed sanitized collisions reject with duplicate_sanitized_claim_id](/test/property/logic.property.test.ts#L717), [logic.property.test.ts:733 logic analysis performs zero solver and write work for invalid groups](/test/property/logic.property.test.ts#L733)
- Implementation: [logic-analysis.ts:267 preflightGroupBounds()](/src/domain/formal/logic-analysis.ts#L267), [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278)
- Test: [smtlib.test.ts:68 throws its size precondition as an unreachable backstop when called directly past a bound](/test/contract/smtlib.test.ts#L68), [logic-analysis.test.ts:631 rejects an oversized compile group as invalid group before compile and solver work](/test/contract/logic-analysis.test.ts#L631), [logic-analysis.test.ts:651 rejects a claim with too many declarations as invalid group scoped to that claim](/test/contract/logic-analysis.test.ts#L651), [logic-analysis.test.ts:681 rejects only the oversized group while a valid sibling group still runs](/test/contract/logic-analysis.test.ts#L681)
- Test (property): [logic.property.test.ts:761 preflightGroupBounds accepts group cardinality at the limit and flags it one past the limit](/test/property/logic.property.test.ts#L761), [logic.property.test.ts:780 preflightGroupBounds counts variables plus functions against the per-claim limit](/test/property/logic.property.test.ts#L780)
- Implementation: [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:318 solver error produces logic.solver_error finding](/test/contract/logic-analysis.test.ts#L318)
- Test (property): [logic.property.test.ts:812 compiler comment emission neutralizes newline-based SMT command injection](/test/property/logic.property.test.ts#L812)
- Test: [smtlib.test.ts:79 uses named assertions with :named labels](/test/contract/smtlib.test.ts#L79), [smtlib.test.ts:214 maps assertion labels back to claim IDs](/test/contract/smtlib.test.ts#L214)
- Implementation: [smtlib.ts:142 sanitizeIdentifier()](/src/domain/formal/smtlib.ts#L142), [smtlib.ts:278 compileSpecSmtlib()](/src/domain/formal/smtlib.ts#L278)
- Test: [smtlib.test.ts:226 keeps assertion labels distinct for formerly colliding identifiers](/test/contract/smtlib.test.ts#L226)
- Test (property): [logic.property.test.ts:459 sanitizer is injective for generated distinct raw identifiers](/test/property/logic.property.test.ts#L459), [logic.property.test.ts:470 sanitizeIdentifier is uniquely decodable, proving injectivity over full Unicode](/test/property/logic.property.test.ts#L470)

#### Requirement model

```alloy
abstract sig DeclarationKind {}
one sig VariableDeclaration, FunctionDeclaration extends DeclarationKind {}
sig Signature {}
sig Declaration { owner : one Claim, symbol : one Symbol, kind : one DeclarationKind, signature : one Signature }
abstract sig ConflictReason {}
one sig VariableSortMismatch, FunctionSignatureMismatch, SymbolKindMismatch extends ConflictReason {}
sig CompileInput {
  claims : set Claim, retained : set Claim, excluded : set Claim, unresolved : set Claim,
  oversized : one Bool, reusable : one Compilation
}
fun declarations[c : Claim] : set Declaration { owner.c }
fun conflict_reason[a,b : Claim] : lone ConflictReason {
  (some x : declarations[a], y : declarations[b] | x.symbol = y.symbol and x.kind = VariableDeclaration and
    y.kind = VariableDeclaration and x.signature != y.signature) => VariableSortMismatch else
  ((some x : declarations[a], y : declarations[b] | x.symbol = y.symbol and x.kind = FunctionDeclaration and
    y.kind = FunctionDeclaration and x.signature != y.signature) => FunctionSignatureMismatch else
  ((some x : declarations[a], y : declarations[b] | x.symbol = y.symbol and x.kind != y.kind) => SymbolKindMismatch else none))
}
// Well-founded source-order selection: an excluded claim cannot poison later
// declarations. This is a pure compiler contract, not first-wins concept identity.
pred checked_compilation[g : CompileInput] {
  g.retained in g.claims
  all c : g.claims | (c in g.retained iff
    no conflict_reason[c,c] and
      (all p : g.retained & inputOrder/prevs[c] | no conflict_reason[p,c]))
  g.excluded = g.claims - g.retained
  g.unresolved = { c : g.retained | some c.^dependencies - g.retained }
  g.reusable.included = g.retained - g.unresolved
  g.reusable.symbols = { d : Declaration | d.owner in g.reusable.included }.symbol
  reusable_compilation[g.reusable]
}
pred compile_group_valid[g : CompileInput] {
  g.oversized = False
  all disj a, b : g.claims | a.compileLabel != b.compileLabel and a.sanitizedLabel != b.sanitizedLabel
}
// Safety: compiler exclusions leave the retained signature conflict-free.
assert compiler_exclusions_are_sound {
  all g : CompileInput | checked_compilation[g] implies
    all a,b : g.retained | no conflict_reason[a,b]
}
// Later conflicting declarations are a typed-compiler boundary, not a permission
// to change semantic identities. Exclusions and unresolved dependencies remain
// explicit inputs to query eligibility rather than deliberate solver errors.
```

### Requirement: Surface Ambiguity Through Sample Clustering [FLA-CLUSTER-AMBIG]
WHEN multiple candidate interpretations exist, THE spec-check tool SHALL compare compatible candidates under a satisfiable background and SHALL qualify stability by the frozen registry, sample count, and measured equivalence evidence.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- [Design: Clustering and alignment](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#clustering-and-alignment)

#### Scenario: Select Stable Interpretation [FLA-CLUSTER-STABLE]
WHEN a nonvacuous equivalence cluster meets the configured stability threshold, THE spec-check tool SHALL select its highest-confidence candidate with deterministic input-index tie-breaking and SHALL preserve evidence and registry-dependent qualifications.

#### Scenario: Surface Divergent Interpretations [FLA-CLUSTER-DIVERGE]
IF no compatible nonvacuous cluster meets the threshold, THEN THE spec-check tool SHALL preserve alternatives and SHALL label any diagnostic representative analysis interpretation-dependent rather than authoritative.

**Postcondition:** Selected artifacts retain single/stable/unstable assessment, sample count, selected input index and cluster membership on both source sides, including downstream evidence and comparisons. Single samples are not measured stable.

#### Scenario: Inconclusive Implication Check Preserved [FLA-CLUSTER-INCON]
IF an equivalence query returns timeout, unknown, or error, THEN THE spec-check tool SHALL preserve that outcome without treating the pair as equivalent or proved distinct.

**Postcondition:** Only an UNSAT sample premise is categorized as inconsistent. Unknown, timeout, and error premises are inconclusive; admission-skipped premises are unassessed. Dependent equivalence checks remain blocked scope rather than proof of inconsistency.

#### Scenario: Single Solver Command Per Implication Query [FLA-CLUSTER-QUERY]
WHEN compatible satisfiable samples A and D are compared, THE spec-check tool SHALL emit one shared declaration signature and the formula `B and A and not(D)` with exactly one `check-sat` per implication script.

#### Scenario: Impossible Samples Do Not Establish Stable Meaning [FLA-CLUSTER-VACUOUS]
IF samples are inconsistent under the background, THEN THE spec-check tool SHALL identify their inconsistency separately and SHALL NOT use their vacuous mutual implication to claim stable intended meaning.

#### Scenario: Single Sample Does Not Establish Agreement [FLA-CLUSTER-SINGLE]
WHEN only one valid sample exists, THE spec-check tool SHALL report a selected interpretation and sample count without claiming observed cross-sample stability.

##### Historical verification evidence
- Implementation: [clustering.ts:97 clusterFormalizationSamples()](/src/domain/formal/clustering.ts#L97)
- Test: [clustering.test.ts:30 selects representative from stable cluster when threshold met](/test/contract/clustering.test.ts#L30)
- Test: [clustering.test.ts:53 emits ambiguity finding when no cluster meets stability threshold](/test/contract/clustering.test.ts#L53), [clustering.test.ts:122 with two non-equivalent samples (sat both) produces two clusters](/test/contract/clustering.test.ts#L122)
- Implementation: [clustering.ts:290 classifyImplication()](/src/domain/formal/clustering.ts#L290)
- Test: [clustering.test.ts:79 records inconclusive pairwise result when z3 returns timeout](/test/contract/clustering.test.ts#L79)
- Implementation: [clustering.ts:244 buildImplicationQuery()](/src/domain/formal/clustering.ts#L244)
- Test: [implication-query.test.ts:20 contains exactly one (check-sat) command](/test/contract/implication-query.test.ts#L20), [implication-query.test.ts:31 does not directly assert right-side claim expressions](/test/contract/implication-query.test.ts#L31), [implication-query.test.ts:48 encodes implication as assert-left + negate-right](/test/contract/implication-query.test.ts#L48)

#### Requirement model

```alloy
fun sample_meaning[s : Sample] : set Valuation {
  s.claim.modal = Permission => s.claim.guard & response[s] & s.claim.postcondition else
  (s.claim.form != Refinement => s.claim.input & response[s] & s.claim.postcondition else
    { v : Valuation | v not in s.claim.guard or v in response[s] & s.claim.postcondition })
}
fun equivalent_class[s : Sample] : set Sample {
  { t : s.*known_equivalence & Run.accepted | t.claim = s.claim and
    (let B = { g : Group | t.claim in members[g] }.background |
      some B & sample_meaning[t] and some B & sample_meaning[s] and
        B & sample_meaning[t] = B & sample_meaning[s]) }
}
// Mutual conclusive UNSAT observations are edges; unknown/skipped queries never
// become equivalence edges. Transitive closure permits independently proved chains.
fun known_equivalence : Sample -> Sample {
  { s,t : Run.accepted | s.claim = t.claim and
    (s = t or (some a,b : Run.persisted | a.kind = Implication and b.kind = Implication and
      a.stage = ClusteringQueries and b.stage = ClusteringQueries and
      a.premiseSample = s and a.conclusionSample = t and
      b.premiseSample = t and b.conclusionSample = s and verdict[a] = Unsat and verdict[b] = Unsat)) }
}
pred stable_sample[s : Sample] {
  #ready_samples[s.claim] > 1
  some equivalent_class[s]
  (#equivalent_class[s]).mul[Config.thresholdDenominator] >=
    (#ready_samples[s.claim]).mul[Config.thresholdNumerator]
}
pred preferred[s, t : Sample] {
  s.confidence > t.confidence or (s.confidence = t.confidence and s.attempt in t.attempt.earlier)
}
pred choose[c : Claim, s : Sample] {
  Run.phase = Selecting and c in candidates and no c.(Run.selected)
  { q : Query | q.stage = ClusteringQueries and c in q.owners } in Run.persisted + Run.skipped
  s in ready_samples[c]
  (some t : ready_samples[c] | stable_sample[t]) implies stable_sample[s]
  no t : ready_samples[c] - s | (stable_sample[t] iff stable_sample[s]) and
    (#equivalent_class[t] > #equivalent_class[s] or
      (#equivalent_class[t] = #equivalent_class[s] and preferred[t, s]))
  Run.selected' = Run.selected + c -> s
  Run.phase' = Run.phase
  Run.frozen' = Run.frozen
  keep_attempts_except_selection
  keep_queries
}
// Safety: a singleton never establishes measured cross-sample stability.
assert singleton_not_stable { always (all s : Run.accepted | one ready_samples[s.claim] implies not stable_sample[s]) }
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
// Deterministic tie-breaking additionally uses immutable attempt input order.
// Two-run serialization is an implementation-test boundary, not cluster identity.
// Safety: same finite meanings form symmetric equivalence classes.
assert equivalence_symmetric { always (all s, t : Run.accepted | t in equivalent_class[s] iff s in equivalent_class[t]) }
```

### Requirement: Run Per-Spec Combined Solver Analysis [FLA-RUN-LOGIC]
WHEN static semantic artifacts are available, THE spec-check tool SHALL analyze each merged capability under explicit background premises and separate mandatory, advisory, permission, and scenario tracks with valuation-based result meanings.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Interaction Protocols`
- [Design: Static query contracts](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#static-query-contracts)

#### Scenario: Report Contradiction With Unsat-Core Identification [FLA-LOGIC-CORE]
WHEN `B and C` is UNSAT after a satisfiable background check, THE spec-check tool SHALL report a mandatory `logic.contradiction` and SHALL attempt a source-mapped sufficient unsat core without calling it minimal unless minimized.

#### Scenario: Advisory-Only Core Reported At Lower Severity [FLA-LOGIC-ADVISORY]
WHEN an advisory extension conflicts with the mandatory baseline or other advisories, THE spec-check tool SHALL report the advisory conflict at warning severity without declaring the mandatory model inconsistent because of the advisory addition.

#### Scenario: Preserve Inconclusive Solver Result [FLA-LOGIC-TIMEOUT]
IF a required static query returns timeout or unknown, THEN THE spec-check tool SHALL preserve it and SHALL emit a warning-scoped inconclusive outcome instead of a clean result.

#### Scenario: Sat Result Triggers Deeper Analysis [FLA-LOGIC-SAT]
WHEN the mandatory global query is SAT, THE spec-check tool SHALL describe a shared satisfying valuation and SHALL plan bounded guard, activation, self-response, pair, coverage, permission, and scenario checks where their prerequisites hold.

#### Scenario: Solver Error Produces Finding [FLA-LOGIC-ERROR]
IF Z3 emits an error diagnostic even alongside SAT or UNSAT, THEN THE spec-check tool SHALL classify the query as an error and SHALL preserve the exact script and captured outputs.

#### Scenario: Inconsistent Background Blocks Favorable Conclusions [FLA-LOGIC-BACKGROUND]
IF the background is UNSAT, THEN THE spec-check tool SHALL report inconsistent premises and SHALL block dependent favorable coverage, implication, stability, and feasibility conclusions.

#### Scenario: Failed Core Extraction Preserves Original Outcome [FLA-LOGIC-CORE-FAIL]
IF an auxiliary core query fails after an UNSAT primary query, THEN THE spec-check tool SHALL preserve both executions and the original UNSAT outcome with attribution explicitly unavailable.

##### Historical verification evidence
- Implementation: [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:122 mandatory contradiction (unsat) reported at severity error](/test/contract/logic-analysis.test.ts#L122), [logic-analysis.test.ts:267 unsat core identifies specific conflicting claims](/test/contract/logic-analysis.test.ts#L267)
- Test (integration): [z3-smtlib.integration.test.ts:75 directly contradictory bare assertions produce UNSAT](/test/integration/z3-smtlib.integration.test.ts#L75)
- Implementation: [logic-analysis-sexpr.ts:402 deriveSeverityFromClaims()](/src/domain/formal/logic-analysis-sexpr.ts#L402), [logic-analysis-sexpr.ts:443 obligationToSeverity()](/src/domain/formal/logic-analysis-sexpr.ts#L443)
- Test: [logic-analysis.test.ts:142 advisory-only contradiction (unsat) reported at severity warning](/test/contract/logic-analysis.test.ts#L142), [logic-analysis.test.ts:297 severity derived from highest-obligation in core (advisory when no mandatory in core)](/test/contract/logic-analysis.test.ts#L297)
- Test: [logic-analysis.test.ts:162 timeout/unknown result preserved as inconclusive finding](/test/contract/logic-analysis.test.ts#L162)
- Test: [logic-analysis.test.ts:226 sat result does not generate contradiction finding](/test/contract/logic-analysis.test.ts#L226)
- Test: [logic-analysis.test.ts:318 solver error produces logic.solver_error finding](/test/contract/logic-analysis.test.ts#L318)

#### Requirement model

```alloy
pred query_enabled[q : Query] {
  ((Run.phase = Selecting and q.stage = ClusteringQueries) or (Run.phase = Analyzing and q.stage = AnalysisQueries))
  q not in Run.issued + Run.skipped
  q.group in Run.frozen
  q.owners in candidates
  q.stage = AnalysisQueries implies q.owners in (Run.selected).Sample
  q.premiseSample + q.conclusionSample in Run.accepted
  q.prerequisites in Run.persisted
  all p : q.satPrerequisites | verdict[p] = Sat
  q.bytesWithinBound = True and q.concurrencyAdmitted = True
  q.pairWithinBudget = True
  checked_compilation[q.compilation]
  compile_group_valid[q.compilation]
  q.compilation.claims = candidates & members[q.group]
  q.owners in q.compilation.reusable.included
  q.family in q.compilation.reusable.included
  q.observed = Sat implies some formula[q]
  q.observed = Unsat implies no formula[q]
  q.kind not in Background + AuxiliaryCore implies
    some p : q.satPrerequisites | p.kind = Background and p.group = q.group
  q.kind in Activation + SelfResponse implies
    some p : q.satPrerequisites | p.kind = Guard and p.first = q.first
  q.kind = PairConflict implies
    some p : q.satPrerequisites | p.kind = PairGuard and p.first = q.first and p.second = q.second
  q.kind = Implication implies
    some p : q.satPrerequisites | p.kind = PremiseCheck and p.premise = q.premise and p.group = q.group
  q.kind in Coverage + PermissionQuery + PositiveExample + NegativeExample implies
    some p : q.satPrerequisites | p.kind = Global and p.group = q.group
  q.kind = PermissionQuery implies q.first.modal = Permission
  q.kind = AdvisoryQuery implies q.first.modal = Advisory
  q.kind = PositiveExample implies q.first.form = Example
  q.kind = NegativeExample implies q.first.form = ProhibitedExample
}
// Outcome projections distinguish errors/inconclusiveness from clean results.
fun contradictions : set Query { { q : Run.persisted | q.kind in Global + Activation + PairConflict and verdict[q] = Unsat } }
fun inconclusive : set Query { { q : Run.persisted | verdict[q] in Unknown + Timeout + SolverError } }
fun favorable : set Query { { q : Run.persisted | q.kind in Coverage + Implication and verdict[q] = Unsat and
  some q.group.background and no q.owners & interpretation_dependent and all p : q.satPrerequisites | verdict[p] = Sat } }
fun interpretation_dependent : set Claim {
  { c : candidates | some c.(Run.selected) and #ready_samples[c] > 1 and not stable_sample[c.(Run.selected)] }
}
fun temp_cleanup_warnings : set Attempt { { a : Run.settled | a.cleanupFails = True } }
```

### Requirement: Group Specs-Forward Logic By Merged Capability [FLA-GROUP-MERGED]
WHEN the spec-check tool prepares specs-forward logical analysis, THE spec-check tool SHALL group spec-derived claims by merged capability identity rather than by raw source-spec file path, SHALL use the merged capability `logicalFile` as the artifact-naming and report-grouping key, SHALL exclude non-spec claims from this capability-grouped logic path, and SHALL derive grouping keys from the same shared semantic key helper that formalization grouping uses.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Postconditions`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Provenance And Grouping Contract`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Verification Strategy`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Scope`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Interface Contracts`

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

##### Evidence
- Implementation: [pipeline-helpers.ts:356 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L356), [grouping.ts:185 selectClaimLogicalFile()](/src/domain/formal/grouping.ts#L185)
- Test: [safety-liveness.invariant.test.ts:177 LIVE-11: if opencode responds with valid output, formalization completes](/test/invariant/safety-liveness.invariant.test.ts#L177)
- Test (property): [semantic-batching.property.test.ts:179 matches solver grouping after the same explicit filtering](/test/property/semantic-batching.property.test.ts#L179)

#### Requirement model

```alloy
// Safety: one shared semantic key groups multi-file capability claims.
assert key_group_parity { all a, b : eligible | key[a] = key[b] implies
  (some g : Group | a + b in members[g]) }
```

### Requirement: Pairwise Guard-Activation Contradiction Checking [FLA-PAIRWISE]
WHEN prerequisite static queries permit co-activation analysis, THE spec-check tool SHALL select bounded pairs using typed dependencies and SHALL check guard coexistence before testing the full mandatory set under both guards.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`
- [Design: Static query contracts](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#static-query-contracts)

#### Scenario: Conditional Contradiction Detected [FLA-PAIRWISE-CONTRA]
WHEN `B and G_i and G_j` is SAT and adding `C` is UNSAT, THE spec-check tool SHALL report `logic.conditional_contradiction` with the selected activation and actual sufficient conflicting rules.

#### Scenario: Compatible Conditional Assertions Produce No Finding [FLA-PAIRWISE-COMPAT]
WHEN co-active guards and the mandatory constraints admit a shared valuation, THE spec-check tool SHALL omit a pair-conflict finding without claiming that every input in the guard region has a valid response.

#### Scenario: Pairwise Check Bounded By Pair Count [FLA-PAIRWISE-BOUND]
WHEN candidate pairs exceed effective `pairBudget` with default 200, THE spec-check tool SHALL execute only the deterministic admitted prefix and SHALL report remaining scope while using the shared run-wide solver pool.

**Postcondition:** A candidate is a pair surviving the conservative dependency-component filter. Examining an admitted candidate consumes one pair allowance before guard-feasibility/co-activation results; compatible, infeasible, and unestablished candidates still count. This is not a findings quota or an actual-script counter. Unissued co-activation/conflict plans are reported with prerequisite or admission reasons, compactly aggregated where needed. Advisory pair examinations have their own bounded prefix; all actual scripts additionally consume the shared script allowance.

#### Scenario: Severity Derived From Paired Claims [FLA-PAIRWISE-SEV]
WHEN a mandatory-track co-activation conflict is established, THE spec-check tool SHALL derive attribution from its actual sufficient core and SHALL report it as an error while advisory-track conflicts remain warnings.

**Postcondition:** A multi-rule core is not falsely attributed only to the selected pair.

##### Historical verification evidence
- Implementation: [logic-analysis-checks.ts:218 runPairwiseContradictionChecks()](/src/domain/formal/logic-analysis-checks.ts#L218), [logic-analysis-checks.ts:361 checkPairContradiction()](/src/domain/formal/logic-analysis-checks.ts#L361)
- Test: [logic-analysis.test.ts:339 sat with conditional assertions from different claims triggers pairwise checks](/test/contract/logic-analysis.test.ts#L339)
- Test (integration): [z3-smtlib.integration.test.ts:149 conditional contradiction detected by pairwise check (guards forced)](/test/integration/z3-smtlib.integration.test.ts#L149)
- Implementation: [logic-analysis-checks.ts:361 checkPairContradiction()](/src/domain/formal/logic-analysis-checks.ts#L361)
- Test: [logic-analysis.test.ts:383 compatible conditional assertions produce no pairwise finding](/test/contract/logic-analysis.test.ts#L383)
- Implementation: [logic-analysis-checks.ts:218 runPairwiseContradictionChecks()](/src/domain/formal/logic-analysis-checks.ts#L218)
- Test: [logic-analysis.test.ts:420 pairwise checks bounded by pair count limit](/test/contract/logic-analysis.test.ts#L420)
- Implementation: [logic-analysis-sexpr.ts:402 deriveSeverityFromClaims()](/src/domain/formal/logic-analysis-sexpr.ts#L402)

#### Requirement model

```alloy
// Pair candidates, issued scripts and findings are distinct budgets/sets.
fun pair_candidates : set Query { { q : Query | q.kind = PairConflict } }
fun skipped_pairs : set Query { pair_candidates & Run.skipped }
// Safety: no pair-conflict execution precedes its SAT guard-coexistence query.
assert pair_prerequisites {
  always (all q : Run.issued | q.kind = PairConflict implies
    all p : q.satPrerequisites | p in Run.persisted and verdict[p] = Sat)
}
```

### Requirement: Completeness Gap Detection [FLA-COMPLETENESS]
WHEN an explicit coverage obligation identifies applicability predicate K and a behavior family with guards, THE spec-check tool SHALL search for `B and K and not(or guards)` and SHALL report its outcome as scoped guard coverage over valuations.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- [Design: Static query contracts](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#static-query-contracts)

#### Scenario: Gap Detected In All-Conditional Spec [FLA-COMPLETENESS-GAP]
WHEN the scoped coverage query is SAT, THE spec-check tool SHALL report `logic.completeness_gap` with a decoded uncovered valuation, applicability domain, behavior family, and included/excluded rule scope.

#### Scenario: No Gap When Ubiquitous Assertions Exist [FLA-COMPLETENESS-UBIQ]
WHEN a group contains ubiquitous assertions unrelated to the selected behavior family, THE spec-check tool SHALL continue the scoped coverage query rather than suppress coverage for the entire group.

**Postcondition:** The historical unconditional-suppression behavior is intentionally replaced; a relevant ubiquitous behavior rule may cover its own family.

#### Scenario: Exhaustive Guards Produce No Gap Finding [FLA-COMPLETENESS-EXHAUST]
WHEN the scoped coverage query is UNSAT under satisfiable premises, THE spec-check tool SHALL report no uncovered valuation in that scope without claiming response completeness or temporal reachability.

#### Scenario: Missing Coverage Expectation Is A Suggestion [FLA-COVERAGE-POTENTIAL]
WHEN a guard-gap search has no explicit applicability expectation, THE spec-check tool SHALL label any result a potential gap for review rather than a proven completeness defect or missing idle behavior.

#### Scenario: Inconclusive Coverage Remains Visible [FLA-COVERAGE-UNKNOWN]
IF coverage is skipped, blocked, timed out, or unknown, THEN THE spec-check tool SHALL record that scope as unestablished rather than exhaustive.

##### Historical verification evidence
- Implementation: [logic-analysis-checks.ts:518 runCompletenessCheck()](/src/domain/formal/logic-analysis-checks.ts#L518)
- Test: [logic-analysis.test.ts:446 completeness gap detected when all assertions are conditional](/test/contract/logic-analysis.test.ts#L446)
- Test (integration): [z3-smtlib.integration.test.ts:173 completeness gap: all-conditional spec has unreachable states](/test/integration/z3-smtlib.integration.test.ts#L173)
- Test: [logic-analysis.test.ts:484 completeness check skipped when ubiquitous assertions exist](/test/contract/logic-analysis.test.ts#L484)
- Test: [logic-analysis.test.ts:516 exhaustive guards produce no completeness gap finding](/test/contract/logic-analysis.test.ts#L516)
- Test (integration): [z3-smtlib.integration.test.ts:445 exhaustive guards leave no completeness gap](/test/integration/z3-smtlib.integration.test.ts#L445)

#### Requirement model

```alloy
// Coverage quantifies only over the selected behavior family and applicability.
// Unrelated unconditional rules do not erase uncovered valuations.
fun gaps : set Query { { q : Run.persisted | q.kind = Coverage and q.explicitCoverage = True and verdict[q] = Sat } }
fun potential_gaps : set Query { { q : Run.persisted | q.kind = Coverage and q.explicitCoverage = False and verdict[q] = Sat } }
// Safety: a reported gap has an actual finite uncovered valuation.
assert gaps_have_witnesses { always (all q : gaps | some formula[q]) }
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
// Terminal timeout is an external bounded-process observation; it is not SAT.
// Event: persist one terminal query, including error/timeout and auxiliary work.
pred persist[q : Query] {
  Run.phase in Selecting + Analyzing and q in Run.issued - Run.persisted
  q.writeFails = False
  Run.persisted' = Run.persisted + q
  Run.phase' = Run.phase
  Run.frozen' = Run.frozen
  keep_attempts
  keep_queries_except_persistence
}
// Safety: timeout does not become a contradiction or favorable proof.
assert timeouts_not_proofs { always (no { q : Run.persisted | verdict[q] = Timeout } & (contradictions + favorable)) }
```

### Requirement: Solver Evidence Persistence [FLA-SOLVER-PERSIST]
WHEN a solver script executes, THE spec-check tool SHALL persist its exact commands, checked signature and assumptions, source attribution, captured stdout/stderr, solver identity/options, and terminal status under a stable query identifier.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- [Design: Interface Contracts](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#interface-contracts)

#### Scenario: Sat Result Persisted [FLA-PERSIST-SAT]
WHEN a query is SAT, THE spec-check tool SHALL preserve the executed script including `check-sat`, its outputs, and any separately executed witness/model script and decoding status.

**Postcondition:** Value decoding requires an exact standalone top-level SAT verdict supporting LF or CRLF output. Missing/non-SAT verdicts, duplicate bindings, malformed scalar values, and unexpected symbols cannot become a complete witness. Completeness refers to the explicitly requested scalar names; partial and unavailable decoding remain distinct from complete assignment evidence. Raw stdout is preserved unchanged.

#### Scenario: Unsat Core Persisted [FLA-PERSIST-UNSAT]
WHEN a query is UNSAT, THE spec-check tool SHALL preserve the primary script and outputs plus every executed core-extraction script, output, and label mapping.

#### Scenario: Deeper And Failed Queries Are Persisted [FLA-PERSIST-ALL]
WHEN clustering, activation, pair, coverage, advisory, permission, scenario, or comparison scripts execute, THE spec-check tool SHALL preserve each execution even if it errors, times out, is unknown, or fails auxiliary extraction.

##### Historical verification evidence
- Implementation: [logic-analysis.ts:380 analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L380)
- Test: [logic-analysis.test.ts:182 persists SMT-LIB input, stdout, stderr for each spec group](/test/contract/logic-analysis.test.ts#L182)

#### Requirement model

```alloy
// Safety: completion binds every executed script, including failed auxiliaries.
assert complete_requires_evidence { always (Run.phase = Complete implies Run.issued = Run.persisted) }
// Safety: failed core extraction never erases a primary result.
assert primary_outcome_retained { always (all q : Run.persisted | some q.auxiliaryOf implies q.auxiliaryOf in Run.persisted) }
```

### Requirement: Shared Semantic Logical-File Grouping [FLA-SEMANTIC-GROUPING]
WHEN the spec-check tool groups formalizable claims (claims with `kind` equal to `requirement` or `scenario`) for formalization or for solver analysis, THE spec-check tool SHALL derive each claim's semantic grouping key from one shared key helper, where a capability-bearing claim keys to the mapped merged capability `logicalFile` or to the synthetic fallback `<merged-spec/{capability}>` when unmapped, and a capability-less claim keys to its `claim.provenance.file`. Semantic keys SHALL be compared by exact string equality without normalization, logical groups SHALL be ordered by first occurrence of the semantic key in eligible-claim order, and claims within each logical group SHALL preserve eligible input order.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Domain Model`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Interface Contracts`

#### Scenario: Mapped Capability Groups By Logical File [FLA-SEMGRP-MAPPED]
WHEN a formalizable claim carries a capability that is present in the logical-file map, THE spec-check tool SHALL group that claim under the mapped `logicalFile` value.

**Postcondition:** The claim's semantic key equals the mapped `logicalFile` string exactly.

##### Evidence
- Implementation: [grouping.ts:185 selectClaimLogicalFile()](/src/domain/formal/grouping.ts#L185), [grouping.ts:224 groupFormalizationClaims()](/src/domain/formal/grouping.ts#L224)
- Test: [semantic-grouping.test.ts:112 selects mapped, provenance, and synthetic fallback keys exactly](/test/contract/semantic-grouping.test.ts#L112)

#### Scenario: Capability-Less Claim Groups By Provenance File [FLA-SEMGRP-PROVENANCE]
WHEN a formalizable claim has no capability, THE spec-check tool SHALL group that claim under its `claim.provenance.file` string, stored verbatim without normalization or resolution.

**Postcondition:** The claim's semantic key equals its provenance file string exactly.

##### Evidence
- Implementation: [grouping.ts:185 selectClaimLogicalFile()](/src/domain/formal/grouping.ts#L185), [grouping.ts:224 groupFormalizationClaims()](/src/domain/formal/grouping.ts#L224)
- Test: [semantic-grouping.test.ts:112 selects mapped, provenance, and synthetic fallback keys exactly](/test/contract/semantic-grouping.test.ts#L112)

#### Scenario: Unmapped Capability Uses Synthetic Fallback [FLA-SEMGRP-FALLBACK]
WHEN a formalizable claim carries a capability that is absent from the logical-file map (including when the map is empty), THE spec-check tool SHALL group that claim under the synthetic key `<merged-spec/{capability}>`.

**Postcondition:** Capability-bearing claims never fall back to provenance-file grouping merely because the map lacks an entry.

##### Evidence
- Implementation: [grouping.ts:185 selectClaimLogicalFile()](/src/domain/formal/grouping.ts#L185), [grouping.ts:224 groupFormalizationClaims()](/src/domain/formal/grouping.ts#L224)
- Test: [semantic-grouping.test.ts:112 selects mapped, provenance, and synthetic fallback keys exactly](/test/contract/semantic-grouping.test.ts#L112)

#### Scenario: Historical File Grouping Is Emergent Only [FLA-SEMGRP-EMERGENT]
WHEN the semantic keys of the input claims equal their provenance files, THE spec-check tool SHALL produce groups identical to historical file grouping as an emergent outcome, and SHALL NOT provide file grouping as a selectable mode.

**Postcondition:** There is exactly one production grouping path; legacy-style grouping is an output equivalence, not a configuration.

##### Evidence
- Implementation: [grouping.ts:224 groupFormalizationClaims()](/src/domain/formal/grouping.ts#L224)
- Test (property): [semantic-batching.property.test.ts:207 equals historical file grouping when semantic keys equal provenance files](/test/property/semantic-batching.property.test.ts#L207)

#### Scenario: Requirements And Scenarios Share Grouping Semantics [FLA-SEMGRP-KINDS]
WHEN a logical group contains both requirement claims and scenario claims, THE spec-check tool SHALL compute their semantic keys with the same shared key helper and SHALL place them in the same logical group when their keys are equal.

**Postcondition:** Requirement and scenario claims with equal semantic keys are never split into separate logical groups by kind.

##### Evidence
- Implementation: [grouping.ts:208 isFormalizableClaim()](/src/domain/formal/grouping.ts#L208), [grouping.ts:224 groupFormalizationClaims()](/src/domain/formal/grouping.ts#L224)
- Test (integration): [semantic-batching.integration.test.ts:173 aligns merged grouping, provenance, bounds, prompt, cleanup, and evidence](/test/integration/semantic-batching.integration.test.ts#L173)

#### Scenario: Grouping Map Covers All Eligible Capabilities [FLA-SEMGRP-COVERAGE]
WHEN the grouping map is constructed from active merged specs and an eligible claim carries a capability, THE map SHALL contain an entry for that capability, or the claim SHALL receive the synthetic fallback key `<merged-spec/{capability}>`.

**Postcondition:** No capability-bearing claim ever fails to obtain a deterministic semantic key.

##### Evidence
- Implementation: [grouping.ts:102 activeMergedSpecsForGrouping()](/src/domain/formal/grouping.ts#L102), [grouping.ts:136 buildLogicalFileByCapability()](/src/domain/formal/grouping.ts#L136), [grouping.ts:185 selectClaimLogicalFile()](/src/domain/formal/grouping.ts#L185)
- Test: [semantic-grouping.test.ts:112 selects mapped, provenance, and synthetic fallback keys exactly](/test/contract/semantic-grouping.test.ts#L112)

#### Scenario: Solver And Formalization Grouping Parity [FLA-SEMGRP-PARITY]
WHEN solver grouping and formalization grouping process the same claims after the same explicit pre-grouping filtering, THE spec-check tool SHALL produce the same semantic key for the same claim inputs in both phases.

**Postcondition:** No key drift exists between formalization groups and solver groups.

##### Evidence
- Implementation: [grouping.ts:185 selectClaimLogicalFile()](/src/domain/formal/grouping.ts#L185), [grouping.ts:224 groupFormalizationClaims()](/src/domain/formal/grouping.ts#L224), [pipeline-helpers.ts:356 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L356)
- Test (property): [semantic-batching.property.test.ts:179 matches solver grouping after the same explicit filtering](/test/property/semantic-batching.property.test.ts#L179)
- Test (integration): [semantic-batching.integration.test.ts:173 aligns merged grouping, provenance, bounds, prompt, cleanup, and evidence](/test/integration/semantic-batching.integration.test.ts#L173)

#### Scenario: Deterministic Group And Claim Ordering [FLA-SEMGRP-ORDER]
WHEN the spec-check tool forms logical groups, THE groups SHALL be ordered by first occurrence of each semantic key in eligible-claim order, and the claims inside each group SHALL preserve eligible input order.

**Postcondition:** Identical eligible inputs always produce identically ordered groups and group members.

##### Evidence
- Implementation: [grouping.ts:224 groupFormalizationClaims()](/src/domain/formal/grouping.ts#L224)
- Test (property): [semantic-batching.property.test.ts:155 groups every eligible claim exactly once in stable order](/test/property/semantic-batching.property.test.ts#L155), [semantic-batching.property.test.ts:340 repeats groups, chunks, context bytes, and hashes identically](/test/property/semantic-batching.property.test.ts#L340)

#### Requirement model

```alloy
// The same key atom denotes the same exact string, even across origin kinds.
// Safety: source identity does not depend on optional/duplicate display labels.
assert source_indexes_unique { all disj a, b : Claim | a.index != b.index }
```

### Requirement: Deterministic Physical Sub-Batching [FLA-SUBBATCH]
WHILE `maxBatchSize` is resolved from `--max-batch-size`, the config file `maxBatchSize`, or the built-in default of `32`, WHEN the spec-check tool forms first-sample physical batches from one logical group, THE spec-check tool SHALL split the group by pure, deterministic, stable slicing such that `maxBatchSize` of `0` yields exactly one physical batch per logical group regardless of group size (unbounded), `maxBatchSize` of `1` yields single-claim inline batches, and `maxBatchSize` greater than `1` yields chunks of size at most `maxBatchSize`, and sub-batching SHALL never change a claim's semantic key. The default of `32` bounds each attached `formalizations` response below the model output-token threshold that otherwise truncates the JSON into `invalid_json` and forces a full per-claim inline fallback.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Scope`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Component Design`

#### Scenario: Explicit Zero Disables Splitting [FLA-SUBBATCH-ZERO]
WHEN `maxBatchSize` is `0` (an explicit opt-in, not the default), THE spec-check tool SHALL issue exactly one first-sample physical batch per logical group regardless of how many claims the group contains.

**Postcondition:** No physical sub-batching occurs, and the single chunk is unbounded in size.

##### Evidence
- Implementation: [grouping.ts:283 splitPhysicalBatches()](/src/domain/formal/grouping.ts#L283)
- Test: [semantic-batching.test.ts:92 treats zero as unbounded and one as single-claim batching](/test/contract/semantic-batching.test.ts#L92), [semantic-grouping.test.ts:146 treats zero as unbounded, one as single-claim, and empty input as empty](/test/contract/semantic-grouping.test.ts#L146)
- Test (property): [degradation.property.test.ts:106 maxBatchSize = MAX_SAFE_INTEGER and zero both yield a single chunk](/test/property/degradation.property.test.ts#L106)

#### Scenario: Default Caps Batch Size [FLA-SUBBATCH-DEFAULT]
WHEN `maxBatchSize` is not provided by CLI flag or config file, THE spec-check tool SHALL use the default of `32`, so a logical group larger than `32` claims is split into chunks of size at most `32` and a group of `32` or fewer claims stays a single batch.

**Postcondition:** Physical sub-batching is bounded by default; the unbounded single-chunk behavior requires an explicit `maxBatchSize` of `0`.

##### Evidence
- Implementation: [formalize.ts:99 MAX_BATCH_SIZE_DEFAULT](/src/domain/formal/formalize.ts#L99), [formalize.ts:129 formalizeClaims()](/src/domain/formal/formalize.ts#L129), [grouping.ts:283 splitPhysicalBatches()](/src/domain/formal/grouping.ts#L283)
- Test: [semantic-batching.test.ts:106 caps an omitted maxBatchSize at the safe default of 32](/test/contract/semantic-batching.test.ts#L106)

#### Scenario: Single-Claim Batches When Size One [FLA-SUBBATCH-ONE]
WHEN `maxBatchSize` is `1`, THE spec-check tool SHALL issue every first-sample physical batch as a single-claim inline call.

**Postcondition:** No multi-claim attached batches are issued.

##### Evidence
- Implementation: [grouping.ts:283 splitPhysicalBatches()](/src/domain/formal/grouping.ts#L283), [formalize.ts:241 formalizePhysicalBatch()](/src/domain/formal/formalize.ts#L241)
- Test: [semantic-batching.test.ts:92 treats zero as unbounded and one as single-claim batching](/test/contract/semantic-batching.test.ts#L92), [semantic-grouping.test.ts:146 treats zero as unbounded, one as single-claim, and empty input as empty](/test/contract/semantic-grouping.test.ts#L146)

#### Scenario: Stable Chunk Sizes [FLA-SUBBATCH-CHUNKS]
WHEN `maxBatchSize` is `5` and a logical group contains 12 claims, THE spec-check tool SHALL produce physical sub-batches of sizes `[5, 5, 2]` in stable claim order.

**Postcondition:** Chunk sizes never exceed `maxBatchSize`, chunk sizes sum to the group size, and claim order is preserved.

##### Evidence
- Implementation: [grouping.ts:283 splitPhysicalBatches()](/src/domain/formal/grouping.ts#L283)
- Test: [semantic-batching.test.ts:78 splits twelve claims into stable [5, 5, 2] batches](/test/contract/semantic-batching.test.ts#L78), [semantic-grouping.test.ts:135 stably slices twelve claims into batches of five without changing the key](/test/contract/semantic-grouping.test.ts#L135)
- Test (property): [semantic-batching.property.test.ts:231 preserves sub-batch bounds, sum, key, order, ordinals, and termination](/test/property/semantic-batching.property.test.ts#L231)

#### Scenario: Invalid Batch Size Rejected [FLA-SUBBATCH-INVALID]
IF `maxBatchSize`, `samplesPerClaim`, or `concurrency` is not a safe integer within its domain (`maxBatchSize >= 0`; `samplesPerClaim >= 1`; `concurrency >= 1`), THEN THE spec-check tool SHALL reject the input with `err(readonly FormalizationError[])` before any LLM or filesystem work.

**Postcondition:** Negative, `NaN`, infinite, or fractional control values never reach grouping, sub-batching, or `mapBounded`.

##### Evidence
- Implementation: [formalize.ts:202 validateControls()](/src/domain/formal/formalize.ts#L202), [grouping.ts:283 splitPhysicalBatches()](/src/domain/formal/grouping.ts#L283)
- Test: [formalize.test.ts:265 validates controls and logical-file map values before effects](/test/contract/formalize.test.ts#L265), [semantic-batching-failures.test.ts:215 rejects %s=%s before adapter, filesystem, or worker effects](/test/contract/semantic-batching-failures.test.ts#L215), [semantic-grouping.test.ts:157 rejects invalid direct-call batch bounds instead of risking non-termination](/test/contract/semantic-grouping.test.ts#L157)

#### Requirement model

```alloy
// Safety: stable slices neither duplicate nor omit an admitted claim.
assert batches_partition { all c : eligible | one b : Batch | c in b.claims }
```

### Requirement: File-Attached Batch Context Transport [FLA-ATTACH-TRANSPORT]
WHEN a first-sample physical batch contains two or more claims, THE spec-check tool SHALL attach a deterministic JSON context file to the LLM invocation instead of embedding claim bodies in the prompt, and WHEN a first-sample attempt contains exactly one claim, THE spec-check tool SHALL use the inline prompt path. The context file SHALL be schema version 1 with fields `schemaVersion`, `batchKey`, and an ordered `claims` array of `{ index, id, obligation, provenance: { file }, text }`, SHALL serialize with `JSON.stringify(value, null, 2)` as UTF-8 without BOM with LF newlines and exactly one trailing newline, SHALL represent a missing claim ID as `null` while permitting duplicate IDs, and SHALL store provenance path strings verbatim.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Domain Model`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Data Design`

#### Scenario: Multi-Claim Batch Uses Attachment [FLA-ATTACH-MULTI]
WHEN a first-sample physical batch contains two or more claims, THE spec-check tool SHALL write the batch context JSON to a temp file and SHALL attach that file to the LLM invocation.

**Postcondition:** The prompt body contains no claim text; claim content travels only in the attached file.

##### Evidence
- Implementation: [formalize.ts:241 formalizePhysicalBatch()](/src/domain/formal/formalize.ts#L241), [formalize.ts:312 formalizeAttachedBatch()](/src/domain/formal/formalize.ts#L312), [batch-transport.ts:219 buildBatchContextFile()](/src/domain/formal/batch-transport.ts#L219)
- Test: [semantic-batching.test.ts:158 uses attached JSON for multi-claim batches and inline prompts for size one](/test/contract/semantic-batching.test.ts#L158)
- Test (integration): [semantic-batching.integration.test.ts:173 aligns merged grouping, provenance, bounds, prompt, cleanup, and evidence](/test/integration/semantic-batching.integration.test.ts#L173)

#### Scenario: Single-Claim Batch Stays Inline [FLA-ATTACH-SINGLE]
WHEN a first-sample attempt covers exactly one claim, THE spec-check tool SHALL use the inline prompt path and SHALL NOT create an attached context file.

**Postcondition:** Single-claim formalization behavior matches the existing inline path.

##### Evidence
- Implementation: [formalize.ts:241 formalizePhysicalBatch()](/src/domain/formal/formalize.ts#L241), [formalize.ts:273 formalizeSingleClaim()](/src/domain/formal/formalize.ts#L273)
- Test: [semantic-batching.test.ts:158 uses attached JSON for multi-claim batches and inline prompts for size one](/test/contract/semantic-batching.test.ts#L158)
- Test (property): [degradation.property.test.ts:90 fit check is bounded by the adapter byte limit and respects the boundary](/test/property/degradation.property.test.ts#L90)

#### Scenario: Byte-Deterministic Serialization [FLA-ATTACH-DETERMINISTIC]
WHEN the spec-check tool serializes a batch context file, THE output SHALL be byte-identical for identical logical content, using UTF-8 without BOM, LF newlines, exactly one trailing newline, and declared key insertion order.

**Postcondition:** The SHA-256 context hash is reproducible from the serialized bytes.

##### Evidence
- Implementation: [batch-transport.ts:270 serializeBatchContextFile()](/src/domain/formal/batch-transport.ts#L270), [batch-transport.ts:289 hashBatchContext()](/src/domain/formal/batch-transport.ts#L289)
- Test: [semantic-batching.test.ts:128 serializes deterministic UTF-8 context bytes with null IDs and verbatim paths](/test/contract/semantic-batching.test.ts#L128)
- Test (property): [semantic-batching.property.test.ts:340 repeats groups, chunks, context bytes, and hashes identically](/test/property/semantic-batching.property.test.ts#L340)

#### Scenario: Missing Claim ID Serializes As Null [FLA-ATTACH-NULL-ID]
WHEN an attached claim has no `claim.id`, THE spec-check tool SHALL serialize its `id` field as `null`.

**Postcondition:** Missing IDs are explicit in the context file and never fabricated.

##### Evidence
- Implementation: [batch-transport.ts:219 buildBatchContextFile()](/src/domain/formal/batch-transport.ts#L219)
- Test: [semantic-batching.test.ts:128 serializes deterministic UTF-8 context bytes with null IDs and verbatim paths](/test/contract/semantic-batching.test.ts#L128)

#### Requirement model

```alloy
// Only multi-claim attempts allocate attached context; recovery is singleton.
// Safety: inline work cannot carry multi-claim attachments.
assert transport_by_arity { all a : Attempt | (a.transport = Inline iff one a.claims) }
```

### Requirement: Dedicated Attached-Context Prompt [FLA-ATTACH-PROMPT]
WHEN a multi-claim attached attempt is issued, THE spec-check tool SHALL use a dedicated predicate-formalization prompt with the current wire schema, source-index matching, frozen registry hash, untrusted-data instruction, and source-owned clause slots without embedding claim bodies inline.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Scope`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Component Descriptions`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Security`
- [Design: Interaction Protocols](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#interaction-protocols)

#### Scenario: Prompt References Attached Context [FLA-ATTACHP-REFERENCES]
WHEN an attached attempt begins, THE spec-check tool SHALL identify attached claim/context data as the only claim-text source and SHALL keep claim bodies out of the instruction prompt.

#### Scenario: Attached JSON Marked Untrusted [FLA-ATTACHP-UNTRUSTED]
WHEN JSON is attached, THE spec-check tool SHALL state that its text, registry descriptions, and predicate content are untrusted data rather than instructions.

#### Scenario: No Stale Same-File Language [FLA-ATTACHP-NO-STALE]
WHEN semantic-group claims span files, THE spec-check tool SHALL avoid stale same-file or presented-below wording.

#### Scenario: Response Matching Authority Stated [FLA-ATTACHP-MATCHING]
WHEN a batch is formalized, THE spec-check tool SHALL require exactly one entry per attached eligible index and SHALL state that display IDs and array position are not response-matching authority.

#### Scenario: Response Index Validated [FLA-ATTACHP-INDEX-VALID]
IF response indexes are missing, unknown, duplicated, or incomplete, THEN THE spec-check tool SHALL preserve the raw response and SHALL follow existing bounded schema-failure degradation without changing registry or source identity.

##### Historical verification evidence
- Implementation: [formalization.ts:247 ATTACHED_BATCH_FORMALIZATION_PROMPT](/src/domain/prompts/formalization.ts#L247), [formalize.ts:512 callAndAssembleAttached()](/src/domain/formal/formalize.ts#L512)
- Test: [semantic-batching.test.ts:197 keeps the dedicated prompt data-only and excludes stale or claim-specific text](/test/contract/semantic-batching.test.ts#L197), [semantic-batching-adversarial.test.ts:60 escapes claim text in attached context while prompt stays instruction-only](/test/contract/semantic-batching-adversarial.test.ts#L60)
- Implementation: [formalization.ts:247 ATTACHED_BATCH_FORMALIZATION_PROMPT](/src/domain/prompts/formalization.ts#L247)
- Test: [semantic-batching.test.ts:197 keeps the dedicated prompt data-only and excludes stale or claim-specific text](/test/contract/semantic-batching.test.ts#L197), [semantic-batching-adversarial.test.ts:150 keeps adversarial attached claim text out of the prompt](/test/contract/semantic-batching-adversarial.test.ts#L150)
- Test: [semantic-batching.test.ts:197 keeps the dedicated prompt data-only and excludes stale or claim-specific text](/test/contract/semantic-batching.test.ts#L197)
- Implementation: [formalization.ts:247 ATTACHED_BATCH_FORMALIZATION_PROMPT](/src/domain/prompts/formalization.ts#L247), [formalization-findings.ts:160 matchAttachedBatchResponse()](/src/domain/formal/formalization-findings.ts#L160)
- Test (property): [formalization-matching.property.test.ts:161 envelope order and claim IDs cannot override explicit indexes](/test/property/formalization-matching.property.test.ts#L161)
- Implementation: [formalization-findings.ts:160 matchAttachedBatchResponse()](/src/domain/formal/formalization-findings.ts#L160), [formalize.ts:619 acceptAttachedResponse()](/src/domain/formal/formalize.ts#L619)
- Test: [semantic-batching.test.ts:220 degrades $name response indexes to inline claims](/test/contract/semantic-batching.test.ts#L220), [opencode.test.ts:271 rejects batch response with missing index](/test/contract/opencode.test.ts#L271)
- Test (property): [formalization-matching.property.test.ts:130 response matching accepts exactly the attached index set](/test/property/formalization-matching.property.test.ts#L130)

#### Requirement model

```alloy
// Explicit bindings model source-index authority. Concrete prompt bytes and
// JSON serialization remain differential/contract-test boundaries.
// Safety: indexes bound before acceptance.
assert indexes_bound_before_acceptance { always (all s : Run.accepted |
  s.attempt.boundIndexes[s.claim] = s.claim.index) }
```

### Requirement: Temp Context File Lifecycle [FLA-TEMP-LIFECYCLE]
WHILE a multi-claim attached batch is in flight on a handled execution path, THE spec-check tool SHALL manage the temp context file through the explicit lifecycle `not_created`, `dir_created`, `file_written`, `cleanup_succeeded`, or `cleanup_failed`, SHALL create the directory with `mkdtemp()` using the prefix `spec-check-batch-` separately from file writing, SHALL write the fixed filename `batch-context.json` with UTF-8 encoding, mode `0o600`, and exclusive flag `wx`, and SHALL attempt cleanup after success, graceful model failure, adapter-return failure, thrown adapter failure, and partial write failure when execution reaches lifecycle finalization. THE spec-check tool SHALL NOT claim a SIGINT or SIGTERM cleanup guarantee; process termination MAY leave temp artifacts, and the absent final manifest SHALL identify the run as incomplete.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Domain Model`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Key Components`

#### Scenario: Successful Batch Cleans Up [FLA-TEMP-SUCCESS]
WHEN an attached batch attempt completes successfully, THE spec-check tool SHALL remove the temp context directory before returning results.

**Postcondition:** No temp context directory survives a successful attempt.

##### Evidence
- Implementation: [formalize.ts:415 runAttachedAttempt()](/src/domain/formal/formalize.ts#L415), [batch-transport.ts:451 cleanupBatchContext()](/src/domain/formal/batch-transport.ts#L451)
- Test: [semantic-batching-failures.test.ts:400 removes the temporary context after a successful attached response](/test/contract/semantic-batching-failures.test.ts#L400), [batch-evidence.test.ts:121 records complete pointer-only evidence, cleans up, and persists no claim text](/test/contract/batch-evidence.test.ts#L121)
- Test (property): [batch-transport.property.test.ts:178 cleanup failure never masks the attempt outcome and never skips the attempt](/test/property/batch-transport.property.test.ts#L178)

#### Scenario: Directory Creation Failure Yields Claim Errors [FLA-TEMP-DIRFAIL]
IF temp directory creation fails for a physical batch, THEN THE spec-check tool SHALL return claim-level `FormalizationError` values for every claim in that physical batch.

**Postcondition:** The failure surfaces as claim errors; no claim is silently dropped.

##### Evidence
- Implementation: [formalize.ts:312 formalizeAttachedBatch()](/src/domain/formal/formalize.ts#L312), [batch-transport.ts:337 createBatchContextDirectory()](/src/domain/formal/batch-transport.ts#L337)
- Test: [semantic-batching-failures.test.ts:341 turns an unwritable temp directory into errors for every claim](/test/contract/semantic-batching-failures.test.ts#L341), [batch-evidence.test.ts:276 returns claim errors without cleanup when temp directory creation fails](/test/contract/batch-evidence.test.ts#L276)
- Test (property): [batch-transport.property.test.ts:145 cleanup is attempted iff a directory was created, and evidence matches the terminal state](/test/property/batch-transport.property.test.ts#L145)

#### Scenario: Write Failure After Directory Creation Cleans Up [FLA-TEMP-WRITEFAIL]
IF the context file write fails after the temp directory was created, THEN THE spec-check tool SHALL attempt cleanup of the created directory before returning claim-level `FormalizationError` values for the physical batch.

**Postcondition:** A `dir_created` state never leaks when writing fails.

##### Evidence
- Implementation: [formalize.ts:371 transportWriteFailureResult()](/src/domain/formal/formalize.ts#L371), [batch-transport.ts:371 writeBatchContextFile()](/src/domain/formal/batch-transport.ts#L371)
- Test: [semantic-batching-failures.test.ts:361 cleans a created directory before reporting a context write failure](/test/contract/semantic-batching-failures.test.ts#L361), [batch-evidence.test.ts:303 reports write and cleanup failures without masking either](/test/contract/batch-evidence.test.ts#L303)
- Test (property): [batch-transport.property.test.ts:203 a write failure still attempts cleanup exactly once before returning evidence](/test/property/batch-transport.property.test.ts#L203)

#### Scenario: Cleanup Failure After Partial Write Does Not Mask [FLA-TEMP-WRITEFAIL-CLEANUP]
IF cleanup after a partial write failure also fails, THEN THE spec-check tool SHALL include the cleanup failure detail without masking the original write failure.

**Postcondition:** The primary failure remains the reported cause.

##### Evidence
- Implementation: [formalize.ts:371 transportWriteFailureResult()](/src/domain/formal/formalize.ts#L371), [batch-transport.ts:451 cleanupBatchContext()](/src/domain/formal/batch-transport.ts#L451)
- Test: [semantic-batching-failures.test.ts:377 preserves the write failure when partial-state cleanup also fails](/test/contract/semantic-batching-failures.test.ts#L377), [batch-evidence.test.ts:303 reports write and cleanup failures without masking either](/test/contract/batch-evidence.test.ts#L303)
- Test (property): [batch-transport.property.test.ts:203 a write failure still attempts cleanup exactly once before returning evidence](/test/property/batch-transport.property.test.ts#L203)

#### Scenario: Thrown Adapter Failure Still Cleans Up [FLA-TEMP-THROW]
IF `callOpencode()` throws during an attached batch attempt, THEN THE spec-check tool SHALL attempt temp directory cleanup in a `finally` path and SHALL normalize the thrown failure to claim-level `FormalizationError` values.

**Postcondition:** Temp cleanup does not depend on the adapter returning normally.

##### Evidence
- Implementation: [formalize.ts:415 runAttachedAttempt()](/src/domain/formal/formalize.ts#L415), [formalize.ts:512 callAndAssembleAttached()](/src/domain/formal/formalize.ts#L512)
- Test: [semantic-batching-failures.test.ts:493 normalizes an attached adapter throw and still cleans its temporary context](/test/contract/semantic-batching-failures.test.ts#L493), [batch-evidence.test.ts:256 cleans up and normalizes a thrown attached adapter failure](/test/contract/batch-evidence.test.ts#L256)

#### Scenario: Cleanup Failure After Success Is A Warning [FLA-TEMP-CLEANUP-WARN]
IF cleanup fails after a successful model response, THEN THE spec-check tool SHALL record a warning `Finding` with category `formalization.temp_cleanup_failed` (provenance: batch key and sub-batch ordinal; evidence: cleanup error detail and context hash) and SHALL NOT discard the successful candidates.

**Postcondition:** Successful formalization evidence is never discarded due to cleanup failure, and the failure is diagnosable.

##### Evidence
- Implementation: [formalize.ts:469 applyCleanupOutcome()](/src/domain/formal/formalize.ts#L469), [formalization-findings.ts:376 buildCleanupWarning()](/src/domain/formal/formalization-findings.ts#L376)
- Test: [semantic-batching-failures.test.ts:467 preserves successful candidates and emits evidence when cleanup fails](/test/contract/semantic-batching-failures.test.ts#L467), [batch-evidence.test.ts:326 preserves candidates and emits a warning when success cleanup fails](/test/contract/batch-evidence.test.ts#L326)
- Test (property): [batch-transport.property.test.ts:178 cleanup failure never masks the attempt outcome and never skips the attempt](/test/property/batch-transport.property.test.ts#L178)

#### Scenario: OS Temp Unwritable Yields Claim Errors [FLA-TEMP-OSUNWRITABLE]
IF the OS temp directory is not writable and `mkdtemp()` fails, THEN THE spec-check tool SHALL return claim-level `FormalizationError` values for every claim in the physical batch.

**Postcondition:** Environment failures surface as ordinary claim errors, not crashes.

##### Evidence
- Implementation: [formalize.ts:312 formalizeAttachedBatch()](/src/domain/formal/formalize.ts#L312), [batch-transport.ts:337 createBatchContextDirectory()](/src/domain/formal/batch-transport.ts#L337)
- Test: [semantic-batching-failures.test.ts:341 turns an unwritable temp directory into errors for every claim](/test/contract/semantic-batching-failures.test.ts#L341), [batch-evidence.test.ts:276 returns claim errors without cleanup when temp directory creation fails](/test/contract/batch-evidence.test.ts#L276)

#### Scenario: Outcomes Assigned After Cleanup Terminal State [FLA-TEMP-ORDER]
WHEN an attached batch attempt resolves (success, model failure, or infrastructure failure), THE spec-check tool SHALL assign claim outcomes only after the temp lifecycle reaches a terminal cleanup state (`cleanup_succeeded` or `cleanup_failed`). IF no temp directory was created (directory creation failure), THEN claim errors MAY be assigned immediately since no cleanup is owed.

**Postcondition:** On handled paths, the temp lifecycle always precedes outcome assignment when a directory exists. Process termination can bypass this postcondition and is governed by [FLA-TEMP-TERMINATION]; any already finalized evidence audits attempts but does not prove completion.

##### Evidence
- Implementation: [formalize.ts:415 runAttachedAttempt()](/src/domain/formal/formalize.ts#L415), [formalize.ts:371 transportWriteFailureResult()](/src/domain/formal/formalize.ts#L371)
- Test: [semantic-batching-failures.test.ts:413 waits for cleanup to terminate before resolving claim outcomes](/test/contract/semantic-batching-failures.test.ts#L413), [semantic-batching-failures.test.ts:361 cleans a created directory before reporting a context write failure](/test/contract/semantic-batching-failures.test.ts#L361)

#### Scenario: Process Termination May Leave Temp Artifacts [FLA-TEMP-TERMINATION]
IF the process terminates before an attached batch lifecycle reaches its handled `finally` path, THEN THE spec-check tool MAY leave the temp directory or context file and SHALL NOT leave a final manifest that implies successful completion.

**Postcondition:** No cleanup guarantee is attributed to SIGINT, SIGTERM, or other process termination; manifest absence distinguishes the incomplete run from success.

##### Evidence
- Test: [semantic-batching-failures.test.ts:413 waits for cleanup to terminate before resolving claim outcomes](/test/contract/semantic-batching-failures.test.ts#L413)

#### Requirement model

```alloy
// Event: allocate a context directory, recording transport failure explicitly.
pred prepare[a : Attempt] {
  Run.phase = Sampling and a not in Run.captured + Run.settled and a.(Run.stages) = NotCreated
  a.batch.group in Run.frozen
  a.earlier in Run.settled
  some a.recoveryOf implies a.recoveryOf in Run.settled and degradable[a.recoveryOf]
  Run.stages' = Run.stages ++ a ->
    (a.transport = Inline => FileWritten else (a.transportFailure = DirectoryFailure => CleanupSucceeded else DirCreated))
  Run.captured' = Run.captured + (a.transportFailure = DirectoryFailure => a else none)
  keep_attempts_except_transport
  Run.phase' = Run.phase
  Run.frozen' = Run.frozen
  keep_queries
}
pred write_context[a : Attempt] {
  Run.phase = Sampling and a.(Run.stages) = DirCreated
  Run.stages' = Run.stages ++ a -> (a.transportFailure = WriteFailure => ProcessSettled else FileWritten)
  Run.captured' = Run.captured + (a.transportFailure = WriteFailure => a else none)
  keep_attempts_except_transport
  Run.phase' = Run.phase
  Run.frozen' = Run.frozen
  keep_queries
}
pred capture[a : Attempt, t : EvidenceToken] {
  Run.phase = Sampling and a.(Run.stages) = FileWritten and a not in Run.captured
  t not in (Attempt + Query).(Run.reservations)
  Run.reservations' = Run.reservations + a -> t
  Run.captured' = Run.captured + a
  Run.spawned' = Run.spawned + a
  Run.stages' = Run.stages ++ a -> ProcessSettled
  Run.phase' = Run.phase
  Run.frozen' = Run.frozen
  Run.settled' = Run.settled
  Run.accepted' = Run.accepted
  Run.errors' = Run.errors
  Run.selected' = Run.selected
  keep_queries_except_reservations
}
pred cleanup[a : Attempt] {
  Run.phase = Sampling and a.(Run.stages) = ProcessSettled
  Run.stages' = Run.stages ++ a -> (a.cleanupFails = True => CleanupFailed else CleanupSucceeded)
  Run.captured' = Run.captured
  keep_attempts_except_transport
  Run.phase' = Run.phase
  Run.frozen' = Run.frozen
  keep_queries
}
// Safety: accepted outcomes follow capture and terminal cleanup.
assert cleanup_before_outcome { always (all s : Run.accepted |
  s.attempt in Run.captured & Run.settled and s.attempt.(Run.stages) in CleanupSucceeded + CleanupFailed) }
```

### Requirement: Graceful Degradation By Adapter Error Kind [FLA-DEGRADE-KIND]
WHEN a multi-claim attached batch attempt fails with a terminal adapter error (an `OpencodeError.kind` returned after the adapter's internal retry budget is exhausted), THE spec-check tool SHALL select per-claim handling from the existing taxonomy without introducing new public error categories: `timeout`, `invalid_json`, and `schema_validation_error` SHALL degrade to bounded per-claim inline retry; `spawn_error`, `invalid_files`, and `invalid_timeout` SHALL produce claim-level `FormalizationError` values for the affected physical batch with no per-claim fallback; and `prompt_too_large` SHALL degrade only when every per-claim inline prompt (inline template plus claim text, measured in UTF-8 bytes) fits the adapter prompt-size limit, and SHALL otherwise produce claim-level errors immediately.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Scope`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Interface Contracts`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Failure Mode Analysis`

#### Scenario: Batch Timeout Degrades Per Claim [FLA-DEGRADE-TIMEOUT]
IF an attached batch attempt fails with `timeout`, THEN THE spec-check tool SHALL retry each claim of that physical batch individually through the inline path.

**Postcondition:** Smaller work is attempted before claims are declared failed.

##### Evidence
- Implementation: [degradation.ts:80 decideBatchDegradation()](/src/domain/formal/degradation.ts#L80), [formalize.ts:568 recoverAttachedFailure()](/src/domain/formal/formalize.ts#L568)
- Test: [semantic-batching-failures.test.ts:241 degrades attached %s to one inline call per claim](/test/contract/semantic-batching-failures.test.ts#L241), [formalize.test.ts:283 degrades attached timeout failures to bounded inline claims](/test/contract/formalize.test.ts#L283)
- Test (property): [degradation.property.test.ts:66 covers every adapter error kind exactly once across the decision table](/test/property/degradation.property.test.ts#L66)

#### Scenario: Invalid JSON Degrades Per Claim [FLA-DEGRADE-JSON]
IF an attached batch attempt fails with `invalid_json`, THEN THE spec-check tool SHALL retry each claim of that physical batch individually through the inline path.

**Postcondition:** Model response failures consume the existing bounded retry budget per claim.

##### Evidence
- Implementation: [degradation.ts:80 decideBatchDegradation()](/src/domain/formal/degradation.ts#L80), [formalize.ts:568 recoverAttachedFailure()](/src/domain/formal/formalize.ts#L568)
- Test: [semantic-batching-failures.test.ts:241 degrades attached %s to one inline call per claim](/test/contract/semantic-batching-failures.test.ts#L241)
- Test (property): [degradation.property.test.ts:66 covers every adapter error kind exactly once across the decision table](/test/property/degradation.property.test.ts#L66)

#### Scenario: Schema Validation Error Degrades Per Claim [FLA-DEGRADE-SCHEMA]
IF an attached batch attempt fails with `schema_validation_error`, THEN THE spec-check tool SHALL retry each claim of that physical batch individually through the inline path.

**Postcondition:** Model response failures consume the existing bounded retry budget per claim.

##### Evidence
- Implementation: [degradation.ts:80 decideBatchDegradation()](/src/domain/formal/degradation.ts#L80), [formalize.ts:619 acceptAttachedResponse()](/src/domain/formal/formalize.ts#L619), [formalize.ts:568 recoverAttachedFailure()](/src/domain/formal/formalize.ts#L568)
- Test: [semantic-batching-failures.test.ts:241 degrades attached %s to one inline call per claim](/test/contract/semantic-batching-failures.test.ts#L241), [semantic-batching.test.ts:220 degrades $name response indexes to inline claims](/test/contract/semantic-batching.test.ts#L220)
- Test (property): [degradation.property.test.ts:66 covers every adapter error kind exactly once across the decision table](/test/property/degradation.property.test.ts#L66)

#### Scenario: Spawn Error Does Not Degrade [FLA-DEGRADE-SPAWN]
IF an attached batch attempt fails with `spawn_error`, THEN THE spec-check tool SHALL produce claim-level `FormalizationError` values for every claim in the physical batch and SHALL NOT attempt per-claim fallback.

**Postcondition:** OS/process boundary failures are not retried per claim.

##### Evidence
- Implementation: [degradation.ts:80 decideBatchDegradation()](/src/domain/formal/degradation.ts#L80), [formalize.ts:568 recoverAttachedFailure()](/src/domain/formal/formalize.ts#L568)
- Test: [semantic-batching-failures.test.ts:258 does not fallback after attached %s](/test/contract/semantic-batching-failures.test.ts#L258)
- Test (property): [degradation.property.test.ts:66 covers every adapter error kind exactly once across the decision table](/test/property/degradation.property.test.ts#L66)

#### Scenario: Invalid Files Does Not Degrade [FLA-DEGRADE-FILES]
IF an attached batch attempt fails with `invalid_files`, THEN THE spec-check tool SHALL produce claim-level `FormalizationError` values for every claim in the physical batch and SHALL NOT attempt per-claim fallback.

**Postcondition:** Attachment validation failures surface immediately as claim errors.

##### Evidence
- Implementation: [degradation.ts:80 decideBatchDegradation()](/src/domain/formal/degradation.ts#L80), [formalize.ts:568 recoverAttachedFailure()](/src/domain/formal/formalize.ts#L568)
- Test: [semantic-batching-failures.test.ts:258 does not fallback after attached %s](/test/contract/semantic-batching-failures.test.ts#L258)
- Test (property): [degradation.property.test.ts:66 covers every adapter error kind exactly once across the decision table](/test/property/degradation.property.test.ts#L66)

#### Scenario: Invalid Timeout Does Not Degrade [FLA-DEGRADE-INVTIMEOUT]
IF an attached batch attempt fails with `invalid_timeout`, THEN THE spec-check tool SHALL produce claim-level `FormalizationError` values for every claim in the physical batch and SHALL NOT attempt per-claim fallback.

**Postcondition:** Invalid invocation options are never retried.

##### Evidence
- Implementation: [degradation.ts:80 decideBatchDegradation()](/src/domain/formal/degradation.ts#L80), [formalize.ts:568 recoverAttachedFailure()](/src/domain/formal/formalize.ts#L568)
- Test: [semantic-batching-failures.test.ts:258 does not fallback after attached %s](/test/contract/semantic-batching-failures.test.ts#L258)
- Test (property): [degradation.property.test.ts:66 covers every adapter error kind exactly once across the decision table](/test/property/degradation.property.test.ts#L66)

#### Scenario: Prompt Too Large Degrades Conditionally [FLA-DEGRADE-TOOLARGE]
IF an attached batch attempt fails with `prompt_too_large`, THEN THE spec-check tool SHALL degrade to per-claim inline calls only when every per-claim inline prompt (inline template plus that claim's text, measured in UTF-8 bytes) fits the adapter prompt-size limit, and SHALL otherwise produce claim-level `FormalizationError` values for the physical batch without attempting any fallback call.

**Postcondition:** Fallback is attempted only when it can succeed; no budget is spent on fallback calls guaranteed to fail.

##### Evidence
- Implementation: [degradation.ts:51 inlinePromptsFitOpencodeLimit()](/src/domain/formal/degradation.ts#L51), [degradation.ts:80 decideBatchDegradation()](/src/domain/formal/degradation.ts#L80), [formalize.ts:568 recoverAttachedFailure()](/src/domain/formal/formalize.ts#L568)
- Test: [semantic-batching-failures.test.ts:277 falls back from prompt_too_large when every inline prompt fits](/test/contract/semantic-batching-failures.test.ts#L277), [semantic-batching-failures.test.ts:297 does not fallback from prompt_too_large when one complete inline prompt cannot fit](/test/contract/semantic-batching-failures.test.ts#L297)
- Test (property): [degradation.property.test.ts:90 fit check is bounded by the adapter byte limit and respects the boundary](/test/property/degradation.property.test.ts#L90)

#### Requirement model

```alloy
pred degradable[a : Attempt] {
  a.transportFailure = NoTransportFailure
  a.result = ModelFailure or (a.result = PromptTooLarge and a.fallbackFits = True)
}
// Safety: infrastructure failures and overflow admit no recovery spawn.
assert no_infrastructure_degradation { always (all a : Run.spawned | some a.recoveryOf implies degradable[a.recoveryOf]) }
```

### Requirement: Claim Partition And Terminal Outcomes [FLA-CLAIM-PARTITION]
UNDER all handled failure modes, THE spec-check tool SHALL deliver every eligible claim (claims with `kind` equal to `requirement` or `scenario`) to exactly one terminal formalization outcome. Let `E` be the set of eligible claim indexes, `C` the set of candidate indexes, and `R` the set of explicit claim-level `FormalizationError` indexes. THE spec-check tool SHALL maintain `C ⊆ E`, `R ⊆ E`, `C ∩ R = ∅`, and `C ∪ R = E`. No eligible claim SHALL be lost or assigned both outcomes because of grouping, sub-batching, temp-file failure, invalid attachments, model-response failure, graceful degradation, additional-sample failure, or worker-thrown failures.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Failure Mode Analysis`

#### Scenario: Worker Failure Drops No Claims [FLA-PARTITION-WORKER]
IF a `mapBounded` worker throws while processing a physical batch, THEN THE spec-check tool SHALL convert the failure into claim-level errors for every claim of the affected physical batch, and sibling physical batches SHALL continue processing.

**Postcondition:** Every eligible claim in the failed batch reaches a terminal outcome, and one batch's failure never abandons unstarted claims in other batches.

##### Evidence
- Implementation: [formalize.ts:129 formalizeClaims()](/src/domain/formal/formalize.ts#L129), [formalization-findings.ts:412 workerFailureResult()](/src/domain/formal/formalization-findings.ts#L412)
- Test: [semantic-batching-failures.test.ts:527 keeps sibling outcomes and loses no claims when one fallback worker throws](/test/contract/semantic-batching-failures.test.ts#L527)
- Test (property): [semantic-batching.property.test.ts:370 yields identical terminal outcome sets under shuffled completion order](/test/property/semantic-batching.property.test.ts#L370)

#### Scenario: Single-Claim Thrown Adapter Failure Normalized [FLA-PARTITION-THROW]
IF the adapter throws during a single-claim inline attempt, THEN THE spec-check tool SHALL catch the thrown value as `unknown` and SHALL normalize it to a claim-level `FormalizationError`.

**Postcondition:** Thrown infrastructure failures become ordinary claim outcomes.

##### Evidence
- Implementation: [formalize.ts:842 sampleFormalizationsForClaim()](/src/domain/formal/formalize.ts#L842)
- Test: [semantic-batching-failures.test.ts:511 normalizes a single-claim inline adapter throw without creating temporary state](/test/contract/semantic-batching-failures.test.ts#L511)

#### Scenario: All-Error Output Aborts Pipeline [FLA-PARTITION-ABORT]
IF formalization returns zero candidates and one or more errors, THEN THE spec-check tool SHALL abort the run with `PipelineAbortError("FormalizationError", ...)` at the CLI boundary.

**Postcondition:** Existing abort behavior for total formalization failure is preserved.

##### Evidence
- Implementation: [run-cli.ts:398 runFormalizationPhase()](/src/cli/run-cli.ts#L398)
- Test (integration): [merge-liveness.integration.test.ts:409 rejects with FormalizationError when formalization produces only errors](/test/integration/merge-liveness.integration.test.ts#L409)

#### Scenario: Additional-Sample Failure Preserves Candidate [FLA-PARTITION-ADDITIONAL-WARN]
IF a claim already has a valid candidate and a later additional-sample attempt fails or exhausts its bounded retry budget, THEN THE spec-check tool SHALL preserve the candidate and all samples already collected, SHALL emit a warning finding describing the sample shortfall, and SHALL NOT emit a claim-level `FormalizationError` for that additional-sample failure.

**Postcondition:** The claim remains in `C` and not in `R`; additional sampling can reduce confidence but cannot revoke a valid candidate or violate the disjoint partition.

##### Evidence
- Implementation: [formalize.ts:762 addAdditionalSamples()](/src/domain/formal/formalize.ts#L762), [formalization-findings.ts:344 buildAdditionalSampleFailureFinding()](/src/domain/formal/formalization-findings.ts#L344)
- Test: [semantic-batching-failures.test.ts:317 retains an attached candidate when its requested additional sample terminally fails](/test/contract/semantic-batching-failures.test.ts#L317)

#### Requirement model

```alloy
pred close_claim[c : Claim] {
  Run.phase = Sampling and c in eligible and c not in Run.errors
  all a : Attempt | c in a.claims implies a in Run.settled
  c not in candidates
  Run.errors' = Run.errors + c
  Run.phase' = Run.phase
  Run.frozen' = Run.frozen
  Run.stages' = Run.stages
  Run.spawned' = Run.spawned
  Run.captured' = Run.captured
  Run.settled' = Run.settled
  Run.accepted' = Run.accepted
  Run.selected' = Run.selected
  keep_queries
}
pred end_sampling {
  Run.phase = Sampling and Attempt = Run.settled and candidates + Run.errors = eligible
  Run.phase' = (no candidates => Aborted else Selecting)
  Run.frozen' = Run.frozen
  keep_attempts
  keep_queries
}
// Safety: candidate/error attribution is disjoint and complete at sampling exit.
assert claim_partition { always (no candidates & Run.errors and candidates + Run.errors in eligible and
  (Run.phase in Selecting + Analyzing + Complete implies candidates + Run.errors = eligible)) }
```

### Requirement: Original Eligible Index Is Authoritative Identity [FLA-IDENTITY-INDEX]
THE spec-check tool SHALL use the original eligible index (the stable zero-based index of a formalizable claim in eligible-claim order) or claim object identity as the authoritative internal identity for grouping, sub-batching, response matching, and additional-sample merging, and SHALL NOT use `claim.id` alone as internal identity because IDs can be missing or duplicated.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Interface Contracts`

#### Scenario: Duplicate IDs Do Not Merge Samples [FLA-IDENTITY-DUP]
WHEN two distinct claims share the same `claim.id` and `samplesPerClaim` is greater than `1`, THE spec-check tool SHALL merge additional samples per claim using original eligible index or object identity so that samples never merge into the wrong candidate.

**Postcondition:** Duplicate IDs cannot corrupt candidate identity.

##### Evidence
- Implementation: [grouping.ts:73 IndexedFormalizationClaim](/src/domain/formal/grouping.ts#L73), [formalize.ts:762 addAdditionalSamples()](/src/domain/formal/formalize.ts#L762)
- Test: [formalize.test.ts:321 merges additional samples by eligible index when claim IDs are duplicated](/test/contract/formalize.test.ts#L321)
- Test (property): [semantic-batching.property.test.ts:276 keeps candidates distinct when claim IDs are duplicate or missing](/test/property/semantic-batching.property.test.ts#L276)

#### Scenario: Missing IDs Do Not Merge Samples [FLA-IDENTITY-MISSING]
WHEN one or more claims lack `claim.id` and `samplesPerClaim` is greater than `1`, THE spec-check tool SHALL merge additional samples per claim using original eligible index or object identity.

**Postcondition:** Missing IDs are ordinary input, not an identity hazard.

##### Evidence
- Implementation: [grouping.ts:73 IndexedFormalizationClaim](/src/domain/formal/grouping.ts#L73), [formalize.ts:762 addAdditionalSamples()](/src/domain/formal/formalize.ts#L762)
- Test: [semantic-batching.test.ts:296 accepts any attached sample claimId when the source ID is missing](/test/contract/semantic-batching.test.ts#L296)
- Test (property): [semantic-batching.property.test.ts:276 keeps candidates distinct when claim IDs are duplicate or missing](/test/property/semantic-batching.property.test.ts#L276)

#### Scenario: Output Carries Claim Attribution [FLA-IDENTITY-ORDER]
WHEN formalization emits candidates and errors, THE spec-check tool SHALL emit them in eligible input order where practical, and SHALL otherwise attach explicit claim/index identity to each output so downstream consumers and tests never assume array order.

**Postcondition:** Output attribution is always recoverable independent of emission order.

##### Evidence
- Implementation: [formalize.ts:129 formalizeClaims()](/src/domain/formal/formalize.ts#L129), [formalization-findings.ts:464 compareCandidates()](/src/domain/formal/formalization-findings.ts#L464), [formalization-findings.ts:482 compareErrors()](/src/domain/formal/formalization-findings.ts#L482)
- Test: [formalize.test.ts:228 groups semantically, matches attached responses by index, and restores eligible order](/test/contract/formalize.test.ts#L228)
- Test (property): [semantic-batching.property.test.ts:370 yields identical terminal outcome sets under shuffled completion order](/test/property/semantic-batching.property.test.ts#L370)

#### Requirement model

```alloy
// Safety: accepted samples belong to their exact source claim, never an ID join.
assert samples_keep_identity { always (all s : Run.accepted | s.claim in s.attempt.claims) }
```

### Requirement: Batch Attempt Evidence Preservation [FLA-BATCH-EVIDENCE]
WHEN the spec-check tool performs a formalization invocation, THE spec-check tool SHALL produce one `FormalizationAttemptSet` envelope containing schema version, an invocation `claimSet`, and the invocation's attached attempt entries. The `claimSet` SHALL be either `specs_forward` or `generated_spec` with a zero-based invocation ordinal and capability. Each attempt entry SHALL contain batch key, ordered claim indexes local to that `claimSet`, claim IDs when present, claim provenance files, the SHA-256 hash over the exact serialized UTF-8 context bytes, prompt variant/version, model, the physical sub-batch ordinal within the logical group, the response/failure classification, and the cleanup outcome. Evidence SHALL NOT duplicate claim text; each envelope SHALL be persisted as a separate atomically finalized evidence file.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Domain Model`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Data Design`

#### Scenario: Attempt Metadata Is Complete [FLA-EVIDENCE-METADATA]
WHEN an attached batch attempt terminates in any handled state, THE preserved evidence SHALL include the enclosing envelope's schema version and `claimSet`, plus the attempt's batch key, ordered claim-set-local indexes, claim IDs when present, provenance files, context SHA-256, prompt variant/version, model, sub-batch ordinal, response/failure classification, and cleanup outcome.

**Postcondition:** Every attached attempt is auditable without the temp file.

##### Evidence
- Implementation: [batch-evidence.ts:49 buildBatchEvidenceMetadata()](/src/domain/formal/batch-evidence.ts#L49), [batch-evidence.ts:80 buildBatchEvidenceDraft()](/src/domain/formal/batch-evidence.ts#L80), [batch-evidence.ts:104 finalizeBatchEvidence()](/src/domain/formal/batch-evidence.ts#L104), [formalization-evidence.ts:58 buildFormalizationAttemptSet()](/src/domain/reporting/formalization-evidence.ts#L58)
- Test: [batch-evidence.test.ts:121 records complete pointer-only evidence, cleans up, and persists no claim text](/test/contract/batch-evidence.test.ts#L121)

#### Scenario: Hash Covers Exact Serialized Bytes [FLA-EVIDENCE-HASH]
WHEN the spec-check tool computes the context hash, THE hash SHALL be SHA-256 over the exact UTF-8 serialized bytes of the context file.

**Postcondition:** The hash is reproducible from the deterministic serialization.

##### Evidence
- Implementation: [batch-transport.ts:289 hashBatchContext()](/src/domain/formal/batch-transport.ts#L289), [batch-transport.ts:312 prepareBatchContextData()](/src/domain/formal/batch-transport.ts#L312)
- Test: [batch-evidence.test.ts:175 hashes the exact canonical UTF-8 context bytes](/test/contract/batch-evidence.test.ts#L175)

#### Scenario: Deleted Context Is Byte-Reconstructable [FLA-EVIDENCE-RECONSTRUCT]
WHEN a temp context file has been deleted, selecting the claim array identified by the enclosing `FormalizationAttemptSet.claimSet`, resolving the recorded local indexes only against that claim array, rebuilding the context object, and re-serializing deterministically SHALL yield bytes whose SHA-256 equals the recorded context hash.

**Postcondition:** Auditability survives temp-file deletion without duplicating claim text, and indexes from one invocation are never resolved against another invocation's claim set.

##### Evidence
- Implementation: [batch-transport.ts:219 buildBatchContextFile()](/src/domain/formal/batch-transport.ts#L219), [batch-transport.ts:270 serializeBatchContextFile()](/src/domain/formal/batch-transport.ts#L270), [batch-transport.ts:289 hashBatchContext()](/src/domain/formal/batch-transport.ts#L289)
- Test: [batch-evidence.test.ts:215 reconstructs deleted context bytes only within the envelope claim set](/test/contract/batch-evidence.test.ts#L215)

#### Scenario: Attempt Evidence Does Not Mark Completion [FLA-EVIDENCE-NOT-COMPLETE]
IF a run fails or the process terminates after one or more `FormalizationAttemptSet` files are atomically finalized, THEN those files MAY remain and SHALL NOT imply successful run completion.

**Postcondition:** Attempt evidence audits work performed; only a successful final manifest marks completion.

##### Evidence
- Implementation: [formalization-evidence.ts:205 writeFormalizationAttemptSet()](/src/domain/reporting/formalization-evidence.ts#L205)

#### Requirement model

```alloy
// Safety: any accepted or rejected settled attempt retains captured evidence.
assert attempt_evidence_total { always (Run.settled in Run.captured) }
```

### Requirement: Freeze Evidence-Backed Capability Concepts [FLA-CONCEPT-FREEZE]
WHEN eligible claims are prepared for formalization, THE spec-check tool SHALL perform one bounded discovery pass per semantic group and source side, reconcile candidates deterministically, and freeze a registry before dependent batches start.

**References:**
- [Design: Concepts and assumptions](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#concepts-and-assumptions)

#### Scenario: Every Sample Uses The Same Registry [FLA-CONCEPT-SHARED]
WHEN batches, inline calls, retries, fallbacks, or additional samples run, THE spec-check tool SHALL supply the same immutable registry and content hash for their semantic group.

#### Scenario: Missing Concepts Do Not Mutate Frozen State [FLA-CONCEPT-MISSING]
IF a predicate proposes an undeclared concept, THEN THE spec-check tool SHALL preserve the proposal and SHALL mark dependent formal scope unresolved without extending the frozen registry.

#### Scenario: Discovery Completion Order Is Irrelevant [FLA-CONCEPT-ORDER]
WHEN fixed discovery responses complete in different worker orders, THE spec-check tool SHALL produce identical registry bytes and identity-resolution outcomes using source-order reconciliation.

#### Scenario: Conflicting Explicit Concepts Are Not First-Wins [FLA-CONCEPT-COLLISION]
IF explicit concept keys have incompatible signatures, roles, scope, or units, THEN THE spec-check tool SHALL report a model-validation conflict and SHALL block dependent bindings rather than silently select one.

#### Requirement model

```alloy
// Frozen registries are immutable input values; dependent attempts must name
// that exact registry rather than mutate it during parallel completion.
// Safety: samples use frozen registry.
assert samples_use_frozen_registry { always (all a : Run.spawned | a.batch.group in Run.frozen) }
```

### Requirement: Separate Identity From Assumption Authority [FLA-PREMISE-AUTHORITY]
WHEN concept or background candidates are considered, THE spec-check tool SHALL distinguish explicit identities, grounded model-proposed identities, unresolved identities, and explicitly admitted domain premises.

**References:**
- [Design: Concepts and assumptions](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#concepts-and-assumptions)

#### Scenario: Plausible Domain Knowledge Remains A Proposal [FLA-PREMISE-INFERRED]
IF discovery proposes positivity, mode exclusivity, exhaustive alternatives, or other domain facts without explicit authority, THEN THE spec-check tool SHALL preserve them as proposals without adding them to background B.

#### Scenario: Enum Requires Declared Meaning [FLA-PREMISE-ENUM]
WHEN finite enum encoding is selected, THE spec-check tool SHALL require explicit evidence of exclusivity and exhaustiveness and SHALL otherwise retain a weaker or unresolved representation.

#### Scenario: Proposed Identity Qualifies Stability [FLA-PREMISE-CONDITIONAL]
WHEN a registry accepts grounded model-proposed identity alignment, THE spec-check tool SHALL label dependent interpretation agreement and conclusions conditional on that alignment rather than independently validated natural-language fidelity.

#### Requirement model

```alloy
sig Premise { explicitAuthority : one Bool, values : set Valuation }
fun admitted_background[p : set Premise] : set Premise { { a : p | a.explicitAuthority = True } }
// Safety: discovery-proposed facts cannot silently harden the background.
assert assumptions_need_authority { all p : set Premise | admitted_background[p].explicitAuthority in True }
```

### Requirement: Enforce A Conservative Typed Solver Fragment [FLA-TYPED-FRAGMENT]
WHEN expressions or assembled queries are admitted, THE spec-check tool SHALL enforce the supported quantifier-free Boolean, finite-enum, exact linear integer/real, and typed uninterpreted-function fragment with explicit sort coercions and units.

**References:**
- [Design: Expression and semantic IR](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#expression-and-semantic-ir)
- [Design: Resource bounds and encoding](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#resource-bounds-and-encoding)

#### Scenario: Numeric Values Remain Exact [FLA-TYPED-EXACT]
WHEN an integer, rational, or unit conversion is processed, THE spec-check tool SHALL preserve exact canonical values without JavaScript floating-point rounding.

#### Scenario: Unsupported Meaning Is Not Approximated [FLA-TYPED-UNSUPPORTED]
IF a claim requires nonlinear products, division/remainder, strings, quantifiers, collections, recursive datatypes, or temporal timing, THEN THE spec-check tool SHALL report unsupported scope rather than replace the required meaning with an opaque proposition or weaker arithmetic.

#### Scenario: Whole Query Features Are Checked [FLA-TYPED-COMBINED]
WHEN individually accepted expressions are combined, THE spec-check tool SHALL classify and validate the assembled feature set before invoking Z3.

#### Requirement model

```alloy
// Byte/node/depth limits and type/unit/arity observations are checked by the
// independent expression oracle; valid_attempt gates their use here.
// Safety: only typed samples.
assert only_typed_samples { always (all s : Run.accepted | s.attempt.expressionsValid = True and s.attempt.fragmentValid = True) }
```

### Requirement: Separate Mandatory Advisory And Permission Tracks [FLA-MODAL-TRACKS]
WHEN rules are analyzed, THE spec-check tool SHALL place only mandatory obligations in C and SHALL evaluate advisory obligations and explicit permissions in separate tracks.

**References:**
- [Design: Static query contracts](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#static-query-contracts)

#### Scenario: Advisory Conflict Does Not Poison Mandatory Model [FLA-MODAL-ADVISORY]
WHEN an advisory extension conflicts with a satisfiable mandatory baseline, THE spec-check tool SHALL issue a warning-scoped advisory conflict without claiming mandatory global inconsistency.

#### Scenario: Permission Is Not Required Action [FLA-MODAL-PERMISSION]
WHEN a `MAY` response is absent from a satisfying mandatory valuation, THE spec-check tool SHALL omit a missing-response violation for that permission.

#### Scenario: Permission Conflicting With Prohibition Is Visible [FLA-MODAL-PROHIBITION]
WHEN `B and G_p` is SAT but `B and G_p and C and R_p` is UNSAT, THE spec-check tool SHALL report permission infeasibility with its admitted premises and conflicting evidence.

#### Requirement model

```alloy
// Safety: advisory and permission rules do not constrain the mandatory baseline.
assert permissions_not_required {
  always (all g : Group | (no c : candidates & members[g] | c.modal = Mandatory and c.form = Refinement)
    implies mandatory[g] = Valuation)
}
```

### Requirement: Check Individual Rule Activation Feasibility [FLA-RULE-ACTIVATION]
WHEN mandatory rule checks are planned, THE spec-check tool SHALL test guard satisfiability, self-response feasibility, and full-set activation feasibility under explicit background premises.

**References:**
- [Design: Static query contracts](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#static-query-contracts)

#### Scenario: Guard Against Unconditional Prohibition [FLA-ACTIVATE-UBIQUITOUS]
WHEN a satisfiable guard demands a response forbidden by an unconditional mandatory rule, THE spec-check tool SHALL report the activation conflict even when the unforced global model is SAT.

#### Scenario: Self-Conflict Needs No Cross-Claim Pair [FLA-ACTIVATE-SELF]
WHEN `B and G_i` is SAT but adding the rule's response is UNSAT, THE spec-check tool SHALL report the self-response conflict without requiring another claim or a shared-symbol pair.

#### Scenario: Multi-Rule Conflict Is Attributed Honestly [FLA-ACTIVATE-MULTI]
WHEN activation is infeasible because of three or more mandatory rules, THE spec-check tool SHALL preserve the actual sufficient core rather than require a contradictory pair.

#### Scenario: Impossible Guard Is Static Vacuity [FLA-ACTIVATE-VACUOUS]
WHEN `B and G_i` is UNSAT, THE spec-check tool SHALL report static guard vacuity under B without claiming temporal unreachability.

#### Requirement model

```alloy
// Activation, guard and self-response formulas above distinguish static vacuity
// from full-set response infeasibility, without inventing temporal reachability.
// Safety: activation subset global.
assert activation_subset_global { all q : Query | q.kind = Activation implies formula[q] in mandatory[q.group] }
```

### Requirement: Preserve Scenario Logical Meaning [FLA-SCENARIO-MEANING]
WHEN scenario artifacts are formalized, THE spec-check tool SHALL preserve refinement, example, and prohibited-example semantics with scenario-scoped postconditions.

**References:**
- [Design: Static query contracts](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#static-query-contracts)

#### Scenario: Example Does Not Assert A Global Fact [FLA-SCENARIO-WITNESS]
WHEN a concrete positive example is checked, THE spec-check tool SHALL query `B and C and input and expected` as a witness without adding its concrete input or expected response to every valuation.

#### Scenario: Prohibited Example Checks Allowed Bad Behavior [FLA-SCENARIO-PROHIBITED]
WHEN a prohibited example is checked, THE spec-check tool SHALL report SAT of `B and C and input and forbidden` as allowed prohibited behavior and SHALL report UNSAT only as exclusion within the admitted scope.

#### Requirement model

```alloy
// Concrete examples are query-local; mandatory excludes their concrete inputs.
// Safety: examples are query local.
assert examples_are_query_local { all q : Query | q.kind in PositiveExample + NegativeExample implies
  formula[q] in q.first.input & q.first.outcome & q.first.postcondition }
```

### Requirement: Bound Every New Analysis Stage [FLA-ANALYSIS-BOUNDS]
WHEN discovery, expression processing, query planning, or evidence-producing solver work begins, THE spec-check tool SHALL enforce the effective named count, byte, depth, time, and concurrency limits documented in the design.

**References:**
- [Design: Resource bounds and encoding](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#resource-bounds-and-encoding)

#### Scenario: Enumeration And Solver Work Remain Bounded [FLA-BOUNDS-QUERIES]
WHEN the per-group script ceiling of 1,000 or run-wide solver concurrency ceiling of 16 applies, THE spec-check tool SHALL count clustering, auxiliary, and comparison scripts within the same resource accounting and SHALL report unexecuted scope.

**Postcondition:** The shared per-capability actual-script allowance and run-owned recorder also apply when all original statements are excluded and only generated typed artifacts exist. Empty generated scope executes no scripts.

#### Scenario: Expression Limits Precede Solver Work [FLA-BOUNDS-EXPRESSIONS]
IF an expression exceeds its effective 65,536-byte, 8,192-node, or depth-128 default limit, THEN THE spec-check tool SHALL reject it with attributed evidence before compilation or solver execution.

**Postcondition:** The effective configured limits apply equally to foreground predicates, authored background, and coverage applicability. Cached registry preparation must include the limit tuple or be bound to one limit set; reusing a registry cannot bypass a tighter limit.

#### Scenario: Discovery Limits Are Not Silent Truncation [FLA-BOUNDS-DISCOVERY]
IF discovery exceeds its default 1-MiB group context, 256-KiB chunk, 32-chunk, or 2,048-concept limits, THEN THE spec-check tool SHALL record affected unresolved scope instead of silently omitting concepts.

#### Scenario: Disabling Physical Splitting Does Not Remove Bounds [FLA-BOUNDS-BATCH-ZERO]
WHEN `maxBatchSize` is zero, THE spec-check tool SHALL preserve the single-chunk transport behavior while still enforcing semantic context, expression, query, and evidence bounds.

#### Requirement model

```alloy
pred issue[q : Query, s : ScriptToken, e : EvidenceToken] {
  query_enabled[q]
  s not in Query.(Run.usedScripts)
  e not in (Attempt + Query).(Run.reservations)
  Run.issued' = Run.issued + q
  Run.usedScripts' = Run.usedScripts + q -> s
  Run.reservations' = Run.reservations + q -> e
  Run.persisted' = Run.persisted
  Run.skipped' = Run.skipped
  Run.outputFailed' = Run.outputFailed
  Run.phase' = Run.phase
  Run.frozen' = Run.frozen
  keep_attempts
}
pred skip[q : Query] {
  ((Run.phase = Selecting and q.stage = ClusteringQueries) or (Run.phase = Analyzing and q.stage = AnalysisQueries))
  q not in Run.issued + Run.skipped
  (q.prerequisites in Run.persisted + Run.skipped and not query_enabled[q]) or
    some q.prerequisites & Run.skipped or
    (some p : q.satPrerequisites & Run.persisted | verdict[p] != Sat) or
    no ScriptToken - Query.(Run.usedScripts) or
    no EvidenceToken - (Attempt + Query).(Run.reservations)
  Run.skipped' = Run.skipped + q
  Run.issued' = Run.issued
  Run.persisted' = Run.persisted
  Run.usedScripts' = Run.usedScripts
  Run.reservations' = Run.reservations
  Run.outputFailed' = Run.outputFailed
  Run.phase' = Run.phase
  Run.frozen' = Run.frozen
  keep_attempts
}
// Safety: each actual script consumes a unique script and reserved capture token.
assert scripts_are_charged { always (Run.usedScripts.ScriptToken = Run.issued and
  all s : ScriptToken | lone (Run.usedScripts).s) }
```

### State machine and invariant checks

```alloy
pred keep_attempts_except_selection {
  Run.stages' = Run.stages
  Run.spawned' = Run.spawned
  Run.captured' = Run.captured
  Run.settled' = Run.settled
  Run.accepted' = Run.accepted
  Run.errors' = Run.errors
}
pred keep_attempts { keep_attempts_except_selection and Run.selected' = Run.selected }
pred keep_attempts_except_transport {
  Run.spawned' = Run.spawned
  Run.settled' = Run.settled
  Run.accepted' = Run.accepted
  Run.errors' = Run.errors
  Run.selected' = Run.selected
}
pred keep_queries_except_reservations {
  Run.issued' = Run.issued
  Run.persisted' = Run.persisted
  Run.skipped' = Run.skipped
  Run.usedScripts' = Run.usedScripts
  Run.outputFailed' = Run.outputFailed
}
pred keep_queries { keep_queries_except_reservations and Run.reservations' = Run.reservations }
pred keep_queries_except_persistence {
  Run.issued' = Run.issued
  Run.skipped' = Run.skipped
  Run.usedScripts' = Run.usedScripts
  Run.reservations' = Run.reservations
  Run.outputFailed' = Run.outputFailed
}
pred begin_analysis {
  Run.phase = Selecting and (Run.selected).Sample = candidates
  { q : Query | q.stage = ClusteringQueries } in Run.persisted + Run.skipped
  Run.phase' = (Config.artifactKeyCollision = True => Aborted else Analyzing)
  Run.frozen' = Run.frozen
  keep_attempts
  keep_queries
}
pred finish {
  Run.phase = Analyzing and Query = Run.persisted + Run.skipped
  Run.phase' = Complete
  Run.frozen' = Run.frozen
  keep_attempts
  keep_queries
}
pred write_failure[q : Query] {
  Run.phase in Selecting + Analyzing and q in Run.issued - Run.persisted and q.writeFails = True
  Run.phase' = Aborted
  Run.outputFailed' = True
  Run.frozen' = Run.frozen
  keep_attempts
  Run.issued' = Run.issued
  Run.persisted' = Run.persisted
  Run.skipped' = Run.skipped
  Run.usedScripts' = Run.usedScripts
  Run.reservations' = Run.reservations
}
pred init {
  Run.phase = Discover
  no Run.frozen + Run.spawned + Run.captured + Run.settled + Run.accepted + Run.errors +
    Run.issued + Run.persisted + Run.skipped
  no Run.selected
  no Run.usedScripts
  no Run.reservations
  Run.stages = Attempt -> NotCreated
  Run.outputFailed = False
}
pred stutter { Run.phase' = Run.phase and Run.frozen' = Run.frozen and keep_attempts and keep_queries }
fact behavior { init and always (stutter or begin_sampling or end_sampling or begin_analysis or finish or
  (some g : Group | freeze[g]) or (some a : Attempt | prepare[a] or write_context[a] or cleanup[a] or settle[a]) or
  (some a : Attempt, e : EvidenceToken | capture[a,e]) or (some c : eligible | close_claim[c]) or
  (some c : Claim, s : Sample | choose[c,s]) or (some q : Query | persist[q] or skip[q] or write_failure[q]) or
  (some q : Query, s : ScriptToken, e : EvidenceToken | issue[q,s,e])) }
// Scheduler premises service actions, not the desired final outcome. Model
// attempts have finite opportunity sets. Resource availability for model capture
// is explicit; query refusal is a visible skip and needs no success assumption.
pred fairness {
  always (Run.phase = Discover implies eventually (begin_sampling or some g : Group | freeze[g]))
  always (Run.phase = Sampling implies eventually (end_sampling or
    (some a : Attempt | prepare[a] or write_context[a] or cleanup[a] or settle[a]) or
    (some a : Attempt, e : EvidenceToken | capture[a,e]) or (some c : eligible | close_claim[c])))
  always (Run.phase = Selecting implies eventually (begin_analysis or (some c : Claim, s : Sample | choose[c,s]) or
    (some q : Query | persist[q] or skip[q] or write_failure[q]) or
    (some q : Query, s : ScriptToken, e : EvidenceToken | issue[q,s,e])))
  always (Run.phase = Analyzing implies eventually (finish or (some q : Query | persist[q] or skip[q] or write_failure[q]) or
    (some q : Query, s : ScriptToken, e : EvidenceToken | issue[q,s,e])))
}
// Safety: additional failures cannot revoke an already accepted candidate.
assert candidates_never_revoked { always (candidates in candidates') }
// Safety: complete/abort phases permit no later model or solver work.
assert terminal_absorbing { always (Run.phase in Complete + Aborted implies Run.phase' = Run.phase and Run.spawned' = Run.spawned and Run.issued' = Run.issued) }
// Safety: solver diagnostics override even a simultaneously printed SAT verdict.
assert diagnostic_overrides_verdict { all q : Query | q.errorDiagnostic = True implies verdict[q] = SolverError }
// Liveness: finite serviced work reaches an explicit terminal outcome.
pred model_capture_capacity { #EvidenceToken >= #Attempt }
assert pipeline_terminates { fairness and model_capture_capacity implies eventually Run.phase in Complete + Aborted }
run all_ineligible { no eligible and fairness and eventually Run.phase = Complete } for 3 but 5 Int, 5 steps expect 1
run total_failure { some eligible and no a : Attempt | valid_attempt[a]
  eventually formalization_exit = 9 } for 3 but 5 Int, 20 steps expect 1
run partial_success { eventually (Run.phase = Complete and some candidates and some Run.errors) } for 3 but 5 Int, 24 steps expect 1
run attached_cleanup_failure { some a : Attempt | a.transport = Attached and a.cleanupFails = True and valid_attempt[a] and
  eventually (a in Run.settled and some { s : Run.accepted | s.attempt = a }) } for 3 but 5 Int, 18 steps expect 1
run multiple_keys { some disj g,h : Group | g.key != h.key and some members[g] and some members[h] } for 3 but 5 Int, 1 steps expect 1
run extra_sample_failure { some disj a,b : Attempt | a in b.earlier and a.claims = b.claims and valid_attempt[a] and not valid_attempt[b] and
  eventually (b in Run.settled and a.claims in candidates) } for 3 but 5 Int, 24 steps expect 1
run error_alongside_sat { some q : Query | q.observed = Sat and q.errorDiagnostic = True and eventually q in Run.persisted } for 3 but 5 Int, 24 steps expect 1
check rejected_response_not_accepted for 4 but 5 Int, 20 steps expect 0
check no_eligible_no_calls for 4 but 5 Int, 20 steps expect 0
check compiler_names_injective for 5 but 1 steps expect 0
check singleton_not_stable for 4 but 5 Int, 20 steps expect 0
check equivalence_symmetric for 4 but 5 Int, 20 steps expect 0
check key_group_parity for 4 but 5 Int, 1 steps expect 0
check pair_prerequisites for 4 but 5 Int, 20 steps expect 0
check gaps_have_witnesses for 4 but 5 Int, 20 steps expect 0
check timeouts_not_proofs for 4 but 5 Int, 20 steps expect 0
check complete_requires_evidence for 4 but 5 Int, 20 steps expect 0
check primary_outcome_retained for 4 but 5 Int, 20 steps expect 0
check source_indexes_unique for 5 but 1 steps expect 0
check batches_partition for 4 but 5 Int, 1 steps expect 0
check transport_by_arity for 4 but 5 Int, 1 steps expect 0
check indexes_bound_before_acceptance for 4 but 5 Int, 20 steps expect 0
check cleanup_before_outcome for 4 but 5 Int, 20 steps expect 0
check no_infrastructure_degradation for 4 but 5 Int, 20 steps expect 0
check claim_partition for 4 but 5 Int, 20 steps expect 0
check samples_keep_identity for 4 but 5 Int, 20 steps expect 0
check attempt_evidence_total for 4 but 5 Int, 20 steps expect 0
check samples_use_frozen_registry for 4 but 5 Int, 20 steps expect 0
check assumptions_need_authority for 5 but 1 steps expect 0
check only_typed_samples for 4 but 5 Int, 20 steps expect 0
check permissions_not_required for 4 but 5 Int, 20 steps expect 0
check activation_subset_global for 4 but 5 Int, 20 steps expect 0
check examples_are_query_local for 4 but 5 Int, 20 steps expect 0
check scripts_are_charged for 4 but 5 Int, 20 steps expect 0
check candidates_never_revoked for 4 but 5 Int, 20 steps expect 0
check terminal_absorbing for 4 but 5 Int, 20 steps expect 0
check diagnostic_overrides_verdict for 5 but 1 steps expect 0
check pipeline_terminates for 3 but 5 Int, 28 steps expect 0
check compiler_exclusions_are_sound for 4 but 5 Int, 1 steps expect 0
// Distinct source claims may share display IDs without sharing compile labels.
run duplicate_display_ids_keep_identity { some disj a,b : eligible |
  some a.displayId and a.displayId = b.displayId and a.compileLabel != b.compileLabel } for 4 but 5 Int, 1 steps expect 1
run residual_conflict_exclusion { some g : CompileInput, disj a,b : g.claims |
  checked_compilation[g] and some conflict_reason[a,b] and a in g.retained and b in g.excluded } for 4 but 5 Int, 1 steps expect 1
run dangling_dependency_excluded_before_query { some g : CompileInput | checked_compilation[g] and some g.unresolved } for 4 but 5 Int, 1 steps expect 1
run two_group_query_evidence {
  some disj q,r : Query | q.group != r.group and eventually q + r in Run.persisted
} for 4 but 5 Int, 5 EvidenceToken, 2 ScriptToken, 32 steps expect 1
run bounded_model_recovery {
  some a : Attempt | a.transport = Attached and a.result = ModelFailure and
    eventually (a in Run.settled and (all child : recoveryOf.a | child in Run.settled))
} for 4 but 5 Int, 5 Sample, 5 EvidenceToken, 32 steps expect 1
// Nonvacuity: globally satisfiable mandatory rules may have a genuinely
// three-rule activation conflict although every response pair is feasible.
run three_rule_activation_with_query_evidence {
  eventually (some disj a,b,c : candidates | {
    (a+b+c).modal = Mandatory
    (a+b+c).form = Refinement
    a.guard = b.guard and b.guard = c.guard
    a.postcondition = Valuation and b.postcondition = Valuation and c.postcondition = Valuation
    some a.guard & semantic_response[a] & semantic_response[b]
    some a.guard & semantic_response[a] & semantic_response[c]
    some a.guard & semantic_response[b] & semantic_response[c]
    no a.guard & semantic_response[a] & semantic_response[b] & semantic_response[c]
    some global : Run.persisted | global.kind = Global and verdict[global] = Sat and a+b+c in global.owners
    some activation : Run.persisted | activation.kind = Activation and activation.first = a and verdict[activation] = Unsat
  })
} for 4 but 5 Int, 4 Query, 4 ScriptToken, 8 EvidenceToken, 36 steps expect 1
```

**Verification boundary:** All commands use explicit finite scopes. Concrete byte/order preservation and external-process deadlines require the referenced contract/property and integration tests. Passing bounded checks does not prove natural-language fidelity or production refinement.
