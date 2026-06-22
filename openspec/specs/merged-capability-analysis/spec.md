---
title: MergedCapabilityAnalysis
---

## Purpose

Define the per-capability merge behavior for the spec-check tool: combining finalized capability specs with selected delta specs into one deterministic active merged capability view that downstream specs-forward analysis consumes.

## Requirements

### Formal Model

The structural invariants and safety properties of this capability are modeled in [`alloy/merge.als`](alloy/merge.als). The model verifies:
- One merged view per capability (`oneViewPerCapability`)
- Provenance preservation (`provenancePreserved`)
- No phantom introduction (`noPhantomIntroduction`)
- Excluded operations never in output (`excludedOpsNeverInOutput`)
- Cross-capability isolation (`capabilityIsolation`)
- Non-empty capabilities reach downstream (`nonEmptyAnalyzed`)

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

#### Scenario: Finalized-Only Capability Passes Through Unchanged [MCA-MERGE-FINAL]
WHEN a capability has a finalized spec and no selected delta spec, THE spec-check tool SHALL produce a merged capability view whose requirement and scenario content matches the finalized spec content in the same order.

**Postcondition:** Finalized-only capabilities preserve their existing active behavior under the merge phase.

#### Scenario: Delta-Only Capability Uses Additive Output Only [MCA-MERGE-DELTA-ONLY]
WHEN a capability has a selected delta spec and no finalized base spec, THE spec-check tool SHALL treat the initial merged base as empty, SHALL allow `ADDED` requirement blocks to contribute output, and SHALL skip `MODIFIED` and `REMOVED` operations with explicit findings.

**Postcondition:** Delta-only capabilities produce deterministic partial output without pretending that nonexistent base requirements were modified or removed.

### Requirement: Apply Requirement-Block Delta Semantics Deterministically [MCA-DELTA-SEM]
WHEN the spec-check tool merges a selected delta spec into a capability, THE spec-check tool SHALL apply `REMOVED` operations first, `MODIFIED` operations second, and `ADDED` operations last, all at the requirement-block level using canonical requirement identifiers, and SHALL preserve deterministic output ordering.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Merge Semantics`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Merge Contract`

#### Scenario: Added Requirement Appended After Surviving Base Requirements [MCA-DELTA-ADD]
WHEN an `ADDED` requirement block has no colliding requirement or scenario identifiers, THE spec-check tool SHALL append that requirement block after the surviving base requirement blocks in delta-document order.

**Postcondition:** Added behavior appears exactly once at the end of the merged capability requirement ordering.

#### Scenario: Modified Requirement Replaces Base Block In Place [MCA-DELTA-MOD]
WHEN a `MODIFIED` requirement block matches a surviving base requirement by canonical identifier and introduces no external identifier collisions, THE spec-check tool SHALL replace the matched base requirement block and all of its nested scenarios with the delta requirement block in the original base position.

**Postcondition:** The merged capability contains only the modified requirement-block version for that identifier.

#### Scenario: Removed Requirement Deletes Base Block [MCA-DELTA-REM]
WHEN a `REMOVED` requirement block matches a surviving base requirement by canonical identifier, THE spec-check tool SHALL remove that base requirement block and all of its nested scenarios from the merged capability view.

**Postcondition:** Removed behavior no longer participates in downstream specs-forward analysis.

#### Scenario: Collision Checking Uses Projected Final State [MCA-DELTA-SURVIVING]
WHEN the merge layer checks whether an `ADDED` or `MODIFIED` requirement block would introduce an identifier collision, THE spec-check tool SHALL check against the projected final state, defined as the base requirement set after all `REMOVED` deletions and all `MODIFIED` replacements have been applied.

**Postcondition:** An ADDED block does not collide with a requirement that has already been removed or replaced.

#### Scenario: Requirement And Scenario Collision Namespaces Remain Separate [MCA-DELTA-NAMESPACE]
WHEN the merge layer checks for duplicate identifiers introduced by delta application, THE spec-check tool SHALL treat requirement identifiers and scenario identifiers as separate canonical namespaces.

**Postcondition:** A requirement identifier does not collide with a scenario identifier merely because their text matches.

