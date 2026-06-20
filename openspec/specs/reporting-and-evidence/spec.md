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
  var completedPhases : set Phase,
  var findings : set Finding,
  var reports : set ReportName,
  var manifestPresent : one Bool,
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

### Requirement: Emit Bounded Analysis Reports [RAE-EMIT-REPORTS]
WHEN one or more analysis phases complete, THE spec-check tool SHALL write the phase reports and synthesized summary reports defined for the selected analysis mode under the configured output directory. IF the run stops at catalog construction because no active documents survive, THEN THE spec-check tool SHALL report the catalog error instead of emitting vacuous downstream analysis reports.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Quality Attributes`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`

#### Scenario: Emit Phase-Specific Reports [RAE-REPORT-PHASES]
WHEN specs-forward analysis completes for a run, THE spec-check tool SHALL emit distinct reports for qualitative analysis (first pass), qualitative properties and invariants (second pass), coverage analysis, and logic analysis, plus any optional source or tasks reports enabled for that run.

**Postcondition:** Reviewers can inspect each analytical pass separately instead of relying only on a synthesized summary.

##### Evidence
- Implementation: [render.ts:87 writePhaseReports()](/src/domain/reporting/render.ts#L87), [run-cli.ts:290 runReportingPhase()](/src/cli/run-cli.ts#L290)
- Test: [reporting.test.ts:21 writes phase reports at correct naming convention](/test/contract/reporting.test.ts#L21)
- Test (integration): [specs-forward.integration.test.ts:18 produces phase reports and summary](/test/integration/specs-forward.integration.test.ts#L18), [pipeline.integration.test.ts:321 full pipeline produces summary with all finding categories](/test/integration/pipeline.integration.test.ts#L321)

#### Scenario: Emit Code-Derived Evidence Directories [RAE-REPORT-GENSPECS]
WHEN code-backwards analysis completes for a run, THE spec-check tool SHALL persist the `gen_specs/` directory containing code-derived Markdown specifications and the `gen_specs_smt/` directory containing code-derived SMT-LIB artifacts under the configured output directory.

**Postcondition:** Code-derived intermediate artifacts are available for reviewer inspection alongside reports.

##### Evidence
- Implementation: [pipeline-helpers.ts:360 runCodeBackwardsWork()](/src/cli/pipeline-helpers.ts#L360)
- Test (integration): [pipeline.integration.test.ts:160 code-derived spec generation produces gen_specs files](/test/integration/pipeline.integration.test.ts#L160)

#### Scenario: Explain Skipped Report Scope [RAE-REPORT-SKIP]
IF an optional phase is not enabled for a run, THEN THE spec-check tool SHALL explain that skipped scope in the synthesized reporting rather than omit it silently.

**Postcondition:** Reviewers can distinguish intentionally skipped analysis from missing output.

##### Evidence
- Implementation: [render.ts:196 writeSummaryReport()](/src/domain/reporting/render.ts#L196), [pipeline-helpers.ts:78 computeSkippedPhases()](/src/cli/pipeline-helpers.ts#L78)
- Test: [reporting.test.ts:48 includes skipped-phase explanations](/test/contract/reporting.test.ts#L48)
- Test (integration): [specs-forward.integration.test.ts:18 produces phase reports and summary](/test/integration/specs-forward.integration.test.ts#L18)

#### Scenario: Suppress Vacuous Reports On Catalog Error [RAE-REPORT-CATALOG]
IF the catalog phase ends in `CatalogError`, THEN THE spec-check tool SHALL NOT emit downstream qualitative, formal, or comparison reports for that run.

**Postcondition:** Report output accurately reflects that analysis never proceeded past catalog construction.

#### Requirement model

```alloy
// --- Report emission: mode-dependent phase output ---

pred complete_phase [p : Phase] {
  // Guard
  p not in Run.completedPhases
  p in enabledPhases
  Run.failed = False
  Run.manifestPresent = False    // stale manifest must be removed first
  // Effect: phase marked complete, report written
  Run.completedPhases' = Run.completedPhases + p
  Run.reports' = Run.reports + phaseToReport[p]
  // Findings monotonically increase (new findings added)
  Run.findings in Run.findings'
  // Frame
  Run.manifestPresent' = Run.manifestPresent
  Run.failed' = Run.failed
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
- Implementation: [render.ts:99 writePhaseReports()](/src/domain/reporting/render.ts#L99)
- Test: [reporting.test.ts:21 writes phase reports at correct naming convention](/test/contract/reporting.test.ts#L21)
- Test (integration): [pipeline.integration.test.ts:321 full pipeline produces summary](/test/integration/pipeline.integration.test.ts#L321)

#### Scenario: Code-Derived Logic Report Named Correctly [RAE-NAMES-GENLOGIC]
WHEN code-derived solver analysis completes, THE spec-check tool SHALL write the report to `report_2.logic.md` under the output directory.

**Postcondition:** Code-derived formal analysis is at a predictable path distinct from specs-forward logic analysis.

##### Evidence
- Implementation: [render.ts:124 writePhaseReports()](/src/domain/reporting/render.ts#L124)
- Test: [reporting.test.ts:142 writes code-derived logic report at report_2.logic.md](/test/contract/reporting.test.ts#L142)

#### Scenario: Summary Report Named Correctly [RAE-NAMES-SUMMARY]
WHEN the synthesized summary is generated, THE spec-check tool SHALL write it to `report_summary.md` under the output directory.

**Postcondition:** The summary is always at a predictable path.

##### Evidence
- Implementation: [render.ts:196 writeSummaryReport()](/src/domain/reporting/render.ts#L196)
- Test: [reporting.test.ts:36 writes summary report at report_summary.md](/test/contract/reporting.test.ts#L36)
- Test (integration): [pipeline.integration.test.ts:321 full pipeline produces summary](/test/integration/pipeline.integration.test.ts#L321)

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
WHEN the spec-check tool emits a finding or final report conclusion, THE spec-check tool SHALL preserve the provenance, rationale, and supporting artifacts needed for a reviewer to inspect the basis of that conclusion.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Preserve Solver And Model Artifacts [RAE-EVID-ARTS]
WHEN a finding depends on solver analysis or sampled formalization output, THE spec-check tool SHALL preserve the related generated artifacts or references needed to inspect that evidence.

**Postcondition:** Formal conclusions remain auditable after the run completes.

##### Evidence
- Implementation: [pipeline-helpers.ts:360 runCodeBackwardsWork()](/src/cli/pipeline-helpers.ts#L360)
- Test: [coverage-gaps.test.ts:44 solver and model artifacts are preserved](/test/contract/coverage-gaps.test.ts#L44)
- Test (invariant): [global.invariant.test.ts:209 INV-4 + INV-13: solver artifacts are persisted](/test/invariant/global.invariant.test.ts#L209)

#### Scenario: Preserve Cross-Side Implication Evidence [RAE-EVID-CROSSIMPLY]
WHEN a code-backwards classification depends on cross-side implication analysis, THE spec-check tool SHALL preserve the implication queries, solver results, and classification rationale as evidence attached to the finding.

**Postcondition:** Cross-side comparison verdicts are traceable to their formal basis.

##### Evidence
- Implementation: [pipeline-helpers.ts:446 runCodeBackwardsWork()](/src/cli/pipeline-helpers.ts#L446)
- Test (invariant): [global.invariant.test.ts:209 INV-4 + INV-13: solver artifacts are persisted](/test/invariant/global.invariant.test.ts#L209)
- Test (integration): [pipeline.integration.test.ts:271 cross-side comparison pipeline](/test/integration/pipeline.integration.test.ts#L271)

#### Scenario: Prevent Unsupported Verdict [RAE-EVID-FAIL]
IF a final report conclusion would be emitted without preserved provenance or supporting evidence, THEN THE spec-check tool SHALL suppress that unsupported verdict and SHALL surface the missing-evidence condition as a defect.

**Postcondition:** Reported conclusions never outrun the preserved evidence set.

##### Evidence
- Implementation: [render.ts:251 enforceFindingSupport()](/src/domain/reporting/render.ts#L251)
- Test: [reporting.test.ts:53 suppresses finding without required evidence](/test/contract/reporting.test.ts#L53), [reporting.test.ts:99 suppresses finding with empty provenance file](/test/contract/reporting.test.ts#L99)

#### Scenario: Preserve LLM Response As Evidence [RAE-EVID-LLM]
WHEN a finding depends on an LLM-backed analysis response, THE spec-check tool SHALL preserve the full response content as evidence attached to the finding.

**Postcondition:** No final verdict rests on an unpreserved LLM response.

##### Evidence
- Implementation: [qualitative.ts:24 rawResponses](/src/domain/spec-forward/qualitative.ts#L24)
- Test: [qualitative.test.ts:21 runQualitativePasses returns merged findings](/test/contract/qualitative.test.ts#L21)
- Test (property): [code-derived.property.test.ts:40 qualitative review prompts fence all documents](/test/property/code-derived.property.test.ts#L40)
- Test (invariant): [global.invariant.test.ts:125 INV-11: prompts fence document content](/test/invariant/global.invariant.test.ts#L125), [safety-liveness.invariant.test.ts:156 LIVE-10: qualitative analysis completes](/test/invariant/safety-liveness.invariant.test.ts#L156)

#### Requirement model

```alloy
// --- Evidence preservation: every conclusion is auditable ---

// A finding with unpreserved evidence is an analysis defect
pred has_unpreserved_evidence [f : Finding] {
  some e : f.evidenceSet | e.preserved = False
}

// Unsupported verdict: would-be finding without preserved evidence
// The tool must suppress this and emit a defect finding instead
pred suppress_unsupported_verdict [f : Finding] {
  // Guard: finding has unpreserved evidence
  has_unpreserved_evidence[f]
  // Effect: f is NOT added to findings; a defect finding IS added
  f not in Run.findings'
  // A well-formed defect finding is added instead (modeled by the phase event)
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
```

### Requirement: Finding Shape And Severity [RAE-FINDING-SHAPE]
WHEN the spec-check tool creates a finding, THE spec-check tool SHALL use a stable finding shape with required fields: severity, category, provenance, description, rationale, and evidence references. Optional fields include suggestion and related claim identifiers. When catalog-empty conditions are represented as findings or finding-like diagnostics, the same explanatory completeness SHALL apply.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Domain Model`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`

#### Scenario: Finding With All Required Fields [RAE-SHAPE-COMPLETE]
WHEN a finding is created, THE spec-check tool SHALL populate severity, category, provenance, description, rationale, and at least one evidence reference.

**Postcondition:** Every finding is self-describing and reviewable without external context.

##### Evidence
- Implementation: [findings.ts:49 Finding](/src/domain/findings.ts#L49), [render.ts:251 enforceFindingSupport()](/src/domain/reporting/render.ts#L251)
- Test: [reporting.test.ts:124 passes finding with all required fields including rationale](/test/contract/reporting.test.ts#L124)
- Test (invariant): [global.invariant.test.ts:50 INV-2: every finding has provenance](/test/invariant/global.invariant.test.ts#L50)

#### Scenario: Missing Required Field Rejected [RAE-SHAPE-FAIL]
IF a finding would be emitted without a required field, THEN THE spec-check tool SHALL treat this as an analysis defect and surface it rather than emitting an incomplete finding.

**Postcondition:** The finding pipeline never produces malformed findings.

##### Evidence
- Implementation: [render.ts:251 enforceFindingSupport()](/src/domain/reporting/render.ts#L251)
- Test: [reporting.test.ts:53 suppresses finding without required evidence as defect](/test/contract/reporting.test.ts#L53), [reporting.test.ts:74 suppresses finding with empty rationale as defect](/test/contract/reporting.test.ts#L74), [reporting.test.ts:99 suppresses finding with empty provenance file as defect](/test/contract/reporting.test.ts#L99)

#### Scenario: Catalog Diagnostic Remains Actionable [RAE-SHAPE-CATALOG]
WHEN the tool surfaces a catalog-empty diagnostic, THE spec-check tool SHALL include the empty-catalog cause and actionable remediation text in the surfaced message.

**Postcondition:** Catalog errors meet the same reviewability standard as normal findings.

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
```

### Requirement: Findings Never Silently Removed [RAE-FINDINGS-IMMUTABLE]
WHEN findings are produced by earlier phases, THE spec-check tool SHALL preserve them through later phases. Later phases may add evidence or add new findings, but SHALL NOT remove or suppress prior findings without surfacing that change as a separate finding.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Prior Finding Preserved [RAE-IMMUT-KEEP]
WHEN a later analysis phase runs after earlier findings exist, THE spec-check tool SHALL include all prior findings in the final report alongside any new findings from the later phase.

**Postcondition:** Finding count never decreases between phases.

##### Evidence
- Implementation: [run-state.ts:63 addFindings()](/src/domain/run-state.ts#L63)
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
- Implementation: [run-state.ts:63 addFindings()](/src/domain/run-state.ts#L63)
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

// Supersession model: if a finding is "superseded", both the original
// and the supersession explanation remain in the findings set
pred supersede_finding [original : Finding, supersession : Finding] {
  // Both findings must be in the set
  original in Run.findings
  supersession in Run.findings'
  original in Run.findings'      // original preserved
  // Supersession finding references the original (via evidence)
  original.provenance in supersession.provenance
}
```

### Requirement: Complete Runs With Atomic Manifest Semantics [RAE-ATOMIC-MANIFEST]
WHEN the spec-check tool writes output artifacts, THE spec-check tool SHALL write them using atomic finalization behavior and SHALL write the manifest last as the completion marker for the run.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Mark Complete Run [RAE-MANIFEST-DONE]
WHEN all selected outputs are written successfully, THE spec-check tool SHALL write a manifest that lists the produced files and their checksums after all prior outputs have been finalized.

**Postcondition:** Consumers can treat manifest presence as the marker of a completed run.

##### Evidence
- Implementation: [manifest.ts:106 writeManifest()](/src/domain/reporting/manifest.ts#L106), [run-cli.ts:316 runReportingPhase()](/src/cli/run-cli.ts#L316)
- Test: [manifest.test.ts:13 writes checksums and manifest last](/test/contract/manifest.test.ts#L13)
- Test (integration): [pipeline.integration.test.ts:209 manifest checksums match actual file content](/test/integration/pipeline.integration.test.ts#L209)

#### Scenario: Prevent Partial Completion Signal [RAE-MANIFEST-FAIL]
IF the run fails before all selected outputs are finalized, THEN THE spec-check tool SHALL NOT leave a final manifest that implies completed output.

**Postcondition:** Partial runs cannot be mistaken for completed analyses.

##### Evidence
- Implementation: [run-cli.ts:290 runReportingPhase()](/src/cli/run-cli.ts#L290)
- Test: [coverage-gaps.test.ts:59 manifest absence signals incomplete run](/test/contract/coverage-gaps.test.ts#L59)

#### Scenario: Invalidate Stale Manifest From Prior Run [RAE-MANIFEST-STALE]
IF the output directory already contains a manifest from a previous run WHEN a new run begins, THEN THE spec-check tool SHALL remove the existing manifest before analysis begins so that a failed rerun cannot be mistaken for a prior successful run.

**Postcondition:** Only a successfully completed run can leave a manifest in the output directory.

##### Evidence
- Implementation: [manifest.ts:133 invalidateStaleManifest()](/src/domain/reporting/manifest.ts#L133), [run-cli.ts:127 runIngestionPhases()](/src/cli/run-cli.ts#L127)
- Test: [manifest.test.ts:46 removes stale manifest from prior run](/test/contract/manifest.test.ts#L46), [manifest.test.ts:59 returns false when no stale manifest exists](/test/contract/manifest.test.ts#L59)

#### Requirement model

```alloy
// --- Atomic manifest: completion marker semantics ---

pred write_manifest {
  // Guard: all required reports written, not failed
  requiredReports in Run.reports
  Run.failed = False
  // Effect: manifest present
  Run.manifestPresent' = True
  // Frame
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.failed' = Run.failed
}

pred remove_stale_manifest {
  // Guard: manifest present at start of new run, no phases completed yet
  Run.manifestPresent = True
  no Run.completedPhases
  // Effect: manifest removed
  Run.manifestPresent' = False
  // Frame
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.failed' = Run.failed
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
- Test (invariant): [global.invariant.test.ts:112 INV-8: manifest entries have correct checksums](/test/invariant/global.invariant.test.ts#L112)
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
- Test: [fs.test.ts:27 computes sha256 lowercase hex of correct length](/test/contract/fs.test.ts#L27)
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
- Test: [fs.test.ts:17 rejects path traversal outside boundary](/test/contract/fs.test.ts#L17), [fs.test.ts:22 rejects absolute path outside boundary](/test/contract/fs.test.ts#L22)
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
- Test: [fs.test.ts:33 writes atomic output file with correct content](/test/contract/fs.test.ts#L33)
- Test (invariant): [global.invariant.test.ts:199 INV-3: writeOutputAtomic produces correct content via atomic rename](/test/invariant/global.invariant.test.ts#L199)
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
  Run.failed' = Run.failed
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
  Run.failed' = Run.failed
  all f : OutputFile | f.pathState' = f.pathState
}

pred init_state {
  no Run.completedPhases
  no Run.findings
  no Run.reports
  Run.manifestPresent = False
  Run.failed = False
  all f : OutputFile | f.pathState = Absent
}

fact transitions {
  init_state and always (
    // Phase execution
    (some p : Phase | complete_phase[p])
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
    Run.failed' = Run.failed))
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
```
