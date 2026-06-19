## Purpose

Define the reporting and evidence preservation behavior for the spec-check tool: producing bounded, evidence-preserving output artifacts, final reports, and manifest-based completion records.

## Requirements

### Requirement: Emit Bounded Analysis Reports [RAE-EMIT-REPORTS]
WHEN one or more analysis phases complete, THE spec-check tool SHALL write the phase reports and synthesized summary reports defined for the selected analysis mode under the configured output directory. The analysis mode is determined by the provided flags: base mode (no `--src`) produces `report_1.*`, `report_1.logic.md`, and `report_summary.md`; source-backed mode (`--src` provided) additionally produces `report_2.trace.md`, `report_2.logic.md`, `report_2.compare.md`, `gen_specs/`, and `gen_specs_smt/`.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Emit Phase-Specific Reports [RAE-REPORT-PHASES]
WHEN specs-forward analysis completes for a run, THE spec-check tool SHALL emit distinct reports for qualitative analysis (first pass), qualitative properties and invariants (second pass), coverage analysis, and logic analysis, plus any optional source or tasks reports enabled for that run.

**Postcondition:** Reviewers can inspect each analytical pass separately instead of relying only on a synthesized summary.

#### Scenario: Emit Code-Derived Evidence Directories [RAE-REPORT-GENSPECS]
WHEN code-backwards analysis completes for a run, THE spec-check tool SHALL persist the `gen_specs/` directory containing code-derived Markdown specifications and the `gen_specs_smt/` directory containing code-derived SMT-LIB artifacts under the configured output directory.

**Postcondition:** Code-derived intermediate artifacts are available for reviewer inspection alongside reports.

#### Scenario: Explain Skipped Report Scope [RAE-REPORT-SKIP]
IF an optional phase is not enabled for a run, THEN THE spec-check tool SHALL explain that skipped scope in the synthesized reporting rather than omit it silently.

**Postcondition:** Reviewers can distinguish intentionally skipped analysis from missing output.

### Requirement: Report File Naming Convention [RAE-REPORT-NAMES]
WHEN the spec-check tool writes phase reports, THE spec-check tool SHALL use a stable naming convention that identifies the phase and pass number: `report_1.1.md` for the first qualitative pass (spec quality review), `report_1.2.md` for the second qualitative pass (properties and invariants), `report_1.3.md` for coverage analysis, `report_1.logic.md` for logic analysis, `report_2.trace.md` for source traceability, `report_2.logic.md` for code-derived formal analysis, `report_2.compare.md` for code-backwards comparison, and `report_summary.md` for the synthesized summary.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Phase Report Named Correctly [RAE-NAMES-PHASE]
WHEN the qualitative analysis phase completes its first pass, THE spec-check tool SHALL write the report to `report_1.1.md` under the output directory.

**Postcondition:** Report consumers can locate phase output using the documented naming convention.

#### Scenario: Code-Derived Logic Report Named Correctly [RAE-NAMES-GENLOGIC]
WHEN code-derived solver analysis completes, THE spec-check tool SHALL write the report to `report_2.logic.md` under the output directory.

**Postcondition:** Code-derived formal analysis is at a predictable path distinct from specs-forward logic analysis.

#### Scenario: Summary Report Named Correctly [RAE-NAMES-SUMMARY]
WHEN the synthesized summary is generated, THE spec-check tool SHALL write it to `report_summary.md` under the output directory.

**Postcondition:** The summary is always at a predictable path.

### Requirement: Preserve Evidence For Every Surfaced Conclusion [RAE-PRESERVE-EVID]
WHEN the spec-check tool emits a finding or final report conclusion, THE spec-check tool SHALL preserve the provenance, rationale, and supporting artifacts needed for a reviewer to inspect the basis of that conclusion.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Preserve Solver And Model Artifacts [RAE-EVID-ARTS]
WHEN a finding depends on solver analysis or sampled formalization output, THE spec-check tool SHALL preserve the related generated artifacts or references needed to inspect that evidence.

**Postcondition:** Formal conclusions remain auditable after the run completes.

#### Scenario: Preserve Cross-Side Implication Evidence [RAE-EVID-CROSSIMPLY]
WHEN a code-backwards classification depends on cross-side implication analysis, THE spec-check tool SHALL preserve the implication queries, solver results, and classification rationale as evidence attached to the finding.

**Postcondition:** Cross-side comparison verdicts are traceable to their formal basis.

#### Scenario: Prevent Unsupported Verdict [RAE-EVID-FAIL]
IF a final report conclusion would be emitted without preserved provenance or supporting evidence, THEN THE spec-check tool SHALL suppress that unsupported verdict and SHALL surface the missing-evidence condition as a defect.

**Postcondition:** Reported conclusions never outrun the preserved evidence set.

#### Scenario: Preserve LLM Response As Evidence [RAE-EVID-LLM]
WHEN a finding depends on an LLM-backed analysis response, THE spec-check tool SHALL preserve the full response content as evidence attached to the finding.

**Postcondition:** No final verdict rests on an unpreserved LLM response.

