## ADDED Requirements

### Requirement: Generate Optional Final Assessment [RAE-FINAL-REPORT]
WHEN the core evidence manifest is successfully written, THE spec-check tool SHALL attempt to generate one optional decision-oriented Markdown assessment at `report.md` from the completed evidence bundle.

**References:**
- `openspec/changes/add-final-evidence-report/proposal.md#Domain-Model`
- `openspec/changes/add-final-evidence-report/design.md#System-Model`

#### Requirement model

[`alloy/final-report.als`](alloy/final-report.als) models core completion, final-report success and failure, cleanup, warning persistence, manifest refresh, and terminal progress.

#### Scenario: Generate After Core Completion [RAE-FINAL-AFTER-CORE]
WHEN final-report generation starts, THE spec-check tool SHALL have already finalized the phase reports, `report_summary.md`, and the core `manifest.json`.

**Postcondition:** The report agent can read a completion manifest that describes the complete core evidence bundle.

#### Scenario: Save Valid Final Report [RAE-FINAL-SAVE]
WHEN the report agent returns a valid path and Markdown payload, THE spec-check tool SHALL atomically publish and independently validate `report.md`.

**Postcondition:** Exactly one valid final report is available for the current run.

#### Scenario: Final Report Is Optional [RAE-FINAL-OPTIONAL]
IF final-report generation or validation fails after core completion, THEN THE spec-check tool SHALL preserve the completed analysis and SHALL represent the failure as a warning rather than a fatal pipeline error.

**Postcondition:** Core completion remains true even though no final report is available; the warning may produce the existing findings-present exit code.

### Requirement: Bind Final Report Paths [RAE-FINAL-PATHS]
THE spec-check tool SHALL resolve the configured output directory to an absolute path and SHALL use one confined absolute `report.md` path for the prompt, payload comparison, atomic publication, and filesystem validation.

**References:**
- `openspec/changes/add-final-evidence-report/proposal.md#Preconditions-Postconditions-and-Invariants`
- `openspec/changes/add-final-evidence-report/design.md#Interface-Contracts`

#### Scenario: Resolve Relative Output [RAE-FINAL-PATH-ABS]
WHEN a relative output directory is configured, THE spec-check tool SHALL resolve it to an absolute path before final-report request construction.

**Postcondition:** Prompt and permission behavior is independent of the caller's relative path spelling.

#### Scenario: Preserve Paths With Spaces [RAE-FINAL-PATH-SPACE]
WHEN an absolute evidence or report path contains spaces, THE spec-check tool SHALL pass and compare that path without shell interpolation or token splitting.

**Postcondition:** The exact configured destination remains authoritative.

#### Scenario: Reject Acknowledgment Mismatch [RAE-FINAL-PATH-MISMATCH]
IF the acknowledgment `report_path` does not equal the designated absolute destination, THEN THE spec-check tool SHALL reject the report attempt and SHALL NOT read the acknowledged alternate path.

**Postcondition:** Model output cannot redirect validation outside the configured destination.

#### Scenario: Reject Permission Wildcards [RAE-FINAL-PATH-WILDCARD]
IF the absolute evidence or report path contains `*` or `?`, THEN THE spec-check tool SHALL NOT invoke the report agent and SHALL classify the optional report attempt as failed.

**Postcondition:** OpenCode wildcard matching cannot broaden read-only external-directory access.

### Requirement: Restrict Final Report Agent [RAE-FINAL-AGENT]
WHEN the spec-check tool invokes the final-report agent, THE spec-check tool SHALL use OpenCode pure mode and a transient primary-agent policy that permits required reads, denies all file mutation, shell execution, and delegation, and does not enable OpenCode auto-approval.

**References:**
- `openspec/changes/add-final-evidence-report/proposal.md#Constraints`
- `openspec/changes/add-final-evidence-report/design.md#Security`

#### Scenario: Allow Designated Write [RAE-FINAL-AGENT-WRITE]
WHEN a valid report payload is returned, THE spec-check tool SHALL atomically publish its Markdown through the confined filesystem adapter at the exact designated `report.md`.

**Postcondition:** The agent remains read-only and trusted code produces the requested artifact.

#### Scenario: Deny Other Mutation [RAE-FINAL-AGENT-DENY]
IF the report agent attempts to modify any file, THEN THE transient policy SHALL deny that action.

**Postcondition:** Final-report agent execution has no writable path.

#### Scenario: Deny Shell And Delegation [RAE-FINAL-AGENT-TOOLS]
IF the report agent attempts shell execution, task delegation, web access, or another denied capability, THEN THE transient policy SHALL deny that action.

**Postcondition:** The report cannot bypass read-only policy through a more powerful tool.

