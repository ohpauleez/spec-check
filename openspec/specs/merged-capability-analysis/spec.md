---
title: MergedCapabilityAnalysis
---

## Purpose

Define the per-capability merge behavior for the spec-check tool: combining finalized capability specs with selected delta specs into one deterministic active merged capability view that downstream specs-forward analysis consumes.

```alloy
module MergedCapabilityAnalysis

// --- Domain vocabulary ---

// Canonical requirement and scenario identifiers
sig Identifier {}

// Delta operations classify requirement blocks within a delta spec
abstract sig DeltaOperation {}
one sig Base, PreSection, Added, Modified, Removed, Renamed extends DeltaOperation {}

// Source file provenance: the physical file a requirement originated from
sig SourceFile {}

// Namespace separation: requirement and scenario identifiers are distinct
abstract sig Namespace {}
one sig ReqNamespace, ScenNamespace extends Namespace {}

// A parsed requirement block with provenance and delta classification
sig Requirement {
  identifier : lone Identifier,
  deltaOp : one DeltaOperation,
  scenarios : set Scenario,
  sourceFile : one SourceFile,
  namespace : one Namespace
} {
  namespace = ReqNamespace
}

// A parsed scenario within a requirement block
sig Scenario {
  scenarioId : lone Identifier,
  parentReq : lone Requirement,
  scenDeltaOp : one DeltaOperation,
  scenSourceFile : one SourceFile,
  scenNamespace : one Namespace
} {
  scenNamespace = ScenNamespace
}

// A parsed spec document (finalized or delta)
sig ParsedSpec {
  requirements : set Requirement,
  source : one SourceFile,
  deltaSections : set DeltaOperation    // which delta headings were found
}

// A capability: the unit of merge. At most one finalized, at most one delta.
sig Capability {
  finalized : lone ParsedSpec,
  delta : lone ParsedSpec
}

// --- Merged output ---

sig MergedCapability {
  cap : one Capability,
  mergedReqs : set Requirement,
  mergedScenarios : set Scenario,
  logicalKey : one LogicalKey,
  findings : set Finding
}

// Synthetic logical key for artifact naming (distinct from source provenance)
sig LogicalKey {}

// --- Findings ---

abstract sig FindingKind {}
one sig DupBase, DupDelta, DupAdded, DupModifiedId,
        ModNotFound, RemNotFound,
        ModMissingId, RemMissingId,
        PreSectionContent, StandaloneScenario,
        RenameUnsupported, FinalizedDeltaHeadingIgnored,
        EmptyCapSkipped extends FindingKind {}

sig Finding {
  kind : one FindingKind,
  affectedReq : lone Requirement,
  affectedScen : lone Scenario
}

// --- Pipeline state (temporal: for liveness modeling) ---

abstract sig Phase {}
one sig Idle, Merging, ClaimExtraction, CoverageAnalysis,
        LogicAnalysis, Complete extends Phase {}

one sig PipelineState {
  var currentPhase : one Phase,
  var processedCaps : set MergedCapability,   // caps submitted downstream
  var mergeComplete : set MergedCapability     // caps that completed merge
}

// --- Ownership and well-formedness facts ---

// [Precondition] At most one delta per capability
fact atMostOneDelta {
  all c : Capability | lone c.delta
}

// Every finding belongs to exactly one merged capability
fact findingOwnership {
  all f : Finding | one (findings.f)
}

// Requirements belong to exactly one parsed spec
fact requirementOwnership {
  all r : Requirement | one (requirements.r)
}

// Scenarios belong to at most one requirement
fact scenarioOwnership {
  all s : Scenario | lone (scenarios.s)
}

// Parsed specs belong to at most one capability role
fact parsedSpecOwnership {
  all p : ParsedSpec | lone (finalized.p + delta.p)
}

// Requirement source file is consistent with its parsed spec
fact requirementSourceConsistency {
  all r : Requirement, p : ParsedSpec |
    r in p.requirements implies r.sourceFile = p.source
}

// Scenario source file is consistent with its parent requirement
fact scenarioSourceConsistency {
  all s : Scenario | some s.parentReq implies
    s.scenSourceFile = s.parentReq.sourceFile
}

// Base items in finalized specs have deltaOp = Base
fact baseItemsHaveBaseOp {
  all r : Requirement |
    (some p : ParsedSpec | r in p.requirements and p in Capability.finalized)
      implies r.deltaOp = Base
}

// Scenarios inherit parent's delta operation
fact scenarioInheritsDelta {
  all s : Scenario | some s.parentReq implies
    s.scenDeltaOp = s.parentReq.deltaOp
}

// --- Merge structural invariants ---
// Merge is a deterministic pure function over (finalized, delta) inputs.
// Its invariants are modeled as structural facts (not temporal events).

// [MCA-MERGE-CAP] Each capability produces exactly one merged view
fact oneViewPerCapability {
  all c : Capability | one mc : MergedCapability | mc.cap = c
}

// Each MergedCapability has a unique logical key
fact uniqueLogicalKeys {
  all disj mc1, mc2 : MergedCapability | mc1.logicalKey != mc2.logicalKey
}

// [MCA-MERGE-PROVEN] Merged output traces to input source files
fact mergedProvenance {
  all mc : MergedCapability, r : mc.mergedReqs |
    r.sourceFile in (mc.cap.finalized.source + mc.cap.delta.source)
}

// [MCA-MERGE-PROVEN-SCEN] Scenario source files also trace to inputs
fact scenarioProvenance {
  all mc : MergedCapability, s : mc.mergedScenarios |
    s.scenSourceFile in (mc.cap.finalized.source + mc.cap.delta.source)
}

// Merged requirements originate from the capability's parsed specs
fact mergedReqsFromInput {
  all mc : MergedCapability, r : mc.mergedReqs |
    r in mc.cap.finalized.requirements + mc.cap.delta.requirements
}

// Merged scenarios are exactly those belonging to merged requirements
fact mergedScenariosFromReqs {
  all mc : MergedCapability |
    mc.mergedScenarios = mc.mergedReqs.scenarios
}

// [MCA-DELTA-SEM] Excluded operations never in merged output
fact excludedOpsNeverInOutput {
  all mc : MergedCapability |
    no r : mc.mergedReqs | r.deltaOp in (Removed + PreSection + Renamed)
}

// [MCA-MERGE-DELTA-ONLY] Delta-only caps only include Added reqs
fact deltaOnlyAdditiveOutput {
  all mc : MergedCapability |
    (no mc.cap.finalized and some mc.cap.delta) implies
      (all r : mc.mergedReqs | r.deltaOp = Added)
}

// [MCA-DELTA-NAMESPACE] No duplicate requirement identifiers in merged output
fact mergedReqIdUniqueness {
  all mc : MergedCapability, disj r1, r2 : mc.mergedReqs |
    (some r1.identifier and some r2.identifier) implies
      r1.identifier != r2.identifier
}

// [MCA-DELTA-NAMESPACE] No duplicate scenario identifiers in merged output
fact mergedScenIdUniqueness {
  all mc : MergedCapability, disj s1, s2 : mc.mergedScenarios |
    (some s1.scenarioId and some s2.scenarioId) implies
      s1.scenarioId != s2.scenarioId
}

// [MCA-MERGE-STANDALONE] Standalone delta scenarios never in merged output
fact standaloneScenarioExcluded {
  all mc : MergedCapability, s : mc.mergedScenarios |
    (some mc.cap.delta and s.scenSourceFile = mc.cap.delta.source) implies
      some s.parentReq
}

// [MCA-MERGE-FIND] Every excluded delta requirement has a finding
fact skipImpliesFinding {
  all mc : MergedCapability, r : Requirement |
    (some mc.cap.delta and r in mc.cap.delta.requirements
     and r not in mc.mergedReqs)
    implies some f : mc.findings | f.affectedReq = r
}

// [MCA-MERGE-FIND] Empty capabilities have EmptyCapSkipped finding
fact emptyCapFinding {
  all mc : MergedCapability |
    (no mc.mergedReqs and some mc.cap.(finalized + delta).requirements)
    implies some f : mc.findings | f.kind = EmptyCapSkipped
}

// [MCA-MERGE-MOD-COLLISION] Collision preserves original base block
fact collisionPreservesBase {
  all mc : MergedCapability, f : mc.findings |
    (f.kind = DupModifiedId and some f.affectedReq and some f.affectedReq.identifier)
    implies (some baseR : mc.cap.finalized.requirements |
      baseR.identifier = f.affectedReq.identifier and baseR in mc.mergedReqs)
}

// [MCA-MERGE-DUP-BASE] First-occurrence wins for duplicate base identifiers
fact firstOccurrenceWins {
  all mc : MergedCapability, disj r1, r2 : mc.cap.finalized.requirements |
    (some r1.identifier and r1.identifier = r2.identifier)
    implies not (r1 in mc.mergedReqs and r2 in mc.mergedReqs)
}

// Findings reference only requirements from this capability's input
fact findingsAreLocal {
  all mc : MergedCapability, f : mc.findings |
    some f.affectedReq implies
      f.affectedReq in mc.cap.finalized.requirements + mc.cap.delta.requirements
}

// Cross-capability isolation: findings don't reference other capabilities' reqs
fact capabilityIsolation {
  all disj mc1, mc2 : MergedCapability |
    no (mc1.findings.affectedReq &
        (mc2.cap.finalized.requirements + mc2.cap.delta.requirements))
}

// No base requirement disappears silently (removed OR has finding)
fact noSilentDiscard {
  all mc : MergedCapability, r : Requirement |
    (some mc.cap.finalized and r in mc.cap.finalized.requirements
     and r not in mc.mergedReqs)
    implies (
      (some rem : Requirement | rem in mc.cap.delta.requirements
        and rem.deltaOp = Removed and rem.identifier = r.identifier
        and some r.identifier)
      or (some f : mc.findings | f.affectedReq = r)
    )
}

// [MCA-MERGE-FIND] Valid ADDED blocks with no collisions appear in merged output
fact validAddedIncluded {
  all mc : MergedCapability, r : mc.cap.delta.requirements |
    (r.deltaOp = Added
     and (no r.identifier or r.identifier not in (mc.mergedReqs - r).identifier)
     and no (r.scenarios.scenarioId & (mc.mergedScenarios - r.scenarios).scenarioId)
     and not (some f : mc.findings | f.affectedReq = r))
    implies r in mc.mergedReqs
}

// [MCA-MERGE-NO-SPURIOUS] Findings only arise when a delta is present
// (a finalized-only pass-through with no delta headings produces no findings)
fact findingsRequireDelta {
  all mc : MergedCapability |
    (no mc.cap.delta and no (mc.cap.finalized.deltaSections - Base))
    implies no mc.findings
}

// Non-colliding Added requirements cannot be the subject of findings
// (findings target specific operation failures, not clean additions)
fact addedNoCollisionClean {
  all mc : MergedCapability, r : mc.cap.delta.requirements |
    (r.deltaOp = Added
     and (no r.identifier or r.identifier not in (mc.mergedReqs - r).identifier)
     and no (r.scenarios.scenarioId & (mc.mergedScenarios - r.scenarios).scenarioId))
    implies (no f : mc.findings | f.affectedReq = r)
}

// --- Pipeline initial state ---

pred init_state {
  PipelineState.currentPhase = Idle
  no PipelineState.processedCaps
  no PipelineState.mergeComplete
}
```

