---
title: ReportingAndEvidence
---

## Purpose

Define the reporting and evidence preservation behavior for the spec-check tool: producing bounded, evidence-preserving output artifacts, final reports, and manifest-based completion records.

```alloy
module ReportingAndEvidence
open util/boolean

// --- Domain vocabulary ---

// Analysis modes determine which phases and reports are produced
abstract sig AnalysisMode {}
one sig BaseMode, SourceBackedMode extends AnalysisMode {}

// Analysis phases form the pipeline
abstract sig Phase {}
one sig QualPass1, QualPass2, CoveragePhase, LogicPhase extends Phase {}   // base phases
one sig SourceTrace, CodeLogic, CodeCompare extends Phase {}                // source-backed phases

// Report file names (stable naming convention per RAE-REPORT-NAMES)
abstract sig ReportName {}
one sig R_1_1, R_1_2, R_1_3, R_1_Logic extends ReportName {}              // base reports
one sig R_2_Trace, R_2_Logic, R_2_Compare, R_Summary extends ReportName {} // additional

// Severity levels for findings
abstract sig Severity {}
one sig ErrorSev, WarningSev, InfoSev extends Severity {}

// Evidence artifacts attached to findings
sig Evidence {
  preserved : one Bool
}

// Provenance: source traceability
sig Provenance {
  srcFile : one Artifact,
  srcHeading : one Heading
}
sig Artifact {}
sig Heading {}

// Findings: the unit of analysis output
sig Finding {
  severity : one Severity,
  hasCategory : one Bool,
  provenance : lone Provenance,
  hasDescription : one Bool,
  hasRationale : one Bool,
  evidenceSet : set Evidence,
  originPhase : one Phase
}

// Output path resolution
abstract sig WriteLoc {}
one sig InsideDir, OutsideDir extends WriteLoc {}

// Write completion state
abstract sig WriteCompletion {}
one sig AtomicComplete, PartialWrite extends WriteCompletion {}

// Manifest entries (for RAE-MANIFEST-SCHEMA)
sig ManifestEntry {
  entryReport : one ReportName,
  checksumValid : one Bool,
  entryPhase : one Phase
}

// --- Catalog construction lifecycle (for RAE-CATALOG-ERROR) ---

// The catalog stage gates all downstream analysis. A run may only complete
// phases once the catalog is Constructed; if no active documents survive,
// catalog construction Aborts the pipeline.
abstract sig CatalogStage {}
one sig CatalogPending, CatalogConstructed, CatalogAborted extends CatalogStage {}

// The three mutually-exclusive empty-catalog reasons classified from input
// counts (mirrors classifyEmptyCatalogReason).
abstract sig CatalogEmptyReason {}
one sig NoRecognizedDocs, AllArchived, AllFiltered extends CatalogEmptyReason {}

// CLI exit codes surfaced by the tool (only the codes named in this spec).
// Code 0 = success, 1 = findings present, 5 = CatalogError.
abstract sig ExitCode {}
one sig ExitSuccess, ExitFindings, ExitCatalogError extends ExitCode {}

// --- Phase-to-report mapping ---
fun phaseToReport : Phase -> ReportName {
  (QualPass1 -> R_1_1) + (QualPass2 -> R_1_2) + (CoveragePhase -> R_1_3) +
  (LogicPhase -> R_1_Logic) + (SourceTrace -> R_2_Trace) +
  (CodeLogic -> R_2_Logic) + (CodeCompare -> R_2_Compare)
}

fun basePhases : set Phase { QualPass1 + QualPass2 + CoveragePhase + LogicPhase }
fun sourcePhases : set Phase { SourceTrace + CodeLogic + CodeCompare }

// Enabled phases depend on mode
fun enabledPhases : set Phase {
  { p : Phase | Run.mode = SourceBackedMode or p in basePhases }
}

// Required reports depend on mode
fun requiredReports : set ReportName {
  phaseToReport[enabledPhases] + R_Summary
}

// --- Run state (behavioral) ---
one sig Run {
  mode : one AnalysisMode,
  var catalog : one CatalogStage,
  var catalogReason : lone CatalogEmptyReason,
  var completedPhases : set Phase,
  var findings : set Finding,
  var reports : set ReportName,
  var manifestPresent : one Bool,
  var manifestFiles : set ReportName,
  var failed : one Bool
}

// --- Finding well-formedness ---
pred finding_wellformed [f : Finding] {
  f.hasCategory = True
  some f.provenance
  f.hasDescription = True
  f.hasRationale = True
  some f.evidenceSet
}

pred finding_evidence_preserved [f : Finding] {
  all e : f.evidenceSet | e.preserved = True
}
```

## Requirements

### Requirement: Surface Catalog Errors At The CLI Boundary [RAE-CATALOG-ERROR]
WHEN the catalog layer reports that no active documents survived, THE spec-check tool SHALL surface a CLI-visible `CatalogError` with exit code `5` and a cause-specific remediation message.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`

#### Scenario: Report No Recognized Documents [RAE-CATALOG-NODOCS]
WHEN catalog construction reports `no_recognized_docs`, THE spec-check tool SHALL emit a message explaining that no OpenSpec proposal, design, or spec documents were found in the provided inputs.

**Postcondition:** Users can distinguish missing relevant inputs from archive-policy exclusions.

##### Evidence
- Implementation: [run-cli.ts:61 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L61), [catalog.ts:233 classifyEmptyCatalogReason()](/src/domain/parser/catalog.ts#L233)
- Test: [cli.test.ts:169 formats no_recognized_docs with input count](/test/contract/cli.test.ts#L169), [catalog.test.ts:101 returns no_recognized_docs for directories without OpenSpec docs](/test/contract/catalog.test.ts#L101)
- Test (integration): [catalog-abort.integration.test.ts:52 aborts pipeline on no_recognized_docs](/test/integration/catalog-abort.integration.test.ts#L52)
- Example:
```typescript
const { formatCatalogEmptyMessage } = await import("./src/cli/run-cli.ts");
const msg = formatCatalogEmptyMessage({ kind: "no_recognized_docs", inputCount: 3 }); //=> type String
msg.includes("No OpenSpec documents found"); //=> true
msg.includes("3"); //=> true
```

#### Scenario: Report Archived-Only Inputs [RAE-CATALOG-ARCHIVE]
WHEN catalog construction reports `all_archived`, THE spec-check tool SHALL emit a message explaining that all recognized documents are archived and SHALL recommend `--allow-archive`.

**Postcondition:** Users receive the specific remediation that can admit their chosen archived inputs.

##### Evidence
- Implementation: [run-cli.ts:63 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L63), [catalog.ts:237 classifyEmptyCatalogReason()](/src/domain/parser/catalog.ts#L237)
- Test: [cli.test.ts:176 formats all_archived with archived count and --allow-archive guidance](/test/contract/cli.test.ts#L176), [catalog.test.ts:27 excludes archived change specs by default](/test/contract/catalog.test.ts#L27)
- Test (integration): [catalog-abort.integration.test.ts:81 aborts pipeline on all_archived](/test/integration/catalog-abort.integration.test.ts#L81)
- Example:
```typescript
const { formatCatalogEmptyMessage } = await import("./src/cli/run-cli.ts");
const msg = formatCatalogEmptyMessage({ kind: "all_archived", archivedCount: 5 }); //=> type String
msg.includes("--allow-archive"); //=> true
msg.includes("5"); //=> true
```

#### Scenario: Report Policy-Filtered Inputs [RAE-CATALOG-FILTERED]
WHEN catalog construction reports `all_filtered`, THE spec-check tool SHALL emit a message that names the policy reason for exclusion.

**Postcondition:** Policy-based exclusions remain explainable instead of collapsing into a generic empty result.

##### Evidence
- Implementation: [run-cli.ts:65 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L65), [catalog.ts:240 classifyEmptyCatalogReason()](/src/domain/parser/catalog.ts#L240)
- Test: [cli.test.ts:183 formats all_filtered with count and filter reason](/test/contract/cli.test.ts#L183), [catalog.test.ts:113 returns all_filtered when all recognized docs are excluded](/test/contract/catalog.test.ts#L113)
- Test (integration): [catalog-abort.integration.test.ts:110 aborts pipeline on all_filtered](/test/integration/catalog-abort.integration.test.ts#L110)
- Example:
```typescript
const { formatCatalogEmptyMessage } = await import("./src/cli/run-cli.ts");
const msg = formatCatalogEmptyMessage({ kind: "all_filtered", filteredCount: 2, filterReason: "capability resolution" }); //=> type String
msg.includes("capability resolution"); //=> true
msg.includes("2"); //=> true
```

#### Requirement model

```alloy
// ===================================================================
// RAE-CATALOG-ERROR: catalog-empty classification, exit code, and the
// suppression of vacuous downstream reports.
//
// Two complementary sub-models:
//   (1) A STATIC classification model that mirrors classifyEmptyCatalogReason
//       (src/domain/parser/catalog.ts): from the observable input predicates
//       it computes exactly one of the three empty reasons. This validates
//       determinism, totality, and precedence of the reason taxonomy.
//   (2) TEMPORAL ties into the Run state machine: an aborted catalog is a
//       failure that suppresses all downstream reports and surfaces the
//       CatalogError exit code.
// ===================================================================

// --- (1) Static classification sub-model ---

// The classifier branches on three observable predicates, mirroring the
// integer-count inputs of classifyEmptyCatalogReason:
//   active   <-> activeCount > 0
//   recog    <-> recognizedCount > 0
//   allArch  <-> excludedArchivedCount = recognizedCount > 0
// Modeled as Bool parameters (no carrier sig) so every existing analysis
// command keeps its scope list unchanged.

// Well-formedness of the count relationships:
//  - active documents are recognized survivors, so active implies recognized;
//  - if every recognized doc is archived then none survive (active is false);
//  - "all archived" presupposes at least one recognized doc.
pred catalogCountsWF [active, recog, allArch : Bool] {
  active = True implies recog = True
  allArch = True implies recog = True
  active = True implies allArch = False
}

// classifyEmptyCatalogReason as a total function of the observable predicates.
// Precedence exactly matches the implementation:
//   active            -> no error (empty result)
//   not recognized    -> NoRecognizedDocs
//   all archived      -> AllArchived
//   otherwise         -> AllFiltered
fun classify [active, recog, allArch : Bool] : lone CatalogEmptyReason {
  (active = True) implies none
  else (recog = False) implies NoRecognizedDocs
  else (allArch = True) implies AllArchived
  else AllFiltered
}