### Requirement: Use File And Acknowledgment Protocol [RAE-FINAL-PROTOCOL]
WHEN the final-report phase invokes OpenCode with `--format json`, THE spec-check tool SHALL decode stdout as strict UTF-8 newline-delimited OpenCode events, concatenate `part.text` only from top-level `type: "text"` events, and parse that text as one JSON object with the exact `report_path` and complete `report_markdown` strings.

**References:**
- `openspec/changes/add-final-evidence-report/proposal.md#Scope`
- `openspec/changes/add-final-evidence-report/design.md#Interaction-Protocols`

#### Scenario: Invoke In Workspace [RAE-FINAL-PROTO-DIR]
WHEN OpenCode is started for the final-report phase, THE spec-check tool SHALL pass `--pure`, an isolated execution/configuration root with `--dir`, the restricted agent with `--agent`, JSON event output with `--format json`, and SHALL omit `--auto`; the analyzed workspace SHALL be named in the prompt and granted explicit read-only external-directory access.

**Postcondition:** The agent can inspect workspace evidence under the declared permission boundary.

#### Scenario: Validate Acknowledgment Shape [RAE-FINAL-PROTO-ACK]
IF final-report stdout does not decode to exactly the required non-empty `report_path` and `report_markdown` fields, THEN THE spec-check tool SHALL classify the attempt as failed.

**Postcondition:** Malformed UTF-8, malformed event lines, error events, raw payloads outside text events, missing text payloads, Markdown fences, prose wrappers, extra payload fields, and invalid field values are rejected. Non-text status and usage events are ignored.

#### Scenario: Preserve Prompt Parity [RAE-FINAL-PROMPT-PARITY]
WHEN bundled artifacts are built, THE spec-check verification harness SHALL confirm that the distributed final-report prompt and builders match the authoritative `FINAL_REPORT_PROMPT` and builders in `src/domain/prompts/final-report.ts` before declared runtime placeholder substitution.

**Postcondition:** Source and distributed CLIs use the same authoritative evaluated content strategy without depending on an external prompt file.

### Requirement: Validate Final Report File [RAE-FINAL-VALIDATE]
WHEN a final-report payload is accepted, THE spec-check tool SHALL validate its path and Markdown, atomically publish the Markdown, and independently validate the precomputed destination as a non-symlink regular strict UTF-8 file with all required report headings, at least one repository-relative citation, one artifact citation for every numbered prioritized finding, non-whitespace content, and size not greater than 1,048,576 bytes.

**References:**
- `openspec/changes/add-final-evidence-report/proposal.md#Postconditions`
- `openspec/changes/add-final-evidence-report/design.md#Data-Design`

#### Scenario: Accept Bounded Regular File [RAE-FINAL-VALID-FILE]
WHEN trusted atomic publication produces a regular non-symlink file that meets the strict UTF-8, required-heading, citation, non-whitespace, and 1,048,576-byte rules, THE spec-check tool SHALL accept it as the final report.

**Postcondition:** Valid payload content plus filesystem read-back establishes report success.

#### Scenario: Reject Missing Report [RAE-FINAL-MISSING]
IF the report payload omits valid Markdown or trusted atomic publication does not produce the designated report, THEN THE spec-check tool SHALL classify the report attempt as failed.

**Postcondition:** A path assertion cannot substitute for report content and successful publication.

#### Scenario: Reject Symlink [RAE-FINAL-SYMLINK]
IF the designated report is a symbolic link, THEN THE spec-check tool SHALL reject it without following the link target.

**Postcondition:** Report validation cannot escape the configured output through a link.

#### Scenario: Reject Non-Regular Report [RAE-FINAL-NOT-REGULAR]
IF the designated report is a directory or another non-regular filesystem object, THEN THE spec-check tool SHALL classify the report attempt as failed.

**Postcondition:** Only regular files can become final reports.

#### Scenario: Reject Empty Report [RAE-FINAL-EMPTY]
IF the designated report is empty or contains only whitespace, THEN THE spec-check tool SHALL classify the report attempt as failed.

**Postcondition:** A successful report contains substantive Markdown text.

#### Scenario: Reject Oversized Report [RAE-FINAL-OVERSIZED]
IF the designated report is larger than 1,048,576 bytes, THEN THE spec-check tool SHALL reject it before an unbounded content read.

**Postcondition:** Returned Markdown is bounded before atomic publication.

#### Scenario: Reject Unsupported Report Structure [RAE-FINAL-STRUCTURE]
IF returned or read-back Markdown omits a required report heading, contains no repository-relative citation, or gives a numbered prioritized finding no artifact citation, THEN THE spec-check tool SHALL classify the report attempt as failed.

**Postcondition:** A structurally incomplete or uncited prioritized finding cannot be published as a successful final report.

### Requirement: Clean Final Report Output [RAE-FINAL-CLEANUP]
WHEN a new run starts or a handled final-report failure occurs, THE spec-check tool SHALL remove the confined `report.md` destination before that run can claim a final-report outcome.

