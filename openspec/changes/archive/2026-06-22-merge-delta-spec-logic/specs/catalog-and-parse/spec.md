## ADDED Requirements

## MODIFIED Requirements

### Requirement: Discover And Resolve Active Analysis Inputs [CAT-DISCOVER-INPUTS]
WHEN a developer runs `spec-check` with one or more input paths, THE spec-check tool SHALL discover the referenced OpenSpec artifacts, classify proposal, design, spec, and optional task inputs, resolve active capability state from current and in-development specs, and exclude archived change specs from downstream analysis unless the run explicitly allows archived inputs for those provided paths, and SHALL preserve the selected finalized and delta spec sources needed for later per-capability merge.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Define archive activation as an explicit admission policy, not a discovery policy`
- `openspec/changes/merge-delta-spec-logic/proposal.md#Context`
- `openspec/changes/merge-delta-spec-logic/design.md#Proposed Design`

#### Scenario: Resolve Active Capability Set [CAT-DISCOVER-ACTIVE]
WHEN the input set includes finalized capability specs and in-development change specs, THE spec-check tool SHALL build one active capability catalog that uses finalized specs plus at most one selected in-development delta per capability, SHALL surface skipped conflicts as findings, and SHALL preserve the selected finalized and delta documents as merge-eligible inputs for that capability.

**Postcondition:** The active analysis catalog identifies exactly which capability documents will be merged and analyzed and which conflicting deltas were skipped.

#### Scenario: Reject Unreadable Input [CAT-DISCOVER-FAIL]
IF an input path does not exist or is not readable, THEN THE spec-check tool SHALL stop analysis for that run, report the specific unreadable path, and exit with code `2`.

**Postcondition:** No downstream phase runs with an incomplete or ambiguous input catalog.

#### Scenario: Exclude Archived Changes By Default [CAT-DISCOVER-ARCHIVE]
WHILE archived inputs are not explicitly allowed, WHEN the input set includes archived change directories, THE spec-check tool SHALL exclude their recognized documents from the active catalog.

**Postcondition:** Archived documents do not influence active analysis unless the user opts in for the provided archived inputs.

#### Scenario: Allow Explicit Archived Inputs [CAT-DISCOVER-ALLOW-ARCH]
WHERE archive admission is enabled, WHEN a recognized document comes from an explicitly provided archived input path, THE spec-check tool SHALL treat that document as eligible for the active catalog under the same capability-resolution rules as non-archived inputs.

**Postcondition:** Explicitly requested archived content participates in analysis without changing discovery scope.

#### Scenario: Empty Catalog Stops Analysis [CAT-DISCOVER-EMPTY]
IF no active documents survive recognition and catalog admission, THEN THE spec-check tool SHALL stop the run before downstream analysis begins and SHALL surface the classified empty-catalog reason to the CLI.

**Postcondition:** No qualitative, formal, or reporting phase runs against a vacuous active catalog.

### Requirement: Spec Parser EARS Pattern Recognition [CAT-PARSE-EARS]
WHEN the spec-check tool parses a capability spec file, THE spec-check tool SHALL recognize EARS-pattern requirement text using the documented keyword patterns (WHEN/THE...SHALL, IF/THEN THE...SHALL, WHILE/THE...SHALL), SHALL annotate each parsed requirement and scenario with its enclosing delta operation context, SHALL associate each scenario with its enclosing requirement block when present, and SHALL flag requirements that do not follow an EARS pattern or an approved escape-hatch format.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/merge-delta-spec-logic/proposal.md#Scope`
- `openspec/changes/merge-delta-spec-logic/design.md#Component Design`

#### Scenario: EARS Requirement Recognized [CAT-EARS-MATCH]
WHEN a requirement body follows a recognized EARS pattern, THE spec-check tool SHALL classify it with the appropriate EARS type (ubiquitous, event-driven, state-driven, unwanted-behavior, conditional).

**Postcondition:** The parsed requirement carries its EARS classification for downstream analysis.

#### Scenario: Non-EARS Requirement Flagged [CAT-EARS-WARN]
IF a requirement body does not match any recognized EARS pattern and is not marked as an approved escape-hatch, THEN THE spec-check tool SHALL emit a structural finding recommending EARS conformance.

**Postcondition:** Reviewers are alerted to requirements that may lack testable behavioral structure.

#### Scenario: Delta Operation Context Assigned Per Parsed Item [CAT-EARS-DELTA]
WHEN the parser reads a finalized or selected delta spec, THE spec-check tool SHALL assign each parsed requirement and scenario a deterministic delta-operation context derived from the source type and exact enclosing delta section heading, using one of the values `"base"`, `"pre-section"`, `"ADDED"`, `"MODIFIED"`, `"REMOVED"`, or `"RENAMED"`.

**Postcondition:** Downstream merge logic can distinguish base, pre-section, added, modified, removed, and renamed items without re-parsing headings.

#### Scenario: Scenario Parent Association Preserved [CAT-EARS-PARENT]
WHEN the parser reads a scenario after a requirement heading in the same spec document, THE spec-check tool SHALL preserve the identifier of the most recently parsed requirement as the scenario's parent requirement identifier when that identifier exists.

**Postcondition:** Requirement-block merge operations can replace or remove a requirement together with its nested scenarios.

#### Scenario: Scenario Without Identified Parent Preserved [CAT-EARS-NO-PARENT]
IF the parser reads a scenario whose most recently parsed requirement has no identifier, OR if the parser reads a scenario before any requirement heading in the active section, THEN THE spec-check tool SHALL preserve the scenario in parsed output with no parent requirement identifier.

**Postcondition:** Downstream merge logic receives enough structure to surface unsupported standalone scenario content deterministically.

#### Scenario: Finalized Spec Delta Heading Ignored [CAT-EARS-FINAL-DELTA]
IF a finalized spec contains one or more delta section headings, THEN THE spec-check tool SHALL preserve all parsed requirements and scenarios as base content, SHALL emit at most one warning for that finalized spec file, and SHALL include the guidance text `finalized specs should not have Delta Spec Headings`.

**Postcondition:** Malformed finalized specs remain analyzable without changing delta semantics silently.

#### Scenario: Exact Delta Heading Recognition Only [CAT-EARS-EXACT]
WHEN the parser evaluates section headings in a delta spec, THE spec-check tool SHALL change delta-operation context only for the exact headings `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`, and `## RENAMED Requirements`.

**Postcondition:** Approximate, case-variant, or otherwise non-exact heading text is treated as ordinary content and does not silently change semantics.

#### Scenario: Pre-Section Delta Content Preserved Structurally [CAT-EARS-PRE-SECTION]
IF the parser reads requirements or scenarios in a delta spec before the first recognized delta section heading, THEN THE spec-check tool SHALL assign `deltaOperation: "pre-section"` to those parsed items so the merge layer can deterministically identify and exclude them.

**Postcondition:** The merge layer can emit deterministic `spec_merge.pre_section_content` findings without losing source provenance or structure.

### Requirement: Parser Determinism [CAT-PARSE-DETERMINISM]
WHEN the spec-check tool parses the same input content on separate runs, THE spec-check tool SHALL produce identical parsed output, including delta-operation annotations, scenario-parent associations, and pre-section structural state.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/merge-delta-spec-logic/proposal.md#Quality Attributes`

#### Scenario: Identical Input Produces Identical Parse [CAT-DETERM-SAME]
WHEN the same document content is parsed on two separate runs, THE spec-check tool SHALL produce byte-identical parsed models.

**Postcondition:** Parser output is a deterministic function of input content.

## REMOVED Requirements

## RENAMED Requirements