## Requirements

### Requirement: Merge Finalized And Delta Specs Per Capability [MCA-MERGE-CAP]
WHEN specs-forward analysis begins for a capability that has a finalized spec and a selected active delta spec, THE spec-check tool SHALL produce exactly one merged active capability view by applying the delta requirement sections to the finalized requirement blocks before claim extraction, coverage analysis, and solver grouping.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Proposed Design`

#### Scenario: Finalized And Delta Inputs Produce One Active View [MCA-MERGE-ACTIVE]
WHEN one capability has both finalized and selected delta spec inputs, THE spec-check tool SHALL merge them into one active capability view and SHALL use that merged view as the only spec-derived input to downstream specs-forward claim extraction.

**Postcondition:** Downstream specs-forward phases do not analyze separate finalized and delta claim sets for the same capability.

##### Evidence
- Implementation: [merge.ts:24 mergeSpecsByCapability()](/src/domain/parser/merge.ts#L24), [claim-graph.ts:247 extractMergedSpecClaims()](/src/domain/claim-graph.ts#L247)
- Test: [merge.test.ts:76 applies REMOVED then MODIFIED then ADDED deterministically](/test/contract/merge.test.ts#L76)
- Test (integration): [merge-liveness.integration.test.ts:181 routes only active merged requirements to logic inputs (removed excluded, modified retained)](/test/integration/merge-liveness.integration.test.ts#L181)

#### Scenario: Finalized-Only Capability Passes Through Unchanged [MCA-MERGE-FINAL]
WHEN a capability has a finalized spec and no selected delta spec, THE spec-check tool SHALL produce a merged capability view whose requirement and scenario content matches the finalized spec content in the same order.

**Postcondition:** Finalized-only capabilities preserve their existing active behavior under the merge phase.

##### Evidence
- Implementation: [merge.ts:24 mergeSpecsByCapability()](/src/domain/parser/merge.ts#L24), [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88)
- Test: [merge.test.ts:62 passes finalized-only capability unchanged](/test/contract/merge.test.ts#L62)

#### Scenario: Delta-Only Capability Uses Additive Output Only [MCA-MERGE-DELTA-ONLY]
WHEN a capability has a selected delta spec and no finalized base spec, THE spec-check tool SHALL treat the initial merged base as empty, SHALL allow `ADDED` requirement blocks to contribute output, and SHALL skip `MODIFIED` and `REMOVED` operations with explicit findings.

**Postcondition:** Delta-only capabilities produce deterministic partial output without pretending that nonexistent base requirements were modified or removed.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [merge.ts:244 applyRemoved()](/src/domain/parser/merge.ts#L244), [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296), [merge.ts:357 applyAdded()](/src/domain/parser/merge.ts#L357)
- Test: [merge.test.ts:241 supports delta-only capability with ADDED output and MODIFIED/REMOVED findings](/test/contract/merge.test.ts#L241)

#### Requirement model

```alloy
// --- Merge per capability: event predicates ---
// The merge phase is a pure deterministic function over (finalized, delta) inputs.
// Preconditions, postconditions, and failure modes are modeled as event predicates.

// Event: merge a capability that has both finalized and delta inputs
pred merge_finalized_and_delta [c : Capability, mc : MergedCapability] {
  // Guard (precondition)
  mc.cap = c
  some c.finalized
  some c.delta
  PipelineState.currentPhase = Merging
  mc not in PipelineState.mergeComplete
  // Effect (postcondition): exactly one merged view produced
  mc in PipelineState.mergeComplete'
  // Merged reqs are a subset of finalized + delta inputs
  mc.mergedReqs in c.finalized.requirements + c.delta.requirements
  // No excluded operations leak through
  no r : mc.mergedReqs | r.deltaOp in Removed + PreSection + Renamed
  // Frame conditions
  PipelineState.currentPhase' = PipelineState.currentPhase
  PipelineState.processedCaps' = PipelineState.processedCaps
}