### Requirement: Finding Shape And Severity [RAE-FINDING-SHAPE]
WHEN the spec-check tool creates a finding, THE spec-check tool SHALL use a stable finding shape with required fields: severity (error, warning, info), category, provenance (source file and heading), description, rationale (explanation of why the finding exists), and evidence references. Optional fields include suggestion and related claim identifiers.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Finding With All Required Fields [RAE-SHAPE-COMPLETE]
WHEN a finding is created, THE spec-check tool SHALL populate severity, category, provenance, description, rationale, and at least one evidence reference.

**Postcondition:** Every finding is self-describing and reviewable without external context.

#### Scenario: Missing Required Field Rejected [RAE-SHAPE-FAIL]
IF a finding would be emitted without a required field, THEN THE spec-check tool SHALL treat this as an analysis defect and surface it rather than emitting an incomplete finding.

**Postcondition:** The finding pipeline never produces malformed findings.

### Requirement: Findings Never Silently Removed [RAE-FINDINGS-IMMUTABLE]
WHEN findings are produced by earlier phases, THE spec-check tool SHALL preserve them through later phases. Later phases may add evidence or add new findings, but SHALL NOT remove or suppress prior findings without surfacing that change as a separate finding.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Prior Finding Preserved [RAE-IMMUT-KEEP]
WHEN a later analysis phase runs after earlier findings exist, THE spec-check tool SHALL include all prior findings in the final report alongside any new findings from the later phase.

**Postcondition:** Finding count never decreases between phases.

#### Scenario: Finding Removal Surfaced [RAE-IMMUT-CHANGE]
IF a later phase determines that a prior finding should be superseded, THEN THE spec-check tool SHALL preserve the original finding and add a new finding that explains the supersession.

**Postcondition:** Reviewers can trace the evolution of conclusions across phases.

### Requirement: Complete Runs With Atomic Manifest Semantics [RAE-ATOMIC-MANIFEST]
WHEN the spec-check tool writes output artifacts, THE spec-check tool SHALL write them using atomic finalization behavior and SHALL write the manifest last as the completion marker for the run.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Mark Complete Run [RAE-MANIFEST-DONE]
WHEN all selected outputs are written successfully, THE spec-check tool SHALL write a manifest that lists the produced files and their checksums after all prior outputs have been finalized.

**Postcondition:** Consumers can treat manifest presence as the marker of a completed run.

#### Scenario: Prevent Partial Completion Signal [RAE-MANIFEST-FAIL]
IF the run fails before all selected outputs are finalized, THEN THE spec-check tool SHALL NOT leave a final manifest that implies completed output.

**Postcondition:** Partial runs cannot be mistaken for completed analyses.

#### Scenario: Invalidate Stale Manifest From Prior Run [RAE-MANIFEST-STALE]
IF the output directory already contains a manifest from a previous run WHEN a new run begins, THEN THE spec-check tool SHALL remove the existing manifest before analysis begins so that a failed rerun cannot be mistaken for a prior successful run.

**Postcondition:** Only a successfully completed run can leave a manifest in the output directory.

### Requirement: Manifest Content Schema [RAE-MANIFEST-SCHEMA]
THE spec-check tool SHALL write the manifest as a UTF-8 JSON file containing an array of output file entries, each with `path` (relative to output directory), `checksum` (SHA-256 hex), and `phase` (originating phase name) fields.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Manifest Entries Match Files [RAE-SCHEMA-MATCH]
WHEN the manifest is written, every entry SHALL reference a file that exists under the output directory with a checksum that matches the file content.

**Postcondition:** Manifest integrity can be verified mechanically.

#### Scenario: Manifest Checksums Are SHA-256 [RAE-SCHEMA-HASH]
WHEN the manifest computes checksums, THE spec-check tool SHALL use SHA-256 and encode the result as lowercase hexadecimal.

**Postcondition:** Checksum format is predictable and interoperable.

### Requirement: Output Directory Confinement [RAE-OUTPUT-CONFINE]
WHEN the spec-check tool writes any output artifact, THE spec-check tool SHALL confine the write to the configured output directory and SHALL reject any write path that resolves outside that directory.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Write Within Output Directory [RAE-CONFINE-PASS]
WHEN an output path resolves to a location within the configured output directory, THE spec-check tool SHALL allow the write.

**Postcondition:** The artifact is created at the intended location.

#### Scenario: Write Outside Output Directory Rejected [RAE-CONFINE-FAIL]
IF an output path resolves to a location outside the configured output directory (including via symlinks or `..` traversal), THEN THE spec-check tool SHALL reject the write with a fatal error.

**Postcondition:** No file is written outside the declared output boundary.

### Requirement: Atomic Output Writes [RAE-OUTPUT-ATOMIC]
WHEN the spec-check tool writes an output file, THE spec-check tool SHALL write to a temporary file first and rename it into place so that interrupted writes do not leave partial files at the final path.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Successful Atomic Write [RAE-ATOMIC-PASS]
WHEN an output file write completes successfully, THE spec-check tool SHALL rename the temporary file to the final path.

**Postcondition:** The final path contains complete content.

#### Scenario: Interrupted Write Leaves No Partial File [RAE-ATOMIC-INTERRUPT]
IF the process is interrupted during an output file write, THEN the final path SHALL NOT contain partial content. The temporary file may be orphaned.

**Postcondition:** Consumers of the output directory never encounter partially written files at final paths.

