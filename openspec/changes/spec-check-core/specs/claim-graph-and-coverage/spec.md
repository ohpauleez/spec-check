## ADDED Requirements

### Requirement: Normalize Parsed Content Into Typed Claims [CGC-NORMALIZE-CLAIMS]
WHEN parsed proposal, design, spec, or task content is available, THE spec-check tool SHALL normalize the content into typed claims that preserve claim kind, source text, obligation level when present, and provenance needed for downstream analysis.

**References:**
- `proposal.md#Domain Model`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Preserve Claim Provenance [CGC-CLAIM-PROVEN]
WHEN the tool derives a claim from a requirement, scenario, design section, or task summary, THE spec-check tool SHALL attach the source file and nearest heading needed to trace that claim back to its origin.

**Postcondition:** Every derived claim can be traced back to its originating artifact section.

#### Scenario: Reject Provenance-Free Finding Input [CGC-CLAIM-FAIL]
IF a downstream analysis step would consume a claim without sufficient provenance, THEN THE spec-check tool SHALL treat that condition as an analysis defect and SHALL surface it as a finding instead of issuing an untraceable conclusion.

**Postcondition:** Downstream analysis does not rely on orphaned claims.

### Requirement: Obligation Level Assignment [CGC-OBLIGATION-LEVEL]
WHEN the spec-check tool normalizes a claim from a requirement or scenario, THE spec-check tool SHALL assign an obligation level (mandatory, advisory, or informational) based on the source structure and EARS pattern keywords.

**References:**
- `proposal.md#Domain Model`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: SHALL Requirement Classified As Mandatory [CGC-OBLIG-MANDATORY]
WHEN a requirement uses the keyword SHALL without qualification, THE spec-check tool SHALL assign the mandatory obligation level to that claim.

**Postcondition:** Mandatory claims produce higher-severity findings in downstream analysis when violated.

#### Scenario: SHOULD Requirement Classified As Advisory [CGC-OBLIG-ADVISORY]
WHEN a requirement uses the keyword SHOULD, THE spec-check tool SHALL assign the advisory obligation level to that claim.

**Postcondition:** Advisory claims produce lower-severity findings than mandatory claims when violated.

#### Scenario: Informational Content Classified [CGC-OBLIG-INFO]
WHEN a claim is derived from a design property, assumption, or informational section that does not use obligation keywords, THE spec-check tool SHALL assign the informational obligation level.

**Postcondition:** Informational claims contribute to coverage analysis without triggering mandatory-severity findings.

#### Scenario: MAY Requirement Classified As Informational [CGC-OBLIG-OPTIONAL]
WHEN a requirement uses the keyword MAY, THE spec-check tool SHALL assign the informational obligation level to that claim.

**Postcondition:** Optional behavior does not trigger mandatory- or advisory-severity findings when absent or deviated from.

### Requirement: Detect Missing Coverage And Contradictions Across Artifacts [CGC-FIND-MISSING]
WHEN proposal or design claims are compared against capability specs, THE spec-check tool SHALL identify missing coverage, contradiction, and semantic mismatch between upstream intent and downstream requirements and SHALL report each result with supporting evidence.

**References:**
- `proposal.md#Scope`
- `proposal.md#Motivation`
- `proposal.md#Failure Modes`

#### Scenario: Report Uncovered Proposal Claim [CGC-COVER-MISS]
WHEN a proposal or design claim has no corresponding capability requirement or scenario, THE spec-check tool SHALL emit a coverage finding that identifies the uncovered upstream claim and the missing downstream capability coverage.

**Postcondition:** Reviewers can see which upstream intent remains unspecified at the capability level.

#### Scenario: Report Conflicting Requirement Meaning [CGC-COVER-CONFLICT]
IF a capability requirement contradicts a proposal or design claim, THEN THE spec-check tool SHALL emit a contradiction or semantic-mismatch finding that cites both conflicting sources.