// Event: merge a finalized-only capability (passthrough)
pred merge_finalized_only [c : Capability, mc : MergedCapability] {
  // Guard
  mc.cap = c
  some c.finalized
  no c.delta
  PipelineState.currentPhase = Merging
  mc not in PipelineState.mergeComplete
  // Effect: merged output equals finalized content exactly
  mc.mergedReqs = c.finalized.requirements
  mc.mergedScenarios = c.finalized.requirements.scenarios
  no mc.findings
  mc in PipelineState.mergeComplete'
  // Frame
  PipelineState.currentPhase' = PipelineState.currentPhase
  PipelineState.processedCaps' = PipelineState.processedCaps
}

// Event: merge a delta-only capability (additive only)
pred merge_delta_only [c : Capability, mc : MergedCapability] {
  // Guard
  mc.cap = c
  no c.finalized
  some c.delta
  PipelineState.currentPhase = Merging
  mc not in PipelineState.mergeComplete
  // Effect: only ADDED blocks contribute to output
  all r : mc.mergedReqs | r.deltaOp = Added
  mc.mergedReqs in c.delta.requirements
  // MODIFIED and REMOVED in a delta-only context produce findings
  all r : c.delta.requirements |
    r.deltaOp in (Modified + Removed) implies
      some f : mc.findings | f.affectedReq = r
  mc in PipelineState.mergeComplete'
  // Frame
  PipelineState.currentPhase' = PipelineState.currentPhase
  PipelineState.processedCaps' = PipelineState.processedCaps
}

// Failure mode: more than one delta supplied (precondition violation)
// This is caught by assertion, not by graceful finding emission.
pred merge_precondition_violated [c : Capability] {
  // Guard: two deltas for same capability (violates atMostOneDelta fact)
  // In well-formed input this cannot happen; modeled as an impossibility.
  // This pred is unsatisfiable by construction (fact atMostOneDelta prevents it).
  #{p : ParsedSpec | p = c.delta} > 1
}

// Safety: each capability produces exactly one merged view
assert one_view_per_capability {
  all c : Capability | one mc : MergedCapability | mc.cap = c
}

// Safety: finalized-only passthrough produces no findings
// (unless the finalized spec has delta headings, which produces a warning)
assert finalized_only_no_findings {
  all mc : MergedCapability |
    (some mc.cap.finalized and no mc.cap.delta
     and no (mc.cap.finalized.deltaSections - Base))
      implies no mc.findings
}

// Safety: delta-only caps never include MODIFIED or REMOVED in output
assert delta_only_additive_output {
  all mc : MergedCapability |
    (no mc.cap.finalized and some mc.cap.delta)
      implies (all r : mc.mergedReqs | r.deltaOp = Added)
}

// Safety: downstream never sees separate finalized and delta claim sets
// (only the single merged view reaches downstream)
assert single_merged_input_to_downstream {
  all mc : MergedCapability |
    mc in PipelineState.processedCaps implies
      one mc2 : PipelineState.processedCaps | mc2.cap = mc.cap
}

check one_view_per_capability for 6 expect 0
check finalized_only_no_findings for 5 expect 0
check delta_only_additive_output for 5 expect 0
check single_merged_input_to_downstream for 5 expect 0
```

### Requirement: Apply Requirement-Block Delta Semantics Deterministically [MCA-DELTA-SEM]
WHEN the spec-check tool merges a selected delta spec into a capability, THE spec-check tool SHALL apply `REMOVED` operations first, `MODIFIED` operations second, and `ADDED` operations last, all at the requirement-block level using canonical requirement identifiers, and SHALL preserve deterministic output ordering.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Merge Semantics`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Merge Contract`

#### Scenario: Added Requirement Appended After Surviving Base Requirements [MCA-DELTA-ADD]
WHEN an `ADDED` requirement block has no colliding requirement or scenario identifiers, THE spec-check tool SHALL append that requirement block after the surviving base requirement blocks in delta-document order.

**Postcondition:** Added behavior appears exactly once at the end of the merged capability requirement ordering.

##### Evidence
- Implementation: [merge.ts:357 applyAdded()](/src/domain/parser/merge.ts#L357)
- Test: [merge.test.ts:76 applies REMOVED then MODIFIED then ADDED deterministically](/test/contract/merge.test.ts#L76)

#### Scenario: Modified Requirement Replaces Base Block In Place [MCA-DELTA-MOD]
WHEN a `MODIFIED` requirement block matches a surviving base requirement by canonical identifier and introduces no external identifier collisions, THE spec-check tool SHALL replace the matched base requirement block and all of its nested scenarios with the delta requirement block in the original base position.

**Postcondition:** The merged capability contains only the modified requirement-block version for that identifier.

##### Evidence
- Implementation: [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296)
- Test: [merge.test.ts:76 applies REMOVED then MODIFIED then ADDED deterministically](/test/contract/merge.test.ts#L76)
- Test (integration): [merge-liveness.integration.test.ts:181 routes only active merged requirements to logic inputs (removed excluded, modified retained)](/test/integration/merge-liveness.integration.test.ts#L181)

#### Scenario: Removed Requirement Deletes Base Block [MCA-DELTA-REM]
WHEN a `REMOVED` requirement block matches a surviving base requirement by canonical identifier, THE spec-check tool SHALL remove that base requirement block and all of its nested scenarios from the merged capability view.

**Postcondition:** Removed behavior no longer participates in downstream specs-forward analysis.

##### Evidence
- Implementation: [merge.ts:244 applyRemoved()](/src/domain/parser/merge.ts#L244)
- Test: [merge.test.ts:76 applies REMOVED then MODIFIED then ADDED deterministically](/test/contract/merge.test.ts#L76)
- Test (integration): [merge-liveness.integration.test.ts:181 routes only active merged requirements to logic inputs (removed excluded, modified retained)](/test/integration/merge-liveness.integration.test.ts#L181)

#### Scenario: Collision Checking Uses Projected Final State [MCA-DELTA-SURVIVING]
WHEN the merge layer checks whether an `ADDED` or `MODIFIED` requirement block would introduce an identifier collision, THE spec-check tool SHALL check against the projected final state, defined as the base requirement set after all `REMOVED` deletions and all `MODIFIED` replacements have been applied.

**Postcondition:** An ADDED block does not collide with a requirement that has already been removed or replaced.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296), [merge.ts:357 applyAdded()](/src/domain/parser/merge.ts#L357)
- Test: [merge.test.ts:120 surfaces ADDED collisions in requirement and scenario namespaces](/test/contract/merge.test.ts#L120)

#### Scenario: Requirement And Scenario Collision Namespaces Remain Separate [MCA-DELTA-NAMESPACE]
WHEN the merge layer checks for duplicate identifiers introduced by delta application, THE spec-check tool SHALL treat requirement identifiers and scenario identifiers as separate canonical namespaces.

**Postcondition:** A requirement identifier does not collide with a scenario identifier merely because their text matches.

##### Evidence
- Implementation: [merge.ts:281 buildNamespaceSets()](/src/domain/parser/merge.ts#L281), [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296), [merge.ts:357 applyAdded()](/src/domain/parser/merge.ts#L357)
- Test: [merge.test.ts:120 surfaces ADDED collisions in requirement and scenario namespaces](/test/contract/merge.test.ts#L120)

#### Scenario: Modified Replacement Collision Preserves Prior Valid State [MCA-DELTA-MOD-COLLISION]
IF a `MODIFIED` replacement would introduce a requirement or scenario identifier collision outside the matched base block, THEN THE spec-check tool SHALL emit `spec_merge.duplicate_modified_identifier`, SHALL skip the replacement, and SHALL preserve the original matched base block unchanged.

**Postcondition:** The merged capability remains deterministic and collision-free without silently discarding base behavior.

##### Evidence
- Implementation: [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296)
- Test: [merge.test.ts:196 skips modified replacement when it introduces external collisions](/test/contract/merge.test.ts#L196)

#### Requirement model

```alloy
// --- Delta semantics: deterministic application order ---
// Application order: REMOVED first, MODIFIED second, ADDED last.
// Identifier collision checking uses the projected final state (post-remove, post-modify).

// The projected surviving base after removals
fun survivingAfterRemoval [mc : MergedCapability] : set Requirement {
  let baseReqs = mc.cap.finalized.requirements |
  let removedIds = { i : Identifier |
    some r : mc.cap.delta.requirements |
      r.deltaOp = Removed and r.identifier = i and some i } |
  { r : baseReqs | r.identifier not in removedIds or no r.identifier }
}

// The projected state after removals and modifications
fun projectedFinalState [mc : MergedCapability] : set Requirement {
  let surviving = survivingAfterRemoval[mc] |
  let modifiedIds = { i : Identifier |
    some r : mc.cap.delta.requirements |
      r.deltaOp = Modified and r.identifier = i and some i } |
  // Replace matched base reqs with their modified versions
  (surviving - { r : surviving | r.identifier in modifiedIds and some r.identifier })
  + { r : mc.cap.delta.requirements |
      r.deltaOp = Modified and r.identifier in (surviving.identifier & modifiedIds) }
}

// Surviving requirement identifiers in the given namespace after full application
fun survivingReqIds [mc : MergedCapability] : set Identifier {
  projectedFinalState[mc].identifier
}

// Surviving scenario identifiers after full application
fun survivingScenIds [mc : MergedCapability] : set Identifier {
  projectedFinalState[mc].scenarios.scenarioId
}

// Event: apply REMOVED operation (first phase)
pred applyRemoved [mc : MergedCapability, r : Requirement] {
  // Guard: r is in delta with Removed op and has identifier matching a base req
  r in mc.cap.delta.requirements
  r.deltaOp = Removed
  some r.identifier
  some baseTarget : mc.cap.finalized.requirements |
    baseTarget.identifier = r.identifier
  // Postcondition: matched base block and its scenarios excluded from output
  no baseTarget : mc.mergedReqs | baseTarget.identifier = r.identifier
    and baseTarget in mc.cap.finalized.requirements
}

// Event: apply MODIFIED operation (second phase)
pred applyModified [mc : MergedCapability, r : Requirement] {
  // Guard: r is in delta with Modified op, has id, matches surviving base req
  r in mc.cap.delta.requirements
  r.deltaOp = Modified
  some r.identifier
  r.identifier in survivingAfterRemoval[mc].identifier
  // Collision check: new scenario identifiers from r don't collide in projected state
  // (the requirement identifier itself replaces the matched block, so it is non-colliding)
  let externalScenIds = survivingScenIds[mc] -
    { i : Identifier | some s : Scenario |
      s in (survivingAfterRemoval[mc] & { req : Requirement | req.identifier = r.identifier }).scenarios
      and s.scenarioId = i } |
  {
    // No collision: r's scenario ids don't overlap external surviving scenario ids
    no (r.scenarios.scenarioId & externalScenIds)
    // Postcondition: modified block replaces base block at same position
    r in mc.mergedReqs
  }
}

// Event: apply ADDED operation (third phase)
pred applyAdded [mc : MergedCapability, r : Requirement] {
  // Guard: r is in delta with Added op
  r in mc.cap.delta.requirements
  r.deltaOp = Added
  // Collision check against projected final state namespaces
  no (r.identifier & survivingReqIds[mc])
  no (r.scenarios.scenarioId & survivingScenIds[mc])
  // Postcondition: appended to merged output
  r in mc.mergedReqs
}

// Failure mode: MODIFIED introduces external collision
pred applyModified_collision [mc : MergedCapability, r : Requirement] {
  // Guard: r is MODIFIED, has id, matches base, but introduces collision
  r in mc.cap.delta.requirements
  r.deltaOp = Modified
  some r.identifier
  r.identifier in survivingAfterRemoval[mc].identifier
  // Collision detected
  some (r.scenarios.scenarioId & survivingScenIds[mc])
    or some (r.identifier & (survivingReqIds[mc] - r.identifier))
  // Effect: finding emitted, base block preserved unchanged
  some f : mc.findings | f.kind = DupModifiedId and f.affectedReq = r
  r not in mc.mergedReqs
  // Original base block IS in merged output (preserved)
  some baseR : mc.cap.finalized.requirements |
    baseR.identifier = r.identifier and baseR in mc.mergedReqs
}

// Namespace separation invariant: req ids and scenario ids never cross-collide
// (structurally enforced by Namespace sig -- req and scen identifiers occupy different fields)
pred namespaces_separate {
  // A requirement identifier collision is checked only against other requirement identifiers
  // A scenario identifier collision is checked only against other scenario identifiers
  all mc : MergedCapability |
    // No requirement has duplicate id in output (within req namespace)
    (all disj r1, r2 : mc.mergedReqs |
      (some r1.identifier and some r2.identifier) implies r1.identifier != r2.identifier)
    and
    // No scenario has duplicate id in output (within scen namespace)
    (all disj s1, s2 : mc.mergedScenarios |
      (some s1.scenarioId and some s2.scenarioId) implies s1.scenarioId != s2.scenarioId)
}

// Safety: removed ops never in output
assert removed_never_in_output {
  all mc : MergedCapability |
    no r : mc.mergedReqs | r.deltaOp = Removed
}

// Safety: no phantom introduction (every merged req comes from input)
assert no_phantom_introduction {
  all mc : MergedCapability, r : mc.mergedReqs |
    r in mc.cap.finalized.requirements + mc.cap.delta.requirements
}

// Safety: modified collision preserves base block
assert collision_preserves_base {
  all mc : MergedCapability, f : mc.findings |
    (f.kind = DupModifiedId and some f.affectedReq and some f.affectedReq.identifier) implies
      (some baseR : mc.cap.finalized.requirements |
        baseR.identifier = f.affectedReq.identifier and baseR in mc.mergedReqs)
}

// Safety: ADDED blocks cannot introduce duplicate surviving identifiers
assert added_no_duplicate_ids {
  all mc : MergedCapability, r : mc.mergedReqs |
    r.deltaOp = Added implies
      (all r2 : mc.mergedReqs - r |
        (some r.identifier and some r2.identifier) implies r.identifier != r2.identifier)
}

// Invariant: determinism -- same inputs produce same merged output
// (modeled structurally: the facts fully determine mergedReqs given cap inputs)
assert deterministic_merge {
  all disj mc1, mc2 : MergedCapability |
    mc1.cap = mc2.cap implies
      (mc1.mergedReqs = mc2.mergedReqs and mc1.findings = mc2.findings)
}

check removed_never_in_output for 6 expect 0
check no_phantom_introduction for 6 expect 0
check collision_preserves_base for 5 expect 0
check added_no_duplicate_ids for 5 expect 0
check deterministic_merge for 5 expect 0

