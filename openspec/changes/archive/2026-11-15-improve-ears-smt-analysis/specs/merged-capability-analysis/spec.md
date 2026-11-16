## MODIFIED Requirements

### Requirement: Preserve Source Provenance In Merged Output [MCA-MERGE-PROVEN]
WHEN the spec-check tool emits merged requirements, merged scenarios, and derived claims, THE spec-check tool SHALL preserve original provenance and structured statement metadata while using a separate synthetic capability key for downstream semantic grouping and artifact naming.

**References:**
- [Proposal: Assumptions and Dependencies](../../proposal.md#assumptions-and-dependencies)
- [Design: Source and identity](../../design.md#source-and-identity)

#### Scenario: Source Provenance Survives Merge [MCA-MERGE-SOURCE]
WHEN a selected item originates from a finalized or delta spec, THE spec-check tool SHALL retain its original source spans, EARS/scenario structure, formal disposition, justification, and supporting-content references without rewriting them as synthetic source locations.

#### Scenario: Synthetic Logical Key Groups Capability Artifacts [MCA-MERGE-LOGICAL]
WHEN merged capability artifacts are named or grouped, THE spec-check tool SHALL use `<merged-spec/{capability}>` separately from each item's source-file provenance.

#### Scenario: Synthetic Logical Key Defines Compile-Group Boundary [MCA-MERGE-GROUP-KEY]
WHEN selected claims share a merged capability key, THE spec-check tool SHALL group their admitted formal scope under that key and SHALL apply existing compile-group identity validation before submission.

#### Scenario: Merged Output Ordering Is Deterministic [MCA-MERGE-ORDER]
WHEN identical finalized and delta inputs are merged, THE spec-check tool SHALL produce identical selected item order, retained structure, dispositions, findings, and logical grouping identity.

#### Requirement model

The [admission lifecycle model](../../models/analysis-lifecycle.als) assumes a selected active claim universe; existing merge-selection models remain authoritative. Enriched payload preservation is verified by merge/claim round-trip properties rather than encoded as a new selection policy.

## ADDED Requirements

### Requirement: Discover Concepts Only From Selected Active Content [MCA-CONCEPT-ACTIVE]
WHEN concept discovery begins, THE spec-check tool SHALL provide only the selected merged capability statements and explicitly configured model context as authoritative discovery inputs.

**References:**
- [Design: Interaction Protocols](../../design.md#interaction-protocols)

#### Scenario: Removed Or Replaced Statements Do Not Supply Concepts [MCA-CONCEPT-REMOVED]
WHEN a requirement block is removed or replaced by merge operations, THE spec-check tool SHALL exclude its superseded statement text and nested scenarios from concept discovery and formal analysis while retaining ordinary merge provenance.

#### Scenario: Formal Ineligibility Does Not Delete Merge Content [MCA-CONCEPT-INELIGIBLE]
WHEN a selected statement is formally ineligible, THE spec-check tool SHALL retain the selected merge content and its disposition instead of treating ineligibility as an implicit removal operation.
