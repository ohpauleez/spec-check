---
title: CatalogAndParse
---

## Purpose

Define the catalog, input resolution, and structured parsing behavior for the spec-check CLI: discovering relevant OpenSpec artifacts, resolving active capability state, parsing structured content, and producing deterministic structural findings with provenance.

```alloy
module CatalogAndParse
open util/boolean

// --- Pipeline domain vocabulary ---

sig InputPath {}             // A CLI positional input path (file or directory)

// OpenSpec artifacts discovered from input paths
sig Artifact {
  source : one InputPath,    // artifact file identity used for provenance
  providedBy : one InputPath,
  documentKind : one DocumentKind,
  explicitlyArchived : one Bool
}

abstract sig DocumentKind {}
one sig ProposalDoc, DesignDoc, SpecDoc, TaskDoc extends DocumentKind {}

// Subset of artifacts from archived change directories
sig ArchivedArtifact in Artifact {}

// Runtime config relevant to catalog admission policy
one sig Config {
  allowArchive : one Bool,
  timeoutMs : lone Int       // universal LLM timeout (absent = default)
}

// Capability grouping for active catalog resolution
sig Capability {
  finalized : set Artifact,  // finalized spec artifacts for this capability; eg: openspec/specs/<cap>/spec.md
  inDev : set Artifact       // in-development delta artifacts; eg: openspec/changes/.../specs/<cap>/spec.md
}

// Findings with source-file provenance and classification
sig Finding {
  sourceFile : one InputPath,
  kind : one FindingKind,
  location : lone SourceFragment,
  violatedRule : lone StructuralRule
}

abstract sig FindingKind {}
one sig StructuralViolation, ParseWarning, EarsWarning,
        IdentifierError, ParseErrorKind, DeltaConflict,
        DeltaHeadingWarning, PreSectionWarning extends FindingKind {}

// EARS pattern classification
abstract sig EarsType {}
one sig Ubiquitous, EventDriven, StateDriven,
        UnwantedBehavior, Complex, OptionalFeature extends EarsType {}

// Delta operation context assigned during parsing
abstract sig DeltaOperation {}
one sig DeltaBase, PreSection, DeltaAdded, DeltaModified,
        DeltaRemoved, DeltaRenamed extends DeltaOperation {}

// Empty catalog classification (exactly one reason when catalog is empty)
abstract sig EmptyCatalogReason {}
one sig NoRecognizedDocs, AllArchived, AllFiltered extends EmptyCatalogReason {}

// Parsed document: structured representation of an input file
sig ParsedDoc {
  source : one InputPath,
  hasHeadings : one Bool,
  hasUnmatched : one Bool,     // true if unparsed content lines exist
  isDelta : one Bool,          // true if this doc is a delta spec (not finalized)
  elements : set SourceElement,
  unmatched : set SourceFragment
}

// Parsed requirement within a document
sig Requirement {
  doc : one ParsedDoc,
  earsType : lone EarsType,       // classified if EARS; absent if non-EARS
  escapeHatch : one Bool,          // format justification present; not semantics
  deltaOp : one DeltaOperation,   // enclosing delta operation context
  parentReqId : lone Requirement, // identified enclosing requirement, if any
  at : one SourceElement,
  scenario : one Bool,
  identified : one Bool,
  observedForm : lone EarsType,
  modal : lone SourceModal,
  responseNegated : one Bool,
  grammarIssues : set SurfaceIssueKind,
  withinBound : one Bool,
  supportedAlternative : one Bool,
  declaredKinds : set KindDeclaration,
  fragments : set SourceFragment,
  clauses : set SourceClause,
  schemaDefects : set StructuralRule,
  schemaLocation : StructuralRule -> lone SourceFragment
}

// Ordered source observations are immutable. The lexer/property corpus must
// establish exact spelling, fence protection, byte bounds and source offsets.
// Alloy checks the consequences of those observations, not English correctness.
sig SourceElement {
  document : one ParsedDoc,
  prior : set SourceElement,
  exactOperation : lone DeltaOperation,
  fenced : one Bool
}
abstract sig SourceModal {}
one sig ShallModal, MustModal, ShouldModal, MayModal extends SourceModal {}
abstract sig SurfaceIssueKind {}
one sig DriverOrder, MissingCommaOrThen, EmptyClause, ModalCount,
  UnclosedContent, TrailingNormative, MayNotAmbiguous, UnsupportedGrammar,
  WhereDisabled, StatementLimit, UnsupportedRepresentation,
  MetadataAmbiguous, MissingExampleFields extends SurfaceIssueKind {}
abstract sig StructuralRule {}
one sig HeadingShapeRule, IdentifierRule, ScenarioPresenceRule,
  ReferencesRule, DeltaCompletenessRule extends StructuralRule {}
abstract sig FragmentRole {}
one sig StatementContent, ReferenceContent, JustificationContent,
  PostconditionContent, MetadataContent, FencedContent, EvidenceContent,
  SupplementaryContent, UnmatchedContent, InputContent, ExpectedContent,
  ForbiddenContent extends FragmentRole {}
sig SourceText {}
sig SourcePoint { file : one InputPath }
sig NormalizedPoint {}
sig SourceFragment {
  file : one InputPath,
  role : one FragmentRole,
  raw : one SourceText,
  start : one SourcePoint,
  end : one SourcePoint,
  normalizedOffsets : set NormalizedPoint,
  offsetMap : NormalizedPoint -> lone SourcePoint
}
abstract sig ClauseRole {}
one sig StateClause, TriggerClause, ConditionClause, FeatureClause,
  SubjectClause, ResponseClause extends ClauseRole {}
sig SourceClause {
  role : one ClauseRole,
  fragment : one SourceFragment, // containing statement; exact subranges are lexer observations
  priorClause : set SourceClause
}
abstract sig ScenarioDisposition {}
one sig RefinementForm, ExampleForm, ProhibitedExampleForm,
  UnknownScenarioForm extends ScenarioDisposition {}
sig KindDeclaration {
  value : one ScenarioDisposition,
  fragment : one SourceFragment
}

// External input/config observations make failure guards executable formulas.
abstract sig ConfigReadResult {}
one sig ConfigAbsent, ConfigValid, ConfigInvalidJson, ConfigBadShape,
  ConfigUnreadable extends ConfigReadResult {}
sig Setting {}
sig SettingValue {}
one sig Invocation {
  inputs : set InputPath,
  informational : one Bool,
  badFlag : one Bool,
  outputInsideSource : one Bool,
  timeoutValid : one Bool,
  configRead : one ConfigReadResult,
  cliSettings : Setting -> lone SettingValue,
  fileSettings : Setting -> lone SettingValue,
  defaults : Setting -> lone SettingValue,
  recognized : set Artifact,
  unreadable : set InputPath,
  selected : set Artifact,
  preflight : one OCPreflight
}
abstract sig FilterRationale {}
one sig ArchivePolicy, CapabilityPolicy extends FilterRationale {}

fact source_observation_shape {
  Invocation.preflight.informationalOnly = Invocation.informational
  all p : OCPreflight | p.opencodeProbe != p.z3Probe
  all c : Capability | {
    no c.finalized & c.inDev
    (c.finalized + c.inDev).documentKind in SpecDoc
  }
  all disj a, b : Capability | no (a.finalized + a.inDev) & (b.finalized + b.inDev)
  all d : ParsedDoc | d.elements = document.d
  all e : SourceElement | {
    e.prior in e.document.elements
    e not in e.prior
    e.prior.prior in e.prior
    e.exactOperation in DeltaAdded + DeltaModified + DeltaRemoved + DeltaRenamed
  }
  all d : ParsedDoc | all disj a, b : d.elements |
    a in b.prior or b in a.prior
  // Requirement/scenario headings cannot also be exact level-two delta headings.
  all r : Requirement | r.at.document = r.doc and r.at.fenced = False and
    no r.at.exactOperation
  // Exact violated heading/line ranges are source observations, not invented
  // positions. Each schema defect has one retained original-source location.
  all r : Requirement | {
    r.schemaDefects = (r.schemaLocation).SourceFragment
    (r.schemaLocation)[StructuralRule] in r.fragments
  }
  all disj a, b : Requirement | a.at != b.at
  // Retained fields belong to one source item, including scenario postconditions.
  all disj a, b : Requirement | no a.fragments & b.fragments
  all f : SourceFragment | f.start.file = f.file and f.end.file = f.file and
    f.offsetMap[NormalizedPoint].file in f.file and
    (f.offsetMap).SourcePoint in f.normalizedOffsets
  all d : ParsedDoc | d.unmatched.file in d.source and
    (d.hasUnmatched = True iff some d.unmatched)
  all a : Invocation.recognized | a.providedBy in Invocation.inputs
}

// Pipeline phases in execution order
abstract sig Phase {}
one sig CliValidate, ConfigLoad, Discover, DependencyCheck,
        Parse, StructValidate, Emit extends Phase {}

// Phase ordering: immediate successor relation
fun phase_order : Phase -> Phase {
  CliValidate -> ConfigLoad +
  ConfigLoad -> Discover +
  Discover -> DependencyCheck +
  DependencyCheck -> Parse +
  Parse -> StructValidate +
  StructValidate -> Emit
}

// External dependencies required by specific analysis modes
abstract sig Dependency {}
one sig OpencodeDep, Z3Dep extends Dependency {}

// Command outcomes (semantic, not exit codes)
abstract sig Outcome {}
one sig CmdSuccess, InputError, ConfigError, DependencyError,
        EmptyCatalogError extends Outcome {}

// --- Mutable pipeline state ---

one sig RunState {
  var completedPhases : set Phase,           // phases that completed successfully
  var findings : set Finding,                // accumulating findings with provenance
  var catalog : set Artifact,                // all discovered artifacts
  var activeCatalog : set Artifact,          // active subset after resolution
  var parsedDocs : set ParsedDoc,            // successfully parsed documents
  var lastOutcome : lone Outcome,            // most recent outcome
  var emptyCatalogReason : lone EmptyCatalogReason  // set when catalog is empty
}

// --- OpenCode and Z3 boundary vocabulary ---
// Immutable observations refine the existing atomic dependency phase.
// No additional ingestion state, global facts, or temporal steps are required.

abstract sig OCMajor {}
one sig OCMajor1, OCMajor2, OCOtherMajor extends OCMajor {}
abstract sig OCDetectionCause {}
one sig OCSpawnError, OCTimeout, OCOutputLimit, OCInvalidVersion,
  OCUnsupportedMajor extends OCDetectionCause {}
sig OCText {}

// External observations: tests establish UTF-8, grammar and process outcomes.
sig OCProbe {
  command : one InputPath,
  owner : lone OCRun,
  spawnError : one Bool, // includes ENOENT, EACCES/EPERM and other spawn failures
  zeroExit : one Bool,
  signalled : one Bool,
  timedOut : one Bool,
  overflow : one Bool, // combined stdout/stderr capture
  strictUtf8 : one Bool,
  grammarValid : one Bool,
  canonicalVersion : one OCText, // complete version, not its bounded preview
  reportedMajor : one OCMajor
}

sig OCPreflight {
  opencodeProbe : one OCProbe,
  z3Probe : one OCProbe,
  informationalOnly : one Bool,
  effectiveModelValid : one Bool,
  cleanupComplete : one Bool,
  needsZ3 : one Bool
}
abstract sig OCExit {}
one sig OCExit0, OCExit3, OCExit4 extends OCExit {}

// Runtime identity preserves binary/version evidence, not executable bytes.
sig OCRun { runtime : one OCRuntime }
sig OCRuntime { owner : one OCRun, evidence : one OCProbe }
sig OCCall {
  owner : one OCRun,
  explicitRuntime : lone OCRuntime,
  scopedRuntime : lone OCRuntime,
  detectedRuntime : one OCRuntime, // potential fallback; unused with a descriptor
  selectedBinary : lone InputPath,
  model : one OCModel,
  requestShapeValid : one Bool,
  prompt : one OCText,
  files : set InputPath
}
abstract sig OCCallError {}
one sig OCInvalidModel, OCInvalidRequest, OCRuntimeMismatch,
  OCRuntimeDetectionFailure extends OCCallError {}

// Lexer outputs preserve case and additional model '/' characters.
abstract sig OCModelClass {}
// Models with the same fixed variant share a policy class (Terra and Sol are both high).
one sig OCLuna, OCHighPolicyModel, OCOtherModel extends OCModelClass {}
sig OCVariant {}
one sig OCMax, OCHigh extends OCVariant {}
sig OCModel {
  base : one OCText,
  modelClass : one OCModelClass,
  explicitVariant : lone OCVariant,
  lexicalValid : one Bool
}
abstract sig OCVariantEncoding {}
one sig OCSeparateVariant, OCHashVariant, OCNoVariant extends OCVariantEncoding {}
sig OCAttempt { call : one OCCall }

// Local cleanup stages are values, not additional pipeline states.
abstract sig OCCleanupStage {}
one sig OCExecuting, OCStopRequested, OCSettled extends OCCleanupStage {}
sig OCCleanupInput {
  timedOut : one Bool,
  overflow : one Bool,
  parentExited : one Bool,
  ownedPipeHolder : one Bool,
  escapedPipeHolder : one Bool,
  posix : one Bool,
  cleanupCallbackDelivered : one Bool
}

// --- Boundary projections ---
// Effects/Frames: none; all functions derive values from immutable inputs.

// Postcondition: timeout, overflow, process, encoding and major failures have priority.
fun oc_detection_cause[p : OCProbe] : lone OCDetectionCause {
  p.timedOut = True => OCTimeout else
  (p.overflow = True => OCOutputLimit else
  (not oc_process_ok[p] => OCSpawnError else
  ((p.strictUtf8 = False or p.grammarValid = False) => OCInvalidVersion else
  (p.reportedMajor = OCOtherMajor => OCUnsupportedMajor else none))))
}

// Guard: ordinary valid input after cleanup. Postcondition: OpenCode precedes Z3.
fun oc_preflight_probes[p : OCPreflight] : set OCProbe {
  (p.informationalOnly = True or p.effectiveModelValid = False or
    p.cleanupComplete = False) => none else
      p.opencodeProbe +
        ((oc_version_ok[p.opencodeProbe] and p.needsZ3 = True) => p.z3Probe else none)
}

// Postcondition: informational success, model exit 3, or dependency exit 4.
fun oc_preflight_exit[p : OCPreflight] : lone OCExit {
  p.informationalOnly = True => OCExit0 else
  (p.effectiveModelValid = False => OCExit3 else
  (p.cleanupComplete = False => none else
  (oc_dependency_admitted[p] => OCExit0 else OCExit4)))
}

// Postcondition: explicit runtime precedes the scoped descriptor.
fun oc_supplied_runtime[c : OCCall] : lone OCRuntime {
  some c.explicitRuntime => c.explicitRuntime else c.scopedRuntime
}
// Postcondition: detection is a fallback only when no descriptor is supplied.
fun oc_proposed_runtime[c : OCCall] : one OCRuntime {
  some oc_supplied_runtime[c] => oc_supplied_runtime[c] else c.detectedRuntime
}
// Postcondition: model/request errors precede runtime mismatch/detection errors.
fun oc_call_error[c : OCCall] : lone OCCallError {
  not oc_model_valid[c.model] => OCInvalidModel else
  (c.requestShapeValid = False => OCInvalidRequest else
  (oc_runtime_mismatch[c] => OCRuntimeMismatch else
  (not oc_version_ok[oc_proposed_runtime[c].evidence] => OCRuntimeDetectionFailure else none)))
}
// Guard: valid request, no mismatch or descriptor. Postcondition: one direct probe.
fun oc_call_probes[c : OCCall] : set OCProbe {
  (oc_model_valid[c.model] and c.requestShapeValid = True and
    not oc_runtime_mismatch[c] and no oc_supplied_runtime[c]) =>
      c.detectedRuntime.evidence else none
}
// Postcondition: only error-free resolution yields a runtime.
fun oc_resolved_runtime[c : OCCall] : lone OCRuntime {
  no oc_call_error[c] => oc_proposed_runtime[c] else none
}

// Postcondition: fixed Luna/Terra/Sol variants; no forced variant for other models.
fun oc_fixed_variant[m : OCModel] : lone OCVariant {
  m.modelClass = OCLuna => OCMax else (m.modelClass = OCHighPolicyModel => OCHigh else none)
}
// Postcondition: preserve an explicit variant, otherwise apply the fixed policy.
fun oc_normalized_variant[m : OCModel] : lone OCVariant {
  some m.explicitVariant => m.explicitVariant else oc_fixed_variant[m]
}

// Guard: successful resolution. Postcondition: attempts belong to the same call.
fun oc_attempts_allowed[c : OCCall] : set OCAttempt {
  no oc_call_error[c] => call.c else none
}
// Postcondition: every attempt reuses the call's resolved runtime.
fun oc_attempt_runtime[a : OCAttempt] : lone OCRuntime { oc_resolved_runtime[a.call] }
// Postcondition: absent, separate v1 or combined v2 variant syntax.
fun oc_attempt_encoding[a : OCAttempt] : lone OCVariantEncoding {
  no oc_attempt_runtime[a] => none else
  (no oc_normalized_variant[a.call.model] => OCNoVariant else
  (oc_attempt_runtime[a].evidence.reportedMajor = OCMajor1 => OCSeparateVariant else OCHashVariant))
}
// Postcondition: invocation and telemetry share the normalized base and variant.
fun oc_attempt_base[a : OCAttempt] : one OCText { a.call.model.base }
fun oc_attempt_variant[a : OCAttempt] : lone OCVariant { oc_normalized_variant[a.call.model] }

// Guard: local stage and observed callbacks. Effect: derive the next local stage.
// Frame: inputs and RunState are unchanged. Postcondition: settlement is absorbing.
fun oc_cleanup_next[p : OCCleanupInput, s : OCCleanupStage] : one OCCleanupStage {
  s = OCSettled => OCSettled else
  (s = OCStopRequested =>
    (p.cleanupCallbackDelivered = True => OCSettled else OCStopRequested) else
    (oc_stop_required[p] => OCStopRequested else OCExecuting))
}
// Postcondition: settlement yields one terminal result, never another event.
fun oc_cleanup_result[s : OCCleanupStage] : lone OCCleanupStage { s & OCSettled }

// --- Conditional entity invariants ---
// Guards: the named contract is admitted. Effects/Frames: none (static predicates).
// These contracts are assertion premises, not global restrictions on ingestion.

pred oc_run_contract[r : OCRun] {
  // Postcondition: the run owns one supported descriptor and its probe evidence.
  r.runtime.owner = r
  r.runtime.evidence.owner = r
  oc_version_ok[r.runtime.evidence]
}

pred oc_call_contract[c : OCCall] {
  // Postcondition: descriptors are run-local; direct evidence matches the command.
  all r : c.explicitRuntime + c.scopedRuntime + c.detectedRuntime | r.owner = c.owner
  no oc_supplied_runtime[c] and some c.selectedBinary implies
    c.detectedRuntime.evidence.command = c.selectedBinary
}
```