**Postcondition:** The conflict is visible with both sides of the disagreement preserved.

#### Scenario: Report Design-To-Spec Semantic Drift [CGC-COVER-DRIFT]
IF a capability requirement partially implements a design claim but omits documented constraints, failure modes, or boundary conditions, THEN THE spec-check tool SHALL emit a semantic-drift finding that identifies the omission.

**Postcondition:** Partial implementations are surfaced rather than mistaken for complete coverage.

### Requirement: Validate Capability Mapping And References [CGC-VALIDATE-REFS]
WHEN the proposal declares capabilities and capability requirements declare references, THE spec-check tool SHALL validate expected spec-file presence and SHALL assess whether each requirement reference points to upstream content that supports the cited behavior.

**References:**
- `proposal.md#Capabilities`
- `proposal.md#Quality Attributes`

#### Scenario: Report Missing Spec File [CGC-REF-MISSFILE]
WHEN the proposal declares a capability and no corresponding active spec file exists for that capability, THE spec-check tool SHALL emit a missing-spec-file finding for the absent capability.

**Postcondition:** Proposal-to-spec contract gaps are explicitly surfaced.

#### Scenario: Report Unsupported Reference [CGC-REF-BADLINK]
IF a requirement references an upstream section whose content does not support the claimed behavior, THEN THE spec-check tool SHALL emit a semantic-mismatch finding that names the requirement and the unsupported reference target. References to archived change artifacts (`openspec/changes/archive/`) SHALL be accepted as valid provenance links regardless of whether their content semantically supports the citing requirement, and SHALL NOT be flagged as unsupported.

**Postcondition:** References remain meaningful evidence links rather than decorative citations. Archived change references are preserved as historical provenance without triggering semantic-support validation.

### Requirement: Task Evidence Consistency [CGC-TASK-EVIDENCE]
WHEN task files with completed change summaries are present, THE spec-check tool SHALL compare task evidence claims against the claim graph and SHALL report inconsistencies between documented task outcomes and specification requirements.

**References:**
- `proposal.md#Domain Model`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Task Summary Contradicts Spec [CGC-TASK-CONFLICT]
IF a completed task change summary describes behavior that contradicts a capability requirement, THEN THE spec-check tool SHALL emit a task-consistency finding citing both the task summary and the conflicting requirement.

**Postcondition:** Implementation deviations documented in task summaries are surfaced during specification analysis.

#### Scenario: Task References Missing Spec Coverage [CGC-TASK-GAP]
IF a completed task change summary references behavior that has no corresponding capability requirement, THEN THE spec-check tool SHALL emit a coverage finding for the undocumented behavior.

**Postcondition:** Implemented but unspecified behavior is visible to reviewers.

### Requirement: Claim Graph Determinism [CGC-GRAPH-DETERMINISM]
WHEN the spec-check tool builds a claim graph from the same parsed inputs on separate runs, THE spec-check tool SHALL produce identical claim graphs.

**References:**
- `proposal.md#Quality Attributes`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Identical Parsed Input Produces Identical Claims [CGC-DETERM-SAME]
WHEN the same set of parsed documents is processed on two separate runs, THE spec-check tool SHALL produce an identical set of typed claims with identical provenance and obligation levels.

**Postcondition:** Claim graph construction is a deterministic function of parsed input.

### Requirement: Coverage Analysis Determinism [CGC-COVERAGE-DETERMINISM]
WHEN the spec-check tool performs coverage analysis on the same claim graph on separate runs, THE spec-check tool SHALL produce identical coverage findings.

**References:**
- `proposal.md#Quality Attributes`

#### Scenario: Same Graph Produces Same Findings [CGC-COVDET-SAME]
WHEN the same claim graph is analyzed for coverage on two separate runs, THE spec-check tool SHALL produce byte-identical coverage findings.

**Postcondition:** Coverage analysis is a deterministic function of the claim graph.

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements
