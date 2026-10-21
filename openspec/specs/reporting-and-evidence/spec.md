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
one sig R_2_Trace, R_2_Logic, R_2_Compare, R_Summary, R_Final extends ReportName {} // additional

// Severity levels for findings
abstract sig Severity {}
one sig ErrorSev, WarningSev, InfoSev extends Severity {}

abstract sig FindingCategory {}
one sig GeneralCategory, FinalReportFailedCategory extends FindingCategory {}

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
one sig ReportingArtifact extends Artifact {}
one sig ReportingHeading extends Heading {}

// Findings: the unit of analysis output
sig Finding {
  severity : one Severity,
  category : one FindingCategory,
  hasCategory : one Bool,
  provenance : lone Provenance,
  hasDescription : one Bool,
  hasRationale : one Bool,
  evidenceSet : set Evidence,
  originPhase : one Phase,
  finalFailureEvidence : lone FinalFailureKind
}

// Output path resolution
abstract sig WriteLoc {}
one sig InsideDir, OutsideDir extends WriteLoc {}

// Write completion state
abstract sig WriteCompletion {}
one sig AtomicComplete, PartialWrite extends WriteCompletion {}

// Consumer-visible final-path state for atomic output publication.
abstract sig FilePathState {}
one sig Absent, TempWriting, FinalComplete extends FilePathState {}

sig OutputFile {
  var pathState : one FilePathState
}

// The optional assessment has one precomputed, confined final path whose
// lifecycle is owned only by final-report publication and cleanup.
one sig FinalReportDestination {
  var reportPathState : one FilePathState
}

// Manifest entries (for RAE-MANIFEST-SCHEMA)
abstract sig MetricsArtifact {}
one sig MetricsFile extends MetricsArtifact {}
abstract sig ManifestPhase {}
one sig QualPass1ManifestPhase, QualPass2ManifestPhase, CoverageManifestPhase,
  LogicManifestPhase, SourceTraceManifestPhase, CodeLogicManifestPhase,
  CodeCompareManifestPhase, SummaryManifestPhase, FormalizationManifestPhase,
  MetricsManifestPhase extends ManifestPhase {}
sig ManifestEntry {
  entryReport : lone ReportName,
  entryAttemptSet : lone AttemptSet,
  entryMetrics : lone MetricsArtifact,
  checksumValid : one Bool,
  entryPhase : one ManifestPhase
}

fact manifest_entry_has_one_target {
  all e : ManifestEntry |
    one (e.entryReport + e.entryAttemptSet + e.entryMetrics)
}

fun reportManifestPhase : ReportName -> ManifestPhase {
  R_1_1 -> QualPass1ManifestPhase
  + R_1_2 -> QualPass2ManifestPhase
  + R_1_3 -> CoverageManifestPhase
  + R_1_Logic -> LogicManifestPhase
  + R_2_Trace -> SourceTraceManifestPhase
  + R_2_Logic -> CodeLogicManifestPhase
  + R_2_Compare -> CodeCompareManifestPhase
  + R_Summary -> SummaryManifestPhase
}