// Only AllArchived carries the `--allow-archive` remediation (RAE-CATALOG-ARCHIVE).
fun remediationAllowArchive : set CatalogEmptyReason { AllArchived }

// Static exit-code numbering: success 0, findings 1, catalog error 5.
fun exitNum [e : ExitCode] : Int {
  (e = ExitSuccess) implies 0
  else (e = ExitFindings) implies 1
  else 5
}

// A reason is produced exactly when the catalog is empty (no active docs).
assert classify_empty_iff_no_active {
  all active, recog, allArch : Bool | catalogCountsWF[active, recog, allArch] implies
    (some classify[active, recog, allArch] iff active = False)
}

// Classification is total on empty catalogs: precisely one reason.
assert classify_total_when_empty {
  all active, recog, allArch : Bool |
    (catalogCountsWF[active, recog, allArch] and active = False) implies
      one classify[active, recog, allArch]
}

// The reason taxonomy respects the implementation precedence: each reason is
// emitted only under its defining condition (mutually exclusive, deterministic).
assert classify_matches_precedence {
  all active, recog, allArch : Bool | catalogCountsWF[active, recog, allArch] implies {
    classify[active, recog, allArch] = NoRecognizedDocs implies recog = False
    classify[active, recog, allArch] = AllArchived implies
      (recog = True and allArch = True)
    classify[active, recog, allArch] = AllFiltered implies
      (recog = True and allArch = False and active = False)
  }
}

// Only the archived-only case recommends --allow-archive.
assert only_archived_recommends_allow_archive {
  remediationAllowArchive = AllArchived
  NoRecognizedDocs not in remediationAllowArchive
  AllFiltered not in remediationAllowArchive
}

// Exit-code numbering matches the codes named in the spec (0/1/5).
assert exit_codes_match_spec {
  exitNum[ExitSuccess] = 0
  exitNum[ExitFindings] = 1
  exitNum[ExitCatalogError] = 5
}

// --- (2) Temporal ties to the Run state machine ---

// The exit code surfaced for the terminal Run state. Catalog abort dominates
// (code 5); otherwise findings raise code 1; a clean run is code 0.
fun runExit : one ExitCode {
  (Run.catalog = CatalogAborted) implies ExitCatalogError
  else (some Run.findings) implies ExitFindings
  else ExitSuccess
}

// RAE-REPORT-CATALOG: an aborted catalog never emits downstream reports.
assert catalog_abort_no_reports {
  always (Run.catalog = CatalogAborted implies no Run.reports)
}

// An aborted catalog is a failed run (and thus, via no_manifest_on_failure,
// never produces a completion manifest).
assert catalog_abort_is_failure {
  always (Run.catalog = CatalogAborted implies
    (Run.failed = True and Run.manifestPresent = False))
}

// Phases run only after the catalog is successfully constructed: any completed
// phase implies the catalog reached CatalogConstructed.
assert phases_require_catalog {
  always (some Run.completedPhases implies Run.catalog = CatalogConstructed)
}

// RAE-CATALOG-ERROR: an aborted catalog surfaces the CatalogError exit code.
// Combined with exit_codes_match_spec (ExitCatalogError = 5) this establishes
// the required "exit code 5" without introducing Int into the temporal search.
assert catalog_abort_surfaces_error_code {
  always (Run.catalog = CatalogAborted implies runExit = ExitCatalogError)
}
```

### Requirement: Emit Bounded Analysis Reports [RAE-EMIT-REPORTS]
WHEN one or more analysis phases complete, THE spec-check tool SHALL write the phase reports and synthesized summary reports defined for the selected analysis mode under the configured output directory. IF the run stops at catalog construction because no active documents survive, THEN THE spec-check tool SHALL report the catalog error instead of emitting vacuous downstream analysis reports.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`

#### Scenario: Emit Phase-Specific Reports [RAE-REPORT-PHASES]
WHEN specs-forward analysis completes for a run, THE spec-check tool SHALL emit distinct reports for qualitative analysis (first pass), qualitative properties and invariants (second pass), coverage analysis, and logic analysis, plus any optional source or tasks reports enabled for that run.

**Postcondition:** Reviewers can inspect each analytical pass separately instead of relying only on a synthesized summary.