## Requirements

### Requirement: Surface Catalog Empty Cause [CAT-CATALOG-EMPTY]
WHEN catalog construction completes with zero active documents, THE spec-check tool SHALL classify the empty result as exactly one of: no recognized OpenSpec documents, archived-only recognized documents, or all recognized documents excluded by policy.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`

#### Scenario: No Recognized Documents [CAT-EMPTY-NODOCS]
WHEN the provided input paths yield zero recognized proposal, design, or spec documents, THE spec-check tool SHALL classify the empty catalog result as `no_recognized_docs`.

**Postcondition:** The CLI can distinguish irrelevant or incorrect inputs from archive-policy filtering.

##### Evidence
- Implementation: [catalog.ts:222 classifyEmptyCatalogReason()](/src/domain/parser/catalog.ts#L222), [run-cli.ts:83 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L83)
- Test: [catalog.test.ts:101 returns no_recognized_docs for directories without OpenSpec docs](/test/contract/catalog.test.ts#L101), [cli.test.ts:184 formats no_recognized_docs with input count](/test/contract/cli.test.ts#L184)
- Test (integration): [catalog-abort.integration.test.ts:53 aborts pipeline on no_recognized_docs — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L53)

#### Scenario: Archived-Only Recognized Documents [CAT-EMPTY-ARCHIVE]
WHILE archived inputs are not explicitly allowed, WHEN all recognized documents are archived, THE spec-check tool SHALL classify the empty catalog result as `all_archived`.

**Postcondition:** The CLI can recommend `--allow-archive` as a remediation only when it is actually relevant.

##### Evidence
- Implementation: [catalog.ts:222 classifyEmptyCatalogReason()](/src/domain/parser/catalog.ts#L222), [run-cli.ts:83 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L83)
- Test: [catalog.test.ts:27 excludes archived change specs by default](/test/contract/catalog.test.ts#L27), [cli.test.ts:191 formats all_archived with archived count and --allow-archive guidance](/test/contract/cli.test.ts#L191)
- Test (integration): [catalog-abort.integration.test.ts:82 aborts pipeline on all_archived without --allow-archive — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L82)

#### Scenario: Policy-Excluded Recognized Documents [CAT-EMPTY-FILTERED]
IF recognized documents are present but another admission or filtering policy removes all of them from the active catalog, THEN THE spec-check tool SHALL classify the empty catalog result as `all_filtered` and SHALL preserve the filtering rationale.

**Postcondition:** Empty-catalog reporting remains extensible to future filtering policies without collapsing into a generic message.

##### Evidence
- Implementation: [catalog.ts:222 classifyEmptyCatalogReason()](/src/domain/parser/catalog.ts#L222), [run-cli.ts:83 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L83)
- Test: [catalog.test.ts:113 returns all_filtered when all recognized docs are excluded by capability resolution](/test/contract/catalog.test.ts#L113), [catalog.test.ts:134 reports correct filteredCount when inputs contain both archived and unresolvable docs](/test/contract/catalog.test.ts#L134), [cli.test.ts:198 formats all_filtered with count and filter reason](/test/contract/cli.test.ts#L198)
- Test (integration): [catalog-abort.integration.test.ts:111 aborts pipeline on all_filtered — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L111)

#### Requirement model

```alloy
// Preconditions: recognition and admission are complete; active is a subset.
// Postcondition: empty catalogs have one cause, with deterministic priority.
fun archive_excluded[recognized : set Artifact] : set Artifact {
  { a : recognized & ArchivedArtifact |
    Config.allowArchive = False or a.explicitlyArchived = False }
}
fun empty_cause[recognized, active : set Artifact] : lone EmptyCatalogReason {
  some active => none else
  (no recognized => NoRecognizedDocs else
  (recognized = archive_excluded[recognized] => AllArchived else AllFiltered))
}
fun filtering_rationale[recognized, active : set Artifact] : set FilterRationale {
  (some archive_excluded[recognized] => ArchivePolicy else none) +
  (some recognized - active - archive_excluded[recognized] => CapabilityPolicy else none)
}
// Safety: every empty catalog has one classified cause and filtering rationale.
assert empty_cause_is_total_and_preserves_rationale {
  all recognized, active : set Artifact | active in recognized implies {
    no active iff one empty_cause[recognized, active]
    empty_cause[recognized, active] = AllFiltered implies
      CapabilityPolicy in filtering_rationale[recognized, active]
  }
}
// Safety: --allow-archive guidance is applicable only to archive-excluded input.
assert archive_remediation_is_relevant {
  all recognized : set Artifact | empty_cause[recognized, none] = AllArchived implies
    some recognized and recognized = archive_excluded[recognized]
}
```

### Requirement: CLI Argument Validation [CAT-CLI-ARGS]
THE spec-check CLI SHALL accept positional input paths and optional `--output`, `--src`, `--caps`, `--z3`, `--config`, `--timeout-ms`, `--max-batch-size`, `--allow-archive`, `--help`, and `--version` flags, and SHALL reject unrecognized flags or missing required inputs with exit code `2` before any analysis begins.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Define archive activation as an explicit admission policy, not a discovery policy`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`

#### Scenario: Help Flag Prints Help And Exits [CAT-CLI-HELP]
WHEN the user invokes `spec-check --help` or `spec-check -h`, THE spec-check CLI SHALL print command overview and help information together with version information and exit with code `0` without running any analysis.

**Postcondition:** No output directory is created and no analysis phases run.

##### Evidence
- Implementation: [index.ts:42 main()](/src/index.ts#L42), [index.ts:164 printHelp()](/src/index.ts#L164)
- Test: [cli.test.ts:81 parses help and version flags](/test/contract/cli.test.ts#L81)
- Test (integration): [opencode-runtime.integration.test.ts:89 rejects unsupported dependencies with exit 4 and performs no analysis, while help/version never probe](/test/integration/opencode-runtime.integration.test.ts#L89)
- Example:
```typescript
const { parseArgv } = await import("./src/cli/parse-argv.ts");
const result = parseArgv(["--help"]); //=> type Object
result.ok; //=> true
result.value.help; //=> true
result.value.inputs.length; //=> 0
```

#### Scenario: Version Flag Prints Version And Exits [CAT-CLI-VERSION]
WHEN the user invokes `spec-check --version` or `spec-check -v`, THE spec-check CLI SHALL print the embedded version string and exit with code `0` without running any analysis.

**Postcondition:** No output directory is created and no analysis phases run.

##### Evidence
- Implementation: [index.ts:42 main()](/src/index.ts#L42), [version.ts:16 SPEC_CHECK_VERSION](/src/version.ts#L16)
- Test: [cli.test.ts:81 parses help and version flags](/test/contract/cli.test.ts#L81)
- Test (integration): [opencode-runtime.integration.test.ts:89 rejects unsupported dependencies with exit 4 and performs no analysis, while help/version never probe](/test/integration/opencode-runtime.integration.test.ts#L89)
- Example:
```typescript
const { parseArgv } = await import("./src/cli/parse-argv.ts");
const result = parseArgv(["--version"]); //=> type Object
result.ok; //=> true
result.value.version; //=> true
result.value.inputs.length; //=> 0
```

#### Scenario: Missing Input Paths Rejected [CAT-CLI-NOINPUT]
IF the user invokes `spec-check` with no positional input paths and no `--help` or `--version` flag, THEN THE spec-check CLI SHALL exit with code `2` and a diagnostic message naming the missing input.

**Postcondition:** No analysis output is produced.

##### Evidence
- Implementation: [config.ts:198 resolveRunConfig()](/src/cli/config.ts#L198), [index.ts:127 parseConfigError()](/src/index.ts#L127)
- Test: [cli.test.ts:67 resolveRunConfig rejects empty inputs with missing_inputs error](/test/contract/cli.test.ts#L67)

#### Scenario: Unrecognized Flag Rejected [CAT-CLI-BADFLAG]
IF the user supplies an unrecognized flag, THEN THE spec-check CLI SHALL exit with code `2` and a diagnostic message naming the unrecognized flag.

**Postcondition:** No analysis output is produced.

##### Evidence
- Implementation: [parse-argv.ts:135 parseArgv()](/src/cli/parse-argv.ts#L135), [index.ts:103 parseArgParseError()](/src/index.ts#L103)
- Test: [cli.test.ts:48 rejects unrecognized flags](/test/contract/cli.test.ts#L48)
- Example:
```typescript
const { parseArgv } = await import("./src/cli/parse-argv.ts");
const result = parseArgv(["--unknown"]); //=> type Object
result.ok; //=> false
result.error.kind; //=> unknown_flag
result.error.flag; //=> --unknown
```

#### Scenario: Flag Value With Equals Syntax Accepted [CAT-CLI-EQSYNTAX]
WHEN the user supplies a flag using `--flag=value` syntax, THE spec-check CLI SHALL accept the value as equivalent to `--flag value` syntax for all recognized value-bearing flags.

**Postcondition:** Both `--flag value` and `--flag=value` syntaxes are accepted interchangeably.

##### Evidence
- Implementation: [parse-argv.ts:135 parseArgv()](/src/cli/parse-argv.ts#L135)
- Test: [cli.test.ts:105 supports equals syntax for flag values](/test/contract/cli.test.ts#L105)
- Example:
```typescript
const { parseArgv } = await import("./src/cli/parse-argv.ts");
const result = parseArgv(["--output=my-dir", "--z3=/usr/bin/z3"]); //=> type Object
result.ok; //=> true
result.value.output; //=> my-dir
result.value.z3; //=> /usr/bin/z3
```

#### Scenario: Output Directory Inside Source Directory Rejected [CAT-CLI-OUTSRC]
IF the resolved `--output` directory is a descendant of or equal to the resolved `--src` directory, THEN THE spec-check CLI SHALL exit with code `2` and a diagnostic message explaining that the output directory must not reside within the source directory.

**Postcondition:** The read-only source guarantee and output confinement constraints cannot conflict.

##### Evidence
- Implementation: [config.ts:198 resolveRunConfig()](/src/cli/config.ts#L198)
- Test: [cli.test.ts:136 rejects output directory inside source directory](/test/contract/cli.test.ts#L136), [cli.test.ts:152 rejects output directory equal to source directory](/test/contract/cli.test.ts#L152), [cli.test.ts:168 accepts output directory outside source directory](/test/contract/cli.test.ts#L168)

#### Scenario: Timeout Flag Accepted [CAT-CLI-TIMEOUT]
WHEN the user supplies `--timeout-ms` with an integer value within the configured allowed range, THE spec-check CLI SHALL accept the value as the universal timeout for all external LLM calls in the run.

**Postcondition:** A single validated timeout policy is available to every LLM-backed phase.

##### Evidence
- Implementation: [config.ts:383 parseTimeoutMs()](/src/cli/config.ts#L383), [config.ts:415 validateTimeoutMs()](/src/cli/config.ts#L415)
- Test: [config.test.ts:26 uses CLI flags over config values](/test/contract/config.test.ts#L26), [config.test.ts:132 rejects timeout below minimum](/test/contract/config.test.ts#L132), [config.test.ts:147 rejects non-integer timeout](/test/contract/config.test.ts#L147), [config.test.ts:181 rejects timeout above maximum](/test/contract/config.test.ts#L181)
- Example:
```typescript
const { parseArgv } = await import("./src/cli/parse-argv.ts");
const result = parseArgv(["input/", "--timeout-ms", "60000"]); //=> type Object
result.ok; //=> true
result.value.timeoutMs; //=> 60000
```

#### Scenario: Config File Timeout Accepted [CAT-CLI-TIMEOUT-CONFIG]
WHEN the user supplies a JSON config file containing a valid numeric `timeoutMs` field and no CLI `--timeout-ms` override, THE spec-check CLI SHALL accept that value as the universal timeout for all external LLM calls in the run.

**Postcondition:** Runtime timeout policy can be sourced from either CLI or config file, with CLI taking precedence.

##### Evidence
- Implementation: [config.ts:198 resolveRunConfig()](/src/cli/config.ts#L198), [config.ts:383 parseTimeoutMs()](/src/cli/config.ts#L383)
- Test: [config.test.ts:162 accepts config file timeoutMs without CLI override](/test/contract/config.test.ts#L162)

#### Scenario: Archive Admission Flag Accepted [CAT-CLI-ALLOW-ARCH]
WHEN the user supplies `--allow-archive`, THE spec-check CLI SHALL enable admission of explicitly provided archived documents into the active catalog.

**Postcondition:** Archive admission changes only for explicitly provided archived inputs.

##### Evidence
- Implementation: [parse-argv.ts:135 parseArgv()](/src/cli/parse-argv.ts#L135), [config.ts:198 resolveRunConfig()](/src/cli/config.ts#L198)
- Test: [cli.test.ts:128 parses allow-archive as boolean flag](/test/contract/cli.test.ts#L128)
- Example:
```typescript
const { parseArgv } = await import("./src/cli/parse-argv.ts");
const result = parseArgv(["input/", "--allow-archive"]); //=> type Object
result.ok; //=> true
result.value.allowArchive; //=> true
```

#### Requirement model

```alloy
// --- CLI argument validation: pre-analysis guards ---
// Failure modes: unrecognized flag, missing input, output-inside-src, timeout out-of-range