**References:**
- `openspec/changes/add-final-evidence-report/proposal.md#Failure-Modes`
- `openspec/changes/add-final-evidence-report/design.md#Control-and-Recovery`

#### Scenario: Remove Stale Report [RAE-FINAL-CLEAN-STALE]
WHEN a new run starts and `report.md` exists from a prior run, THE spec-check tool SHALL remove it before analysis begins.

**Postcondition:** A prior report cannot be attributed to the new evidence bundle.

#### Scenario: Remove All Stale Managed Output [RAE-FINAL-CLEAN-MANAGED]
WHEN a new run starts, THE spec-check tool SHALL first invalidate the prior `manifest.json` and SHALL then remove all tool-owned phase reports, summary, final report, metrics, formalization evidence, SMT evidence, generated specifications, and cross-implication evidence before analysis begins.

**Postcondition:** Artifacts omitted by the current run cannot be mistaken for current unmanifested evidence.

#### Scenario: Surface Startup Cleanup Failure [RAE-FINAL-CLEAN-START-ERROR]
IF managed-output cleanup fails after prior-manifest invalidation, THEN THE spec-check tool SHALL return fatal `OutputError` before ingestion and SHALL NOT claim a current completed bundle.

**Postcondition:** Residue can remain for operator inspection, but no stale manifest attests it as the new run.

#### Scenario: Remove Invalid Candidate [RAE-FINAL-CLEAN-FAILED]
IF report generation or validation fails on a handled path, THEN THE spec-check tool SHALL remove any file or filesystem object at the designated report path before persisting the failure warning.

**Postcondition:** The warning terminal state has no report residue.

#### Scenario: Surface Cleanup Failure [RAE-FINAL-CLEAN-ERROR]
IF the spec-check tool cannot establish that the designated report path is absent after a failed attempt, THEN THE spec-check tool SHALL surface an output failure and SHALL NOT claim the `warning_without_report` terminal outcome.

**Postcondition:** The system never reports successful cleanup when invalid residue may remain.

#### Scenario: Surface Post-Completion Output Failure [RAE-FINAL-OUTPUT-ERROR]
IF report cleanup, marker invalidation, warning-summary rewrite, or manifest refresh fails, THEN THE spec-check tool SHALL enter `output_failed`, return fatal `OutputError`, and SHALL NOT claim `valid_report` or `warning_without_report`.

**Postcondition:** Report, summary, and manifest presence reflect only side effects completed before the failed operation. After successful marker invalidation, no completion manifest remains.

### Requirement: Persist Final Report Failure [RAE-FINAL-WARNING]
IF final-report generation or validation fails and cleanup succeeds, THEN THE spec-check tool SHALL append one well-formed warning with category `reporting.final_report_failed`, rewrite `report_summary.md`, and refresh `manifest.json` after the summary write.

**References:**
- `openspec/changes/add-final-evidence-report/proposal.md#Postconditions`
- `openspec/changes/add-final-evidence-report/design.md#System-Invariant-Tactics`

#### Scenario: Record Failure Kind [RAE-FINAL-WARN-KIND]
WHEN a final-report warning is created, THE warning SHALL contain warning severity, `<reporting>` provenance, a non-empty description and rationale, and evidence naming the stable failure kind.

**Postcondition:** Reviewers can distinguish optional-report degradation from missing analysis.

#### Scenario: Refresh Summary Checksum [RAE-FINAL-WARN-HASH]
WHEN the warning changes `report_summary.md`, THE spec-check tool SHALL first invalidate the old manifest, SHALL compute the new entry from final summary bytes, and SHALL atomically write `manifest.json` after the summary.

**Postcondition:** Every core manifest checksum matches its final core artifact.

#### Scenario: Preserve Core Completion [RAE-FINAL-WARN-COMPLETE]
WHEN the final-report warning is persisted, THE spec-check tool SHALL retain `manifest.json` as the core completion marker and SHALL NOT convert the handled report failure into a fatal pipeline result.

**Postcondition:** The run is complete with an observable warning and no report.

## MODIFIED Requirements

### Requirement: Report File Naming Convention [RAE-REPORT-NAMES]
WHEN the spec-check tool writes phase reports or synthesized reports, THE spec-check tool SHALL use these stable names: `report_1.1.md` for the first qualitative pass, `report_1.2.md` for the properties and invariants pass, `report_1.3.md` for coverage analysis, `report_1.logic.md` for logic analysis, `report_2.trace.md` for source traceability, `report_2.logic.md` for code-derived formal analysis, `report_2.compare.md` for code-backwards comparison, `report_summary.md` for the core synthesized summary, and `report.md` for the optional post-completion final assessment.

