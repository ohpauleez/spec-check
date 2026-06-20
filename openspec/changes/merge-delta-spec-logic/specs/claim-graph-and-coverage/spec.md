## ADDED Requirements

## MODIFIED Requirements

### Requirement: Normalize Parsed Content Into Typed Claims [CGC-NORMALIZE-CLAIMS]
WHEN parsed proposal, design, merged capability spec, or task content is available, THE spec-check tool SHALL normalize the content into typed claims that preserve claim kind, source text, obligation level when present, original source provenance needed for downstream analysis, and capability identity for all spec-derived claims.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/merge-delta-spec-logic/proposal.md#Domain Model`
- `openspec/changes/merge-delta-spec-logic/design.md#Interface Contracts`

#### Scenario: Preserve Claim Provenance [CGC-CLAIM-PROVEN]
WHEN the tool derives a claim from a requirement, scenario, design section, or task summary, THE spec-check tool SHALL attach the source file and nearest heading needed to trace that claim back to its origin.

**Postcondition:** Every derived claim can be traced back to its originating artifact section.

#### Scenario: Reject Provenance-Free Finding Input [CGC-CLAIM-FAIL]
IF a downstream analysis step would consume a claim without sufficient provenance, THEN THE spec-check tool SHALL treat that condition as an analysis defect and SHALL surface it as a finding instead of issuing an untraceable conclusion.

**Postcondition:** Downstream analysis does not rely on orphaned claims.

#### Scenario: Populate Capability Identity On Spec-Derived Claims [CGC-CLAIM-CAP]
WHEN the tool derives a claim from a merged capability requirement or scenario, THE spec-check tool SHALL attach the capability identity of the merged capability view to that claim.

**Postcondition:** Downstream specs-forward grouping can use capability identity without re-inferring it from source file paths.

### Requirement: Validate Capability Mapping And References [CGC-VALIDATE-REFS]
WHEN the proposal declares capabilities and capability requirements declare references, THE spec-check tool SHALL validate expected active merged capability presence and SHALL assess whether each requirement reference points to upstream content that supports the cited behavior.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Capabilities`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/merge-delta-spec-logic/proposal.md#Capabilities`

#### Scenario: Report Missing Spec File [CGC-REF-MISSFILE]
WHEN the proposal declares a capability and no corresponding active merged capability view exists for that capability, THE spec-check tool SHALL emit a missing-spec-file finding for the absent capability.

**Postcondition:** Proposal-to-spec contract gaps are explicitly surfaced against the active capability set.

#### Scenario: Report Unsupported Reference [CGC-REF-BADLINK]
IF a requirement references an upstream section whose content does not support the claimed behavior, THEN THE spec-check tool SHALL emit a semantic-mismatch finding that names the requirement and the unsupported reference target. References to archived change artifacts (`openspec/changes/archive/`) SHALL be accepted as valid provenance links regardless of whether their content semantically supports the citing requirement, and SHALL NOT be flagged as unsupported.

**Postcondition:** References remain meaningful evidence links rather than decorative citations. Archived change references are preserved as historical provenance without triggering semantic-support validation.

### Requirement: Use Merged Capability Views For Coverage [CGC-MERGED-COVERAGE]
WHEN the spec-check tool performs proposal-to-spec mapping and downstream coverage analysis, THE spec-check tool SHALL use merged capability specs as the active capability source of truth rather than raw per-file parsed specs.

**References:**
- `openspec/changes/merge-delta-spec-logic/proposal.md#Postconditions`
- `openspec/changes/merge-delta-spec-logic/design.md#Interaction Protocols`
- `openspec/changes/merge-delta-spec-logic/design.md#Verification Strategy`

#### Scenario: Removed Requirements Do Not Participate In Coverage [CGC-COVERAGE-REMOVED]
WHEN a requirement is removed from the active merged capability view by a valid `REMOVED` delta operation, THE spec-check tool SHALL exclude that removed requirement from downstream coverage analysis.

**Postcondition:** Coverage reflects the same active capability behavior used by claim extraction and logic.

#### Scenario: Empty Merged Capability Skipped In Coverage [CGC-COVERAGE-EMPTY]
IF a capability produces zero surviving merged requirements and the merge layer emits `spec_merge.empty_capability_skipped`, THEN THE spec-check tool SHALL omit that capability from coverage analysis.

**Postcondition:** Coverage analysis does not report misleading results for vacuous capability groups.

### Requirement: Claim Graph Determinism [CGC-GRAPH-DETERMINISM]
WHEN the spec-check tool builds a claim graph from the same parsed inputs and merged capability views on separate runs, THE spec-check tool SHALL produce identical claim graphs.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/merge-delta-spec-logic/proposal.md#Quality Attributes`

#### Scenario: Identical Parsed Input Produces Identical Claims [CGC-DETERM-SAME]
WHEN the same set of parsed documents is processed on two separate runs, THE spec-check tool SHALL produce an identical set of typed claims with identical provenance and obligation levels.

**Postcondition:** Claim graph construction is a deterministic function of parsed input.

### Requirement: Coverage Analysis Determinism [CGC-COVERAGE-DETERMINISM]
WHEN the spec-check tool performs coverage analysis on the same claim graph and merged capability set on separate runs, THE spec-check tool SHALL produce identical coverage findings.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/merge-delta-spec-logic/proposal.md#Quality Attributes`

#### Scenario: Same Graph Produces Same Findings [CGC-COVDET-SAME]
WHEN the same claim graph is analyzed for coverage on two separate runs, THE spec-check tool SHALL produce byte-identical coverage findings.

**Postcondition:** Coverage analysis is a deterministic function of the merged capability analysis inputs.

## REMOVED Requirements

## RENAMED Requirements