// Scenario: deterministic application order is satisfiable
run delta_application_scenario {
  some c : Capability, mc : MergedCapability |
    some c.finalized and some c.delta and mc.cap = c
    and some r : mc.cap.delta.requirements | r.deltaOp = Removed
    and some r : mc.cap.delta.requirements | r.deltaOp = Modified
    and some r : mc.cap.delta.requirements | r.deltaOp = Added
    and some mc.mergedReqs
} for 5 expect 1
```

### Requirement: Surface Invalid Or Unsupported Delta Content [MCA-MERGE-FIND]
IF a selected delta spec contains malformed, ambiguous, duplicate, or unsupported merge content, THEN THE spec-check tool SHALL emit explicit `spec_merge.*` findings and SHALL skip only the affected merge operation or malformed item.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Findings Catalog`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Failure And Reliability`

#### Scenario: Unsupported Standalone Scenario Surfaced [MCA-MERGE-STANDALONE]
IF a delta section contains a scenario that is not associated with a parsed requirement block, THEN THE spec-check tool SHALL emit `spec_merge.standalone_scenario_unsupported` and SHALL exclude that scenario from the merged capability view.

**Postcondition:** Unsupported scenario-only delta content cannot silently influence downstream analysis.

##### Evidence
- Implementation: [merge.ts:159 partitionDelta()](/src/domain/parser/merge.ts#L159), [merge.ts:414 groupBlocks()](/src/domain/parser/merge.ts#L414)
- Test: [merge.test.ts:175 surfaces standalone scenarios in delta sections](/test/contract/merge.test.ts#L175)
- Test (property): [merge.property.test.ts:122 preserves provenance, avoids silent discard, and emits complete skip findings](/test/property/merge.property.test.ts#L122)

#### Scenario: Pre-Section Delta Content Surfaced [MCA-MERGE-PRE-SECTION]
IF a delta spec contains requirements or scenarios before the first recognized delta section heading, THEN THE spec-check tool SHALL emit `spec_merge.pre_section_content` for each such item and SHALL exclude those items from the merged capability view.

**Postcondition:** Structurally ambiguous delta content is surfaced explicitly rather than guessed at.

##### Evidence
- Implementation: [merge.ts:159 partitionDelta()](/src/domain/parser/merge.ts#L159)
- Test: [merge.test.ts:161 surfaces pre-section content](/test/contract/merge.test.ts#L161)
- Test (integration): [merge-pipeline.integration.test.ts:61 keeps merge findings visible and ordered before downstream findings](/test/integration/merge-pipeline.integration.test.ts#L61)

#### Scenario: Missing Identifier In Modified Or Removed Operation Surfaced [MCA-MERGE-MISSING-ID]
IF a `MODIFIED` or `REMOVED` requirement block lacks a canonical identifier, THEN THE spec-check tool SHALL emit `spec_merge.modified_missing_identifier` or `spec_merge.removed_missing_identifier` respectively and SHALL skip that operation.

**Postcondition:** Identifier-dependent operations do not guess at their targets.

##### Evidence
- Implementation: [merge.ts:244 applyRemoved()](/src/domain/parser/merge.ts#L244), [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296)
- Test: [merge.test.ts:99 surfaces unmatched and missing-id operations with one finding each](/test/contract/merge.test.ts#L99)
- Test (property): [merge.property.test.ts:122 preserves provenance, avoids silent discard, and emits complete skip findings](/test/property/merge.property.test.ts#L122)

#### Scenario: Missing Modification Or Removal Target Surfaced [MCA-MERGE-NO-TARGET]
IF a `MODIFIED` or `REMOVED` requirement block names an identifier that does not match any surviving base requirement block, THEN THE spec-check tool SHALL emit `spec_merge.modified_target_not_found` or `spec_merge.removed_target_not_found` respectively and SHALL skip that operation.

**Postcondition:** Merge failures remain localized and visible without stopping other valid operations.

##### Evidence
- Implementation: [merge.ts:244 applyRemoved()](/src/domain/parser/merge.ts#L244), [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296)
- Test: [merge.test.ts:99 surfaces unmatched and missing-id operations with one finding each](/test/contract/merge.test.ts#L99)
- Test (property): [merge.property.test.ts:122 preserves provenance, avoids silent discard, and emits complete skip findings](/test/property/merge.property.test.ts#L122)

#### Scenario: Duplicate Added Identifier Surfaced [MCA-MERGE-DUP-ADD]
IF an `ADDED` requirement block or one of its nested scenarios would collide with an existing surviving identifier in its namespace, THEN THE spec-check tool SHALL emit `spec_merge.duplicate_added_identifier` with a message that identifies the colliding identifier value and states which namespace (requirement or scenario) the collision occurred in, and SHALL skip that requirement block and its nested scenarios as a unit.

**Postcondition:** Added behavior cannot introduce duplicate surviving identifiers.

##### Evidence
- Implementation: [merge.ts:357 applyAdded()](/src/domain/parser/merge.ts#L357)
- Test: [merge.test.ts:120 surfaces ADDED collisions in requirement and scenario namespaces](/test/contract/merge.test.ts#L120)

#### Scenario: Duplicate Base Identifier Surfaced [MCA-MERGE-DUP-BASE]
IF a finalized base spec contains duplicate canonical requirement identifiers, THEN THE spec-check tool SHALL keep the first occurrence authoritative, SHALL emit `spec_merge.duplicate_base_identifier` for each later occurrence, and SHALL exclude later duplicate blocks from merged output and future matching.

**Postcondition:** Finalized malformed input remains deterministic and analyzable.

##### Evidence
- Implementation: [merge.ts:133 deduplicateBaseBlocks()](/src/domain/parser/merge.ts#L133)
- Test: [merge.test.ts:141 surfaces duplicate base and duplicate delta identifiers](/test/contract/merge.test.ts#L141)

#### Scenario: Duplicate Delta Identifier Group Surfaced [MCA-MERGE-DUP-DELTA]
IF duplicate canonical identifiers appear more than once within the same delta operation section for one capability, THEN THE spec-check tool SHALL emit `spec_merge.duplicate_delta_identifier` for each conflicting block in that duplicate group and SHALL exclude all conflicting blocks in that group from merge application.

**Postcondition:** Competing edits in the same delta section do not force arbitrary merge choices.

##### Evidence
- Implementation: [merge.ts:208 excludeDuplicateDeltaIdentifiers()](/src/domain/parser/merge.ts#L208)
- Test: [merge.test.ts:141 surfaces duplicate base and duplicate delta identifiers](/test/contract/merge.test.ts#L141)

#### Scenario: Rename Blocks Emit One Finding Per Skipped Operation [MCA-MERGE-RENAME]
IF a selected delta spec contains a `RENAMED` requirement block, THEN THE spec-check tool SHALL emit exactly one `spec_merge.rename_unsupported` warning for that skipped requirement block and SHALL leave merged capability content unchanged.

**Postcondition:** Deferred rename semantics are visible without pretending renames were applied, and no skipped `RENAMED` operation is silently discarded.

##### Evidence
- Implementation: [merge.ts:159 partitionDelta()](/src/domain/parser/merge.ts#L159)
- Test: [merge.test.ts:187 warns on finalized delta headings and renamed sections](/test/contract/merge.test.ts#L187), [merge.test.ts:261 emits one finding per RENAMED requirement (D-13 compliance)](/test/contract/merge.test.ts#L261)

#### Scenario: Finalized Delta Headings Warn Once And Are Ignored [MCA-MERGE-FINAL-DELTA]
IF a finalized spec contains one or more delta section headings, THEN THE spec-check tool SHALL emit exactly one `spec_merge.finalized_spec_delta_heading_ignored` warning for that finalized spec file, SHALL include guidance that finalized specs should not have Delta Spec Headings, and SHALL treat all parsed items in that file as base content.

**Postcondition:** Malformed finalized specs do not silently acquire delta semantics.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88)
- Test: [merge.test.ts:187 warns on finalized delta headings and renamed sections](/test/contract/merge.test.ts#L187)

#### Scenario: Empty Merged Capability Is Skipped Downstream [MCA-MERGE-EMPTY]
IF a capability produces zero surviving merged requirements after removals and exclusions, THEN THE spec-check tool SHALL emit `spec_merge.empty_capability_skipped` and SHALL omit that capability from downstream specs-forward claim extraction, logic analysis, and coverage.

**Postcondition:** Vacuous capability groups are not analyzed as if they contained active behavior.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [run-cli.ts:233 runAnalysisPhases()](/src/cli/run-cli.ts#L233), [pipeline-helpers.ts:264 runClaimGraphPhase()](/src/cli/pipeline-helpers.ts#L264)
- Test: [merge.test.ts:215 emits empty capability finding when no surviving requirements remain](/test/contract/merge.test.ts#L215)
- Test (integration): [merge-liveness.integration.test.ts:85 processes each non-empty merged capability exactly once across downstream phases](/test/integration/merge-liveness.integration.test.ts#L85)

#### Requirement model

```alloy
// --- Failure modes: finding emission event predicates ---
// Each failure mode is modeled as a guarded event that emits a finding and skips
// the affected item. The frame condition ensures other merge operations proceed.

