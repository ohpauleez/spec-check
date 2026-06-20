## ADDED Requirements

### Requirement: Surface Catalog Errors At The CLI Boundary [RAE-CATALOG-ERROR]
WHEN the catalog layer reports that no active documents survived, THE spec-check tool SHALL surface a CLI-visible `CatalogError` with exit code `5` and a cause-specific remediation message.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Failure Modes`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`

#### Scenario: Report No Recognized Documents [RAE-CATALOG-NODOCS]
WHEN catalog construction reports `no_recognized_docs`, THE spec-check tool SHALL emit a message explaining that no OpenSpec proposal, design, or spec documents were found in the provided inputs.

**Postcondition:** Users can distinguish missing relevant inputs from archive-policy exclusions.

#### Scenario: Report Archived-Only Inputs [RAE-CATALOG-ARCHIVE]
WHEN catalog construction reports `all_archived`, THE spec-check tool SHALL emit a message explaining that all recognized documents are archived and SHALL recommend `--allow-archive`.

**Postcondition:** Users receive the specific remediation that can admit their chosen archived inputs.

#### Scenario: Report Policy-Filtered Inputs [RAE-CATALOG-FILTERED]
WHEN catalog construction reports `all_filtered`, THE spec-check tool SHALL emit a message that names the policy reason for exclusion.

**Postcondition:** Policy-based exclusions remain explainable instead of collapsing into a generic empty result.

## MODIFIED Requirements

### Requirement: Emit Bounded Analysis Reports [RAE-EMIT-REPORTS]
WHEN one or more analysis phases complete, THE spec-check tool SHALL write the phase reports and synthesized summary reports defined for the selected analysis mode under the configured output directory. IF the run stops at catalog construction because no active documents survive, THEN THE spec-check tool SHALL report the catalog error instead of emitting vacuous downstream analysis reports.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Quality Attributes`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`

#### Scenario: Emit Phase-Specific Reports [RAE-REPORT-PHASES]
WHEN specs-forward analysis completes for a run, THE spec-check tool SHALL emit distinct reports for qualitative analysis, qualitative properties and invariants, coverage analysis, and logic analysis, plus any optional source or tasks reports enabled for that run.

**Postcondition:** Reviewers can inspect each analytical pass separately instead of relying only on a synthesized summary.

#### Scenario: Emit Code-Derived Evidence Directories [RAE-REPORT-GENSPECS]
WHEN code-backwards analysis completes for a run, THE spec-check tool SHALL persist the `gen_specs/` directory containing code-derived Markdown specifications and the `gen_specs_smt/` directory containing code-derived SMT-LIB artifacts under the configured output directory.

**Postcondition:** Code-derived intermediate artifacts are available for reviewer inspection alongside reports.

#### Scenario: Explain Skipped Report Scope [RAE-REPORT-SKIP]
IF an optional phase is not enabled for a run, THEN THE spec-check tool SHALL explain that skipped scope in the synthesized reporting rather than omit it silently.

**Postcondition:** Reviewers can distinguish intentionally skipped analysis from missing output.

#### Scenario: Suppress Vacuous Reports On Catalog Error [RAE-REPORT-CATALOG]
IF the catalog phase ends in `CatalogError`, THEN THE spec-check tool SHALL NOT emit downstream qualitative, formal, or comparison reports for that run.

**Postcondition:** Report output accurately reflects that analysis never proceeded past catalog construction.

### Requirement: Finding Shape And Severity [RAE-FINDING-SHAPE]
WHEN the spec-check tool creates a finding, THE spec-check tool SHALL use a stable finding shape with required fields: severity, category, provenance, description, rationale, and evidence references. Optional fields include suggestion and related claim identifiers. When catalog-empty conditions are represented as findings or finding-like diagnostics, the same explanatory completeness SHALL apply.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Domain Model`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`

#### Scenario: Finding With All Required Fields [RAE-SHAPE-COMPLETE]
WHEN a finding is created, THE spec-check tool SHALL populate severity, category, provenance, description, rationale, and at least one evidence reference.

**Postcondition:** Every finding is self-describing and reviewable without external context.

#### Scenario: Missing Required Field Rejected [RAE-SHAPE-FAIL]
IF a finding would be emitted without a required field, THEN THE spec-check tool SHALL treat this as an analysis defect and surface it rather than emitting an incomplete finding.

**Postcondition:** The finding pipeline never produces malformed findings.

#### Scenario: Catalog Diagnostic Remains Actionable [RAE-SHAPE-CATALOG]
WHEN the tool surfaces a catalog-empty diagnostic, THE spec-check tool SHALL include the empty-catalog cause and actionable remediation text in the surfaced message.

**Postcondition:** Catalog errors meet the same reviewability standard as normal findings.

## REMOVED Requirements

## RENAMED Requirements