#### Scenario: Modified Replacement Collision Preserves Prior Valid State [MCA-DELTA-MOD-COLLISION]
IF a `MODIFIED` replacement would introduce a requirement or scenario identifier collision outside the matched base block, THEN THE spec-check tool SHALL emit `spec_merge.duplicate_modified_identifier`, SHALL skip the replacement, and SHALL preserve the original matched base block unchanged.

**Postcondition:** The merged capability remains deterministic and collision-free without silently discarding base behavior.

### Requirement: Surface Invalid Or Unsupported Delta Content [MCA-MERGE-FIND]
IF a selected delta spec contains malformed, ambiguous, duplicate, or unsupported merge content, THEN THE spec-check tool SHALL emit explicit `spec_merge.*` findings and SHALL skip only the affected merge operation or malformed item.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Findings Catalog`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Failure And Reliability`

#### Scenario: Unsupported Standalone Scenario Surfaced [MCA-MERGE-STANDALONE]
IF a delta section contains a scenario that is not associated with a parsed requirement block, THEN THE spec-check tool SHALL emit `spec_merge.standalone_scenario_unsupported` and SHALL exclude that scenario from the merged capability view.

**Postcondition:** Unsupported scenario-only delta content cannot silently influence downstream analysis.

#### Scenario: Pre-Section Delta Content Surfaced [MCA-MERGE-PRE-SECTION]
IF a delta spec contains requirements or scenarios before the first recognized delta section heading, THEN THE spec-check tool SHALL emit `spec_merge.pre_section_content` for each such item and SHALL exclude those items from the merged capability view.

**Postcondition:** Structurally ambiguous delta content is surfaced explicitly rather than guessed at.

#### Scenario: Missing Identifier In Modified Or Removed Operation Surfaced [MCA-MERGE-MISSING-ID]
IF a `MODIFIED` or `REMOVED` requirement block lacks a canonical identifier, THEN THE spec-check tool SHALL emit `spec_merge.modified_missing_identifier` or `spec_merge.removed_missing_identifier` respectively and SHALL skip that operation.

**Postcondition:** Identifier-dependent operations do not guess at their targets.

#### Scenario: Missing Modification Or Removal Target Surfaced [MCA-MERGE-NO-TARGET]
IF a `MODIFIED` or `REMOVED` requirement block names an identifier that does not match any surviving base requirement block, THEN THE spec-check tool SHALL emit `spec_merge.modified_target_not_found` or `spec_merge.removed_target_not_found` respectively and SHALL skip that operation.

**Postcondition:** Merge failures remain localized and visible without stopping other valid operations.

#### Scenario: Duplicate Added Identifier Surfaced [MCA-MERGE-DUP-ADD]
IF an `ADDED` requirement block or one of its nested scenarios would collide with an existing surviving identifier in its namespace, THEN THE spec-check tool SHALL emit `spec_merge.duplicate_added_identifier` with a message that identifies the colliding identifier value and states which namespace (requirement or scenario) the collision occurred in, and SHALL skip that requirement block and its nested scenarios as a unit.

**Postcondition:** Added behavior cannot introduce duplicate surviving identifiers.

#### Scenario: Duplicate Base Identifier Surfaced [MCA-MERGE-DUP-BASE]
IF a finalized base spec contains duplicate canonical requirement identifiers, THEN THE spec-check tool SHALL keep the first occurrence authoritative, SHALL emit `spec_merge.duplicate_base_identifier` for each later occurrence, and SHALL exclude later duplicate blocks from merged output and future matching.

**Postcondition:** Finalized malformed input remains deterministic and analyzable.

#### Scenario: Duplicate Delta Identifier Group Surfaced [MCA-MERGE-DUP-DELTA]
IF duplicate canonical identifiers appear more than once within the same delta operation section for one capability, THEN THE spec-check tool SHALL emit `spec_merge.duplicate_delta_identifier` for each conflicting block in that duplicate group and SHALL exclude all conflicting blocks in that group from merge application.

**Postcondition:** Competing edits in the same delta section do not force arbitrary merge choices.