// Failure mode: standalone scenario in delta (no parent requirement)
pred emit_standalone_scenario [mc : MergedCapability, s : Scenario] {
  // Guard: scenario has no parent requirement and is in delta input
  no s.parentReq
  s.scenSourceFile = mc.cap.delta.source
  // Effect: finding emitted, scenario excluded from merged output
  some f : mc.findings | f.kind = StandaloneScenario and f.affectedScen = s
  s not in mc.mergedScenarios
}

// Failure mode: pre-section content in delta
pred emit_pre_section_content [mc : MergedCapability, r : Requirement] {
  // Guard: requirement has PreSection delta op
  r in mc.cap.delta.requirements
  r.deltaOp = PreSection
  // Effect: finding emitted, requirement excluded
  some f : mc.findings | f.kind = PreSectionContent and f.affectedReq = r
  r not in mc.mergedReqs
}

// Failure mode: MODIFIED or REMOVED with missing identifier
pred emit_missing_identifier_modified [mc : MergedCapability, r : Requirement] {
  // Guard: MODIFIED requirement without identifier
  r in mc.cap.delta.requirements
  r.deltaOp = Modified
  no r.identifier
  // Effect: finding emitted, operation skipped
  some f : mc.findings | f.kind = ModMissingId and f.affectedReq = r
  r not in mc.mergedReqs
}

pred emit_missing_identifier_removed [mc : MergedCapability, r : Requirement] {
  // Guard: REMOVED requirement without identifier
  r in mc.cap.delta.requirements
  r.deltaOp = Removed
  no r.identifier
  // Effect: finding emitted, operation skipped
  some f : mc.findings | f.kind = RemMissingId and f.affectedReq = r
  r not in mc.mergedReqs
}

// Failure mode: MODIFIED or REMOVED target not found in surviving base
pred emit_target_not_found_modified [mc : MergedCapability, r : Requirement] {
  // Guard: MODIFIED with identifier that has no matching base requirement
  r in mc.cap.delta.requirements
  r.deltaOp = Modified
  some r.identifier
  r.identifier not in survivingAfterRemoval[mc].identifier
  // Effect: finding emitted, operation skipped
  some f : mc.findings | f.kind = ModNotFound and f.affectedReq = r
  r not in mc.mergedReqs
}

pred emit_target_not_found_removed [mc : MergedCapability, r : Requirement] {
  // Guard: REMOVED with identifier that has no matching base requirement
  r in mc.cap.delta.requirements
  r.deltaOp = Removed
  some r.identifier
  r.identifier not in mc.cap.finalized.requirements.identifier
  // Effect: finding emitted, operation skipped
  some f : mc.findings | f.kind = RemNotFound and f.affectedReq = r
}

// Failure mode: ADDED introduces duplicate identifier
pred emit_duplicate_added [mc : MergedCapability, r : Requirement] {
  // Guard: ADDED block collides with surviving id in its namespace
  r in mc.cap.delta.requirements
  r.deltaOp = Added
  (some (r.identifier & survivingReqIds[mc]))
    or (some (r.scenarios.scenarioId & survivingScenIds[mc]))
  // Effect: finding emitted (identifies colliding id and namespace), block + scenarios skipped
  some f : mc.findings | f.kind = DupAdded and f.affectedReq = r
  r not in mc.mergedReqs
  r.scenarios not in mc.mergedScenarios
}

// Failure mode: duplicate base identifier (first-occurrence wins)
pred emit_duplicate_base [mc : MergedCapability, r : Requirement] {
  // Guard: r is a later occurrence of a duplicated identifier in finalized spec
  r in mc.cap.finalized.requirements
  some r.identifier
  some r2 : mc.cap.finalized.requirements - r |
    r2.identifier = r.identifier
    // r2 is "earlier" (first occurrence is authoritative; modeled as: r2 in mergedReqs, r is not)
  // Effect: finding emitted, later block excluded from output and matching
  some f : mc.findings | f.kind = DupBase and f.affectedReq = r
  r not in mc.mergedReqs
}

// Failure mode: duplicate delta identifier group
pred emit_duplicate_delta [mc : MergedCapability, r : Requirement] {
  // Guard: r shares identifier+deltaOp with another delta req in same section
  r in mc.cap.delta.requirements
  some r.identifier
  some r2 : mc.cap.delta.requirements - r |
    r2.identifier = r.identifier and r2.deltaOp = r.deltaOp
  // Effect: finding emitted for each conflicting block, all excluded
  some f : mc.findings | f.kind = DupDelta and f.affectedReq = r
  r not in mc.mergedReqs
}

// Failure mode: RENAMED block (unsupported operation)
pred emit_rename_unsupported [mc : MergedCapability, r : Requirement] {
  // Guard: requirement has Renamed delta op
  r in mc.cap.delta.requirements
  r.deltaOp = Renamed
  // Effect: exactly one finding per renamed block, merged content unchanged
  one f : mc.findings | f.kind = RenameUnsupported and f.affectedReq = r
  r not in mc.mergedReqs
}

// Failure mode: finalized spec has delta headings (warn once, treat as base)
pred emit_finalized_delta_heading [mc : MergedCapability] {
  // Guard: finalized spec has delta section headings
  some mc.cap.finalized
  some (mc.cap.finalized.deltaSections - Base)
  // Effect: exactly one warning per finalized spec file
  one f : mc.findings | f.kind = FinalizedDeltaHeadingIgnored
  // All items in finalized treated as Base (enforced by baseItemsHaveBaseOp fact)
}

// Failure mode: empty merged capability
pred emit_empty_cap_skipped [mc : MergedCapability] {
  // Guard: no surviving requirements after all operations
  no mc.mergedReqs
  some mc.cap.(finalized + delta).requirements
  // Effect: finding emitted, capability omitted from downstream
  some f : mc.findings | f.kind = EmptyCapSkipped
  mc not in PipelineState.processedCaps
}

// --- Safety assertions for failure modes ---

// Safety: every skipped operation has exactly one corresponding finding
assert every_skip_has_finding {
  all mc : MergedCapability, r : mc.cap.delta.requirements |
    (r.deltaOp in (Modified + Removed + Added + Renamed + PreSection)
     and r not in mc.mergedReqs)
    implies some f : mc.findings | f.affectedReq = r
}

// Safety: standalone scenarios never in merged output
assert standalone_never_in_output {
  all mc : MergedCapability, s : Scenario |
    (no s.parentReq and s.scenSourceFile = mc.cap.delta.source)
    implies s not in mc.mergedScenarios
}

// Safety: pre-section content never in merged output
assert pre_section_never_in_output {
  all mc : MergedCapability |
    no r : mc.mergedReqs | r.deltaOp = PreSection
}

// Safety: renamed blocks never in merged output
assert renamed_never_in_output {
  all mc : MergedCapability |
    no r : mc.mergedReqs | r.deltaOp = Renamed
}

// Safety: duplicate base -- only first occurrence is authoritative
assert first_occurrence_wins {
  all mc : MergedCapability, disj r1, r2 : mc.cap.finalized.requirements |
    (some r1.identifier and r1.identifier = r2.identifier)
    implies not (r1 in mc.mergedReqs and r2 in mc.mergedReqs)
}

