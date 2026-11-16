## MODIFIED Requirements

### Requirement: Spec Parser EARS Pattern Recognition [CAT-PARSE-EARS]
WHEN the spec-check tool parses a capability spec file, THE spec-check tool SHALL parse complete source statements using the simplified strict project EARS grammar and SHALL preserve delta context and scenario parent associations independently of formal eligibility.

**References:**
- [Proposal: Scope](../../proposal.md#scope)
- [Design: Surface grammar and annotations](../../design.md#surface-grammar-and-annotations)

#### Scenario: EARS Requirement Recognized [CAT-EARS-MATCH]
WHEN a complete statement matches ubiquitous, state-driven, event-driven, unwanted-behavior, or complex syntax, THE spec-check tool SHALL retain its ordered clause spans, subject, modal, response, and response-negation flag.

**Postcondition:** Classification follows structure, not substring presence; generic `conditional` is not a separate type.

#### Scenario: Non-EARS Requirement Flagged [CAT-EARS-WARN]
IF a statement lacks a supported EARS or justified supported alternative representation, THEN THE spec-check tool SHALL emit a structural diagnostic and SHALL mark the statement formally ineligible without removing it from parsed output.

#### Scenario: Delta Operation Context Assigned Per Parsed Item [CAT-EARS-DELTA]
WHEN a finalized or selected delta spec is parsed, THE spec-check tool SHALL assign each requirement and scenario its deterministic `base`, `pre-section`, `ADDED`, `MODIFIED`, `REMOVED`, or `RENAMED` context from the source type and exact enclosing heading.

#### Scenario: Scenario Parent Association Preserved [CAT-EARS-PARENT]
WHEN a scenario follows an identified requirement in the same active section, THE spec-check tool SHALL retain that requirement's identifier as the scenario parent independently of whether either statement is formally eligible.

#### Scenario: Scenario Without Identified Parent Preserved [CAT-EARS-NO-PARENT]
IF a scenario has no identified enclosing requirement in the active section, THEN THE spec-check tool SHALL preserve the scenario with no parent identifier for deterministic merge diagnostics.

#### Scenario: Finalized Spec Delta Heading Ignored [CAT-EARS-FINAL-DELTA]
IF a finalized spec contains delta headings, THEN THE spec-check tool SHALL treat its items as base content and SHALL emit at most one warning containing `finalized specs should not have Delta Spec Headings` for that file.

#### Scenario: Exact Delta Heading Recognition Only [CAT-EARS-EXACT]
WHEN a delta heading is evaluated, THE spec-check tool SHALL change operation context only for exact `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`, or `## RENAMED Requirements` headings outside fenced content.

#### Scenario: Pre-Section Delta Content Preserved Structurally [CAT-EARS-PRE-SECTION]
IF a delta item occurs before a recognized delta heading, THEN THE spec-check tool SHALL preserve it with `pre-section` context and original source structure for merge exclusion findings.

#### Scenario: Malformed Clause Order Rejected [CAT-EARS-STRICT]
IF a statement has reversed drivers, missing required commas or `THEN`, empty clauses, multiple primary modals, unclosed quoting, or trailing normative statements, THEN THE spec-check tool SHALL diagnose the precise source span and SHALL exclude the affected statement from formalization.

#### Scenario: Keyword Substrings Remain Prose [CAT-EARS-TOKENS]
WHEN a keyword-like substring appears inside a word, quote, inline code span, or response content, THE spec-check tool SHALL treat it as clause content rather than as a structural driver.

#### Scenario: Optional Feature Extension Requires Selection [CAT-EARS-WHERE]
IF a statement uses `WHERE` without the configured `where` extension, THEN THE spec-check tool SHALL retain its recognized extension structure and SHALL report formal ineligibility with extension-enablement guidance.

**Postcondition:** With `analysis.earsExtensions: ["where"]`, the same well-formed statement is eligible; the default extension list is empty.

#### Scenario: Modal Tokens And Negation Preserved [CAT-EARS-MODALS]
WHEN a statement uses `SHALL`, `MUST`, `SHOULD`, or `MAY`, THE spec-check tool SHALL retain that structural modal and SHALL allow explicit response negation for `SHALL NOT`, `MUST NOT`, or `SHOULD NOT`.

#### Scenario: Ambiguous Permission Negation Rejected [CAT-EARS-MAY-NOT]
IF a statement uses `MAY NOT`, THEN THE spec-check tool SHALL diagnose ambiguous permission negation rather than infer a prohibition.

#### Requirement model

The [admission lifecycle model](../../models/analysis-lifecycle.als) checks that excluded claims cannot enter sampling or queries. Grammar acceptance and reversible spans are verified by the independent parser contract/property corpus; the lifecycle abstraction does not prove English parsing correctness.

## ADDED Requirements

### Requirement: Separate Statements From Supporting Content [CAT-STATEMENT-SPANS]
WHEN the spec-check tool extracts requirement or scenario content, THE spec-check tool SHALL separate the statement, references, justification, postcondition, metadata, fenced models, evidence, and supplementary content with reversible source spans.

**References:**
- [Design: Source and identity](../../design.md#source-and-identity)

#### Scenario: Embedded Model Remains Separate [CAT-SPANS-FENCES]
WHEN a requirement block contains a fenced Alloy model or evidence section, THE spec-check tool SHALL retain it separately and SHALL omit it from EARS statement text and admitted SMT assumptions.

#### Scenario: Normalized Text Maps To Source [CAT-SPANS-NORMALIZE]
WHEN multiline text or CRLF input is normalized, THE spec-check tool SHALL retain original source mapping so every clause diagnostic identifies its source range without inventing line positions.

#### Scenario: Source Statement Limit Is Visible [CAT-SPANS-BOUND]
IF a statement exceeds the effective byte bound of 65,536 bytes by default, THEN THE spec-check tool SHALL preserve its source reference and SHALL emit an explicit eligibility limitation before model work.

### Requirement: Admit Explicit Alternative And Scenario Forms [CAT-FORMAL-DISPOSITION]
WHEN the spec-check tool evaluates a non-EARS representation or scenario, THE spec-check tool SHALL record its supported formal disposition and SHALL preserve unsupported content with a reason.

**References:**
- [Design: Surface grammar and annotations](../../design.md#surface-grammar-and-annotations)

#### Scenario: Justification Does Not Supply Semantics [CAT-FORMAT-JUSTIFIED]
IF a non-EARS requirement has `**Format justification:**` but no supported formal representation, THEN THE spec-check tool SHALL retain the justification and SHALL mark formalization unsupported rather than guess its logical structure.

#### Scenario: Scenario Refinement Is The Default [CAT-SCENARIO-DEFAULT]
WHEN an EARS scenario has no explicit scenario-kind metadata, THE spec-check tool SHALL classify it as a refinement and SHALL retain its postcondition scoped to that scenario.

#### Scenario: Explicit Examples Are Distinguished [CAT-SCENARIO-EXAMPLE]
WHEN a scenario declares `**Scenario kind:** example` or `prohibited-example`, THE spec-check tool SHALL classify it accordingly and SHALL require source-spanned `**Input:**` and respectively `**Expected:**` or `**Forbidden:**` fields for separate predicate formalization before solver admission.

#### Scenario: Invalid Metadata Remains Visible [CAT-SCENARIO-METADATA]
IF scenario-kind metadata is unknown or duplicated, THEN THE spec-check tool SHALL preserve it and SHALL diagnose the ambiguity instead of choosing a kind silently.