#### Scenario: Rename Blocks Emit One Finding Per Skipped Operation [MCA-MERGE-RENAME]
IF a selected delta spec contains a `RENAMED` requirement block, THEN THE spec-check tool SHALL emit exactly one `spec_merge.rename_unsupported` warning for that skipped requirement block and SHALL leave merged capability content unchanged.

**Postcondition:** Deferred rename semantics are visible without pretending renames were applied, and no skipped `RENAMED` operation is silently discarded.

#### Scenario: Finalized Delta Headings Warn Once And Are Ignored [MCA-MERGE-FINAL-DELTA]
IF a finalized spec contains one or more delta section headings, THEN THE spec-check tool SHALL emit exactly one `spec_merge.finalized_spec_delta_heading_ignored` warning for that finalized spec file, SHALL include guidance that finalized specs should not have Delta Spec Headings, and SHALL treat all parsed items in that file as base content.

**Postcondition:** Malformed finalized specs do not silently acquire delta semantics.

#### Scenario: Empty Merged Capability Is Skipped Downstream [MCA-MERGE-EMPTY]
IF a capability produces zero surviving merged requirements after removals and exclusions, THEN THE spec-check tool SHALL emit `spec_merge.empty_capability_skipped` and SHALL omit that capability from downstream specs-forward claim extraction, logic analysis, and coverage.

**Postcondition:** Vacuous capability groups are not analyzed as if they contained active behavior.

### Requirement: Preserve Source Provenance In Merged Output [MCA-MERGE-PROVEN]
WHEN the spec-check tool emits merged requirements, merged scenarios, and derived claims from a merged capability view, THE spec-check tool SHALL preserve the original source-file provenance on each contributing item and SHALL use a separate synthetic merged capability key only for grouping and artifact naming.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#System Invariant Tactics`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Artifact-Key Contract`

#### Scenario: Source Provenance Survives Merge [MCA-MERGE-SOURCE]
WHEN a merged requirement or scenario originates from either the finalized spec or the selected delta spec, THE spec-check tool SHALL preserve that item's original source file and line provenance in the merged output and any derived claim.

**Postcondition:** Reviewers can trace merged analysis results back to the original contributing file.

#### Scenario: Synthetic Logical Key Groups Capability Artifacts [MCA-MERGE-LOGICAL]
WHEN the spec-check tool persists specs-forward solver artifacts or report headings for a merged capability, THE spec-check tool SHALL use the deterministic synthetic merged capability key `<merged-spec/{capability}>` rather than a real filesystem source path.

**Postcondition:** Capability-scoped artifacts remain distinct from source-file provenance.

#### Scenario: Merged Output Ordering Is Deterministic [MCA-MERGE-ORDER]
WHEN the same finalized and delta inputs are merged on separate runs, THE spec-check tool SHALL produce the same requirement order, scenario order, capability order, findings, and logical grouping identity on each run.

**Postcondition:** Merge output is a deterministic function of input specs and catalog selection.

### Requirement: Ensure All Non-Empty Merged Capabilities Reach Downstream Phases [MCA-LIVENESS]
WHEN the spec-check tool completes capability merging and at least one merged capability contains surviving requirements, THE spec-check tool SHALL submit every non-empty merged capability to downstream specs-forward claim extraction, coverage analysis, and logical analysis exactly once.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Merge Contract`

#### Scenario: Non-Empty Merged Capability Is Analyzed [MCA-LIVENESS-NONEMPTY]
WHEN a merged capability contains at least one surviving requirement after merge application, THE spec-check tool SHALL include that capability in downstream specs-forward claim extraction, coverage analysis, and logical analysis.

**Postcondition:** No non-empty merged capability is silently omitted from downstream processing.

#### Scenario: Merge Precondition Assertion Catches Internal Errors [MCA-LIVENESS-ASSERT]
IF `mergeSpecsByCapability()` receives input that violates its precondition (more than one delta per capability), THEN THE spec-check tool SHALL raise a fatal pipeline exception rather than producing undefined merge behavior.

**Postcondition:** Precondition violations are caught at the merge entry point and do not propagate as silent correctness failures.