// Safety: empty capabilities never reach downstream
assert empty_caps_never_processed {
  all mc : MergedCapability |
    no mc.mergedReqs implies mc not in PipelineState.processedCaps
}

// Safety: failures are localized (other valid operations still apply)
assert failure_localization {
  all mc : MergedCapability |
    (some f : mc.findings | f.kind in (ModNotFound + RemNotFound + ModMissingId + RemMissingId))
    implies
      // Other valid operations can still produce merged output
      (all r : mc.cap.delta.requirements |
        (r.deltaOp = Added
         and (no r.identifier or r.identifier not in (mc.mergedReqs - r).identifier)
         and no (r.scenarios.scenarioId & (mc.mergedScenarios - r.scenarios).scenarioId))
        implies r in mc.mergedReqs)
}

check every_skip_has_finding for 5 expect 0
check standalone_never_in_output for 5 expect 0
check pre_section_never_in_output for 6 expect 0
check renamed_never_in_output for 6 expect 0
check first_occurrence_wins for 5 expect 0
check empty_caps_never_processed for 5 expect 0
check failure_localization for 4 expect 0

// Scenario: failure modes are satisfiable
run failure_mode_scenario {
  some mc : MergedCapability |
    some f : mc.findings | f.kind = ModNotFound
    and some r : mc.mergedReqs | r.deltaOp = Added
} for 4 expect 1
```

### Requirement: Preserve Source Provenance In Merged Output [MCA-MERGE-PROVEN]
WHEN the spec-check tool emits merged requirements, merged scenarios, and derived claims from a merged capability view, THE spec-check tool SHALL preserve the original source-file provenance on each contributing item and SHALL use a separate synthetic merged capability key only for grouping and artifact naming.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#System Invariant Tactics`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Artifact-Key Contract`

#### Scenario: Source Provenance Survives Merge [MCA-MERGE-SOURCE]
WHEN a merged requirement or scenario originates from either the finalized spec or the selected delta spec, THE spec-check tool SHALL preserve that item's original source file and line provenance in the merged output and any derived claim.

**Postcondition:** Reviewers can trace merged analysis results back to the original contributing file.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [claim-graph.ts:247 extractMergedSpecClaims()](/src/domain/claim-graph.ts#L247)
- Test: [merge.test.ts:290 preserves provenance and does not remove base blocks without explicit cause](/test/contract/merge.test.ts#L290)
- Test (property): [merge.property.test.ts:122 preserves provenance, avoids silent discard, and emits complete skip findings](/test/property/merge.property.test.ts#L122)

#### Scenario: Synthetic Logical Key Groups Capability Artifacts [MCA-MERGE-LOGICAL]
WHEN the spec-check tool persists specs-forward solver artifacts or report headings for a merged capability, THE spec-check tool SHALL use the deterministic synthetic merged capability key `<merged-spec/{capability}>` rather than a real filesystem source path.

**Postcondition:** Capability-scoped artifacts remain distinct from source-file provenance.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [pipeline-helpers.ts:345 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L345), [pipeline-helpers.ts:403 sanitizeLogicalFileForArtifacts()](/src/cli/pipeline-helpers.ts#L403)
- Test: [merge-logic-routing.test.ts:57 writes logic artifacts under synthetic merged logicalFile artifact key](/test/contract/merge-logic-routing.test.ts#L57)
- Test (integration): [merge-liveness.integration.test.ts:85 processes each non-empty merged capability exactly once across downstream phases](/test/integration/merge-liveness.integration.test.ts#L85)

#### Scenario: Merged Output Ordering Is Deterministic [MCA-MERGE-ORDER]
WHEN the same finalized and delta inputs are merged on separate runs, THE spec-check tool SHALL produce the same requirement order, scenario order, capability order, findings, and logical grouping identity on each run.

**Postcondition:** Merge output is a deterministic function of input specs and catalog selection.

##### Evidence
- Implementation: [merge.ts:24 mergeSpecsByCapability()](/src/domain/parser/merge.ts#L24), [merge.ts:414 groupBlocks()](/src/domain/parser/merge.ts#L414), [pipeline-helpers.ts:345 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L345)
- Test: [merge.test.ts:76 applies REMOVED then MODIFIED then ADDED deterministically](/test/contract/merge.test.ts#L76), [merge.test.ts:277 is deterministic across repeated runs](/test/contract/merge.test.ts#L277), [merge.determinism.test.ts:20 is byte-for-byte deterministic across repeated invocations](/test/determinism/merge.determinism.test.ts#L20)
- Test (property): [merge.property.test.ts:60 random valid inputs are deterministic across 3 runs](/test/property/merge.property.test.ts#L60)

#### Requirement model

```alloy
// --- Provenance preservation and artifact-key contract ---
// Source provenance (physical file) is distinct from logical key (synthetic grouping).
// The merge function preserves source provenance on every merged item while using
// a separate synthetic key for downstream artifact naming.

// Postcondition: every merged requirement retains its original source file
pred provenance_preserved {
  all mc : MergedCapability, r : mc.mergedReqs |
    r.sourceFile in (mc.cap.finalized.source + mc.cap.delta.source)
}

// Postcondition: every merged scenario retains its original source file
pred scenario_provenance_preserved {
  all mc : MergedCapability, s : mc.mergedScenarios |
    s.scenSourceFile in (mc.cap.finalized.source + mc.cap.delta.source)
}

// Invariant: logical key is structurally distinct from source file
// (LogicalKey and SourceFile are separate sigs in Alloy -- type disjointness is guaranteed)

// Invariant: each capability gets a unique logical key for artifacts
pred unique_logical_keys {
  all disj mc1, mc2 : MergedCapability |
    mc1.logicalKey != mc2.logicalKey
}

// Invariant: determinism -- same inputs produce identical output
// Merge is a pure function: identical (finalized, delta) pairs yield byte-for-byte same result
pred merge_is_deterministic {
  all disj mc1, mc2 : MergedCapability |
    mc1.cap = mc2.cap implies (
      mc1.mergedReqs = mc2.mergedReqs
      and mc1.mergedScenarios = mc2.mergedScenarios
      and mc1.findings = mc2.findings
      and mc1.logicalKey = mc2.logicalKey
    )
}

// Safety: provenance is never lost during merge
assert provenance_integrity {
  provenance_preserved
  scenario_provenance_preserved
}

// Safety: logical key never collides with source provenance
// (structural: LogicalKey and SourceFile are separate sigs)
assert logical_key_separation {
  unique_logical_keys
}

// Safety: provenance of findings also traces to input files
assert finding_provenance {
  all mc : MergedCapability, f : mc.findings |
    some f.affectedReq implies
      f.affectedReq.sourceFile in (mc.cap.finalized.source + mc.cap.delta.source)
}

// Safety: merged output is a deterministic function of inputs
assert output_determinism {
  merge_is_deterministic
}

check provenance_integrity for 6 expect 0
check logical_key_separation for 6 expect 0
check finding_provenance for 5 expect 0
check output_determinism for 5 expect 0

// Scenario: provenance survives merge with both finalized and delta sources
run provenance_scenario {
  some mc : MergedCapability |
    some mc.cap.finalized and some mc.cap.delta
    and some r1 : mc.mergedReqs | r1.sourceFile = mc.cap.finalized.source
    and some r2 : mc.mergedReqs | r2.sourceFile = mc.cap.delta.source
} for 4 expect 1
```

### Requirement: Ensure All Non-Empty Merged Capabilities Reach Downstream Phases [MCA-LIVENESS]
WHEN the spec-check tool completes capability merging and at least one merged capability contains surviving requirements, THE spec-check tool SHALL submit every non-empty merged capability to downstream specs-forward claim extraction, coverage analysis, and logical analysis exactly once.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Merge Contract`