fact manifest_entry_phase_matches_target {
  all e : ManifestEntry | {
    some e.entryReport implies e.entryPhase = reportManifestPhase[e.entryReport]
    some e.entryAttemptSet implies e.entryPhase = FormalizationManifestPhase
    some e.entryMetrics implies e.entryPhase = MetricsManifestPhase
  }
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

// --- Optional final-report lifecycle ---
abstract sig FinalStage {}
one sig Preparing, StartupCleaning, CoreReporting, CoreComplete, Generating,
  Validating, PublishedCandidate, Cleaning, Cleaned, WarningRecorded,
  MarkerInvalidated, SummaryRewritten,
  ManifestRefreshing, ReportAvailable, WarningPersisted, OutputFailed
  extends FinalStage {}

// Closed failure taxonomy. Handled failures converge on Cleaning; output
// failures cannot safely claim a handled warning-without-report outcome.
abstract sig FinalFailureKind {}
one sig AgentFailed, AcknowledgmentInvalid, PathUnsupported, PathMismatch,
  ReportMissing, ReportSymlink, ReportNotRegular, ReportEmpty,
  ReportStructureInvalid, ReportTooLarge, ReportUnreadable,
  StartupCleanupFailed, CleanupFailed, WarningPersistenceFailed, MarkerInvalidationFailed,
  SummaryRewriteFailed, ManifestRefreshFailed extends FinalFailureKind {}

fun handledFinalFailures : set FinalFailureKind {
  AgentFailed + AcknowledgmentInvalid + PathUnsupported + PathMismatch
  + ReportMissing + ReportSymlink + ReportNotRegular + ReportEmpty
  + ReportStructureInvalid + ReportTooLarge + ReportUnreadable
}

fun generationFinalFailures : set FinalFailureKind {
  AgentFailed
}

fun validationFinalFailures : set FinalFailureKind {
  AcknowledgmentInvalid + PathMismatch + ReportMissing + ReportSymlink
  + ReportNotRegular + ReportEmpty
  + ReportStructureInvalid + ReportTooLarge + ReportUnreadable
}

fun outputFinalFailures : set FinalFailureKind {
  StartupCleanupFailed + CleanupFailed + MarkerInvalidationFailed
  + WarningPersistenceFailed + SummaryRewriteFailed + ManifestRefreshFailed
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
  telemetryEnabled : one Bool,
  var catalog : one CatalogStage,
  var catalogReason : lone CatalogEmptyReason,
  var completedPhases : set Phase,
  var findings : set Finding,
  var reports : set ReportName,
  var manifestPresent : one Bool,
  var manifestFiles : set ReportName,
  var manifestAttemptSets : set AttemptSet,
  var failed : one Bool,
  // Post-completion derivative state. `coreComplete` remains true while the
  // manifest is temporarily invalidated and refreshed on the warning path.
  var finalStage : one FinalStage,
  var coreComplete : one Bool,
  var reportPresent : one Bool,
  var reportValid : one Bool,
  var warningPresent : one Bool,
  var summaryCurrent : one Bool,
  var finalFailure : lone FinalFailureKind,
  var agentInvoked : one Bool,
  // Startup residue is distinct from current-run output.
  var staleManifestPresent : one Bool,
  var staleManagedOutputPresent : one Bool,
  // metrics.json is a core-completion snapshot, not a post-completion report.
  var metricsPresent : one Bool,
  var metricsChecksummed : one Bool,
  var metricsListed : one Bool,
  var reportsAtomicallyComplete : one Bool
}

// --- Finding well-formedness ---
// Guards/Postconditions: required fields and preserved evidence admit a finding.
// Effects/Frames: none; these are static entity predicates.
pred finding_wellformed [f : Finding] {
  f.hasCategory = True
  one f.category
  some f.provenance
  f.hasDescription = True
  f.hasRationale = True
  some f.evidenceSet
}

pred finding_evidence_preserved [f : Finding] {
  all e : f.evidenceSet | e.preserved = True
}

// --- Report, path and agent entities ---

abstract sig GenArtifact {}
one sig GenSpecsDir, GenSpecsSmtDir extends GenArtifact {}
one sig FinalPathBinding {
  outputAbsolute : one Bool,
  workspaceAbsolute : one Bool,
  destinationAbsolute : one Bool,
  destinationConfined : one Bool,
  promptAgrees : one Bool,
  acknowledgmentAgrees : one Bool,
  validationAgrees : one Bool,
  containsPermissionWildcard : one Bool,
  containsSpaces : one Bool
}
abstract sig AgentCapability {}
one sig ReadCapability, SearchCapability, EditCapability, BashCapability,
  DelegateCapability, WebCapability, SkillCapability, QuestionCapability,
  TodoCapability, AutoApprovalCapability extends AgentCapability {}
one sig FinalAgentPolicy {
  configuredAllowed : set AgentCapability,
  admitted : one Bool
}
one sig FinalAgentInvocation {
  requestedCapabilities : set AgentCapability,
  effectiveCapabilities : set AgentCapability
}
one sig ReportProtocol {
  agentSucceeded : one Bool,
  strictUtf8 : one Bool,
  linesAreJsonEvents : one Bool,
  errorEventAbsent : one Bool,
  textFromTopLevelEventsOnly : one Bool,
  exactPayloadFields : one Bool,
  pathNonempty : one Bool,
  markdownNonempty : one Bool,
  noWrapperOrFence : one Bool,
  pureMode : one Bool,
  isolatedDir : one Bool,
  restrictedAgentSelected : one Bool,
  autoOmitted : one Bool
}
abstract sig PromptArtifact {}
one sig SourcePrompt, BundledPrompt extends PromptArtifact {}
one sig PromptInstruction {}
one sig PromptBuild {
  normalizedInstructions : PromptArtifact -> PromptInstruction,
  accepted : one Bool
}
one sig ReportCandidate {
  payloadPresent : one Bool,
  pathMatches : one Bool,
  publicationAtomic : one Bool,
  payloadNonWhitespace : one Bool,
  payloadWithinByteLimit : one Bool,
  payloadHeadingsComplete : one Bool,
  payloadRepositoryCitation : one Bool,
  payloadEveryFindingCited : one Bool,
  payloadContentId : one ContentIdentity,
  filePresent : one Bool,
  strictUtf8 : one Bool,
  regularFile : one Bool,
  symlink : one Bool,
  nonWhitespace : one Bool,
  withinByteLimit : one Bool,
  headingsComplete : one Bool,
  repositoryCitation : one Bool,
  everyFindingCited : one Bool,
  readBackContentId : one ContentIdentity
}
abstract sig ContentIdentity {}
one sig PayloadContent, AlternateContent extends ContentIdentity {}
abstract sig ReadBackStage {}
one sig MetadataPending, MetadataChecked, ContentRead, ReadRejected extends ReadBackStage {}
one sig ReportReadBack { var readStage : one ReadBackStage }

// --- Evidence and diagnostic entities ---

abstract sig AnalysisBasis {}
one sig FormalSolverBasis, CrossSideBasis, LLMBasis extends AnalysisBasis {}
abstract sig EvidenceSource {}
one sig SolverArtifact, ModelArtifact extends EvidenceSource {}
one sig ImplicationQuery, SolverResult, ClassificationRationale extends EvidenceSource {}
one sig LLMResponse extends EvidenceSource {}
abstract sig MarkdownControl {}
one sig LinkCtl, EmphasisCtl, InlineCodeCtl, HeadingCtl,
  ListItemCtl, BlockQuoteCtl, TableCellCtl extends MarkdownControl {}
abstract sig LogicDefectKind {}
one sig FunctionSignatureConflict, VariableSortConflict, SymbolKindCollision extends LogicDefectKind {}
one sig DuplicateRawClaimId, SanitizedIdCollision extends LogicDefectKind {}
abstract sig EvidenceRole {}
one sig SharedSanitizedSymbol, BothRawNames, BothClaimIds, ExclusionTuple extends EvidenceRole {}
one sig BothSorts, BothDeclKinds extends EvidenceRole {}
one sig DuplicatedRawIds, AffectedClaims, CollidingRawIds, SharedSanitizedId extends EvidenceRole {}
abstract sig CatalogCauseDetail {}
one sig InputCountDetail, ArchivedCountDetail, FilterReasonDetail extends CatalogCauseDetail {}
abstract sig CatalogRemediationCue {}
one sig EnsureRecognizedDocs, UseAllowArchiveFlag, ShowExcludingPolicy extends CatalogRemediationCue {}

// --- Metrics and invocation-evidence entities ---

abstract sig TelemetryPhase {}
one sig CoreOpenCodePhase, FinalReportTelemetryPhase extends TelemetryPhase {}
abstract sig PipelinePhaseName {}
one sig ReportingPhaseName, FormalizationPhaseName extends PipelinePhaseName {}
abstract sig AnalysisScope {}
one sig SpecsScope, GeneratedScope, FinalReportScope extends AnalysisScope {}
abstract sig AttemptOutcome {}
one sig AttemptSucceeded, AttemptFailed extends AttemptOutcome {}
abstract sig DurationUnit {}
one sig DurationA, DurationB, DurationFinal extends DurationUnit {}
abstract sig TokenUnit {}
one sig TokenA, TokenB, TokenFinal extends TokenUnit {}
abstract sig CostUnit {}
one sig CostA, CostB, CostFinal extends CostUnit {}
abstract sig ModelVariant {}
one sig DefaultVariant, ReasoningVariant extends ModelVariant {}
abstract sig TelemetryAttempt {
  attemptPhase : one TelemetryPhase,
  pipelinePhase : one PipelinePhaseName,
  attemptScope : one AnalysisScope,
  outcome : one AttemptOutcome,
  modelVariant : one ModelVariant,
  retryOf : lone TelemetryAttempt,
  durationUnits : some DurationUnit,
  tokenUnits : some TokenUnit,
  costUnits : some CostUnit
}
one sig CoreAttemptA, CoreAttemptB, FinalReportAttempt extends TelemetryAttempt {}
abstract sig PipelinePhaseDuration {
  phaseName : one PipelinePhaseName,
  durationUnits : some DurationUnit
}
one sig ReportingDuration, FormalizationDuration extends PipelinePhaseDuration {}
one sig MetricsSnapshot {
  persistedAttempts : set TelemetryAttempt,
  phaseDurations : set PipelinePhaseDuration,
  scopeTotalsCover : set AnalysisScope,
  durationTotal : set DurationUnit,
  tokenTotal : set TokenUnit,
  costTotal : set CostUnit
}
abstract sig ClaimSetKind {}
one sig SpecsForward, GeneratedSpec extends ClaimSetKind {}
sig Capability {}
sig AttemptSet {
  claimSetKind : one ClaimSetKind,
  setCapability : lone Capability,
  ordinal : lone Ordinal,
  var finalized : one Bool
}
sig Ordinal {}
sig WriteAttempt {
  resolvedLoc : one WriteLoc,
  writeResult : one WriteCompletion
}

// --- Derived domain values ---
// Effects/Frames: none; functions project existing observations and Run state.

// Postcondition: count precedence distinguishes empty-catalog causes.
fun classify [active, recog, allArch : Bool] : lone CatalogEmptyReason {
  (active = True) implies none
  else (recog = False) implies NoRecognizedDocs
  else (allArch = True) implies AllArchived
  else AllFiltered
}
fun remediationAllowArchive : set CatalogEmptyReason { AllArchived }
fun exitNum [e : ExitCode] : Int {
  (e = ExitSuccess) implies 0
  else (e = ExitFindings) implies 1
  else 5
}
fun runExit : one ExitCode {
  (Run.catalog = CatalogAborted) implies ExitCatalogError
  else (some Run.findings) implies ExitFindings
  else ExitSuccess
}
// Postcondition: code-derived directories exist together after comparison.
fun genArtifactsPresent : set GenArtifact {
  CodeCompare in Run.completedPhases implies (GenSpecsDir + GenSpecsSmtDir) else none
}
fun skippedPhases : set Phase { Phase - enabledPhases }
fun allowedAgentCapabilities : set AgentCapability { ReadCapability + SearchCapability }
fun deniedAgentCapabilities : set AgentCapability {
  EditCapability + BashCapability + DelegateCapability + WebCapability
  + SkillCapability + QuestionCapability + TodoCapability + AutoApprovalCapability
}
// Postcondition: every analysis basis has its source-specific evidence roles.
fun requiredEvidenceFor : AnalysisBasis -> EvidenceSource {
    FormalSolverBasis -> (SolverArtifact + ModelArtifact)
  + CrossSideBasis -> (ImplicationQuery + SolverResult + ClassificationRationale)
  + LLMBasis -> LLMResponse
}
fun neutralizedControls : set MarkdownControl { MarkdownControl }
fun rendersAsActiveStructure [rawContainsControl : Bool, neutralized : Bool] : Bool {
  (rawContainsControl = True and neutralized = False) implies True else False
}
fun mergeConflictKinds : set LogicDefectKind {
  FunctionSignatureConflict + VariableSortConflict + SymbolKindCollision
}
fun invalidGroupKinds : set LogicDefectKind { DuplicateRawClaimId + SanitizedIdCollision }
// Postcondition: each structural defect maps to its required diagnostic evidence.
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
fun logicSeverity [k : LogicDefectKind, sourceObligated : Bool] : one Severity { ErrorSev }
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
// Postcondition: core and optional-report attempts occupy distinct snapshot sets.
fun coreAttempts : set TelemetryAttempt {
  { a : TelemetryAttempt | a.attemptPhase = CoreOpenCodePhase }
}
fun finalReportAttempts : set TelemetryAttempt {
  { a : TelemetryAttempt | a.attemptPhase = FinalReportTelemetryPhase }
}

// --- Entity invariants ---
// Guards: configured entities or the named lifecycle state. Effects/Frames:
// constrain existing values only; no new transition or scheduler is introduced.

// Guard: observable document counts. Postcondition: survivors are recognized,
// and an archived-only catalog has no survivors. Effects/Frames: none.
pred catalogCountsWF [active, recog, allArch : Bool] {
  active = True implies recog = True
  allArch = True implies recog = True
  active = True implies allArch = False
}

fact configured_final_report_paths {
  path_preconditions
  FinalPathBinding.promptAgrees = True
}
fact final_agent_policy_admission {
  FinalAgentPolicy.admitted = True iff
    FinalAgentPolicy.configuredAllowed = allowedAgentCapabilities
}
fact configured_final_agent_policy {
  FinalAgentPolicy.configuredAllowed in allowedAgentCapabilities
  FinalAgentPolicy.admitted = True implies
    FinalAgentPolicy.configuredAllowed = allowedAgentCapabilities
}
fact final_agent_invocation_enforces_policy {
  FinalAgentInvocation.effectiveCapabilities
    = FinalAgentInvocation.requestedCapabilities & FinalAgentPolicy.configuredAllowed
}
fact prompt_bundle_admission {
  PromptBuild.accepted = True iff
    SourcePrompt.(PromptBuild.normalizedInstructions)
      = BundledPrompt.(PromptBuild.normalizedInstructions)
}
fact distributed_prompt_is_admitted {
  PromptBuild.accepted = True implies
    some SourcePrompt.(PromptBuild.normalizedInstructions)
}
fact final_report_invocation_controls { protocol_preconditions }

// Postcondition: fixed metric observations distinguish core from final-report work.
fact pipeline_phase_duration_kinds {
  ReportingDuration.phaseName = ReportingPhaseName
  ReportingDuration.durationUnits = DurationA
  FormalizationDuration.phaseName = FormalizationPhaseName
  FormalizationDuration.durationUnits = DurationA + DurationB
  DurationFinal not in MetricsSnapshot.phaseDurations.durationUnits
}
fact telemetry_attempt_kinds {
  CoreAttemptA.attemptPhase = CoreOpenCodePhase
  CoreAttemptB.attemptPhase = CoreOpenCodePhase
  FinalReportAttempt.attemptPhase = FinalReportTelemetryPhase
  CoreAttemptA.pipelinePhase = FormalizationPhaseName
  CoreAttemptB.pipelinePhase = FormalizationPhaseName
  FinalReportAttempt.pipelinePhase = ReportingPhaseName
  CoreAttemptA.attemptScope = SpecsScope
  CoreAttemptB.attemptScope = GeneratedScope
  FinalReportAttempt.attemptScope = FinalReportScope
  CoreAttemptA.outcome = AttemptFailed
  CoreAttemptB.outcome = AttemptSucceeded
  FinalReportAttempt.outcome = AttemptSucceeded
  CoreAttemptA.modelVariant = DefaultVariant
  CoreAttemptB.modelVariant = ReasoningVariant
  FinalReportAttempt.modelVariant = ReasoningVariant
  no CoreAttemptA.retryOf
  CoreAttemptB.retryOf = CoreAttemptA
  no FinalReportAttempt.retryOf
  CoreAttemptA.durationUnits = DurationA
  CoreAttemptB.durationUnits = DurationB
  FinalReportAttempt.durationUnits = DurationFinal
  CoreAttemptA.tokenUnits = TokenA
  CoreAttemptB.tokenUnits = TokenB
  FinalReportAttempt.tokenUnits = TokenFinal
  CoreAttemptA.costUnits = CostA
  CoreAttemptB.costUnits = CostB
  FinalReportAttempt.costUnits = CostFinal
}
fact metrics_snapshot_inventory {
  MetricsSnapshot.persistedAttempts = coreAttempts
  MetricsSnapshot.phaseDurations = PipelinePhaseDuration
  MetricsSnapshot.scopeTotalsCover = coreAttempts.attemptScope
  MetricsSnapshot.durationTotal = coreAttempts.durationUnits
  MetricsSnapshot.tokenTotal = coreAttempts.tokenUnits
  MetricsSnapshot.costTotal = coreAttempts.costUnits
}

// Postcondition: one invocation namespace per durable attempt-evidence file.
fact attempt_set_namespace {
  all a : AttemptSet |
    (a.claimSetKind = SpecsForward implies (no a.setCapability and no a.ordinal))
    and (a.claimSetKind = GeneratedSpec implies (one a.setCapability and one a.ordinal))
}
fact one_file_per_invocation {
  all disj a1, a2 : AttemptSet |
    (a1.claimSetKind = SpecsForward and a2.claimSetKind = SpecsForward) implies a1 = a2
  all disj a1, a2 : AttemptSet |
    (a1.claimSetKind = GeneratedSpec and a2.claimSetKind = GeneratedSpec
     and a1.setCapability = a2.setCapability) implies a1.ordinal != a2.ordinal
}
fact attempt_evidence_monotonic {
  always (all a : AttemptSet | a.finalized = True implies a.finalized' = True)
}
fact non_formalization_events_frame_attempt_sets {
  always ((not (some a : AttemptSet | finalize_attempt_set[a])) implies
    (all a : AttemptSet | a.finalized' = a.finalized))
}

// Postcondition: manifest entries describe finalized outputs with matching checksums.
fact manifest_entries_describe_run {
  always (Run.manifestPresent = True implies
    (all e : ManifestEntry |
      (some e.entryReport implies e.entryReport in Run.reports) and
      (some e.entryAttemptSet implies e.entryAttemptSet in Run.manifestAttemptSets) and
      (some e.entryMetrics implies Run.metricsListed = True) and
      (no e.entryReport or e.entryReport = R_Summary
        or e.entryPhase in reportManifestPhase[phaseToReport[Run.completedPhases]]) and
      e.checksumValid = True))
}
fact manifest_entries_cover_nonreport_artifacts {
  always (Run.manifestPresent = True implies complete_manifest_entries)
}
// Safety assumptions at the filesystem boundary; integration tests establish them.
fact confinement_enforced {
  all w : WriteAttempt |
    w.resolvedLoc = OutsideDir implies w.writeResult != AtomicComplete
}
fact no_temp_at_final {
  always (all f : OutputFile | f.pathState in (Absent + FinalComplete))
}
// Safety: the run admits only well-formed findings with preserved evidence.
fact only_wellformed_findings {
  always (all f : Run.findings | finding_wellformed[f])
  always (all f : Run.findings | finding_evidence_preserved[f])
}

// --- Release, transport and verification boundary entities ---
// Observations are immutable inputs, not new global facts or pipeline ticks.
// Executable fixtures establish CLI/config, decoding, byte/hash and OS behavior.

abstract sig RAEMajor {}
one sig RAEV1, RAEV2 extends RAEMajor {}
sig RAEValue {}
sig RAEReleaseEvidence {
  major : one RAEMajor,
  recorded : one Bool,
  configPrecedenceVerified : one Bool,
  approvedReadsVerified : one Bool,
  credentialsUsable : one Bool,
  deniedAuthorityVerified : one Bool,
  externalPluginsExcluded : one Bool,
  ambientMcpExcluded : one Bool,
  builtinsUsable : one Bool,
  credentialsCopied : one Bool,
  userConfigChanged : one Bool,
  privateConfig : one Bool,
  projectDisabled : one Bool,
  cwdMatchesPwd : one Bool,
  standalone : one Bool,
  pureFlag : one Bool,
  dirFlag : one Bool,
  autoApproval : one Bool
}
sig RAEEvent {
  isText : one Bool,
  isError : one Bool,
  textValue : lone RAEValue
}
sig RAEStream {
  events : set RAEEvent,
  strictUtf8 : one Bool,
  validEventLines : one Bool,
  phasePayloadValid : one Bool,
  zeroExit : one Bool,
  signalled : one Bool,
  usagePresent : one Bool,
  usageValid : one Bool
}
sig RAEMetricRecord {
  probe : one Bool,
  recordedAsAttempt : one Bool,
  historical : one Bool,
  detectedMajor : one RAEMajor,
  storedMajor : lone RAEMajor,
  baseModel : one RAEValue,
  selectedVariant : lone RAEValue,
  storedModel : one RAEValue,
  storedVariant : lone RAEValue,
  schemaV1 : one Bool,
  includesArgv : one Bool,
  includesCredentials : one Bool
}
abstract sig RAEAttemptFailure {}
one sig RAECaptureOverflow, RAECallTimeout, RAEOtherFailure extends RAEAttemptFailure {}
sig RAECollectionMode {
  requestedAtStart : one Bool,
  explicitlyInjected : one Bool,
  currentEnvironment : one Bool, // deliberately excluded from mode selection
  collectorBound : one Bool,
  usageParsingAllowed : one Bool,
  retentionAllowed : one Bool,
  publicationAllowed : one Bool
}
sig RAECitation {
  wholeToken : one Bool,
  relativeSyntax : one Bool, // excludes URL/absolute/drive/UNC/home forms
  traversal : one Bool,
  controlCharacters : one Bool,
  visible : one Bool, // outside code fences and comments
  artifactReference : one Bool, // includes explicit extensionless root links
  customDirectory : one Bool // no directory allowlist participates in admission
}
sig RAEHistoryObservation {
  productionCoordinator : one Bool,
  independentEffects : one Bool,
  orderedEffects : one Bool,
  hashesMatch : one Bool,
  initialCoreComplete : one Bool,
  coreBundlePreserved : one Bool,
  markerInvalidated : one Bool,
  manifestPresent : one Bool,
  observedStage : one FinalStage,
  referenceStage : one FinalStage,
  failure : lone FinalFailureKind
}

// --- Boundary projections ---
// Effects/Frames: none; derived values leave the existing Run state unchanged.

// Postcondition: only top-level text events contribute response text.
fun rae_response_text[s : RAEStream] : set RAEValue {
  { e : s.events | e.isText = True and e.isError = False }.textValue
}
// Postcondition: overflow classification precedes any competing timeout.
fun rae_attempt_failure[overflow, timedOut : Bool] : one RAEAttemptFailure {
  overflow = True => RAECaptureOverflow else
    (timedOut = True => RAECallTimeout else RAEOtherFailure)
}

// --- Conditional boundary invariants ---
// Guards: an observation is admitted under its named contract.
// Effects/Frames: none; these predicates do not constrain the global lifecycle.

pred rae_metric_shape[m : RAEMetricRecord] {
  // Postcondition: schema-v1 metadata matches semantic selection without secrets.
  m.schemaV1 = True
  m.includesArgv = False
  m.includesCredentials = False
  m.probe = True implies m.recordedAsAttempt = False
  m.probe = False implies {
    m.recordedAsAttempt = True
    m.storedModel = m.baseModel
    m.storedVariant = m.selectedVariant
    m.historical = False implies m.storedMajor = m.detectedMajor
    some m.storedMajor implies m.storedMajor = m.detectedMajor
  }
}
pred rae_collection_contract[m : RAECollectionMode] {
  // Postcondition: collection uses startup opt-in/injection; publication uses opt-in.
  (m.collectorBound = True iff rae_collection_enabled[m])
  (m.usageParsingAllowed = True iff rae_collection_enabled[m])
  (m.retentionAllowed = True iff rae_collection_enabled[m])
  (m.publicationAllowed = True iff m.requestedAtStart = True)
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
- Implementation: [run-cli.ts:83 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L83), [catalog.ts:222 classifyEmptyCatalogReason()](/src/domain/parser/catalog.ts#L222)
- Test: [cli.test.ts:184 formats no_recognized_docs with input count](/test/contract/cli.test.ts#L184), [catalog.test.ts:101 returns no_recognized_docs for directories without OpenSpec docs](/test/contract/catalog.test.ts#L101)
- Test (integration): [catalog-abort.integration.test.ts:53 aborts pipeline on no_recognized_docs — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L53)
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
- Implementation: [run-cli.ts:83 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L83), [catalog.ts:222 classifyEmptyCatalogReason()](/src/domain/parser/catalog.ts#L222)
- Test: [cli.test.ts:191 formats all_archived with archived count and --allow-archive guidance](/test/contract/cli.test.ts#L191), [catalog.test.ts:27 excludes archived change specs by default](/test/contract/catalog.test.ts#L27)
- Test (integration): [catalog-abort.integration.test.ts:82 aborts pipeline on all_archived without --allow-archive — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L82)
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
- Implementation: [run-cli.ts:83 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L83), [catalog.ts:222 classifyEmptyCatalogReason()](/src/domain/parser/catalog.ts#L222)
- Test: [cli.test.ts:198 formats all_filtered with count and filter reason](/test/contract/cli.test.ts#L198), [catalog.test.ts:113 returns all_filtered when all recognized docs are excluded by capability resolution](/test/contract/catalog.test.ts#L113)
- Test (integration): [catalog-abort.integration.test.ts:111 aborts pipeline on all_filtered — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L111)
- Example:
```typescript
const { formatCatalogEmptyMessage } = await import("./src/cli/run-cli.ts");
const msg = formatCatalogEmptyMessage({ kind: "all_filtered", filteredCount: 2, filterReason: "capability resolution" }); //=> type String
msg.includes("capability resolution"); //=> true
msg.includes("2"); //=> true
```

#### Requirement model

```alloy
// --- Catalog-empty classification and CLI failure ---
// Effects/Frames: assertions observe the classifier and existing Run lifecycle.
// Safety: a well-formed empty catalog has a cause; nonempty catalogs do not.
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
- Implementation: [render.ts:138 writePhaseReports()](/src/domain/reporting/render.ts#L138), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553)
- Test: [reporting.test.ts:25 writes phase reports at correct naming convention](/test/contract/reporting.test.ts#L25)
- Test (integration): [specs-forward.integration.test.ts:18 produces phase reports and summary](/test/integration/specs-forward.integration.test.ts#L18), [pipeline.integration.test.ts:330 full pipeline produces summary with all finding categories](/test/integration/pipeline.integration.test.ts#L330)

#### Scenario: Emit Code-Derived Evidence Directories [RAE-REPORT-GENSPECS]
WHEN code-backwards analysis completes for a run, THE spec-check tool SHALL persist the `gen_specs/` directory containing code-derived Markdown specifications and the `gen_specs_smt/` directory containing code-derived SMT-LIB artifacts under the configured output directory.

**Postcondition:** Code-derived intermediate artifacts are available for reviewer inspection alongside reports.

##### Evidence
- Implementation: [pipeline-helpers.ts:468 runCodeBackwardsWork()](/src/cli/pipeline-helpers.ts#L468)
- Test (integration): [pipeline.integration.test.ts:165 code-derived spec generation produces gen_specs files per capability](/test/integration/pipeline.integration.test.ts#L165)

#### Scenario: Explain Skipped Report Scope [RAE-REPORT-SKIP]
IF an optional phase is not enabled for a run, THEN THE spec-check tool SHALL explain that skipped scope in the synthesized reporting rather than omit it silently.

**Postcondition:** Reviewers can distinguish intentionally skipped analysis from missing output.

##### Evidence
- Implementation: [render.ts:247 writeSummaryReport()](/src/domain/reporting/render.ts#L247), [pipeline-helpers.ts:81 computeSkippedPhases()](/src/cli/pipeline-helpers.ts#L81)
- Test: [reporting.test.ts:52 includes skipped-phase explanations](/test/contract/reporting.test.ts#L52)
- Test (integration): [specs-forward.integration.test.ts:18 produces phase reports and summary](/test/integration/specs-forward.integration.test.ts#L18)

#### Scenario: Suppress Vacuous Reports On Catalog Error [RAE-REPORT-CATALOG]
IF the catalog phase ends in `CatalogError`, THEN THE spec-check tool SHALL NOT emit downstream qualitative, formal, or comparison reports for that run.

**Postcondition:** Report output accurately reflects that analysis never proceeded past catalog construction.

##### Evidence
- Implementation: [run-cli.ts:284 runIngestionPhases()](/src/cli/run-cli.ts#L284)
- Test (integration): [catalog-abort.integration.test.ts:53 aborts pipeline on no_recognized_docs — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L53), [catalog-abort.integration.test.ts:82 aborts pipeline on all_archived without --allow-archive — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L82), [catalog-abort.integration.test.ts:111 aborts pipeline on all_filtered — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L111)

#### Requirement model

```alloy
// --- Report emission: mode-dependent phase output ---

pred complete_phase [p : Phase] {
  // Guard
  p not in Run.completedPhases
  p in enabledPhases
  Run.catalog = CatalogConstructed   // phases run only after catalog survives
  Run.finalStage = CoreReporting
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
  frame_final_state
  Run.metricsPresent' = Run.metricsPresent
  Run.metricsChecksummed' = Run.metricsChecksummed
  Run.metricsListed' = Run.metricsListed
  Run.reportsAtomicallyComplete' = False
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
// Code-backwards analysis is represented by the code-derived comparison phase
// (report_2.compare). Directory presence is DERIVED from completedPhases (no
// redundant state): both directories exist exactly when that phase has
// completed. runCodeBackwardsWork persists gen_specs/ and gen_specs_smt/.
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
WHEN the spec-check tool writes phase reports or synthesized reports, THE spec-check tool SHALL use these stable names: `report_1.1.md` for the first qualitative pass, `report_1.2.md` for the properties and invariants pass, `report_1.3.md` for coverage analysis, `report_1.logic.md` for logic analysis, `report_2.trace.md` for source traceability, `report_2.logic.md` for code-derived formal analysis, `report_2.compare.md` for code-backwards comparison, `report_summary.md` for the core synthesized summary, and `report.md` for the optional post-completion final assessment.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Scope`

#### Scenario: Phase Report Named Correctly [RAE-NAMES-PHASE]
WHEN the qualitative analysis phase completes its first pass, THE spec-check tool SHALL write the report to `report_1.1.md` under the output directory.

**Postcondition:** Report consumers can locate phase output using the documented naming convention.

##### Evidence
- Implementation: [render.ts:138 writePhaseReports()](/src/domain/reporting/render.ts#L138)
- Test: [reporting.test.ts:25 writes phase reports at correct naming convention](/test/contract/reporting.test.ts#L25)
- Test (integration): [pipeline.integration.test.ts:330 full pipeline produces summary with all finding categories](/test/integration/pipeline.integration.test.ts#L330)

#### Scenario: Code-Derived Logic Report Named Correctly [RAE-NAMES-GENLOGIC]
WHEN code-derived solver analysis completes, THE spec-check tool SHALL write the report to `report_2.logic.md` under the output directory.

**Postcondition:** Code-derived formal analysis is at a predictable path distinct from specs-forward logic analysis.

##### Evidence
- Implementation: [render.ts:138 writePhaseReports()](/src/domain/reporting/render.ts#L138)
- Test: [reporting.test.ts:146 writes code-derived logic report at report_2.logic.md](/test/contract/reporting.test.ts#L146)

#### Scenario: Summary Report Named Correctly [RAE-NAMES-SUMMARY]
WHEN the core synthesized summary is generated, THE spec-check tool SHALL write it to `report_summary.md` under the output directory.

**Postcondition:** The core summary is always at a predictable path.

##### Evidence
- Implementation: [render.ts:247 writeSummaryReport()](/src/domain/reporting/render.ts#L247)
- Test: [reporting.test.ts:40 writes summary report at report_summary.md](/test/contract/reporting.test.ts#L40)
- Test (integration): [pipeline.integration.test.ts:330 full pipeline produces summary with all finding categories](/test/integration/pipeline.integration.test.ts#L330)

#### Scenario: Final Assessment Named Correctly [RAE-NAMES-FINAL]
WHEN final-report generation succeeds, THE spec-check tool SHALL preserve the validated assessment at `report.md` under the output directory.

**Postcondition:** Consumers can distinguish the decision-oriented derivative from phase and summary reports.

##### Evidence
- Implementation: [final-report.ts:20 FINAL_REPORT_PATH](/src/domain/reporting/final-report.ts#L20), [final-report.ts:264 generateFinalReport()](/src/domain/reporting/final-report.ts#L264)
- Test: [final-report.test.ts:128 accepts a regular report at the exact byte limit](/test/contract/final-report.test.ts#L128), [final-report.test.ts:325 uses the acknowledgment only for equality and validates the designated file](/test/contract/final-report.test.ts#L325)

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

### Requirement: Generate Optional Final Assessment [RAE-FINAL-REPORT]
WHEN the core evidence manifest is successfully written, THE spec-check tool SHALL attempt to generate one optional decision-oriented Markdown assessment at `report.md` from the completed evidence bundle.

**References:**
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Domain-Model`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/design.md#System-Model`

#### Scenario: Generate After Core Completion [RAE-FINAL-AFTER-CORE]
WHEN final-report generation starts, THE spec-check tool SHALL have already finalized the phase reports, `report_summary.md`, and the core `manifest.json`.

**Postcondition:** The report agent can read a completion manifest that describes the complete core evidence bundle.

##### Evidence
- Implementation: [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553)
- Test (integration): [merge-pipeline.integration.test.ts:215 persists a nonfatal final-report warning and refreshes the summary checksum](/test/integration/merge-pipeline.integration.test.ts#L215)

#### Scenario: Save Valid Final Report [RAE-FINAL-SAVE]
WHEN the report agent returns a valid path and Markdown payload, THE spec-check tool SHALL atomically publish and independently validate `report.md`.

**Postcondition:** Exactly one valid final report is available for the current run.

##### Evidence
- Implementation: [final-report.ts:264 generateFinalReport()](/src/domain/reporting/final-report.ts#L264), [final-report.ts:370 validateFinalReport()](/src/domain/reporting/final-report.ts#L370)
- Test: [final-report.test.ts:325 uses the acknowledgment only for equality and validates the designated file](/test/contract/final-report.test.ts#L325)
- Test (integration): [merge-pipeline.integration.test.ts:271 removes stale report output before the current final-report attempt](/test/integration/merge-pipeline.integration.test.ts#L271)

#### Scenario: Final Report Is Optional [RAE-FINAL-OPTIONAL]
IF final-report generation or validation fails after core completion, THEN THE spec-check tool SHALL preserve the completed analysis and SHALL represent the failure as a warning rather than a fatal pipeline error.

**Postcondition:** Core completion remains true even though no final report is available; the warning may produce the existing findings-present exit code.

##### Evidence
- Implementation: [final-report-lifecycle.ts:65 coordinateFinalReportLifecycle()](/src/cli/final-report-lifecycle.ts#L65), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553), [run-cli.ts:632 finalReportFailureFinding()](/src/cli/run-cli.ts#L632), [final-report.ts:164 reduceFinalReportLifecycle()](/src/domain/reporting/final-report.ts#L164)
- Test: [final-report.test.ts:425 maps terminal OpenCode %s to a nonfatal agent failure](/test/contract/final-report.test.ts#L425), [final-report.test.ts:451 enforces guarded transitions and terminal stuttering](/test/contract/final-report.test.ts#L451)
- Test (property): [final-report.property.test.ts:32 legal success and failure histories reach exactly one terminal state](/test/property/final-report.property.test.ts#L32), [final-report.property.test.ts:55 generated stuttering and failure-point histories preserve lifecycle invariants](/test/property/final-report.property.test.ts#L55)
- Test (integration): [merge-pipeline.integration.test.ts:215 persists a nonfatal final-report warning and refreshes the summary checksum](/test/integration/merge-pipeline.integration.test.ts#L215), [merge-pipeline.integration.test.ts:259 persists warning for final-report %s degradation](/test/integration/merge-pipeline.integration.test.ts#L259)

#### Requirement model

```alloy
// --- Optional final assessment: post-completion lifecycle ---

// Preconditions for invoking the optional report agent. Core reports and the
// summary are complete, and manifest presence attests the core evidence bundle.
pred final_report_preconditions {
  // Guards/Postconditions: a complete current core bundle has no current report.
  // Effects/Frames: none; invocation is performed only by start_final_report.
  Run.finalStage = CoreComplete
  Run.coreComplete = True
  Run.manifestPresent = True
  requiredReports in Run.reports
  Run.summaryCurrent = True
  Run.reportPresent = False
}

// Guard: core complete, safe paths, admitted policy/prompt and isolated protocol.
// Effect: invoke generation. Frame: core artifacts/observations. Postcondition: no failure.
pred start_final_report {
  final_report_preconditions
  request_paths_safe
  protocol_preconditions
  FinalAgentPolicy.admitted = True
  PromptBuild.accepted = True
  Run.finalStage' = Generating
  Run.agentInvoked' = True
  Run.finalFailure' = none
  frame_core_and_final_files
  frame_final_observations
}

// Guard: successful isolated agent return. Effect: begin validation.
// Frame: core/files/observations. Postcondition: no publication is inferred from text.
pred generation_returns {
  Run.finalStage = Generating
  protocol_preconditions
  ReportProtocol.agentSucceeded = True
  Run.finalStage' = Validating
  Run.agentInvoked' = Run.agentInvoked
  Run.finalFailure' = Run.finalFailure
  frame_core_and_final_files
  frame_final_observations
}

// Guard: classified generation failure. Effect: enter cleanup and record its kind.
// Frame: core/files/observations. Postcondition: core completion is preserved.
pred generation_fails [k : FinalFailureKind] {
  Run.finalStage = Generating
  k in generationFinalFailures
  k = AgentFailed implies ReportProtocol.agentSucceeded = False
  Run.finalStage' = Cleaning
  Run.finalFailure' = k
  Run.agentInvoked' = Run.agentInvoked
  frame_core_and_final_files
  frame_final_observations
}

// Guard: published candidate passes path, protocol and independent file checks.
// Effect: expose a valid report. Frame: core/metrics. Postcondition: one current report.
pred validation_succeeds {
  Run.finalStage = PublishedCandidate
  final_paths_safe
  protocol_preconditions
  acknowledgment_valid
  candidate_valid
  Run.finalStage' = ReportAvailable
  Run.reportPresent' = True
  Run.reportValid' = True
  Run.agentInvoked' = Run.agentInvoked
  Run.finalFailure' = none
  frame_core_state
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  frame_metrics
  FinalReportDestination.reportPathState = FinalComplete
  FinalReportDestination.reportPathState' = FinalReportDestination.reportPathState
  all f : OutputFile | f.pathState' = f.pathState
}

// Trusted code atomically publishes a payload that passed all pre-write checks.
// Guard: safe valid payload, absent destination. Effect: atomic publication.
// Frame: core/observations/other files. Postcondition: candidate awaits read-back.
pred publish_candidate {
  Run.finalStage = Validating
  final_paths_safe
  acknowledgment_valid
  candidate_payload_valid
  ReportCandidate.publicationAtomic = True
  FinalReportDestination.reportPathState = Absent
  FinalReportDestination.reportPathState' = FinalComplete
  Run.finalStage' = PublishedCandidate
  Run.agentInvoked' = Run.agentInvoked
  Run.finalFailure' = Run.finalFailure
  frame_core_state
  frame_final_observations
  all f : OutputFile | f.pathState' = f.pathState
}

pred publish_candidate_enabled {
  Run.finalStage = Validating
  final_paths_safe
  acknowledgment_valid
  candidate_payload_valid
  ReportCandidate.publicationAtomic = True
}

// Permission wildcard rejection occurs before invocation.
// Guard: wildcard path after core completion. Effect: classify failure and clean.
// Frame: core/files/observations. Postcondition: the agent is not invoked.
pred reject_unsafe_path {
  Run.finalStage = CoreComplete
  Run.coreComplete = True
  FinalPathBinding.containsPermissionWildcard = True
  Run.finalStage' = Cleaning
  Run.finalFailure' = PathUnsupported
  Run.agentInvoked' = False
  frame_core_and_final_files
  frame_final_observations
}

// Guard: safe path but unadmitted policy/prompt. Effect: fail closed to cleanup.
// Frame: core/files/observations. Postcondition: the agent is not invoked.
pred reject_unadmitted_agent_or_prompt {
  Run.finalStage = CoreComplete
  Run.coreComplete = True
  FinalPathBinding.containsPermissionWildcard = False
  FinalAgentPolicy.admitted = False or PromptBuild.accepted = False
  Run.finalStage' = Cleaning
  Run.finalFailure' = AgentFailed
  Run.agentInvoked' = False
  frame_core_and_final_files
  frame_final_observations
}

pred start_final_report_enabled {
  final_report_preconditions
  request_paths_safe
  protocol_preconditions
  FinalAgentPolicy.admitted = True
  PromptBuild.accepted = True
}

pred reject_unsafe_path_enabled {
  Run.finalStage = CoreComplete
  Run.coreComplete = True
  FinalPathBinding.containsPermissionWildcard = True
}

pred reject_unadmitted_agent_or_prompt_enabled {
  Run.finalStage = CoreComplete
  Run.coreComplete = True
  FinalPathBinding.containsPermissionWildcard = False
  FinalAgentPolicy.admitted = False or PromptBuild.accepted = False
}

// Guard: classified payload/read-back failure. Effect: record kind and enter cleanup.
// Frame: core/files/observations. Postcondition: invalid residue is not accepted.
pred validation_fails [k : FinalFailureKind] {
  Run.finalStage in Validating + PublishedCandidate
  k in validationFinalFailures
  final_failure_cause[k]
  Run.finalStage' = Cleaning
  Run.finalFailure' = k
  Run.agentInvoked' = Run.agentInvoked
  frame_core_and_final_files
  frame_final_observations
}

pred validation_failure_enabled [k : FinalFailureKind] {
  Run.finalStage in Validating + PublishedCandidate
  k in validationFinalFailures
  final_failure_cause[k]
}

// Guards/Postconditions: the bounded, nonempty payload has structure and citations.
// Effects/Frames: none; file publication/read-back require separate events.
pred candidate_payload_valid {
  ReportCandidate.payloadPresent = True
  ReportCandidate.pathMatches = True
  ReportCandidate.payloadNonWhitespace = True
  ReportCandidate.payloadWithinByteLimit = True
  ReportCandidate.payloadHeadingsComplete = True
  ReportCandidate.payloadRepositoryCitation = True
  ReportCandidate.payloadEveryFindingCited = True
}

// Each stable validation failure kind has one normative cause.
pred final_failure_cause [k : FinalFailureKind] {
  k = AcknowledgmentInvalid implies {
    Run.finalStage = Validating
    not acknowledgment_valid or ReportCandidate.payloadPresent = False
  }
  k = PathMismatch implies {
    Run.finalStage = Validating
    acknowledgment_valid
    FinalPathBinding.acknowledgmentAgrees = False
      or ReportCandidate.pathMatches = False
  }
  k = ReportMissing implies {
    Run.finalStage = PublishedCandidate
    ReportCandidate.filePresent = False
  }
  k = ReportSymlink implies {
    Run.finalStage = PublishedCandidate
    ReportCandidate.symlink = True
  }
  k = ReportNotRegular implies {
    Run.finalStage = PublishedCandidate
    ReportCandidate.regularFile = False
  }
  k = ReportEmpty implies
    (Run.finalStage = Validating and ReportCandidate.payloadNonWhitespace = False)
      or (Run.finalStage = PublishedCandidate and ReportReadBack.readStage = ContentRead
        and ReportCandidate.nonWhitespace = False)
  k = ReportStructureInvalid implies {
    (Run.finalStage = Validating and (
      ReportCandidate.payloadHeadingsComplete = False
        or ReportCandidate.payloadRepositoryCitation = False
        or ReportCandidate.payloadEveryFindingCited = False))
    or (Run.finalStage = PublishedCandidate and ReportReadBack.readStage = ContentRead and (
      ReportCandidate.headingsComplete = False
        or ReportCandidate.repositoryCitation = False
        or ReportCandidate.everyFindingCited = False))
  }
  k = ReportTooLarge implies
    (Run.finalStage = Validating and ReportCandidate.payloadWithinByteLimit = False)
      or (Run.finalStage = PublishedCandidate and ReportCandidate.withinByteLimit = False)
  k = ReportUnreadable implies {
    (Run.finalStage = Validating and ReportCandidate.publicationAtomic = False)
    or (Run.finalStage = PublishedCandidate and ReportReadBack.readStage = ContentRead and (
      ReportCandidate.strictUtf8 = False
        or FinalPathBinding.validationAgrees = False
        or ReportCandidate.readBackContentId != ReportCandidate.payloadContentId))
  }
}

assert validating_has_classified_outcome {
  always (Run.finalStage = Validating implies
    (publish_candidate_enabled
      or some k : validationFinalFailures | validation_failure_enabled[k]))
}

assert published_candidate_has_classified_outcome {
  always (Run.finalStage = PublishedCandidate implies
    (inspect_report_metadata or read_report_content or candidate_valid
      or some k : validationFinalFailures | validation_failure_enabled[k]))
}

// Success postcondition: exactly one current, independently validated report is
// available, core completion remains true, and report.md is not self-manifested.
assert valid_report_postcondition {
  always (Run.finalStage = ReportAvailable implies {
    Run.coreComplete = True
    Run.reportPresent = True
    Run.reportValid = True
    FinalReportDestination.reportPathState = FinalComplete
    Run.warningPresent = False
    R_Final not in Run.manifestFiles
  })
}

assert final_report_terminal_states_stutter {
  always (Run.finalStage in ReportAvailable + WarningPersisted + OutputFailed
    implies Run.finalStage' = Run.finalStage)
}

// Safety: report generation and every later stage require prior core completion.
assert final_report_starts_after_core_completion {
  always (Run.finalStage in Generating + Validating + PublishedCandidate + Cleaning + Cleaned + WarningRecorded
    + MarkerInvalidated + SummaryRewritten + ManifestRefreshing
    + ReportAvailable + WarningPersisted
    implies Run.coreComplete = True)
}

// Optionality: handled report failure does not revoke completed core analysis.
assert core_completion_monotonic_after_attempt {
  always (Run.coreComplete = True implies Run.coreComplete' = True)
}

// RAE-FINAL-OPTIONAL: handled failure is observable but nonfatal to core completion.
assert handled_failure_preserves_core {
  always (Run.finalStage = WarningPersisted implies {
    Run.coreComplete = True
    Run.failed = False
    Run.reportPresent = False
    Run.warningPresent = True
  })
}
```

### Requirement: Bind Final Report Paths [RAE-FINAL-PATHS]
THE spec-check tool SHALL resolve the configured output directory to an absolute path and SHALL use one confined absolute `report.md` path for the prompt, payload comparison, atomic publication, and filesystem validation.

**References:**
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Preconditions-Postconditions-and-Invariants`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/design.md#Interface-Contracts`

#### Scenario: Resolve Relative Output [RAE-FINAL-PATH-ABS]
WHEN a relative output directory is configured, THE spec-check tool SHALL resolve it to an absolute path before final-report request construction.

**Postcondition:** Prompt and permission behavior is independent of the caller's relative path spelling.

##### Evidence
- Implementation: [config.ts:198 resolveRunConfig()](/src/cli/config.ts#L198), [final-report.ts:264 generateFinalReport()](/src/domain/reporting/final-report.ts#L264)
- Test: [config.test.ts:69 resolves every configured output spelling to an absolute path](/test/contract/config.test.ts#L69), [config.test.ts:92 resolves output supplied only by the config file](/test/contract/config.test.ts#L92)

#### Scenario: Preserve Paths With Spaces [RAE-FINAL-PATH-SPACE]
WHEN an absolute evidence or report path contains spaces, THE spec-check tool SHALL pass and compare that path without shell interpolation or token splitting.

**Postcondition:** The exact configured destination remains authoritative.

##### Evidence
- Implementation: [final-report.ts:264 generateFinalReport()](/src/domain/reporting/final-report.ts#L264), [final-report.ts:174 buildFinalReportPrompt()](/src/domain/prompts/final-report.ts#L174), [process.ts:115 runProcess()](/src/adapters/process.ts#L115)
- Test: [final-report.test.ts:44 substitutes absolute paths exactly without replacement interpolation](/test/contract/final-report.test.ts#L44), [opencode.test.ts:48 constructs restricted final-report argv and inline environment](/test/contract/opencode.test.ts#L48)
- Test (property): [final-report.property.test.ts:19 preserves generated literal paths exactly](/test/property/final-report.property.test.ts#L19)

#### Scenario: Reject Acknowledgment Mismatch [RAE-FINAL-PATH-MISMATCH]
IF the acknowledgment `report_path` does not equal the designated absolute destination, THEN THE spec-check tool SHALL reject the report attempt and SHALL NOT read the acknowledged alternate path.

**Postcondition:** Model output cannot redirect validation outside the configured destination.

##### Evidence
- Implementation: [final-report.ts:264 generateFinalReport()](/src/domain/reporting/final-report.ts#L264)
- Test: [final-report.test.ts:325 uses the acknowledgment only for equality and validates the designated file](/test/contract/final-report.test.ts#L325), [final-report.test.ts:354 does not inspect an acknowledged alternate path](/test/contract/final-report.test.ts#L354)

#### Scenario: Reject Permission Wildcards [RAE-FINAL-PATH-WILDCARD]
IF the absolute evidence or report path contains `*` or `?`, THEN THE spec-check tool SHALL NOT invoke the report agent and SHALL classify the optional report attempt as failed.

**Postcondition:** OpenCode wildcard matching cannot broaden read-only external-directory access.

##### Evidence
- Implementation: [final-report.ts:264 generateFinalReport()](/src/domain/reporting/final-report.ts#L264), [final-report.ts:158 isPermissionLiteralPath()](/src/domain/prompts/final-report.ts#L158)
- Test: [final-report.test.ts:55 rejects wildcard paths that cannot express exact edit authority](/test/contract/final-report.test.ts#L55)
- Test (property): [final-report.property.test.ts:19 preserves generated literal paths exactly](/test/property/final-report.property.test.ts#L19)

#### Requirement model

```alloy
// --- Final-report path binding and confinement ---
// Effects/Frames: none; predicates classify the resolved destination and comparisons.

pred final_paths_safe {
  FinalPathBinding.outputAbsolute = True
  FinalPathBinding.workspaceAbsolute = True
  FinalPathBinding.destinationAbsolute = True
  FinalPathBinding.destinationConfined = True
  FinalPathBinding.promptAgrees = True
  FinalPathBinding.acknowledgmentAgrees = True
  FinalPathBinding.validationAgrees = True
  FinalPathBinding.containsPermissionWildcard = False
}

// Preconditions: request construction has one resolved, confined absolute path.
pred path_preconditions {
  FinalPathBinding.outputAbsolute = True
  FinalPathBinding.workspaceAbsolute = True
  FinalPathBinding.destinationAbsolute = True
  FinalPathBinding.destinationConfined = True
}

pred request_paths_safe {
  path_preconditions
  FinalPathBinding.promptAgrees = True
  FinalPathBinding.containsPermissionWildcard = False
}

// Configuration resolution always establishes absolute confinement and exact
// prompt binding. Wildcard presence alone selects invoke versus fail-closed.

// Path mismatch and wildcard paths are handled before any model-selected path is read.
assert unsafe_paths_prevent_agent_or_validation {
  always {
    FinalPathBinding.containsPermissionWildcard = True implies Run.agentInvoked = False
    FinalPathBinding.acknowledgmentAgrees = False implies Run.reportValid = False
  }
}

// Success postcondition: prompt, acknowledgment, publication, and validation all
// refer to the precomputed destination inside the output directory.
assert report_success_requires_path_agreement {
  always (Run.finalStage = ReportAvailable implies final_paths_safe)
}
```

### Requirement: Restrict Final Report Agent [RAE-FINAL-AGENT]
WHEN the spec-check tool invokes the final-report agent, THE spec-check tool SHALL use the detected major's verified isolated execution protocol and a transient primary-agent policy that permits required reads, denies all file mutation, shell execution, and delegation, and does not enable OpenCode auto-approval.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/proposal.md#Constraints`
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Final-Report-Compatibility`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Constraints`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/design.md#Security`

#### Scenario: Allow Designated Write [RAE-FINAL-AGENT-WRITE]
WHEN a valid report payload is returned, THE spec-check tool SHALL atomically publish its Markdown through the confined filesystem adapter at the exact designated `report.md`.

**Postcondition:** The agent remains read-only and trusted code produces the requested artifact.

##### Evidence
- Implementation: [final-report.ts:264 generateFinalReport()](/src/domain/reporting/final-report.ts#L264), [fs.ts:83 writeOutputAtomic()](/src/adapters/fs.ts#L83), [final-report.ts:215 buildFinalReportAgentPolicy()](/src/domain/prompts/final-report.ts#L215)
- Test: [final-report.test.ts:76 builds a deny-first one-path agent policy](/test/contract/final-report.test.ts#L76), [final-report.test.ts:325 uses the acknowledgment only for equality and validates the designated file](/test/contract/final-report.test.ts#L325), [safety-liveness.invariant.test.ts:251 SAFE-17: final-report authority is one exact edit path](/test/invariant/safety-liveness.invariant.test.ts#L251)

#### Scenario: Deny Other Mutation [RAE-FINAL-AGENT-DENY]
IF the report agent attempts to modify any file, THEN THE transient policy SHALL deny that action.

**Postcondition:** Final-report agent execution has no writable path.

##### Evidence
- Implementation: [final-report.ts:215 buildFinalReportAgentPolicy()](/src/domain/prompts/final-report.ts#L215)
- Test: [final-report.test.ts:76 builds a deny-first one-path agent policy](/test/contract/final-report.test.ts#L76), [final-report.test.ts:92 allows external analyzed inputs for reads without broadening edits](/test/contract/final-report.test.ts#L92), [safety-liveness.invariant.test.ts:251 SAFE-17: final-report authority is one exact edit path](/test/invariant/safety-liveness.invariant.test.ts#L251)

#### Scenario: Deny Shell And Delegation [RAE-FINAL-AGENT-TOOLS]
IF the report agent attempts shell execution, task delegation, web access, or another denied capability, THEN THE transient policy SHALL deny that action.

**Postcondition:** The report cannot bypass read-only policy through a more powerful tool.

##### Evidence
- Implementation: [final-report.ts:215 buildFinalReportAgentPolicy()](/src/domain/prompts/final-report.ts#L215), [opencode-protocol.ts:66 serializeFinalReportPolicy()](/src/adapters/opencode-protocol.ts#L66)
- Test: [final-report.test.ts:76 builds a deny-first one-path agent policy](/test/contract/final-report.test.ts#L76), [opencode.test.ts:48 constructs restricted final-report argv and inline environment](/test/contract/opencode.test.ts#L48), [safety-liveness.invariant.test.ts:251 SAFE-17: final-report authority is one exact edit path](/test/invariant/safety-liveness.invariant.test.ts#L251), [opencode-compatibility.test.ts:36 uses native restricted v2 config, cwd, and non-inherited server exclusion](/test/contract/opencode-compatibility.test.ts#L36)

#### Requirement model

```alloy
// --- Restricted agent capability model ---
// Effects/Frames: none; the top-level policy invariants constrain effective authority.


// Safety: the agent is read-only; trusted publication is not an agent capability.
assert agent_policy_is_read_only {
  FinalAgentPolicy.admitted = True implies {
    FinalAgentPolicy.configuredAllowed = ReadCapability + SearchCapability
    no (FinalAgentPolicy.configuredAllowed & deniedAgentCapabilities)
  }
}

// Safety: denied actions confer no mutation or tool authority.
assert denied_agent_action_cannot_publish {
  no (FinalAgentInvocation.effectiveCapabilities & deniedAgentCapabilities)
  FinalAgentInvocation.requestedCapabilities & deniedAgentCapabilities
    in AgentCapability - FinalAgentInvocation.effectiveCapabilities
}
```

### Requirement: Use File And Acknowledgment Protocol [RAE-FINAL-PROTOCOL]
WHEN the final-report phase invokes OpenCode with `--format json`, THE spec-check tool SHALL decode stdout as strict UTF-8 newline-delimited OpenCode events, concatenate `part.text` only from top-level `type: "text"` events, and parse that text as one JSON object with the exact `report_path` and complete `report_markdown` strings.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Final-Report-Compatibility`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Scope`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/design.md#Interaction-Protocols`

#### Scenario: Invoke In Workspace [RAE-FINAL-PROTO-DIR]
WHEN OpenCode is started for the final-report phase, THE spec-check tool SHALL use the verified v1 `--pure` and `--dir <isolated-root>` invocation for its tested v1 baseline or the verified v2 standalone invocation with subprocess `cwd` and environment `PWD` set to the isolated execution/configuration root, private generated server configuration, and explicit `OPENCODE_CONFIG_PROJECT_DISABLE=1`, select the restricted agent with `--agent`, request JSON output with `--format json`, and omit `--auto`; the analyzed workspace SHALL be named in the prompt and granted explicit read-only external-directory access.

**Postcondition:** The agent can inspect workspace evidence under the declared permission boundary. V2 receives no `--pure`, `--dir`, or separate `--variant`; v1 receives no v2-only flags. If discovery requires a different supported isolation transport, the design and this protocol scenario must be revised before accepting compatibility.

##### Evidence
- Implementation: [opencode-protocol.ts:17 buildOpencodeArgs()](/src/adapters/opencode-protocol.ts#L17), [opencode-protocol.ts:42 buildOpencodeEnvironment()](/src/adapters/opencode-protocol.ts#L42), [opencode.ts:385 attemptOpencodeOnce()](/src/adapters/opencode.ts#L385), [final-report.ts:264 generateFinalReport()](/src/domain/reporting/final-report.ts#L264), [final-report.ts:215 buildFinalReportAgentPolicy()](/src/domain/prompts/final-report.ts#L215)
- Test: [opencode.test.ts:48 constructs restricted final-report argv and inline environment](/test/contract/opencode.test.ts#L48), [opencode.test.ts:78 isolates final-report config roots when provided](/test/contract/opencode.test.ts#L78), [final-report.test.ts:92 allows external analyzed inputs for reads without broadening edits](/test/contract/final-report.test.ts#L92), [distribution.test.ts:15 bundles the authoritative final-report prompt and restricted protocol](/test/contract/distribution.test.ts#L15), [opencode-compatibility.test.ts:36 uses native restricted v2 config, cwd, and non-inherited server exclusion](/test/contract/opencode-compatibility.test.ts#L36)

#### Scenario: Validate Acknowledgment Shape [RAE-FINAL-PROTO-ACK]
IF final-report stdout does not decode to exactly the required non-empty `report_path` and `report_markdown` fields, THEN THE spec-check tool SHALL classify the attempt as failed.

**Postcondition:** Malformed UTF-8, malformed event lines, error events, raw payloads outside text events, missing text payloads, Markdown fences, prose wrappers, extra payload fields, and invalid field values are rejected. Non-text status and usage events are ignored.

##### Evidence
- Implementation: [opencode.ts:306 classifyProcessResult()](/src/adapters/opencode.ts#L306), [opencode.ts:659 parseOpencodePayload()](/src/adapters/opencode.ts#L659), [opencode.ts:1006 validatePhaseSchema()](/src/adapters/opencode.ts#L1006), [final-report.ts:428 parseAcknowledgment()](/src/domain/reporting/final-report.ts#L428)
- Test: [opencode.test.ts:131 rejects %s final-report acknowledgment](/test/contract/opencode.test.ts#L131), [opencode.test.ts:154 rejects fenced or prose-wrapped final-report acknowledgments](/test/contract/opencode.test.ts#L154), [opencode.test.ts:169 rejects a raw final-report payload outside a text event](/test/contract/opencode.test.ts#L169), [opencode.test.ts:184 rejects malformed UTF-8 in the final-report event stream](/test/contract/opencode.test.ts#L184), [process-output.test.ts:7 kills a child when combined captured output exceeds the configured byte bound](/test/contract/process-output.test.ts#L7), [process-output.test.ts:18 marks malformed UTF-8 without hiding it behind replacement decoding](/test/contract/process-output.test.ts#L18)

#### Scenario: Preserve Prompt Parity [RAE-FINAL-PROMPT-PARITY]
WHEN bundled artifacts are built, THE spec-check verification harness SHALL confirm that the distributed final-report prompt and builders match the authoritative `FINAL_REPORT_PROMPT` and builders in `src/domain/prompts/final-report.ts` before declared runtime placeholder substitution.

**Postcondition:** Source and distributed CLIs use the same authoritative evaluated content strategy without depending on an external prompt file.

##### Evidence
- Implementation: [final-report.ts:22 FINAL_REPORT_PROMPT](/src/domain/prompts/final-report.ts#L22), [final-report.ts:174 buildFinalReportPrompt()](/src/domain/prompts/final-report.ts#L174)
- Test: [distribution.test.ts:15 bundles the authoritative final-report prompt and restricted protocol](/test/contract/distribution.test.ts#L15)

#### Requirement model

The existing abstract `pureMode` field below denotes the verified isolation property, not the presence of a literal `--pure` flag on v2. Its v1/v2 realization is established by the compatibility gate and executable fixtures; this preserved model does not prove external configuration loading behavior.

```alloy
// --- Strict OpenCode event and acknowledgment protocol ---
// Effects/Frames: none; protocol predicates classify isolated invocation and payload.

// Build admission is the modeled trust boundary. Runtime placeholders are
// normalized before this equality check; executable distribution tests compare bytes.

// Guards/Postconditions: verified isolation, restricted agent, and no auto-approval.
pred protocol_preconditions {
  ReportProtocol.pureMode = True
  ReportProtocol.isolatedDir = True
  ReportProtocol.restrictedAgentSelected = True
  ReportProtocol.autoOmitted = True
}


// Guards/Postconditions: strict text-event transport contains exactly the required fields.
pred acknowledgment_valid {
  ReportProtocol.strictUtf8 = True
  ReportProtocol.linesAreJsonEvents = True
  ReportProtocol.errorEventAbsent = True
  ReportProtocol.textFromTopLevelEventsOnly = True
  ReportProtocol.exactPayloadFields = True
  ReportProtocol.pathNonempty = True
  ReportProtocol.markdownNonempty = True
  ReportProtocol.noWrapperOrFence = True
}

assert validating_requires_strict_protocol {
  always (Run.finalStage = Validating implies
    (protocol_preconditions and ReportProtocol.agentSucceeded = True))
}

assert malformed_protocol_never_validates {
  always (not acknowledgment_valid implies Run.finalStage != ReportAvailable)
}

assert accepted_bundle_has_prompt_parity {
  PromptBuild.accepted = True implies
    SourcePrompt.(PromptBuild.normalizedInstructions)
      = BundledPrompt.(PromptBuild.normalizedInstructions)
}
```

### Requirement: Validate Final Report File [RAE-FINAL-VALIDATE]
WHEN a final-report payload is accepted, THE spec-check tool SHALL validate its path and Markdown, atomically publish the Markdown, and independently validate the precomputed destination as a non-symlink regular strict UTF-8 file with all required report headings, at least one repository-relative citation, one artifact citation for every numbered prioritized finding, non-whitespace content, and size not greater than 1,048,576 bytes.

**References:**
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Postconditions`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/design.md#Data-Design`

#### Scenario: Accept Bounded Regular File [RAE-FINAL-VALID-FILE]
WHEN trusted atomic publication produces a regular non-symlink file that meets the strict UTF-8, required-heading, citation, non-whitespace, and 1,048,576-byte rules, THE spec-check tool SHALL accept it as the final report.

**Postcondition:** Valid payload content plus filesystem read-back establishes report success.

##### Evidence
- Implementation: [final-report.ts:370 validateFinalReport()](/src/domain/reporting/final-report.ts#L370), [final-report.ts:447 validateFinalReportContent()](/src/domain/reporting/final-report.ts#L447)
- Test: [final-report.test.ts:128 accepts a regular report at the exact byte limit](/test/contract/final-report.test.ts#L128)

#### Scenario: Reject Missing Report [RAE-FINAL-MISSING]
IF the report payload omits valid Markdown or trusted atomic publication does not produce the designated report, THEN THE spec-check tool SHALL classify the report attempt as failed.

**Postcondition:** A path assertion cannot substitute for report content and successful publication.

##### Evidence
- Implementation: [final-report.ts:370 validateFinalReport()](/src/domain/reporting/final-report.ts#L370), [final-report.ts:555 metadataError()](/src/domain/reporting/final-report.ts#L555)
- Test: [final-report.test.ts:150 rejects a missing report](/test/contract/final-report.test.ts#L150), [final-report.test.ts:407 rejects missing read-back output after publication](/test/contract/final-report.test.ts#L407)

#### Scenario: Reject Symlink [RAE-FINAL-SYMLINK]
IF the designated report is a symbolic link, THEN THE spec-check tool SHALL reject it without following the link target.

**Postcondition:** Report validation cannot escape the configured output through a link.

##### Evidence
- Implementation: [final-report.ts:370 validateFinalReport()](/src/domain/reporting/final-report.ts#L370)
- Test: [final-report.test.ts:157 rejects symlinks and directories](/test/contract/final-report.test.ts#L157)

#### Scenario: Reject Non-Regular Report [RAE-FINAL-NOT-REGULAR]
IF the designated report is a directory or another non-regular filesystem object, THEN THE spec-check tool SHALL classify the report attempt as failed.

**Postcondition:** Only regular files can become final reports.

##### Evidence
- Implementation: [final-report.ts:370 validateFinalReport()](/src/domain/reporting/final-report.ts#L370)
- Test: [final-report.test.ts:157 rejects symlinks and directories](/test/contract/final-report.test.ts#L157)

#### Scenario: Reject Empty Report [RAE-FINAL-EMPTY]
IF the designated report is empty or contains only whitespace, THEN THE spec-check tool SHALL classify the report attempt as failed.

**Postcondition:** A successful report contains substantive Markdown text.

##### Evidence
- Implementation: [final-report.ts:370 validateFinalReport()](/src/domain/reporting/final-report.ts#L370), [final-report.ts:447 validateFinalReportContent()](/src/domain/reporting/final-report.ts#L447)
- Test: [final-report.test.ts:141 rejects %s report content](/test/contract/final-report.test.ts#L141), [final-report.test.ts:376 rejects %s returned Markdown before publication](/test/contract/final-report.test.ts#L376)

#### Scenario: Reject Oversized Report [RAE-FINAL-OVERSIZED]
IF the designated report is larger than 1,048,576 bytes, THEN THE spec-check tool SHALL reject it before an unbounded content read.

**Postcondition:** Returned Markdown is bounded before atomic publication.

##### Evidence
- Implementation: [final-report.ts:22 FINAL_REPORT_MAX_BYTES](/src/domain/reporting/final-report.ts#L22), [final-report.ts:370 validateFinalReport()](/src/domain/reporting/final-report.ts#L370), [final-report.ts:447 validateFinalReportContent()](/src/domain/reporting/final-report.ts#L447)
- Test: [final-report.test.ts:141 rejects %s report content](/test/contract/final-report.test.ts#L141), [final-report.test.ts:376 rejects %s returned Markdown before publication](/test/contract/final-report.test.ts#L376)

#### Scenario: Reject Unsupported Report Structure [RAE-FINAL-STRUCTURE]
IF returned or read-back Markdown omits a required report heading, contains no repository-relative citation, or gives a numbered prioritized finding no artifact citation, THEN THE spec-check tool SHALL classify the report attempt as failed.

**Postcondition:** A structurally incomplete or uncited prioritized finding cannot be published as a successful final report.

##### Evidence
- Implementation: [final-report.ts:25 FINAL_REPORT_REQUIRED_HEADINGS](/src/domain/reporting/final-report.ts#L25), [final-report.ts:447 validateFinalReportContent()](/src/domain/reporting/final-report.ts#L447)
- Test: [final-report.test.ts:181 rejects reports without the required sections or repository citation](/test/contract/final-report.test.ts#L181), [final-report.test.ts:213 rejects a numbered prioritized finding without its own artifact citation](/test/contract/final-report.test.ts#L213), [final-report.test.ts:241 does not accept headings or citations from fenced or non-relative text](/test/contract/final-report.test.ts#L241), [final-report.test.ts:261 rejects duplicate or malformed prioritized headings](/test/contract/final-report.test.ts#L261)

#### Requirement model

```alloy
// --- Independent payload and filesystem validation ---

// Guard: newly published candidate. Effect: classify file metadata before content I/O.
// Frame: core/files/observations. Postcondition: bounded regular files may proceed.
pred inspect_report_metadata {
  Run.finalStage = PublishedCandidate
  ReportReadBack.readStage = MetadataPending
  ReportReadBack.readStage' = (
    ReportCandidate.filePresent = True
      and ReportCandidate.regularFile = True
      and ReportCandidate.symlink = False
      and ReportCandidate.withinByteLimit = True
    implies MetadataChecked else ReadRejected)
  Run.finalStage' = Run.finalStage
  Run.agentInvoked' = Run.agentInvoked
  Run.finalFailure' = Run.finalFailure
  frame_core_and_final_files
  frame_final_observations
}

// Guard: checked regular non-symlink file within the byte bound. Effect: read content.
// Frame: core/files/observations. Postcondition: payload/file validation can complete.
pred read_report_content {
  Run.finalStage = PublishedCandidate
  ReportReadBack.readStage = MetadataChecked
  ReportCandidate.filePresent = True
  ReportCandidate.regularFile = True
  ReportCandidate.symlink = False
  ReportCandidate.withinByteLimit = True
  ReportReadBack.readStage' = ContentRead
  Run.finalStage' = Run.finalStage
  Run.agentInvoked' = Run.agentInvoked
  Run.finalFailure' = Run.finalFailure
  frame_core_and_final_files
  frame_final_observations
}

// Guards/Postconditions: payload, metadata, decoded content and read-back identity agree.
// Effects/Frames: none; accepting the candidate is a separate event.
pred candidate_valid {
  ReportCandidate.payloadPresent = True
  ReportCandidate.pathMatches = True
  ReportCandidate.publicationAtomic = True
  ReportCandidate.filePresent = True
  ReportCandidate.strictUtf8 = True
  ReportCandidate.regularFile = True
  ReportCandidate.symlink = False
  ReportCandidate.nonWhitespace = True
  ReportCandidate.withinByteLimit = True
  ReportCandidate.headingsComplete = True
  ReportCandidate.repositoryCitation = True
  ReportCandidate.everyFindingCited = True
  ReportCandidate.readBackContentId = ReportCandidate.payloadContentId
  ReportReadBack.readStage = ContentRead
}

assert oversized_report_rejected_before_content_read {
  always (ReportCandidate.withinByteLimit = False implies
    ReportReadBack.readStage != ContentRead)
}

// Validation authority: success requires payload checks, trusted atomic
// publication, and independent read-back checks at the designated path.
assert report_available_requires_candidate_valid {
  always (Run.finalStage = ReportAvailable implies candidate_valid)
}

assert invalid_objects_never_succeed {
  always ((ReportCandidate.symlink = True
    or ReportCandidate.regularFile = False
    or ReportCandidate.filePresent = False
    or ReportCandidate.nonWhitespace = False
    or ReportCandidate.withinByteLimit = False
    or ReportCandidate.strictUtf8 = False
    or ReportCandidate.headingsComplete = False
    or ReportCandidate.repositoryCitation = False
    or ReportCandidate.everyFindingCited = False)
    implies Run.reportValid = False)
}
```

### Requirement: Clean Final Report Output [RAE-FINAL-CLEANUP]
WHEN a new run starts or a handled final-report failure occurs, THE spec-check tool SHALL remove the confined `report.md` destination before that run can claim a final-report outcome.

**References:**
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Failure-Modes`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/design.md#Control-and-Recovery`

#### Scenario: Remove Stale Report [RAE-FINAL-CLEAN-STALE]
WHEN a new run starts and `report.md` exists from a prior run, THE spec-check tool SHALL remove it before analysis begins.

**Postcondition:** A prior report cannot be attributed to the new evidence bundle.

##### Evidence
- Implementation: [run-cli.ts:170 runCliPipeline()](/src/cli/run-cli.ts#L170), [final-report.ts:423 removeFinalReport()](/src/domain/reporting/final-report.ts#L423)
- Test: [final-report.test.ts:313 removes stale files and directories idempotently](/test/contract/final-report.test.ts#L313)
- Test (integration): [merge-pipeline.integration.test.ts:271 removes stale report output before the current final-report attempt](/test/integration/merge-pipeline.integration.test.ts#L271)

#### Scenario: Remove All Stale Managed Output [RAE-FINAL-CLEAN-MANAGED]
WHEN a new run starts, THE spec-check tool SHALL first invalidate the prior `manifest.json` and SHALL then remove all tool-owned phase reports, summary, final report, metrics, formalization evidence, SMT evidence, generated specifications, and cross-implication evidence before analysis begins.

**Postcondition:** Artifacts omitted by the current run cannot be mistaken for current unmanifested evidence.

##### Evidence
- Implementation: [run-cli.ts:170 runCliPipeline()](/src/cli/run-cli.ts#L170), [run-cli.ts:235 MANAGED_OUTPUT_PATHS](/src/cli/run-cli.ts#L235), [fs.ts:137 removeOutputTree()](/src/adapters/fs.ts#L137)
- Test: [fs.test.ts:66 removes interrupted atomic-write siblings only for managed root files](/test/contract/fs.test.ts#L66)
- Test (integration): [merge-pipeline.integration.test.ts:271 removes stale report output before the current final-report attempt](/test/integration/merge-pipeline.integration.test.ts#L271), [merge-pipeline.integration.test.ts:318 supports consecutive runs against the same output directory](/test/integration/merge-pipeline.integration.test.ts#L318)

#### Scenario: Surface Startup Cleanup Failure [RAE-FINAL-CLEAN-START-ERROR]
IF managed-output cleanup fails after prior-manifest invalidation, THEN THE spec-check tool SHALL return fatal `OutputError` before ingestion and SHALL NOT claim a current completed bundle.

**Postcondition:** Residue can remain for operator inspection, but no stale manifest attests it as the new run.

##### Evidence
- Implementation: [run-cli.ts:170 runCliPipeline()](/src/cli/run-cli.ts#L170)
- Test (integration): [merge-pipeline.integration.test.ts:305 surfaces run-start managed-output cleanup failure before ingestion](/test/integration/merge-pipeline.integration.test.ts#L305)

#### Scenario: Remove Invalid Candidate [RAE-FINAL-CLEAN-FAILED]
IF report generation or validation fails on a handled path, THEN THE spec-check tool SHALL remove any file or filesystem object at the designated report path before persisting the failure warning.

**Postcondition:** The warning terminal state has no report residue.

##### Evidence
- Implementation: [final-report-lifecycle.ts:65 coordinateFinalReportLifecycle()](/src/cli/final-report-lifecycle.ts#L65), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553), [final-report.ts:423 removeFinalReport()](/src/domain/reporting/final-report.ts#L423)
- Test: [final-report.test.ts:313 removes stale files and directories idempotently](/test/contract/final-report.test.ts#L313), [safety-liveness.invariant.test.ts:268 LIVE-13: every handled final-report branch reaches one terminal outcome](/test/invariant/safety-liveness.invariant.test.ts#L268)
- Test (property): [final-report.property.test.ts:32 legal success and failure histories reach exactly one terminal state](/test/property/final-report.property.test.ts#L32), [final-report.property.test.ts:85 executes production coordination against independent filesystem observations and reference histories](/test/property/final-report.property.test.ts#L85)

#### Scenario: Surface Cleanup Failure [RAE-FINAL-CLEAN-ERROR]
IF the spec-check tool cannot establish that the designated report path is absent after a failed attempt, THEN THE spec-check tool SHALL surface an output failure and SHALL NOT claim the `warning_without_report` terminal outcome.

**Postcondition:** The system never reports successful cleanup when invalid residue may remain.

##### Evidence
- Implementation: [final-report-lifecycle.ts:65 coordinateFinalReportLifecycle()](/src/cli/final-report-lifecycle.ts#L65), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553)
- Test (property): [final-report.property.test.ts:55 generated stuttering and failure-point histories preserve lifecycle invariants](/test/property/final-report.property.test.ts#L55), [final-report.property.test.ts:85 executes production coordination against independent filesystem observations and reference histories](/test/property/final-report.property.test.ts#L85)
- Test (integration): [merge-pipeline.integration.test.ts:332 surfaces cleanup failure instead of claiming warning-without-report](/test/integration/merge-pipeline.integration.test.ts#L332)

#### Scenario: Surface Post-Completion Output Failure [RAE-FINAL-OUTPUT-ERROR]
IF report cleanup, marker invalidation, warning-summary rewrite, or manifest refresh fails, THEN THE spec-check tool SHALL enter `output_failed`, return fatal `OutputError`, and SHALL NOT claim `valid_report` or `warning_without_report`.

**Postcondition:** Report, summary, and manifest presence reflect only side effects completed before the failed operation. After successful marker invalidation, no completion manifest remains.

##### Evidence
- Implementation: [final-report-lifecycle.ts:65 coordinateFinalReportLifecycle()](/src/cli/final-report-lifecycle.ts#L65), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553), [final-report.ts:164 reduceFinalReportLifecycle()](/src/domain/reporting/final-report.ts#L164)
- Test (property): [final-report.property.test.ts:55 generated stuttering and failure-point histories preserve lifecycle invariants](/test/property/final-report.property.test.ts#L55), [final-report.property.test.ts:85 executes production coordination against independent filesystem observations and reference histories](/test/property/final-report.property.test.ts#L85)
- Test (integration): [merge-pipeline.integration.test.ts:332 surfaces cleanup failure instead of claiming warning-without-report](/test/integration/merge-pipeline.integration.test.ts#L332), [merge-pipeline.integration.test.ts:358 surfaces warning-summary persistence failure as OutputError](/test/integration/merge-pipeline.integration.test.ts#L358), [merge-pipeline.integration.test.ts:377 surfaces refreshed-manifest failure as OutputError](/test/integration/merge-pipeline.integration.test.ts#L377)

#### Requirement model

```alloy
// --- Startup and handled-failure cleanup ---
// Guard: new run preparing. Effect: invalidate the stale completion marker first.
// Frame: core/report/metrics. Postcondition: managed cleanup cannot retain stale authority.
pred begin_startup_cleanup {
  Run.finalStage = Preparing
  Run.finalStage' = StartupCleaning
  // Invalidate the old completion marker before deleting managed output.
  Run.staleManifestPresent' = False
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  frame_core_state
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  frame_metrics
  all f : OutputFile | f.pathState' = f.pathState
  Run.finalFailure' = Run.finalFailure
  Run.agentInvoked' = Run.agentInvoked
}

// Guard: marker invalidated. Effect: remove stale managed output and report residue.
// Frame: core/metrics/other files. Postcondition: core reporting may start.
pred startup_cleanup_succeeds {
  Run.finalStage = StartupCleaning
  Run.finalStage' = CoreReporting
  Run.staleManifestPresent = False
  Run.staleManagedOutputPresent' = False
  FinalReportDestination.reportPathState' = Absent
  Run.staleManifestPresent' = Run.staleManifestPresent
  frame_core_state
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  frame_metrics
  all f : OutputFile | f.pathState' = f.pathState
  Run.finalFailure' = Run.finalFailure
  Run.agentInvoked' = Run.agentInvoked
}

// Guard: handled report failure. Effect: remove the designated report object.
// Frame: core/metrics/observations. Postcondition: failure warning may be recorded.
pred cleanup_succeeds {
  Run.finalStage = Cleaning
  one Run.finalFailure
  Run.finalFailure in handledFinalFailures
  Run.findings' = Run.findings
  Run.finalStage' = Cleaned
  Run.reportPresent' = False
  Run.reportValid' = False
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.agentInvoked' = Run.agentInvoked
  Run.finalFailure' = Run.finalFailure
  Run.completedPhases' = Run.completedPhases
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  Run.coreComplete' = Run.coreComplete
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  frame_metrics
  FinalReportDestination.reportPathState' = Absent
  all f : OutputFile | f.pathState' = f.pathState
}

// Guard: cleanup established report absence. Effect: append a well-formed failure warning.
// Frame: core artifacts/metrics. Postcondition: persisted summary needs rewriting.
pred persist_final_report_warning {
  Run.finalStage = Cleaned
  one Run.finalFailure
  Run.finalFailure in handledFinalFailures
  some w : Finding | {
    w.severity = WarningSev
    w.category = FinalReportFailedCategory
    finding_wellformed[w]
    finding_evidence_preserved[w]
    w.provenance.srcFile = ReportingArtifact
    w.provenance.srcHeading = ReportingHeading
    w.finalFailureEvidence = Run.finalFailure
    w not in Run.findings
    Run.findings' = Run.findings + w
  }
  Run.finalStage' = WarningRecorded
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = True
  // The new warning makes the persisted summary stale until rewrite.
  Run.summaryCurrent' = False
  Run.agentInvoked' = Run.agentInvoked
  Run.finalFailure' = Run.finalFailure
  Run.completedPhases' = Run.completedPhases
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  Run.coreComplete' = Run.coreComplete
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  frame_metrics
  FinalReportDestination.reportPathState' = FinalReportDestination.reportPathState
  all f : OutputFile | f.pathState' = f.pathState
}

// Guard: matching output operation failed. Effect: enter fatal OutputFailed.
// Frame: completed side effects. Postcondition: no handled terminal outcome is claimed.
pred final_output_fails [k : FinalFailureKind] {
  k in outputFinalFailures
  k = StartupCleanupFailed implies Run.finalStage = StartupCleaning
  k = CleanupFailed implies Run.finalStage = Cleaning
  k = WarningPersistenceFailed implies Run.finalStage = Cleaned
  k = MarkerInvalidationFailed implies Run.finalStage = WarningRecorded
  k = SummaryRewriteFailed implies Run.finalStage = MarkerInvalidated
  k = ManifestRefreshFailed implies Run.finalStage = ManifestRefreshing
  Run.finalStage' = OutputFailed
  Run.failed' = True
  Run.finalFailure' = k
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.agentInvoked' = Run.agentInvoked
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  frame_metrics
  all f : OutputFile | f.pathState' = f.pathState
}

assert marker_invalidated_before_managed_cleanup {
  always (Run.finalStage = StartupCleaning implies Run.staleManifestPresent = False)
}

assert startup_cleanup_establishes_report_absence {
  always (Run.finalStage = CoreReporting implies
    FinalReportDestination.reportPathState = Absent)
}

assert handled_failure_has_no_report_residue {
  always (Run.finalStage = WarningPersisted implies
    (Run.reportPresent = False and Run.reportValid = False
      and FinalReportDestination.reportPathState = Absent))
}

assert output_failure_never_claims_handled_outcome {
  always (Run.finalStage = OutputFailed implies
    Run.finalStage not in ReportAvailable + WarningPersisted)
}
```

### Requirement: Persist Final Report Failure [RAE-FINAL-WARNING]
IF final-report generation or validation fails and cleanup succeeds, THEN THE spec-check tool SHALL append one well-formed warning with category `reporting.final_report_failed`, rewrite `report_summary.md`, and refresh `manifest.json` after the summary write.

**References:**
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Postconditions`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/design.md#System-Invariant-Tactics`

#### Scenario: Record Failure Kind [RAE-FINAL-WARN-KIND]
WHEN a final-report warning is created, THE warning SHALL contain warning severity, `<reporting>` provenance, a non-empty description and rationale, and evidence naming the stable failure kind.

**Postcondition:** Reviewers can distinguish optional-report degradation from missing analysis.

##### Evidence
- Implementation: [run-cli.ts:632 finalReportFailureFinding()](/src/cli/run-cli.ts#L632)
- Test (integration): [merge-pipeline.integration.test.ts:215 persists a nonfatal final-report warning and refreshes the summary checksum](/test/integration/merge-pipeline.integration.test.ts#L215), [merge-pipeline.integration.test.ts:259 persists warning for final-report %s degradation](/test/integration/merge-pipeline.integration.test.ts#L259)

#### Scenario: Refresh Summary Checksum [RAE-FINAL-WARN-HASH]
WHEN the warning changes `report_summary.md`, THE spec-check tool SHALL first invalidate the old manifest, SHALL compute the new entry from final summary bytes, and SHALL atomically write `manifest.json` after the summary.

**Postcondition:** Every core manifest checksum matches its final core artifact.

##### Evidence
- Implementation: [final-report-lifecycle.ts:65 coordinateFinalReportLifecycle()](/src/cli/final-report-lifecycle.ts#L65), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553), [run-cli.ts:615 writeCoreManifest()](/src/cli/run-cli.ts#L615)
- Test (property): [final-report.property.test.ts:104 an unmanifested report cannot change core entries and warning bytes do](/test/property/final-report.property.test.ts#L104), [final-report.property.test.ts:85 executes production coordination against independent filesystem observations and reference histories](/test/property/final-report.property.test.ts#L85)
- Test (integration): [merge-pipeline.integration.test.ts:215 persists a nonfatal final-report warning and refreshes the summary checksum](/test/integration/merge-pipeline.integration.test.ts#L215), [merge-pipeline.integration.test.ts:358 surfaces warning-summary persistence failure as OutputError](/test/integration/merge-pipeline.integration.test.ts#L358), [merge-pipeline.integration.test.ts:377 surfaces refreshed-manifest failure as OutputError](/test/integration/merge-pipeline.integration.test.ts#L377)

#### Scenario: Preserve Core Completion [RAE-FINAL-WARN-COMPLETE]
WHEN the final-report warning is persisted, THE spec-check tool SHALL retain `manifest.json` as the core completion marker and SHALL NOT convert the handled report failure into a fatal pipeline result.

**Postcondition:** The run is complete with an observable warning and no report.

##### Evidence
- Implementation: [final-report-lifecycle.ts:65 coordinateFinalReportLifecycle()](/src/cli/final-report-lifecycle.ts#L65), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553), [final-report.ts:164 reduceFinalReportLifecycle()](/src/domain/reporting/final-report.ts#L164)
- Test: [final-report.test.ts:451 enforces guarded transitions and terminal stuttering](/test/contract/final-report.test.ts#L451)
- Test (property): [final-report.property.test.ts:32 legal success and failure histories reach exactly one terminal state](/test/property/final-report.property.test.ts#L32), [final-report.property.test.ts:55 generated stuttering and failure-point histories preserve lifecycle invariants](/test/property/final-report.property.test.ts#L55)
- Test (integration): [merge-pipeline.integration.test.ts:215 persists a nonfatal final-report warning and refreshes the summary checksum](/test/integration/merge-pipeline.integration.test.ts#L215)

#### Requirement model

```alloy
// --- Warning persistence and manifest refresh ordering ---
// Guard: warning recorded. Effect: invalidate manifest inventory before summary rewrite.
// Frame: core/report files. Postcondition: no stale completion marker attests new bytes.
pred invalidate_warning_manifest {
  Run.finalStage = WarningRecorded
  Run.finalStage' = MarkerInvalidated
  Run.manifestPresent' = False
  no Run.manifestFiles'
  no Run.manifestAttemptSets'
  Run.summaryCurrent' = False
  Run.agentInvoked' = Run.agentInvoked
  Run.finalFailure' = Run.finalFailure
  frame_core_except_manifest
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  Run.metricsPresent' = Run.metricsPresent
  Run.metricsChecksummed' = Run.metricsChecksummed
  Run.metricsListed' = False
  all f : OutputFile | f.pathState' = f.pathState
}

// Guard: manifest absent after warning. Effect: rewrite summary with the warning.
// Frame: core/report/metrics. Postcondition: summary is current before manifest refresh.
pred rewrite_warning_summary {
  Run.finalStage = MarkerInvalidated
  Run.manifestPresent = False
  Run.finalStage' = SummaryRewritten
  Run.summaryCurrent' = True
  frame_core_state
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.agentInvoked' = Run.agentInvoked
  Run.finalFailure' = Run.finalFailure
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  frame_metrics
  all f : OutputFile | f.pathState' = f.pathState
}

// Guard: current rewritten summary, no manifest. Effect: begin manifest refresh.
// Frame: core/files/observations. Postcondition: refresh uses final summary bytes.
pred begin_manifest_refresh {
  Run.finalStage = SummaryRewritten
  Run.manifestPresent = False
  Run.summaryCurrent = True
  Run.finalStage' = ManifestRefreshing
  frame_core_and_final_files
  frame_final_observations
  Run.finalFailure' = Run.finalFailure
  Run.agentInvoked' = Run.agentInvoked
}

// Guard: refreshed summary ready. Effect: publish the current core manifest.
// Frame: core/report/metric content. Postcondition: warning persists without a report.
pred manifest_refresh_succeeds {
  Run.finalStage = ManifestRefreshing
  Run.summaryCurrent = True
  Run.finalStage' = WarningPersisted
  Run.manifestPresent' = True
  Run.manifestFiles' = Run.reports
  Run.manifestAttemptSets' = { a : AttemptSet | a.finalized = True }
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.finalFailure' = Run.finalFailure
  Run.agentInvoked' = Run.agentInvoked
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  Run.metricsPresent' = Run.metricsPresent
  Run.metricsChecksummed' = Run.metricsChecksummed
  Run.metricsListed' = Run.telemetryEnabled
  all f : OutputFile | f.pathState' = f.pathState
}

assert warning_terminal_postcondition {
  always (Run.finalStage = WarningPersisted implies {
    one Run.finalFailure
    Run.finalFailure in handledFinalFailures
    Run.warningPresent = True
    Run.reportPresent = False
    Run.summaryCurrent = True
    Run.manifestPresent = True
    R_Final not in Run.manifestFiles
  })
}

assert refresh_window_has_no_stale_manifest {
  always (Run.finalStage in MarkerInvalidated + SummaryRewritten + ManifestRefreshing
    implies Run.manifestPresent = False)
}

assert final_outcomes_are_exclusive {
  always (lone (Run.finalStage & (ReportAvailable + WarningPersisted + OutputFailed)))
  always (Run.finalStage = ReportAvailable implies Run.warningPresent = False)
  always (Run.finalStage = WarningPersisted implies Run.reportPresent = False)
}

// Action-progress assumptions apply only to liveness. Safety properties above
// permit arbitrary stuttering and fatal output failure.
pred final_report_fairness {
  always (Run.finalStage = Preparing implies eventually begin_startup_cleanup)
  always (Run.finalStage = StartupCleaning implies eventually
    (startup_cleanup_succeeds or final_output_fails[StartupCleanupFailed]))
  always (Run.finalStage = CoreComplete implies eventually
    (start_final_report or reject_unsafe_path or reject_unadmitted_agent_or_prompt))
  always (Run.finalStage = Generating implies eventually
    (generation_returns or some k : generationFinalFailures | generation_fails[k]))
  always (Run.finalStage = Validating implies eventually
    (publish_candidate or some k : validationFinalFailures | validation_fails[k]))
  always (Run.finalStage = PublishedCandidate implies eventually
    (validation_succeeds or some k : validationFinalFailures | validation_fails[k]))
  always (Run.finalStage = Cleaning implies eventually
    (cleanup_succeeds or some k : outputFinalFailures | final_output_fails[k]))
  always (Run.finalStage = Cleaned implies eventually
    (persist_final_report_warning or final_output_fails[WarningPersistenceFailed]))
  always (Run.finalStage = WarningRecorded implies eventually
    (invalidate_warning_manifest or final_output_fails[MarkerInvalidationFailed]))
  always (Run.finalStage = MarkerInvalidated implies eventually
    (rewrite_warning_summary or some k : outputFinalFailures | final_output_fails[k]))
  always (Run.finalStage = SummaryRewritten implies eventually
    (begin_manifest_refresh or some k : outputFinalFailures | final_output_fails[k]))
  always (Run.finalStage = ManifestRefreshing implies eventually
    (manifest_refresh_succeeds or some k : outputFinalFailures | final_output_fails[k]))
}

assert completed_core_eventually_attempts_report {
  final_report_fairness implies always (Run.finalStage = CoreComplete implies
    eventually Run.finalStage in Generating + Cleaning)
}

assert completed_core_has_enabled_report_action {
  always (Run.finalStage = CoreComplete implies
    (FinalPathBinding.containsPermissionWildcard = False implies
      (start_final_report_enabled or reject_unadmitted_agent_or_prompt_enabled))
    and (FinalPathBinding.containsPermissionWildcard = True implies reject_unsafe_path_enabled))
}

assert startup_cleanup_eventually_terminates {
  final_report_fairness implies always (Run.finalStage in Preparing + StartupCleaning
    implies eventually Run.finalStage in CoreReporting + OutputFailed)
}

assert attempted_report_eventually_terminates {
  final_report_fairness implies always (Run.finalStage in Generating + Validating + PublishedCandidate
    implies eventually Run.finalStage in ReportAvailable + WarningPersisted + OutputFailed)
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
- Implementation: [pipeline-helpers.ts:468 runCodeBackwardsWork()](/src/cli/pipeline-helpers.ts#L468)
- Test: [coverage-gaps.test.ts:44 solver and model artifacts are preserved via writeOutputAtomic](/test/contract/coverage-gaps.test.ts#L44), [global.invariant.test.ts:207 INV-4 + INV-13: solver artifacts are persisted](/test/invariant/global.invariant.test.ts#L207)

#### Scenario: Preserve Cross-Side Implication Evidence [RAE-EVID-CROSSIMPLY]
WHEN a code-backwards classification depends on cross-side implication analysis, THE spec-check tool SHALL preserve the implication queries, solver results, and classification rationale as evidence attached to the finding.

**Postcondition:** Cross-side comparison verdicts are traceable to their formal basis.

##### Evidence
- Implementation: [cross-implication.ts:332 runBoundedPairwiseComparison()](/src/domain/code-backwards/cross-implication.ts#L332)
- Test: [global.invariant.test.ts:207 INV-4 + INV-13: solver artifacts are persisted](/test/invariant/global.invariant.test.ts#L207)
- Test (integration): [pipeline.integration.test.ts:279 cross-side comparison pipeline with solver + blind comparison](/test/integration/pipeline.integration.test.ts#L279)

#### Scenario: Prevent Unsupported Verdict [RAE-EVID-FAIL]
IF a final report conclusion would be emitted without preserved provenance or supporting evidence, THEN THE spec-check tool SHALL suppress that unsupported verdict and SHALL surface the missing-evidence condition as a defect.

**Postcondition:** Reported conclusions never outrun the preserved evidence set.

##### Evidence
- Implementation: [render.ts:314 enforceFindingSupport()](/src/domain/reporting/render.ts#L314)
- Test: [reporting.test.ts:57 suppresses finding without required evidence as defect](/test/contract/reporting.test.ts#L57), [reporting.test.ts:103 suppresses finding with empty provenance file as defect](/test/contract/reporting.test.ts#L103)

#### Scenario: Preserve LLM Response As Evidence [RAE-EVID-LLM]
WHEN a finding depends on an LLM-backed analysis response, THE spec-check tool SHALL preserve the full response content as evidence attached to the finding.

**Postcondition:** No final verdict rests on an unpreserved LLM response.

##### Evidence

#### Scenario: Render Evidence Values As Inert Markdown Data [RAE-EVID-RENDER-SAFE]
WHEN the spec-check tool renders finding descriptions, provenance, related claim identifiers, or evidence values into Markdown reports, THE spec-check tool SHALL neutralize inline Markdown control syntax in those raw values so they cannot render as links, emphasis, inline code spans, headings, list items, block quotes, or extra table cells.

**Postcondition:** Evidence remains inspectable without creating synthetic report structure or misleading reviewer-visible findings.

##### Evidence
- Implementation: [render.ts:44 neutralizeMarkdownInline()](/src/domain/reporting/render.ts#L44), [render.ts:370 renderFindingsReport()](/src/domain/reporting/render.ts#L370)
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
  Run.finalStage = CoreReporting
  Run.failed = False
  R_Summary not in Run.reports
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

// Safety: no emitted verdict has unpreserved evidence; this is not a progress claim.
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

// Safety: each analysis basis retains its required source-specific evidence.
assert evidence_source_requirements {
  (SolverArtifact + ModelArtifact) in requiredEvidenceFor[FormalSolverBasis]
  (ImplicationQuery + SolverResult + ClassificationRationale) in requiredEvidenceFor[CrossSideBasis]
  LLMResponse in requiredEvidenceFor[LLMBasis]
  all b : AnalysisBasis | some requiredEvidenceFor[b]
}

// --- RAE-EVID-RENDER-SAFE: preserved raw values render as inert Markdown data ---

// Safety: neutralized evidence cannot activate inline or block Markdown structure.
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
- Implementation: [findings.ts:49 Finding](/src/domain/findings.ts#L49), [render.ts:314 enforceFindingSupport()](/src/domain/reporting/render.ts#L314)
- Test: [reporting.test.ts:128 passes finding with all required fields including rationale](/test/contract/reporting.test.ts#L128), [global.invariant.test.ts:50 INV-2: every finding has provenance linking to a source file](/test/invariant/global.invariant.test.ts#L50)

#### Scenario: Missing Required Field Rejected [RAE-SHAPE-FAIL]
IF a finding would be emitted without a required field, THEN THE spec-check tool SHALL treat this as an analysis defect and surface it rather than emitting an incomplete finding.

**Postcondition:** The finding pipeline never produces malformed findings.

##### Evidence
- Implementation: [render.ts:314 enforceFindingSupport()](/src/domain/reporting/render.ts#L314)
- Test: [reporting.test.ts:57 suppresses finding without required evidence as defect](/test/contract/reporting.test.ts#L57), [reporting.test.ts:78 suppresses finding with empty rationale as defect](/test/contract/reporting.test.ts#L78), [reporting.test.ts:103 suppresses finding with empty provenance file as defect](/test/contract/reporting.test.ts#L103)

#### Scenario: Catalog Diagnostic Remains Actionable [RAE-SHAPE-CATALOG]
WHEN the tool surfaces a catalog-empty diagnostic, THE spec-check tool SHALL include the empty-catalog cause and actionable remediation text in the surfaced message.

**Postcondition:** Catalog errors meet the same reviewability standard as normal findings.

##### Evidence
- Implementation: [run-cli.ts:83 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L83)
- Test: [cli.test.ts:209 formats each empty-catalog variant with contextual details](/test/contract/cli.test.ts#L209)
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
- Test: [logic-analysis.test.ts:575 maps each merge conflict kind to merge_conflict finding with stable evidence](/test/contract/logic-analysis.test.ts#L575), [logic-analysis.test.ts:556 rejects duplicate raw claim IDs as invalid group before compile and solver work](/test/contract/logic-analysis.test.ts#L556), [logic-analysis.test.ts:619 detects constructed sanitized-id collision in preflight](/test/contract/logic-analysis.test.ts#L619), [smtlib.test.ts:115 detects function signature conflicts and excludes conflicting claims](/test/contract/smtlib.test.ts#L115), [smtlib.test.ts:135 detects variable sort mismatch and excludes later claim](/test/contract/smtlib.test.ts#L135), [smtlib.test.ts:155 detects symbol kind collision across claims](/test/contract/smtlib.test.ts#L155), [smtlib.test.ts:175 detects same-claim symbol kind collision](/test/contract/smtlib.test.ts#L175)
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

// --- Logic-defect taxonomy and claim-attributed evidence ---
// Safety: each structural defect requires evidence and error severity.
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

// Guard/Postcondition: a cause-specific diagnostic includes a remediation cue.
// Effects/Frames: none; this is a static diagnostic-shape check.
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
- Test: [run-state.test.ts:23 appends findings preserving prior entries](/test/contract/run-state.test.ts#L23), [global.invariant.test.ts:79 INV-6: findings are never silently removed by later phases](/test/invariant/global.invariant.test.ts#L79)
- Test (property): [run-state.property.test.ts:20 findings are never removed by later phases (append-only)](/test/property/run-state.property.test.ts#L20)
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
  frame_final_state
  frame_metrics
  all f : OutputFile | f.pathState' = f.pathState
}

// Admissible emission: a well-formed finding with fully preserved evidence is
// recorded. This is the sole way an ordinary finding enters the findings set,
// which is why complete_phase now frames findings.
pred emit_finding [f : Finding] {
  // Guard
  Run.catalog = CatalogConstructed
  Run.finalStage = CoreReporting
  Run.failed = False
  R_Summary not in Run.reports
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
  Run.finalStage = CoreReporting
  Run.failed = False
  R_Summary not in Run.reports
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

### Requirement: Persist Opt-In Run Metrics [RAE-RUN-METRICS]

WHEN the `SPEC_CHECK_TELEMETRY` environment variable equals `1`, THE spec-check tool SHALL atomically write `metrics.json` under the output directory before the successful manifest, SHALL include it as a checksummed manifest entry, and SHALL record named pipeline phase durations plus every OpenCode subprocess attempt before core completion, including retries, model variant, outcome, token usage, cost, and analysis-scope attribution. The post-completion final-report attempt SHALL remain in in-memory telemetry and SHALL NOT mutate the core `metrics.json` snapshot.

#### Scenario: Metrics Reconcile Attempt And Phase Totals [RAE-METRICS-RECONCILE]

WHEN an instrumented run completes successfully, THE `metrics.json` totals
SHALL equal the sum of its recorded attempts, and each analysis-scope total
SHALL equal the sum of attempts attributed to that scope.

**Postcondition:** Consumers can compare model quality and efficiency without
inferring tokens from report size or double-counting concurrent phase time.

##### Evidence
- Implementation: [metrics.ts:23 writeRunMetrics()](/src/domain/reporting/metrics.ts#L23), [telemetry.ts:74 recordPipelinePhase()](/src/adapters/telemetry.ts#L74), [telemetry.ts:116 recordOpencodeAttempt()](/src/adapters/telemetry.ts#L116), [telemetry.ts:129 snapshotCurrentTelemetry()](/src/adapters/telemetry.ts#L129)
- Test: [metrics.test.ts:13 reconciles phase and run totals and returns its checksum](/test/contract/metrics.test.ts#L13), [telemetry.test.ts:14 keeps concurrent phase attribution isolated and sorts logical calls](/test/contract/telemetry.test.ts#L14)

#### Scenario: Metrics Preserve Manifest Completion Semantics [RAE-METRICS-MANIFEST]

WHEN metrics are enabled and a run completes successfully, THE spec-check tool
SHALL finalize `metrics.json` before `manifest.json` and SHALL list the exact
metrics checksum in the manifest. IF the pipeline fails before successful
reporting, THEN metrics SHALL NOT create a completion marker.

**Postcondition:** `manifest.json` remains the sole successful-run completion
marker.

##### Evidence
- Implementation: [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553), [run-cli.ts:650 writeCurrentRunMetrics()](/src/cli/run-cli.ts#L650), [manifest.ts:128 writeManifest()](/src/domain/reporting/manifest.ts#L128)
- Test: [metrics.test.ts:13 reconciles phase and run totals and returns its checksum](/test/contract/metrics.test.ts#L13)
- Test (integration): [merge-pipeline.integration.test.ts:189 writes and manifests opt-in run metrics](/test/integration/merge-pipeline.integration.test.ts#L189)

#### Requirement model

```alloy
// --- Opt-in core metrics snapshot ---
// Snapshot entity invariants are above; publication remains lifecycle-gated.

// Guard: opt-in, complete reports, healthy core phase, no prior metrics snapshot.
// Effect: finalize checksummed metrics. Frame: core/report state. Postcondition: not yet listed.
pred write_metrics {
  Run.telemetryEnabled = True
  Run.failed = False
  requiredReports in Run.reports
  Run.metricsPresent = False
  Run.finalStage = CoreReporting
  Run.metricsPresent' = True
  Run.metricsChecksummed' = True
  Run.metricsListed' = False
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  Run.finalStage' = Run.finalStage
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.finalFailure' = Run.finalFailure
  Run.agentInvoked' = Run.agentInvoked
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  all f : OutputFile | f.pathState' = f.pathState
}

// Safety: disabled runs publish no metrics.
assert metrics_opt_in_only {
  always (Run.telemetryEnabled = False implies Run.metricsPresent = False)
}

// Safety: persisted totals and scope partitions reconcile to core attempts only.
assert persisted_attempts_reconcile {
  always (Run.metricsPresent = True implies {
    MetricsSnapshot.persistedAttempts = coreAttempts
    no (MetricsSnapshot.persistedAttempts & finalReportAttempts)
    MetricsSnapshot.scopeTotalsCover
      = MetricsSnapshot.persistedAttempts.attemptScope
    MetricsSnapshot.durationTotal
      = MetricsSnapshot.persistedAttempts.durationUnits
    MetricsSnapshot.tokenTotal
      = MetricsSnapshot.persistedAttempts.tokenUnits
    MetricsSnapshot.costTotal
      = MetricsSnapshot.persistedAttempts.costUnits
    all s : MetricsSnapshot.scopeTotalsCover |
      some a : MetricsSnapshot.persistedAttempts | a.attemptScope = s
  })
}

// Safety: retry identity and resource inventories exclude the final-report attempt.
assert retry_and_resource_inventory_reconcile {
  CoreAttemptB.retryOf = CoreAttemptA
  CoreAttemptA.outcome = AttemptFailed
  CoreAttemptB.outcome = AttemptSucceeded
  MetricsSnapshot.durationTotal = DurationA + DurationB
  MetricsSnapshot.tokenTotal = TokenA + TokenB
  MetricsSnapshot.costTotal = CostA + CostB
  FinalReportAttempt not in MetricsSnapshot.persistedAttempts
  all a : MetricsSnapshot.persistedAttempts | {
    one a.pipelinePhase
    one a.modelVariant
    one a.outcome
  }
  all p : PipelinePhaseName |
    some d : MetricsSnapshot.phaseDurations | d.phaseName = p
}

// Safety: enabled metrics are finalized and checksummed before manifest publication.
assert metrics_precede_completion_manifest {
  always (Run.manifestPresent = True and Run.telemetryEnabled = True implies {
    Run.metricsPresent = True
    Run.metricsChecksummed = True
    Run.metricsListed = True
  })
}

// Safety: enabled metrics are listed exactly while a current manifest exists.
assert metrics_listing_matches_manifest_presence {
  always (Run.telemetryEnabled = True implies
    (Run.metricsListed = True iff Run.manifestPresent = True))
}

// Post-completion telemetry cannot make the core snapshot stale because it is
// deliberately outside the snapshot and does not rewrite metrics.
assert final_report_does_not_mutate_metrics {
  always (Run.finalStage in Generating + Validating + PublishedCandidate + Cleaning + Cleaned + WarningRecorded
    + MarkerInvalidated + SummaryRewritten + ManifestRefreshing
    + ReportAvailable + WarningPersisted + OutputFailed implies {
      Run.metricsPresent' = Run.metricsPresent
      Run.metricsChecksummed' = Run.metricsChecksummed
    })
}
```

### Requirement: Complete Runs With Atomic Manifest Semantics [RAE-ATOMIC-MANIFEST]
WHEN the spec-check tool writes core output artifacts, THE spec-check tool SHALL atomically finalize each core artifact, SHALL permit separate formalization attempt-evidence files to exist before successful core completion, and SHALL write `manifest.json` after all core artifacts as the sole core-run success marker. The successful manifest SHALL list every produced attempt-evidence file and its SHA-256 checksum together with the other produced core output files. The optional post-completion `report.md` MAY be written after that marker and SHALL remain outside the manifest.

**References:**
- `openspec/specs/reporting-and-evidence/spec.md#Requirement-Complete-Runs-With-Atomic-Manifest-Semantics-RAE-ATOMIC-MANIFEST`
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Preconditions-Postconditions-and-Invariants`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Data-Design`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Preconditions-Postconditions-and-Invariants`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/design.md#Interaction-Protocols`

#### Scenario: Successful Manifest Covers Attempt Evidence [RAE-MANIFEST-ATTEMPT-EVIDENCE]
WHEN a run completes core analysis after producing one or more `FormalizationAttemptSet` files, THE spec-check tool SHALL write the manifest after those files and SHALL include one entry per file with its relative path and matching SHA-256 checksum.

**Postcondition:** Manifest presence marks the last successful core run and mechanically binds all durable attempt evidence to it.

##### Evidence
- Implementation: [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553), [formalization-evidence.ts:205 writeFormalizationAttemptSet()](/src/domain/reporting/formalization-evidence.ts#L205)
- Test: [manifest.test.ts:73 lists formalization evidence as an ordinary checksummed file without embedding attempts](/test/contract/manifest.test.ts#L73)
- Test (integration): [merge-liveness.integration.test.ts:447 removes stale formalization evidence at run start and checksums the replacement](/test/integration/merge-liveness.integration.test.ts#L447)

#### Scenario: Attempt Evidence Alone Is Not Completion [RAE-MANIFEST-ATTEMPT-INCOMPLETE]
IF attempt-evidence files exist but core analysis fails or terminates before `manifest.json` is written, THEN consumers SHALL treat the run as incomplete.

**Postcondition:** Atomic evidence survival does not weaken core manifest completion semantics.

##### Evidence
- Implementation: [run-cli.ts:441 runFormalizationPhaseWithEvidence()](/src/cli/run-cli.ts#L441), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553)
- Test (integration): [merge-liveness.integration.test.ts:367 still aborts when every formalization claim fails](/test/integration/merge-liveness.integration.test.ts#L367)

#### Scenario: Mark Complete Core Run [RAE-MANIFEST-DONE]
WHEN all selected core outputs are written successfully, THE spec-check tool SHALL write a manifest that lists the produced core files and their checksums after all prior core outputs have been finalized.

**Postcondition:** Consumers can treat manifest presence as the marker of a completed core run whether the optional final report later succeeds or fails.

##### Evidence
- Implementation: [manifest.ts:128 writeManifest()](/src/domain/reporting/manifest.ts#L128), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553)
- Test: [manifest.test.ts:19 writes checksums and manifest last](/test/contract/manifest.test.ts#L19)
- Test (integration): [pipeline.integration.test.ts:215 manifest checksums match actual file content](/test/integration/pipeline.integration.test.ts#L215)

#### Scenario: Prevent Partial Core Completion Signal [RAE-MANIFEST-FAIL]
IF core analysis fails before all selected core outputs are finalized, THEN THE spec-check tool SHALL NOT leave a final manifest that implies completed core output.

**Postcondition:** Partial core runs cannot be mistaken for completed analyses.

##### Evidence
- Implementation: [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553)
- Test: [coverage-gaps.test.ts:59 manifest absence signals incomplete run](/test/contract/coverage-gaps.test.ts#L59)

#### Scenario: Invalidate Stale Manifest From Prior Run [RAE-MANIFEST-STALE]
IF the output directory already contains a manifest from a previous run WHEN a new run begins, THEN THE spec-check tool SHALL remove the existing manifest before analysis begins so that a failed rerun cannot be mistaken for a prior successful run.

**Postcondition:** Only a successfully completed core run can leave a current manifest in the output directory.

##### Evidence
- Implementation: [manifest.ts:158 invalidateStaleManifest()](/src/domain/reporting/manifest.ts#L158), [run-cli.ts:170 runCliPipeline()](/src/cli/run-cli.ts#L170)
- Test: [manifest.test.ts:52 removes stale manifest from prior run](/test/contract/manifest.test.ts#L52), [manifest.test.ts:65 returns false when no stale manifest exists](/test/contract/manifest.test.ts#L65)

#### Scenario: Exclude Final Report From Manifest [RAE-MANIFEST-NO-FINAL]
WHEN `manifest.json` is written or refreshed, THE spec-check tool SHALL NOT include an entry whose path is `report.md`.

**Postcondition:** The report does not attest to itself and remains a post-completion derivative.

##### Evidence
- Implementation: [manifest.ts:88 validateCoreManifestEntries()](/src/domain/reporting/manifest.ts#L88), [run-cli.ts:615 writeCoreManifest()](/src/cli/run-cli.ts#L615)
- Test: [safety-liveness.invariant.test.ts:262 SAFE-18: final report never enters core manifest descriptors](/test/invariant/safety-liveness.invariant.test.ts#L262)
- Test (property): [final-report.property.test.ts:104 an unmanifested report cannot change core entries and warning bytes do](/test/property/final-report.property.test.ts#L104), [final-report.property.test.ts:117 the production core-manifest guard rejects report descriptors](/test/property/final-report.property.test.ts#L117)
- Test (integration): [merge-pipeline.integration.test.ts:215 persists a nonfatal final-report warning and refreshes the summary checksum](/test/integration/merge-pipeline.integration.test.ts#L215), [merge-pipeline.integration.test.ts:271 removes stale report output before the current final-report attempt](/test/integration/merge-pipeline.integration.test.ts#L271)

#### Requirement model

```alloy
// --- Atomic manifest: completion marker semantics ---

pred write_manifest {
  // Guard: all required reports written, not failed
  requiredReports in Run.reports
  Run.failed = False
  Run.reportsAtomicallyComplete = True
  Run.telemetryEnabled = True implies
    (Run.metricsPresent = True and Run.metricsChecksummed = True and Run.metricsListed = False)
  // Effect: manifest present and lists exactly the produced reports
  Run.manifestPresent' = True
  Run.manifestFiles' = Run.reports
  Run.manifestAttemptSets' = { a : AttemptSet | a.finalized = True }
  // Frame
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  // The first manifest write establishes core completion. Warning refresh uses
  // its dedicated post-completion event instead.
  Run.finalStage = CoreReporting
  Run.finalStage' = CoreComplete
  Run.coreComplete' = True
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = True
  Run.finalFailure' = Run.finalFailure
  Run.agentInvoked' = Run.agentInvoked
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  Run.metricsPresent' = Run.metricsPresent
  Run.metricsChecksummed' = Run.metricsChecksummed
  Run.metricsListed' = Run.telemetryEnabled
  Run.reportsAtomicallyComplete' = Run.reportsAtomicallyComplete
}

pred remove_stale_manifest {
  // Guard: manifest present at start of new run, no phases completed yet
  Run.manifestPresent = True
  no Run.completedPhases
  // Effect: manifest removed
  Run.manifestPresent' = False
  Run.manifestFiles' = Run.manifestFiles
  Run.manifestAttemptSets' = Run.manifestAttemptSets
  // Frame
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  frame_final_state
  frame_metrics
}

pred run_fails {
  // Guard
  Run.failed = False
  Run.manifestPresent = False    // cannot fail after manifest written (run is complete)
  Run.finalStage = CoreReporting
  // Effect: run marked as failed
  Run.failed' = True
  // Frame: state frozen
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.manifestAttemptSets' = Run.manifestAttemptSets
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  frame_final_state
  frame_metrics
}

// Safety: manifest only present when all required reports are written
assert manifest_implies_complete {
  always (Run.manifestPresent = True implies requiredReports in Run.reports)
}

// Safety: failed runs never have a manifest
assert no_manifest_on_failure {
  always ((Run.failed = True and Run.coreComplete = False)
    implies Run.manifestPresent = False)
}

// Safety: manifest is written AFTER all reports (temporal ordering)
assert manifest_written_last {
  always (Run.manifestPresent' = True and Run.manifestPresent = False
    implies requiredReports in Run.reports)
}

// Report-level COVERAGE (RAE-MANIFEST-DONE / RAE-MANIFEST-ATTEMPT-EVIDENCE):
// "the successful manifest SHALL list every produced output file". Whenever a
// manifest is present, the recorded manifest file set (Run.manifestFiles)
// covers every produced report -- nothing durable is omitted from the
// completion record. write_manifest sets manifestFiles = reports, so this is
// the standing coverage guarantee the schema comment at
// manifest_entries_describe_run defers to.
assert manifest_lists_all_reports {
  always (Run.manifestPresent = True implies Run.reports in Run.manifestFiles)
}

assert manifest_lists_all_finalized_attempt_sets {
  always (Run.manifestPresent = True implies
    Run.manifestAttemptSets = { a : AttemptSet | a.finalized = True })
}

// Safety: an existing manifest blocks phase execution; removal progress is separate.
assert stale_manifest_blocks_phases {
  always (all p : Phase |
    complete_phase[p] implies Run.manifestPresent = False)
}
```

### Requirement: Persist Invocation-Scoped Formalization Attempt Evidence [RAE-FORMAL-ATTEMPT-SETS]
WHEN the spec-check tool records attached formalization attempts, THE spec-check tool SHALL persist one separate atomically finalized `FormalizationAttemptSet` evidence file per formalization invocation. Each envelope SHALL identify its `claimSet` as `specs_forward` or as `generated_spec` with a zero-based invocation ordinal and capability, and SHALL contain attempt indexes that are local to that claim set. Evidence files MAY survive a failed or terminated run and SHALL NOT serve as run-completion markers.

**References:**
- `openspec/changes/archive/2026-08-09-semantic-batching/proposal.md#Domain Model`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Data Design`
- `openspec/changes/archive/2026-08-09-semantic-batching/design.md#Evidence And Artifact Verification`

#### Scenario: Persist Separate Atomic File Per Invocation [RAE-FORMAL-ATTEMPT-ATOMIC]
WHEN one specs-forward or generated-spec formalization invocation produces attempt evidence, THE spec-check tool SHALL atomically finalize exactly one evidence file containing that invocation's `FormalizationAttemptSet` envelope.

**Postcondition:** A complete evidence file contains attempts from one invocation and one claim-index namespace only.

##### Evidence
- Implementation: [formalization-evidence.ts:58 buildFormalizationAttemptSet()](/src/domain/reporting/formalization-evidence.ts#L58), [formalization-evidence.ts:159 formalizationAttemptSetPath()](/src/domain/reporting/formalization-evidence.ts#L159), [formalization-evidence.ts:205 writeFormalizationAttemptSet()](/src/domain/reporting/formalization-evidence.ts#L205), [gen-formal.ts:71 formalizeGeneratedSpecs()](/src/domain/code-backwards/gen-formal.ts#L71)
- Test: [batch-evidence.test.ts:121 records complete pointer-only evidence, cleans up, and persists no claim text](/test/contract/batch-evidence.test.ts#L121), [manifest.test.ts:102 uses deterministic discriminated paths and collision-free generated ordinals](/test/contract/manifest.test.ts#L102)
- Test (property): [semantic-batching.property.test.ts:414 keeps attempt evidence isolated between two concurrent invocations](/test/property/semantic-batching.property.test.ts#L414)
- Test (integration): [merge-liveness.integration.test.ts:447 removes stale formalization evidence at run start and checksums the replacement](/test/integration/merge-liveness.integration.test.ts#L447)
- Example:
```typescript
const { buildFormalizationAttemptSet, formalizationAttemptSetPath } = await import("./src/domain/reporting/formalization-evidence.ts");
const attemptSet = buildFormalizationAttemptSet({ kind: "generated_spec", ordinal: 0, capability: "billing" }, []); //=> type Object
attemptSet.claimSet.kind; //=> generated_spec
attemptSet.attempts.length; //=> 0
formalizationAttemptSetPath(attemptSet.claimSet).includes("generated_spec_000000"); //=> true
```

#### Scenario: Failed Run May Retain Attempt Evidence [RAE-FORMAL-ATTEMPT-FAILED-RUN]
IF a run fails or the process terminates after an attempt-set evidence file is atomically finalized, THEN THE file MAY remain while `manifest.json` is absent.

**Postcondition:** Surviving attempt evidence is auditable partial-run output and cannot be mistaken for a successful run.

##### Evidence
- Implementation: [run-cli.ts:441 runFormalizationPhaseWithEvidence()](/src/cli/run-cli.ts#L441)
- Test (integration): [merge-liveness.integration.test.ts:367 still aborts when every formalization claim fails](/test/integration/merge-liveness.integration.test.ts#L367)

#### Requirement model

```alloy
// --- Invocation-scoped formalization attempt evidence (RAE-FORMAL-ATTEMPT-SETS) ---
// One FormalizationAttemptSet file per formalization invocation. The envelope
// identifies a claimSet (specs_forward, or generated_spec with a capability and
// a zero-based invocation ordinal) and carries attempt indexes local to that
// claim set. These files are atomically finalized, MAY survive a failed or
// terminated run, and are NEVER run-completion markers (only manifest.json is).

// Claim-set kind: specs_forward is singular; generated_spec is per-capability.
// One evidence file = one invocation's attempt set. `finalized` tracks the
// atomic-write lifecycle (Absent -> FinalComplete); a file becomes durable only
// when atomically finalized.

// Zero-based invocation ordinals for generated_spec claim sets. (The zero-based
// numbering is a serialization detail; the model treats ordinals as distinct
// tags that disambiguate multiple generated_spec invocations of one capability.)

// Structural invariant [RAE-FORMAL-ATTEMPT-ATOMIC]: the claim-index namespace is
// exactly one claim set per file. specs_forward files bind no capability/ordinal;
// generated_spec files bind exactly one capability and a zero-based ordinal.

// Distinct generated_spec files for the same capability carry distinct ordinals,
// and specs_forward is unique: one invocation namespace never maps to two files.

// --- Atomic finalization lifecycle (reuses Run.failed / Run.manifestPresent) ---

pred init_attempt_sets { all a : AttemptSet | a.finalized = False }

// Atomically finalize one attempt-set evidence file. Permitted before manifest
// completion and even independent of run success (evidence is produced as
// invocations happen). Other pipeline events do not clear it -- see the
// attempt_evidence_monotonic fact -- so no per-event frame is required.
pred finalize_attempt_set [a : AttemptSet] {
  // Guard: unfinished invocation evidence during healthy core reporting.
  // Effect: finalize this file. Frame: other files/Run. Postcondition: evidence alone is not completion.
  Run.finalStage = CoreReporting
  Run.manifestPresent = False
  Run.failed = False
  a.finalized = False
  a.finalized' = True
  all a2 : AttemptSet - a | a2.finalized' = a2.finalized
  // Frame: Run and OutputFile state are unchanged by evidence finalization.
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  frame_final_state
  frame_metrics
  all f : OutputFile | f.pathState' = f.pathState
}

// [RAE-FORMAL-ATTEMPT-FAILED-RUN] A finalized evidence file MAY persist through a
// failed run while manifest.json is absent: finalization is monotonic and does
// not depend on run success. (Modeled as: finalized never spontaneously clears;
// only run-start manifest removal governs manifest, not evidence files.)
// No post-completion or terminal event may create new formalization evidence.

assert attempt_evidence_finalizes_before_core_completion {
  always (all a : AttemptSet |
    (a.finalized = False and a.finalized' = True) implies
      (Run.finalStage = CoreReporting and Run.manifestPresent = False))
}

// Safety [RAE-FORMAL-ATTEMPT-SETS]: an attempt-set file is never a completion
// marker. The load-bearing form: a finalized attempt set can coexist with an
// absent manifest on a failed run (evidence survives failure; it does not mark
// success).
assert evidence_survives_failure_without_manifest {
  always (all a : AttemptSet |
    (a.finalized = True and Run.failed = True and Run.coreComplete = False)
      implies Run.manifestPresent = False)
}

// Safety [RAE-FORMAL-ATTEMPT-ATOMIC]: every finalized file has exactly one claim
// set namespace (never mixes specs_forward and generated_spec content).
assert one_namespace_per_file {
  all a : AttemptSet | one a.claimSetKind
}

// Coverage [RAE-MANIFEST-ATTEMPT-EVIDENCE]: when the manifest is present the run
// did not fail, so any evidence produced belongs to a successful run and is
// listed alongside other outputs (report-level coverage is manifest_lists_all_reports).
assert manifest_present_implies_run_succeeded {
  // A fatal post-completion output failure may preserve the already-valid core
  // manifest if marker invalidation has not yet occurred. Before core completion,
  // however, no failed run may expose a completion marker.
  always ((Run.manifestPresent = True and Run.coreComplete = False)
    implies Run.failed = False)
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
- Implementation: [manifest.ts:66 buildManifestEntries()](/src/domain/reporting/manifest.ts#L66)
- Test: [manifest.test.ts:40 manifest entries match actual file checksums](/test/contract/manifest.test.ts#L40), [global.invariant.test.ts:113 INV-8: manifest entries have correct checksums for content](/test/invariant/global.invariant.test.ts#L113)
- Test (property): [manifest.property.test.ts:9 every manifest entry has correct checksum for its content](/test/property/manifest.property.test.ts#L9)
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
- Implementation: [fs.ts:119 sha256Hex()](/src/adapters/fs.ts#L119)
- Test: [fs.test.ts:30 computes sha256 lowercase hex of correct length](/test/contract/fs.test.ts#L30)
- Test (property): [manifest.property.test.ts:9 every manifest entry has correct checksum for its content](/test/property/manifest.property.test.ts#L9)
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
  // Every entry references one produced artifact class.
  all e : entries |
    (some e.entryReport implies e.entryReport in Run.reports)
    and (some e.entryAttemptSet implies e.entryAttemptSet.finalized = True)
    and (some e.entryMetrics implies Run.metricsPresent = True)
  // Every entry has a valid checksum
  all e : entries | e.checksumValid = True
  // Every entry references a phase that was completed
  all e : entries |
    no e.entryReport or e.entryReport = R_Summary
      or e.entryPhase in reportManifestPhase[phaseToReport[Run.completedPhases]]
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
// separately via Run.manifestFiles (see manifest_lists_all_reports in the
// RAE-ATOMIC-MANIFEST requirement model).

pred complete_manifest_entries {
  {
    all r : Run.reports |
      one e : ManifestEntry | {
        e.entryReport = r
        e.checksumValid = True
        r != R_Summary implies one e.entryPhase
      }
    all a : Run.manifestAttemptSets |
      one e : ManifestEntry | e.entryAttemptSet = a and e.checksumValid = True
    Run.telemetryEnabled = True implies
      one e : ManifestEntry | e.entryMetrics = MetricsFile and e.checksumValid = True
  }
}


// Safety: manifest entries always reference existing reports
assert manifest_entries_match_files {
  always (Run.manifestPresent = True implies
    (all e : ManifestEntry |
      (some e.entryReport implies e.entryReport in Run.reports)
      and (some e.entryAttemptSet implies e.entryAttemptSet in Run.manifestAttemptSets)
      and (some e.entryMetrics implies Run.metricsListed = True)))
}

// Safety: manifest entries have valid checksums
assert manifest_checksums_valid {
  always (Run.manifestPresent = True implies
    (all e : ManifestEntry | e.checksumValid = True))
}

assert manifest_entries_cover_attempt_sets_and_metrics {
  always (Run.manifestPresent = True implies complete_manifest_entries)
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
- Implementation: [fs.ts:46 resolveConfinedOutputPath()](/src/adapters/fs.ts#L46)
- Test: [fs.test.ts:12 allows path within output directory](/test/contract/fs.test.ts#L12), [global.invariant.test.ts:102 INV-7: all writes are confined to the configured output directory](/test/invariant/global.invariant.test.ts#L102)
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
- Implementation: [fs.ts:46 resolveConfinedOutputPath()](/src/adapters/fs.ts#L46)
- Test: [fs.test.ts:18 rejects path traversal at branding boundary](/test/contract/fs.test.ts#L18), [fs.test.ts:24 rejects absolute path at branding boundary](/test/contract/fs.test.ts#L24), [global.invariant.test.ts:102 INV-7: all writes are confined to the configured output directory](/test/invariant/global.invariant.test.ts#L102)
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
- Implementation: [fs.ts:83 writeOutputAtomic()](/src/adapters/fs.ts#L83)
- Test: [fs.test.ts:36 writes atomic output file with correct content](/test/contract/fs.test.ts#L36), [global.invariant.test.ts:197 INV-3: writeOutputAtomic produces correct content via atomic rename](/test/invariant/global.invariant.test.ts#L197)
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
- Implementation: [fs.ts:83 writeOutputAtomic()](/src/adapters/fs.ts#L83)
- Test: [coverage-gaps.test.ts:72 writeOutputAtomic uses temp+rename to prevent partial writes](/test/contract/coverage-gaps.test.ts#L72)

#### Requirement model

```alloy
// --- Atomic writes: temp-file-then-rename protocol ---

pred atomic_write_success [f : OutputFile] {
  // Guard: path is currently absent (no prior content)
  Run.finalStage = CoreReporting
  Run.failed = False
  f.pathState = Absent
  // Effect: transitions through temp to final atomically
  // In the model, the final state is FinalComplete (temp is invisible to consumers)
  f.pathState' = FinalComplete
  all other : OutputFile - f | other.pathState' = other.pathState
}

pred atomic_write_interrupt [f : OutputFile] {
  // Guard: write was in progress (temp file exists)
  Run.finalStage = CoreReporting
  Run.failed = False
  f.pathState = Absent or f.pathState = TempWriting
  // Effect: final path stays absent (only temp may be orphaned)
  f.pathState' = Absent
  all other : OutputFile - f | other.pathState' = other.pathState
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
```

### Requirement: Verify Release Compatibility Boundary [RAE-OC-COMPAT]
WHEN accepting OpenCode v2 compatibility, THE spec-check verification harness SHALL establish the pinned v1/v2 invocation and isolation baseline and record sanitized empirical evidence in `openspec/changes/archive/2026-10-21-support-opencode-v2/v2-isolation-verification.md` before the v2 final-report path is enabled or compatibility is declared complete.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/proposal.md#Assumptions and Dependencies`
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Compatibility-Discovery-Gate`

#### Scenario: Verify Configuration And Credential Loading [RAE-OC-COMPAT-CONFIG]
WHEN exercising disposable compatibility environments, THE verification harness SHALL establish config-source and environment-override precedence, actual evidence/source reads, usable configured-provider authentication, and report generation without copying credentials into generated config or changing the user's real global configuration.

**Postcondition:** Evidence covers `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, ancestor direct and `.opencode` configs, global/system config, and ambient instructions. Private-server execution alone is not accepted as proof of config isolation.

##### Evidence
- Implementation: [opencode-protocol.ts:42 buildOpencodeEnvironment()](/src/adapters/opencode-protocol.ts#L42), [final-report.ts:264 generateFinalReport()](/src/domain/reporting/final-report.ts#L264)
- Test: [opencode-compatibility.test.ts:36 uses native restricted v2 config, cwd, and non-inherited server exclusion](/test/contract/opencode-compatibility.test.ts#L36), [opencode.live.test.ts:30 reads an approved random token, denies external reads/mutations, and returns strict report transport](/test/contract/opencode.live.test.ts#L30)
- Test (integration): [opencode-server-exclusion.integration.test.ts:14 distinguishes import exclusion from empty arrays and setup-only removals](/test/integration/opencode-server-exclusion.integration.test.ts#L14)

#### Scenario: Exclude Ambient Server Integrations [RAE-OC-COMPAT-EXCLUDE]
WHEN verifying the v2 final-report transport on the supported release baseline, THE verification harness SHALL establish that a private generated server config directory combined with explicit `OPENCODE_CONFIG_PROJECT_DISABLE=1` excludes external server-plugin imports/setup and ambient MCP startup from the tested global/ancestor sources, while retaining required built-in server plugins and the generated restricted report agent.

**Postcondition:** Native project-discovery exclusion overrides inherited native/legacy values. Terminal-only/CLI plugins are outside this exclusion obligation. An empty plugin array or setup-only removal is not accepted as proof of module-import exclusion. Credential/permission/report-transport obligations still require separate evidence.

##### Evidence
- Implementation: [opencode-protocol.ts:42 buildOpencodeEnvironment()](/src/adapters/opencode-protocol.ts#L42)
- Test: [opencode-compatibility.test.ts:36 uses native restricted v2 config, cwd, and non-inherited server exclusion](/test/contract/opencode-compatibility.test.ts#L36), [opencode-compatibility.test.ts:124 retains release-specific gate evidence and its original blocking counterexample](/test/contract/opencode-compatibility.test.ts#L124)
- Test (integration): [opencode-server-exclusion.integration.test.ts:14 distinguishes import exclusion from empty arrays and setup-only removals](/test/integration/opencode-server-exclusion.integration.test.ts#L14)

#### Scenario: Verify Ambient Authority Does Not Escape [RAE-OC-COMPAT-AUTHORITY]
WHEN conflicting same-name agent, permissive mutation-policy, instruction-marker, and harmless plugin/MCP startup-marker fixtures are present, THE verification harness SHALL establish that the accepted transport preserves the required restricted-agent authority and isolation baseline, denies mutation/shell/delegation/web and unapproved external-directory actions, and leaves mutation sentinel bytes unchanged.

**Postcondition:** Startup markers are inspected separately from tool-permission results; an unchanged sentinel alone does not prove plugins or MCP integrations were excluded.

##### Evidence
- Implementation: [final-report.ts:215 buildFinalReportAgentPolicy()](/src/domain/prompts/final-report.ts#L215), [opencode-protocol.ts:66 serializeFinalReportPolicy()](/src/adapters/opencode-protocol.ts#L66), [opencode-protocol.ts:42 buildOpencodeEnvironment()](/src/adapters/opencode-protocol.ts#L42)
- Test: [opencode.live.test.ts:30 reads an approved random token, denies external reads/mutations, and returns strict report transport](/test/contract/opencode.live.test.ts#L30), [opencode-compatibility.test.ts:36 uses native restricted v2 config, cwd, and non-inherited server exclusion](/test/contract/opencode-compatibility.test.ts#L36)
- Test (integration): [opencode-server-exclusion.integration.test.ts:14 distinguishes import exclusion from empty arrays and setup-only removals](/test/integration/opencode-server-exclusion.integration.test.ts#L14)

#### Scenario: Block Unverified Compatibility [RAE-OC-COMPAT-BLOCK]
IF the required isolation or credential-loading contract cannot be established, THEN THE change implementer SHALL record the blocker and revise the invocation design/specification before enabling the v2 final-report path or marking the change complete.

**Postcondition:** The existing handled final-report warning/manifest-refresh lifecycle remains in force at runtime and does not satisfy this release acceptance gate by itself. Published documentation names tested releases and any discovered minimum release requirement.

##### Evidence
- Test: [opencode-compatibility.test.ts:124 retains release-specific gate evidence and its original blocking counterexample](/test/contract/opencode-compatibility.test.ts#L124)

#### Requirement model

```alloy
// --- Pinned-release compatibility gate ---
// Effects/Frames: none; external verification supplies these observations.
// Tests establish config precedence, provider use and actual denied operations.
// Terminal-only plugins are outside the server-source exclusion obligation.
pred rae_release_verified[e : RAEReleaseEvidence] {
  // Guards: recorded positive reads/auth plus independent authority/startup evidence.
  e.recorded = True
  e.configPrecedenceVerified = True
  e.approvedReadsVerified = True
  e.credentialsUsable = True
  e.deniedAuthorityVerified = True
  e.externalPluginsExcluded = True
  e.ambientMcpExcluded = True
  e.builtinsUsable = True
  e.credentialsCopied = False
  e.userConfigChanged = False
  e.autoApproval = False
  // Postcondition: only the tested major's isolated transport is admitted.
  e.major = RAEV1 implies {
    e.pureFlag = True
    e.dirFlag = True
    e.standalone = False
  }
  e.major = RAEV2 implies {
    e.privateConfig = True
    e.projectDisabled = True
    e.cwdMatchesPwd = True
    e.standalone = True
    e.pureFlag = False
    e.dirFlag = False
  }
}
// Safety: successful generation alone cannot satisfy the release acceptance gate.
assert rae_unverified_release_is_blocked {
  all e : RAEReleaseEvidence | e.recorded = False or e.credentialsUsable = False or
    e.deniedAuthorityVerified = False or e.externalPluginsExcluded = False or
    e.ambientMcpExcluded = False implies not rae_release_verified[e]
}
// Safety: v2 admission requires native project exclusion and aligned cwd/PWD.
assert rae_v2_requires_isolated_transport {
  all e : RAEReleaseEvidence | rae_release_verified[e] and e.major = RAEV2 implies
    e.projectDisabled = True and e.cwdMatchesPwd = True and
    e.privateConfig = True and e.pureFlag = False and e.dirFlag = False
}
```

### Requirement: Preserve OpenCode Event Meaning [RAE-OC-EVENTS]
WHEN consuming output from either supported major, THE OpenCode adapter SHALL preserve accepted text/error semantics, phase-schema validation, nonzero-exit precedence, and usage-completeness accounting, with version-specific decoding only for demonstrated fixture differences.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Event-and-Telemetry-Protocol`

#### Scenario: Ignore Unknown Event Types [RAE-OC-EVENTS-UNKNOWN]
WHEN an otherwise valid stream includes an unrecognized event type, THE adapter SHALL ignore that event without treating it as response text or proof of successful completion.

##### Evidence
- Implementation: [opencode.ts:659 parseOpencodePayload()](/src/adapters/opencode.ts#L659), [opencode.ts:770 extractPayloadFromEvents()](/src/adapters/opencode.ts#L770), [opencode.ts:932 extractTextPart()](/src/adapters/opencode.ts#L932)
- Test: [opencode-compatibility.test.ts:53 decodes captured major %s text and usage with no protocol branch](/test/contract/opencode-compatibility.test.ts#L53), [opencode-compatibility.test.ts:78 never accepts an event-only %s stream as a raw model response](/test/contract/opencode-compatibility.test.ts#L78)

#### Scenario: Preserve Invalid Transport Failure [RAE-OC-EVENTS-INVALID]
IF output violates the existing phase-specific transport/schema contract or its process exits nonzero or by signal, THEN THE adapter SHALL reject the attempt even if partial valid response text was emitted.

##### Evidence
- Implementation: [opencode.ts:306 classifyProcessResult()](/src/adapters/opencode.ts#L306), [opencode.ts:659 parseOpencodePayload()](/src/adapters/opencode.ts#L659), [opencode.ts:1006 validatePhaseSchema()](/src/adapters/opencode.ts#L1006)
- Test: [opencode-compatibility.test.ts:68 rejects major %s captured error and process failure with partial payload](/test/contract/opencode-compatibility.test.ts#L68), [opencode.test.ts:184 rejects malformed UTF-8 in the final-report event stream](/test/contract/opencode.test.ts#L184), [opencode.test.ts:515 rejects non-object payload with schema_validation_error](/test/contract/opencode.test.ts#L515)

#### Scenario: Preserve Incomplete Usage [RAE-OC-EVENTS-USAGE]
IF usage fields are missing or malformed under the existing completeness rules, THEN THE adapter SHALL retain incomplete usage attribution rather than fabricate complete zero usage.

##### Evidence
- Implementation: [opencode.ts:511 extractOpencodeUsage()](/src/adapters/opencode.ts#L511), [opencode.ts:562 isCompleteUsageEvent()](/src/adapters/opencode.ts#L562), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443)
- Test: [opencode-compatibility.test.ts:53 decodes captured major %s text and usage with no protocol branch](/test/contract/opencode-compatibility.test.ts#L53), [opencode.test.ts:261 marks usage events incomplete when required provider token fields are absent](/test/contract/opencode.test.ts#L261)

#### Requirement model

```alloy
// --- Event and process-result admission ---
// Effects/Frames: none; observations leave Run and the core snapshot unchanged.
// UTF-8, JSON decoding and phase schemas are executable-test boundaries.
pred rae_stream_accepted[s : RAEStream] {
  // Guards: successful process, valid transport/schema and response text.
  s.zeroExit = True
  s.signalled = False
  s.strictUtf8 = True
  s.validEventLines = True
  s.phasePayloadValid = True
  no e : s.events | e.isError = True
  some rae_response_text[s]
  // Postcondition: partial text never overrides process or transport failure.
}
// Guard: all required usage fields exist and are valid. Postcondition: complete usage.
pred rae_usage_complete[s : RAEStream] { s.usagePresent = True and s.usageValid = True }
// Safety: unknown/error events never contribute response text.
assert rae_text_requires_text_events {
  all s : RAEStream | rae_stream_accepted[s] implies
    some e : s.events | e.isText = True and e.isError = False and some e.textValue
}
// Safety: nonzero exit/signal rejects even a partial valid response.
assert rae_process_failure_overrides_text {
  all s : RAEStream | s.zeroExit = False or s.signalled = True implies
    not rae_stream_accepted[s]
}
// Safety: malformed transport/schema or an error event cannot become success.
assert rae_invalid_transport_is_rejected {
  all s : RAEStream | s.strictUtf8 = False or s.validEventLines = False or
    s.phasePayloadValid = False or (some e : s.events | e.isError = True) implies
      not rae_stream_accepted[s]
}
// Safety: absent/malformed usage stays incomplete, independently of payload success.
assert rae_missing_usage_is_incomplete {
  all s : RAEStream | s.usagePresent = False or s.usageValid = False implies
    not rae_usage_complete[s]
}
```

### Requirement: Attribute Normalized Runtime Metrics [RAE-OC-METRICS]
WHEN recording a new OpenCode model attempt, THE spec-check tool SHALL record its normalized base `model`, resolved `variant` or `null`, and detected `opencodeMajor` (`1` or `2`) while preserving existing opt-in metrics and core-manifest snapshot semantics.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/proposal.md#Postconditions`
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Event-and-Telemetry-Protocol`

#### Scenario: Preserve Schema V1 Compatibility [RAE-OC-METRICS-SCHEMA]
WHEN serializing new attempts or handling existing schema-v1 snapshots, THE metrics code SHALL retain `schemaVersion: 1`, serialize the additive optional `opencodeMajor` when present, and continue to accept snapshots without that field.

##### Evidence
- Implementation: [telemetry.ts:12 OpencodeAttemptTelemetry](/src/adapters/telemetry.ts#L12), [telemetry.ts:41 RunTelemetrySnapshot](/src/adapters/telemetry.ts#L41), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443), [metrics.ts:23 writeRunMetrics()](/src/domain/reporting/metrics.ts#L23)
- Test: [opencode-compatibility.test.ts:85 records semantic model/variant and additive major metadata, without a probe attempt](/test/contract/opencode-compatibility.test.ts#L85), [metrics.test.ts:13 reconciles phase and run totals and returns its checksum](/test/contract/metrics.test.ts#L13)

#### Scenario: Keep Probes Out Of Model Usage [RAE-OC-METRICS-PROBE]
WHEN OpenCode version detection executes, THE spec-check tool SHALL attribute it to dependency work without recording it as a model attempt or token-bearing call.

##### Evidence
- Implementation: [run-cli.ts:284 runIngestionPhases()](/src/cli/run-cli.ts#L284), [opencode-runtime.ts:88 detectOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L88), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443)
- Test: [opencode-compatibility.test.ts:85 records semantic model/variant and additive major metadata, without a probe attempt](/test/contract/opencode-compatibility.test.ts#L85)
- Test (integration): [opencode-runtime.integration.test.ts:43 runs compiled and bundled pipelines against major %s with one probe each](/test/integration/opencode-runtime.integration.test.ts#L43)

#### Scenario: Preserve Snapshot And Privacy [RAE-OC-METRICS-SNAPSHOT]
WHEN core metrics are persisted, THE spec-check tool SHALL preserve the existing totals and pre-manifest checksum rules, omit full argv and credentials from new compatibility metadata, and retain post-completion report attempts only in memory without rewriting the core metrics snapshot.

##### Evidence
- Implementation: [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443), [metrics.ts:23 writeRunMetrics()](/src/domain/reporting/metrics.ts#L23)
- Test: [opencode.test.ts:100 attributes final-report attempts without recording prompt content](/test/contract/opencode.test.ts#L100), [opencode-compatibility.test.ts:85 records semantic model/variant and additive major metadata, without a probe attempt](/test/contract/opencode-compatibility.test.ts#L85)
- Test (property): [metrics.property.test.ts:41 single-pass metrics reconcile with independent reductions for generated retry histories](/test/property/metrics.property.test.ts#L41)
- Test (integration): [merge-pipeline.integration.test.ts:189 writes and manifests opt-in run metrics](/test/integration/merge-pipeline.integration.test.ts#L189)

#### Requirement model

```alloy
// --- Additive schema-v1 runtime metadata ---
// Guards: the metadata-shape contract is admitted. Effects/Frames: none.
// Existing metrics snapshot/manifest predicates retain publication authority.
// Safety: new attempts record the detected major and normalized model/variant.
assert rae_new_attempt_metadata_matches_selection {
  all m : RAEMetricRecord | rae_metric_shape[m] and
    m.probe = False and m.historical = False implies {
      m.storedMajor = m.detectedMajor
      m.storedModel = m.baseModel
      m.storedVariant = m.selectedVariant
      m.schemaV1 = True
    }
}
// Safety: probes never become model attempts; compatibility metadata has no secrets/argv.
assert rae_probes_and_private_metadata_are_excluded {
  all m : RAEMetricRecord | rae_metric_shape[m] implies {
    m.probe = True implies m.recordedAsAttempt = False
    m.includesArgv = False
    m.includesCredentials = False
  }
}
// Legacy absence is permitted by rae_metric_shape; the end-of-file witness checks it.
```

### Requirement: Make Capture Overflow Terminal [RAE-OC-OUTPUT-LIMIT]
WHEN a model call exceeds its process-output capture limit, THE OpenCode adapter SHALL return terminal `output_limit`, SHALL perform no further model attempt for that logical call, and SHALL prohibit formalization model-response degradation for that infrastructure limit.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Review-Correction-Contracts`

#### Scenario: Preserve The Capture Budget [RAE-OC-OUTPUT-ONCE]
IF capture overflow is reported with a retry budget larger than one or a competing timeout flag, THEN THE OpenCode adapter SHALL retain output-limit classification and SHALL record at most the single attempted model call rather than retry an oversized response.

##### Evidence
- Implementation: [opencode.ts:306 classifyProcessResult()](/src/adapters/opencode.ts#L306), [opencode.ts:158 isTransientFailureKind()](/src/adapters/opencode.ts#L158), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443), [degradation.ts:80 decideBatchDegradation()](/src/domain/formal/degradation.ts#L80)
- Test: [opencode.test.ts:198 never retries capture overflow even with a competing timeout flag (%s)](/test/contract/opencode.test.ts#L198)

#### Requirement model

```alloy
// --- Terminal capture overflow ---
// Effects/Frames: none; local retry/fallback decisions add no pipeline states.
// Guard: retryable failure and remaining budget, without overflow.
// Postcondition: only these calls may attempt again.
pred rae_retry_allowed[overflow, retryable, budgetRemaining : Bool] {
  overflow = False
  retryable = True
  budgetRemaining = True
}
// Guard: recoverable model response, not capture overflow. Postcondition: fallback allowed.
pred rae_degradation_allowed[overflow, modelResponseFailure : Bool] {
  overflow = False
  modelResponseFailure = True
}
// Safety: overflow wins over timeout and cannot consume another attempt or fallback.
assert rae_overflow_is_terminal {
  all timedOut, retryable, budget, responseFailure : Bool | {
    rae_attempt_failure[True, timedOut] = RAECaptureOverflow
    not rae_retry_allowed[True, retryable, budget]
    not rae_degradation_allowed[True, responseFailure]
  }
}
```

### Requirement: Collect Telemetry Only On Request [RAE-OC-COLLECTION]
WHEN a production run starts without `SPEC_CHECK_TELEMETRY=1` and without an explicitly injected collector, THE spec-check tool SHALL avoid creating a telemetry collector, parsing model usage, or retaining attempt records.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Review-Correction-Contracts`

#### Scenario: Preserve Explicit Collection [RAE-OC-COLLECTION-EXPLICIT]
WHEN a verification caller explicitly binds a collector or a production run enables telemetry, THE spec-check tool SHALL retain phase/attempt attribution, reconcile totals and logical calls, and preserve existing metrics/manifest snapshot semantics.

##### Evidence
- Implementation: [run-cli.ts:162 runCli()](/src/cli/run-cli.ts#L162), [telemetry.ts:88 runWithTelemetryCollector()](/src/adapters/telemetry.ts#L88), [telemetry.ts:105 allocateOpencodeCallId()](/src/adapters/telemetry.ts#L105), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553)
- Test: [opencode-compatibility.test.ts:101 does not re-read stdout for usage parsing without a telemetry context](/test/contract/opencode-compatibility.test.ts#L101), [telemetry.test.ts:14 keeps concurrent phase attribution isolated and sorts logical calls](/test/contract/telemetry.test.ts#L14)
- Test (property): [metrics.property.test.ts:41 single-pass metrics reconcile with independent reductions for generated retry histories](/test/property/metrics.property.test.ts#L41)
- Test (integration): [merge-pipeline.integration.test.ts:100 does not create an implicit collector when telemetry is disabled, but preserves explicit injection](/test/integration/merge-pipeline.integration.test.ts#L100), [merge-pipeline.integration.test.ts:119 captures telemetry enablement once at run start (%s)](/test/integration/merge-pipeline.integration.test.ts#L119)

#### Requirement model

```alloy
// --- Immutable startup collection mode ---
// Effects/Frames: none; currentEnvironment cannot change the startup decision.
// Guard: startup opt-in or explicit collector. Postcondition: collection is enabled.
pred rae_collection_enabled[m : RAECollectionMode] {
  m.requestedAtStart = True or m.explicitlyInjected = True
}
// Safety: disabled runs bind no collector and allow no usage parsing/retention.
assert rae_disabled_collection_has_no_work {
  all m : RAECollectionMode | rae_collection_contract[m] and
    m.requestedAtStart = False and m.explicitlyInjected = False implies {
      m.collectorBound = False
      m.usageParsingAllowed = False
      m.retentionAllowed = False
      m.publicationAllowed = False
    }
}
// Safety: startup opt-in permits collection and durable publication.
assert rae_requested_collection_is_enabled {
  all m : RAECollectionMode | rae_collection_contract[m] and
    m.requestedAtStart = True implies {
      m.collectorBound = True
      m.usageParsingAllowed = True
      m.retentionAllowed = True
      m.publicationAllowed = True
    }
}
// Safety: explicit injection enables collection, not unsolicited durable publication.
assert rae_injected_collection_remains_explicit {
  all m : RAECollectionMode | rae_collection_contract[m] and
    m.explicitlyInjected = True implies {
      m.collectorBound = True
      m.usageParsingAllowed = True
      m.retentionAllowed = True
      (m.publicationAllowed = True iff m.requestedAtStart = True)
    }
}
// Safety: environment changes after startup cannot switch collection/publication mode.
assert rae_collection_mode_is_stable {
  all a, b : RAECollectionMode | rae_collection_contract[a] and
    rae_collection_contract[b] and a.requestedAtStart = b.requestedAtStart and
    a.explicitlyInjected = b.explicitlyInjected implies {
      a.collectorBound = b.collectorBound
      a.usageParsingAllowed = b.usageParsingAllowed
      a.retentionAllowed = b.retentionAllowed
      a.publicationAllowed = b.publicationAllowed
    }
}
```

### Requirement: Admit Safe Relative Citations [RAE-RELATIVE-CITATIONS]
WHEN validating global and per-finding final-report citations, THE spec-check tool SHALL accept syntactically safe repository-relative artifact paths independently of their directory names, including custom output/specification directories and explicitly formatted root filenames.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Review-Correction-Contracts`

#### Scenario: Admit Custom Artifact Locations [RAE-CITATION-CUSTOM]
WHEN an otherwise valid report cites `analysis-output/report_summary.md`, `requirements/spec.md`, or an explicitly formatted root artifact, THE final-report validator SHALL accept those paths without a built-in directory allowlist.

##### Evidence
- Implementation: [final-report.ts:517 hasRepositoryCitation()](/src/domain/reporting/final-report.ts#L517), [final-report.ts:536 isRepositoryRelativeCitation()](/src/domain/reporting/final-report.ts#L536), [final-report.ts:447 validateFinalReportContent()](/src/domain/reporting/final-report.ts#L447)
- Test: [final-report.test.ts:191 accepts safe custom repository citations: %s](/test/contract/final-report.test.ts#L191)

#### Scenario: Reject Nonrelative Or Traversing Citations [RAE-CITATION-UNSAFE]
IF a citation is a URL, absolute/drive/UNC/home path, contains dot traversal or control characters, or appears only inside a fenced/comment block, THEN THE final-report validator SHALL reject that candidate without recovering an apparently relative substring from it.

##### Evidence
- Implementation: [final-report.ts:496 markdownLinesOutsideFences()](/src/domain/reporting/final-report.ts#L496), [final-report.ts:517 hasRepositoryCitation()](/src/domain/reporting/final-report.ts#L517), [final-report.ts:536 isRepositoryRelativeCitation()](/src/domain/reporting/final-report.ts#L536)
- Test: [final-report.test.ts:203 rejects unsafe custom citations without accepting a relative suffix: %s](/test/contract/final-report.test.ts#L203), [final-report.test.ts:233 does not recover a bare relative suffix inside a non-path token: %s](/test/contract/final-report.test.ts#L233), [final-report.test.ts:241 does not accept headings or citations from fenced or non-relative text](/test/contract/final-report.test.ts#L241), [final-report.test.ts:284 does not accept report structure hidden in HTML comments](/test/contract/final-report.test.ts#L284)

#### Requirement model

```alloy
// --- Whole-token repository-relative citation admission ---
// Effects/Frames: none; no file-existence claim or directory allowlist is added.
// Tests establish whole-token extraction, lexical syntax and fence/comment visibility.
pred rae_citation_admitted[c : RAECitation] {
  // Guards: visible whole artifact token with safe relative syntax.
  c.wholeToken = True
  c.relativeSyntax = True
  c.traversal = False
  c.controlCharacters = False
  c.visible = True
  c.artifactReference = True
  // Postcondition: custom directories and explicit root artifacts can qualify.
}
// Safety: malformed/nonrelative tokens cannot qualify via suffix recovery.
assert rae_unsafe_citation_is_rejected {
  all c : RAECitation | c.wholeToken = False or c.relativeSyntax = False or
    c.traversal = True or c.controlCharacters = True or c.visible = False implies
      not rae_citation_admitted[c]
}
// Safety: identical syntax is treated identically across standard/custom locations.
assert rae_citation_directory_is_not_policy {
  all a, b : RAECitation | a.wholeToken = b.wholeToken and
    a.relativeSyntax = b.relativeSyntax and a.traversal = b.traversal and
    a.controlCharacters = b.controlCharacters and a.visible = b.visible and
    a.artifactReference = b.artifactReference implies
      (rae_citation_admitted[a] iff rae_citation_admitted[b])
}
```

### Requirement: Verify Production Lifecycle Coordination [RAE-LIFECYCLE-PRODUCTION]
WHEN generating verification evidence for optional-report persistence, THE verification harness SHALL execute the same coordinator used by production orchestration with injected effects and SHALL compare independent effect observations and failure histories to the reference lifecycle model.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Review-Correction-Contracts`

#### Scenario: Reconcile Effect Failure Histories [RAE-LIFECYCLE-EFFECTS]
WHEN generated histories cover report success, generation/validation failure, and cleanup/marker/summary/manifest failures, THE verification harness SHALL compare actual coordinator transitions and independently stored report/summary/manifest bytes to the model, including preservation of the preexisting core bundle before marker invalidation.

##### Evidence
- Implementation: [final-report-lifecycle.ts:65 coordinateFinalReportLifecycle()](/src/cli/final-report-lifecycle.ts#L65), [run-cli.ts:553 runReportingPhase()](/src/cli/run-cli.ts#L553)
- Test (property): [final-report.property.test.ts:85 executes production coordination against independent filesystem observations and reference histories](/test/property/final-report.property.test.ts#L85)

#### Requirement model

```alloy
// --- Production-coordinator conformance evidence ---
// Effects/Frames: none; observations compare real effects with the reference model.
// Tests execute production coordination, inject faults, and independently hash bytes.
pred rae_history_verified[h : RAEHistoryObservation] {
  // Guards: completed core bundle, production executor and independent observations.
  h.initialCoreComplete = True
  h.productionCoordinator = True
  h.independentEffects = True
  h.orderedEffects = True
  h.hashesMatch = True
  // Postconditions: terminal facts agree; pre-invalidation core bytes survive.
  h.observedStage = h.referenceStage
  h.referenceStage in ReportAvailable + WarningPersisted + OutputFailed
  h.markerInvalidated = False implies {
    h.coreBundlePreserved = True
    h.manifestPresent = True
  }
  h.referenceStage = ReportAvailable implies no h.failure
  h.referenceStage = WarningPersisted implies h.failure in handledFinalFailures and one h.failure
  h.referenceStage = OutputFailed implies
    h.failure in outputFinalFailures - StartupCleanupFailed and one h.failure
  h.referenceStage in ReportAvailable + WarningPersisted implies h.manifestPresent = True
  h.referenceStage = OutputFailed and h.markerInvalidated = True implies h.manifestPresent = False
}
// Safety: model agreement without production execution/independent effects is insufficient.
assert rae_model_only_history_is_not_evidence {
  all h : RAEHistoryObservation | h.productionCoordinator = False or
    h.independentEffects = False or h.hashesMatch = False or
    h.observedStage != h.referenceStage implies not rae_history_verified[h]
}
// Safety: output failure cannot resurrect an invalidated completion marker.
assert rae_observed_output_failure_keeps_marker_absent {
  all h : RAEHistoryObservation | rae_history_verified[h] and
    h.observedStage = OutputFailed and h.markerInvalidated = True implies
      h.manifestPresent = False
}
// Safety: failure before marker invalidation preserves the completed core bundle.
assert rae_pre_invalidation_failure_preserves_bundle {
  all h : RAEHistoryObservation | rae_history_verified[h] and
    h.markerInvalidated = False implies
      h.coreBundlePreserved = True and h.manifestPresent = True
}
// Liveness remains in final_report_fairness/attempted_report_eventually_terminates;
// conformance observations add neither scheduling assumptions nor lifecycle ticks.
```

### System model: State machine and invariant checks

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
  frame_final_state
  frame_metrics
  all f : OutputFile | f.pathState' = f.pathState
}

// Shared complete frames for the extended Run state. These are used by every
// event that does not own the post-completion lifecycle or metrics snapshot.
pred frame_final_state {
  Run.finalStage' = Run.finalStage
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.finalFailure' = Run.finalFailure
  Run.agentInvoked' = Run.agentInvoked
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
}

pred frame_metrics {
  Run.metricsPresent' = Run.metricsPresent
  Run.metricsChecksummed' = Run.metricsChecksummed
  Run.metricsListed' = Run.metricsListed
  Run.reportsAtomicallyComplete' = Run.reportsAtomicallyComplete
}

pred frame_core_state {
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  Run.coreComplete' = Run.coreComplete
}

pred frame_core_except_manifest {
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  Run.coreComplete' = Run.coreComplete
}

pred frame_core_and_final_files {
  frame_core_state
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  frame_metrics
  all f : OutputFile | f.pathState' = f.pathState
}

pred frame_final_observations {
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.staleManifestPresent' = Run.staleManifestPresent
  Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent
  frame_metrics
}

// --- Catalog construction events (RAE-CATALOG-ERROR) ---

// Catalog construction succeeds: at least one active document survived.
pred construct_catalog {
  // Guard: catalog not yet decided
  Run.catalog = CatalogPending
  Run.failed = False
  Run.finalStage = CoreReporting
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
  frame_final_state
  frame_metrics
  all f : OutputFile | f.pathState' = f.pathState
}

// Catalog construction aborts: no active document survived. The run fails with
// a CatalogError classified by one of the three empty reasons, and NO
// downstream reports are ever produced (RAE-REPORT-CATALOG).
pred abort_catalog [r : CatalogEmptyReason] {
  // Guard: catalog not yet decided, nothing produced yet
  Run.catalog = CatalogPending
  Run.finalStage = CoreReporting
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
  frame_final_state
  frame_metrics
  all f : OutputFile | f.pathState' = f.pathState
}

pred write_summary {
  // Guard: all enabled phases completed
  enabledPhases in Run.completedPhases
  Run.failed = False
  Run.finalStage = CoreReporting
  R_Summary not in Run.reports
  // Effect: summary report added
  Run.reports' = Run.reports + R_Summary
  Run.reportsAtomicallyComplete' = Run.reportsAtomicallyComplete
  // Frame
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  frame_final_state
  Run.metricsPresent' = Run.metricsPresent
  Run.metricsChecksummed' = Run.metricsChecksummed
  Run.metricsListed' = Run.metricsListed
  all f : OutputFile | f.pathState' = f.pathState
}

pred finalize_core_reports {
  requiredReports in Run.reports
  Run.failed = False
  Run.finalStage = CoreReporting
  Run.reportsAtomicallyComplete = False
  Run.reportsAtomicallyComplete' = True
  Run.completedPhases' = Run.completedPhases
  Run.findings' = Run.findings
  Run.reports' = Run.reports
  Run.manifestPresent' = Run.manifestPresent
  Run.manifestFiles' = Run.manifestFiles
  Run.failed' = Run.failed
  Run.catalog' = Run.catalog
  Run.catalogReason' = Run.catalogReason
  frame_final_state
  Run.metricsPresent' = Run.metricsPresent
  Run.metricsChecksummed' = Run.metricsChecksummed
  Run.metricsListed' = Run.metricsListed
  all f : OutputFile | f.pathState' = FinalComplete
}

pred init_state {
  Run.catalog = CatalogPending
  no Run.catalogReason
  no Run.completedPhases
  no Run.findings
  no Run.reports
  Run.manifestPresent = False
  no Run.manifestFiles
  no Run.manifestAttemptSets
  Run.failed = False
  Run.finalStage = Preparing
  Run.coreComplete = False
  Run.reportPresent = False
  Run.reportValid = False
  Run.warningPresent = False
  Run.summaryCurrent = False
  no Run.finalFailure
  Run.agentInvoked = False
  // Prior-run residue is unconstrained at state 0; cleanup invalidates/removes it.
  Run.metricsPresent = False
  Run.metricsChecksummed = False
  Run.metricsListed = False
  Run.reportsAtomicallyComplete = False
  ReportReadBack.readStage = MetadataPending
  all f : OutputFile | f.pathState = Absent
  all a : AttemptSet | a.finalized = False
}

fact transitions {
  init_state and always (
    // Run-start managed-output cleanup and stale-marker invalidation
    begin_startup_cleanup
    or startup_cleanup_succeeds
    or final_output_fails[StartupCleanupFailed]
    // Catalog construction (must precede any phase)
    or construct_catalog
    or (some r : CatalogEmptyReason | abort_catalog[r])
    // Phase execution
    or (some p : Phase | complete_phase[p])
    // Findings emission (admissibility-gated)
    or (some f : Finding | emit_finding[f])
    or (some w, d : Finding | suppress_unsupported_verdict[w, d])
    or (some o, s : Finding | supersede_finding[o, s])
    // Summary generation
    or write_summary
    or finalize_core_reports
    // Manifest
    or write_manifest
    or remove_stale_manifest
    // Optional post-completion final report
    or start_final_report
    or reject_unsafe_path
    or reject_unadmitted_agent_or_prompt
    or generation_returns
    or (some k : generationFinalFailures | generation_fails[k])
    or publish_candidate
    or inspect_report_metadata
    or read_report_content
    or validation_succeeds
    or (some k : validationFinalFailures | validation_fails[k])
    or cleanup_succeeds
    or persist_final_report_warning
    or invalidate_warning_manifest
    or rewrite_warning_summary
    or begin_manifest_refresh
    or manifest_refresh_succeeds
    or (some k : outputFinalFailures | final_output_fails[k])
    // Opt-in core metrics snapshot
    or write_metrics
    // Failure
    or run_fails
    // File operations
    or (some f : OutputFile | atomic_write_success[f])
    or (some f : OutputFile | atomic_write_interrupt[f])
    // Formalization attempt-set evidence finalization (RAE-FORMAL-ATTEMPT-SETS)
    or (some a : AttemptSet | finalize_attempt_set[a])
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
    Run.catalogReason' = Run.catalogReason and
    Run.finalStage' = Run.finalStage and
    Run.coreComplete' = Run.coreComplete and
    Run.reportPresent' = Run.reportPresent and
    Run.reportValid' = Run.reportValid and
    Run.warningPresent' = Run.warningPresent and
    Run.summaryCurrent' = Run.summaryCurrent and
    Run.finalFailure' = Run.finalFailure and
    Run.agentInvoked' = Run.agentInvoked and
    Run.staleManifestPresent' = Run.staleManifestPresent and
    Run.staleManagedOutputPresent' = Run.staleManagedOutputPresent and
    Run.metricsPresent' = Run.metricsPresent and
    Run.metricsChecksummed' = Run.metricsChecksummed and
    Run.metricsListed' = Run.metricsListed))
}

// Only trusted final-report publication and cleanup own the designated path.
fact non_final_report_events_frame_destination {
  always ((not startup_cleanup_succeeds and not publish_candidate
      and not cleanup_succeeds and not persist_final_report_warning) implies
    FinalReportDestination.reportPathState' = FinalReportDestination.reportPathState)
}

fact non_readback_events_frame_read_stage {
  always ((not inspect_report_metadata and not read_report_content) implies
    ReportReadBack.readStage' = ReportReadBack.readStage)
}

fact non_report_completion_events_frame_atomic_completion {
  always ((not (some p : Phase | complete_phase[p]) and not finalize_core_reports) implies
    Run.reportsAtomicallyComplete' = Run.reportsAtomicallyComplete)
}

// Manifest attempt evidence changes only with marker publication/invalidation.
fact non_manifest_events_frame_attempt_inventory {
  always ((not write_manifest and not invalidate_warning_manifest
      and not manifest_refresh_succeeds) implies
    Run.manifestAttemptSets' = Run.manifestAttemptSets)
}

// --- Liveness: a healthy run reaches manifest completion (RAE-MANIFEST-DONE) ---

// The progress-enabling events for the main (non-failing) pipeline. Per-event
// weak fairness on each of these excludes runs that stall forever while a step
// is continuously enabled, which is what makes the eventual-completion claim
// non-vacuous (see Pitfall 4: liveness without fairness). Fairness must be
// stated per event -- fairness on the mere disjunction can be discharged by a
// different event firing, leaving the pending one starved.
pred pipeline_fairness {
  ((eventually always construct_catalog_enabled) implies (always eventually construct_catalog))
  and (all p : Phase |
    (eventually always complete_phase_enabled[p]) implies (always eventually complete_phase[p]))
  and ((eventually always write_summary_enabled) implies (always eventually write_summary))
  and ((eventually always finalize_core_reports_enabled) implies
    (always eventually finalize_core_reports))
  and ((eventually always write_metrics_enabled) implies (always eventually write_metrics))
  and ((eventually always write_manifest_enabled) implies (always eventually write_manifest))
}

// Enabling guards (the guard portion of each event), used by the fairness
// premises above so a continuously-enabled step must eventually be taken.
pred construct_catalog_enabled {
  Run.catalog = CatalogPending and Run.failed = False and Run.finalStage = CoreReporting
}
pred complete_phase_enabled [p : Phase] {
  p not in Run.completedPhases and p in enabledPhases
  and Run.catalog = CatalogConstructed and Run.failed = False
  and Run.finalStage = CoreReporting
  and Run.manifestPresent = False
}
pred write_summary_enabled {
  enabledPhases in Run.completedPhases and Run.failed = False
  and Run.finalStage = CoreReporting
  and R_Summary not in Run.reports
}
pred write_manifest_enabled {
  requiredReports in Run.reports and Run.failed = False
  and Run.finalStage = CoreReporting
  and Run.reportsAtomicallyComplete = True
  and (Run.telemetryEnabled = False or
    (Run.metricsPresent = True and Run.metricsChecksummed = True and Run.metricsListed = False))
}
pred finalize_core_reports_enabled {
  requiredReports in Run.reports and Run.failed = False
  and Run.finalStage = CoreReporting
  and Run.reportsAtomicallyComplete = False
}
pred write_metrics_enabled {
  Run.telemetryEnabled = True and requiredReports in Run.reports
  and Run.metricsPresent = False and Run.finalStage = CoreReporting
}

// Liveness: under fairness, a run whose catalog is successfully constructed and
// that never fails and never re-arms a stale manifest eventually writes the
// completion manifest listing every required report. This is the good-thing-
// eventually-happens counterpart to the manifest safety properties.
assert healthy_run_eventually_completes {
  (pipeline_fairness
    and eventually (Run.finalStage = CoreReporting)
    and eventually (Run.catalog = CatalogConstructed)
    and always (Run.failed = False)
    and always (Run.manifestPresent = True implies always Run.manifestPresent = True))
  implies eventually (Run.manifestPresent = True)
}

// Liveness: once every required report is written on a run that stays healthy,
// fairness guarantees the manifest is eventually produced (no permanent stall
// just short of completion). The always-healthy premise is required because a
// run may still fail from the reports-done state, which permanently disables
// manifest writing.
assert reports_done_leads_to_manifest {
  (pipeline_fairness and always Run.failed = False) implies
    always (
      (requiredReports in Run.reports and Run.manifestPresent = False
        and Run.finalStage = CoreReporting
        and Run.reportsAtomicallyComplete = True
        and (Run.telemetryEnabled = False or
          (Run.metricsPresent = True and Run.metricsChecksummed = True and Run.metricsListed = False)))
      implies eventually Run.manifestPresent = True)
}

// --- Commands ---

run show {} for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 2 WriteAttempt, 2 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 8 steps

run scenario_base_mode_complete {
  eventually (Run.manifestPresent = True and Run.mode = BaseMode)
} for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 13 steps

run scenario_failure_no_manifest {
  eventually (Run.failed = True and Run.manifestPresent = False)
} for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 6 steps

check findings_never_decrease for 4 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 2 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 15 steps expect 0

check all_findings_wellformed for 4 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

check evidence_always_preserved for 4 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

check manifest_implies_complete for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0

check no_manifest_on_failure for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

check no_write_outside_boundary for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 3 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 5 steps expect 0

check no_partial_at_final_path for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 3 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

check disabled_phases_no_reports for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

check phases_monotonic for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

// Report emission (RAE-EMIT-REPORTS)
check base_mode_reports for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0

check source_mode_reports for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 14 steps expect 0

// Naming convention (RAE-REPORT-NAMES)
check naming_injective for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check naming_total_for_phases for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

// Evidence preservation (RAE-PRESERVE-EVID)
check provenance_always_present for 4 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

check no_unsupported_verdicts_in_output for 4 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

// Finding shape (RAE-FINDING-SHAPE)
check no_malformed_findings for 4 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

// Atomic manifest ordering (RAE-ATOMIC-MANIFEST)
check manifest_written_last for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0

check stale_manifest_blocks_phases for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

check manifest_lists_all_reports for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0

// Pipeline liveness: a healthy run eventually completes with a manifest (RAE-MANIFEST-DONE)
check healthy_run_eventually_completes for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 14 steps expect 0

check reports_done_leads_to_manifest for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 14 steps expect 0

// Manifest schema (RAE-MANIFEST-SCHEMA)
check manifest_entries_match_files for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0

check manifest_checksums_valid for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0

// Output confinement (RAE-OUTPUT-CONFINE)
check all_writes_confined for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 3 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 5 steps expect 0

// Atomic output writes (RAE-OUTPUT-ATOMIC)
check successful_writes_complete for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 3 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

// Catalog-error classification, exit codes, and report suppression (RAE-CATALOG-ERROR)
check classify_empty_iff_no_active for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check classify_total_when_empty for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check classify_matches_precedence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check only_archived_recommends_allow_archive for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check exit_codes_match_spec for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps, 5 Int expect 0

check catalog_abort_no_reports for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

check catalog_abort_is_failure for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

check phases_require_catalog for 3 Finding, 2 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0

check catalog_abort_surfaces_error_code for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

run scenario_catalog_abort {
  eventually (Run.catalog = CatalogAborted and some Run.catalogReason)
} for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 8 steps

run scenario_classify_all_reasons {
  some a1, r1, x1, a2, r2, x2, a3, r3, x3 : Bool |
    classify[a1, r1, x1] = NoRecognizedDocs and
    classify[a2, r2, x2] = AllArchived and
    classify[a3, r3, x3] = AllFiltered
} for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps

// Findings emission events: suppression and supersession (RAE-EVID-FAIL, RAE-IMMUT-CHANGE)
check suppression_emits_defect for 4 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

check supersede_preserves_original for 4 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps expect 0

run scenario_suppress_unsupported {
  eventually (some w, d : Finding | suppress_unsupported_verdict[w, d])
} for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 8 steps

run scenario_supersede {
  eventually (some o, s : Finding | supersede_finding[o, s])
} for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 10 steps

// Logic-defect finding taxonomy: evidence roles + error severity (RAE-SHAPE-MERGE-CONFLICT-EVIDENCE)
check every_logic_kind_requires_evidence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check merge_core_evidence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check kind_specific_evidence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check invalid_group_identity_evidence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check logic_kinds_distinct_evidence for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check logic_roles_all_used for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check logic_defects_are_error for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

run scenario_logic_defect_taxonomy {
  ExclusionTuple in requiredRoles[FunctionSignatureConflict]
  BothSorts in requiredRoles[VariableSortConflict]
  BothDeclKinds in requiredRoles[SymbolKindCollision]
  SharedSanitizedId in requiredRoles[SanitizedIdCollision]
} for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps

// Catalog-empty diagnostics stay as reviewable as findings (RAE-SHAPE-CATALOG)
check catalog_diagnostics_actionable for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

run scenario_catalog_diagnostic_actionable {
  all r : CatalogEmptyReason |
    some catalogCause[r] and some catalogRemediation[r]
} for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps

// Code-derived gen artifacts (RAE-REPORT-GENSPECS)
check genspecs_present_when_code_backwards for 2 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0

check genspecs_paired for 2 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0

check genspecs_only_in_source_mode for 3 Finding, 2 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0

run scenario_genspecs_emitted {
  Run.mode = SourceBackedMode
  eventually (CodeCompare in Run.completedPhases
    and genArtifactsPresent = GenSpecsDir + GenSpecsSmtDir)
} for 2 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 8 steps

// Skipped-scope explanation (RAE-REPORT-SKIP)
check enabled_and_skipped_partition for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check base_mode_skips_source_phases for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

run scenario_skip_explained {
  Run.mode = BaseMode
  skippedPhases = sourcePhases and some skippedPhases
} for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps

// Source-specific evidence + inert rendering (RAE-EVID-ARTS/CROSSIMPLY/LLM, RAE-EVID-RENDER-SAFE)
check evidence_source_requirements for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

check render_evidence_inert for 1 Finding, 1 Evidence, 1 Provenance,
  1 Artifact, 1 Heading, 8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0

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
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps

// Optional final-report lifecycle witnesses and checks (RAE-FINAL-*).
run scenario_final_report_success {
  Run.telemetryEnabled = False
  Run.mode = BaseMode
  eventually Run.finalStage = ReportAvailable
} for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 22 steps expect 1

run scenario_final_report_warning {
  Run.telemetryEnabled = False
  Run.mode = BaseMode
  eventually Run.finalStage = WarningPersisted
} for 4 Finding, 4 Evidence, 4 Provenance, 4 Artifact, 4 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 27 steps expect 1

run scenario_final_report_output_failure {
  eventually Run.finalStage = OutputFailed
} for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 1

check valid_report_postcondition for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check final_report_terminal_states_stutter for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check final_report_starts_after_core_completion for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check core_completion_monotonic_after_attempt for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check handled_failure_preserves_core for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check unsafe_paths_prevent_agent_or_validation for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 16 steps expect 0
check report_success_requires_path_agreement for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check agent_policy_is_read_only for 2 Finding, 2 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0
check denied_agent_action_cannot_publish for 2 Finding, 2 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0
check accepted_bundle_has_prompt_parity for 2 Finding, 2 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0
check validating_requires_strict_protocol for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check malformed_protocol_never_validates for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check report_available_requires_candidate_valid for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check invalid_objects_never_succeed for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check oversized_report_rejected_before_content_read for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check validating_has_classified_outcome for 2 Finding, 2 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0
check published_candidate_has_classified_outcome for 2 Finding, 2 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0
check marker_invalidated_before_managed_cleanup for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0
check startup_cleanup_establishes_report_absence for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0
run scenario_stale_report_removed {
  FinalReportDestination.reportPathState = FinalComplete
  eventually (Run.finalStage = CoreReporting
    and FinalReportDestination.reportPathState = Absent)
} for 2 Finding, 2 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 5 steps expect 1
check handled_failure_has_no_report_residue for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check warning_terminal_postcondition for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check refresh_window_has_no_stale_manifest for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check final_outcomes_are_exclusive for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check completed_core_eventually_attempts_report for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check attempted_report_eventually_terminates for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0
check completed_core_has_enabled_report_action for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0
check startup_cleanup_eventually_terminates for 1 Finding, 1 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 12 steps expect 0
check attempt_evidence_finalizes_before_core_completion for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 2 AttemptSet, 2 Capability, 2 Ordinal, 20 steps expect 0
check manifest_lists_all_finalized_attempt_sets for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 2 AttemptSet, 2 Capability, 2 Ordinal, 20 steps expect 0
check manifest_entries_cover_attempt_sets_and_metrics for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  11 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 2 AttemptSet, 2 Capability, 2 Ordinal, 20 steps expect 0
run scenario_cleanup_failure {
  eventually Run.finalFailure = CleanupFailed
} for 4 Finding, 4 Evidence, 3 Provenance, 3 Artifact, 3 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 26 steps expect 1
run scenario_warning_persistence_failure {
  eventually Run.finalFailure = WarningPersistenceFailed
} for 4 Finding, 4 Evidence, 3 Provenance, 3 Artifact, 3 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 28 steps expect 1
run scenario_marker_invalidation_failure {
  eventually Run.finalFailure = MarkerInvalidationFailed
} for 4 Finding, 4 Evidence, 3 Provenance, 3 Artifact, 3 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 29 steps expect 1
run scenario_summary_rewrite_failure {
  eventually Run.finalFailure = SummaryRewriteFailed
} for 4 Finding, 4 Evidence, 3 Provenance, 3 Artifact, 3 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 31 steps expect 1
run scenario_manifest_refresh_failure {
  eventually Run.finalFailure = ManifestRefreshFailed
} for 4 Finding, 4 Evidence, 3 Provenance, 3 Artifact, 3 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 33 steps expect 1

// Opt-in metrics safety checks (RAE-RUN-METRICS).
check metrics_opt_in_only for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 16 steps expect 0
check persisted_attempts_reconcile for 2 Finding, 2 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0
check retry_and_resource_inventory_reconcile for 2 Finding, 2 Evidence, 1 Provenance, 1 Artifact, 1 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 3 steps expect 0
check metrics_precede_completion_manifest for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 16 steps expect 0
check metrics_listing_matches_manifest_presence for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0
check final_report_does_not_mutate_metrics for 3 Finding, 3 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 0 AttemptSet, 0 Capability, 0 Ordinal, 20 steps expect 0

// Invocation-scoped evidence checks and witnesses (RAE-FORMAL-ATTEMPT-SETS).
check evidence_survives_failure_without_manifest for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 2 AttemptSet, 2 Capability, 2 Ordinal, 2 ClaimSetKind, 10 steps expect 0
check one_namespace_per_file for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 2 AttemptSet, 2 Capability, 2 Ordinal, 2 ClaimSetKind, 10 steps expect 0
check manifest_present_implies_run_succeeded for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 2 AttemptSet, 2 Capability, 2 Ordinal, 2 ClaimSetKind, 12 steps expect 0

// Non-vacuity: durable evidence can survive a failed run without a manifest.
run attempt_evidence_survives_failure {
  eventually (some a : AttemptSet | a.finalized = True and Run.failed = True and Run.manifestPresent = False)
} for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 2 AttemptSet, 2 Capability, 2 Ordinal, 2 ClaimSetKind, 10 steps expect 1

// Non-vacuity: both invocation namespaces are representable as distinct files.
run both_claimset_namespaces {
  some a1, a2 : AttemptSet |
    a1.claimSetKind = SpecsForward
    and a2.claimSetKind = GeneratedSpec and some a2.ordinal
} for 3 Finding, 2 Evidence, 2 Provenance, 2 Artifact, 2 Heading,
  8 ManifestEntry, 1 WriteAttempt, 1 OutputFile, 2 AttemptSet, 2 Capability, 2 Ordinal, 8 steps expect 1

// --- Compatibility boundary witnesses ---
// Static refinements use one state; original pipeline commands/scopes stay intact.

run rae_verified_v1_release {
  some e : RAEReleaseEvidence | rae_release_verified[e] and e.major = RAEV1
} for 1 but 1 steps expect 1
run rae_verified_v2_release {
  some e : RAEReleaseEvidence | rae_release_verified[e] and e.major = RAEV2
} for 1 but 1 steps expect 1
run rae_stream_with_unknown_event_and_incomplete_usage {
  some s : RAEStream | rae_stream_accepted[s] and not rae_usage_complete[s] and
    (some e : s.events | e.isText = False and e.isError = False)
} for 1 but 2 RAEEvent, 1 steps expect 1
run rae_legacy_metrics_without_major {
  some m : RAEMetricRecord | rae_metric_shape[m] and
    m.probe = False and m.historical = True and no m.storedMajor
} for 1 but 1 steps expect 1
run rae_new_metrics_with_major {
  some m : RAEMetricRecord | rae_metric_shape[m] and
    m.probe = False and m.historical = False and some m.storedMajor
} for 1 but 1 steps expect 1
run rae_probe_without_model_attempt {
  some m : RAEMetricRecord | rae_metric_shape[m] and m.probe = True
} for 1 but 1 steps expect 1
run rae_non_overflow_retry {
  rae_retry_allowed[False, True, True]
  rae_degradation_allowed[False, True]
} for 1 but 1 steps expect 1
run rae_explicit_collection_without_publication {
  some m : RAECollectionMode | rae_collection_contract[m] and
    m.explicitlyInjected = True and m.requestedAtStart = False
} for 1 but 1 steps expect 1
run rae_disabled_collection_despite_environment_change {
  some m : RAECollectionMode | rae_collection_contract[m] and
    m.requestedAtStart = False and m.explicitlyInjected = False and
    m.currentEnvironment = True
} for 1 but 1 steps expect 1
run rae_custom_directory_citation {
  some c : RAECitation | rae_citation_admitted[c] and c.customDirectory = True
} for 1 but 1 steps expect 1
run rae_observed_report_success {
  some h : RAEHistoryObservation | rae_history_verified[h] and
    h.observedStage = ReportAvailable
} for 1 but 1 steps expect 1
run rae_observed_handled_warning {
  some h : RAEHistoryObservation | rae_history_verified[h] and
    h.observedStage = WarningPersisted and h.markerInvalidated = True
} for 1 but 1 steps expect 1
run rae_observed_post_invalidation_failure {
  some h : RAEHistoryObservation | rae_history_verified[h] and
    h.observedStage = OutputFailed and h.markerInvalidated = True
} for 1 but 1 steps expect 1
run rae_observed_cleanup_failure_before_invalidation {
  some h : RAEHistoryObservation | rae_history_verified[h] and
    h.failure = CleanupFailed and h.markerInvalidated = False
} for 1 but 1 steps expect 1

// --- Compatibility safety checks ---

check rae_unverified_release_is_blocked for 1 but 1 steps expect 0
check rae_v2_requires_isolated_transport for 1 but 1 steps expect 0
check rae_text_requires_text_events for 1 but 3 RAEEvent, 1 steps expect 0
check rae_process_failure_overrides_text for 1 but 3 RAEEvent, 1 steps expect 0
check rae_invalid_transport_is_rejected for 1 but 3 RAEEvent, 1 steps expect 0
check rae_missing_usage_is_incomplete for 1 but 1 steps expect 0
check rae_new_attempt_metadata_matches_selection for 1 but 1 steps expect 0
check rae_probes_and_private_metadata_are_excluded for 1 but 1 steps expect 0
check rae_overflow_is_terminal for 1 but 1 steps expect 0
check rae_disabled_collection_has_no_work for 1 but 1 steps expect 0
check rae_requested_collection_is_enabled for 1 but 1 steps expect 0
check rae_injected_collection_remains_explicit for 1 but 1 steps expect 0
check rae_collection_mode_is_stable for 1 but 2 RAECollectionMode, 1 steps expect 0
check rae_unsafe_citation_is_rejected for 1 but 1 steps expect 0
check rae_citation_directory_is_not_policy for 1 but 2 RAECitation, 1 steps expect 0
check rae_model_only_history_is_not_evidence for 1 but 1 steps expect 0
check rae_observed_output_failure_keeps_marker_absent for 1 but 1 steps expect 0
check rae_pre_invalidation_failure_preserves_bundle for 1 but 1 steps expect 0
```