##### Evidence
- Implementation: [render.ts:131 writePhaseReports()](/src/domain/reporting/render.ts#L131), [run-cli.ts:349 runReportingPhase()](/src/cli/run-cli.ts#L349)
- Test: [reporting.test.ts:25 writes phase reports at correct naming convention](/test/contract/reporting.test.ts#L25)
- Test (integration): [specs-forward.integration.test.ts:18 produces phase reports and summary](/test/integration/specs-forward.integration.test.ts#L18), [pipeline.integration.test.ts:324 full pipeline produces summary with all finding categories](/test/integration/pipeline.integration.test.ts#L324)

#### Scenario: Emit Code-Derived Evidence Directories [RAE-REPORT-GENSPECS]
WHEN code-backwards analysis completes for a run, THE spec-check tool SHALL persist the `gen_specs/` directory containing code-derived Markdown specifications and the `gen_specs_smt/` directory containing code-derived SMT-LIB artifacts under the configured output directory.

**Postcondition:** Code-derived intermediate artifacts are available for reviewer inspection alongside reports.

##### Evidence
- Implementation: [pipeline-helpers.ts:458 runCodeBackwardsWork()](/src/cli/pipeline-helpers.ts#L458)
- Test (integration): [pipeline.integration.test.ts:160 code-derived spec generation produces gen_specs files](/test/integration/pipeline.integration.test.ts#L160)

#### Scenario: Explain Skipped Report Scope [RAE-REPORT-SKIP]
IF an optional phase is not enabled for a run, THEN THE spec-check tool SHALL explain that skipped scope in the synthesized reporting rather than omit it silently.

**Postcondition:** Reviewers can distinguish intentionally skipped analysis from missing output.

##### Evidence
- Implementation: [render.ts:240 writeSummaryReport()](/src/domain/reporting/render.ts#L240), [pipeline-helpers.ts:81 computeSkippedPhases()](/src/cli/pipeline-helpers.ts#L81)
- Test: [reporting.test.ts:52 includes skipped-phase explanations](/test/contract/reporting.test.ts#L52)
- Test (integration): [specs-forward.integration.test.ts:18 produces phase reports and summary](/test/integration/specs-forward.integration.test.ts#L18)

#### Scenario: Suppress Vacuous Reports On Catalog Error [RAE-REPORT-CATALOG]
IF the catalog phase ends in `CatalogError`, THEN THE spec-check tool SHALL NOT emit downstream qualitative, formal, or comparison reports for that run.

**Postcondition:** Report output accurately reflects that analysis never proceeded past catalog construction.

##### Evidence
- Implementation: [run-cli.ts:178 runIngestionPhases()](/src/cli/run-cli.ts#L178)
- Test (integration): [catalog-abort.integration.test.ts:52 aborts pipeline on no_recognized_docs](/test/integration/catalog-abort.integration.test.ts#L52), [catalog-abort.integration.test.ts:81 aborts pipeline on all_archived](/test/integration/catalog-abort.integration.test.ts#L81), [catalog-abort.integration.test.ts:110 aborts pipeline on all_filtered](/test/integration/catalog-abort.integration.test.ts#L110)

#### Requirement model

```alloy
// --- Report emission: mode-dependent phase output ---

pred complete_phase [p : Phase] {
  // Guard
  p not in Run.completedPhases
  p in enabledPhases
  Run.catalog = CatalogConstructed   // phases run only after catalog survives
  Run.failed = False
  Run.manifestPresent = False    // stale manifest must be removed first
  // Effect: phase marked complete, report written
  Run.completedPhases' = Run.completedPhases + p
  Run.reports' = Run.reports + phaseToReport[p]
  // Findings change only via dedicated emission events (emit_finding /
  // suppress_unsupported_verdict / supersede_finding), so a phase step frames them.
  Run.findings' = Run.findings
  // Frame
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
}

// Base mode produces exactly the base phase reports plus summary
assert base_mode_reports {
  always (
    Run.mode = BaseMode and Run.completedPhases = basePhases and R_Summary in Run.reports
    implies
    Run.reports = (phaseToReport[basePhases] + R_Summary))
}

// Source-backed mode produces all reports
assert source_mode_reports {
  always (
    Run.mode = SourceBackedMode and Run.completedPhases = Phase and R_Summary in Run.reports
    implies
    requiredReports in Run.reports)
}

// Safety: disabled phases never produce reports
assert disabled_phases_no_reports {
  always (all p : Phase |
    p not in enabledPhases implies phaseToReport[p] not in Run.reports)
}

// --- RAE-REPORT-GENSPECS: code-derived evidence directories ---

// The two code-derived output directories produced by code-backwards analysis.
abstract sig GenArtifact {}
one sig GenSpecsDir, GenSpecsSmtDir extends GenArtifact {}   // gen_specs/, gen_specs_smt/

// Code-backwards analysis is represented by the code-derived comparison phase
// (report_2.compare). Directory presence is DERIVED from completedPhases (no
// redundant state): both directories exist exactly when that phase has
// completed. runCodeBackwardsWork persists gen_specs/ and gen_specs_smt/.
fun genArtifactsPresent : set GenArtifact {
  CodeCompare in Run.completedPhases implies (GenSpecsDir + GenSpecsSmtDir) else none
}

// Postcondition: completing code-backwards analysis persists BOTH directories.
assert genspecs_present_when_code_backwards {
  always (CodeCompare in Run.completedPhases implies
    genArtifactsPresent = GenSpecsDir + GenSpecsSmtDir)
}

// The two directories are always produced as a pair, never one without the other.
assert genspecs_paired {
  always (GenSpecsDir in genArtifactsPresent iff GenSpecsSmtDir in genArtifactsPresent)
}

// Base mode never runs code-backwards analysis, so it never emits gen artifacts.
// (Teeth: relies on enabledPhases mode-gating, not just the derivation.)
assert genspecs_only_in_source_mode {
  always (Run.mode = BaseMode implies no genArtifactsPresent)
}

// --- RAE-REPORT-SKIP: skipped scope is explained, not silently omitted ---

// Phases disabled for the run's mode. This set is explicitly computed so the
// synthesized summary can explain the skipped scope rather than omit it.
fun skippedPhases : set Phase { Phase - enabledPhases }

// Enabled and skipped phases partition the pipeline (no phase is both, together
// they cover every phase — nothing is silently dropped).
assert enabled_and_skipped_partition {
  always (no (enabledPhases & skippedPhases))
  always (enabledPhases + skippedPhases = Phase)
}

// In base mode the source-backed phases are exactly the skipped-and-explained set.
assert base_mode_skips_source_phases {
  always (Run.mode = BaseMode implies skippedPhases = sourcePhases)
}
```

### Requirement: Report File Naming Convention [RAE-REPORT-NAMES]
WHEN the spec-check tool writes phase reports, THE spec-check tool SHALL use a stable naming convention that identifies the phase and pass number: `report_1.1.md` for the first qualitative pass (spec quality review), `report_1.2.md` for the second qualitative pass (properties and invariants), `report_1.3.md` for coverage analysis, `report_1.logic.md` for logic analysis, `report_2.trace.md` for source traceability, `report_2.logic.md` for code-derived formal analysis, `report_2.compare.md` for code-backwards comparison, and `report_summary.md` for the synthesized summary.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Phase Report Named Correctly [RAE-NAMES-PHASE]
WHEN the qualitative analysis phase completes its first pass, THE spec-check tool SHALL write the report to `report_1.1.md` under the output directory.

**Postcondition:** Report consumers can locate phase output using the documented naming convention.

##### Evidence
- Implementation: [render.ts:143 writePhaseReports()](/src/domain/reporting/render.ts#L143)
- Test: [reporting.test.ts:25 writes phase reports at correct naming convention](/test/contract/reporting.test.ts#L25)
- Test (integration): [pipeline.integration.test.ts:324 full pipeline produces summary](/test/integration/pipeline.integration.test.ts#L324)

#### Scenario: Code-Derived Logic Report Named Correctly [RAE-NAMES-GENLOGIC]
WHEN code-derived solver analysis completes, THE spec-check tool SHALL write the report to `report_2.logic.md` under the output directory.

**Postcondition:** Code-derived formal analysis is at a predictable path distinct from specs-forward logic analysis.

##### Evidence
- Implementation: [render.ts:168 writePhaseReports()](/src/domain/reporting/render.ts#L168)
- Test: [reporting.test.ts:146 writes code-derived logic report at report_2.logic.md](/test/contract/reporting.test.ts#L146)

#### Scenario: Summary Report Named Correctly [RAE-NAMES-SUMMARY]
WHEN the synthesized summary is generated, THE spec-check tool SHALL write it to `report_summary.md` under the output directory.

**Postcondition:** The summary is always at a predictable path.

##### Evidence
- Implementation: [render.ts:240 writeSummaryReport()](/src/domain/reporting/render.ts#L240)
- Test: [reporting.test.ts:40 writes summary report at report_summary.md](/test/contract/reporting.test.ts#L40)
- Test (integration): [pipeline.integration.test.ts:324 full pipeline produces summary](/test/integration/pipeline.integration.test.ts#L324)

#### Requirement model

```alloy
// --- Naming convention: bijective phase-to-report mapping ---

// The phaseToReport function is injective: no two phases map to the same report
assert naming_injective {
  all disj p1, p2 : Phase |
    (some phaseToReport[p1] and some phaseToReport[p2]) implies
      phaseToReport[p1] != phaseToReport[p2]
}

// Naming is total for all defined phases (every phase has a report name)
assert naming_total_for_phases {
  all p : Phase | some phaseToReport[p]
}

// Monotonicity: completed phases never revert
assert phases_monotonic {
  always (Run.completedPhases in Run.completedPhases')
}
```

### Requirement: Preserve Evidence For Every Surfaced Conclusion [RAE-PRESERVE-EVID]
WHEN the spec-check tool emits a finding or final report conclusion, THE spec-check tool SHALL preserve the provenance, rationale, and supporting artifacts needed for a reviewer to inspect the basis of that conclusion, and SHALL render evidence-bearing report content so that preserved raw values remain inert data rather than report-structure control.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Preserve Solver And Model Artifacts [RAE-EVID-ARTS]
WHEN a finding depends on solver analysis or sampled formalization output, THE spec-check tool SHALL preserve the related generated artifacts or references needed to inspect that evidence.

**Postcondition:** Formal conclusions remain auditable after the run completes.

##### Evidence
- Implementation: [pipeline-helpers.ts:458 runCodeBackwardsWork()](/src/cli/pipeline-helpers.ts#L458)
- Test: [coverage-gaps.test.ts:44 solver and model artifacts are preserved](/test/contract/coverage-gaps.test.ts#L44)
- Test (invariant): [global.invariant.test.ts:207 INV-4 + INV-13: solver artifacts are persisted](/test/invariant/global.invariant.test.ts#L207)

#### Scenario: Preserve Cross-Side Implication Evidence [RAE-EVID-CROSSIMPLY]
WHEN a code-backwards classification depends on cross-side implication analysis, THE spec-check tool SHALL preserve the implication queries, solver results, and classification rationale as evidence attached to the finding.

**Postcondition:** Cross-side comparison verdicts are traceable to their formal basis.

##### Evidence
- Implementation: [pipeline-helpers.ts:558 runBoundedPairwiseComparison()](/src/cli/pipeline-helpers.ts#L558)
- Test (invariant): [global.invariant.test.ts:207 INV-4 + INV-13: solver artifacts are persisted](/test/invariant/global.invariant.test.ts#L207)
- Test (integration): [pipeline.integration.test.ts:273 cross-side comparison pipeline](/test/integration/pipeline.integration.test.ts#L273)

#### Scenario: Prevent Unsupported Verdict [RAE-EVID-FAIL]
IF a final report conclusion would be emitted without preserved provenance or supporting evidence, THEN THE spec-check tool SHALL suppress that unsupported verdict and SHALL surface the missing-evidence condition as a defect.

**Postcondition:** Reported conclusions never outrun the preserved evidence set.

##### Evidence
- Implementation: [render.ts:295 enforceFindingSupport()](/src/domain/reporting/render.ts#L295)
- Test: [reporting.test.ts:57 suppresses finding without required evidence](/test/contract/reporting.test.ts#L57), [reporting.test.ts:103 suppresses finding with empty provenance file](/test/contract/reporting.test.ts#L103)

#### Scenario: Preserve LLM Response As Evidence [RAE-EVID-LLM]
WHEN a finding depends on an LLM-backed analysis response, THE spec-check tool SHALL preserve the full response content as evidence attached to the finding.

**Postcondition:** No final verdict rests on an unpreserved LLM response.

##### Evidence
- Implementation: [qualitative.ts:30 rawResponses](/src/domain/spec-forward/qualitative.ts#L30)
- Test: [qualitative.test.ts:21 runQualitativePasses returns merged findings](/test/contract/qualitative.test.ts#L21)
- Test (property): [code-derived.property.test.ts:40 qualitative review prompts fence all documents](/test/property/code-derived.property.test.ts#L40)
- Test (invariant): [global.invariant.test.ts:126 INV-11: prompts fence document content](/test/invariant/global.invariant.test.ts#L126), [safety-liveness.invariant.test.ts:156 LIVE-10: qualitative analysis completes](/test/invariant/safety-liveness.invariant.test.ts#L156)

#### Scenario: Render Evidence Values As Inert Markdown Data [RAE-EVID-RENDER-SAFE]
WHEN the spec-check tool renders finding descriptions, provenance, related claim identifiers, or evidence values into Markdown reports, THE spec-check tool SHALL neutralize inline Markdown control syntax in those raw values so they cannot render as links, emphasis, inline code spans, headings, list items, block quotes, or extra table cells.

**Postcondition:** Evidence remains inspectable without creating synthetic report structure or misleading reviewer-visible findings.

##### Evidence
- Implementation: [render.ts:37 neutralizeMarkdownInline()](/src/domain/reporting/render.ts#L37), [render.ts:351 renderFindingsReport()](/src/domain/reporting/render.ts#L351)
- Test: [reporting.test.ts:160 neutralizes markdown control payloads in rendered evidence and provenance](/test/contract/reporting.test.ts#L160), [reporting.test.ts:203 neutralization helper escapes block and inline markdown controls](/test/contract/reporting.test.ts#L203), [reporting.test.ts:219 renders merge-conflict and invalid-group evidence as inert data](/test/contract/reporting.test.ts#L219)
- Test (property): [logic.property.test.ts:801 renderer neutralization keeps markdown payloads inert](/test/property/logic.property.test.ts#L801)
- Example:
```typescript
const { neutralizeMarkdownInline } = await import("./src/domain/reporting/render.ts");
const link = neutralizeMarkdownInline("[click](http://evil.example)"); //=> type String
link.includes("\\["); //=> true
neutralizeMarkdownInline("### not a heading").startsWith("\\#"); //=> true
```

#### Requirement model

```alloy
// --- Evidence preservation: every conclusion is auditable ---

// A finding with unpreserved evidence is an analysis defect
pred has_unpreserved_evidence [f : Finding] {
  some e : f.evidenceSet | e.preserved = False
}

// Unsupported verdict: a would-be finding whose evidence is not preserved.
// RAE-EVID-FAIL requires the tool to SUPPRESS that verdict (it never enters the
// findings set) and to SURFACE the missing-evidence condition as a well-formed
// defect finding. Modeled here as a real transition event (wired into
// `transitions`) so the suppression is an observable step, not just an invariant.
pred suppress_unsupported_verdict [wouldBe, defect : Finding] {
  // Guard: catalog constructed, run healthy, candidate has unpreserved evidence
  Run.catalog = CatalogConstructed
  Run.failed = False
  has_unpreserved_evidence[wouldBe]
  wouldBe not in Run.findings
  defect not in Run.findings
  wouldBe != defect
  // The surfaced defect is itself admissible (well-formed, evidence preserved)
  finding_wellformed[defect]
  finding_evidence_preserved[defect]
  // Effect: the defect is recorded; the unsupported verdict is excluded
  Run.findings' = Run.findings + defect
  wouldBe not in Run.findings'
  // Frame: only the findings set changes
  frame_all_but_findings
}

// Safety: all findings in the run have preserved evidence
assert evidence_always_preserved {
  always (all f : Run.findings | finding_evidence_preserved[f])
}

// Safety: no finding exists without provenance
assert provenance_always_present {
  always (all f : Run.findings | some f.provenance)
}

// Liveness: if unpreserved evidence exists, a defect is surfaced
// (modeled via the invariant - any finding that reaches Run.findings is preserved)
assert no_unsupported_verdicts_in_output {
  always (all f : Run.findings | not has_unpreserved_evidence[f])
}

// RAE-EVID-FAIL behavioral guarantee: whenever a suppression step occurs, the
// unsupported verdict is kept out of the findings set and a well-formed defect
// finding is surfaced in its place.
assert suppression_emits_defect {
  always (all w, d : Finding | suppress_unsupported_verdict[w, d] implies
    (d in Run.findings' and w not in Run.findings' and
     finding_wellformed[d] and finding_evidence_preserved[d]))
}

// --- RAE-EVID-ARTS / RAE-EVID-CROSSIMPLY / RAE-EVID-LLM: source-specific
//     evidence that must be preserved for particular analysis bases. ---

// The analysis basis a finding rests on.
abstract sig AnalysisBasis {}
one sig FormalSolverBasis, CrossSideBasis, LLMBasis extends AnalysisBasis {}

// Concrete evidence items that may be attached to a finding.
abstract sig EvidenceSource {}
one sig SolverArtifact, ModelArtifact                       // RAE-EVID-ARTS
  extends EvidenceSource {}
one sig ImplicationQuery, SolverResult, ClassificationRationale  // RAE-EVID-CROSSIMPLY
  extends EvidenceSource {}
one sig LLMResponse                                          // RAE-EVID-LLM
  extends EvidenceSource {}

// The evidence each basis MUST preserve:
//  - solver/model findings preserve their generated artifacts (RAE-EVID-ARTS);
//  - cross-side classifications preserve the implication queries, solver
//    results, and classification rationale (RAE-EVID-CROSSIMPLY);
//  - LLM-backed findings preserve the full response (RAE-EVID-LLM).
fun requiredEvidenceFor : AnalysisBasis -> EvidenceSource {
    FormalSolverBasis -> (SolverArtifact + ModelArtifact)
  + CrossSideBasis -> (ImplicationQuery + SolverResult + ClassificationRationale)
  + LLMBasis -> LLMResponse
}

// Every analysis basis mandates its source-specific evidence.
assert evidence_source_requirements {
  (SolverArtifact + ModelArtifact) in requiredEvidenceFor[FormalSolverBasis]
  (ImplicationQuery + SolverResult + ClassificationRationale) in requiredEvidenceFor[CrossSideBasis]
  LLMResponse in requiredEvidenceFor[LLMBasis]
  all b : AnalysisBasis | some requiredEvidenceFor[b]
}

// --- RAE-EVID-RENDER-SAFE: preserved raw values render as inert Markdown data ---

// Inline/block Markdown control constructs that must never be produced by a raw
// evidence value: links, emphasis, inline code spans, headings, list items,
// block quotes, and extra table cells.
abstract sig MarkdownControl {}
one sig LinkCtl, EmphasisCtl, InlineCodeCtl, HeadingCtl,
        ListItemCtl, BlockQuoteCtl, TableCellCtl extends MarkdownControl {}

// The renderer (neutralizeMarkdownInline) neutralizes every control construct.
fun neutralizedControls : set MarkdownControl { MarkdownControl }

// Whether a rendered raw value can activate report structure. A value the
// renderer produced is inert (never active structure) regardless of whether the
// raw payload contained control syntax, because it is neutralized.
fun rendersAsActiveStructure [rawContainsControl : Bool, neutralized : Bool] : Bool {
  (rawContainsControl = True and neutralized = False) implies True else False
}

// RAE-EVID-RENDER-SAFE: every enumerated control is neutralized, and a
// neutralized render is inert whether or not the raw value contained controls.
assert render_evidence_inert {
  // All seven enumerated control constructs are neutralized (none omitted).
  neutralizedControls = MarkdownControl
  LinkCtl + EmphasisCtl + InlineCodeCtl + HeadingCtl
    + ListItemCtl + BlockQuoteCtl + TableCellCtl in neutralizedControls
  // Neutralized output never renders as active report structure.
  all rawContainsControl : Bool | rendersAsActiveStructure[rawContainsControl, True] = False
}
```

### Requirement: Finding Shape And Severity [RAE-FINDING-SHAPE]
WHEN the spec-check tool creates a finding, THE spec-check tool SHALL use a stable finding shape with required fields: severity, category, provenance, description, rationale, and evidence references. Optional fields include suggestion and related claim identifiers. When catalog-empty conditions are represented as findings or finding-like diagnostics, the same explanatory completeness SHALL apply.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`

#### Scenario: Finding With All Required Fields [RAE-SHAPE-COMPLETE]
WHEN a finding is created, THE spec-check tool SHALL populate severity, category, provenance, description, rationale, and at least one evidence reference.

**Postcondition:** Every finding is self-describing and reviewable without external context.

##### Evidence
- Implementation: [findings.ts:49 Finding](/src/domain/findings.ts#L49), [render.ts:295 enforceFindingSupport()](/src/domain/reporting/render.ts#L295)
- Test: [reporting.test.ts:128 passes finding with all required fields including rationale](/test/contract/reporting.test.ts#L128)
- Test (invariant): [global.invariant.test.ts:50 INV-2: every finding has provenance](/test/invariant/global.invariant.test.ts#L50)

#### Scenario: Missing Required Field Rejected [RAE-SHAPE-FAIL]
IF a finding would be emitted without a required field, THEN THE spec-check tool SHALL treat this as an analysis defect and surface it rather than emitting an incomplete finding.

**Postcondition:** The finding pipeline never produces malformed findings.

##### Evidence
- Implementation: [render.ts:295 enforceFindingSupport()](/src/domain/reporting/render.ts#L295)
- Test: [reporting.test.ts:57 suppresses finding without required evidence as defect](/test/contract/reporting.test.ts#L57), [reporting.test.ts:78 suppresses finding with empty rationale as defect](/test/contract/reporting.test.ts#L78), [reporting.test.ts:103 suppresses finding with empty provenance file as defect](/test/contract/reporting.test.ts#L103)

#### Scenario: Catalog Diagnostic Remains Actionable [RAE-SHAPE-CATALOG]
WHEN the tool surfaces a catalog-empty diagnostic, THE spec-check tool SHALL include the empty-catalog cause and actionable remediation text in the surfaced message.

**Postcondition:** Catalog errors meet the same reviewability standard as normal findings.

##### Evidence
- Implementation: [run-cli.ts:58 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L58)
- Test: [cli.test.ts:194 formats each empty-catalog variant with contextual details](/test/contract/cli.test.ts#L194)
- Example:
```typescript
const { formatCatalogEmptyMessage } = await import("./src/cli/run-cli.ts");
const msg1 = formatCatalogEmptyMessage({ kind: "no_recognized_docs", inputCount: 0 }); //=> type String
msg1.includes("0"); //=> true
const msg2 = formatCatalogEmptyMessage({ kind: "all_archived", archivedCount: 3 }); //=> type String
msg2.includes("--allow-archive"); //=> true
const msg3 = formatCatalogEmptyMessage({ kind: "all_filtered", filterReason: "archive policy", filteredCount: 2 }); //=> type String
msg3.includes("archive policy"); //=> true
```

#### Scenario: Merge And Invalid-Group Findings Preserve Conflict Evidence [RAE-SHAPE-MERGE-CONFLICT-EVIDENCE]
WHEN the logic-analysis pipeline emits `logic.merge_conflict` or `logic.invalid_group`, THE finding SHALL use severity `error`, SHALL include the category, provenance, description, rationale, and evidence references, and SHALL preserve claim-attributed details needed to diagnose the structural defect.

**Merge Evidence:** Function-signature conflicts SHALL preserve the shared sanitized symbol, both raw function names, both claim IDs, and the `[existingClaimId, excludedClaimId]` tuple. Variable-sort conflicts SHALL additionally preserve expected and conflicting sorts. Symbol-kind collisions SHALL preserve both raw symbol names and both declaration kinds, including the same-claim `[claimId, claimId]` edge case.

**Invalid-Group Evidence:** Duplicate raw claim-ID findings SHALL list duplicated raw IDs and affected claims. Sanitized-ID collision findings SHALL list colliding raw IDs and the shared sanitized ID. These findings are structural identity errors, not merge conflicts.

**Severity:** Merge conflicts and invalid compile groups SHALL be `error` severity independent of source obligation, because declaration conflicts and identity aliasing are structural defects rather than satisfiability outcomes.

##### Evidence
- Implementation: [smtlib.ts:77 SpecMergeConflict](/src/domain/formal/smtlib.ts#L77), [logic-analysis.ts:315 conflictToFinding()](/src/domain/formal/logic-analysis.ts#L315), [logic-analysis.ts:200 preflightGroupClaimIds()](/src/domain/formal/logic-analysis.ts#L200), [logic-analysis.ts:562 buildInvalidGroupFinding()](/src/domain/formal/logic-analysis.ts#L562)
- Test: [logic-analysis.test.ts:575 maps each merge conflict kind to merge_conflict finding with stable evidence](/test/contract/logic-analysis.test.ts#L575), [logic-analysis.test.ts:556 rejects duplicate raw claim IDs as invalid group](/test/contract/logic-analysis.test.ts#L556), [logic-analysis.test.ts:619 detects constructed sanitized-id collision in preflight](/test/contract/logic-analysis.test.ts#L619), [smtlib.test.ts:115 detects function signature conflicts and excludes conflicting claims](/test/contract/smtlib.test.ts#L115), [smtlib.test.ts:135 detects variable sort mismatch and excludes later claim](/test/contract/smtlib.test.ts#L135), [smtlib.test.ts:155 detects symbol kind collision across claims](/test/contract/smtlib.test.ts#L155), [smtlib.test.ts:175 detects same-claim symbol kind collision](/test/contract/smtlib.test.ts#L175)
- Test (property): [logic.property.test.ts:700 function-signature conflict histories keep function-conflict-only scope](/test/property/logic.property.test.ts#L700), [logic.property.test.ts:717 constructed sanitized collisions reject with duplicate_sanitized_claim_id](/test/property/logic.property.test.ts#L717)

#### Requirement model

```alloy
// --- Finding shape: structural completeness invariant ---

// A malformed finding (missing required field) is never admitted to the run
pred finding_malformed [f : Finding] {
  not finding_wellformed[f]
}

// Safety: all findings in the run state are well-formed
assert all_findings_wellformed {
  always (all f : Run.findings | finding_wellformed[f])
}

// Safety: malformed findings are never present in run output
assert no_malformed_findings {
  always (no f : Run.findings | finding_malformed[f])
}

// The severity field is always populated (by type constraint)
// Category, provenance, description, rationale, and evidence are checked by finding_wellformed

// --- RAE-SHAPE-MERGE-CONFLICT-EVIDENCE: logic-defect finding taxonomy ---
// Structural defects surfaced by the logic-analysis pipeline. Modeled with
// fixed-scope enumerations + functions (no open carrier sig) so the existing
// analysis commands need no scope changes.

// logic.merge_conflict and logic.invalid_group defect families.
abstract sig LogicDefectKind {}
one sig FunctionSignatureConflict, VariableSortConflict, SymbolKindCollision
  extends LogicDefectKind {}                       // logic.merge_conflict family
one sig DuplicateRawClaimId, SanitizedIdCollision
  extends LogicDefectKind {}                       // logic.invalid_group family

fun mergeConflictKinds : set LogicDefectKind {
  FunctionSignatureConflict + VariableSortConflict + SymbolKindCollision
}
fun invalidGroupKinds : set LogicDefectKind {
  DuplicateRawClaimId + SanitizedIdCollision
}

// Claim-attributed evidence roles a logic-defect finding may preserve.
abstract sig EvidenceRole {}
one sig SharedSanitizedSymbol, BothRawNames, BothClaimIds, ExclusionTuple  // merge core
  extends EvidenceRole {}
one sig BothSorts, BothDeclKinds                                            // kind-specific extras
  extends EvidenceRole {}
one sig DuplicatedRawIds, AffectedClaims, CollidingRawIds, SharedSanitizedId // invalid-group identity
  extends EvidenceRole {}

// The evidence each defect kind MUST preserve, mirroring the "Merge Evidence"
// and "Invalid-Group Evidence" clauses. The merge family shares a common core
// (shared sanitized symbol, both raw names, both claim IDs incl. the same-claim
// [claimId, claimId] edge case, and the [existing, excluded] exclusion tuple);
// variable-sort conflicts add both sorts; symbol-kind collisions add both kinds.
fun requiredRoles : LogicDefectKind -> EvidenceRole {
    FunctionSignatureConflict ->
      (SharedSanitizedSymbol + BothRawNames + BothClaimIds + ExclusionTuple)
  + VariableSortConflict ->
      (SharedSanitizedSymbol + BothRawNames + BothClaimIds + ExclusionTuple + BothSorts)
  + SymbolKindCollision ->
      (SharedSanitizedSymbol + BothRawNames + BothClaimIds + ExclusionTuple + BothDeclKinds)
  + DuplicateRawClaimId -> (DuplicatedRawIds + AffectedClaims)
  + SanitizedIdCollision -> (CollidingRawIds + SharedSanitizedId)
}

// Severity of a logic defect is `error` regardless of source obligation, because
// declaration conflicts and identity aliasing are structural defects, not
// satisfiability outcomes.
fun logicSeverity [k : LogicDefectKind, sourceObligated : Bool] : one Severity {
  ErrorSev
}

// Every logic-defect kind carries a non-empty required-evidence set.
assert every_logic_kind_requires_evidence {
  all k : LogicDefectKind | some requiredRoles[k]
}

// All merge-conflict kinds preserve the shared conflict core.
assert merge_core_evidence {
  all k : mergeConflictKinds |
    (SharedSanitizedSymbol + BothRawNames + BothClaimIds + ExclusionTuple) in requiredRoles[k]
}

// Kind-specific extra evidence is required exactly where the spec mandates it.
assert kind_specific_evidence {
  BothSorts in requiredRoles[VariableSortConflict]
  BothSorts not in requiredRoles[FunctionSignatureConflict]
  BothSorts not in requiredRoles[SymbolKindCollision]
  BothDeclKinds in requiredRoles[SymbolKindCollision]
  BothDeclKinds not in requiredRoles[FunctionSignatureConflict]
  BothDeclKinds not in requiredRoles[VariableSortConflict]
}

// Invalid-group findings preserve identity-conflict evidence and are a family
// disjoint from the merge conflicts (structural identity errors, not merges).
assert invalid_group_identity_evidence {
  DuplicatedRawIds in requiredRoles[DuplicateRawClaimId]
  AffectedClaims in requiredRoles[DuplicateRawClaimId]
  CollidingRawIds in requiredRoles[SanitizedIdCollision]
  SharedSanitizedId in requiredRoles[SanitizedIdCollision]
  no (mergeConflictKinds & invalidGroupKinds)
  mergeConflictKinds + invalidGroupKinds = LogicDefectKind
}

// The taxonomy discriminates: distinct kinds require distinct evidence sets.
assert logic_kinds_distinct_evidence {
  all disj k1, k2 : LogicDefectKind | requiredRoles[k1] != requiredRoles[k2]
}

// No orphan roles: every declared evidence role is required by some kind.
assert logic_roles_all_used {
  all r : EvidenceRole | some k : LogicDefectKind | r in requiredRoles[k]
}

// Logic defects are always error severity, independent of source obligation.
assert logic_defects_are_error {
  all k : LogicDefectKind, o : Bool | logicSeverity[k, o] = ErrorSev
}

// --- RAE-SHAPE-CATALOG: catalog-empty diagnostics are as reviewable as findings ---

// A catalog-empty diagnostic must surface the SAME explanatory completeness as a
// normal finding: it identifies its cause and carries actionable remediation.
// Mirrors formatCatalogEmptyMessage (src/cli/run-cli.ts), where each variant
// reports a quantitative/contextual cause detail plus an actionable next step.

// The cause detail surfaced per reason (the quantitative/contextual fact).
abstract sig CatalogCauseDetail {}
one sig InputCountDetail, ArchivedCountDetail, FilterReasonDetail
  extends CatalogCauseDetail {}                 // 0 inputs / N archived / policy name

// The actionable remediation cue surfaced per reason (the operator's next step).
abstract sig CatalogRemediationCue {}
one sig EnsureRecognizedDocs, UseAllowArchiveFlag, ShowExcludingPolicy
  extends CatalogRemediationCue {}              // add docs / --allow-archive / relax policy

fun catalogCause : CatalogEmptyReason -> CatalogCauseDetail {
    NoRecognizedDocs -> InputCountDetail
  + AllArchived      -> ArchivedCountDetail
  + AllFiltered      -> FilterReasonDetail
}

fun catalogRemediation : CatalogEmptyReason -> CatalogRemediationCue {
    NoRecognizedDocs -> EnsureRecognizedDocs
  + AllArchived      -> UseAllowArchiveFlag
  + AllFiltered      -> ShowExcludingPolicy
}

// A catalog-empty diagnostic is actionable iff it identifies its cause AND
// carries actionable remediation — the catalog analogue of finding_wellformed.
pred catalogDiagnosticActionable [r : CatalogEmptyReason] {
  one catalogCause[r]
  one catalogRemediation[r]
}

// RAE-SHAPE-CATALOG: every empty-catalog variant meets the finding reviewability
// standard, with distinct (non-generic, non-omitted) cause and remediation, and
// the --allow-archive cue reserved for the archived-only reason.
assert catalog_diagnostics_actionable {
  all r : CatalogEmptyReason | catalogDiagnosticActionable[r]
  // Cause + remediation are total and reason-specific (nothing shared or blank).
  all disj r1, r2 : CatalogEmptyReason | catalogCause[r1] != catalogCause[r2]
  all disj r1, r2 : CatalogEmptyReason | catalogRemediation[r1] != catalogRemediation[r2]
  // Consistency with the exit-boundary remediation model (RAE-CATALOG-ARCHIVE):
  // --allow-archive is recommended exactly for the archived-only reason.
  all r : CatalogEmptyReason |
    (catalogRemediation[r] = UseAllowArchiveFlag iff r in remediationAllowArchive)
}
```

### Requirement: Findings Never Silently Removed [RAE-FINDINGS-IMMUTABLE]
WHEN findings are produced by earlier phases, THE spec-check tool SHALL preserve them through later phases. Later phases may add evidence or add new findings, but SHALL NOT remove or suppress prior findings without surfacing that change as a separate finding.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Prior Finding Preserved [RAE-IMMUT-KEEP]
WHEN a later analysis phase runs after earlier findings exist, THE spec-check tool SHALL include all prior findings in the final report alongside any new findings from the later phase.

**Postcondition:** Finding count never decreases between phases.

##### Evidence
- Implementation: [run-state.ts:66 addFindings()](/src/domain/run-state.ts#L66)
- Test: [run-state.test.ts:23 appends findings preserving prior entries](/test/contract/run-state.test.ts#L23)
- Test (property): [run-state.property.test.ts:20 findings are never removed by later phases](/test/property/run-state.property.test.ts#L20)
- Test (invariant): [global.invariant.test.ts:79 INV-6: findings are never silently removed](/test/invariant/global.invariant.test.ts#L79)
- Example:
```typescript
const { createInitialRunState, addFindings } = await import("./src/domain/run-state.ts");
const f1 = { severity: "warning", category: "a", provenance: { file: "a.md" }, description: "a", rationale: "r", evidence: [{ kind: "k", value: "v" }] };
const f2 = { severity: "error", category: "b", provenance: { file: "b.md" }, description: "b", rationale: "r", evidence: [{ kind: "k", value: "v" }] };
let state = createInitialRunState(); //*
state = addFindings(state, [f1]); //*
state.findings.length; //=> 1
state = addFindings(state, [f2]); //*
state.findings.length; //=> 2
state.findings[0] === f1; //=> true
```

#### Scenario: Finding Removal Surfaced [RAE-IMMUT-CHANGE]
IF a later phase determines that a prior finding should be superseded, THEN THE spec-check tool SHALL preserve the original finding and add a new finding that explains the supersession.

**Postcondition:** Reviewers can trace the evolution of conclusions across phases.

##### Evidence
- Implementation: [run-state.ts:66 addFindings()](/src/domain/run-state.ts#L66)
- Test (invariant): [global.invariant.test.ts:79 INV-6: findings are never silently removed](/test/invariant/global.invariant.test.ts#L79)

#### Requirement model

```alloy
// --- Findings immutability: monotonic accumulation ---

// Core safety property: findings never decrease across state transitions
assert findings_never_decrease {
  always (Run.findings in Run.findings')
}

// Finding count monotonicity follows from findings_never_decrease (subset implies <=)
// Integer cardinality comparison omitted to avoid Int scope overhead.

// Shared frame for findings-only events: every Run field except `findings`, and
// every OutputFile, is held constant. Keeps the three emission events DRY.
pred frame_all_but_findings {
  Run.completedPhases' = Run.completedPhases
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  all f : OutputFile | f.pathState' = f.pathState
}

// Admissible emission: a well-formed finding with fully preserved evidence is
// recorded. This is the sole way an ordinary finding enters the findings set,
// which is why complete_phase now frames findings.
pred emit_finding [f : Finding] {
  // Guard
  Run.catalog = CatalogConstructed
  Run.failed = False
  f not in Run.findings
  finding_wellformed[f]
  finding_evidence_preserved[f]
  // Effect
  Run.findings' = Run.findings + f
  // Frame
  frame_all_but_findings
}

// Supersession model (RAE-IMMUT-CHANGE): a later phase may supersede a prior
// finding, but SHALL preserve the original and add a new finding that explains
// the supersession. Modeled as a real transition event: the original is kept in
// the findings set and an admissible supersession that references it is added.
pred supersede_finding [original, supersession : Finding] {
  // Guard
  Run.catalog = CatalogConstructed
  Run.failed = False
  original in Run.findings
  supersession not in Run.findings
  original != supersession
  // The supersession is itself admissible and references the original's provenance
  finding_wellformed[supersession]
  finding_evidence_preserved[supersession]
  original.provenance in supersession.provenance
  // Effect: original preserved, supersession added
  Run.findings' = Run.findings + supersession
  // Frame
  frame_all_but_findings
}

// RAE-IMMUT-CHANGE behavioral guarantee: a supersession step never removes the
// original finding and always records a distinct explanatory supersession.
assert supersede_preserves_original {
  always (all o, s : Finding | supersede_finding[o, s] implies
    (o in Run.findings' and s in Run.findings' and o != s))
}
```

### Requirement: Complete Runs With Atomic Manifest Semantics [RAE-ATOMIC-MANIFEST]
WHEN the spec-check tool writes output artifacts, THE spec-check tool SHALL atomically finalize each artifact, SHALL permit separate formalization attempt-evidence files to exist before successful completion, and SHALL write `manifest.json` last as the sole success marker for the run. The successful manifest SHALL list every produced attempt-evidence file and its SHA-256 checksum together with the other produced output files.

**References:**
- `openspec/specs/reporting-and-evidence/spec.md#Requirement-Complete-Runs-With-Atomic-Manifest-Semantics-RAE-ATOMIC-MANIFEST`
- `openspec/changes/semantic-batching/proposal.md#Preconditions-Postconditions-and-Invariants`
- `openspec/changes/semantic-batching/design.md#Data-Design`

#### Scenario: Successful Manifest Covers Attempt Evidence [RAE-MANIFEST-ATTEMPT-EVIDENCE]
WHEN a run completes successfully after producing one or more `FormalizationAttemptSet` files, THE spec-check tool SHALL write the manifest after those files and SHALL include one entry per file with its relative path and matching SHA-256 checksum.

**Postcondition:** Manifest presence marks the last successful run and mechanically binds all durable attempt evidence to it.

#### Scenario: Attempt Evidence Alone Is Not Completion [RAE-MANIFEST-ATTEMPT-INCOMPLETE]
IF attempt-evidence files exist but the run fails or terminates before `manifest.json` is written, THEN consumers SHALL treat the run as incomplete.

**Postcondition:** Atomic evidence survival does not weaken manifest-last completion semantics.

#### Scenario: Mark Complete Run [RAE-MANIFEST-DONE]
WHEN all selected outputs are written successfully, THE spec-check tool SHALL write a manifest that lists the produced files and their checksums after all prior outputs have been finalized.

**Postcondition:** Consumers can treat manifest presence as the marker of a completed run.

##### Evidence
- Implementation: [manifest.ts:106 writeManifest()](/src/domain/reporting/manifest.ts#L106), [run-cli.ts:375 runReportingPhase()](/src/cli/run-cli.ts#L375)
- Test: [manifest.test.ts:13 writes checksums and manifest last](/test/contract/manifest.test.ts#L13)
- Test (integration): [pipeline.integration.test.ts:210 manifest checksums match actual file content](/test/integration/pipeline.integration.test.ts#L210)

#### Scenario: Prevent Partial Completion Signal [RAE-MANIFEST-FAIL]
IF the run fails before all selected outputs are finalized, THEN THE spec-check tool SHALL NOT leave a final manifest that implies completed output.

**Postcondition:** Partial runs cannot be mistaken for completed analyses.

##### Evidence
- Implementation: [run-cli.ts:349 runReportingPhase()](/src/cli/run-cli.ts#L349)
- Test: [coverage-gaps.test.ts:59 manifest absence signals incomplete run](/test/contract/coverage-gaps.test.ts#L59)

#### Scenario: Invalidate Stale Manifest From Prior Run [RAE-MANIFEST-STALE]
IF the output directory already contains a manifest from a previous run WHEN a new run begins, THEN THE spec-check tool SHALL remove the existing manifest before analysis begins so that a failed rerun cannot be mistaken for a prior successful run.

**Postcondition:** Only a successfully completed run can leave a manifest in the output directory.

##### Evidence
- Implementation: [manifest.ts:133 invalidateStaleManifest()](/src/domain/reporting/manifest.ts#L133), [run-cli.ts:162 runIngestionPhases()](/src/cli/run-cli.ts#L162)
- Test: [manifest.test.ts:46 removes stale manifest from prior run](/test/contract/manifest.test.ts#L46), [manifest.test.ts:59 returns false when no stale manifest exists](/test/contract/manifest.test.ts#L59)

#### Requirement model

```alloy
// --- Atomic manifest: completion marker semantics ---

pred write_manifest {
  // Guard: all required reports written, not failed
  requiredReports in Run.reports
  Run.failed = False
  // Effect: manifest present and lists exactly the produced reports
  Run.manifestPresent' = True
  Run.manifestFiles' = Run.reports
  // Frame
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
}

pred remove_stale_manifest {
  // Guard: manifest present at start of new run, no phases completed yet
  Run.manifestPresent = True
  no Run.completedPhases
  // Effect: manifest removed
  Run.manifestPresent' = False
  Run.manifestFiles' = Run.manifestFiles
  // Frame
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
}

pred run_fails {
  // Guard
  Run.failed = False
  Run.manifestPresent = False    // cannot fail after manifest written (run is complete)
  // Effect: run marked as failed
  Run.failed' = True
  // Frame: state frozen
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
}

// Safety: manifest only present when all required reports are written
assert manifest_implies_complete {
  always (Run.manifestPresent = True implies requiredReports in Run.reports)
}

// Safety: failed runs never have a manifest
assert no_manifest_on_failure {
  always (Run.failed = True implies Run.manifestPresent = False)
}

// Safety: manifest is written AFTER all reports (temporal ordering)
assert manifest_written_last {
  always (Run.manifestPresent' = True and Run.manifestPresent = False
    implies requiredReports in Run.reports)
}

// Liveness: stale manifests are removed before analysis begins
// (Enforced by complete_phase guard: manifestPresent = False)
assert stale_manifest_blocks_phases {
  always (all p : Phase |
    complete_phase[p] implies Run.manifestPresent = False)
}
```

### Requirement: Persist Invocation-Scoped Formalization Attempt Evidence [RAE-FORMAL-ATTEMPT-SETS]
WHEN the spec-check tool records attached formalization attempts, THE spec-check tool SHALL persist one separate atomically finalized `FormalizationAttemptSet` evidence file per formalization invocation. Each envelope SHALL identify its `claimSet` as `specs_forward` or as `generated_spec` with a zero-based invocation ordinal and capability, and SHALL contain attempt indexes that are local to that claim set. Evidence files MAY survive a failed or terminated run and SHALL NOT serve as run-completion markers.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Domain Model`
- `openspec/changes/semantic-batching/design.md#Data Design`
- `openspec/changes/semantic-batching/design.md#Evidence And Artifact Verification`

#### Requirement model

[`formalization-and-logic-analysis/alloy/semantic-batching.als`](../formalization-and-logic-analysis/alloy/semantic-batching.als) checks that every attached attempt reaching a terminal resolution records evidence. Invocation namespaces, atomic evidence-file persistence, failed-run survival, run-start removal, and manifest completion semantics remain reporting-contract obligations outside the model.

#### Scenario: Persist Separate Atomic File Per Invocation [RAE-FORMAL-ATTEMPT-ATOMIC]
WHEN one specs-forward or generated-spec formalization invocation produces attempt evidence, THE spec-check tool SHALL atomically finalize exactly one evidence file containing that invocation's `FormalizationAttemptSet` envelope.

**Postcondition:** A complete evidence file contains attempts from one invocation and one claim-index namespace only.

#### Scenario: Failed Run May Retain Attempt Evidence [RAE-FORMAL-ATTEMPT-FAILED-RUN]
IF a run fails or the process terminates after an attempt-set evidence file is atomically finalized, THEN THE file MAY remain while `manifest.json` is absent.

**Postcondition:** Surviving attempt evidence is auditable partial-run output and cannot be mistaken for a successful run.

### Requirement: Manifest Content Schema [RAE-MANIFEST-SCHEMA]
THE spec-check tool SHALL write the manifest as a UTF-8 JSON file containing an array of output file entries, each with `path` (relative to output directory), `checksum` (SHA-256 hex), and `phase` (originating phase name) fields.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Manifest Entries Match Files [RAE-SCHEMA-MATCH]
WHEN the manifest is written, every entry SHALL reference a file that exists under the output directory with a checksum that matches the file content.

**Postcondition:** Manifest integrity can be verified mechanically.

##### Evidence
- Implementation: [manifest.ts:65 buildManifestEntries()](/src/domain/reporting/manifest.ts#L65)
- Test: [manifest.test.ts:34 manifest entries match actual file checksums](/test/contract/manifest.test.ts#L34)
- Test (property): [manifest.property.test.ts:9 every manifest entry has correct checksum](/test/property/manifest.property.test.ts#L9)
- Test (invariant): [global.invariant.test.ts:113 INV-8: manifest entries have correct checksums](/test/invariant/global.invariant.test.ts#L113)
- Example:
```typescript
const { buildManifestEntries } = await import("./src/domain/reporting/manifest.ts");
const { sha256Hex } = await import("./src/adapters/fs.ts");
const content = "# Report\n";
const entries = buildManifestEntries([{ path: "report.md", phase: "test", content }]); //=> type Array
entries[0].checksum === sha256Hex(content); //=> true
entries[0].path; //=> report.md
```

#### Scenario: Manifest Checksums Are SHA-256 [RAE-SCHEMA-HASH]
WHEN the manifest computes checksums, THE spec-check tool SHALL use SHA-256 and encode the result as lowercase hexadecimal.

**Postcondition:** Checksum format is predictable and interoperable.

##### Evidence
- Implementation: [fs.ts:96 sha256Hex()](/src/adapters/fs.ts#L96)
- Test: [fs.test.ts:29 computes sha256 lowercase hex of correct length](/test/contract/fs.test.ts#L29)
- Test (property): [manifest.property.test.ts:9 every manifest entry has correct checksum](/test/property/manifest.property.test.ts#L9)
- Example:
```typescript
const { sha256Hex } = await import("./src/adapters/fs.ts");
const hash = sha256Hex("hello\n"); //=> type String
hash.length; //=> 64
/^[a-f0-9]{64}$/.test(hash); //=> true
```

#### Requirement model

```alloy
// --- Manifest schema: structural integrity ---

// Every manifest entry references an actually-written report
pred manifest_entries_valid [entries : set ManifestEntry] {
  // Every entry references a written report
  all e : entries | e.entryReport in Run.reports
  // Every entry has a valid checksum
  all e : entries | e.checksumValid = True
  // Every entry references a phase that was completed
  all e : entries | e.entryPhase in Run.completedPhases
  // Coverage: every written report has an entry
  all r : Run.reports | some e : entries | e.entryReport = r
}

// Domain rule (RAE-SCHEMA-MATCH): a ManifestEntry only exists to describe a
// written manifest. So whenever a manifest is present, every entry must
// reference a written report, a completed originating phase, and carry a valid
// (matching) checksum. This is entry-level SOUNDNESS only -- it deliberately
// does NOT force every report to have an entry, so it never prunes the
// reachability of manifest-present states in scenarios with few entries.
// Report-level COVERAGE ("the manifest lists the produced files") is modeled
// separately via Run.manifestFiles (see manifest_lists_all_reports).
fact manifest_entries_describe_run {
  always (Run.manifestPresent = True implies
    (all e : ManifestEntry |
      e.entryReport in Run.reports and
      e.entryPhase in Run.completedPhases and
      e.checksumValid = True))
}

// Safety: manifest entries always reference existing reports
assert manifest_entries_match_files {
  always (Run.manifestPresent = True implies
    (all e : ManifestEntry | e.entryReport in Run.reports))
}

// Safety: manifest entries have valid checksums
assert manifest_checksums_valid {
  always (Run.manifestPresent = True implies
    (all e : ManifestEntry | e.checksumValid = True))
}
```

### Requirement: Output Directory Confinement [RAE-OUTPUT-CONFINE]
WHEN the spec-check tool writes any output artifact, THE spec-check tool SHALL confine the write to the configured output directory and SHALL reject any write path that resolves outside that directory.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Write Within Output Directory [RAE-CONFINE-PASS]
WHEN an output path resolves to a location within the configured output directory, THE spec-check tool SHALL allow the write.

**Postcondition:** The artifact is created at the intended location.

##### Evidence
- Implementation: [fs.ts:32 resolveConfinedOutputPath()](/src/adapters/fs.ts#L32)
- Test: [fs.test.ts:11 allows path within output directory](/test/contract/fs.test.ts#L11)
- Test (invariant): [global.invariant.test.ts:102 INV-7: all writes are confined](/test/invariant/global.invariant.test.ts#L102)
- Example:
```typescript
const { resolveConfinedOutputPath } = await import("./src/adapters/fs.ts");
const { toOutputDirPath, toRelativePath } = await import("./src/domain/branded.ts");
const result = resolveConfinedOutputPath(toOutputDirPath("/tmp/out"), toRelativePath("report.md")); //=> /tmp/out/report.md
```

#### Scenario: Write Outside Output Directory Rejected [RAE-CONFINE-FAIL]
IF an output path resolves to a location outside the configured output directory (including via symlinks or `..` traversal), THEN THE spec-check tool SHALL reject the write with a fatal error.

**Postcondition:** No file is written outside the declared output boundary.

##### Evidence
- Implementation: [fs.ts:32 resolveConfinedOutputPath()](/src/adapters/fs.ts#L32)
- Test: [fs.test.ts:17 rejects path traversal at branding boundary](/test/contract/fs.test.ts#L17), [fs.test.ts:23 rejects absolute path at branding boundary](/test/contract/fs.test.ts#L23)
- Test (invariant): [global.invariant.test.ts:102 INV-7: all writes are confined](/test/invariant/global.invariant.test.ts#L102)
- Example:
```typescript
const { resolveConfinedOutputPath } = await import("./src/adapters/fs.ts");
const { toOutputDirPath, toRelativePath } = await import("./src/domain/branded.ts");
resolveConfinedOutputPath(toOutputDirPath("/tmp/out"), toRelativePath("../../etc/passwd")); //=> throws Error
```

#### Requirement model

```alloy
// --- Output confinement: all writes stay within boundary ---

// A write attempt has a resolved location
sig WriteAttempt {
  resolvedLoc : one WriteLoc,
  writeResult : one WriteCompletion
}

pred write_confined [w : WriteAttempt] {
  w.resolvedLoc = InsideDir
}

pred write_rejected [w : WriteAttempt] {
  w.resolvedLoc = OutsideDir
  w.writeResult = PartialWrite    // rejected: nothing written
}

// Safety: no successful write ever targets outside the output directory
assert no_write_outside_boundary {
  all w : WriteAttempt |
    w.resolvedLoc = OutsideDir implies w.writeResult != AtomicComplete
}

// Safety: all completed writes are inside the output directory
assert all_writes_confined {
  all w : WriteAttempt |
    w.writeResult = AtomicComplete implies w.resolvedLoc = InsideDir
}

// Enforcement: the tool rejects outside writes (domain rule)
fact confinement_enforced {
  all w : WriteAttempt |
    w.resolvedLoc = OutsideDir implies w.writeResult != AtomicComplete
}
```

### Requirement: Atomic Output Writes [RAE-OUTPUT-ATOMIC]
WHEN the spec-check tool writes an output file, THE spec-check tool SHALL write to a temporary file first and rename it into place so that interrupted writes do not leave partial files at the final path.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Successful Atomic Write [RAE-ATOMIC-PASS]
WHEN an output file write completes successfully, THE spec-check tool SHALL rename the temporary file to the final path.

**Postcondition:** The final path contains complete content.

##### Evidence
- Implementation: [fs.ts:66 writeOutputAtomic()](/src/adapters/fs.ts#L66)
- Test: [fs.test.ts:35 writes atomic output file with correct content](/test/contract/fs.test.ts#L35)
- Test (invariant): [global.invariant.test.ts:197 INV-3: writeOutputAtomic produces correct content via atomic rename](/test/invariant/global.invariant.test.ts#L197)
- Example:
```typescript
const { writeOutputAtomic } = await import("./src/adapters/fs.ts");
const { toOutputDirPath, toRelativePath } = await import("./src/domain/branded.ts");
const { mkdtemp, readFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = await mkdtemp(join(tmpdir(), "rae-atomic-")); //*
await writeOutputAtomic(toOutputDirPath(dir), toRelativePath("out.md"), "complete\n"); //*
const content = await readFile(join(dir, "out.md"), "utf8"); //=> complete
```

#### Scenario: Interrupted Write Leaves No Partial File [RAE-ATOMIC-INTERRUPT]
IF the process is interrupted during an output file write, THEN the final path SHALL NOT contain partial content. The temporary file may be orphaned.

**Postcondition:** Consumers of the output directory never encounter partially written files at final paths.

##### Evidence
- Implementation: [fs.ts:66 writeOutputAtomic()](/src/adapters/fs.ts#L66)
- Test: [coverage-gaps.test.ts:72 writeOutputAtomic uses temp+rename to prevent partial writes](/test/contract/coverage-gaps.test.ts#L72)

#### Requirement model

```alloy
// --- Atomic writes: temp-file-then-rename protocol ---

// Model the write lifecycle as states of a file path
abstract sig FilePathState {}
one sig Absent, TempWriting, FinalComplete extends FilePathState {}

sig OutputFile {
  var pathState : one FilePathState
}

pred atomic_write_success [f : OutputFile] {
  // Guard: path is currently absent (no prior content)
  f.pathState = Absent
  // Effect: transitions through temp to final atomically
  // In the model, the final state is FinalComplete (temp is invisible to consumers)
  f.pathState' = FinalComplete
}

pred atomic_write_interrupt [f : OutputFile] {
  // Guard: write was in progress (temp file exists)
  f.pathState = Absent or f.pathState = TempWriting
  // Effect: final path stays absent (only temp may be orphaned)
  f.pathState' = Absent
}

// Safety: final path never contains partial content
assert no_partial_at_final_path {
  always (all f : OutputFile | f.pathState != TempWriting)
}

// Safety: successful writes always reach FinalComplete
assert successful_writes_complete {
  always (all f : OutputFile |
    atomic_write_success[f] implies f.pathState' = FinalComplete)
}

// Note: TempWriting is an intermediate state that is never visible at the final path.
// The model abstracts this by ensuring pathState is either Absent or FinalComplete.
// The TempWriting state exists only as a modeling artifact for the interrupt case.
fact no_temp_at_final {
  always (all f : OutputFile | f.pathState in (Absent + FinalComplete))
}
```

### State machine and invariant checks

```alloy
// --- Transition system ---

pred stutter {
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  all f : OutputFile | f.pathState' = f.pathState
}

// --- Catalog construction events (RAE-CATALOG-ERROR) ---

// Catalog construction succeeds: at least one active document survived.
pred construct_catalog {
  // Guard: catalog not yet decided
  Run.catalog = CatalogPending
  Run.failed = False
  // Effect: catalog is constructed; phases may now run
  Run.catalog' = CatalogConstructed
  // Frame
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalogReason' = Run.catalogReason
  all f : OutputFile | f.pathState' = f.pathState
}

// Catalog construction aborts: no active document survived. The run fails with
// a CatalogError classified by one of the three empty reasons, and NO
// downstream reports are ever produced (RAE-REPORT-CATALOG).
pred abort_catalog [r : CatalogEmptyReason] {
  // Guard: catalog not yet decided, nothing produced yet
  Run.catalog = CatalogPending
  no Run.completedPhases
  no Run.reports
  Run.failed = False
  // Effect: catalog aborts, reason recorded, run marked failed
  Run.catalog' = CatalogAborted
  Run.catalogReason' = r
  Run.failed' = True
  // Frame: no phases, no reports, no manifest ever produced on this path
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  all f : OutputFile | f.pathState' = f.pathState
}

pred write_summary {
  // Guard: all enabled phases completed
  enabledPhases in Run.completedPhases
  Run.failed = False
  R_Summary not in Run.reports
  // Effect: summary report added
  Run.reports' = Run.reports + R_Summary
  // Frame
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  all f : OutputFile | f.pathState' = f.pathState
}

pred init_state {
  Run.catalog = CatalogPending
  no Run.catalogReason
  no Run.completedPhases
  no Run.findings
  no Run.reports
  Run.manifestPresent = False
  no Run.manifestFiles
  Run.failed = False
  all f : OutputFile | f.pathState = Absent
}

fact transitions {
  init_state and always (
    // Catalog construction (must precede any phase)
    construct_catalog
    or (some r : CatalogEmptyReason | abort_catalog[r])
    // Phase execution
    or (some p : Phase | complete_phase[p])
    // Findings emission (admissibility-gated)
    or (some f : Finding | emit_finding[f])
    or (some w, d : Finding | suppress_unsupported_verdict[w, d])
    or (some o, s : Finding | supersede_finding[o, s])
    // Summary generation
    or write_summary
    // Manifest
    or write_manifest
    or remove_stale_manifest
    // Failure
    or run_fails
    // File operations
    or (some f : OutputFile | atomic_write_success[f])
    or (some f : OutputFile | atomic_write_interrupt[f])
    // Stutter
    or stutter
  )
}

// Frame condition: complete_phase must also frame OutputFile
fact phase_frames_files {
  always ((some p : Phase | complete_phase[p]) implies
    (all f : OutputFile | f.pathState' = f.pathState))
}

// Frame condition: manifest and failure events frame OutputFile
fact manifest_frames_files {
  always ((write_manifest or remove_stale_manifest or run_fails) implies
    (all f : OutputFile | f.pathState' = f.pathState))
}

// Frame condition: write_summary frames OutputFile
fact summary_frames_files {
  always (write_summary implies
    (all f : OutputFile | f.pathState' = f.pathState))
}

// Frame condition: file operations frame Run state
fact file_ops_frame_run {
  always ((some f : OutputFile | atomic_write_success[f] or atomic_write_interrupt[f]) implies (
    Run.completedPhases' = Run.completedPhases and
    Run.findings' = Run.findings and
    Run.reports' = Run.reports and
    Run.manifestPresent' = Run.manifestPresent and
    Run.manifestFiles' = Run.manifestFiles and
    Run.failed' = Run.failed and
    Run.catalog' = Run.catalog and
    Run.catalogReason' = Run.catalogReason))
}

// --- Analysis rule: only well-formed findings enter the pipeline ---
fact only_wellformed_findings {
  always (all f : Run.findings | finding_wellformed[f])
  always (all f : Run.findings | finding_evidence_preserved[f])
}

// --- Commands ---

run show {} for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 2 WriteAttempt, 2 OutputFile, 8 steps

run scenario_base_mode_complete {
  eventually (Run.manifestPresent = True and Run.mode = BaseMode)
} for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps

run scenario_failure_no_manifest {
  eventually (Run.failed = True and Run.manifestPresent = False)
} for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 6 steps

check findings_never_decrease for 4 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 2 OutputFile, 15 steps expect 0

check all_findings_wellformed for 4 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

check evidence_always_preserved for 4 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

check manifest_implies_complete for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 12 steps expect 0

check no_manifest_on_failure for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

check no_write_outside_boundary for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 3 WriteAttempt, 1 OutputFile, 5 steps expect 0

check no_partial_at_final_path for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 3 OutputFile, 10 steps expect 0

check disabled_phases_no_reports for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

check phases_monotonic for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

// Report emission (RAE-EMIT-REPORTS)
check base_mode_reports for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 12 steps expect 0

check source_mode_reports for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 14 steps expect 0

// Naming convention (RAE-REPORT-NAMES)
check naming_injective for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check naming_total_for_phases for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

// Evidence preservation (RAE-PRESERVE-EVID)
check provenance_always_present for 4 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

check no_unsupported_verdicts_in_output for 4 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

// Finding shape (RAE-FINDING-SHAPE)
check no_malformed_findings for 4 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

// Atomic manifest ordering (RAE-ATOMIC-MANIFEST)
check manifest_written_last for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 12 steps expect 0

check stale_manifest_blocks_phases for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  2 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

// Manifest schema (RAE-MANIFEST-SCHEMA)
check manifest_entries_match_files for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  3 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 12 steps expect 0

check manifest_checksums_valid for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  3 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 12 steps expect 0

// Output confinement (RAE-OUTPUT-CONFINE)
check all_writes_confined for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 3 WriteAttempt, 1 OutputFile, 5 steps expect 0

// Atomic output writes (RAE-OUTPUT-ATOMIC)
check successful_writes_complete for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 3 OutputFile, 10 steps expect 0

// Catalog-error classification, exit codes, and report suppression (RAE-CATALOG-ERROR)
check classify_empty_iff_no_active for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check classify_total_when_empty for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check classify_matches_precedence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check only_archived_recommends_allow_archive for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check exit_codes_match_spec for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps, 5 Int expect 0

check catalog_abort_no_reports for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

check catalog_abort_is_failure for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

check phases_require_catalog for 3 Finding, 2 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 12 steps expect 0

check catalog_abort_surfaces_error_code for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

run scenario_catalog_abort {
  eventually (Run.catalog = CatalogAborted and some Run.catalogReason)
} for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 8 steps

run scenario_classify_all_reasons {
  some a1, r1, x1, a2, r2, x2, a3, r3, x3 : Bool |
    classify[a1, r1, x1] = NoRecognizedDocs and
    classify[a2, r2, x2] = AllArchived and
    classify[a3, r3, x3] = AllFiltered
} for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps

// Findings emission events: suppression and supersession (RAE-EVID-FAIL, RAE-IMMUT-CHANGE)
check suppression_emits_defect for 4 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

check supersede_preserves_original for 4 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps expect 0

run scenario_suppress_unsupported {
  eventually (some w, d : Finding | suppress_unsupported_verdict[w, d])
} for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 8 steps

run scenario_supersede {
  eventually (some o, s : Finding | supersede_finding[o, s])
} for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 10 steps

// Logic-defect finding taxonomy: evidence roles + error severity (RAE-SHAPE-MERGE-CONFLICT-EVIDENCE)
check every_logic_kind_requires_evidence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check merge_core_evidence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check kind_specific_evidence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check invalid_group_identity_evidence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check logic_kinds_distinct_evidence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check logic_roles_all_used for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check logic_defects_are_error for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

run scenario_logic_defect_taxonomy {
  ExclusionTuple in requiredRoles[FunctionSignatureConflict]
  BothSorts in requiredRoles[VariableSortConflict]
  BothDeclKinds in requiredRoles[SymbolKindCollision]
  SharedSanitizedId in requiredRoles[SanitizedIdCollision]
} for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps

// Catalog-empty diagnostics stay as reviewable as findings (RAE-SHAPE-CATALOG)
check catalog_diagnostics_actionable for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

run scenario_catalog_diagnostic_actionable {
  all r : CatalogEmptyReason |
    some catalogCause[r] and some catalogRemediation[r]
} for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps

// Code-derived gen artifacts (RAE-REPORT-GENSPECS)
check genspecs_present_when_code_backwards for 2 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 12 steps expect 0

check genspecs_paired for 2 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 12 steps expect 0

check genspecs_only_in_source_mode for 3 Finding, 2 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 12 steps expect 0

run scenario_genspecs_emitted {
  Run.mode = SourceBackedMode
  eventually (CodeCompare in Run.completedPhases
    and genArtifactsPresent = GenSpecsDir + GenSpecsSmtDir)
} for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 8 steps

// Skipped-scope explanation (RAE-REPORT-SKIP)
check enabled_and_skipped_partition for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check base_mode_skips_source_phases for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

run scenario_skip_explained {
  Run.mode = BaseMode
  skippedPhases = sourcePhases and some skippedPhases
} for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps

// Source-specific evidence + inert rendering (RAE-EVID-ARTS/CROSSIMPLY/LLM, RAE-EVID-RENDER-SAFE)
check evidence_source_requirements for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

check render_evidence_inert for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps expect 0

run scenario_evidence_and_render {
  // every analysis basis mandates its source-specific evidence
  ModelArtifact in requiredEvidenceFor[FormalSolverBasis]
  SolverResult in requiredEvidenceFor[CrossSideBasis]
  LLMResponse in requiredEvidenceFor[LLMBasis]
  // renderer semantics: raw control activates structure ONLY when not neutralized
  rendersAsActiveStructure[True, False] = True
  rendersAsActiveStructure[True, True] = False
  rendersAsActiveStructure[False, False] = False
} for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  1 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 3 steps
```
