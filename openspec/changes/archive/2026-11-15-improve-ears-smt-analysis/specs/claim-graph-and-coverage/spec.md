## MODIFIED Requirements

### Requirement: Normalize Parsed Content Into Typed Claims [CGC-NORMALIZE-CLAIMS]
WHEN parsed proposal, design, merged capability spec, or task content is available, THE spec-check tool SHALL construct claims preserving source text, kind, provenance, references, capability identity, and any source-established statement structure and formal disposition.

**References:**
- [Proposal: Domain Model](../../proposal.md#domain-model)
- [Design: Source and identity](../../design.md#source-and-identity)

#### Scenario: Preserve Claim Provenance [CGC-CLAIM-PROVEN]
WHEN a claim is derived from a source item, THE spec-check tool SHALL retain its original file, nearest heading, statement/clause spans, and supporting-content associations when present.

#### Scenario: Reject Provenance-Free Finding Input [CGC-CLAIM-FAIL]
IF a downstream step receives a claim without sufficient provenance, THEN THE spec-check tool SHALL surface an analysis-defect finding instead of issuing an untraceable conclusion.

#### Scenario: Populate Capability Identity On Spec-Derived Claims [CGC-CLAIM-CAP]
WHEN a claim is derived from a merged requirement or scenario, THE spec-check tool SHALL retain the merged capability identity separately from original source provenance.

#### Scenario: Preserve Source Structure Across Normalization [CGC-CLAIM-CLAUSES]
WHEN a parsed item supplies EARS clauses or scenario metadata, THE spec-check tool SHALL carry those structures into formalization context without flattening them into prose-only claims.

#### Requirement model

The [admission lifecycle model](../../models/analysis-lifecycle.als) retains an immutable admitted set and disjoint terminal candidate/error sets. Source-span and clause preservation require parser/claim-graph differential evidence in addition to this abstraction.

### Requirement: Obligation Level Assignment [CGC-OBLIGATION-LEVEL]
WHEN a requirement or scenario is normalized, THE spec-check tool SHALL derive obligation and permission meaning from its parsed structural modal rather than from substring scanning or model output.

**References:**
- [Design: Expression and semantic IR](../../design.md#expression-and-semantic-ir)

#### Scenario: SHALL Requirement Classified As Mandatory [CGC-OBLIG-MANDATORY]
WHEN a statement uses structural `SHALL` or `MUST`, THE spec-check tool SHALL assign mandatory obligation while preserving response negation independently.

#### Scenario: SHOULD Requirement Classified As Advisory [CGC-OBLIG-ADVISORY]
WHEN a statement uses structural `SHOULD`, THE spec-check tool SHALL assign advisory obligation for analysis separately from the mandatory baseline.

#### Scenario: Informational Content Classified [CGC-OBLIG-INFO]
WHEN a design property or informational section lacks an authoritative structural modal, THE spec-check tool SHALL retain informational classification without promoting prose occurrences of modal words into behavioral obligations.

#### Scenario: MAY Requirement Classified As Informational [CGC-OBLIG-OPTIONAL]
WHEN a statement uses structural `MAY`, THE spec-check tool SHALL retain informational obligation metadata and explicit permission semantics rather than require the response.

**Postcondition:** Absence of the permitted behavior is not a violation; an explicit permission may still conflict with mandatory prohibitions.

#### Requirement model

The [admission lifecycle model](../../models/analysis-lifecycle.als) separates source admission from sample outcomes. The replacement [finite static model](../../models/static-semantics.als) checks that advisory and permission rules do not constrain the mandatory baseline; it replaces the former severity-only obligation abstraction. Truth-table tests check logical meanings independently.

## ADDED Requirements

### Requirement: Preserve Every Source Formal Disposition [CGC-FORMAL-SCOPE]
WHEN the claim graph is built, THE spec-check tool SHALL assign every extracted specification statement a source-local identity and explicit eligible or excluded disposition independently of authored identifiers.

**References:**
- [Proposal: Preconditions, Postconditions, and Invariants](../../proposal.md#preconditions-postconditions-and-invariants)
- [Design: Source and identity](../../design.md#source-and-identity)

#### Scenario: Excluded Statements Remain Reviewable [CGC-SCOPE-EXCLUDED]
WHEN a statement is excluded from solver formalization, THE spec-check tool SHALL retain it for qualitative review, coverage context, provenance, and analyzed-scope reporting.

#### Scenario: Duplicate Display Identifiers Do Not Merge Claims [CGC-SCOPE-IDENTITY]
WHEN authored identifiers are missing or duplicated, THE spec-check tool SHALL retain distinct source-local identities and SHALL assign eligible indexes only after the eligibility filter without using display IDs to join sample outcomes.

#### Scenario: Total Disposition Accounting [CGC-SCOPE-PARTITION]
WHEN admission completes, THE spec-check tool SHALL expose disjoint eligible and excluded sets whose union equals the extracted specification-statement set.