#### Scenario: Non-Empty Merged Capability Is Analyzed [MCA-LIVENESS-NONEMPTY]
WHEN a merged capability contains at least one surviving requirement after merge application, THE spec-check tool SHALL include that capability in downstream specs-forward claim extraction, coverage analysis, and logical analysis.

**Postcondition:** No non-empty merged capability is silently omitted from downstream processing.

##### Evidence
- Implementation: [pipeline-helpers.ts:264 runClaimGraphPhase()](/src/cli/pipeline-helpers.ts#L264), [run-cli.ts:233 runAnalysisPhases()](/src/cli/run-cli.ts#L233), [pipeline-helpers.ts:345 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L345)
- Test (integration): [merge-liveness.integration.test.ts:85 processes each non-empty merged capability exactly once across downstream phases](/test/integration/merge-liveness.integration.test.ts#L85)

#### Scenario: Merge Precondition Assertion Catches Internal Errors [MCA-LIVENESS-ASSERT]
IF `mergeSpecsByCapability()` receives input that violates its precondition (more than one delta per capability), THEN THE spec-check tool SHALL raise a fatal pipeline exception rather than producing undefined merge behavior.

**Postcondition:** Precondition violations are caught at the merge entry point and do not propagate as silent correctness failures.

##### Evidence
- Implementation: [merge.ts:24 mergeSpecsByCapability()](/src/domain/parser/merge.ts#L24), [assert.ts:42 precondition()](/src/domain/assert.ts#L42)
- Example:
```typescript
const { toCapabilityName } = await import("./src/domain/branded.ts");
const { mergeSpecsByCapability } = await import("./src/domain/parser/merge.ts");
const docs = [
  { path: "delta-a.md", type: "spec", source: "delta", capability: toCapabilityName("cap-a") },
  { path: "delta-b.md", type: "spec", source: "delta", capability: toCapabilityName("cap-a") },
];
const parsedSpecs = [
  { file: "delta-a.md", requirements: [], scenarios: [], deltaSections: [], structuralFindings: [], unparsed: [] },
  { file: "delta-b.md", requirements: [], scenarios: [], deltaSections: [], structuralFindings: [], unparsed: [] },
];
mergeSpecsByCapability(docs, parsedSpecs); //=> throws Error
```

#### Requirement model

```alloy
// --- Liveness: all non-empty merged capabilities reach downstream ---
// Uses temporal operators to model pipeline phase progression.
// The merge phase is a synchronous step; liveness means every non-empty
// merged capability eventually reaches claim extraction, coverage, and logic phases.

// Event: begin merge phase from initial state
pred start_merge {
  // Guard: pipeline is idle
  PipelineState.currentPhase = Idle
  // Effect: transition to Merging, synchronously complete all merges
  PipelineState.currentPhase' = Merging
  PipelineState.mergeComplete' = MergedCapability
  PipelineState.processedCaps' = PipelineState.processedCaps
}

// Event: complete merge phase and advance to downstream
pred complete_merge_phase {
  // Guard: currently in Merging phase, all capabilities have been merged
  PipelineState.currentPhase = Merging
  PipelineState.mergeComplete = MergedCapability
  // Effect: advance to ClaimExtraction, submit non-empty caps
  PipelineState.currentPhase' = ClaimExtraction
  PipelineState.processedCaps' = { mc : MergedCapability | some mc.mergedReqs }
  PipelineState.mergeComplete' = PipelineState.mergeComplete
}

// Event: batch claim extraction (all submitted capabilities processed together)
pred process_all_claims {
  PipelineState.currentPhase = ClaimExtraction
  PipelineState.currentPhase' = CoverageAnalysis
  PipelineState.processedCaps' = PipelineState.processedCaps
  PipelineState.mergeComplete' = PipelineState.mergeComplete
}

// Event: batch coverage analysis
pred process_all_coverage {
  PipelineState.currentPhase = CoverageAnalysis
  PipelineState.currentPhase' = LogicAnalysis
  PipelineState.processedCaps' = PipelineState.processedCaps
  PipelineState.mergeComplete' = PipelineState.mergeComplete
}

// Event: batch logic analysis
pred process_all_logic {
  PipelineState.currentPhase = LogicAnalysis
  PipelineState.currentPhase' = Complete
  PipelineState.processedCaps' = PipelineState.processedCaps
  PipelineState.mergeComplete' = PipelineState.mergeComplete
}

// Stuttering (no progress)
pred stutter {
  PipelineState.currentPhase' = PipelineState.currentPhase
  PipelineState.processedCaps' = PipelineState.processedCaps
  PipelineState.mergeComplete' = PipelineState.mergeComplete
}

// Transition system
fact transitions {
  init_state and always (
    start_merge
    or complete_merge_phase
    or process_all_claims
    or process_all_coverage
    or process_all_logic
    or stutter
  )
}

// --- Liveness property ---

// Fairness: if a transition is always eventually enabled, it eventually fires
pred fairness {
  // If idle, start_merge fires
  (eventually always (PipelineState.currentPhase = Idle))
    implies (always eventually start_merge)
  // If merge is complete, downstream processing fires
  (eventually always (PipelineState.currentPhase = Merging
                      and PipelineState.mergeComplete = MergedCapability))
    implies (always eventually complete_merge_phase)
  // Downstream batch phases eventually fire
  (eventually always (PipelineState.currentPhase = ClaimExtraction))
    implies (always eventually process_all_claims)
  (eventually always (PipelineState.currentPhase = CoverageAnalysis))
    implies (always eventually process_all_coverage)
  (eventually always (PipelineState.currentPhase = LogicAnalysis))
    implies (always eventually process_all_logic)
}

// Liveness: every non-empty merged capability eventually reaches Complete phase
assert all_nonempty_caps_reach_downstream {
  fairness implies
    (some MergedCapability implies eventually PipelineState.currentPhase = Complete)
}

// Liveness: no non-empty capability is silently omitted
assert no_silent_omission {
  fairness implies always (
    PipelineState.currentPhase = ClaimExtraction implies
      (all mc : MergedCapability |
        some mc.mergedReqs implies mc in PipelineState.processedCaps)
  )
}

// Safety: empty capabilities never reach downstream processing
assert empty_never_processed {
  always (all mc : MergedCapability |
    no mc.mergedReqs implies mc not in PipelineState.processedCaps)
}

// Safety: each non-empty cap is processed exactly once (no double-processing)
assert exactly_once_processing {
  always (all mc : PipelineState.processedCaps |
    one mc2 : PipelineState.processedCaps | mc2.cap = mc.cap)
}

// Safety: precondition violation is structurally impossible
// (fact atMostOneDelta prevents >1 delta; if violated, no valid instance exists)
assert precondition_structurally_enforced {
  all c : Capability | lone c.delta
}

check all_nonempty_caps_reach_downstream for 3 but 15 steps expect 0
check no_silent_omission for 3 but 15 steps expect 0
check empty_never_processed for 4 but 10 steps expect 0
check exactly_once_processing for 4 but 10 steps expect 0
check precondition_structurally_enforced for 6 expect 0

// Scenario: non-empty capability reaches Complete phase
run liveness_scenario {
  some mc : MergedCapability |
    some mc.mergedReqs
    and eventually (PipelineState.currentPhase = Complete
                    and mc in PipelineState.processedCaps)
} for 2 but 10 steps expect 1

// Scenario: pipeline with empty capability skips it
run empty_cap_skipped_scenario {
  some mc : MergedCapability |
    no mc.mergedReqs
    and eventually (PipelineState.currentPhase = Complete)
    and always (mc not in PipelineState.processedCaps)
} for 3 but 12 steps expect 1

// Sanity: the transition system is satisfiable
run pipeline_sanity {} for 3 but 10 steps expect 1
```