**References:**
- `openspec/specs/reporting-and-evidence/spec.md#Requirement-Report-File-Naming-Convention-RAE-REPORT-NAMES`
- `openspec/changes/add-final-evidence-report/proposal.md#Scope`

#### Scenario: Phase Report Named Correctly [RAE-NAMES-PHASE]
WHEN the qualitative analysis phase completes its first pass, THE spec-check tool SHALL write the report to `report_1.1.md` under the output directory.

**Postcondition:** Report consumers can locate phase output using the documented naming convention.

#### Scenario: Code-Derived Logic Report Named Correctly [RAE-NAMES-GENLOGIC]
WHEN code-derived solver analysis completes, THE spec-check tool SHALL write the report to `report_2.logic.md` under the output directory.

**Postcondition:** Code-derived formal analysis is at a predictable path distinct from specs-forward logic analysis.

#### Scenario: Summary Report Named Correctly [RAE-NAMES-SUMMARY]
WHEN the core synthesized summary is generated, THE spec-check tool SHALL write it to `report_summary.md` under the output directory.

**Postcondition:** The core summary is always at a predictable path.

#### Scenario: Final Assessment Named Correctly [RAE-NAMES-FINAL]
WHEN final-report generation succeeds, THE spec-check tool SHALL preserve the validated assessment at `report.md` under the output directory.

**Postcondition:** Consumers can distinguish the decision-oriented derivative from phase and summary reports.

### Requirement: Complete Runs With Atomic Manifest Semantics [RAE-ATOMIC-MANIFEST]
WHEN the spec-check tool writes core output artifacts, THE spec-check tool SHALL atomically finalize each core artifact, SHALL permit separate formalization attempt-evidence files to exist before successful core completion, and SHALL write `manifest.json` after all core artifacts as the sole core-run success marker. The successful manifest SHALL list every produced attempt-evidence file and its SHA-256 checksum together with the other produced core output files. The optional post-completion `report.md` MAY be written after that marker and SHALL remain outside the manifest.

**References:**
- `openspec/specs/reporting-and-evidence/spec.md#Requirement-Complete-Runs-With-Atomic-Manifest-Semantics-RAE-ATOMIC-MANIFEST`
- `openspec/changes/add-final-evidence-report/proposal.md#Preconditions-Postconditions-and-Invariants`
- `openspec/changes/add-final-evidence-report/design.md#Interaction-Protocols`

#### Requirement model

[`alloy/final-report.als`](alloy/final-report.als) checks that core completion precedes report generation, remains monotonic, excludes the report from manifested files, and is preserved by both final-report outcomes.

#### Scenario: Successful Manifest Covers Attempt Evidence [RAE-MANIFEST-ATTEMPT-EVIDENCE]
WHEN a run completes core analysis after producing one or more `FormalizationAttemptSet` files, THE spec-check tool SHALL write the manifest after those files and SHALL include one entry per file with its relative path and matching SHA-256 checksum.

**Postcondition:** Manifest presence marks the last successful core run and mechanically binds all durable attempt evidence to it.

#### Scenario: Attempt Evidence Alone Is Not Completion [RAE-MANIFEST-ATTEMPT-INCOMPLETE]
IF attempt-evidence files exist but core analysis fails or terminates before `manifest.json` is written, THEN consumers SHALL treat the run as incomplete.

**Postcondition:** Atomic evidence survival does not weaken core manifest completion semantics.

#### Scenario: Mark Complete Core Run [RAE-MANIFEST-DONE]
WHEN all selected core outputs are written successfully, THE spec-check tool SHALL write a manifest that lists the produced core files and their checksums after all prior core outputs have been finalized.

**Postcondition:** Consumers can treat manifest presence as the marker of a completed core run whether the optional final report later succeeds or fails.

#### Scenario: Prevent Partial Core Completion Signal [RAE-MANIFEST-FAIL]
IF core analysis fails before all selected core outputs are finalized, THEN THE spec-check tool SHALL NOT leave a final manifest that implies completed core output.

**Postcondition:** Partial core runs cannot be mistaken for completed analyses.

#### Scenario: Invalidate Stale Manifest From Prior Run [RAE-MANIFEST-STALE]
IF the output directory already contains a manifest from a previous run WHEN a new run begins, THEN THE spec-check tool SHALL remove the existing manifest before analysis begins so that a failed rerun cannot be mistaken for a prior successful run.

**Postcondition:** Only a successfully completed core run can leave a current manifest in the output directory.

#### Scenario: Exclude Final Report From Manifest [RAE-MANIFEST-NO-FINAL]
WHEN `manifest.json` is written or refreshed, THE spec-check tool SHALL NOT include an entry whose path is `report.md`.

**Postcondition:** The report does not attest to itself and remains a post-completion derivative.

## REMOVED Requirements

## RENAMED Requirements