pred cli_informational {
  Invocation.informational = True
  Invocation.badFlag = False
  // Guard: only from initial state (--help/-h or --version/-v), no prior outcome
  no RunState.completedPhases
  no RunState.lastOutcome
  // Effect: success, no analysis phases run, no findings produced
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = CmdSuccess
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred cli_rejected_missing_input {
  Invocation.informational = False
  no Invocation.inputs
  // Guard: only from initial state; no positional input paths, no help/version, no prior outcome
  no RunState.completedPhases
  no RunState.lastOutcome
  // Effect: InputError, no analysis
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = InputError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred cli_rejected_bad_flag {
  Invocation.badFlag = True
  // Guard: only from initial state; unrecognized CLI flag supplied, no prior outcome
  no RunState.completedPhases
  no RunState.lastOutcome
  // Effect: InputError, no analysis
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = InputError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred cli_rejected_output_inside_src {
  Invocation.informational = False
  Invocation.outputInsideSource = True
  // Guard: only from initial state; resolved --output is descendant of --src, no prior outcome
  no RunState.completedPhases
  no RunState.lastOutcome
  // Effect: InputError, no analysis
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = InputError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred cli_rejected_timeout_range {
  Invocation.informational = False
  Invocation.timeoutValid = False
  // Guard: only from initial state; --timeout-ms outside allowed range, no prior outcome
  no RunState.completedPhases
  no RunState.lastOutcome
  // Effect: InputError, no analysis
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = InputError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

// Composite: any CLI rejection
pred cli_rejected {
  cli_rejected_missing_input
  or cli_rejected_bad_flag
  or cli_rejected_output_inside_src
  or cli_rejected_timeout_range
}

// Lexer observations model value-bearing flags independently of wire spelling.
abstract sig FlagSyntax {}
one sig EqualsSyntax, SeparateSyntax extends FlagSyntax {}
sig FlagValue { setting : one Setting, value : one SettingValue, syntax : one FlagSyntax }
fun flag_binding[f : FlagValue] : Setting -> SettingValue { f.setting -> f.value }
// Safety: equal observed flag bindings are independent of their wire syntax.
// Lexer tests establish that equals/separate spellings yield these observations.
assert equals_syntax_equivalence {
  all a, b : FlagValue | a.setting = b.setting and a.value = b.value implies
    flag_binding[a] = flag_binding[b]
}

pred cli_validate_success {
  Invocation.informational = False
  Invocation.badFlag = False
  some Invocation.inputs
  Invocation.outputInsideSource = False
  Invocation.timeoutValid = True
  // Guard: at least one valid input path, recognized flags, output outside src,
  //        timeout in range (if provided), no prior outcome set
  no RunState.completedPhases
  no RunState.lastOutcome
  // Effect: CliValidate phase completed
  RunState.completedPhases' = RunState.completedPhases + CliValidate
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

// Safety: CLI rejection prevents all downstream analysis
assert cli_rejection_blocks_analysis {
  always (cli_rejected implies
    RunState.completedPhases' = RunState.completedPhases)
}

// Safety: informational commands (help, version) produce no analysis output
assert informational_no_analysis {
  always (cli_informational implies (
    RunState.completedPhases' = RunState.completedPhases and
    RunState.findings' = RunState.findings and
    RunState.catalog' = RunState.catalog))
}

// Safety: timeout rejection produces InputError (not ConfigError)
assert timeout_rejection_is_input_error {
  always (cli_rejected_timeout_range implies
    RunState.lastOutcome' = InputError)
}
```

### Requirement: Config Loading And Merge [CAT-CLI-CONFIG]
WHEN `--config` is provided, THE spec-check CLI SHALL load the JSON config file, validate its structure, and merge config values with CLI flags where CLI flags take precedence.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`

#### Scenario: Valid Config Merged [CAT-CONFIG-MERGE]
WHEN a valid config file is loaded and CLI flags are also present, THE spec-check CLI SHALL use CLI flag values over config file values for any overlapping settings.

**Postcondition:** The resolved run configuration reflects CLI precedence.

##### Evidence
- Implementation: [config.ts:198 resolveRunConfig()](/src/cli/config.ts#L198)
- Test: [config.test.ts:26 uses CLI flags over config values](/test/contract/config.test.ts#L26)

#### Scenario: Invalid Config Rejected [CAT-CONFIG-FAIL]
IF the `--config` file exists but contains invalid JSON or violates the expected config structure, THEN THE spec-check CLI SHALL exit with code `2` and a diagnostic message before any analysis begins.

**Postcondition:** No analysis output is produced from an invalid configuration.

##### Evidence
- Implementation: [config.ts:278 loadConfigFile()](/src/cli/config.ts#L278), [config.ts:328 isConfigFileShape()](/src/cli/config.ts#L328)
- Test: [config.test.ts:110 rejects invalid config JSON](/test/contract/config.test.ts#L110)

#### Requirement model

```alloy
// --- Config loading and merge ---
// Config merge is a pure function: CLI flags override config file values.
// Missing CLI/file values fall through to defaults; explicit values win.
// Failure modes: invalid JSON, violated config structure, unreadable config file.

pred config_load_success {
  Invocation.configRead in ConfigAbsent + ConfigValid
  Invocation.preflight.effectiveModelValid = True
  // Guard: CliValidate completed, no prior fatal outcome
  CliValidate in RunState.completedPhases
  ConfigLoad not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: ConfigLoad completed, CLI precedence applied
  RunState.completedPhases' = RunState.completedPhases + ConfigLoad
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred config_load_fail_invalid_json {
  Invocation.configRead in ConfigInvalidJson + ConfigUnreadable
  // Guard: CliValidate completed, config file contains invalid JSON, no prior outcome
  CliValidate in RunState.completedPhases
  ConfigLoad not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: ConfigError, pipeline stops (ConfigLoad NOT added to completed)
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = ConfigError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred config_load_fail_bad_structure {
  Invocation.configRead = ConfigBadShape
  // Guard: CliValidate completed, config JSON violates expected structure, no prior outcome
  CliValidate in RunState.completedPhases
  ConfigLoad not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: ConfigError, pipeline stops
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = ConfigError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

// Composite: any config failure
pred config_load_fail {
  config_load_fail_invalid_json or config_load_fail_bad_structure
}

// Safety: invalid config blocks all downstream phases
assert invalid_config_blocks_downstream {
  always (config_load_fail implies (
    Discover not in RunState.completedPhases' and
    Parse not in RunState.completedPhases'))
}

// Safety: config error is always ConfigError outcome, never InputError
assert config_failure_outcome {
  always (config_load_fail implies RunState.lastOutcome' = ConfigError)
}

fun resolved_settings : Setting -> SettingValue {
  Invocation.defaults ++ Invocation.fileSettings ++ Invocation.cliSettings
}
// Safety: explicit CLI values override overlapping file/default bindings.
assert cli_settings_take_precedence {
  all s : Setting | some s.(Invocation.cliSettings) implies
    s.resolved_settings = s.(Invocation.cliSettings)
}
// Safety: file values supply settings absent from the CLI.
assert file_settings_fill_missing_cli_values {
  all s : Setting | no s.(Invocation.cliSettings) and some s.(Invocation.fileSettings) implies
    s.resolved_settings = s.(Invocation.fileSettings)
}
```

### Requirement: Discover And Resolve Active Analysis Inputs [CAT-DISCOVER-INPUTS]
WHEN a developer runs `spec-check` with one or more input paths, THE spec-check tool SHALL discover the referenced OpenSpec artifacts, classify proposal, design, spec, and optional task inputs, resolve active capability state from current and in-development specs, and exclude archived change specs from downstream analysis unless the run explicitly allows archived inputs for those provided paths, and SHALL preserve the selected finalized and delta spec sources needed for later per-capability merge.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Define archive activation as an explicit admission policy, not a discovery policy`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Context`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Proposed Design`

#### Scenario: Resolve Active Capability Set [CAT-DISCOVER-ACTIVE]
WHEN the input set includes finalized capability specs and in-development change specs, THE spec-check tool SHALL build one active capability catalog that uses finalized specs plus at most one selected in-development delta per capability, SHALL surface skipped conflicts as findings, and SHALL preserve the selected finalized and delta documents as merge-eligible inputs for that capability.

**Postcondition:** The active analysis catalog identifies exactly which capability documents will be merged and analyzed and which conflicting deltas were skipped.

##### Evidence
- Implementation: [catalog.ts:394 resolveActiveCapabilities()](/src/domain/parser/catalog.ts#L394)
- Test: [catalog.test.ts:55 resolves active capabilities preferring finals over deltas](/test/contract/catalog.test.ts#L55), [catalog.test.ts:66 emits conflict findings for multiple deltas of same capability](/test/contract/catalog.test.ts#L66)

#### Scenario: Reject Unreadable Input [CAT-DISCOVER-FAIL]
IF an input path does not exist or is not readable, THEN THE spec-check tool SHALL stop analysis for that run, report the specific unreadable path, and exit with code `2`.

**Postcondition:** No downstream phase runs with an incomplete or ambiguous input catalog.

##### Evidence
- Implementation: [catalog.ts:107 buildCatalog()](/src/domain/parser/catalog.ts#L107), [catalog.ts:269 collectFiles()](/src/domain/parser/catalog.ts#L269)
- Test: [catalog.test.ts:76 rejects unreadable input path](/test/contract/catalog.test.ts#L76)

#### Scenario: Exclude Archived Changes By Default [CAT-DISCOVER-ARCHIVE]
WHILE archived inputs are not explicitly allowed, WHEN the input set includes archived change directories, THE spec-check tool SHALL exclude their recognized documents from the active catalog.

**Postcondition:** Archived documents do not influence active analysis unless the user opts in for the provided archived inputs.

##### Evidence
- Implementation: [catalog.ts:107 buildCatalog()](/src/domain/parser/catalog.ts#L107)
- Test: [catalog.test.ts:27 excludes archived change specs by default](/test/contract/catalog.test.ts#L27)

#### Scenario: Allow Explicit Archived Inputs [CAT-DISCOVER-ALLOW-ARCH]
WHERE archive admission is enabled, WHEN a recognized document comes from an explicitly provided archived input path, THE spec-check tool SHALL treat that document as eligible for the active catalog under the same capability-resolution rules as non-archived inputs.

**Postcondition:** Explicitly requested archived content participates in analysis without changing discovery scope.

##### Evidence
- Implementation: [catalog.ts:107 buildCatalog()](/src/domain/parser/catalog.ts#L107)
- Test: [catalog.test.ts:41 admits explicitly provided archived inputs with allowArchive](/test/contract/catalog.test.ts#L41)

#### Scenario: Empty Catalog Stops Analysis [CAT-DISCOVER-EMPTY]
IF no active documents survive recognition and catalog admission, THEN THE spec-check tool SHALL stop the run before downstream analysis begins and SHALL surface the classified empty-catalog reason to the CLI.

**Postcondition:** No qualitative, formal, or reporting phase runs against a vacuous active catalog.

##### Evidence
- Implementation: [run-cli.ts:284 runIngestionPhases()](/src/cli/run-cli.ts#L284), [catalog.ts:222 classifyEmptyCatalogReason()](/src/domain/parser/catalog.ts#L222), [run-cli.ts:83 formatCatalogEmptyMessage()](/src/cli/run-cli.ts#L83)
- Test: [cli.test.ts:209 formats each empty-catalog variant with contextual details](/test/contract/cli.test.ts#L209)
- Test (integration): [catalog-abort.integration.test.ts:53 aborts pipeline on no_recognized_docs — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L53), [catalog-abort.integration.test.ts:82 aborts pipeline on all_archived without --allow-archive — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L82), [catalog-abort.integration.test.ts:111 aborts pipeline on all_filtered — no downstream reports produced](/test/integration/catalog-abort.integration.test.ts#L111)

#### Requirement model

```alloy
// --- Discover and resolve active analysis inputs ---
// Constraints on discovered/active sets are expressed directly on primed/"next" state.
// Failure modes: unreadable input, empty catalog (3 classified causes), delta conflicts.

pred discover_success {
  no Invocation.unreadable
  RunState.catalog' = Invocation.recognized
  RunState.activeCatalog' = Invocation.selected
  catalog_selection_contract
  // Guard: ConfigLoad completed, no prior fatal outcome
  ConfigLoad in RunState.completedPhases
  Discover not in RunState.completedPhases
  no RunState.lastOutcome
  // Postcondition: archived artifacts are excluded unless archive admission is enabled
  (Config.allowArchive = False) implies no (RunState.activeCatalog' & ArchivedArtifact)
  // Postcondition: active catalog is a subset of full catalog
  RunState.activeCatalog' in RunState.catalog'
  // Postcondition: at most one in-dev delta per capability
  all c : Capability | lone (c.inDev & RunState.activeCatalog')
  // Postcondition: active catalog is non-empty (success path)
  some RunState.activeCatalog'
  // Every skipped eligible delta has its own source-attributed conflict finding.
  all c : Capability | all a : (c.inDev & catalog_eligible) - Invocation.selected |
    some f : RunState.findings' - RunState.findings |
      f.kind = DeltaConflict and f.sourceFile = a.source
  // Delta conflicts produce DeltaConflict findings
  all c : Capability |
    (#(c.inDev & catalog_eligible) > 1) implies
      (some f : RunState.findings' - RunState.findings |
        f.kind = DeltaConflict)
  // Opted-in archived sources can legitimately produce conflict findings.
  all f : RunState.findings' - RunState.findings |
    f.sourceFile in catalog_eligible.source
  // Findings monotonic
  RunState.findings in RunState.findings'
  // Effect
  RunState.completedPhases' = RunState.completedPhases + Discover
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
  no RunState.emptyCatalogReason'
}

pred discover_reject_unreadable [p : InputPath] {
  p in Invocation.unreadable
  // Guard: ConfigLoad completed, input path not readable, no prior outcome
  ConfigLoad in RunState.completedPhases
  Discover not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: InputError, pipeline stops
  RunState.completedPhases' = RunState.completedPhases
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.findings' = RunState.findings
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = InputError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred discover_empty_no_docs {
  no Invocation.unreadable
  no Invocation.recognized
  // Guard: ConfigLoad completed, input paths yield zero recognized documents, no prior outcome
  ConfigLoad in RunState.completedPhases
  Discover not in RunState.completedPhases
  no RunState.lastOutcome
  // Postcondition: no artifacts at all in the catalog
  no RunState.catalog'
  // Effect: pipeline stops, classified as no_recognized_docs
  RunState.completedPhases' = RunState.completedPhases
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.findings' = RunState.findings
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = EmptyCatalogError
  RunState.emptyCatalogReason' = NoRecognizedDocs
}

pred discover_empty_all_archived {
  no Invocation.unreadable
  RunState.catalog' = Invocation.recognized
  Invocation.recognized = archive_excluded[Invocation.recognized]
  // Guard: ConfigLoad completed, all recognized docs are archived, archive not allowed, no prior outcome
  ConfigLoad in RunState.completedPhases
  Discover not in RunState.completedPhases
  no RunState.lastOutcome
  // Postcondition: catalog has items but they're all archived
  some RunState.catalog'
  RunState.catalog' in ArchivedArtifact
  no RunState.activeCatalog'
  // Effect: pipeline stops, classified as all_archived
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = EmptyCatalogError
  RunState.emptyCatalogReason' = AllArchived
}

pred discover_empty_all_filtered {
  no Invocation.unreadable
  RunState.catalog' = Invocation.recognized
  no Invocation.selected
  catalog_selection_contract
  // Guard: ConfigLoad completed, recognized docs exist but all excluded by policy, no prior outcome
  ConfigLoad in RunState.completedPhases
  Discover not in RunState.completedPhases
  no RunState.lastOutcome
  // Postcondition: catalog has non-archived items but none survive resolution
  some RunState.catalog'
  some (RunState.catalog' - archive_excluded[RunState.catalog'])
  no RunState.activeCatalog'
  // Effect: pipeline stops, classified as all_filtered
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = EmptyCatalogError
  RunState.emptyCatalogReason' = AllFiltered
}

// Safety: archived artifacts never appear in active catalog unless explicitly allowed
assert archived_never_active {
  always ((Config.allowArchive = False) implies
    no (RunState.activeCatalog & ArchivedArtifact))
}

// Safety: unreadable input stops the entire run
assert unreadable_stops_run {
  always (all p : InputPath |
    discover_reject_unreadable[p] implies
      Parse not in RunState.completedPhases')
}

// Safety: at most one in-development delta per capability in active catalog
assert at_most_one_delta_per_capability {
  always (all c : Capability | lone (c.inDev & RunState.activeCatalog))
}

// Safety: empty catalog classification is exactly one cause (mutual exclusion)
assert empty_catalog_exactly_one_cause {
  always (RunState.lastOutcome = EmptyCatalogError implies
    one RunState.emptyCatalogReason and
    RunState.emptyCatalogReason = empty_cause[RunState.catalog, RunState.activeCatalog])
}

// Safety: empty catalog always stops downstream analysis
assert empty_catalog_stops_downstream {
  always (some RunState.emptyCatalogReason implies
    (Parse not in RunState.completedPhases and
     StructValidate not in RunState.completedPhases and
     Emit not in RunState.completedPhases))
}

// Safety: delta conflicts always produce findings when multiple deltas exist
assert delta_conflicts_surfaced {
  always (Discover in RunState.completedPhases implies
    all c : Capability | (#(c.inDev & catalog_eligible) > 1) implies
      (some f : RunState.findings | f.kind = DeltaConflict))
}

fun catalog_eligible : set Artifact {
  Invocation.recognized - archive_excluded[Invocation.recognized]
}
pred catalog_selection_contract {
  Invocation.selected in catalog_eligible
  // Non-spec artifacts pass through; capability-less specs remain filtered.
  { a : catalog_eligible | a.documentKind != SpecDoc } in Invocation.selected
  Invocation.selected & { a : Artifact | a.documentKind = SpecDoc } in
    Capability.finalized + Capability.inDev
  all c : Capability | {
    lone (c.finalized & Invocation.selected)
    lone (c.inDev & Invocation.selected)
    some c.finalized & catalog_eligible implies one c.finalized & Invocation.selected
    some c.inDev & catalog_eligible implies one c.inDev & Invocation.selected
  }
}
// Safety: active archived artifacts require opt-in and explicit archived input.
assert explicitly_admitted_archives_only {
  always (all a : RunState.activeCatalog & ArchivedArtifact |
    Config.allowArchive = True and a.explicitlyArchived = True)
}
```

### Requirement: Dependency Availability Check [CAT-CLI-DEPS]
WHEN analysis begins after run-start output cleanup, THE spec-check tool SHALL verify that required external dependencies (`opencode` for LLM-backed phases, `z3` for solver-backed phases) are available and executable before proceeding to phases that need them, and SHALL resolve a supported OpenCode release through the bounded version probe before any analysis invocation.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/proposal.md#Constraints`
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Runtime-Resolution`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Assumptions and Dependencies`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Missing Opencode Rejected [CAT-DEPS-OPENCODE]
IF `opencode` is required for the selected analysis mode and is not available or not executable, THEN THE spec-check tool SHALL exit with code `4` and a diagnostic message naming the missing dependency.

**Postcondition:** No LLM-backed analysis proceeds without a working `opencode` binary.

##### Evidence
- Implementation: [pipeline-helpers.ts:60 checkDependencies()](/src/cli/pipeline-helpers.ts#L60), [opencode-runtime.ts:88 detectOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L88), [run-cli.ts:284 runIngestionPhases()](/src/cli/run-cli.ts#L284)
- Test: [opencode-runtime.test.ts:54 normalizes spawn failures into inert bounded diagnostics](/test/contract/opencode-runtime.test.ts#L54)
- Test (integration): [opencode-runtime.integration.test.ts:21 terminates hanging/verbose probes and rejects malformed bytes and non-executable files](/test/integration/opencode-runtime.integration.test.ts#L21)

#### Scenario: Missing Z3 Rejected [CAT-DEPS-Z3]
IF `z3` is required for the selected analysis mode and its default PATH command or configured `--z3` command cannot execute successfully, THEN THE spec-check tool SHALL exit with code `4` during the dependency phase, emit a bounded inert diagnostic identifying the command, failure reason, and corrective checks, and SHALL NOT begin any LLM analysis or solver query.

**Postcondition:** Exactly one argv-only `z3 --version` preflight is attempted after successful OpenCode detection, with a fixed `5000` ms timeout and `16384`-byte combined capture limit plus the process adapter's `250` ms cleanup allowance, subject to event-loop scheduling. Only a signal-free zero exit without spawn error, timeout or overflow succeeds. Missing commands, `EACCES`/`EPERM`, other spawn failures, nonzero exit, signal, timeout and overflow are dependency failures, not warnings that permit paid work. No Z3 version policy or SMT query is introduced. Preflight consumes no model retry budget or telemetry attempt. Failed runs publish no new completion manifest; help/version remain dependency-free.

##### Evidence
- Implementation: [pipeline-helpers.ts:60 checkDependencies()](/src/cli/pipeline-helpers.ts#L60), [z3.ts:44 probeZ3Dependency()](/src/adapters/z3.ts#L44), [process.ts:115 runProcess()](/src/adapters/process.ts#L115), [run-cli.ts:284 runIngestionPhases()](/src/cli/run-cli.ts#L284)
- Test: [z3-preflight.test.ts:14 uses one bounded version command without allocating model work or imposing a version policy](/test/contract/z3-preflight.test.ts#L14), [z3-preflight.test.ts:28 classifies %s without accepting a merely existing file](/test/contract/z3-preflight.test.ts#L28), [z3-preflight.test.ts:48 fails closed for process result %o](/test/contract/z3-preflight.test.ts#L48), [z3-preflight.test.ts:55 bounds and escapes the configured path, and never prints hostile process output or exceptions](/test/contract/z3-preflight.test.ts#L55)
- Test (integration): [z3-preflight.integration.test.ts:17 accepts a valid executable and rejects a permission-denied file through both availability paths](/test/integration/z3-preflight.integration.test.ts#L17), [z3-preflight.integration.test.ts:32 %s stops before analysis on unusable explicit/PATH Z3 and keeps informational commands dependency-free](/test/integration/z3-preflight.integration.test.ts#L32), [opencode-runtime.integration.test.ts:43 runs compiled and bundled pipelines against major %s with one probe each](/test/integration/opencode-runtime.integration.test.ts#L43)

#### Requirement model

```alloy
// --- Dependency availability check ---
// Failure modes: opencode missing/non-executable, z3 missing/non-executable.

pred deps_check_success {
  oc_dependency_admitted[Invocation.preflight]
  // Guard: Discover completed, all required deps available, no prior fatal outcome
  Discover in RunState.completedPhases
  DependencyCheck not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: DependencyCheck completed
  RunState.completedPhases' = RunState.completedPhases + DependencyCheck
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred deps_missing_opencode {
  Invocation.preflight.cleanupComplete = True
  not oc_version_ok[Invocation.preflight.opencodeProbe]
  // Guard: Discover completed, opencode not available or not executable, no prior outcome
  Discover in RunState.completedPhases
  DependencyCheck not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: DependencyError, pipeline stops
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = DependencyError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred deps_missing_z3 {
  Invocation.preflight.cleanupComplete = True
  oc_version_ok[Invocation.preflight.opencodeProbe]
  Invocation.preflight.needsZ3 = True
  not oc_process_ok[Invocation.preflight.z3Probe]
  // Guard: Discover completed, z3 not available at default or --z3 path, no prior outcome
  Discover in RunState.completedPhases
  DependencyCheck not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: DependencyError, pipeline stops
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = DependencyError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

// Composite: any dependency missing
pred deps_missing [d : Dependency] {
  (d = OpencodeDep and deps_missing_opencode)
  or (d = Z3Dep and deps_missing_z3)
}

// Safety: no LLM-backed analysis without opencode
assert no_llm_without_opencode {
  always (deps_missing_opencode implies
    Parse not in RunState.completedPhases')
}

// Safety: no solver-backed analysis without z3
assert no_solver_without_z3 {
  always (deps_missing_z3 implies
    Parse not in RunState.completedPhases')
}

// Safety: dependency failure always produces DependencyError outcome
assert dep_failure_outcome {
  always ((deps_missing_opencode or deps_missing_z3) implies
    RunState.lastOutcome' = DependencyError)
}
```

#### Bounded preflight refinement

```alloy
// --- Atomic dependency admission ---
// Effects/Frames: none; this refinement leaves RunState unchanged.
// Tests establish argv, time/capture limits, cleanup and absence of paid work.
pred oc_dependency_admitted[p : OCPreflight] {
  // Guards: ordinary valid input, cleanup complete, required probes successful.
  // Postcondition: dependency admission permits the existing analysis phase.
  p.informationalOnly = False
  p.effectiveModelValid = True
  p.cleanupComplete = True
  oc_version_ok[p.opencodeProbe]
  p.needsZ3 = True implies oc_process_ok[p.z3Probe]
}
// Safety: a dependency error never admits analysis.
assert oc_dependency_failure_blocks_admission {
  all p : OCPreflight | oc_preflight_exit[p] = OCExit4 implies
    not oc_dependency_admitted[p]
}
// Safety: informational commands neither probe dependencies nor admit analysis.
assert oc_informational_has_no_probes {
  all p : OCPreflight | p.informationalOnly = True implies
    no oc_preflight_probes[p] and not oc_dependency_admitted[p]
}
// Safety: required Z3 failure maps to dependency exit 4 before analysis.
assert oc_z3_failure_is_exit4 {
  all p : OCPreflight | p.informationalOnly = False and
    p.effectiveModelValid = True and p.cleanupComplete = True and
    oc_version_ok[p.opencodeProbe] and p.needsZ3 = True and
    not oc_process_ok[p.z3Probe] implies oc_preflight_exit[p] = OCExit4
}
```

### Requirement: Validate Schema Structure Deterministically [CAT-VALIDATE-STRUCT]
WHEN the spec-check tool parses an input artifact with recognizable headings, THE spec-check tool SHALL deterministically validate schema-mandated structural rules including heading shape, identifier format, scenario presence, references presence, and delta completeness, and SHALL emit structural findings with provenance for every violation.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Report Structural Violation [CAT-STRUCT-REPORT]
WHEN a requirement or scenario header violates the canonical identifier format or required section structure, THE spec-check tool SHALL emit a structural finding that names the violated rule, the source file, and the exact line or heading where the violation occurred.

**Postcondition:** Reviewers can identify the failing structural rule without re-parsing the document manually.

##### Evidence
- Implementation: [spec.ts:141 parseRequirement()](/src/domain/parser/spec.ts#L141), [spec.ts:236 parseScenario()](/src/domain/parser/spec.ts#L236), [pipeline-helpers.ts:195 collectParserFindings()](/src/cli/pipeline-helpers.ts#L195)

#### Scenario: Reject Content With No Headings [CAT-STRUCT-FAIL]
IF an input file contains no recognizable headings, THEN THE spec-check tool SHALL emit a parse-error finding for that file and SHALL exclude that file from downstream phases unless no parseable inputs remain.

**Postcondition:** Downstream phases receive only inputs with minimally recognizable structure.

##### Evidence

#### Scenario: Validate Canonical Identifier Format [CAT-STRUCT-IDFORMAT]
WHEN a requirement or scenario declares a bracketed identifier, THE spec-check tool SHALL validate that the identifier matches the canonical format: uppercase letters, digits, and hyphens enclosed in square brackets (e.g., `[UPPER-KEBAB-123]`).

**Postcondition:** Malformed identifiers are surfaced as structural findings before downstream phases use them for traceability.

##### Evidence
- Implementation: [shared.ts:53 parseCanonicalIdentifier()](/src/domain/parser/shared.ts#L53), [spec.ts:300 parseTitledIdentifier()](/src/domain/parser/spec.ts#L300)
- Test: [parser.test.ts:21 validates canonical identifier format](/test/contract/parser.test.ts#L21), [parser.test.ts:76 extracts scenario with identifier and postcondition](/test/contract/parser.test.ts#L76)
- Example:
```typescript
const { parseCanonicalIdentifier } = await import("./src/domain/parser/shared.ts");
parseCanonicalIdentifier("[CAT-CLI-HELP]"); //=> CAT-CLI-HELP
parseCanonicalIdentifier("[UPPER-KEBAB-123]"); //=> UPPER-KEBAB-123
parseCanonicalIdentifier("[bad]"); //=> undefined
```

#### Requirement model

```alloy
// --- Structural validation: deterministic schema checks ---
// Note: Canonical identifier regex validation (^[A-Z0-9][A-Z0-9-]*$) is a
// syntactic property not fully expressible in Alloy's relational logic.
// The model captures the structural invariant that violations produce findings.
// Failure modes: headless document, malformed identifier, missing required sections.
// Clarified all-headless case: retain parsed source/error evidence, stop analysis.

pred struct_validate_phase {
  // Guard: Parse completed, no prior fatal outcome
  Parse in RunState.completedPhases
  StructValidate not in RunState.completedPhases
  no RunState.lastOutcome
  let headless = { d : RunState.parsedDocs | d.hasHeadings = False },
      headed = { d : RunState.parsedDocs | d.hasHeadings = True } | {
    // Headless documents produce parse-error findings
    all d : headless |
      (some f : RunState.findings' - RunState.findings |
        f.sourceFile = d.source and f.kind = ParseErrorKind)
    // If headed docs exist, exclude headless; otherwise retain diagnostic records
    (some headed) implies RunState.parsedDocs' = RunState.parsedDocs - headless
    (no headed) implies RunState.parsedDocs' = RunState.parsedDocs
    (some headed) implies {
      RunState.completedPhases' = RunState.completedPhases + StructValidate
      RunState.lastOutcome' = RunState.lastOutcome
    }
    (no headed) implies {
      RunState.completedPhases' = RunState.completedPhases
      RunState.lastOutcome' = InputError
    }
  }
  // Report each schema defect, including malformed identifiers, at its heading.
  all r : Requirement | r.doc in RunState.parsedDocs implies
    all rule : r.schemaDefects |
      some f : RunState.findings' - RunState.findings |
        f.sourceFile = r.doc.source and f.violatedRule = rule and
        f.location = rule.(r.schemaLocation) and
        f.kind = (rule = IdentifierRule => IdentifierError else StructuralViolation)
  // New findings have provenance in the parsed document set
  all f : RunState.findings' - RunState.findings |
    f.sourceFile in RunState.parsedDocs.source
  // Findings monotonic
  RunState.findings in RunState.findings'
  // Effect
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

// Safety: structural violations always produce findings with provenance
assert violations_produce_findings {
  always (struct_validate_phase implies
    all r : Requirement | r.doc in RunState.parsedDocs implies
      all rule : r.schemaDefects | some f : RunState.findings' |
        f.sourceFile = r.doc.source and f.violatedRule = rule and
        f.location = rule.(r.schemaLocation) and some f.location)
}

// Safety: after structural validation, if headed docs existed, only headed remain
assert headless_excluded_from_downstream {
  always (StructValidate in RunState.completedPhases implies
    (some d : RunState.parsedDocs | d.hasHeadings = True) implies
      (all d : RunState.parsedDocs | d.hasHeadings = True))
}

// Safety: identifier format errors always trace to catalog sources
assert identifier_errors_surfaced {
  always (StructValidate in RunState.completedPhases implies
    all f : RunState.findings | f.kind = IdentifierError implies
      f.sourceFile in RunState.catalog.source)
}
// Safety: all-headless inputs retain diagnostic records and stop before emission.
assert all_headless_inputs_stop_with_evidence {
  always (struct_validate_phase and
    (no d : RunState.parsedDocs | d.hasHeadings = True) implies
      RunState.lastOutcome' = InputError and
      RunState.parsedDocs' = RunState.parsedDocs and
      Emit not in RunState.completedPhases')
}
```

### Requirement: Spec Parser EARS Pattern Recognition [CAT-PARSE-EARS]
WHEN the spec-check tool parses a capability spec file, THE spec-check tool SHALL parse complete source statements using the simplified strict project EARS grammar and SHALL preserve delta context and scenario parent associations independently of formal eligibility.

**References:**
- [Proposal: Scope](../../changes/archive/2026-11-15-improve-ears-smt-analysis/proposal.md#scope)
- [Design: Surface grammar and annotations](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#surface-grammar-and-annotations)

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

```alloy
// --- Strict surface parsing and source-section scanner ---
// Preconditions: bounded source observations supplied by the lexer.
// Postconditions: retain all items, including excluded statements and orphans.
// Grammar defect atoms represent the precise source-span diagnostics; no
// optional extension or justification silently repairs malformed EARS.

one sig ParserOptions { whereEnabled : one Bool }
fun delta_boundaries[d : ParsedDoc] : set SourceElement {
  { e : d.elements | some e.exactOperation and e.fenced = False }
}
fun preceding_boundary[r : Requirement] : lone SourceElement {
  { e : delta_boundaries[r.doc] & r.at.prior |
    no later : delta_boundaries[r.doc] & r.at.prior | e in later.prior }
}
fun source_operation[r : Requirement] : one DeltaOperation {
  r.doc.isDelta = False => DeltaBase else
    (some preceding_boundary[r] => preceding_boundary[r].exactOperation else PreSection)
}
fun enclosing_requirement[r : Requirement] : lone Requirement {
  { p : Requirement | r.scenario = True and p.scenario = False and
    p.doc = r.doc and p.at in r.at.prior and p.identified = True and
    // A new requirement (identified or not) or an exact delta heading resets parent.
    (no q : Requirement | q.scenario = False and q.doc = r.doc and
      p.at in q.at.prior and q.at in r.at.prior) and
    (no e : delta_boundaries[r.doc] & r.at.prior | p.at in e.prior) }
}

fun syntax_issues[r : Requirement] : set SurfaceIssueKind {
  r.grammarIssues +
    ((r.modal = MayModal and r.responseNegated = True) => MayNotAmbiguous else none)
}
pred ears_structure_supported[r : Requirement] {
  some r.observedForm
  some r.modal
  no syntax_issues[r]
}
pred justified_alternative_supported[r : Requirement] {
  r.supportedAlternative = True
  r.escapeHatch = True
}
fun surface_issues[r : Requirement] : set SurfaceIssueKind {
  syntax_issues[r] + metadata_issues[r] +
    (r.withinBound = False => StatementLimit else none) +
    ((r.observedForm = OptionalFeature and ParserOptions.whereEnabled = False) => WhereDisabled else none) +
    ((not ears_structure_supported[r] and not justified_alternative_supported[r] and
       scenario_form[r] not in ExampleForm + ProhibitedExampleForm) => UnsupportedRepresentation else none)
}
pred surface_eligible[r : Requirement] {
  no surface_issues[r]
  ears_structure_supported[r] or justified_alternative_supported[r] or
    scenario_form[r] in ExampleForm + ProhibitedExampleForm
}
pred parser_item_contract[r : Requirement] {
  r.deltaOp = source_operation[r]
  r.parentReqId = enclosing_requirement[r]
  r.earsType = (ears_structure_supported[r] => r.observedForm else none)
  fragment_contract[r]
  clause_contract[r]
  disposition_contract[r]
}

pred parse_phase {
  // Guard: admitted dependencies, exactly one parse per active file.
  DependencyCheck in RunState.completedPhases
  Parse not in RunState.completedPhases
  no RunState.lastOutcome
  RunState.parsedDocs' = { d : ParsedDoc | d.source in RunState.activeCatalog.source }
  RunState.parsedDocs'.source = RunState.activeCatalog.source
  all p : RunState.activeCatalog.source | one d : RunState.parsedDocs' | d.source = p
  all r : Requirement | r.doc in RunState.parsedDocs' implies parser_item_contract[r]
  // Every limitation has a source-attributed structural diagnostic.
  all r : Requirement | r.doc in RunState.parsedDocs' and some surface_issues[r] implies
    some f : RunState.findings' - RunState.findings |
      f.kind = EarsWarning and f.sourceFile = r.doc.source and
      f.location in r.fragments and some f.location
  all d : RunState.parsedDocs' | {
    all u : d.unmatched | some f : RunState.findings' - RunState.findings |
      f.kind = ParseWarning and f.sourceFile = d.source and f.location = u
    // Finalized delta headings warn once per file, not once per heading.
    d.isDelta = False and some delta_boundaries[d] implies
      one f : RunState.findings' - RunState.findings |
        f.kind = DeltaHeadingWarning and f.sourceFile = d.source
    some r : Requirement | r.doc = d and r.deltaOp = PreSection implies
      some f : RunState.findings' - RunState.findings |
        f.kind = PreSectionWarning and f.sourceFile = d.source
  }
  // Findings cannot invent defects in clean inputs.
  all f : RunState.findings' - RunState.findings | {
    f.kind in EarsWarning + ParseWarning + DeltaHeadingWarning + PreSectionWarning
    f.kind = EarsWarning implies some r : Requirement |
      r.doc in RunState.parsedDocs' and r.doc.source = f.sourceFile and some surface_issues[r]
    f.kind = ParseWarning implies some d : RunState.parsedDocs' |
      d.source = f.sourceFile and f.location in d.unmatched and some f.location
    f.kind = DeltaHeadingWarning implies some d : RunState.parsedDocs' |
      d.source = f.sourceFile and d.isDelta = False and some delta_boundaries[d]
    f.kind = PreSectionWarning implies some r : Requirement |
      r.doc in RunState.parsedDocs' and r.doc.source = f.sourceFile and r.deltaOp = PreSection
  }
  RunState.findings in RunState.findings'
  all f : RunState.findings' - RunState.findings | f.sourceFile in RunState.parsedDocs'.source
  RunState.completedPhases' = RunState.completedPhases + Parse
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.lastOutcome' = RunState.lastOutcome
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

// Safety: every parsed item with surface limitations has a diagnostic.
assert non_ears_produces_finding {
  always (Parse in RunState.completedPhases implies
    all r : Requirement | r.doc in RunState.parsedDocs and some surface_issues[r] implies
      some f : RunState.findings | f.kind = EarsWarning and f.sourceFile = r.doc.source)
}
// Safety: each parsed item has the operation derived from its source section.
assert delta_op_always_assigned {
  always (Parse in RunState.completedPhases implies
    all r : Requirement | r.doc in RunState.parsedDocs implies r.deltaOp = source_operation[r])
}
// Safety: finalized items remain base content despite delta headings.
assert finalized_always_base {
  always (Parse in RunState.completedPhases implies
    all r : Requirement | r.doc in RunState.parsedDocs and r.doc.isDelta = False implies r.deltaOp = DeltaBase)
}
// Safety: a scenario and its identified parent share document and delta context.
assert scenario_inherits_parent_delta {
  always (Parse in RunState.completedPhases implies
    all r : Requirement | r.doc in RunState.parsedDocs and some r.parentReqId implies
      r.parentReqId.doc = r.doc and r.parentReqId.deltaOp = r.deltaOp)
}
// Safety: eligibility cannot change the source-derived scenario parent.
assert scenario_parent_is_independent_of_eligibility {
  always (Parse in RunState.completedPhases implies
    all r : Requirement | r.doc in RunState.parsedDocs implies
      r.parentReqId = enclosing_requirement[r])
}
// Safety: delta items preceding an exact boundary remain pre-section content.
assert pre_section_never_promoted {
  always (Parse in RunState.completedPhases implies
    all r : Requirement | r.doc in RunState.parsedDocs and r.doc.isDelta = True and
      no preceding_boundary[r] implies r.deltaOp = PreSection)
}
// Safety: syntax defects, byte limits and disabled extensions prevent eligibility.
assert malformed_or_disabled_forms_never_admitted {
  all r : Requirement | some syntax_issues[r] or r.withinBound = False or
    (r.observedForm = OptionalFeature and ParserOptions.whereEnabled = False) implies
      not surface_eligible[r]
}
// Safety: fenced and inexact headings cannot change delta context.
assert only_exact_unfenced_headings_change_delta_context {
  all r : Requirement | some preceding_boundary[r] implies
    preceding_boundary[r].fenced = False and some preceding_boundary[r].exactOperation
}
```

### Requirement: Preserve Unparsed Source Content As Evidence [CAT-PRESERVE-LOSS]
WHEN the parser encounters input lines that do not match any recognized pattern, THE spec-check tool SHALL preserve those lines with file and line provenance and SHALL surface them as parse-warning findings instead of silently dropping them.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Preserve Unparsed Lines [CAT-PRESERVE-LINES]
WHEN a document contains extra content outside recognized fields, THE spec-check tool SHALL record the unmatched lines in parser output and SHALL include provenance for each unmatched fragment in the resulting findings.

**Postcondition:** Analysts can inspect every parser loss boundary as part of the evidence set.

##### Evidence
- Implementation: [shared.ts:136 collectUnparsedLines()](/src/domain/parser/shared.ts#L136), [pipeline-helpers.ts:195 collectParserFindings()](/src/cli/pipeline-helpers.ts#L195)
- Test: [parser.test.ts:27 recognizes EARS and preserves unparsed lines deterministically](/test/contract/parser.test.ts#L27)
- Test (property): [parser.property.test.ts:12 is deterministic and preserves unmatched lines](/test/property/parser.property.test.ts#L12)

#### Scenario: Prevent Silent Parser Loss [CAT-PRESERVE-FAIL]
IF the parser cannot classify a line of otherwise parseable content, THEN THE spec-check tool SHALL retain the line as evidence and SHALL NOT silently omit it from the analysis record.

**Postcondition:** Parser loss cannot reduce evidence without an explicit surfaced warning.

##### Evidence
- Implementation: [shared.ts:136 collectUnparsedLines()](/src/domain/parser/shared.ts#L136)
- Test (property): [parser.property.test.ts:12 is deterministic and preserves unmatched lines](/test/property/parser.property.test.ts#L12)

#### Requirement model

```alloy
// --- Preserve unparsed source content as evidence ---
// The parser must never silently drop content. Unmatched lines produce
// ParseWarning findings with source-file provenance.

// Safety: every parsed document with unmatched content has a ParseWarning finding
assert no_silent_parser_loss {
  always (Parse in RunState.completedPhases implies
    all d : RunState.parsedDocs | d.hasUnmatched = True implies
      (some f : RunState.findings | f.sourceFile = d.source and f.kind = ParseWarning))
}

// Safety: findings only accumulate, never shrink
assert findings_monotonic {
  always (RunState.findings in RunState.findings')
}

// Safety: each raw unmatched fragment survives with its observed source location.
assert every_unmatched_fragment_is_evidence {
  always (parse_phase implies all d : RunState.parsedDocs' | all u : d.unmatched |
    some f : RunState.findings' | f.kind = ParseWarning and f.location = u and
      f.sourceFile = u.file and f.sourceFile = d.source)
}
```

### Requirement: Parser Determinism [CAT-PARSE-DETERMINISM]
WHEN the spec-check tool parses the same input content on separate runs, THE spec-check tool SHALL produce identical parsed output, including delta-operation annotations, scenario-parent associations, and pre-section structural state.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Quality Attributes`

#### Scenario: Identical Input Produces Identical Parse [CAT-DETERM-SAME]
WHEN the same document content is parsed on two separate runs, THE spec-check tool SHALL produce byte-identical parsed models.

**Postcondition:** Parser output is a deterministic function of input content.

##### Evidence
- Implementation: [spec.ts:43 parseSpec()](/src/domain/parser/spec.ts#L43)
- Test: [extended.determinism.test.ts:80 parser output is identical across runs for same input](/test/determinism/extended.determinism.test.ts#L80)
- Test (property): [parser.property.test.ts:12 is deterministic and preserves unmatched lines](/test/property/parser.property.test.ts#L12)

#### Requirement model

```alloy
// --- Parser determinism: implementation boundary contract ---
// Paths and content are distinct identities; equal bytes do not imply equal paths.
// Repeated runs compare ordered serialized outputs for the same full parser input
// (bytes, provenance, finalized/delta source type and effective options).
// Byte-identical serialization is established by determinism/property tests.
// ParseEvaluation records that external contract; it is not a second parser
// implementation or an independent Alloy proof of serialization determinism.
sig ParseInput {
  path : one InputPath, bytes : one SourceText,
  deltaSource : one Bool, whereOption : one Bool, boundOption : one SettingValue
}
sig ParseEvaluation { input : one ParseInput, serialized : one SourceText }
pred same_parser_input[a, b : ParseInput] {
  a.path = b.path and a.bytes = b.bytes and a.deltaSource = b.deltaSource and
    a.whereOption = b.whereOption and a.boundOption = b.boundOption
}
// Safety contract (externally verified): equal full inputs have equal output bytes.
pred repeated_parse_contract {
  all a, b : ParseEvaluation | same_parser_input[a.input, b.input] implies
    a.serialized = b.serialized
}

pred parse_is_functional {
  all p : InputPath |
    lone { d : RunState.parsedDocs | d.source = p }
}

// Safety: one completed parse retains at most one document per source path.
// This is a within-run uniqueness check, not cross-run byte determinism.
assert parsed_sources_are_unique {
  always (Parse in RunState.completedPhases implies parse_is_functional)
}
```

### Requirement: Progress Event Emission [CAT-CLI-PROGRESS]
WHEN the spec-check tool begins or completes a pipeline phase, THE spec-check tool SHALL emit a JSON progress event on stdout containing at least `phase`, `status`, and `timestamp` fields.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Error Format and Exit Codes`

#### Scenario: Phase Start And Completion Events [CAT-PROGRESS-EVENTS]
WHEN a pipeline phase starts, THE spec-check tool SHALL emit a progress event with `status: "started"`, and WHEN the phase completes, SHALL emit a progress event with `status: "completed"` and a `duration_ms` field.

**Postcondition:** Operators can observe pipeline progress in real time.

##### Evidence
- Implementation: [progress.ts:36 emitProgressEvent()](/src/domain/progress.ts#L36), [progress.ts:55 createProgressEvent()](/src/domain/progress.ts#L55), [phase-runner.ts:42 runPhase()](/src/cli/phase-runner.ts#L42), [phase-runner.ts:89 runPhaseWithResult()](/src/cli/phase-runner.ts#L89)
- Test: [progress.test.ts:6 creates event with phase, status, and ISO timestamp](/test/contract/progress.test.ts#L6), [progress.test.ts:15 includes duration_ms for completed events](/test/contract/progress.test.ts#L15), [progress.test.ts:21 emits JSON line to stdout](/test/contract/progress.test.ts#L21)
- Example:
```typescript
const { createProgressEvent } = await import("./src/domain/progress.ts");
const started = createProgressEvent("parse", "started"); //=> type Object
started.phase; //=> parse
started.status; //=> started
const completed = createProgressEvent("parse", "completed", 150); //=> type Object
completed.duration_ms; //=> 150
```

#### Scenario: Phase Failure Event [CAT-PROGRESS-FAIL]
IF a pipeline phase fails fatally, THEN THE spec-check tool SHALL emit a progress event with `status: "failed"` before exiting.

**Postcondition:** The failing phase is identified in the progress stream.

##### Evidence
- Implementation: [phase-runner.ts:42 runPhase()](/src/cli/phase-runner.ts#L42), [phase-runner.ts:89 runPhaseWithResult()](/src/cli/phase-runner.ts#L89)
- Test: [progress.test.ts:34 creates failed event for phase failures](/test/contract/progress.test.ts#L34)
- Test (integration): [z3-preflight.integration.test.ts:32 %s stops before analysis on unusable explicit/PATH Z3 and keeps informational commands dependency-free](/test/integration/z3-preflight.integration.test.ts#L32)

#### Requirement model

```alloy
// --- Progress event emission and pipeline lifecycle ---
// A phase's started/terminal events are projected from its atomic transition.
// The projection records event membership, not emission order or wall-clock
// interleaving. Progress/phase-runner tests establish JSON encoding, timestamps,
// started-before-terminal ordering and failure emission before process exit.
// The key properties are:
// - Under the external emission contract, every phase has its required events
// - A valid pipeline eventually reaches completion (liveness)
// Failure mode: phase failure emits "failed" event (modeled as outcome, not state)

abstract sig ProgressStatus {}
one sig ProgressStarted, ProgressCompleted, ProgressFailed extends ProgressStatus {}
sig ProgressEvent {
  phase : one Phase,
  status : one ProgressStatus,
  timestamp : one SourceText, // ISO timestamp encoding is an external observation
  duration : lone Int,
  jsonLineOnStdout : one Bool
}
fun failing_phase : lone Phase {
  cli_rejected => CliValidate else
  ((config_load_fail or config_invalid_model) => ConfigLoad else
  (((some p : InputPath | discover_reject_unreadable[p]) or
    discover_empty_no_docs or discover_empty_all_archived or discover_empty_all_filtered) => Discover else
  ((deps_missing_opencode or deps_missing_z3) => DependencyCheck else
  ((struct_validate_phase and RunState.lastOutcome' = InputError) => StructValidate else none))))
}
fun progress_obligations : Phase -> ProgressStatus {
  (RunState.completedPhases' - RunState.completedPhases) -> (ProgressStarted + ProgressCompleted) +
    failing_phase -> (ProgressStarted + ProgressFailed)
}
fun emitted_progress : set ProgressEvent {
  { e : ProgressEvent | e.phase -> e.status in progress_obligations }
}
pred progress_emission_contract {
  all p : Phase, s : ProgressStatus | p -> s in progress_obligations implies
    one e : emitted_progress | e.phase = p and e.status = s
  all e : emitted_progress | {
    e.jsonLineOnStdout = True
    e.status = ProgressCompleted implies one e.duration and e.duration >= 0
  }
}
// Safety: the external emission contract covers completed-phase event fields.
// Conditional projection checks do not prove the stdout implementation.
assert phase_transitions_emit_json_progress {
  always (progress_emission_contract implies all p : RunState.completedPhases' - RunState.completedPhases |
    one e : emitted_progress | e.phase = p and e.status = ProgressCompleted and
      one e.duration and e.jsonLineOnStdout = True)
}
// Safety: the external emission contract includes a failing-phase event.
assert fatal_phase_has_failure_event {
  always (progress_emission_contract and some failing_phase implies
    one e : emitted_progress | e.phase = failing_phase and e.status = ProgressFailed)
}

pred emit_phase {
  // Guard: StructValidate completed, no prior fatal outcome
  StructValidate in RunState.completedPhases
  Emit not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: pipeline complete
  RunState.completedPhases' = RunState.completedPhases + Emit
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = CmdSuccess
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

// Safety: completed phases monotonically grow (no phase un-completes)
assert completed_phases_monotonic {
  always (RunState.completedPhases in RunState.completedPhases')
}

// Safety: phase ordering is always respected
assert phase_ordering_respected {
  always (all p1, p2 : Phase |
    (p1 -> p2) in ^phase_order and p2 in RunState.completedPhases
      implies p1 in RunState.completedPhases)
}

// Safety: a fatal outcome freezes the pipeline (no further phases complete)
assert fatal_outcome_freezes_pipeline {
  always ((some RunState.lastOutcome and
    RunState.lastOutcome in (InputError + ConfigError + DependencyError + EmptyCatalogError))
    implies RunState.completedPhases' = RunState.completedPhases)
}

// Safety: successful completion with analysis requires all phases completed
assert success_requires_all_phases {
  always ((RunState.lastOutcome = CmdSuccess and Emit in RunState.completedPhases)
    implies (CliValidate in RunState.completedPhases and
             ConfigLoad in RunState.completedPhases and
             Discover in RunState.completedPhases and
             DependencyCheck in RunState.completedPhases and
             Parse in RunState.completedPhases and
             StructValidate in RunState.completedPhases))
}

// Liveness: if CLI validation succeeds and no phase fails fatally,
// the pipeline eventually reaches the Emit phase.
// Cooperative success-path scheduling: enabled phases are eventually serviced.
// This premise intentionally excludes invalid input and unavailable dependencies;
// failure traces are checked separately and can stutter after their outcome.
pred pipeline_fairness {
  // If CLI validation is enabled (initial state), it eventually succeeds
  always (no RunState.completedPhases implies
    eventually cli_validate_success)
  // If config loading is enabled, it eventually succeeds
  always ((CliValidate in RunState.completedPhases and
           ConfigLoad not in RunState.completedPhases) implies
    eventually config_load_success)
  // If discovery is enabled, it eventually succeeds
  always ((ConfigLoad in RunState.completedPhases and
           Discover not in RunState.completedPhases) implies
    eventually discover_success)
  // If dependency check is enabled, it eventually succeeds
  always ((Discover in RunState.completedPhases and
           DependencyCheck not in RunState.completedPhases) implies
    eventually deps_check_success)
  // If parsing is enabled, it eventually succeeds
  always ((DependencyCheck in RunState.completedPhases and
           Parse not in RunState.completedPhases) implies
    eventually parse_phase)
  // If structural validation is enabled, it eventually succeeds
  always ((Parse in RunState.completedPhases and
           StructValidate not in RunState.completedPhases) implies
    eventually struct_validate_phase)
  // If emit is enabled, it eventually fires
  always ((StructValidate in RunState.completedPhases and
           Emit not in RunState.completedPhases) implies
    eventually emit_phase)
}

// Liveness: success-path scheduling eventually completes the pipeline.
assert pipeline_progress_liveness {
  pipeline_fairness implies eventually (Emit in RunState.completedPhases)
}

// Liveness: every failure mode eventually terminates with an outcome
// (no silent hang on unresolvable states)
pred failure_terminates {
  always (
    (cli_rejected implies eventually some RunState.lastOutcome) and
    (config_load_fail implies eventually some RunState.lastOutcome) and
    ((some p : InputPath | discover_reject_unreadable[p]) implies
      eventually some RunState.lastOutcome) and
    ((deps_missing_opencode or deps_missing_z3) implies
      eventually some RunState.lastOutcome) and
    (config_invalid_model implies eventually some RunState.lastOutcome) and
    ((discover_empty_no_docs or discover_empty_all_archived or discover_empty_all_filtered) implies
      eventually some RunState.lastOutcome) and
    ((struct_validate_phase and RunState.lastOutcome' = InputError) implies
      eventually some RunState.lastOutcome))
}

// Liveness: an executed fatal transition eventually yields a terminal outcome.
// This does not require failure transitions to be scheduled instead of stuttering.
assert no_silent_hang {
  failure_terminates
}
```

### Requirement: Detect Supported OpenCode Release [CAT-OC-VERSION]
WHEN checking OpenCode for an analysis run, THE spec-check tool SHALL invoke the selected binary with `--version` using argv-only execution, a fixed `5000` ms process timeout, and a `16384`-byte combined stdout/stderr capture limit, and SHALL accept only successful strict-UTF-8 stdout matching the release grammar below with major `1` or `2`.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/proposal.md#Constraints`
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Release-Encoding`

**Format justification:** A grammar and validity rules express the accepted encoding more precisely than a separate EARS statement for each character constraint.

```text
VERSION_LINE := ["opencode "] ["v"] CORE ["-" PRERELEASE] ["+" BUILD]
CORE         := NUMBER "." NUMBER "." NUMBER
NUMBER       := "0" | [1-9][0-9]*
PRERELEASE   := IDENTIFIER ("." IDENTIFIER)*
BUILD        := IDENTIFIER ("." IDENTIFIER)*
IDENTIFIER   := [0-9A-Za-z-]+
```

THE spec-check tool SHALL normalize CRLF to LF, trim outer whitespace, require exactly one nonempty stdout line matching the entire grammar, reject numeric prerelease identifiers with leading zeroes and unsafe-integer core components, match prefixes case-sensitively, and store the version without the optional `opencode ` and `v` prefixes. Successful stderr diagnostics SHALL NOT supply the parsed version.

#### Scenario: Accept Supported Release [CAT-OC-VERSION-ACCEPT]
WHEN a successful probe emits `1.2.3`, `v1.2.3`, `opencode v2.0.15`, or `opencode v2.0.15-rc.1+build.7`, THE spec-check tool SHALL resolve the corresponding canonical semantic version and major and emit one concise detected-version/protocol diagnostic on stderr.

##### Evidence
- Implementation: [opencode-runtime.ts:66 parseOpencodeVersion()](/src/adapters/opencode-runtime.ts#L66), [opencode-runtime.ts:88 detectOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L88), [run-cli.ts:284 runIngestionPhases()](/src/cli/run-cli.ts#L284)
- Test: [opencode-runtime.test.ts:22 accepts the complete release grammar: %s](/test/contract/opencode-runtime.test.ts#L22)
- Test (integration): [opencode-runtime.integration.test.ts:89 rejects unsupported dependencies with exit 4 and performs no analysis, while help/version never probe](/test/integration/opencode-runtime.integration.test.ts#L89)
- Example:
```typescript
const { parseOpencodeVersion } = await import("./src/adapters/opencode-runtime.ts");
const release = parseOpencodeVersion("opencode v2.0.15-rc.1+build.7\r\n"); //=> type Object
release.ok; //=> true
release.value.version; //=> 2.0.15-rc.1+build.7
release.value.major; //=> 2
```

#### Scenario: Bound Version Presentation [CAT-OC-VERSION-PREVIEW]
WHEN a valid semantic version has a long suffix, THE spec-check tool SHALL retain its complete canonical version when minting a supported runtime descriptor and SHALL restrict the version presentation in both success and unsupported-major diagnostics to at most 300 inert characters.

##### Evidence
- Implementation: [opencode-runtime.ts:42 preview()](/src/adapters/opencode-runtime.ts#L42), [opencode-runtime.ts:55 formatOpencodeVersion()](/src/adapters/opencode-runtime.ts#L55), [opencode-runtime.ts:66 parseOpencodeVersion()](/src/adapters/opencode-runtime.ts#L66), [opencode-runtime.ts:88 detectOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L88), [run-cli.ts:284 runIngestionPhases()](/src/cli/run-cli.ts#L284)
- Test: [opencode-runtime.test.ts:65 bounds both displayed version forms while preserving full supported identity](/test/contract/opencode-runtime.test.ts#L65)
- Test (integration): [opencode-runtime.integration.test.ts:89 rejects unsupported dependencies with exit 4 and performs no analysis, while help/version never probe](/test/integration/opencode-runtime.integration.test.ts#L89)

#### Scenario: Reject Invalid Or Unsupported Probe [CAT-OC-VERSION-REJECT]
IF the probe cannot spawn, exits nonzero, receives a signal, times out, exceeds the capture limit, emits malformed UTF-8 or invalid/multiple stdout lines, or reports an unsupported major, THEN THE spec-check tool SHALL fail with `DependencyError` exit `4`, a bounded inert diagnostic, and zero analysis invocations.

**Postcondition:** Detection causes are classified as `spawn_error`, `timeout`, `output_limit`, `invalid_version`, or `unsupported_major`. A signal or nonzero exit without timeout/output overflow is `spawn_error`. No assumed version or cross-major fallback is used.

##### Evidence
- Implementation: [opencode-runtime.ts:66 parseOpencodeVersion()](/src/adapters/opencode-runtime.ts#L66), [opencode-runtime.ts:88 detectOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L88), [pipeline-helpers.ts:60 checkDependencies()](/src/cli/pipeline-helpers.ts#L60), [run-cli.ts:284 runIngestionPhases()](/src/cli/run-cli.ts#L284)
- Test: [opencode-runtime.test.ts:29 rejects invalid release output: %s](/test/contract/opencode-runtime.test.ts#L29), [opencode-runtime.test.ts:34 uses exact dependency bounds and fails closed on unknown majors](/test/contract/opencode-runtime.test.ts#L34), [opencode-runtime.test.ts:47 classifies failed probe %o](/test/contract/opencode-runtime.test.ts#L47), [opencode-runtime.test.ts:54 normalizes spawn failures into inert bounded diagnostics](/test/contract/opencode-runtime.test.ts#L54)
- Test (integration): [opencode-runtime.integration.test.ts:21 terminates hanging/verbose probes and rejects malformed bytes and non-executable files](/test/integration/opencode-runtime.integration.test.ts#L21), [opencode-runtime.integration.test.ts:89 rejects unsupported dependencies with exit 4 and performs no analysis, while help/version never probe](/test/integration/opencode-runtime.integration.test.ts#L89)

#### Scenario: Preserve Informational Fast Paths [CAT-OC-VERSION-INFO]
WHEN invoked with `--help` or `--version`, THE spec-check tool SHALL produce its existing informational output without probing OpenCode or contacting other external dependencies.

##### Evidence
- Implementation: [index.ts:42 main()](/src/index.ts#L42)
- Test: [cli.test.ts:81 parses help and version flags](/test/contract/cli.test.ts#L81)
- Test (integration): [opencode-runtime.integration.test.ts:89 rejects unsupported dependencies with exit 4 and performs no analysis, while help/version never probe](/test/integration/opencode-runtime.integration.test.ts#L89), [z3-preflight.integration.test.ts:32 %s stops before analysis on unusable explicit/PATH Z3 and keeps informational commands dependency-free](/test/integration/z3-preflight.integration.test.ts#L32)

#### Requirement model

```alloy
// --- Supported release admission ---
// Effects/Frames: none; immutable probe observations leave RunState unchanged.
// Tests establish grammar/UTF-8 observations; Alloy does not execute the lexer.
pred oc_process_ok[p : OCProbe] {
  // Guards: zero exit, no spawn error, signal, timeout or capture overflow.
  // Postcondition: the observed process completed successfully.
  p.spawnError = False
  p.zeroExit = True
  p.signalled = False
  p.timedOut = False
  p.overflow = False
}
// Guard: no detection failure. Postcondition: the release is admitted.
pred oc_version_ok[p : OCProbe] { no oc_detection_cause[p] }
// Safety: accepted versions have valid transport/grammar and a supported major.
assert oc_accepted_version_is_supported {
  all p : OCProbe | oc_version_ok[p] implies
    oc_process_ok[p] and p.strictUtf8 = True and p.grammarValid = True and
    p.reportedMajor in OCMajor1 + OCMajor2
}
// Safety: a signal is failure unless timeout/overflow classification takes priority.
assert oc_signal_is_spawn_error {
  all p : OCProbe | p.signalled = True and p.timedOut = False and
    p.overflow = False implies oc_detection_cause[p] = OCSpawnError
}

// Presentation is separate from canonical descriptor identity. The character
// count/escaping observations are established by presentation contract tests.
sig OCVersionPresentation {
  probe : one OCProbe,
  retainedVersion : one OCText,
  displayedVersion : one OCText,
  inert : one Bool,
  within300Characters : one Bool
}
pred oc_presentation_contract[p : OCVersionPresentation] {
  p.retainedVersion = p.probe.canonicalVersion
  p.inert = True
  p.within300Characters = True
}
// Safety contract (externally verified): presentation remains bounded/inert and
// retains canonical identity. Presentation tests establish these observations;
// repeating the contract as an assertion would not independently verify them.
// Safety: timeout takes detection priority, followed by capture overflow.
assert oc_timeout_and_overflow_have_priority {
  all p : OCProbe | {
    p.timedOut = True implies oc_detection_cause[p] = OCTimeout
    p.timedOut = False and p.overflow = True implies oc_detection_cause[p] = OCOutputLimit
  }
}
```

### Requirement: Preserve Run Protocol Identity [CAT-OC-RUNTIME]
WHILE an analysis run is active, THE spec-check tool SHALL use its single immutable resolved OpenCode runtime for every model invocation, retry, and optional final-report call, without sharing that runtime with concurrent runs or persisting it between CLI invocations.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/proposal.md#Invariants`
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Runtime-Resolution`

#### Scenario: Reuse Run Runtime [CAT-OC-RUNTIME-REUSE]
WHEN a valid run executes multiple phases and retries, THE spec-check tool SHALL perform exactly one OpenCode version probe for that run and retain the same binary/version/major descriptor through final reporting.

##### Evidence
- Implementation: [run-cli.ts:170 runCliPipeline()](/src/cli/run-cli.ts#L170), [opencode-runtime.ts:114 runWithOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L114), [opencode-runtime.ts:125 resolveOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L125), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443)
- Test: [opencode-runtime.test.ts:108 detects once per direct logical call and retains the protocol across retries](/test/contract/opencode-runtime.test.ts#L108)
- Test (property): [opencode-runtime.test.ts:88 isolates nested and interleaved scopes under generated schedules](/test/contract/opencode-runtime.test.ts#L88)
- Test (integration): [opencode-runtime.integration.test.ts:43 runs compiled and bundled pipelines against major %s with one probe each](/test/integration/opencode-runtime.integration.test.ts#L43)

#### Scenario: Isolate Concurrent Runs [CAT-OC-RUNTIME-ISOLATE]
WHEN two analysis runs with different resolved binaries execute concurrently, THE spec-check tool SHALL encode each run's invocations using only its own runtime descriptor.

##### Evidence
- Implementation: [opencode-runtime.ts:114 runWithOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L114), [opencode-runtime.ts:125 resolveOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L125), [opencode-protocol.ts:17 buildOpencodeArgs()](/src/adapters/opencode-protocol.ts#L17)
- Test (property): [opencode-runtime.test.ts:88 isolates nested and interleaved scopes under generated schedules](/test/contract/opencode-runtime.test.ts#L88)

#### Scenario: Resolve Direct Adapter Call [CAT-OC-RUNTIME-DIRECT]
WHEN a valid direct adapter call executes, THE OpenCode adapter SHALL select an explicit runtime override first, otherwise a matching scoped runtime, otherwise one bounded detection outside a scope, and SHALL resolve that selection before the retry loop.

##### Evidence
- Implementation: [opencode-runtime.ts:125 resolveOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L125), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443)
- Test: [opencode-runtime.test.ts:78 prioritizes an explicit runtime and rejects selected-binary mismatch before probing](/test/contract/opencode-runtime.test.ts#L78), [opencode-runtime.test.ts:108 detects once per direct logical call and retains the protocol across retries](/test/contract/opencode-runtime.test.ts#L108)

#### Scenario: Reject Mismatched Runtime [CAT-OC-RUNTIME-MISMATCH]
IF a selected binary conflicts with its explicit descriptor or a call without an explicit override conflicts with the scoped descriptor, THEN THE OpenCode adapter SHALL return a non-retryable `runtime_error` before any probe or analysis spawn.

##### Evidence
- Implementation: [opencode-runtime.ts:125 resolveOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L125), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443)
- Test: [opencode-runtime.test.ts:78 prioritizes an explicit runtime and rejects selected-binary mismatch before probing](/test/contract/opencode-runtime.test.ts#L78)

#### Scenario: Reject Direct Detection Failure [CAT-OC-RUNTIME-FAIL]
IF direct-call runtime detection fails, THEN THE OpenCode adapter SHALL return a non-retryable `runtime_error` containing the detection cause without consuming model retries or triggering formalization model-response degradation.

**Postcondition:** Runtime resolution does not pin executable bytes. Executable replacement during a run has no compatibility guarantee.

##### Evidence
- Implementation: [opencode-runtime.ts:125 resolveOpencodeRuntime()](/src/adapters/opencode-runtime.ts#L125), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443), [degradation.ts:80 decideBatchDegradation()](/src/domain/formal/degradation.ts#L80)
- Test: [opencode-runtime.test.ts:124 returns terminal runtime failure without response degradation](/test/contract/opencode-runtime.test.ts#L124)

#### Requirement model

```alloy
// --- Run-local runtime resolution ---
// Effects/Frames: none; descriptor selection is immutable and precedes retries.
pred oc_runtime_mismatch[c : OCCall] {
  // Guards: a supplied descriptor and an explicitly selected binary disagree.
  // Postcondition: reject the mismatch before probing or analysis.
  some oc_supplied_runtime[c]
  some c.selectedBinary
  c.selectedBinary != oc_supplied_runtime[c].evidence.command
}
// Safety: admitted concurrent runs own distinct descriptors and probe evidence.
assert oc_concurrent_runs_do_not_share_descriptors {
  all disj a, b : OCRun | oc_run_contract[a] and oc_run_contract[b] implies
    a.runtime != b.runtime and a.runtime.evidence != b.runtime.evidence
}
// Safety: invalid requests and descriptor mismatches cause no probe or resolution.
assert oc_resolution_failure_is_pre_spawn {
  all c : OCCall | oc_call_error[c] in OCInvalidModel + OCInvalidRequest + OCRuntimeMismatch and
    some oc_call_error[c] implies no oc_call_probes[c] and no oc_resolved_runtime[c]
}

// Pipeline calls inherit the run descriptor. Direct calls can still explicitly
// override a scope according to the separately modeled precedence contract.
pred oc_pipeline_call_contract[c : OCCall] {
  oc_run_contract[c.owner]
  oc_call_contract[c]
  no c.explicitRuntime
  c.scopedRuntime = c.owner.runtime
}
// Safety: pipeline calls reuse the run descriptor without another probe.
assert oc_pipeline_calls_reuse_one_run_probe {
  all c : OCCall | oc_pipeline_call_contract[c] and no oc_call_error[c] implies
    oc_resolved_runtime[c] = c.owner.runtime and no oc_call_probes[c]
}
// Safety: direct detection failure permits neither resolution nor model attempts.
assert oc_direct_detection_failure_is_terminal {
  all c : OCCall | oc_call_error[c] = OCRuntimeDetectionFailure implies
    no oc_resolved_runtime[c] and no oc_attempts_allowed[c]
}
```

### Requirement: Normalize OpenCode Model Selection [CAT-OC-MODEL]
WHEN resolving an effective model setting, THE spec-check tool SHALL normalize it into a base model and optional variant, enforce Luna=`max`, Terra=`high`, and Sol=`high` for `github-copilot/gpt-5.6-luna`, `github-copilot/gpt-5.6-terra`, and `github-copilot/gpt-6.1-sol` respectively, and use that same semantic selection for invocation and telemetry. WHEN neither CLI nor configuration selects a model, THE spec-check tool SHALL default to `github-copilot/gpt-6.1-sol#high`.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/proposal.md#Invariants`
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Model-Encoding`

#### Scenario: Preserve Bare Model Selection [CAT-OC-MODEL-BARE]
WHEN the effective model contains no `#` and satisfies existing nonempty-model validation, THE spec-check tool SHALL preserve its base value, apply the fixed variant for Luna/Terra/Sol, and leave other models without a forced variant.

##### Evidence
- Implementation: [opencode-model.ts:31 normalizeOpencodeModel()](/src/domain/opencode-model.ts#L31), [opencode-model.ts:17 variantForModel()](/src/domain/opencode-model.ts#L17)
- Test: [opencode.test.ts:213 selects only the preregistered model reasoning variants](/test/contract/opencode.test.ts#L213), [opencode.test.ts:219 passes the Luna max and Terra high variants to OpenCode](/test/contract/opencode.test.ts#L219)
- Test (property): [opencode-runtime.test.ts:139 preserves bare models and round-trips generated explicit selections](/test/contract/opencode-runtime.test.ts#L139)

#### Scenario: Accept Explicit Variant [CAT-OC-MODEL-EXPLICIT]
WHEN the effective model has exactly one `#`, no whitespace, a nonempty provider before the first `/`, a nonempty model after it, and a nonempty variant, THE spec-check tool SHALL preserve component case and additional model `/` characters and accept the explicit variant unless it conflicts with the fixed policy.

**Postcondition:** A matching fixed suffix is accepted. OpenCode, not `spec-check`, validates catalog availability for other models and variants.

##### Evidence
- Implementation: [opencode-model.ts:31 normalizeOpencodeModel()](/src/domain/opencode-model.ts#L31)
- Test (property): [opencode-runtime.test.ts:139 preserves bare models and round-trips generated explicit selections](/test/contract/opencode-runtime.test.ts#L139)
- Example:
```typescript
const { normalizeOpencodeModel } = await import("./src/domain/opencode-model.ts");
const selection = normalizeOpencodeModel("Provider/Family/Model#High"); //=> type Object
selection.ok; //=> true
selection.value.model; //=> Provider/Family/Model
selection.value.variant; //=> High
normalizeOpencodeModel("github-copilot/gpt-5.6-terra#high").ok; //=> true
```

#### Scenario: Reject Invalid Model Selection [CAT-OC-MODEL-INVALID]
IF the effective model is malformed or its explicit suffix conflicts case-sensitively with a fixed variant, THEN THE spec-check tool SHALL return `ConfigError` exit `3` before dependency work, and THE adapter for an equivalent invalid direct call SHALL return non-retryable `invalid_model` before any probe or analysis spawn.

**Postcondition:** Empty/whitespace-only components, an empty suffix, extra `#` separators, and whitespace in explicit references are rejected without silently trimming or changing case. Existing prompt/file/timeout request-shape failures likewise remain pre-spawn failures.

##### Evidence
- Implementation: [opencode-model.ts:31 normalizeOpencodeModel()](/src/domain/opencode-model.ts#L31), [config.ts:198 resolveRunConfig()](/src/cli/config.ts#L198), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443)
- Test: [opencode-runtime.test.ts:132 rejects invalid model before any process: %s](/test/contract/opencode-runtime.test.ts#L132), [opencode-compatibility.test.ts:116 rejects invalid effective model settings as ConfigError before dependencies](/test/contract/opencode-compatibility.test.ts#L116), [opencode.test.ts:367 rejects oversized instruction prompt before spawn](/test/contract/opencode.test.ts#L367), [opencode.test.ts:880 rejects invalid timeout below minimum (defense-in-depth)](/test/contract/opencode.test.ts#L880), [opencode.test.ts:970 rejects symlink files](/test/contract/opencode.test.ts#L970)
- Test (integration): [opencode-runtime.integration.test.ts:89 rejects unsupported dependencies with exit 4 and performs no analysis, while help/version never probe](/test/integration/opencode-runtime.integration.test.ts#L89)

#### Requirement model

```alloy
// --- Fixed model selection policy ---
// Effects/Frames: none; lexical validity is an external parser-test boundary.
pred oc_model_valid[m : OCModel] {
  // Guards: valid syntax and no conflict with a fixed reasoning variant.
  // Postcondition: normalized selection is admissible before subprocess work.
  m.lexicalValid = True
  (some m.explicitVariant and some oc_fixed_variant[m]) implies
    m.explicitVariant = oc_fixed_variant[m]
}
// Safety: accepted Luna/Terra/Sol selections preserve their fixed reasoning variants.
assert oc_fixed_variant_is_enforced {
  all m : OCModel | oc_model_valid[m] and some oc_fixed_variant[m] implies
    oc_normalized_variant[m] = oc_fixed_variant[m]
}
// Safety: an invalid model resolves neither a probe nor a runtime.
assert oc_invalid_model_never_probes {
  all c : OCCall | not oc_model_valid[c.model] implies
    oc_call_error[c] = OCInvalidModel and no oc_call_probes[c] and no oc_resolved_runtime[c]
}

// Effective settings select the named default only when CLI/config are absent.
one sig DefaultSolBase in OCText {}
sig EffectiveModelInput { cliModel : lone OCModel, fileModel : lone OCModel }
fun effective_model_base[i : EffectiveModelInput] : one OCText {
  some i.cliModel => i.cliModel.base else
    (some i.fileModel => i.fileModel.base else DefaultSolBase)
}
fun effective_model_variant[i : EffectiveModelInput] : lone OCVariant {
  some i.cliModel => oc_normalized_variant[i.cliModel] else
    (some i.fileModel => oc_normalized_variant[i.fileModel] else OCHigh)
}
// Safety: absent CLI/file selection resolves to the Sol/high default.
assert model_default_is_sol_high {
  all i : EffectiveModelInput | no i.cliModel + i.fileModel implies
    effective_model_base[i] = DefaultSolBase and effective_model_variant[i] = OCHigh
}
// CLI model rejection precedes discovery/dependency work; it is ConfigError
// exit 3, distinct from malformed JSON/shape (ConfigError exit 2).
pred config_invalid_model {
  CliValidate in RunState.completedPhases
  ConfigLoad not in RunState.completedPhases
  no RunState.lastOutcome
  Invocation.configRead in ConfigAbsent + ConfigValid
  Invocation.preflight.effectiveModelValid = False
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = ConfigError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}
abstract sig CLIExitCode {}
one sig ExitZero, ExitTwo, ExitThree, ExitFour extends CLIExitCode {}
fun terminal_exit : lone CLIExitCode {
  RunState.lastOutcome = CmdSuccess => ExitZero else
  (RunState.lastOutcome = DependencyError => ExitFour else
  (RunState.lastOutcome = ConfigError and Invocation.preflight.effectiveModelValid = False and
    Invocation.configRead in ConfigAbsent + ConfigValid => ExitThree else
  (some RunState.lastOutcome => ExitTwo else none)))
}
// Safety: invalid effective model selection stops before dependency work.
assert invalid_effective_model_stops_before_dependencies {
  always (config_invalid_model implies
    RunState.lastOutcome' = ConfigError and DependencyCheck not in RunState.completedPhases')
}
```

### Requirement: Encode Version Appropriate Model Calls [CAT-OC-INVOKE]
WHEN invoking OpenCode with a normalized model selection, THE OpenCode adapter SHALL encode the selected variant as separate `--model <base> --variant <variant>` arguments for v1 and as `--model <base>#<variant>` for v2, omit variant syntax when absent, and retain argv-only prompts, JSON output, validated attachments, and existing per-call timeout/retry budgets.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/proposal.md#Scope`
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Invocation-Protocol`

#### Scenario: Invoke Both Protocol Families [CAT-OC-INVOKE-FAMILY]
WHEN the same Terra model selection is invoked against v1 and v2 fixtures, THE adapter SHALL respectively pass `--model github-copilot/gpt-5.6-terra --variant high` and `--model github-copilot/gpt-5.6-terra#high`, preserving prompt and repeated-file identities under each verified argument ordering.

##### Evidence
- Implementation: [opencode-protocol.ts:17 buildOpencodeArgs()](/src/adapters/opencode-protocol.ts#L17), [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443)
- Test: [opencode-compatibility.test.ts:20 encodes major %s with exact validated attachment identity](/test/contract/opencode-compatibility.test.ts#L20)
- Test (integration): [opencode-runtime.integration.test.ts:43 runs compiled and bundled pipelines against major %s with one probe each](/test/integration/opencode-runtime.integration.test.ts#L43)

#### Scenario: Preserve Protocol Across Retries [CAT-OC-INVOKE-RETRY]
IF an invocation fails and existing policy permits a retry, THEN THE adapter SHALL reuse the same resolved runtime and normalized model selection without re-probing or trying another major's arguments.

##### Evidence
- Implementation: [opencode.ts:443 callOpencode()](/src/adapters/opencode.ts#L443), [opencode-protocol.ts:17 buildOpencodeArgs()](/src/adapters/opencode-protocol.ts#L17)
- Test: [opencode-runtime.test.ts:108 detects once per direct logical call and retains the protocol across retries](/test/contract/opencode-runtime.test.ts#L108)

#### Requirement model

```alloy
// --- Stable versioned invocation ---
// Effects/Frames: none; attempts project one already-resolved immutable call.
// Tests establish argv order, attachment identity, JSON and timeout/retry budgets.
// Safety: retries preserve runtime, wire protocol, base model and variant.
assert oc_retries_keep_protocol_and_model {
  all a, b : OCAttempt | a.call = b.call implies
    oc_attempt_runtime[a] = oc_attempt_runtime[b] and
    oc_attempt_encoding[a] = oc_attempt_encoding[b] and
    oc_attempt_base[a] = oc_attempt_base[b] and oc_attempt_variant[a] = oc_attempt_variant[b]
}
// Safety: resolution failure admits no model attempt.
assert oc_resolution_errors_consume_no_attempts {
  all c : OCCall | some oc_call_error[c] implies no oc_attempts_allowed[c]
}
```

### Requirement: Bound Owned Subprocess Termination [CAT-PROCESS-BOUND]
WHEN an external call reaches its timeout or capture limit, THE process adapter SHALL request termination of its owned process tree and SHALL finalize its own streams/result exactly once within a fixed 250 ms cleanup allowance after that request, without waiting indefinitely for descendant-held pipes, subject to Node event-loop scheduling.

**References:**
- `openspec/changes/archive/2026-10-21-support-opencode-v2/design.md#Review-Correction-Contracts`

**Ownership:** POSIX invocations own a newly created process group. Timeout/overflow terminates descendants that remain in that group, including when the immediate parent has already exited. Deliberately detached process groups and existing shared OpenCode services are outside this ownership. Windows uses bounded best-effort tree termination; Linux evidence does not establish Windows cleanup success.

#### Scenario: Terminate Owned Descendants [CAT-PROCESS-DESCENDANTS]
IF an owned descendant retains inherited stdout/stderr after timeout or capture overflow, THEN THE process adapter SHALL terminate the owned group and return the corresponding failure flags within the cleanup bound, including after immediate-parent exit.

##### Evidence
- Implementation: [process.ts:115 runProcess()](/src/adapters/process.ts#L115), [process.ts:167 killOwnedProcess()](/src/adapters/process.ts#L167), [process.ts:187 stopProcess()](/src/adapters/process.ts#L187), [process.ts:199 settleProcess()](/src/adapters/process.ts#L199)
- Test: [process-tree.test.ts:25 bounds %s while inherited pipes are held, and kills owned descendants](/test/contract/process-tree.test.ts#L25), [process-settlement.test.ts:22 settles overflow once despite competing stream errors (%s)](/test/contract/process-settlement.test.ts#L22)

#### Scenario: Bound Escaped Pipe Holders [CAT-PROCESS-PIPE-CLEANUP]
IF an out-of-group descendant retains a pipe after termination is requested, THEN THE process adapter SHALL destroy its own stream handles and settle within the cleanup allowance without claiming that the escaped process was contained or terminated.

##### Evidence
- Implementation: [process.ts:187 stopProcess()](/src/adapters/process.ts#L187), [process.ts:199 settleProcess()](/src/adapters/process.ts#L199)
- Test: [process-tree.test.ts:51 settles after bounded pipe cleanup even if a descendant deliberately escapes ownership](/test/contract/process-tree.test.ts#L51), [process-settlement.test.ts:40 retains the first termination cause and releases pipes when close never arrives](/test/contract/process-settlement.test.ts#L40)

#### Requirement model

```alloy
// --- Local process cleanup contract ---
// Effects/Frames: predicates classify values; RunState and inputs are unchanged.
// Tests establish OS termination and delivery of the 250ms cleanup callback.
// Guard: timeout or overflow. Postcondition: owned work requires termination.
pred oc_stop_required[p : OCCleanupInput] { p.timedOut = True or p.overflow = True }
// Guard: POSIX and required stop. Postcondition: request owned-group termination.
pred oc_requests_owned_group[p : OCCleanupInput] { oc_stop_required[p] and p.posix = True }
// Guard/Postcondition: settlement closes the adapter's own streams.
pred oc_own_streams_closed[s : OCCleanupStage] { s = OCSettled }
// Safety: settlement is absorbing and yields exactly one terminal result.
assert oc_settlement_is_absorbing {
  all p : OCCleanupInput | oc_cleanup_next[p, OCSettled] = OCSettled and
    one oc_cleanup_result[OCSettled] and oc_own_streams_closed[OCSettled]
}
// Local liveness: a delivered deadline callback settles despite pipe holders.
// Assumption: event-loop scheduling delivers the callback; no wall-clock proof.
assert oc_cleanup_callback_cannot_be_blocked_by_pipes {
  all p : OCCleanupInput | p.cleanupCallbackDelivered = True implies
    oc_cleanup_next[p, OCStopRequested] = OCSettled
}
// Safety: immediate-parent exit does not suppress required group termination.
assert oc_parent_exit_does_not_suppress_group_request {
  all p : OCCleanupInput | oc_stop_required[p] and p.posix = True and
    p.parentExited = True implies oc_requests_owned_group[p]
}
// No predicate claims escaped groups or shared services are terminated.
// Windows requests remain bounded best effort, without POSIX kill guarantees.
```

### Requirement: Separate Statements From Supporting Content [CAT-STATEMENT-SPANS]
WHEN the spec-check tool extracts requirement or scenario content, THE spec-check tool SHALL separate the statement, references, justification, postcondition, metadata, fenced models, evidence, and supplementary content with reversible source spans.

**References:**
- [Design: Source and identity](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#source-and-identity)

#### Scenario: Embedded Model Remains Separate [CAT-SPANS-FENCES]
WHEN a requirement block contains a fenced Alloy model or evidence section, THE spec-check tool SHALL retain it separately and SHALL omit it from EARS statement text and admitted SMT assumptions.

#### Scenario: Normalized Text Maps To Source [CAT-SPANS-NORMALIZE]
WHEN multiline text or CRLF input is normalized, THE spec-check tool SHALL retain original source mapping so every clause diagnostic identifies its source range without inventing line positions.

#### Scenario: Source Statement Limit Is Visible [CAT-SPANS-BOUND]
IF a statement exceeds the effective byte bound of 65,536 bytes by default, THEN THE spec-check tool SHALL preserve its source reference and SHALL emit an explicit eligibility limitation before model work.

#### Requirement model

```alloy
// --- Source extraction boundary contract ---
// Preconditions: raw fragments and source-map observations belong to the file.
// Effects/Frames: none; all retained source objects are immutable.
// The bound is an observed comparison against the effective limit (default
// 65,536 UTF-8 bytes), avoiding overflow in Alloy's bounded integer arithmetic.
// Source-map round trips, point ordering, exact clause subranges and original
// spelling are established by parser contract/property tests. Alloy checks
// item ownership, per-fragment map coverage and file provenance, not the lexer.
fun statement_fragments[r : Requirement] : set SourceFragment {
  { f : r.fragments | f.role = StatementContent }
}
fun supporting_fragments[r : Requirement] : set SourceFragment {
  r.fragments - statement_fragments[r]
}
pred fragment_contract[r : Requirement] {
  r.fragments.file in r.doc.source
  some statement_fragments[r]
  r.escapeHatch = True iff some f : r.fragments | f.role = JustificationContent
  // Each fragment owns its modeled normalized offset domain, including the
  // exclusive end. Synthetic join spaces may share a source position; totality
  // is not an injectivity or exact-reversibility proof. Oversized input retains
  // source evidence without requiring an unbounded per-character map.
  r.withinBound = True implies all f : statement_fragments[r] |
    all n : f.normalizedOffsets | one n.(f.offsetMap)
  all k : r.declaredKinds | k.fragment in r.fragments and k.fragment.role = MetadataContent
}
pred clause_contract[r : Requirement] {
  r.clauses.fragment in statement_fragments[r]
  no r.clauses implies not ears_structure_supported[r]
  ears_structure_supported[r] implies {
    one c : r.clauses | c.role = SubjectClause
    one c : r.clauses | c.role = ResponseClause
    all cr : ClauseRole | lone c : r.clauses | c.role = cr
    let drivers = r.clauses - { c : r.clauses | c.role in SubjectClause + ResponseClause } | {
      r.observedForm = Ubiquitous implies no drivers
      r.observedForm = StateDriven implies drivers.role = StateClause
      r.observedForm = EventDriven implies drivers.role = TriggerClause
      r.observedForm = UnwantedBehavior implies drivers.role = ConditionClause
      r.observedForm = OptionalFeature implies drivers.role = FeatureClause
      r.observedForm = Complex implies drivers.role = StateClause + TriggerClause
    }
    all c : r.clauses | {
      c.priorClause in r.clauses
      c not in c.priorClause
      c.priorClause.priorClause in c.priorClause
      c.role = ResponseClause implies c.priorClause = r.clauses - c
      c.role = SubjectClause implies c.priorClause.role =
        r.clauses.role - SubjectClause - ResponseClause
      c.role = TriggerClause and r.observedForm = Complex implies c.priorClause.role = StateClause
    }
  }
}
// Parser-side candidate predicate slots, not solver-admitted assumptions.
// Selected merged-view authority, predicate validation and query prerequisites
// belong to the downstream capability models. Scenario postconditions supply
// a scoped slot alongside the response, expected, or forbidden predicate.
fun candidate_predicate_fragments[r : Requirement] : set SourceFragment {
  not surface_eligible[r] => none else
  ((scenario_form[r] = ExampleForm => { f : r.fragments | f.role in InputContent + ExpectedContent } else
  (scenario_form[r] = ProhibitedExampleForm => { f : r.fragments | f.role in InputContent + ForbiddenContent } else
     statement_fragments[r])) +
    (r.scenario = True => fields[r, PostconditionContent] else none))
}
// Safety: supporting prose/models cannot become candidate predicate slots.
assert supporting_prose_never_becomes_predicate_slots {
  all r : Requirement | no candidate_predicate_fragments[r] &
    { f : r.fragments | f.role in ReferenceContent + JustificationContent +
      MetadataContent + FencedContent + EvidenceContent + SupplementaryContent }
}
// Safety: oversized statements retain source evidence without predicate slots.
assert oversized_source_is_preserved_and_excluded {
  always (Parse in RunState.completedPhases implies all r : Requirement |
    r.doc in RunState.parsedDocs and r.withinBound = False implies
      some statement_fragments[r] and StatementLimit in surface_issues[r] and
      no candidate_predicate_fragments[r])
}
// Safety: clause observations refer to their item's original file.
assert clause_spans_belong_to_original_file {
  always (Parse in RunState.completedPhases implies all r : Requirement |
    r.doc in RunState.parsedDocs implies r.clauses.fragment.file in r.doc.source)
}
```

### Requirement: Admit Explicit Alternative And Scenario Forms [CAT-FORMAL-DISPOSITION]
WHEN the spec-check tool evaluates a non-EARS representation or scenario, THE spec-check tool SHALL record its supported formal disposition and SHALL preserve unsupported content with a reason.

**References:**
- [Design: Surface grammar and annotations](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#surface-grammar-and-annotations)

#### Scenario: Justification Does Not Supply Semantics [CAT-FORMAT-JUSTIFIED]
IF a non-EARS requirement has `**Format justification:**` but no supported formal representation, THEN THE spec-check tool SHALL retain the justification and SHALL mark formalization unsupported rather than guess its logical structure.

#### Scenario: Scenario Refinement Is The Default [CAT-SCENARIO-DEFAULT]
WHEN an EARS scenario has no explicit scenario-kind metadata, THE spec-check tool SHALL classify it as a refinement and SHALL retain its postcondition scoped to that scenario.

#### Scenario: Explicit Examples Are Distinguished [CAT-SCENARIO-EXAMPLE]
WHEN a scenario declares `**Scenario kind:** example` or `prohibited-example`, THE spec-check tool SHALL classify it accordingly and SHALL require source-spanned `**Input:**` and respectively `**Expected:**` or `**Forbidden:**` fields for separate predicate formalization before solver admission.

#### Scenario: Invalid Metadata Remains Visible [CAT-SCENARIO-METADATA]
IF scenario-kind metadata is unknown or duplicated, THEN THE spec-check tool SHALL preserve it and SHALL diagnose the ambiguity instead of choosing a kind silently.

#### Requirement model

```alloy
// --- Formal disposition and downstream admission ---
// Preconditions: structured fields and metadata remain source-owned.
// Invalid/duplicate kind declarations have no silently selected semantic kind.
fun scenario_form[r : Requirement] : one ScenarioDisposition {
  no r.declaredKinds => RefinementForm else
    (one r.declaredKinds and r.declaredKinds.value != UnknownScenarioForm =>
      r.declaredKinds.value else UnknownScenarioForm)
}
fun fields[r : Requirement, fr : FragmentRole] : set SourceFragment {
  { f : r.fragments | f.role = fr }
}
fun metadata_issues[r : Requirement] : set SurfaceIssueKind {
  (scenario_form[r] = UnknownScenarioForm => MetadataAmbiguous else none) +
  ((scenario_form[r] = ExampleForm and
    (no fields[r, InputContent] or no fields[r, ExpectedContent] or some fields[r, ForbiddenContent])) =>
      MissingExampleFields else none) +
  ((scenario_form[r] = ProhibitedExampleForm and
    (no fields[r, InputContent] or no fields[r, ForbiddenContent] or some fields[r, ExpectedContent])) =>
      MissingExampleFields else none)
}
pred disposition_contract[r : Requirement] {
  // Supported alternative semantics are an external representation-validator
  // observation. A justification is required but cannot itself supply semantics.
  r.supportedAlternative = True implies
    r.escapeHatch = True and some fields[r, StatementContent]
}
// Safety: justification alone cannot make unsupported non-EARS content eligible.
assert justification_alone_is_not_formal_semantics {
  all r : Requirement | r.escapeHatch = True and no r.observedForm and
    r.supportedAlternative = False and scenario_form[r] = RefinementForm implies
      not surface_eligible[r] and UnsupportedRepresentation in surface_issues[r]
}
// Safety: ambiguous scenario-kind metadata prevents eligibility.
assert invalid_metadata_is_excluded {
  all r : Requirement | scenario_form[r] = UnknownScenarioForm implies
    MetadataAmbiguous in surface_issues[r] and not surface_eligible[r]
}
// Safety: eligible examples retain Input and the matching outcome field.
assert examples_require_matching_source_fields {
  all r : Requirement | surface_eligible[r] implies {
    scenario_form[r] = ExampleForm implies
      some fields[r, InputContent] and some fields[r, ExpectedContent] and no fields[r, ForbiddenContent]
    scenario_form[r] = ProhibitedExampleForm implies
      some fields[r, InputContent] and some fields[r, ForbiddenContent] and no fields[r, ExpectedContent]
  }
}

// Safety: surface exclusion produces no candidate predicate slots.
assert excluded_items_have_no_predicate_slots {
  all r : Requirement | not surface_eligible[r] implies
    no candidate_predicate_fragments[r]
}
// Safety: an eligible scenario's postcondition remains an item-local slot.
assert scenario_postconditions_are_scoped {
  all r : Requirement | parser_item_contract[r] and r.scenario = True and
    surface_eligible[r] implies {
      fields[r, PostconditionContent] in candidate_predicate_fragments[r]
      all p : Requirement - r | no fields[r, PostconditionContent] &
        candidate_predicate_fragments[p]
    }
}
// Safety: bounded statements map precisely their own modeled offset domain.
assert statement_maps_cover_owned_offsets {
  all r : Requirement | fragment_contract[r] and r.withinBound = True implies
    all f : statement_fragments[r] | (f.offsetMap).SourcePoint = f.normalizedOffsets
}
// Sampling and queries consume selected merged items, not all parsed items.
// Their lifecycle is specified in merged-capability-analysis and formalization-
// and-logic-analysis; this parser contract does not invent an independent run.
```

### State machine and invariant checks
```alloy
// --- Transition system ---

pred stutter {
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred init_state {
  no RunState.completedPhases
  no RunState.findings
  no RunState.catalog
  no RunState.activeCatalog
  no RunState.parsedDocs
  no RunState.lastOutcome
  no RunState.emptyCatalogReason
}

fact transitions {
  init_state and always (
    // CLI validation (per-scenario failure predicates)
    cli_informational
    or cli_rejected_missing_input
    or cli_rejected_bad_flag
    or cli_rejected_output_inside_src
    or cli_rejected_timeout_range
    or cli_validate_success
    // Config (per-scenario failure predicates)
    or config_load_success
    or config_load_fail_invalid_json
    or config_load_fail_bad_structure
    or config_invalid_model
    // Discovery: success, unreadable, and 3 empty-catalog causes
    or discover_success
    or (some p : InputPath | discover_reject_unreadable[p])
    or discover_empty_no_docs
    or discover_empty_all_archived
    or discover_empty_all_filtered
    // Dependencies (per-dependency failure predicates)
    or deps_check_success
    or deps_missing_opencode
    or deps_missing_z3
    // Parse (includes delta-operation and scenario-parent assignment)
    or parse_phase
    // Structural validation
    or struct_validate_phase
    // Emit
    or emit_phase
    // Stutter
    or stutter
  )
}

// --- Scenario commands ---

run show_spec_check {} for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 8 steps

run scenario_full_pipeline {
  always progress_emission_contract
  some r : Requirement | r.observedForm = Complex and surface_eligible[r] and
    eventually (Emit in RunState.completedPhases and r.doc in RunState.parsedDocs)
} for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 4 SourceClause, 14 ProgressEvent, 10 steps expect 1

run scenario_config_failure_stops_pipeline {
  eventually (RunState.lastOutcome = ConfigError)
} for 3 but 2 InputPath, 2 Artifact, 1 Capability, 2 Finding, 2 ParsedDoc, 1 Requirement, 14 ProgressEvent, 5 steps

run scenario_empty_catalog_no_docs {
  eventually (RunState.emptyCatalogReason = NoRecognizedDocs)
} for 3 but 2 InputPath, 2 Artifact, 1 Capability, 2 Finding, 2 ParsedDoc, 1 Requirement, 14 ProgressEvent, 5 steps

run scenario_empty_catalog_all_archived {
  eventually (RunState.emptyCatalogReason = AllArchived)
} for 3 but 2 InputPath, 3 Artifact, 1 Capability, 2 Finding, 2 ParsedDoc, 1 Requirement, 14 ProgressEvent, 5 steps

run scenario_empty_catalog_all_filtered {
  eventually (RunState.emptyCatalogReason = AllFiltered)
} for 3 but 2 InputPath, 3 Artifact, 1 Capability, 2 Finding, 2 ParsedDoc, 1 Requirement, 14 ProgressEvent, 5 steps

run scenario_delta_conflict_surfaced {
  eventually (some f : RunState.findings | f.kind = DeltaConflict)
} for 3 but 3 InputPath, 4 Artifact, 2 Capability, 4 Finding, 2 ParsedDoc, 2 Requirement, 14 ProgressEvent, 8 steps

run scenario_finalized_delta_warning {
  eventually (some f : RunState.findings | f.kind = DeltaHeadingWarning)
} for 3 but 2 InputPath, 3 Artifact, 1 Capability, 4 Finding, 2 ParsedDoc, 2 Requirement, 14 ProgressEvent, 8 steps

run scenario_pre_section_warning {
  eventually (some f : RunState.findings | f.kind = PreSectionWarning)
} for 3 but 2 InputPath, 3 Artifact, 1 Capability, 4 Finding, 2 ParsedDoc, 2 Requirement, 14 ProgressEvent, 8 steps

run scenario_dep_failure {
  eventually (RunState.lastOutcome = DependencyError)
} for 3 but 2 InputPath, 2 Artifact, 1 Capability, 2 Finding, 1 ParsedDoc, 1 Requirement, 14 ProgressEvent, 5 steps

run scenario_timeout_rejection {
  eventually (cli_rejected_timeout_range)
} for 3 but 1 InputPath, 1 Artifact, 1 Capability, 1 Finding, 1 ParsedDoc, 1 Requirement, 14 ProgressEvent, 3 steps

// --- Safety checks ---

check cli_rejection_blocks_analysis for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check informational_no_analysis for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check timeout_rejection_is_input_error for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check invalid_config_blocks_downstream for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check config_failure_outcome for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check archived_never_active for 3 but 3 InputPath, 4 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 15 steps expect 0
check at_most_one_delta_per_capability for 3 but 3 InputPath, 4 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 15 steps expect 0
check empty_catalog_exactly_one_cause for 3 but 3 InputPath, 4 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check empty_catalog_stops_downstream for 3 but 3 InputPath, 4 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check delta_conflicts_surfaced for 3 but 3 InputPath, 4 Artifact, 2 Capability, 5 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 15 steps expect 0
check no_llm_without_opencode for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check no_solver_without_z3 for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check dep_failure_outcome for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check violations_produce_findings for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check headless_excluded_from_downstream for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check identifier_errors_surfaced for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check non_ears_produces_finding for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 4 SourceClause, 14 ProgressEvent, 10 steps expect 0
check delta_op_always_assigned for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 4 SourceClause, 14 ProgressEvent, 10 steps expect 0
check finalized_always_base for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 4 SourceClause, 14 ProgressEvent, 10 steps expect 0
check scenario_inherits_parent_delta for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 4 SourceClause, 14 ProgressEvent, 10 steps expect 0
check pre_section_never_promoted for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 4 SourceClause, 14 ProgressEvent, 10 steps expect 0
check no_silent_parser_loss for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 10 steps expect 0
check findings_monotonic for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 15 steps expect 0
check parsed_sources_are_unique for 3 but 3 InputPath, 4 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 4 SourceClause, 14 ProgressEvent, 10 steps expect 0
check completed_phases_monotonic for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 15 steps expect 0
check phase_ordering_respected for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 15 steps expect 0
check fatal_outcome_freezes_pipeline for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 15 steps expect 0
check success_requires_all_phases for 3 but 3 InputPath, 3 Artifact, 2 Capability, 4 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 15 steps expect 0
check no_silent_hang for 3 but 3 InputPath, 4 Artifact, 2 Capability, 5 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 15 steps expect 0
check pipeline_progress_liveness for 3 but 3 InputPath, 4 Artifact, 2 Capability, 6 Finding, 3 ParsedDoc, 3 Requirement, 14 ProgressEvent, 20 steps expect 0

// --- Compatibility boundary witnesses ---
// Structural checks use one state; existing pipeline bounds are unchanged.

run oc_supported_release_witness {
  some p : OCProbe | oc_version_ok[p] and p.reportedMajor = OCMajor2
} for 3 but 1 steps expect 1

run oc_v2_variant_witness {
  some a : OCAttempt | a in oc_attempts_allowed[a.call] and
    a.call.model.modelClass = OCHighPolicyModel and oc_attempt_encoding[a] = OCHashVariant
} for 3 but 1 steps expect 1

run oc_escaped_pipe_cleanup_witness {
  some p : OCCleanupInput | oc_stop_required[p] and p.escapedPipeHolder = True and
    p.cleanupCallbackDelivered = True and
    oc_cleanup_next[p, oc_cleanup_next[p, OCExecuting]] = OCSettled
} for 3 but 1 steps expect 1

// --- Compatibility safety checks ---

check oc_dependency_failure_blocks_admission for 3 but 1 steps expect 0
check oc_informational_has_no_probes for 3 but 1 steps expect 0
check oc_z3_failure_is_exit4 for 3 but 1 steps expect 0
check oc_accepted_version_is_supported for 3 but 1 steps expect 0
check oc_signal_is_spawn_error for 3 but 1 steps expect 0
check oc_concurrent_runs_do_not_share_descriptors for 3 but 1 steps expect 0
check oc_resolution_failure_is_pre_spawn for 3 but 1 steps expect 0
check oc_fixed_variant_is_enforced for 3 but 1 steps expect 0
check oc_invalid_model_never_probes for 3 but 1 steps expect 0
check oc_retries_keep_protocol_and_model for 3 but 1 steps expect 0
check oc_resolution_errors_consume_no_attempts for 3 but 1 steps expect 0
check oc_settlement_is_absorbing for 3 but 1 steps expect 0
check oc_parent_exit_does_not_suppress_group_request for 3 but 1 steps expect 0

// --- Local liveness check ---
// Conditional on callback delivery; no additional pipeline fairness assumption.

check oc_cleanup_callback_cannot_be_blocked_by_pipes for 3 but 1 steps expect 0

// --- New surface-contract checks and nonvacuity witnesses ---
// Event atoms are immutable records (up to two per successful phase); provide
// enough scope to exercise a complete pipeline rather than vacuous checks.
run surface_where_disabled_witness {
  some r : Requirement | r.observedForm = OptionalFeature and
    parser_item_contract[r] and ears_structure_supported[r] and ParserOptions.whereEnabled = False and
    WhereDisabled in surface_issues[r] and not surface_eligible[r]
} for 3 but 1 steps expect 1
run surface_orphan_witness {
  some r : Requirement | parser_item_contract[r] and r.scenario = True and no enclosing_requirement[r]
} for 3 but 1 steps expect 1
run surface_duplicate_metadata_witness {
  some r : Requirement | parser_item_contract[r] and #r.declaredKinds = 2 and
    r.declaredKinds.value = ExampleForm and scenario_form[r] = UnknownScenarioForm and
    not surface_eligible[r]
} for 3 but 1 steps expect 1
run surface_example_slots_witness {
  some r : Requirement | r.scenario = True and scenario_form[r] = ExampleForm and
    surface_eligible[r] and some fields[r, PostconditionContent] and
    eventually (Parse in RunState.completedPhases and r.doc in RunState.parsedDocs)
} for 3 but 5 SourceFragment, 14 ProgressEvent, 10 steps expect 1
run surface_prohibited_example_slots_witness {
  some r : Requirement | r.scenario = True and scenario_form[r] = ProhibitedExampleForm and
    surface_eligible[r] and some fields[r, PostconditionContent] and
    eventually (Parse in RunState.completedPhases and r.doc in RunState.parsedDocs)
} for 3 but 5 SourceFragment, 14 ProgressEvent, 10 steps expect 1
run surface_refinement_postcondition_witness {
  some r : Requirement | r.scenario = True and scenario_form[r] = RefinementForm and
    surface_eligible[r] and some fields[r, PostconditionContent] and
    eventually (Parse in RunState.completedPhases and r.doc in RunState.parsedDocs)
} for 3 but 4 SourceClause, 14 ProgressEvent, 10 steps expect 1

// Exercise each supported grammar form under the actual completed parse contract.
pred parsed_form_witness[form : EarsType] {
  some r : Requirement | r.observedForm = form and ears_structure_supported[r] and
    surface_eligible[r] and
    eventually (Parse in RunState.completedPhases and r.doc in RunState.parsedDocs)
}
run parsed_ubiquitous_witness { parsed_form_witness[Ubiquitous] }
  for 3 but 4 SourceClause, 14 ProgressEvent, 10 steps expect 1
run parsed_state_witness { parsed_form_witness[StateDriven] }
  for 3 but 4 SourceClause, 14 ProgressEvent, 10 steps expect 1
run parsed_event_witness { parsed_form_witness[EventDriven] }
  for 3 but 4 SourceClause, 14 ProgressEvent, 10 steps expect 1
run parsed_unwanted_witness { parsed_form_witness[UnwantedBehavior] }
  for 3 but 4 SourceClause, 14 ProgressEvent, 10 steps expect 1
run parsed_complex_witness { parsed_form_witness[Complex] }
  for 3 but 4 SourceClause, 14 ProgressEvent, 10 steps expect 1
run parsed_where_enabled_witness {
  ParserOptions.whereEnabled = True
  parsed_form_witness[OptionalFeature]
} for 3 but 4 SourceClause, 14 ProgressEvent, 10 steps expect 1
run fragment_local_maps_witness {
  some r : Requirement | fragment_contract[r] and r.withinBound = True and
    some disj a, b : statement_fragments[r] |
      some a.normalizedOffsets and some b.normalizedOffsets and
      no a.normalizedOffsets & b.normalizedOffsets
} for 3 but 1 steps expect 1
run surface_ineligible_parent_witness {
  some r : Requirement | r.scenario = True and some r.parentReqId and
    not surface_eligible[r.parentReqId] and
    eventually (Parse in RunState.completedPhases and r.doc in RunState.parsedDocs)
} for 3 but 5 SourceFragment, 14 ProgressEvent, 10 steps expect 1
run success_path_fairness_witness {
  pipeline_fairness
} for 3 but 14 ProgressEvent, 10 steps expect 1

check empty_cause_is_total_and_preserves_rationale for 3 but 1 steps expect 0
check archive_remediation_is_relevant for 3 but 1 steps expect 0
check equals_syntax_equivalence for 3 but 1 steps expect 0
check cli_settings_take_precedence for 3 but 1 steps expect 0
check file_settings_fill_missing_cli_values for 3 but 1 steps expect 0
check model_default_is_sol_high for 3 but 1 steps expect 0
check malformed_or_disabled_forms_never_admitted for 3 but 4 SourceClause, 1 steps expect 0
check only_exact_unfenced_headings_change_delta_context for 4 but 1 steps expect 0
check supporting_prose_never_becomes_predicate_slots for 4 but 1 steps expect 0
check justification_alone_is_not_formal_semantics for 3 but 1 steps expect 0
check invalid_metadata_is_excluded for 3 but 1 steps expect 0
check examples_require_matching_source_fields for 4 but 1 steps expect 0
check explicitly_admitted_archives_only for 3 but 14 ProgressEvent, 10 steps expect 0
check scenario_parent_is_independent_of_eligibility for 3 but 4 SourceClause, 14 ProgressEvent, 10 steps expect 0
check every_unmatched_fragment_is_evidence for 3 but 14 ProgressEvent, 10 steps expect 0
check oversized_source_is_preserved_and_excluded for 3 but 14 ProgressEvent, 10 steps expect 0
check clause_spans_belong_to_original_file for 3 but 4 SourceClause, 14 ProgressEvent, 10 steps expect 0
check phase_transitions_emit_json_progress for 3 but 14 ProgressEvent, 10 steps expect 0
check fatal_phase_has_failure_event for 3 but 14 ProgressEvent, 10 steps expect 0
check invalid_effective_model_stops_before_dependencies for 3 but 14 ProgressEvent, 10 steps expect 0
check excluded_items_have_no_predicate_slots for 3 but 1 steps expect 0
check scenario_postconditions_are_scoped for 3 but 5 SourceFragment, 4 SourceClause, 1 steps expect 0
check statement_maps_cover_owned_offsets for 3 but 1 steps expect 0
check all_headless_inputs_stop_with_evidence for 3 but 14 ProgressEvent, 10 steps expect 0
check oc_timeout_and_overflow_have_priority for 3 but 1 steps expect 0
check oc_pipeline_calls_reuse_one_run_probe for 3 but 1 steps expect 0
check oc_direct_detection_failure_is_terminal for 3 but 1 steps expect 0

run all_headless_failure_witness {
  eventually (struct_validate_phase and
    (no d : RunState.parsedDocs | d.hasHeadings = True) and some RunState.parsedDocs)
} for 3 but 14 ProgressEvent, 10 steps expect 1
```
