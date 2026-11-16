---
title: MergedCapabilityAnalysis
---

## Purpose

Define the per-capability merge behavior for the spec-check tool: combining finalized capability specs with selected delta specs into one deterministic active merged capability view that downstream specs-forward analysis consumes.

All Alloy fences below form one Alloy 6 module in document order. Source bytes, lexical correctness, OS effects, and concrete serialization are explicit implementation-test boundaries; the model checks relational preservation and analyzer control. Execution witnesses and temporal regressions explicitly use `execution`; no global fact forces initialization. This permits independent namespace induction over arbitrary current/next states. Safety assertions permit stuttering. Liveness is conditional on the stated action scheduling and resource premises.

```alloy
module MergedCapabilityAnalysis
open util/boolean

// --- Domain vocabulary: ordered requirement blocks and owned scenarios ---
sig Capability { logicalFile : one LogicalKey, selectedDeltas : set DeltaFile }
sig DeltaFile {}
sig LogicalKey { sanitized : one ArtifactKey, nonempty : one Bool }
sig ArtifactKey {}
sig Identifier {}
sig SourceFile {}
sig Payload {} // immutable spans, clauses, dispositions and supporting content
abstract sig Operation {}
one sig Base, Removed, Modified, Added, PreSection, Renamed extends Operation {}
sig Block {
  prior : set Block,
  cap : one Capability, op : one Operation, identifier : lone Identifier,
  file : one SourceFile, payload : one Payload,
  scenarios : set Scenario, headedDeltaInFinal : one Bool,
  formallyEligible : one Bool
}
sig Scenario { parent : one Block, identifier : lone Identifier, file : one SourceFile, payload : one Payload, formallyEligible : one Bool }
fact source_ownership {
  no iden & ^prior
  prior.prior in prior
  all disj a,b : Block | a in b.prior or b in a.prior
  all b : Block | b.scenarios = parent.b
  all s : Scenario | s.file = s.parent.file
  all disj c, d : Capability | c.logicalFile != d.logicalFile
}
abstract sig FindingKind {}
one sig DuplicateBase, DuplicateDelta, MissingId, MissingTarget, Collision,
  PreSectionContent, RenameUnsupported extends FindingKind {}
abstract sig Stage {}
one sig Idle, RemoveStage, ModifyStage, AddStage, Handoff, Complete, Aborted extends Stage {}
one sig Run {
  var stage : one Stage,
  var working : set Block,
  var handled : set Block,
  var applied : set Block,
  var rejected : Block -> lone FindingKind,
  var extracted : set Capability,
  var covered : set Capability,
  var analyzed : set Capability,
  var solverSubmitted : set Capability
}
// Compile labels are separate from authored requirement identifiers.
sig Claim { block : one Block, sourceScenario : lone Scenario, rawLabel : one Identifier, sanitizedLabel : one Identifier, payload : one Payload }
fact claim_source {
  all q : Claim | {
    some q.sourceScenario implies q.sourceScenario.parent = q.block
    q.payload = (some q.sourceScenario => q.sourceScenario.payload else q.block.payload)
  }
}
pred claim_eligible[q : Claim] {
  (no q.sourceScenario and q.block.formallyEligible = True) or
    (some q.sourceScenario and q.sourceScenario.formallyEligible = True)
}
one sig Faults { internalError : one Bool }
fun earlier[b : Block] : set Block { b.prior }
fun bases : set Block { { b : Block | b.op = Base } }
pred later_base_duplicate[b : Block] {
  b.op = Base and some b.identifier
  some p : earlier[b] & bases | p.cap = b.cap and p.identifier = b.identifier
}
fun authoritative_base : set Block { { b : bases | not later_base_duplicate[b] } }
pred delta_duplicate[b : Block] {
  b.op in Removed + Modified + Added and some b.identifier
  some p : Block - b | p.cap = b.cap and p.op = b.op and p.identifier = b.identifier
}
fun targets[b : Block] : set Block {
  { p : Run.working | p.cap = b.cap and some b.identifier and p.identifier = b.identifier }
}
pred external_collision[b : Block] {
  let external = { p : Run.working - targets[b] | p.cap = b.cap } |
    some b.identifier & external.identifier or
    some b.scenarios.identifier & external.scenarios.identifier
}
fun failure[b : Block] : lone FindingKind {
  b.op = PreSection => PreSectionContent else
  (b.op = Renamed => RenameUnsupported else
  (delta_duplicate[b] => DuplicateDelta else
  (b.op in Removed + Modified and no b.identifier => MissingId else
  (b.op in Removed + Modified and no targets[b] => MissingTarget else
  (b.op = Modified and external_collision[b] => Collision else
  (b.op = Added and (some { p : Run.working | p.cap = b.cap and some b.identifier and p.identifier = b.identifier }
    or some b.scenarios.identifier & { p : Run.working | p.cap = b.cap }.scenarios.identifier) => Collision else none))))))
}
fun active_caps : set Capability { Run.working.cap }
fun active_scenarios : set Scenario { Run.working.scenarios }
fun empty_caps : set Capability { Capability - active_caps }
fun compile_group[c : Capability] : set Claim { { q : Claim | q.block in Run.working and q.block.cap = c and claim_eligible[q] } }
pred claim_group_valid[c : Capability] {
  all disj a, b : compile_group[c] | a.rawLabel != b.rawLabel and a.sanitizedLabel != b.sanitizedLabel
}
pred abort_enabled {
  Faults.internalError = True or
  some c : Capability | #c.selectedDeltas > 1 or c.logicalFile.nonempty = False or
    (some d : Capability - c | c.logicalFile.sanitized = d.logicalFile.sanitized)
}
fun pending : set Block {
  { b : Block - Run.handled | (Run.stage = RemoveStage and b.op = Removed) or
    (Run.stage = ModifyStage and b.op = Modified) or (Run.stage = AddStage and b.op = Added) }
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
- Implementation: [merge.ts:24 mergeSpecsByCapability()](/src/domain/parser/merge.ts#L24), [claim-graph.ts:253 extractMergedSpecClaims()](/src/domain/claim-graph.ts#L253)
- Test: [merge.test.ts:76 applies REMOVED then MODIFIED then ADDED deterministically](/test/contract/merge.test.ts#L76)
- Test (integration): [merge-liveness.integration.test.ts:237 routes only active merged requirements to logic inputs (removed excluded, modified retained)](/test/integration/merge-liveness.integration.test.ts#L237)

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
// Event: initialize the authoritative base and pre-reject unsupported content.
pred start_merge {
  // Guard: selected inputs passed entry-point validation.
  Run.stage = Idle and not abort_enabled
  // Effect: first base occurrence wins; all duplicate delta members are rejected.
  Run.stage' = RemoveStage
  Run.working' = authoritative_base
  Run.handled' = bases + { b : Block | b.op in PreSection + Renamed }
  Run.applied' = none
  Run.rejected' = { b : Block, k : FindingKind |
    (later_base_duplicate[b] and k = DuplicateBase) or
    (b.op = PreSection and k = PreSectionContent) or (b.op = Renamed and k = RenameUnsupported) }
  // Frame: downstream phases cannot precede merge completion.
  no Run.extracted' + Run.covered' + Run.analyzed' + Run.solverSubmitted'
}
// Safety: finalized-only clean blocks pass through without invented exclusions.
assert finalized_only_passthrough {
  execution implies always (Run.stage = Complete and Block = bases implies Run.working = authoritative_base)
}
// Safety: delta-only output consists solely of accepted additions.
assert delta_only_additive {
  execution implies always (no bases implies Run.working.op in Added)
}
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
- Test (integration): [merge-liveness.integration.test.ts:237 routes only active merged requirements to logic inputs (removed excluded, modified retained)](/test/integration/merge-liveness.integration.test.ts#L237)

#### Scenario: Removed Requirement Deletes Base Block [MCA-DELTA-REM]
WHEN a `REMOVED` requirement block matches a surviving base requirement by canonical identifier, THE spec-check tool SHALL remove that base requirement block and all of its nested scenarios from the merged capability view.

**Postcondition:** Removed behavior no longer participates in downstream specs-forward analysis.

##### Evidence
- Implementation: [merge.ts:244 applyRemoved()](/src/domain/parser/merge.ts#L244)
- Test: [merge.test.ts:76 applies REMOVED then MODIFIED then ADDED deterministically](/test/contract/merge.test.ts#L76)
- Test (integration): [merge-liveness.integration.test.ts:237 routes only active merged requirements to logic inputs (removed excluded, modified retained)](/test/integration/merge-liveness.integration.test.ts#L237)

#### Scenario: Collision Checking Uses Projected Final State [MCA-DELTA-SURVIVING]
WHEN the merge layer checks whether an `ADDED` or `MODIFIED` requirement block would introduce an identifier collision, THE spec-check tool SHALL first apply `REMOVED` deletions, SHALL process `MODIFIED` replacements in source order against the current surviving state with the matched block excluded from its own collision check, and SHALL check `ADDED` blocks against the resulting post-modification state and previously accepted additions.

**Postcondition:** An ADDED block does not collide with a requirement that has already been removed or replaced.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296), [merge.ts:357 applyAdded()](/src/domain/parser/merge.ts#L357)

#### Scenario: Requirement And Scenario Collision Namespaces Remain Separate [MCA-DELTA-NAMESPACE]
WHEN the merge layer checks for duplicate identifiers introduced by delta application, THE spec-check tool SHALL treat requirement identifiers and scenario identifiers as separate canonical namespaces.

**Postcondition:** A requirement identifier does not collide with a scenario identifier merely because their text matches.

##### Evidence
- Implementation: [merge.ts:281 buildNamespaceSets()](/src/domain/parser/merge.ts#L281), [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296), [merge.ts:357 applyAdded()](/src/domain/parser/merge.ts#L357)

#### Scenario: Modified Replacement Collision Preserves Prior Valid State [MCA-DELTA-MOD-COLLISION]
IF a `MODIFIED` replacement would introduce a requirement or scenario identifier collision outside the matched base block, THEN THE spec-check tool SHALL emit `spec_merge.duplicate_modified_identifier`, SHALL skip the replacement, and SHALL preserve the original matched base block unchanged.

**Postcondition:** The merged capability remains deterministic and collision-free without silently discarding base behavior.

**Ordering clarification:** A replacement that collides with another block still present at its source-order turn is rejected even if a later replacement would free that identifier. Failed replacements preserve their prior base blocks.

##### Evidence
- Implementation: [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296)
- Test: [merge.test.ts:196 skips modified replacement when it introduces external collisions](/test/contract/merge.test.ts#L196)

#### Requirement model

```alloy
// Event: service the next instruction in source order within its operation stage.
pred apply_next[b : Block] {
  // Guard: removals precede modifications, which precede additions.
  b in pending and no earlier[b] & pending
  // Effect: commit a whole block or preserve the previous valid state on failure.
  Run.handled' = Run.handled + b
  Run.rejected' = Run.rejected + b -> failure[b]
  Run.applied' = Run.applied + (no failure[b] => b else none)
  Run.working' = (some failure[b] => Run.working else
    (b.op = Removed => Run.working - targets[b] else
    (b.op = Modified => Run.working - targets[b] + b else Run.working + b)))
  // Frame: one instruction never advances a downstream phase.
  Run.stage' = Run.stage
  Run.extracted' = Run.extracted
  Run.covered' = Run.covered
  Run.analyzed' = Run.analyzed
  Run.solverSubmitted' = Run.solverSubmitted
}
pred advance_merge {
  Run.stage in RemoveStage + ModifyStage + AddStage and no pending
  Run.stage' = (Run.stage = RemoveStage => ModifyStage else
    (Run.stage = ModifyStage => AddStage else Handoff))
  keep_merge
  keep_downstream
}
// Output positions retain base slots for replacements; additions follow base slots.
// Concrete ordinal serialization is an implementation-test boundary.
fun original_slot[b : Block] : lone Block {
  b.op = Modified => { p : authoritative_base | p.cap = b.cap and p.identifier = b.identifier } else b
}
fun output_before : Block -> Block {
  { a, b : Run.working | a.cap = b.cap and a != b and
    ((a.op != Added and b.op = Added) or
     (a.op = Added and b.op = Added and a in earlier[b]) or
     (a.op != Added and b.op != Added and original_slot[a] in earlier[original_slot[b]])) }
}
// Safety: replacement success removes the old block, while rejection preserves it.
assert modification_atomicity {
  execution implies always (all b : Block | apply_next[b] and b.op = Modified implies
    (some failure[b] => Run.working' = Run.working else no targets[b] & Run.working'))
}
// Safety: source order exposes at most one next instruction in an operation
// stage. This checks operational choice, not uniqueness of output atom names.
assert merge_instruction_choice_unique {
  execution implies always (all disj a,b : pending | not (no earlier[a] & pending and no earlier[b] & pending))
}
// Safety: requirement IDs are unique; deltas introduce no external scenario
// collision. Pre-existing malformed base scenario IDs remain parser scope.
pred namespace_inv {
  all disj a, b : Run.working | a.cap = b.cap and some a.identifier and some b.identifier implies a.identifier != b.identifier
  all disj a, b : active_scenarios | a.parent != b.parent and
    (a.parent.op != Base or b.parent.op != Base) and a.parent.cap = b.parent.cap and
    some a.identifier and some b.identifier implies a.identifier != b.identifier
}
// Safety: short execution regression; independent induction below is the primary
// namespace check and retains the larger structural scope without trace unrolling.
assert namespaces_unique {
  execution implies always namespace_inv
}
pred scenario_input_namespace_valid {
  all b : Block | all disj s,t : b.scenarios | some s.identifier and some t.identifier implies s.identifier != t.identifier
  all disj s,t : authoritative_base.scenarios | s.parent.cap = t.parent.cap and some s.identifier and some t.identifier implies s.identifier != t.identifier
}
pred scenario_namespace_inv {
  all disj s,t : active_scenarios | s.parent.cap = t.parent.cap and
    some s.identifier and some t.identifier implies s.identifier != t.identifier
}
// Safety: short regression for full scenario uniqueness with explicit input validity.
assert valid_scenario_namespaces_preserved {
  execution and scenario_input_namespace_valid implies always scenario_namespace_inv
}
// Safety: initialization establishes namespace health.
assert namespace_initialization {
  init implies namespace_inv
}
// Safety: an arbitrary namespace-valid state is preserved by any permitted step.
// There is deliberately no execution/init premise restricting the current state.
assert namespace_preservation {
  namespace_inv and next_step implies after namespace_inv
}
// Safety: full scenario uniqueness is established for well-formed source namespaces.
assert scenario_namespace_initialization {
  scenario_input_namespace_valid and init implies scenario_namespace_inv
}
// Safety: full scenario uniqueness is preserved with the same explicit input premise.
assert scenario_namespace_preservation {
  scenario_input_namespace_valid and scenario_namespace_inv and next_step
    implies after scenario_namespace_inv
}
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
- Test (integration): [merge-pipeline.integration.test.ts:136 keeps merge findings visible and ordered before downstream findings](/test/integration/merge-pipeline.integration.test.ts#L136)

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
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [run-cli.ts:388 runAnalysisPhases()](/src/cli/run-cli.ts#L388), [pipeline-helpers.ts:270 runClaimGraphPhase()](/src/cli/pipeline-helpers.ts#L270)
- Test: [merge.test.ts:215 emits empty capability finding when no surviving requirements remain](/test/contract/merge.test.ts#L215)
- Test (integration): [merge-liveness.integration.test.ts:135 processes each non-empty merged capability exactly once across downstream phases](/test/integration/merge-liveness.integration.test.ts#L135)

#### Requirement model

```alloy
// Safety: every handled rejected instruction has one attributed reason.
assert every_skip_has_finding {
  execution implies always (all b : Run.handled - bases | b not in Run.applied implies one b.(Run.rejected))
}
// Derived skip evidence is capability-local; successful REMOVED instructions are
// applied operations, not failures merely because instructions are not output.
fun empty_skip_findings : set Capability { Run.stage in Handoff + Complete => empty_caps else none }
fun finalized_heading_warnings : set SourceFile { { b : bases | b.headedDeltaInFinal = True }.file }
// Safety: pre-section/rename instructions never influence the selected output.
assert unsupported_never_active { execution implies always (no Run.working.op & (Removed + PreSection + Renamed)) }
```

### Requirement: Preserve Source Provenance In Merged Output [MCA-MERGE-PROVEN]
WHEN the spec-check tool emits merged requirements, merged scenarios, and derived claims, THE spec-check tool SHALL preserve original provenance and structured statement metadata while using a separate synthetic capability key for downstream semantic grouping and artifact naming.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#System Invariant Tactics`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Artifact-Key Contract`
- [Proposal: Assumptions and Dependencies](../../changes/archive/2026-11-15-improve-ears-smt-analysis/proposal.md#assumptions-and-dependencies)
- [Design: Source and identity](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#source-and-identity)

#### Scenario: Source Provenance Survives Merge [MCA-MERGE-SOURCE]
WHEN a selected item originates from a finalized or delta spec, THE spec-check tool SHALL retain its original source spans, EARS/scenario structure, formal disposition, justification, and supporting-content references without rewriting them as synthetic source locations.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [claim-graph.ts:275 claimFromRequirement()](/src/domain/claim-graph.ts#L275), [claim-graph.ts:298 claimFromScenario()](/src/domain/claim-graph.ts#L298)
- Test: [merge.test.ts:290 preserves provenance and does not remove base blocks without explicit cause](/test/contract/merge.test.ts#L290), [surface-claims.test.ts:15 modified payload replaces the original without rewriting provenance](/test/contract/surface-claims.test.ts#L15)
- Test (property): [merge.property.test.ts:122 preserves provenance, avoids silent discard, and emits complete skip findings](/test/property/merge.property.test.ts#L122)

#### Scenario: Synthetic Logical Key Groups Capability Artifacts [MCA-MERGE-LOGICAL]
WHEN merged capability artifacts are named or grouped, THE spec-check tool SHALL use `<merged-spec/{capability}>` separately from each item's source-file provenance.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [pipeline-helpers.ts:365 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L365), [pipeline-helpers.ts:422 sanitizeLogicalFileForArtifacts()](/src/cli/pipeline-helpers.ts#L422)
- Test: [pipeline-helpers.test.ts:137 groups by Claim.capability instead of provenance.file](/test/contract/pipeline-helpers.test.ts#L137), [merge-logic-routing.test.ts:57 writes logic artifacts under synthetic merged logicalFile artifact key](/test/contract/merge-logic-routing.test.ts#L57)
- Test (integration): [merge-liveness.integration.test.ts:135 processes each non-empty merged capability exactly once across downstream phases](/test/integration/merge-liveness.integration.test.ts#L135)

#### Scenario: Synthetic Logical Key Defines Compile-Group Boundary [MCA-MERGE-GROUP-KEY]
WHEN selected claims share a merged capability key, THE spec-check tool SHALL group their admitted formal scope under that key and SHALL apply existing compile-group identity validation before submission.

##### Evidence
- Implementation: [pipeline-helpers.ts:365 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L365), [logic-analysis.ts:150 runLogicAnalysis()](/src/domain/formal/logic-analysis.ts#L150), [logic-analysis.ts:209 preflightGroupClaimIds()](/src/domain/formal/logic-analysis.ts#L209)
- Test: [merge-logic-routing.test.ts:35 runs one logic group per merged capability and detects contradictions in one run](/test/contract/merge-logic-routing.test.ts#L35), [logic-analysis.test.ts:556 rejects duplicate raw claim IDs as invalid group before compile and solver work](/test/contract/logic-analysis.test.ts#L556), [logic-analysis.test.ts:619 detects constructed sanitized-id collision in preflight](/test/contract/logic-analysis.test.ts#L619)

#### Scenario: Merged Output Ordering Is Deterministic [MCA-MERGE-ORDER]
WHEN identical finalized and delta inputs are merged, THE spec-check tool SHALL produce identical selected item order, retained structure, dispositions, findings, and logical grouping identity.

##### Evidence
- Implementation: [merge.ts:24 mergeSpecsByCapability()](/src/domain/parser/merge.ts#L24), [merge.ts:414 groupBlocks()](/src/domain/parser/merge.ts#L414), [pipeline-helpers.ts:365 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L365)
- Test: [merge.test.ts:76 applies REMOVED then MODIFIED then ADDED deterministically](/test/contract/merge.test.ts#L76), [merge.test.ts:277 is deterministic across repeated runs](/test/contract/merge.test.ts#L277), [merge.determinism.test.ts:20 is byte-for-byte deterministic across repeated invocations](/test/determinism/merge.determinism.test.ts#L20)
- Test (property): [merge.property.test.ts:60 random valid inputs are deterministic across 3 runs](/test/property/merge.property.test.ts#L60)

#### Requirement model

```alloy
// Selected objects are retained by identity, preserving file, payload and scenarios.
fun selected_payloads : Block -> Payload { (Run.working <: payload) }
// Safety: source payload is never rewritten into a synthetic capability location.
assert provenance_preserved { execution implies always (all b : Run.working | b -> b.payload in selected_payloads) }
// Safety: projected output ordering is a strict total order per capability.
assert output_ordered {
  execution implies always (no iden & ^output_before and all disj a, b : Run.working |
    a.cap = b.cap implies (a -> b in output_before or b -> a in output_before))
}
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
- Implementation: [pipeline-helpers.ts:270 runClaimGraphPhase()](/src/cli/pipeline-helpers.ts#L270), [run-cli.ts:388 runAnalysisPhases()](/src/cli/run-cli.ts#L388), [pipeline-helpers.ts:365 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L365)
- Test (integration): [merge-liveness.integration.test.ts:135 processes each non-empty merged capability exactly once across downstream phases](/test/integration/merge-liveness.integration.test.ts#L135)

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
// Event: record each distinct downstream submission exactly once.
pred handoff[c : Capability] {
  Run.stage = Handoff and c in active_caps - Run.extracted
  Run.extracted' = Run.extracted + c
  Run.covered' = Run.covered + c
  Run.analyzed' = Run.analyzed + c
  Run.solverSubmitted' = Run.solverSubmitted + ((some compile_group[c] and claim_group_valid[c]) => c else none)
  Run.stage' = Run.stage
  keep_merge
}
pred finish {
  Run.stage = Handoff and Run.extracted = active_caps
  Run.stage' = Complete
  keep_merge
  keep_downstream
}
pred abort {
  Run.stage = Idle and abort_enabled
  Run.stage' = Aborted
  keep_merge
  keep_downstream
}
// Safety: empty capabilities and invalid compile groups cannot reach the solver.
assert downstream_exact {
  execution implies always (Run.extracted = Run.covered and Run.covered = Run.analyzed and
    Run.extracted in active_caps and all c : Run.solverSubmitted | claim_group_valid[c])
}
// Safety: entry-point faults prevent every downstream submission.
assert abort_no_work { execution implies always (Run.stage = Aborted implies no Run.extracted + Run.solverSubmitted) }
```

### Requirement: Shared Logical-File Grouping Authority [MCA-GROUP-KEY]
THE spec-check tool SHALL treat merged capability logical-file keys as the shared grouping authority for both requirement claims and scenario claims: the logical-file map SHALL map every provided merged capability to its non-empty `logicalFile`, the map-building step SHALL validate that each provided `spec.logicalFile` is a non-empty string, and scenario-only merged specs (specs with at least one scenario and no requirements) SHALL contribute logical-file map entries. The scenario-only rule is defensive: in the current merge domain model, merged scenarios derive only from requirement blocks, so a scenario-only merged spec cannot be produced; the rule exists to keep grouping correct if the domain model ever admits standalone scenario claims. Capability uniqueness within the map follows from the merge layer's `capabilityOrder` first-occurrence deduplication and is not re-enforced by the map builder.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Domain Model`
- `openspec/changes/semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/semantic-batching/design.md#Component Descriptions`

#### Scenario: Scenario-Only Spec Contributes Map Entry [MCA-GROUP-KEY-SCEN]
WHEN a merged capability spec contains at least one scenario and no requirements (a defensive case that is unreachable in the current merge domain model), THE spec-check tool SHALL include that capability in the logical-file map used for grouping.

**Postcondition:** Scenario-level claims of the capability receive the merged logical file as their semantic key.

##### Evidence
- Implementation: [grouping.ts:102 activeMergedSpecsForGrouping()](/src/domain/formal/grouping.ts#L102), [grouping.ts:136 buildLogicalFileByCapability()](/src/domain/formal/grouping.ts#L136)
- Test: [semantic-grouping.test.ts:56 selects requirement and defensive scenario-only specs in input order](/test/contract/semantic-grouping.test.ts#L56), [semantic-grouping.test.ts:68 maps every supplied capability without normalizing logical files](/test/contract/semantic-grouping.test.ts#L68)

#### Scenario: Empty Logical File Rejected [MCA-GROUP-KEY-EMPTY]
IF a merged capability spec supplied to the map builder has an empty `logicalFile` string, THEN THE spec-check tool SHALL reject it as a validation failure.

**Postcondition:** Empty logical-file values never silently enter the grouping map.

##### Evidence
- Implementation: [grouping.ts:136 buildLogicalFileByCapability()](/src/domain/formal/grouping.ts#L136), [run-cli.ts:546 runMergeAndGroupingMap()](/src/cli/run-cli.ts#L546)
- Test: [semantic-grouping.test.ts:87 returns every empty logical-file value as validation data](/test/contract/semantic-grouping.test.ts#L87)

#### Scenario: Every Provided Capability Mapped [MCA-GROUP-KEY-COMPLETE]
WHEN the map builder receives a set of merged capability specs, THE resulting map SHALL contain exactly one entry for every provided capability, consistent with merge-layer capability uniqueness invariants.

**Postcondition:** No provided capability is silently omitted from the map.

##### Evidence
- Implementation: [grouping.ts:136 buildLogicalFileByCapability()](/src/domain/formal/grouping.ts#L136), [run-cli.ts:546 runMergeAndGroupingMap()](/src/cli/run-cli.ts#L546)
- Test: [semantic-grouping.test.ts:68 maps every supplied capability without normalizing logical files](/test/contract/semantic-grouping.test.ts#L68)

#### Requirement model

```alloy
fun grouping_map : Capability -> LogicalKey { { c : active_caps, k : LogicalKey | k = c.logicalFile } }
// Safety: provided active capabilities have exactly their original logical key.
assert grouping_complete { execution implies always (grouping_map.LogicalKey = active_caps) }
```

### Requirement: Active Merged Specs For Grouping [MCA-ACTIVE-SPECS]
WHEN the spec-check tool selects merged specs for grouping-map construction, THE spec-check tool SHALL include a merged spec when it has at least one requirement or at least one scenario, and SHALL express this filtering in a dedicated, explicitly named helper rather than hiding it inside the map builder. This helper is used only for grouping-map construction; it SHALL NOT replace the claim-graph or solver-input activity filters (at least one requirement), so the grouping map can only be broader than the set of specs that contribute claims — never narrower. The scenarios clause is defensive: unreachable under the current merge domain model. If standalone scenario claims are ever admitted, this clause becomes load-bearing and the claim-graph activity filter must be broadened in the same change.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Scope`
- `openspec/changes/semantic-batching/design.md#Component Descriptions`
- `openspec/changes/semantic-batching/design.md#Interaction Protocols`

#### Scenario: Requirement-Bearing Spec Is Active [MCA-ACTIVE-REQ]
WHEN a merged spec has at least one requirement, THE spec-check tool SHALL treat it as active for grouping.

**Postcondition:** The spec is included in grouping-map construction.

##### Evidence
- Implementation: [grouping.ts:102 activeMergedSpecsForGrouping()](/src/domain/formal/grouping.ts#L102), [run-cli.ts:546 runMergeAndGroupingMap()](/src/cli/run-cli.ts#L546)
- Test: [semantic-grouping.test.ts:56 selects requirement and defensive scenario-only specs in input order](/test/contract/semantic-grouping.test.ts#L56)
- Test (integration): [semantic-batching.integration.test.ts:173 aligns merged grouping, provenance, bounds, prompt, cleanup, and evidence](/test/integration/semantic-batching.integration.test.ts#L173)

#### Scenario: Scenario-Only Spec Is Active [MCA-ACTIVE-SCEN]
WHEN a merged spec has at least one scenario and no requirements (a defensive case that is unreachable in the current merge domain model), THE spec-check tool SHALL treat it as active for grouping.

**Postcondition:** Scenario-only capabilities keep their semantic grouping key.

##### Evidence
- Implementation: [grouping.ts:102 activeMergedSpecsForGrouping()](/src/domain/formal/grouping.ts#L102), [run-cli.ts:546 runMergeAndGroupingMap()](/src/cli/run-cli.ts#L546)
- Test: [semantic-grouping.test.ts:56 selects requirement and defensive scenario-only specs in input order](/test/contract/semantic-grouping.test.ts#L56)

#### Scenario: Empty Spec Is Inactive [MCA-ACTIVE-EMPTY]
WHEN a merged spec has zero requirements and zero scenarios, THE spec-check tool SHALL exclude it from grouping-map construction.

**Postcondition:** Vacuous specs contribute no grouping entries.

##### Evidence
- Implementation: [grouping.ts:102 activeMergedSpecsForGrouping()](/src/domain/formal/grouping.ts#L102), [run-cli.ts:546 runMergeAndGroupingMap()](/src/cli/run-cli.ts#L546)
- Test: [semantic-grouping.test.ts:56 selects requirement and defensive scenario-only specs in input order](/test/contract/semantic-grouping.test.ts#L56)

#### Requirement model

```alloy
// Today's merge output has scenarios only through surviving requirement blocks.
fun grouping_active : set Capability { Run.working.cap + active_scenarios.parent.cap }
// Safety: the grouping filter is never narrower than requirement-bearing output.
assert grouping_never_narrower { execution implies always (active_caps in grouping_active) }
```

### Requirement: Solver Grouping Calls Shared Key Helper [MCA-SOLVER-SHARED-KEY]
WHEN the spec-check tool groups claims for solver analysis, THE solver grouping path SHALL obtain each claim's grouping key from the same shared semantic key helper used by formalization grouping, SHALL NOT duplicate capability fallback logic locally, SHALL consume the same logical-file map instance that the pipeline constructs once and passes to both phases, and SHALL perform any solver-specific claim filtering before grouping and document that filtering independently of the key function.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Scope`
- `openspec/changes/semantic-batching/design.md#Interaction Protocols`

#### Scenario: No Duplicated Fallback Logic [MCA-SOLVER-NODUP]
WHEN solver grouping computes a claim's grouping key, THE key SHALL be produced by the shared helper so that the capability fallback rule (mapped `logicalFile`, else `<merged-spec/{capability}>`) exists in exactly one place.

**Postcondition:** The capability fallback rule has a single authoritative implementation.

##### Evidence
- Implementation: [grouping.ts:185 selectClaimLogicalFile()](/src/domain/formal/grouping.ts#L185), [pipeline-helpers.ts:365 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L365), [run-cli.ts:546 runMergeAndGroupingMap()](/src/cli/run-cli.ts#L546)
- Test: [semantic-grouping.test.ts:112 selects mapped, provenance, and synthetic fallback keys exactly](/test/contract/semantic-grouping.test.ts#L112)
- Test (property): [semantic-batching.property.test.ts:179 matches solver grouping after the same explicit filtering](/test/property/semantic-batching.property.test.ts#L179)
- Test (integration): [merge-liveness.integration.test.ts:135 processes each non-empty merged capability exactly once across downstream phases](/test/integration/merge-liveness.integration.test.ts#L135)

#### Scenario: Filtering Precedes Grouping [MCA-SOLVER-FILTER-FIRST]
WHEN solver analysis excludes claims (for example, non-spec claims), THE spec-check tool SHALL apply those exclusions before grouping and SHALL NOT encode solver-specific policy inside the shared key helper.

**Postcondition:** The key function remains policy-free and identical across phases.

##### Evidence
- Implementation: [pipeline-helpers.ts:365 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L365), [grouping.ts:185 selectClaimLogicalFile()](/src/domain/formal/grouping.ts#L185)
- Test: [pipeline-helpers.test.ts:218 excludes non-spec claims from capability-grouped logic path](/test/contract/pipeline-helpers.test.ts#L218)
- Test (property): [semantic-batching.property.test.ts:179 matches solver grouping after the same explicit filtering](/test/property/semantic-batching.property.test.ts#L179)

#### Requirement model

```alloy
fun key_for_claim[q : Claim] : one LogicalKey { q.block.cap.logicalFile }
// Safety: logical grouping is independent of original file provenance.
assert shared_key_parity { all a, b : Claim | a.block.cap = b.block.cap implies key_for_claim[a] = key_for_claim[b] }
```

### Requirement: Discover Concepts Only From Selected Active Content [MCA-CONCEPT-ACTIVE]
WHEN concept discovery begins, THE spec-check tool SHALL provide only the selected merged capability statements and explicitly configured model context as authoritative discovery inputs.

**References:**
- [Design: Interaction Protocols](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#interaction-protocols)

#### Scenario: Removed Or Replaced Statements Do Not Supply Concepts [MCA-CONCEPT-REMOVED]
WHEN a requirement block is removed or replaced by merge operations, THE spec-check tool SHALL exclude its superseded statement text and nested scenarios from concept discovery and formal analysis while retaining ordinary merge provenance.

##### Evidence
- Implementation: [merge.ts:244 applyRemoved()](/src/domain/parser/merge.ts#L244), [merge.ts:296 applyModified()](/src/domain/parser/merge.ts#L296), [claim-graph.ts:253 extractMergedSpecClaims()](/src/domain/claim-graph.ts#L253), [source-formalize.ts:80 processGroup()](/src/domain/formal/source-formalize.ts#L80)
- Test: [surface-claims.test.ts:15 modified payload replaces the original without rewriting provenance](/test/contract/surface-claims.test.ts#L15), [surface-claims.test.ts:64 ineligible content remains selected but removed blocks do not](/test/contract/surface-claims.test.ts#L64)
- Test (integration): [merge-liveness.integration.test.ts:237 routes only active merged requirements to logic inputs (removed excluded, modified retained)](/test/integration/merge-liveness.integration.test.ts#L237)

#### Scenario: Formal Ineligibility Does Not Delete Merge Content [MCA-CONCEPT-INELIGIBLE]
WHEN a selected statement is formally ineligible, THE spec-check tool SHALL retain the selected merge content and its disposition instead of treating ineligibility as an implicit removal operation.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [claim-graph.ts:275 claimFromRequirement()](/src/domain/claim-graph.ts#L275), [claim-graph.ts:298 claimFromScenario()](/src/domain/claim-graph.ts#L298), [grouping.ts:208 isFormalizableClaim()](/src/domain/formal/grouping.ts#L208)
- Test: [surface-claims.test.ts:64 ineligible content remains selected but removed blocks do not](/test/contract/surface-claims.test.ts#L64), [surface-claims.test.ts:34 retains excluded source claims but assigns indexes after admission](/test/contract/surface-claims.test.ts#L34)

#### Requirement model

```alloy
fun discovery_input : set Block { Run.stage in Handoff + Complete => { b : Run.working | b.formallyEligible = True } else none }
fun discovery_scenario_input : set Scenario { Run.stage in Handoff + Complete => { s : active_scenarios | s.formallyEligible = True } else none }
// Safety: formal ineligibility does not delete selected merge content.
assert discovery_selected_only { execution implies always (discovery_input in Run.working and discovery_input.formallyEligible in True and
  discovery_scenario_input in active_scenarios and discovery_scenario_input.formallyEligible in True) }
// Safety: eligibility never changes merge selection or authorizes solver work
// for an empty formal group; diagnostics still reach every nonempty capability.
assert solver_submission_exact { execution implies always (Run.stage = Complete implies Run.solverSubmitted =
  { c : active_caps | some compile_group[c] and claim_group_valid[c] }) }
fun invalid_compile_groups : set Capability { { c : Run.analyzed | not claim_group_valid[c] } }
```

### State machine and invariant checks

```alloy
pred keep_merge {
  Run.working' = Run.working
  Run.handled' = Run.handled
  Run.applied' = Run.applied
  Run.rejected' = Run.rejected
}
pred keep_downstream {
  Run.extracted' = Run.extracted
  Run.covered' = Run.covered
  Run.analyzed' = Run.analyzed
  Run.solverSubmitted' = Run.solverSubmitted
}
pred init {
  Run.stage = Idle
  no Run.rejected
  no Run.working + Run.handled + Run.applied +
    Run.extracted + Run.covered + Run.analyzed + Run.solverSubmitted
}
pred stutter { Run.stage' = Run.stage and keep_merge and keep_downstream }
// One-step relation is usable independently of initialization for preservation.
pred next_step {
  start_merge or abort or advance_merge or finish or
    (some b : Block | apply_next[b]) or (some c : Capability | handoff[c]) or stutter
}
// Opt-in execution semantics: assertions/runs about reachable behavior name this
// predicate explicitly. Structural source/ownership facts remain globally valid.
pred execution { init and always next_step }
pred fairness {
  always (Run.stage = Idle implies eventually (start_merge or abort))
  all b : Block | always (b in pending and no earlier[b] & pending implies eventually apply_next[b])
  always (Run.stage in RemoveStage + ModifyStage + AddStage and no pending implies eventually advance_merge)
  all c : Capability | always (Run.stage = Handoff and c in active_caps - Run.extracted implies eventually handoff[c])
  always (Run.stage = Handoff and Run.extracted = active_caps implies eventually finish)
}
// Liveness: finite selected input drains under action-level service fairness.
assert eventually_terminal { execution and fairness implies eventually Run.stage in Complete + Aborted }
// Safety: completion accounts for every selected instruction and active capability.
assert completion_total { execution implies always (Run.stage = Complete implies Run.handled = Block and Run.extracted = active_caps) }
// Safety: the complete/aborted workflow admits only framed stuttering.
assert terminal_stable { execution implies always (Run.stage in Complete + Aborted implies Run.stage' = Run.stage and Run.working' = Run.working) }
run clean_completion { execution and fairness and some Block and eventually Run.stage = Complete } for 4 but 20 steps expect 1
run three_operation_completion {
  execution
  (some b : Block | b.op = Removed) and (some b : Block | b.op = Modified) and (some b : Block | b.op = Added)
  eventually (Run.stage = Complete and (Removed + Modified + Added) in Run.applied.op)
} for 6 but 3 Identifier, 24 steps expect 1
run fresh_replacement_scenario {
  execution
  some b : Block | b.op = Modified and some b.scenarios and
    (some old : authoritative_base | old.cap = b.cap and old.identifier = b.identifier and some old.scenarios) and
    no b.scenarios.identifier & bases.scenarios.identifier and eventually b in Run.applied
  eventually Run.stage = Complete
} for 4 but 20 steps expect 1
run collision_rolls_back {
  execution
  eventually (some b : Block | b.op = Modified and apply_next[b] and failure[b] = Collision and some targets[b])
  eventually Run.stage = Complete
} for 5 but 20 steps expect 1
run duplicate_base_authority {
  execution
  Block = bases
  some b : bases | later_base_duplicate[b]
  eventually Run.stage = Complete
} for 4 but 20 steps expect 1
run duplicate_delta_group {
  execution
  some disj a, b : Block | delta_duplicate[a] and delta_duplicate[b]
  eventually Run.stage = Complete
} for 4 but 20 steps expect 1
run mixed_capability_handoff {
  execution
  eventually (Run.stage = Complete and #active_caps = 2 and some empty_caps)
} for 4 but exactly 3 Capability, 20 steps expect 1
run input_precondition_abort { execution
  some c : Capability | #c.selectedDeltas > 1
  eventually Run.stage = Aborted } for 3 but 4 steps expect 1
run key_collision_abort { execution
  some disj c, d : Capability | c.logicalFile.sanitized = d.logicalFile.sanitized
  eventually Run.stage = Aborted } for 3 but 4 steps expect 1
run empty_finalized_skip { execution and no Block and eventually (Run.stage = Complete and some empty_skip_findings) } for 3 but exactly 0 Block, 12 steps expect 1
run ineligible_selected_content {
  execution
  some b : Block | b.op = Base and b.formallyEligible = False and
    eventually (Run.stage = Complete and b in Run.working and b not in discovery_input)
} for 3 but 14 steps expect 1
run compile_identity_rejected {
  execution
  some disj a,b : Claim | a.block.cap = b.block.cap and a.rawLabel = b.rawLabel and
    a.block.formallyEligible = True and b.block.formallyEligible = True and
    eventually (Run.stage = Complete and a.block + b.block in Run.working and a.block.cap in invalid_compile_groups)
} for 3 but 2 Claim, 16 steps expect 1
run both_sources_preserved {
  execution
  some disj a,b : Block | a.cap = b.cap and a.op = Base and b.op = Added and a.file != b.file and
    eventually (Run.stage = Complete and a + b in Run.working)
} for 3 but 16 steps expect 1
run source_ordered_scenario_swap_rejected {
  execution
  some disj a,b : bases, disj x,y : Block | {
    a.cap = b.cap and x.cap = a.cap and y.cap = a.cap
    x.op = Modified and y.op = Modified
    some a.identifier and some b.identifier and a.identifier != b.identifier
    x.identifier = a.identifier and y.identifier = b.identifier
    one a.scenarios and one b.scenarios and one x.scenarios and one y.scenarios
    some a.scenarios.identifier and some b.scenarios.identifier
    a.scenarios.identifier != b.scenarios.identifier
    x.scenarios.identifier = b.scenarios.identifier
    y.scenarios.identifier = a.scenarios.identifier
    eventually (Run.stage = Complete and x.(Run.rejected) = Collision and y.(Run.rejected) = Collision and a + b in Run.working)
  }
} for 4 but 1 Capability, 1 LogicalKey, 1 ArtifactKey, 4 Scenario, 0 Claim, 20 steps expect 1
run eligible_scenario_under_ineligible_parent {
  execution
  some b : Block, s : b.scenarios | b.op = Base and b.formallyEligible = False and s.formallyEligible = True and
    eventually (Run.stage = Complete and b in Run.working and s in discovery_scenario_input)
} for 3 but 14 steps expect 1
check finalized_only_passthrough for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check delta_only_additive for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check modification_atomicity for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
// Primary namespace verification: independent base and step, with the original
// six-block/four-scenario structural budgets and only one/two temporal states.
check namespace_initialization for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 1 steps expect 0
check namespace_preservation for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 2 steps expect 0
check scenario_namespace_initialization for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 1 steps expect 0
check scenario_namespace_preservation for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 2 steps expect 0
// Six-state prefix regressions supplement induction and the full-length witnesses.
// Their purpose is execution wiring, not a second long-horizon invariant proof.
check namespaces_unique for 4 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 6 steps expect 0
check every_skip_has_finding for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check unsupported_never_active for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check provenance_preserved for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check output_ordered for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check downstream_exact for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check abort_no_work for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check grouping_complete for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check grouping_never_narrower for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check shared_key_parity for 6 but 1 steps expect 0
check discovery_selected_only for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check eventually_terminal for 4 but 24 steps expect 0
check completion_total for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check terminal_stable for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check merge_instruction_choice_unique for 6 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 20 steps expect 0
check solver_submission_exact for 4 but 2 Capability, 3 Claim, 4 Block, 20 steps expect 0
check valid_scenario_namespaces_preserved for 4 but 2 Capability, 2 LogicalKey, 2 ArtifactKey, 3 Identifier, 4 Scenario, 2 SourceFile, 1 Payload, 0 Claim, 2 DeltaFile, 6 steps expect 0
// Nonvacuity controls deliberately omit execution. They would become UNSAT if a
// global initialization/behavior fact accidentally constrained induction again.
run induction_exercises_noninitial_modification {
  namespace_inv
  scenario_input_namespace_valid
  scenario_namespace_inv
  Run.stage = ModifyStage
  Run.working.op = Base
  some Run.working.scenarios
  some b : Block | apply_next[b] and b.op = Modified and some b.scenarios and no failure[b]
} for 4 but 2 Capability, 3 Identifier, 4 Scenario, 0 Claim, 2 steps expect 1
run namespace_violation_is_representable {
  not namespace_inv
} for 4 but 2 Capability, 3 Identifier, 4 Scenario, 0 Claim, 1 steps expect 1
run scenario_violation_is_representable {
  scenario_input_namespace_valid
  not scenario_namespace_inv
} for 4 but 2 Capability, 3 Identifier, 4 Scenario, 0 Claim, 1 steps expect 1
```

**Verification boundary:** Namespace initialization and preservation are checked independently of `execution`, over arbitrary states within the listed structural scopes; they are not short initialized traces presented as induction. Full scenario uniqueness retains its explicit source-validity premise. Smaller temporal regressions and full execution witnesses supplement these checks. All commands use explicit finite scopes. Concrete byte/order preservation and external-process deadlines require the referenced contract/property and integration tests. Passing bounded checks does not prove natural-language fidelity or production refinement.

**Bounded verification (2026-11-16):** Alloy 6.2.0, using its default SAT solver with no solver override, found instances for all 18 execution/control witnesses and no counterexamples for all 24 assertion checks in the complete merge suite. This includes all four independent namespace initialization/preservation checks, both six-state execution regressions, and the non-initial modification and representable-invalid-state controls. The induction checks retain the six-block/four-scenario structural budgets listed above; these results do not extend the checked object scopes or establish production refinement.
