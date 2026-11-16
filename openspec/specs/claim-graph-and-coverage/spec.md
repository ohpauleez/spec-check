---
title: ClaimGraphAndCoverage
---

## Purpose

Define the claim graph construction and coverage analysis behavior for the spec-check tool: normalizing parsed content into typed claims and analyzing coverage, contradiction, and semantic alignment across proposal, design, and capability specs.

All Alloy fences in this document form one Alloy 6 module in document order. Text, spans, clauses, metadata, and semantic comparisons are abstract values; equality checks preservation, while parser differential and serialization tests establish their concrete meaning. Merged views are immutable results supplied by the authoritative merged-capability-analysis contract; this model checks their handoff, not merge application or collision resolution. Empty capabilities retain merge-layer skip findings only. Catalog resolution may select no capabilities (for example, proposal-only analysis). Malformed claims remain reviewable in a separate rejected-input set and never enter the ordinary graph or coverage conclusions.

```alloy
module ClaimGraphAndCoverage
open util/boolean

// --- Domain vocabulary ---

// Artifacts are the documents that contain claims
abstract sig Artifact {}
sig Proposal, Design, CapabilitySpec, TaskFile extends Artifact {}

// Sections within artifacts provide provenance anchoring
sig Section {
  artifact : one Artifact
}

// Provenance: the source location of a claim
sig Provenance {
  sourceFile : one Artifact,
  sourceSection : one Section
} {
  sourceSection.artifact = sourceFile
}

// Obligation levels (EARS structural-modal classification)
abstract sig ObligationLevel {}
one sig Mandatory, Advisory, Informational extends ObligationLevel {}

// Claim kinds
abstract sig ClaimKind {}
one sig Behavioral, Structural, Constraint extends ClaimKind {}

// --- Delta operations and selected merge-result boundary ---

// Delta operations from the OpenSpec authoring model
abstract sig DeltaOperation {}
one sig DeltaBase, DeltaPreSection, DeltaAdded, DeltaModified,
        DeltaRemoved, DeltaRenamed extends DeltaOperation {}

// A parsed requirement with its delta operation context
sig ParsedRequirement {
  reqIdentifier : lone ReqIdentifier,
  reqDeltaOp : one DeltaOperation,
  reqSourceFile : one Artifact,
  reqCapability : one Capability
}

// Parsed scenarios retain block ownership independently of claim eligibility.
sig ParsedScenario {
  scenarioParent : lone ParsedRequirement,
  scenarioCapability : one Capability,
  scenarioDeltaOp : one DeltaOperation
}

// Requirement identifiers for delta matching
sig ReqIdentifier {}

// Merged capability spec: immutable handoff from the authoritative merge model.
// Bookkeeping sets describe supplied outcomes; they are not production fields
// or a second implementation of first-wins matching/collision resolution.
sig MergedCapabilitySpec {
  mergeSource : one Capability,
  activeReqs : set ParsedRequirement,
  removedBaseReqs : set ParsedRequirement,
  replacedBaseReqs : set ParsedRequirement,
  appliedDeltas : set ParsedRequirement,
  removalTargets : ParsedRequirement -> lone ParsedRequirement,
  replacementTargets : ParsedRequirement -> lone ParsedRequirement,
  skippedReqs : set ParsedRequirement,
  activeScenarios : set ParsedScenario,
  mergeFindings : set MergeFinding,
  isEmpty : one Bool
} {
  // Exclusion: removed, replaced and skipped blocks cannot remain active.
  disj[activeReqs, removedBaseReqs, replacedBaseReqs, skippedReqs]
  // All reqs trace back to this capability
  (activeReqs + removedBaseReqs + replacedBaseReqs + appliedDeltas + skippedReqs).reqCapability in mergeSource
  // isEmpty reflects zero active requirements
  isEmpty = True iff no activeReqs
}

// Merge-phase findings (distinct from coverage findings)
abstract sig MergeFindingKind {}
one sig MergeModNotFound, MergeRemNotFound, MergeDupId,
        MergePreSectionContent, MergeStandaloneScenario,
        MergeRenameUnsupported, MergeEmptyCapSkipped extends MergeFindingKind {}

sig MergeFinding {
  mfKind : one MergeFindingKind,
  mfAffectedReq : lone ParsedRequirement,
  mfAffectedScenario : lone ParsedScenario
}

// --- Claims ---

// A typed claim: the core unit of the claim graph
sig Claim {
  source : one SourceItem,
  text : one SourceText,
  statementSpans : set SourceSpan,
  clauses : set Clause,
  scenarioMetadata : lone ScenarioMetadata,
  supportingContent : set SupportingContent,
  references : set Reference,
  disposition : one FormalDisposition,
  permission : one Bool,
  responseNegated : one Bool,
  kind : one ClaimKind,
  obligation : one ObligationLevel,
  provenance : lone Provenance,
  capability : lone Capability    // populated for spec-derived claims
}

// Finding severity levels (ordered)
abstract sig Severity {}
one sig High, Medium, Low extends Severity {}

// Finding kinds emitted by analysis
abstract sig FindingKind {}
one sig CoverageGap, Contradiction, SemanticDrift,
        MissingSpecFile, UnsupportedRef, TaskConflict,
        TaskGap, AnalysisDefect, EmptyCapSkipped extends FindingKind {}

// A finding: the result of coverage analysis
sig Finding {
  findingKind : one FindingKind,
  severity : one Severity,
  upstream : lone Claim,
  downstream : lone Claim,
  affectedCapability : lone Capability,  // for capability-level findings
  affectedReference : lone Reference,
  omissions : set DocumentedDetail,
  var emitted : one Bool
}

// Structural constraints on findings: severity must respect obligation level
// and evidence fields must be populated correctly per finding kind.
fact finding_wellformedness {
  // Severity ceiling for upstream-violation findings (coverage gap, contradiction, drift):
  // severity is determined by the upstream claim's obligation level
  all f : Finding |
    (f.findingKind in (Contradiction + CoverageGap + SemanticDrift) and some f.upstream) implies {
      f.upstream.obligation = Mandatory implies f.severity = High
      f.upstream.obligation = Advisory implies f.severity in (Medium + Low)
      f.upstream.obligation = Informational implies f.severity = Low
    }
  // TaskConflict severity is based on the downstream (spec) claim's obligation
  all f : Finding |
    (f.findingKind = TaskConflict and some f.downstream) implies {
      f.downstream.obligation = Mandatory implies f.severity = High
      f.downstream.obligation = Advisory implies f.severity in (Medium + Low)
      f.downstream.obligation = Informational implies f.severity = Low
    }
  // Contradiction and drift findings always cite both sides
  all f : Finding |
    f.findingKind in (Contradiction + SemanticDrift + TaskConflict) implies
      (some f.upstream and some f.downstream)
  // Coverage gap and defect findings always cite the upstream claim
  all f : Finding |
    f.findingKind in (CoverageGap + TaskGap + AnalysisDefect + UnsupportedRef) implies
      some f.upstream
  // Archived references never produce UnsupportedRef findings
  all f : Finding |
    f.findingKind = UnsupportedRef implies {
      some f.affectedReference
      f.upstream = f.affectedReference.refSource
      f.affectedReference.isArchived = False
    }
  all f : Finding | f.findingKind != UnsupportedRef implies no f.affectedReference
  all f : Finding | f.findingKind != SemanticDrift implies no f.omissions
  all f : Finding | f.findingKind = SemanticDrift implies some f.omissions
  // EmptyCapSkipped findings reference the affected capability, not claims
  all f : Finding |
    f.findingKind = EmptyCapSkipped implies
      (no f.upstream and no f.downstream and some f.affectedCapability)
}

// Bool (via the module import) for tracking emission state

// Capability identity may exist without a proposal in spec-only analysis.
sig Capability {
  declaredIn : lone Proposal,
  specFile : lone CapabilitySpec,
  mergedView : lone MergedCapabilitySpec
}

// References from requirements to upstream content
sig Reference {
  refSource : one Claim,       // the claim that declares the reference
  refTarget : lone Section,    // absent for unresolved links; citation still retained
  citation : one SourceText,
  semanticSupport : one Bool,
  isArchived : one Bool        // whether citation is in changes/archive/
}

// Coverage relation: semantic alignment between claims
sig CoverageLink {
  upstreamClaim : one Claim,
  downstreamClaim : one Claim,
  partial : one Bool,          // whether coverage is only partial
  omittedDetails : set DocumentedDetail
}

abstract sig DocumentedDetail {}
sig DocumentedConstraint, DocumentedFailureMode, BoundaryCondition extends DocumentedDetail {}
fact partial_link_evidence {
  all link : CoverageLink | link.partial = True iff some link.omittedDetails
}

// --- Merge well-formedness constraints ---

// Each capability has at most one merged view
fact one_merged_view_per_capability {
  all c : Capability | lone c.mergedView
}

// Structural consistency: capabilities with spec files always have merged views
// (the merge phase is deterministic and always produces a result)
fact merge_always_produces_result {
  all cap : Capability | some cap.specFile implies some cap.mergedView
}

// Bidirectional consistency: mergedView and mergeSource are inverses
fact merged_view_consistency {
  all cap : Capability, mc : MergedCapabilitySpec |
    cap.mergedView = mc iff mc.mergeSource = cap
}

// Analysis requires a non-empty workspace (at least one artifact/section)
fact nonempty_analysis_input {
  some Artifact
  some Section
}

// Delta requirements in active set have non-excluded operations
fact active_reqs_have_valid_ops {
  all mc : MergedCapabilitySpec, r : mc.activeReqs |
    r.reqDeltaOp in (DeltaBase + DeltaAdded + DeltaModified)
}

// Removed/replaced base blocks: abstract bookkeeping for accepted operations.
// REMOVED instructions are separately recorded in appliedDeltas.
fact retired_blocks_are_base_requirements {
  all mc : MergedCapabilitySpec |
    (mc.removedBaseReqs + mc.replacedBaseReqs).reqDeltaOp in DeltaBase
}

// Upstream claims (proposal/design/task) never carry capability identity
// Capability identity is only for spec-derived claims
fact upstream_claims_no_capability {
  all c : Claim |
    (some c.provenance and c.provenance.sourceFile in (Proposal + Design + TaskFile))
      implies no c.capability
}

// PreSection and Renamed requirements never appear in active or removed
fact excluded_ops_never_in_merge_output {
  all mc : MergedCapabilitySpec |
    no r : mc.activeReqs + mc.removedBaseReqs + mc.replacedBaseReqs |
      r.reqDeltaOp in (DeltaPreSection + DeltaRenamed)
}

// Empty merged capabilities have EmptyCapSkipped finding
fact empty_cap_has_finding {
  all mc : MergedCapabilitySpec |
    mc.isEmpty = True
    implies some mf : mc.mergeFindings | mf.mfKind = MergeEmptyCapSkipped
}

// --- Analysis state ---

one sig AnalysisState {
  var phase : one Phase,
  var graphClaims : set Claim,
  var graphFindings : set Finding,
  var analysisComplete : one Bool
}

abstract sig Phase {}
one sig Idle, Merging, Normalizing, Analyzing, Complete extends Phase {}
```

## Requirements

### Requirement: Normalize Parsed Content Into Typed Claims [CGC-NORMALIZE-CLAIMS]
WHEN parsed proposal, design, merged capability spec, or task content is available, THE spec-check tool SHALL construct claims preserving source text, kind, provenance, references, capability identity, and any source-established statement structure and formal disposition.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Interaction Protocols`
- [Proposal: Domain Model](../../changes/archive/2026-11-15-improve-ears-smt-analysis/proposal.md#domain-model)
- [Design: Source and identity](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#source-and-identity)

#### Scenario: Preserve Claim Provenance [CGC-CLAIM-PROVEN]
WHEN a claim is derived from a source item, THE spec-check tool SHALL retain its original file, nearest heading, statement/clause spans, and supporting-content associations when present.

**Postcondition:** Every ordinary graph claim traces to its originating artifact section; malformed inputs remain separately reviewable.

##### Evidence
- Implementation: [buildClaimGraph(), claimFromRequirement(), claimFromScenario(), extractProposalClaims(), extractDesignClaims(), extractTaskClaims()](/src/domain/claim-graph.ts)
- Test: [claim-graph.test.ts — obligation levels and provenance](/test/contract/claim-graph.test.ts), [safety-liveness.invariant.test.ts — SAFE-2](/test/invariant/safety-liveness.invariant.test.ts)
- Test (property): [claim-graph.property.test.ts — source traceability](/test/property/claim-graph.property.test.ts)

#### Scenario: Reject Provenance-Free Finding Input [CGC-CLAIM-FAIL]
IF a downstream step receives a claim without sufficient provenance, THEN THE spec-check tool SHALL surface an analysis-defect finding instead of issuing an untraceable conclusion.

**Postcondition:** Rejected claims remain evidence, without entering the ordinary graph or supporting coverage conclusions.

##### Evidence
- Implementation: [detectOrphanClaims()](/src/domain/claim-graph.ts)
- Test: [claim-graph.test.ts — orphaned claim without provenance](/test/contract/claim-graph.test.ts)
- Model boundary: the separate rejected-input set makes the no-consumption policy explicit; the implementation evidence above establishes defect detection, not a proof of this stronger handoff policy.

#### Scenario: Populate Capability Identity On Spec-Derived Claims [CGC-CLAIM-CAP]
WHEN a claim is derived from a merged requirement or scenario, THE spec-check tool SHALL retain the merged capability identity separately from original source provenance.

**Postcondition:** Downstream grouping uses capability identity without re-inferring it from original file paths.

##### Evidence
- Implementation: [extractMergedSpecClaims()](/src/domain/claim-graph.ts), [groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts)
- Test: [claim-graph.test.ts — merged capability identity](/test/contract/claim-graph.test.ts), [pipeline-helpers.test.ts — grouping by capability](/test/contract/pipeline-helpers.test.ts)

#### Scenario: Preserve Source Structure Across Normalization [CGC-CLAIM-CLAUSES]
WHEN a parsed item supplies EARS clauses or scenario metadata, THE spec-check tool SHALL carry those structures into formalization context without flattening them into prose-only claims.

#### Requirement model

```alloy
// --- Claim normalization: source structure, provenance and capability identity ---
// Source-local identity does not depend on optional authored/display IDs.
sig SourceIdentity {}
sig SourceText, SourceSpan, Clause, ScenarioMetadata, SupportingContent {}
abstract sig FormalDisposition {}
one sig Eligible, Excluded extends FormalDisposition {}
abstract sig StructuralModal {}
one sig ShallModal, MustModal, ShouldModal, MayModal, NoModal extends StructuralModal {}

sig SourceItem {
  localIdentity : one SourceIdentity,
  displayIdentifier : lone ReqIdentifier,
  sourceArtifact : one Artifact,
  sourceProvenance : lone Provenance,
  sourceText : one SourceText,
  sourceKind : one ClaimKind,
  sourceSpans : set SourceSpan,
  sourceClauses : set Clause,
  sourceScenarioMetadata : lone ScenarioMetadata,
  sourceSupportingContent : set SupportingContent,
  sourceReferences : set Reference,
  sourceDisposition : one FormalDisposition,
  structuralModal : one StructuralModal,
  sourceResponseNegated : one Bool,
  sourceCapability : lone Capability,
  parentRequirement : lone ParsedRequirement,
  parsedScenario : lone ParsedScenario,
  completedTaskSummary : one Bool
}

fact source_identity_and_origin {
  all disj a, b : SourceItem | a.localIdentity != b.localIdentity
  all s : SourceItem | {
    some s.sourceProvenance implies s.sourceProvenance.sourceFile = s.sourceArtifact
    s.sourceArtifact in CapabilitySpec implies {
      one s.parentRequirement
      s.sourceCapability = s.parentRequirement.reqCapability
      s.sourceArtifact = s.parentRequirement.reqSourceFile
      some s.parsedScenario implies {
        s.parsedScenario.scenarioParent = s.parentRequirement
        s.parsedScenario.scenarioCapability = s.sourceCapability
      }
    }
    s.sourceArtifact not in CapabilitySpec implies {
      no s.sourceCapability
      no s.parentRequirement
      no s.parsedScenario
    }
  }
  all c : Claim | c.references = c.source.sourceReferences
  all r : Reference | r in r.refSource.references
}

// The extracted set includes requirements and their surviving scenarios.
fun extracted_sources : set SourceItem {
  { s : SourceItem | s.sourceArtifact not in CapabilitySpec or
      (s.parentRequirement in MergedCapabilitySpec.activeReqs and
       (no s.parsedScenario or s.parsedScenario in MergedCapabilitySpec.activeScenarios)) }
}

pred normalized_claim [c : Claim] {
  c.text = c.source.sourceText
  c.kind = c.source.sourceKind
  c.provenance = c.source.sourceProvenance
  c.statementSpans = c.source.sourceSpans
  c.clauses = c.source.sourceClauses
  c.scenarioMetadata = c.source.sourceScenarioMetadata
  c.supportingContent = c.source.sourceSupportingContent
  c.references = c.source.sourceReferences
  c.capability = c.source.sourceCapability
  c.disposition = c.source.sourceDisposition
  c.responseNegated = c.source.sourceResponseNegated
  c.obligation = structural_obligation[c.source.structuralModal]
  c.permission = True iff c.source.structuralModal = MayModal
}

// Canonical normalized claims are immutable values; arbitrary downstream
// inputs may still be malformed and must be rejected before conclusions.
fact canonical_claim_generation {
  all s : extracted_sources | one c : Claim | c.source = s and normalized_claim[c]
  all c : Claim | normalized_claim[c] and c.source in extracted_sources implies
    all r : c.references | r.refSource = c
}
fun normalized_input : set Claim {
  { c : Claim | c.source in extracted_sources and normalized_claim[c] }
}
// Valid ordinary graph input and retained rejected source claims are disjoint.
fun graph_input : set Claim { { c : normalized_input | analyzable_claim[c] } }
fun rejected_source_input : set Claim { normalized_input - graph_input }
pred normalization_precondition { some Artifact }
pred merge_complete_precondition {
  all cap : Capability | some cap.specFile implies some cap.mergedView
}
// Event: normalize all source values, separating malformed claims for review.
pred normalize_claims {
  // Guard: normalization follows the selected merge-result handoff.
  AnalysisState.phase = Normalizing
  normalization_precondition
  merge_complete_precondition
  AnalysisState.graphClaims != graph_input
  // Effect: only traceable canonical claims enter the ordinary graph.
  AnalysisState.graphClaims' = graph_input
  // Frame: findings and completion are unchanged.
  AnalysisState.phase' = Normalizing
  AnalysisState.graphFindings' = AnalysisState.graphFindings
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding | f.emitted' = f.emitted
}

pred sufficient_provenance [c : Claim] {
  some c.provenance
  c.provenance.sourceFile = c.source.sourceArtifact
  c.provenance = c.source.sourceProvenance
  c.statementSpans = c.source.sourceSpans
}
pred analyzable_claim [c : Claim] {
  sufficient_provenance[c]
  c.source.sourceArtifact in CapabilitySpec implies {
    some c.capability
    c.capability = c.source.sourceCapability
    c.source.parentRequirement in c.capability.mergedView.activeReqs
  }
}

// A downstream boundary may receive damaged/external claims as well as the
// constructed graph. They are diagnosed without entering the claim graph.
one sig DownstreamInput { received : set Claim }
fun rejected_inputs : set Claim {
  rejected_source_input + { c : DownstreamInput.received | not analyzable_claim[c] }
}

// Event: retain a high-severity defect for rejected input, without consuming it.
pred emit_analysis_defect [c : Claim] {
  // Guard: only malformed, reviewable boundary inputs are diagnosed.
  AnalysisState.phase = Analyzing
  c in rejected_inputs
  // Effect: add one new defect finding.
  some f : Finding - AnalysisState.graphFindings | {
    f.findingKind = AnalysisDefect
    f.upstream = c
    no f.downstream + f.affectedCapability
    f.severity = High
    f.emitted' = True
    AnalysisState.graphFindings' = AnalysisState.graphFindings + f
    all other : Finding - f | other.emitted' = other.emitted
  }
  // Frame: the ordinary graph and lifecycle remain unchanged.
  AnalysisState.phase' = AnalysisState.phase
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
}
pred reject_provenance_free_claim [c : Claim] {
  not sufficient_provenance[c]
  emit_analysis_defect[c]
}
pred reject_capability_free_spec_claim [c : Claim] {
  c.source.sourceArtifact in CapabilitySpec
  not analyzable_claim[c]
  emit_analysis_defect[c]
}

// Safety: ordinary graph values preserve the complete source-owned structure.
assert normalization_preserves_source_structure {
  always (all c : AnalysisState.graphClaims | normalized_claim[c])
}
// Safety: every ordinary graph claim has sufficient provenance, not just
// claims that happen to be cited by an emitted finding.
assert provenance_integrity {
  always (all c : AnalysisState.graphClaims | sufficient_provenance[c])
}
// Safety: rejected input never supports a coverage conclusion.
assert no_silent_orphan_consumption {
  always (no AnalysisState.graphClaims & rejected_inputs and
    all f : AnalysisState.graphFindings | f.findingKind != AnalysisDefect implies
      no (f.upstream + f.downstream) & rejected_inputs)
}
// Safety: conclusions cite only sufficiently traceable claims.
assert conclusion_provenance_integrity {
  always (all f : AnalysisState.graphFindings |
    f.findingKind != AnalysisDefect implies
      all c : f.upstream + f.downstream | sufficient_provenance[c])
}
// Safety: spec claims retain their selected merged capability identity.
assert spec_claims_carry_capability {
  always (all c : AnalysisState.graphClaims |
    c.source.sourceArtifact in CapabilitySpec implies
      c.capability = c.source.sourceCapability and some c.capability)
}
// Safety: empty capability groups cannot contribute ordinary graph claims.
assert no_claims_from_empty_capabilities {
  always (all c : AnalysisState.graphClaims | some c.capability implies
    capability_active_for_coverage[c.capability])
}
// Safety postcondition: completion requires a high-severity defect per rejection.
assert defective_inputs_are_reported {
  always (AnalysisState.phase = Complete implies
    all c : rejected_inputs |
      some f : AnalysisState.graphFindings |
        f.findingKind = AnalysisDefect and f.upstream = c and f.severity = High)
}
```

### Requirement: Obligation Level Assignment [CGC-OBLIGATION-LEVEL]
WHEN a requirement or scenario is normalized, THE spec-check tool SHALL derive obligation and permission meaning from its parsed structural modal rather than from substring scanning or model output.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- [Design: Expression and semantic IR](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#expression-and-semantic-ir)

#### Scenario: SHALL Requirement Classified As Mandatory [CGC-OBLIG-MANDATORY]
WHEN a statement uses structural `SHALL` or `MUST`, THE spec-check tool SHALL assign mandatory obligation while preserving response negation independently.

**Postcondition:** Mandatory obligations remain distinct from advisory and permission semantics.

##### Evidence
- Implementation: [deriveObligation()](/src/domain/claim-graph.ts)
- Test: [claim-graph.test.ts — obligation levels](/test/contract/claim-graph.test.ts)
- Test (property): [claim-graph.property.test.ts — obligation assignment](/test/property/claim-graph.property.test.ts)

#### Scenario: SHOULD Requirement Classified As Advisory [CGC-OBLIG-ADVISORY]
WHEN a statement uses structural `SHOULD`, THE spec-check tool SHALL assign advisory obligation for analysis separately from the mandatory baseline.

**Postcondition:** Advisory rules cannot constrain the mandatory baseline.

##### Evidence
- Implementation: [deriveObligation()](/src/domain/claim-graph.ts)
- Test: [claim-graph.test.ts — advisory obligation](/test/contract/claim-graph.test.ts)
- Test (property): [claim-graph.property.test.ts — obligation assignment](/test/property/claim-graph.property.test.ts)

#### Scenario: Informational Content Classified [CGC-OBLIG-INFO]
WHEN a design property or informational section lacks an authoritative structural modal, THE spec-check tool SHALL retain informational classification without promoting prose occurrences of modal words into behavioral obligations.

**Postcondition:** Informational content remains coverage context without becoming a mandatory rule.

##### Evidence
- Implementation: [extractProposalClaims(), extractDesignClaims()](/src/domain/claim-graph.ts)
- Test: [claim-graph.test.ts — informational content](/test/contract/claim-graph.test.ts), [safety-liveness.invariant.test.ts — SAFE-9](/test/invariant/safety-liveness.invariant.test.ts)
- Test (property): [claim-graph.property.test.ts — obligation assignment](/test/property/claim-graph.property.test.ts)

#### Scenario: MAY Requirement Classified As Informational [CGC-OBLIG-OPTIONAL]
WHEN a statement uses structural `MAY`, THE spec-check tool SHALL retain informational obligation metadata and explicit permission semantics rather than require the response.

**Postcondition:** Absence of the permitted behavior is not a violation; an explicit permission may still conflict with mandatory prohibitions.

##### Evidence
- Implementation: [deriveObligation()](/src/domain/claim-graph.ts)
- Test: [claim-graph.test.ts — MAY is informational](/test/contract/claim-graph.test.ts)

#### Requirement model

```alloy
// --- Obligation assignment, permission semantics and severity mapping ---
fun structural_obligation [m : StructuralModal] : one ObligationLevel {
  m in ShallModal + MustModal => Mandatory else
    (m = ShouldModal => Advisory else Informational)
}
fun max_severity [o : ObligationLevel] : one Severity {
  o = Mandatory => High else (o = Advisory => Medium else Low)
}

// Static valuations model behavior meaning, independently of graph severity.
sig BehaviorValuation {}
sig SemanticRule {
  ruleClaim : one Claim,
  guard : set BehaviorValuation,
  positiveResponse : set BehaviorValuation
} {
  ruleClaim in normalized_input
}
fun response [r : SemanticRule] : set BehaviorValuation {
  r.ruleClaim.responseNegated = True => BehaviorValuation - r.positiveResponse
    else r.positiveResponse
}
fun mandatory_baseline [rs : set SemanticRule] : set BehaviorValuation {
  { v : BehaviorValuation | all r : rs |
    r.ruleClaim.obligation = Mandatory implies
      (v in r.guard implies v in response[r]) }
}
pred permission_conflicts_with_baseline [p : SemanticRule, rs : set SemanticRule] {
  p.ruleClaim.permission = True
  some p.guard & response[p]
  no p.guard & response[p] & mandatory_baseline[rs]
}
// Safety: parsed structural modals and negation are the classification authority.
assert structural_modal_is_authoritative {
  always (all c : AnalysisState.graphClaims |
    c.obligation = structural_obligation[c.source.structuralModal] and
    (c.permission = True iff c.source.structuralModal = MayModal) and
    c.responseNegated = c.source.sourceResponseNegated)
}
// Safety: advisory and permission rules cannot constrain mandatory behavior.
assert advisory_and_permission_do_not_constrain_baseline {
  all rs : set SemanticRule | mandatory_baseline[rs] =
    mandatory_baseline[{ r : rs | r.ruleClaim.obligation = Mandatory }]
}
// Safety: an isolated permission imposes no mandatory response obligation.
assert permission_absence_is_not_a_violation {
  all p : SemanticRule | p.ruleClaim.permission = True implies
    mandatory_baseline[p] = BehaviorValuation
}
// Safety: mandatory upstream violations retain the existing high severity.
assert mandatory_produces_high_severity {
  all f : Finding | f.findingKind in CoverageGap + Contradiction + SemanticDrift and
    f.upstream.obligation = Mandatory implies f.severity = High
}
// Safety: advisory violations respect the existing medium-or-low ceiling.
assert advisory_produces_medium_severity {
  all f : Finding | f.findingKind in CoverageGap + Contradiction + SemanticDrift and
    f.upstream.obligation = Advisory implies f.severity in Medium + Low
}
// Safety: informational upstream violations respect the low severity ceiling.
assert informational_no_high_severity {
  all f : Finding | f.findingKind in CoverageGap + Contradiction + SemanticDrift and
    f.upstream.obligation = Informational implies f.severity = Low
}
```

### Requirement: Detect Missing Coverage And Contradictions Across Artifacts [CGC-FIND-MISSING]
WHEN proposal or design claims are compared against capability specs, THE spec-check tool SHALL identify missing coverage, contradiction, and semantic mismatch between upstream intent and downstream requirements and SHALL report each result with supporting evidence.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Report Uncovered Proposal Claim [CGC-COVER-MISS]
WHEN a proposal or design claim has no corresponding capability requirement or scenario, THE spec-check tool SHALL emit a coverage finding that identifies the uncovered upstream claim and the missing downstream capability coverage.

**Postcondition:** Reviewers can see which upstream intent remains unspecified at the capability level.

##### Evidence
- Implementation: [coverage.ts:228 detectCoverageGaps()](/src/domain/spec-forward/coverage.ts#L228)
- Test: [coverage.test.ts:45 detects uncovered upstream claims](/test/contract/coverage.test.ts#L45)
- Test (integration): [pipeline.integration.test.ts:75 coverage gaps produce expected findings](/test/integration/pipeline.integration.test.ts#L75)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const { analyzeCoverage } = await import("./src/domain/spec-forward/coverage.ts");
const proposal = { file: "proposal.md", sections: new Map([["Scope", { heading: "Scope", lines: ["handles requests"], startLine: 1, endLine: 2 }]]), unparsed: [] };
const graph = buildClaimGraph({ proposal, specs: [] }); //*
const findings = analyzeCoverage({ claimGraph: graph.graph, proposal, specs: [] }); //*
findings.some(f => f.category === "coverage.uncovered_upstream_claim"); //=> true
```

#### Scenario: Report Conflicting Requirement Meaning [CGC-COVER-CONFLICT]
IF a capability requirement contradicts a proposal or design claim, THEN THE spec-check tool SHALL emit a contradiction or semantic-mismatch finding that cites both conflicting sources.

**Postcondition:** The conflict is visible with both sides of the disagreement preserved.

##### Evidence
- Implementation: [coverage.ts:272 detectContradictionsAndDrift()](/src/domain/spec-forward/coverage.ts#L272)
- Test: [coverage.test.ts:53 detects contradictions between upstream and downstream](/test/contract/coverage.test.ts#L53)
- Test (integration): [pipeline.integration.test.ts:101 contradictions produce expected findings](/test/integration/pipeline.integration.test.ts#L101)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const { analyzeCoverage } = await import("./src/domain/spec-forward/coverage.ts");
const proposal = { file: "proposal.md", sections: new Map([["Scope", { heading: "Scope", lines: ["the system should never timeout"], startLine: 1, endLine: 2 }]]), unparsed: [] };
const req = { title: "R1", identifier: "R1", body: "WHEN analysis runs, THE system SHALL timeout after 30 seconds.", earsType: "event-driven", references: [], provenance: { file: "specs/cap/spec.md", line: 1 } };
const spec = { file: "specs/cap/spec.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const graph = buildClaimGraph({ proposal, specs: [spec] }); //*
const findings = analyzeCoverage({ claimGraph: graph.graph, proposal, specs: [spec] }); //*
findings.some(f => f.category === "coverage.contradiction"); //=> true
```

#### Scenario: Report Design-To-Spec Semantic Drift [CGC-COVER-DRIFT]
IF a capability requirement partially implements a design claim but omits documented constraints, failure modes, or boundary conditions, THEN THE spec-check tool SHALL emit a semantic-drift finding that identifies the omission.

**Postcondition:** Partial implementations are surfaced rather than mistaken for complete coverage.

##### Evidence
- Implementation: [coverage.ts:272 detectContradictionsAndDrift()](/src/domain/spec-forward/coverage.ts#L272)
- Test: [coverage.test.ts:90 detects semantic drift for failure modes](/test/contract/coverage.test.ts#L90)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const { analyzeCoverage } = await import("./src/domain/spec-forward/coverage.ts");
const proposal = { file: "proposal.md", sections: new Map([["Failure Modes", { heading: "Failure Modes", lines: ["analysis timeout causes abort"], startLine: 1, endLine: 2 }]]), unparsed: [] };
const req = { title: "R1", identifier: "R1", body: "WHEN analysis completes, THE system SHALL report.", earsType: "event-driven", references: [], provenance: { file: "specs/cap/spec.md", line: 1 } };
const spec = { file: "specs/cap/spec.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const graph = buildClaimGraph({ proposal, specs: [spec] }); //*
const findings = analyzeCoverage({ claimGraph: graph.graph, proposal, specs: [spec] }); //*
findings.some(f => f.category === "coverage.semantic_drift"); //=> true
```

#### Requirement model

```alloy
// --- Coverage analysis: gap, contradiction, and drift detection ---

// Upstream claims: claims originating from proposal or design artifacts
fun upstream_claims : set Claim {
  { c : Claim | some c.provenance and c.provenance.sourceFile in (Proposal + Design) }
}

// Downstream claims: claims originating from capability specs
fun downstream_claims : set Claim {
  { c : Claim | some c.provenance and c.provenance.sourceFile in CapabilitySpec }
}

// A claim is covered if it has at least one full coverage link
pred claim_covered [c : Claim] {
  some link : CoverageLink |
    link.upstreamClaim = c and link.partial = False
}

// A claim is partially covered if it has only partial links
pred claim_partially_covered [c : Claim] {
  some link : CoverageLink | link.upstreamClaim = c and link.partial = True
  no link : CoverageLink | link.upstreamClaim = c and link.partial = False
}

// A claim is uncovered if it has no coverage links
pred claim_uncovered [c : Claim] {
  no link : CoverageLink | link.upstreamClaim = c
}

// Contradiction: a downstream claim semantically conflicts with upstream
// Modeled as a relation (semantic comparison is opaque to the model)
sig ContradictionPair {
  contra_upstream : one Claim,
  contra_downstream : one Claim
} {
  contra_upstream in upstream_claims
  contra_downstream in downstream_claims
}

// Event: emit coverage-gap finding for uncovered upstream claim
pred emit_coverage_gap [c : Claim] {
  // Guard
  c in upstream_claims
  c in AnalysisState.graphClaims
  claim_uncovered[c]
  analyzable_claim[c]
  AnalysisState.phase = Analyzing
  // Effect: emit finding
  some f : Finding - AnalysisState.graphFindings {
    f.findingKind = CoverageGap
    f.upstream = c
    no f.downstream
    no f.affectedCapability
    f.severity = max_severity[c.obligation]
    f.emitted' = True
    AnalysisState.graphFindings' = AnalysisState.graphFindings + f
  }
  // Frame
  AnalysisState.phase' = AnalysisState.phase
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding - AnalysisState.graphFindings' + AnalysisState.graphFindings |
    f.emitted' = f.emitted
}

// Event: emit contradiction finding
pred emit_contradiction [cp : ContradictionPair] {
  // Guard
  cp.contra_upstream in AnalysisState.graphClaims
  cp.contra_downstream in AnalysisState.graphClaims
  analyzable_claim[cp.contra_upstream]
  analyzable_claim[cp.contra_downstream]
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding - AnalysisState.graphFindings {
    f.findingKind = Contradiction
    f.upstream = cp.contra_upstream
    f.downstream = cp.contra_downstream
    no f.affectedCapability
    f.severity = max_severity[cp.contra_upstream.obligation]
    f.emitted' = True
    AnalysisState.graphFindings' = AnalysisState.graphFindings + f
  }
  // Frame
  AnalysisState.phase' = AnalysisState.phase
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding - AnalysisState.graphFindings' + AnalysisState.graphFindings |
    f.emitted' = f.emitted
}

// Event: emit semantic-drift finding for partial coverage
pred emit_semantic_drift [c : Claim] {
  // Guard
  c in upstream_claims
  c in AnalysisState.graphClaims
  claim_partially_covered[c]
  analyzable_claim[c]
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding - AnalysisState.graphFindings, link : CoverageLink {
    link.upstreamClaim = c
    link.partial = True
    link.downstreamClaim in AnalysisState.graphClaims
    analyzable_claim[link.downstreamClaim]
    f.findingKind = SemanticDrift
    f.upstream = c
    f.downstream = link.downstreamClaim
    f.omissions = link.omittedDetails
    no f.affectedCapability
    f.severity = max_severity[c.obligation]
    f.emitted' = True
    AnalysisState.graphFindings' = AnalysisState.graphFindings + f
  }
  // Frame
  AnalysisState.phase' = AnalysisState.phase
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding - AnalysisState.graphFindings' + AnalysisState.graphFindings |
    f.emitted' = f.emitted
}

// Safety postcondition: every analyzable uncovered upstream claim is reported.
assert uncovered_claims_surfaced {
  always (
    (AnalysisState.phase = Complete) implies
      (all c : upstream_claims & AnalysisState.graphClaims |
        (claim_uncovered[c] and analyzable_claim[c]) implies
          some f : AnalysisState.graphFindings |
            f.findingKind = CoverageGap and f.upstream = c))
}

// Safety: contradictions always cite both sides
assert contradiction_cites_both {
  all f : Finding |
    f.findingKind = Contradiction implies
      (some f.upstream and some f.downstream)
}

// Safety: drift findings always identify the partial link
assert drift_identifies_omission {
  always (all f : AnalysisState.graphFindings |
    f.findingKind = SemanticDrift implies
      (some link : CoverageLink | link.upstreamClaim = f.upstream and
        link.downstreamClaim = f.downstream and link.partial = True and
        f.omissions = link.omittedDetails and some f.omissions))
}
```

### Requirement: Validate Capability Mapping And References [CGC-VALIDATE-REFS]
WHEN the proposal declares capabilities and capability requirements declare references, THE spec-check tool SHALL validate expected active merged capability presence and SHALL assess whether each requirement reference points to upstream content that supports the cited behavior.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Capabilities`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Capabilities`

#### Scenario: Report Missing Spec File [CGC-REF-MISSFILE]
WHEN the proposal declares a capability and no corresponding active merged capability view exists for that capability, THE spec-check tool SHALL emit a missing-spec-file finding for the absent capability.

**Postcondition:** Proposal-to-spec contract gaps are explicitly surfaced against the active capability set.

##### Evidence
- Implementation: [coverage.ts:107 detectMissingSpecFiles()](/src/domain/spec-forward/coverage.ts#L107)
- Test: [coverage.test.ts:34 detects missing spec files for declared capabilities](/test/contract/coverage.test.ts#L34)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const { analyzeCoverage } = await import("./src/domain/spec-forward/coverage.ts");
const proposal = { file: "proposal.md", sections: new Map([["Capabilities", { heading: "Capabilities", lines: ["- existing-cap", "- missing-cap"], startLine: 1, endLine: 3 }]]), unparsed: [] };
const req = { title: "R1", identifier: "R1", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: [], provenance: { file: "specs/existing-cap/spec.md", line: 1 } };
const spec = { file: "specs/existing-cap/spec.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const graph = buildClaimGraph({ proposal, specs: [spec] }); //*
const findings = analyzeCoverage({ claimGraph: graph.graph, proposal, specs: [spec] }); //*
findings.some(f => f.category === "coverage.missing_spec_file"); //=> true
```

#### Scenario: Report Unsupported Reference [CGC-REF-BADLINK]
IF a requirement references an upstream section whose content does not support the claimed behavior, THEN THE spec-check tool SHALL emit a semantic-mismatch finding that names the requirement and the unsupported reference target. References to archived change artifacts (`openspec/changes/archive/`) SHALL be accepted as valid provenance links regardless of whether their content semantically supports the citing requirement, and SHALL NOT be flagged as unsupported.

**Postcondition:** References remain meaningful evidence links rather than decorative citations. Archived change references are preserved as historical provenance without triggering semantic-support validation.

##### Evidence
- Implementation: [coverage.ts:173 detectUnsupportedReferences()](/src/domain/spec-forward/coverage.ts#L173), [coverage.ts:584 isArchivedChangeReference()](/src/domain/spec-forward/coverage.ts#L584)
- Test: [coverage.test.ts:70 detects unsupported requirement references](/test/contract/coverage.test.ts#L70), [coverage.test.ts:80 accepts archived change references as valid provenance](/test/contract/coverage.test.ts#L80)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const { analyzeCoverage } = await import("./src/domain/spec-forward/coverage.ts");
const req = { title: "R1", identifier: "R1", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: ["nonexistent.md#Section"], provenance: { file: "specs/cap/spec.md", line: 1 } };
const spec = { file: "specs/cap/spec.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const graph = buildClaimGraph({ specs: [spec] }); //*
const findings = analyzeCoverage({ claimGraph: graph.graph, specs: [spec] }); //*
findings.some(f => f.category === "coverage.unsupported_reference"); //=> true
```

#### Requirement model

```alloy
// Preconditions and postconditions use active merged presence, not raw files.
pred reference_validation_precondition {
  AnalysisState.phase = Analyzing
  merge_complete_precondition
}
pred reference_validation_postcondition {
  reference_results_present[AnalysisState.graphFindings]
}
// Required result descriptors are parameterized independently of completion.
pred reference_results_present[fs : set Finding] {
  all cap : Capability | capability_missing_spec[cap] implies
    some f : fs |
      f.findingKind = MissingSpecFile and f.affectedCapability = cap
  all r : Reference | r.refSource in AnalysisState.graphClaims and
    analyzable_claim[r.refSource] and reference_unsupported[r] implies
      some f : fs |
        f.findingKind = UnsupportedRef and f.affectedReference = r
}
// Safety postcondition: completion includes every required reference result.
assert completed_reference_validation {
  always (AnalysisState.phase = Complete implies reference_validation_postcondition)
}
// Safety: unsupported-reference findings retain the exact citing requirement/link.
assert unsupported_reference_names_exact_target {
  always (all f : AnalysisState.graphFindings | f.findingKind = UnsupportedRef implies
    f.upstream = f.affectedReference.refSource and
    reference_unsupported[f.affectedReference] and
    some f.affectedReference.citation)
}
```

### Requirement: Use Merged Capability Views For Coverage [CGC-MERGED-COVERAGE]
WHEN the spec-check tool performs proposal-to-spec mapping and downstream coverage analysis, THE spec-check tool SHALL use merged capability specs as the active capability source of truth rather than raw per-file parsed specs.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Postconditions`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Interaction Protocols`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Verification Strategy`

#### Scenario: Removed Requirements Do Not Participate In Coverage [CGC-COVERAGE-REMOVED]
WHEN a requirement is removed from the active merged capability view by a valid `REMOVED` delta operation, THE spec-check tool SHALL exclude that removed requirement from downstream coverage analysis.

**Postcondition:** Coverage reflects the same active capability behavior used by claim extraction and logic.

##### Evidence
- Implementation: [merge.ts:244 applyRemoved()](/src/domain/parser/merge.ts#L244), [pipeline-helpers.ts:265 runClaimGraphPhase()](/src/cli/pipeline-helpers.ts#L265)
- Test (integration): [merge-liveness.integration.test.ts:226 routes only active merged requirements to logic inputs (removed excluded, modified retained)](/test/integration/merge-liveness.integration.test.ts#L226)
- Example:
```typescript
const { mergeSpecsByCapability } = await import("./src/domain/parser/merge.ts");
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const { toCapabilityName } = await import("./src/domain/branded.ts");
const docs = [
  { path: "specs/cap-a/spec.md", type: "spec", source: "final", capability: toCapabilityName("cap-a") },
  { path: "openspec/changes/demo/specs/cap-a/spec.md", type: "spec", source: "delta", capability: toCapabilityName("cap-a") },
];
const base = {
  file: "specs/cap-a/spec.md",
  requirements: [
    { title: "Keep", identifier: "CAP-A-KEEP", body: "WHEN keep appears, THE system SHALL keep behavior.", earsType: "event-driven", deltaOperation: "base", references: [], provenance: { file: "specs/cap-a/spec.md", line: 1 } },
    { title: "Remove", identifier: "CAP-A-REMOVE", body: "WHEN remove appears, THE system SHALL remove behavior.", earsType: "event-driven", deltaOperation: "base", references: [], provenance: { file: "specs/cap-a/spec.md", line: 5 } },
  ],
  scenarios: [],
  deltaSections: [],
  structuralFindings: [],
  unparsed: [],
};
const delta = {
  file: "openspec/changes/demo/specs/cap-a/spec.md",
  requirements: [
    { title: "Remove", identifier: "CAP-A-REMOVE", body: "WHEN removed, THE system SHALL remove behavior.", earsType: "event-driven", deltaOperation: "REMOVED", references: [], provenance: { file: "openspec/changes/demo/specs/cap-a/spec.md", line: 1 } },
  ],
  scenarios: [],
  deltaSections: ["REMOVED"],
  structuralFindings: [],
  unparsed: [],
};
const merged = mergeSpecsByCapability(docs, [base, delta]); //*
const { graph } = buildClaimGraph({ specs: [base, delta], mergedSpecs: merged }); //*
graph.claims.some((claim) => claim.id === "CAP-A-REMOVE"); //=> false
```

#### Scenario: Empty Merged Capability Skipped In Coverage [CGC-COVERAGE-EMPTY]
IF a capability produces zero surviving merged requirements and the merge layer emits `spec_merge.empty_capability_skipped`, THEN THE spec-check tool SHALL omit that capability from coverage analysis.

**Postcondition:** Coverage analysis does not report misleading results for vacuous capability groups.

##### Evidence
- Implementation: [merge.ts:88 mergeCapability()](/src/domain/parser/merge.ts#L88), [pipeline-helpers.ts:265 runClaimGraphPhase()](/src/cli/pipeline-helpers.ts#L265)
- Test: [merge.test.ts:215 emits empty capability finding when no surviving requirements remain](/test/contract/merge.test.ts#L215), [pipeline-helpers.test.ts:61 submits every non-empty merged capability to claim extraction and coverage exactly once](/test/contract/pipeline-helpers.test.ts#L61)
- Test (integration): [merge-liveness.integration.test.ts:124 processes each non-empty merged capability exactly once across downstream phases](/test/integration/merge-liveness.integration.test.ts#L124)
- Example:
```typescript
const { runClaimGraphPhase } = await import("./src/cli/pipeline-helpers.ts");
const { toCapabilityName } = await import("./src/domain/branded.ts");
const result = runClaimGraphPhase({
  specs: [],
  mergedSpecs: [{
    capability: toCapabilityName("cap-empty"),
    sourceFiles: ["specs/cap-empty/spec.md"],
    logicalFile: "<merged-spec/cap-empty>",
    requirements: [],
    scenarios: [],
    findings: [],
  }],
}); //*
result.graph.claims.length; //=> 0
result.coverageFindings.length; //=> 0
```

#### Requirement model

```alloy
// --- Reference validation, capability mapping, and merge-coverage integration ---

// A capability is missing its spec file (no merged view exists)
pred capability_missing_spec [cap : Capability] {
  some cap.declaredIn
  no cap.mergedView
}

// A capability has a merged view but it is empty (all reqs removed)
pred capability_merged_empty [cap : Capability] {
  some cap.mergedView
  cap.mergedView.isEmpty = True
}

// A capability is active and non-empty for coverage
pred capability_active_for_coverage [cap : Capability] {
  some cap.mergedView
  cap.mergedView.isEmpty = False
}

// A reference is semantically supported by its target
// (opaque to model: semantic analysis determines this)
pred reference_supported [r : Reference] {
  r.isArchived = True or (some r.refTarget and r.semanticSupport = True)
}

// A reference is unsupported (non-archived and semantically unsupported)
pred reference_unsupported [r : Reference] {
  r.isArchived = False
  not reference_supported[r]
}

// --- Selected merge-result handoff (external component contract) ---
// The merged-capability-analysis specification owns first-base-wins matching,
// duplicate rejection, removal-before-modification, projected requirement and
// scenario namespaces, collision rollback, and ordered output. This module
// deliberately does not recompute those decisions from parsed identifiers.
// The supplied outcome sets below partition selected inputs and retain skip
// evidence; their algorithmic correctness requires the authoritative model and
// merge contract/integration tests cited above.

// Precondition: merge requires catalog resolution to have selected inputs
pred merge_precondition {
  some Artifact
}

fact selected_merge_handoff {
  all mc : MergedCapabilitySpec | {
    let inputs = { r : ParsedRequirement | r.reqCapability = mc.mergeSource },
        bases = { r : inputs | r.reqDeltaOp = DeltaBase } | {
      bases = (mc.activeReqs & bases) + mc.removedBaseReqs +
        mc.replacedBaseReqs + (mc.skippedReqs & bases)
      disj[mc.appliedDeltas, mc.skippedReqs]
      inputs - bases = mc.appliedDeltas + (mc.skippedReqs - bases)
      mc.appliedDeltas.reqDeltaOp in DeltaAdded + DeltaModified + DeltaRemoved
      mc.activeReqs - bases = { r : mc.appliedDeltas | r.reqDeltaOp != DeltaRemoved }
    }
    // Supplied application receipts distinguish retired base identities from
    // their instructions. This checks receipt shape, not how merge chose them.
    (mc.removalTargets).ParsedRequirement = { r : mc.appliedDeltas | r.reqDeltaOp = DeltaRemoved }
    ParsedRequirement.(mc.removalTargets) = mc.removedBaseReqs
    (mc.replacementTargets).ParsedRequirement = { r : mc.appliedDeltas | r.reqDeltaOp = DeltaModified }
    ParsedRequirement.(mc.replacementTargets) = mc.replacedBaseReqs
    all base : mc.removedBaseReqs | one (mc.removalTargets).base
    all base : mc.replacedBaseReqs | one (mc.replacementTargets).base
    all instruction, base : ParsedRequirement |
      instruction -> base in mc.removalTargets + mc.replacementTargets implies
        some base.reqIdentifier and instruction.reqIdentifier = base.reqIdentifier
    // Merge supplies the surviving scenario/block association as one unit.
    mc.activeScenarios = { s : ParsedScenario |
      s.scenarioCapability = mc.mergeSource and some s.scenarioParent and
      s.scenarioParent in mc.activeReqs }
    all r : mc.skippedReqs | some mf : mc.mergeFindings |
      mf.mfAffectedReq = r and mf.mfKind != MergeEmptyCapSkipped
    all s : ParsedScenario | s.scenarioCapability = mc.mergeSource and
      no s.scenarioParent implies some mf : mc.mergeFindings |
        mf.mfAffectedScenario = s and mf.mfKind in
          MergePreSectionContent + MergeStandaloneScenario
  }
}

// --- Coverage events using merged views ---

// Event: emit missing-spec-file finding (no merged view at all)
pred emit_missing_spec_file [cap : Capability] {
  // Guard
  capability_missing_spec[cap]
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding - AnalysisState.graphFindings {
    f.findingKind = MissingSpecFile
    no f.upstream
    no f.downstream
    f.affectedCapability = cap
    f.severity = High
    f.emitted' = True
    AnalysisState.graphFindings' = AnalysisState.graphFindings + f
  }
  // Frame
  AnalysisState.phase' = AnalysisState.phase
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding - AnalysisState.graphFindings' + AnalysisState.graphFindings |
    f.emitted' = f.emitted
}

// EmptyCapSkipped is reserved vocabulary; this pipeline surfaces empty
// capabilities through MergeEmptyCapSkipped, without a coverage event.

// Event: emit unsupported-reference finding
pred emit_unsupported_ref [r : Reference] {
  // Guard
  reference_unsupported[r]
  r.refSource in AnalysisState.graphClaims
  analyzable_claim[r.refSource]
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding - AnalysisState.graphFindings {
    f.findingKind = UnsupportedRef
    f.upstream = r.refSource
    f.affectedReference = r
    no f.downstream
    no f.affectedCapability
    f.severity = Medium
    f.emitted' = True
    AnalysisState.graphFindings' = AnalysisState.graphFindings + f
  }
  // Frame
  AnalysisState.phase' = AnalysisState.phase
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding - AnalysisState.graphFindings' + AnalysisState.graphFindings |
    f.emitted' = f.emitted
}

// --- Safety properties: reference and merge-coverage ---

// Safety: archived references are never flagged as unsupported
assert archived_refs_never_flagged {
  all r : Reference |
    r.isArchived = True implies
      no f : Finding | f.findingKind = UnsupportedRef and f.affectedReference = r
}

// Safety: missing spec files are always surfaced
assert missing_specs_surfaced {
  always (
    AnalysisState.phase = Complete implies
      all cap : Capability |
        capability_missing_spec[cap] implies
          some f : AnalysisState.graphFindings |
            f.findingKind = MissingSpecFile and f.affectedCapability = cap)
}

// Safety: removed requirements never produce claims in the graph
// Requirement identity, including attached scenarios, traces to active blocks.
assert removed_reqs_never_produce_claims {
  always (all c : AnalysisState.graphClaims |
    no c.source.parentRequirement & MergedCapabilitySpec.removedBaseReqs)
}

// Safety: empty capabilities never contribute claims to the graph
assert empty_caps_produce_no_claims {
  always (all cap : Capability |
    capability_merged_empty[cap] implies
      no c : AnalysisState.graphClaims | c.capability = cap)
}

// Safety: empty capabilities never participate in coverage analysis
// Boundary defects may diagnose stale received claims; they are not coverage
// conclusions about an empty capability.
assert empty_caps_excluded_from_coverage {
  always (all cap : Capability |
    capability_merged_empty[cap] implies
      no f : AnalysisState.graphFindings |
        f.findingKind != AnalysisDefect and
        (f.affectedCapability = cap or
         cap in (f.upstream + f.downstream).capability))
}

// Safety: every unapplied delta retains supplied merge-skip evidence.
// This is a handoff-contract consequence, not a proof of merge classification
// or evidence generation; those belong to the authoritative merge model.
assert no_silent_delta_discard {
  all mc : MergedCapabilitySpec, r : ParsedRequirement |
    (r.reqDeltaOp != DeltaBase and
     r.reqCapability = mc.mergeSource and
      r not in mc.appliedDeltas)
      implies some mf : mc.mergeFindings | mf.mfAffectedReq = r
}

// Safety: rejected/retired merge blocks and their scenarios cannot enter claims.
assert skipped_and_replaced_blocks_never_produce_claims {
  always (all c : AnalysisState.graphClaims | no c.source.parentRequirement &
    (MergedCapabilitySpec.skippedReqs + MergedCapabilitySpec.replacedBaseReqs))
}
// Safety: every graph scenario belongs to the supplied surviving scenario set.
assert graph_scenarios_follow_merge_handoff {
  always (AnalysisState.graphClaims.source.parsedScenario in MergedCapabilitySpec.activeScenarios)
}

// Safety: only non-empty merged capabilities feed downstream analysis
assert only_active_caps_analyzed {
  always (all c : AnalysisState.graphClaims |
    some c.capability implies capability_active_for_coverage[c.capability])
}

// Safety postcondition: the merge-layer skip remains reviewable.
assert empty_caps_surfaced {
  always (
    AnalysisState.phase = Complete implies
      all cap : Capability |
        capability_merged_empty[cap] implies
          some mf : cap.mergedView.mergeFindings | mf.mfKind = MergeEmptyCapSkipped)
}

// --- Inductive invariants for merge-coverage properties ---

// Invariant predicate: merge-coverage structural health
pred merge_coverage_inv {
  // No claims from empty capabilities
  all cap : Capability |
    capability_merged_empty[cap] implies
      no c : AnalysisState.graphClaims | c.capability = cap
  // All spec-derived claims have capability identity
  all c : AnalysisState.graphClaims |
    (some c.provenance and c.provenance.sourceFile in CapabilitySpec)
      implies some c.capability
}

// Safety: initiation of the merge-coverage invariant (no transition induction).
assert merge_coverage_initiation {
  no AnalysisState.graphClaims implies merge_coverage_inv
}

// Reachable-state preservation is checked below. A genuine inductive step
// would require arbitrary invariant states, not the global init/transitions fact.
// Safety: all reachable states retain merge-coverage structural health.
assert merge_coverage_reachable_invariant {
  always merge_coverage_inv
}
```

### Requirement: Task Evidence Consistency [CGC-TASK-EVIDENCE]
WHEN task files with completed change summaries are present, THE spec-check tool SHALL compare task evidence claims against the claim graph and SHALL report inconsistencies between documented task outcomes and specification requirements.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Task Summary Contradicts Spec [CGC-TASK-CONFLICT]
IF a completed task change summary describes behavior that contradicts a capability requirement, THEN THE spec-check tool SHALL emit a task-consistency finding citing both the task summary and the conflicting requirement.

**Postcondition:** Implementation deviations documented in task summaries are surfaced during specification analysis.

##### Evidence
- Implementation: [coverage.ts:337 detectTaskEvidenceInconsistency()](/src/domain/spec-forward/coverage.ts#L337)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const { analyzeCoverage } = await import("./src/domain/spec-forward/coverage.ts");
const taskDoc = { file: "tasks.md", groups: [{ title: "G1", tasks: [{ text: "Implemented feature that never processes input", done: true, provenance: { file: "tasks.md", line: 1 } }] }], changeSummaries: new Map(), unparsed: [] };
const req = { title: "R1", identifier: "R1", body: "WHEN input arrives, THE system SHALL process it.", earsType: "event-driven", references: [], provenance: { file: "specs/cap/spec.md", line: 1 } };
const spec = { file: "specs/cap/spec.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const graph = buildClaimGraph({ specs: [spec], tasks: taskDoc }); //*
const findings = analyzeCoverage({ claimGraph: graph.graph, specs: [spec], tasks: taskDoc }); //*
findings.some(f => f.category === "coverage.task_conflict"); //=> true
```

#### Scenario: Task References Missing Spec Coverage [CGC-TASK-GAP]
IF a completed task change summary references behavior that has no corresponding capability requirement, THEN THE spec-check tool SHALL emit a coverage finding for the undocumented behavior.

**Postcondition:** Implemented but unspecified behavior is visible to reviewers.

##### Evidence
- Implementation: [coverage.ts:337 detectTaskEvidenceInconsistency()](/src/domain/spec-forward/coverage.ts#L337)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const { analyzeCoverage } = await import("./src/domain/spec-forward/coverage.ts");
const taskDoc = { file: "tasks.md", groups: [{ title: "G1", tasks: [{ text: "Implemented entirely novel behavior", done: true, provenance: { file: "tasks.md", line: 1 } }] }], changeSummaries: new Map(), unparsed: [] };
const graph = buildClaimGraph({ specs: [], tasks: taskDoc }); //*
const findings = analyzeCoverage({ claimGraph: graph.graph, specs: [], tasks: taskDoc }); //*
findings.some(f => f.category === "coverage.task_gap"); //=> true
```

#### Requirement model

```alloy
// --- Task evidence consistency ---

// Task claims: claims originating from task files
fun task_claims : set Claim {
  { c : Claim | some c.provenance and c.provenance.sourceFile in TaskFile and
      c.source.completedTaskSummary = True }
}

// A task claim contradicts a spec claim (semantic comparison, opaque)
sig TaskContradiction {
  task_claim : one Claim,
  spec_claim : one Claim
} {
  task_claim in task_claims
  spec_claim in downstream_claims
}

// A task claim references behavior with no spec coverage
pred task_claim_uncovered [c : Claim] {
  c in task_claims
  no link : CoverageLink | link.upstreamClaim = c
}

// Event: emit task-conflict finding
pred emit_task_conflict [tc : TaskContradiction] {
  // Guard
  tc.task_claim in AnalysisState.graphClaims
  tc.spec_claim in AnalysisState.graphClaims
  analyzable_claim[tc.task_claim]
  analyzable_claim[tc.spec_claim]
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding - AnalysisState.graphFindings {
    f.findingKind = TaskConflict
    f.upstream = tc.task_claim
    f.downstream = tc.spec_claim
    no f.affectedCapability
    f.severity = max_severity[tc.spec_claim.obligation]
    f.emitted' = True
    AnalysisState.graphFindings' = AnalysisState.graphFindings + f
  }
  // Frame
  AnalysisState.phase' = AnalysisState.phase
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding - AnalysisState.graphFindings' + AnalysisState.graphFindings |
    f.emitted' = f.emitted
}

// Event: emit task-gap finding for uncovered task behavior
pred emit_task_gap [c : Claim] {
  // Guard
  task_claim_uncovered[c]
  c in AnalysisState.graphClaims
  analyzable_claim[c]
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding - AnalysisState.graphFindings {
    f.findingKind = TaskGap
    f.upstream = c
    no f.downstream
    no f.affectedCapability
    f.severity = Medium
    f.emitted' = True
    AnalysisState.graphFindings' = AnalysisState.graphFindings + f
  }
  // Frame
  AnalysisState.phase' = AnalysisState.phase
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding - AnalysisState.graphFindings' + AnalysisState.graphFindings |
    f.emitted' = f.emitted
}

// Safety: task contradictions always cite both the task and the spec claim
assert task_conflict_cites_both {
  all f : Finding |
    f.findingKind = TaskConflict implies
      (some f.upstream and some f.downstream)
}

// Safety: uncovered task behavior is surfaced
assert task_gaps_surfaced {
  always (
    AnalysisState.phase = Complete implies
      all c : task_claims & AnalysisState.graphClaims |
        (task_claim_uncovered[c] and analyzable_claim[c]) implies
          some f : AnalysisState.graphFindings |
            f.findingKind = TaskGap and f.upstream = c)
}
```

### Requirement: Claim Graph Determinism [CGC-GRAPH-DETERMINISM]
WHEN the spec-check tool builds a claim graph from the same parsed inputs and merged capability views on separate runs, THE spec-check tool SHALL produce identical claim graphs.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Quality Attributes`

#### Scenario: Identical Parsed Input Produces Identical Claims [CGC-DETERM-SAME]
WHEN the same set of parsed documents is processed on two separate runs, THE spec-check tool SHALL produce an identical set of typed claims with identical provenance and obligation levels.

**Postcondition:** Claim graph construction is a deterministic function of parsed input.

##### Evidence
- Implementation: [claim-graph.ts:153 buildClaimGraph()](/src/domain/claim-graph.ts#L153)
- Test: [extended.determinism.test.ts:103 claim graph is identical across runs for same parsed input](/test/determinism/extended.determinism.test.ts#L103), [run.determinism.test.ts:18 produces stable summary output for same deterministic input](/test/determinism/run.determinism.test.ts#L18)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const req = { title: "R1", identifier: "R1", body: "THE system SHALL respond", earsType: "event-driven", references: [], provenance: { file: "s.md", line: 1 } };
const spec = { file: "s.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const a = buildClaimGraph({ specs: [spec] }); //*
const b = buildClaimGraph({ specs: [spec] }); //*
JSON.stringify(a.graph.claims) === JSON.stringify(b.graph.claims); //=> true
```

#### Requirement model

```alloy
// --- Claim graph determinism: normalized values and rejected-input inventory ---
// A snapshot identifies parsed values and selected merged views, not just files.
sig AnalysisRun {
  parsedInputs : set SourceItem,
  mergedInputs : set MergedCapabilitySpec,
  declaredCapabilities : set Capability,
  runClaims : set Claim,
  runGraph : set Claim,
  runRejected : set Claim
}
fun run_extracted_sources [r : AnalysisRun] : set SourceItem {
  { s : r.parsedInputs | s.sourceArtifact not in CapabilitySpec or
      (s.parentRequirement in r.mergedInputs.activeReqs and
       (no s.parsedScenario or s.parsedScenario in r.mergedInputs.activeScenarios)) }
}
fact run_construction_contract {
  all r : AnalysisRun | {
    r.runClaims = { c : Claim | c.source in run_extracted_sources[r] and normalized_claim[c] }
    r.runGraph = { c : r.runClaims | analyzable_claim[c] }
    r.runRejected = r.runClaims - r.runGraph
    r.declaredCapabilities in { cap : Capability | some cap.declaredIn }
  }
}
pred same_input [a, b : AnalysisRun] {
  a.parsedInputs = b.parsedInputs
  a.mergedInputs = b.mergedInputs
  a.declaredCapabilities = b.declaredCapabilities
}
pred graph_deterministic [a, b : AnalysisRun] {
  same_input[a, b] implies a.runClaims = b.runClaims and
    a.runGraph = b.runGraph and a.runRejected = b.runRejected
}
// Safety: equal complete snapshots select equal canonical values and partitions.
// Concrete claim ordering/serialization is verified by the cited tests.
assert claim_graph_is_deterministic_function {
  all a, b : AnalysisRun | graph_deterministic[a, b]
}
pred snapshot_matches_invocation[r : AnalysisRun] {
  r.parsedInputs = extracted_sources
  r.mergedInputs = MergedCapabilitySpec
  r.declaredCapabilities = { cap : Capability | some cap.declaredIn }
}
// Safety: the snapshot projection matches the operational handoff at analysis.
assert snapshot_matches_operational_graph {
  always (AnalysisState.phase in Analyzing + Complete implies
    all r : AnalysisRun | snapshot_matches_invocation[r] implies
      r.runGraph = AnalysisState.graphClaims and r.runRejected = rejected_source_input)
}
```

### Requirement: Coverage Analysis Determinism [CGC-COVERAGE-DETERMINISM]
WHEN the spec-check tool performs coverage analysis on the same claim graph and merged capability set on separate runs, THE spec-check tool SHALL produce identical coverage findings.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Quality Attributes`

#### Scenario: Same Graph Produces Same Findings [CGC-COVDET-SAME]
WHEN the same claim graph is analyzed for coverage on two separate runs, THE spec-check tool SHALL produce byte-identical coverage findings.

**Postcondition:** Coverage analysis is a deterministic function of the merged capability analysis inputs.

##### Evidence
- Implementation: [coverage.ts:66 analyzeCoverage()](/src/domain/spec-forward/coverage.ts#L66)
- Test: [extended.determinism.test.ts:236 coverage findings are identical across runs for same claim graph](/test/determinism/extended.determinism.test.ts#L236), [run.determinism.test.ts:18 produces stable summary output for same deterministic input](/test/determinism/run.determinism.test.ts#L18)
- Test (property): [coverage.property.test.ts:10 same claim graph always produces the same coverage findings](/test/property/coverage.property.test.ts#L10)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const { analyzeCoverage } = await import("./src/domain/spec-forward/coverage.ts");
const req = { title: "R1", identifier: "R1", body: "WHEN x, THE system SHALL y.", earsType: "event-driven", references: ["missing.md#Section"], provenance: { file: "s.md", line: 1 } };
const spec = { file: "s.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const graph = buildClaimGraph({ specs: [spec] }); //*
const a = analyzeCoverage({ claimGraph: graph.graph, specs: [spec] }); //*
const b = analyzeCoverage({ claimGraph: graph.graph, specs: [spec] }); //*
JSON.stringify(a) === JSON.stringify(b); //=> true
```

#### Requirement model

```alloy
// --- Coverage determinism: external implementation-test boundary ---
// analyzeCoverage computes comparisons deterministically from the graph and
// selected capability inputs. Equal comparison outcomes are NOT extra premises
// in the product requirement. This module abstracts semantic matching and does
// not implement the token/negation algorithms or serialize findings to bytes.
pred same_claim_graph [a, b : AnalysisRun] {
  a.runGraph = b.runGraph
  a.runRejected = b.runRejected
  a.mergedInputs = b.mergedInputs
  a.declaredCapabilities = b.declaredCapabilities
}
sig SerializedBytes {}
sig CoverageEvaluation { inputRun : one AnalysisRun, outputBytes : one SerializedBytes }
// Safety contract (externally verified): identical graph/merge inputs produce
// identical finding bytes. No canonical-serializer fact or assertion assumes
// this contract and then presents its repetition as independent Alloy evidence.
pred repeated_coverage_contract {
  all a, b : CoverageEvaluation | same_claim_graph[a.inputRun, b.inputRun] implies
    a.outputBytes = b.outputBytes
}
```

### Requirement: Preserve Every Source Formal Disposition [CGC-FORMAL-SCOPE]
WHEN the claim graph is built, THE spec-check tool SHALL assign every extracted specification statement a source-local identity and explicit eligible or excluded disposition independently of authored identifiers.

**References:**
- [Proposal: Preconditions, Postconditions, and Invariants](../../changes/archive/2026-11-15-improve-ears-smt-analysis/proposal.md#preconditions-postconditions-and-invariants)
- [Design: Source and identity](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#source-and-identity)

#### Scenario: Excluded Statements Remain Reviewable [CGC-SCOPE-EXCLUDED]
WHEN a statement is excluded from solver formalization, THE spec-check tool SHALL retain it for qualitative review, coverage context, provenance, and analyzed-scope reporting.

#### Scenario: Duplicate Display Identifiers Do Not Merge Claims [CGC-SCOPE-IDENTITY]
WHEN authored identifiers are missing or duplicated, THE spec-check tool SHALL retain distinct source-local identities and SHALL assign eligible indexes only after the eligibility filter without using display IDs to join sample outcomes.

#### Scenario: Total Disposition Accounting [CGC-SCOPE-PARTITION]
WHEN admission completes, THE spec-check tool SHALL expose disjoint eligible and excluded sets whose union equals the extracted specification-statement set.

#### Requirement model

```alloy
sig EligibleIndex {}
sig Admission {
  admissionRun : one AnalysisRun,
  extracted : set Claim,
  eligible : set Claim,
  excluded : set Claim,
  eligibleIndex : Claim -> lone EligibleIndex,
  reviewable : set Claim,
  coverageContext : set Claim,
  scopeReported : set Claim
}
fact total_source_disposition {
  all a : Admission | {
    a.extracted = { c : a.admissionRun.runClaims |
      c.source.sourceArtifact in CapabilitySpec }
    // Source disposition is preserved. Invalid provenance is an additional
    // admission exclusion; rejected source claims remain in the inventory.
    a.eligible = { c : a.extracted | c.disposition = Eligible and analyzable_claim[c] }
    a.excluded = a.extracted - a.eligible
    a.reviewable = a.extracted
    a.coverageContext = a.extracted
    a.scopeReported = a.extracted
    a.eligibleIndex.EligibleIndex = a.eligible
    all c : a.eligible | one c.(a.eligibleIndex)
    all disj c, d : a.eligible | c.(a.eligibleIndex) != d.(a.eligibleIndex)
  }
}
// Sample errors do not alter admission; joins use eligible indexes, not IDs.
abstract sig SampleStatus {}
one sig CandidateSample, ErrorSample extends SampleStatus {}
sig SampleOutcome {
  admission : one Admission,
  index : one EligibleIndex,
  outcomeClaim : one Claim,
  status : one SampleStatus
} {
  outcomeClaim in admission.eligible
  outcomeClaim.(admission.eligibleIndex) = index
}
// Safety: every extracted spec statement has exactly one admission disposition.
assert disposition_partition_is_total {
  all a : Admission | no a.eligible & a.excluded and
    a.eligible + a.excluded = a.extracted
}
// Safety: exclusions retain review, coverage-context and scope-report visibility.
assert excluded_statements_remain_reviewable {
  all a : Admission | a.excluded in
    a.reviewable & a.coverageContext & a.scopeReported
}
// Safety: distinct source statements retain distinct source-local identities.
assert display_identifiers_cannot_merge_claims {
  all disj c, d : normalized_input | c.source.localIdentity != d.source.localIdentity
}
// Safety: excluded statements receive no eligible sample index.
assert eligible_indexes_follow_filter {
  all a : Admission | no a.excluded & a.eligibleIndex.EligibleIndex
}
// Safety: sample errors do not retroactively revoke source admission.
assert sample_errors_do_not_change_disposition {
  all o : SampleOutcome | o.status = ErrorSample implies
    o.outcomeClaim in o.admission.eligible
}

// Safety: each sample index resolves to exactly its source-local eligible claim.
assert sample_outcomes_join_source_local_identity {
  all o : SampleOutcome | one c : o.admission.eligible |
    c.(o.admission.eligibleIndex) = o.index and c = o.outcomeClaim
}
```

### State machine, invariants, and verification commands

```alloy
// --- Transition system ---

// Event: idle step; frame every mutable relation.
pred stutter {
  AnalysisState.phase' = AnalysisState.phase
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.graphFindings' = AnalysisState.graphFindings
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding | f.emitted' = f.emitted
}

// Event: start merge-result handoff after catalog resolution has selected inputs.
pred start_merge {
  // Guard: Idle with selected artifacts; capabilities need not exist.
  AnalysisState.phase = Idle
  merge_precondition
  // Effect: enter the handoff phase.
  AnalysisState.phase' = Merging
  // Frame: claims, findings, completion and emission flags are unchanged.
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.graphFindings' = AnalysisState.graphFindings
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding | f.emitted' = f.emitted
}

// Event: finish the immutable merge-result handoff and begin normalization.
pred complete_merge {
  // Guard: handoff is in progress; merge-result facts describe supplied inputs.
  AnalysisState.phase = Merging
  // Effect: enable normalization.
  AnalysisState.phase' = Normalizing
  // Frame: no claims/findings are constructed during merge handoff.
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.graphFindings' = AnalysisState.graphFindings
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding | f.emitted' = f.emitted
}

// Event: begin coverage only after all valid graph input has been normalized.
pred begin_analysis {
  // Guard: complete valid graph, with rejected source values separately retained.
  AnalysisState.phase = Normalizing
  AnalysisState.graphClaims = graph_input
  // Effect: enter analysis without a completion marker.
  AnalysisState.phase' = Analyzing
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.graphFindings' = AnalysisState.graphFindings
  AnalysisState.analysisComplete' = False
  all f : Finding | f.emitted' = f.emitted
}

// Event: complete analysis after all result obligations are discharged.
pred complete_analysis {
  // Guard: analysis is active and all required findings are present.
  AnalysisState.phase = Analyzing
  analysis_postcondition
  // Effect: publish completion; graph/findings/emission flags are framed.
  AnalysisState.phase' = Complete
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.graphFindings' = AnalysisState.graphFindings
  AnalysisState.analysisComplete' = True
  all f : Finding | f.emitted' = f.emitted
}

pred init_state {
  AnalysisState.phase = Idle
  no AnalysisState.graphClaims
  no AnalysisState.graphFindings
  AnalysisState.analysisComplete = False
  all f : Finding | f.emitted = False
}

fact transitions {
  init_state and always (
    // Phase transitions
    start_merge
    or complete_merge
    or normalize_claims
    or begin_analysis
    or complete_analysis
    // Analysis events
    or (some c : Claim | emit_coverage_gap[c])
    or (some cp : ContradictionPair | emit_contradiction[cp])
    or (some c : Claim | emit_semantic_drift[c])
    or (some cap : Capability | emit_missing_spec_file[cap])
    or (some r : Reference | emit_unsupported_ref[r])
    or (some tc : TaskContradiction | emit_task_conflict[tc])
    or (some c : Claim | emit_task_gap[c])
    // Failure modes
    or (some c : Claim | reject_provenance_free_claim[c])
    or (some c : Claim | reject_capability_free_spec_claim[c])
    // Stutter
    or stutter
  )
}

// --- Global invariants ---

// Safety: findings always have valid evidence (at least one side cited,
// or the finding is a capability-level finding like MissingSpecFile/EmptyCapSkipped)
assert findings_have_evidence {
  always (all f : AnalysisState.graphFindings |
    some f.upstream or some f.downstream or
    f.findingKind in (MissingSpecFile + EmptyCapSkipped))
}

// Safety: analysis phases progress forward without regression.
assert phase_monotonic {
  always (
    (AnalysisState.phase = Complete implies after AnalysisState.phase = Complete)
    and (AnalysisState.phase = Idle implies after AnalysisState.phase in (Idle + Merging))
    and (AnalysisState.phase = Merging implies after AnalysisState.phase in (Merging + Normalizing))
    and (AnalysisState.phase = Normalizing implies after AnalysisState.phase in (Normalizing + Analyzing))
  )
}

// Completion contract: all required results, including rejected-input defects.
// Safety checks at Complete verify this guard. Separate candidate availability,
// actual-action witnesses and liveness checks below verify reporting progress.
pred analysis_postcondition {
  analysis_results_present[AnalysisState.graphFindings]
}
pred analysis_results_present[fs : set Finding] {
  reference_results_present[fs]
  all c : rejected_inputs |
    some f : fs | f.findingKind = AnalysisDefect and f.upstream = c and f.severity = High
  all c : AnalysisState.graphClaims | {
    (analyzable_claim[c] and c in upstream_claims and claim_uncovered[c]) implies
      some f : fs | f.findingKind = CoverageGap and f.upstream = c
    (analyzable_claim[c] and c in task_claims and task_claim_uncovered[c]) implies
      some f : fs | f.findingKind = TaskGap and f.upstream = c
    (analyzable_claim[c] and c in upstream_claims and claim_partially_covered[c]) implies
      some f : fs | f.findingKind = SemanticDrift and f.upstream = c
  }
  all cp : ContradictionPair |
    cp.contra_upstream + cp.contra_downstream in AnalysisState.graphClaims and
    analyzable_claim[cp.contra_upstream] and analyzable_claim[cp.contra_downstream] implies
      some f : fs | f.findingKind = Contradiction and
        f.upstream = cp.contra_upstream and f.downstream = cp.contra_downstream
  all tc : TaskContradiction |
    tc.task_claim + tc.spec_claim in AnalysisState.graphClaims and
    analyzable_claim[tc.task_claim] and analyzable_claim[tc.spec_claim] implies
      some f : fs | f.findingKind = TaskConflict and
        f.upstream = tc.task_claim and f.downstream = tc.spec_claim
}

// Report candidates describe the guards/evidence of the concrete emit actions.
// They do not assert that a required descriptor exists or has been emitted.
fun reporting_candidates : set Finding {
  { f : Finding | no f.affectedCapability and (
    (f.findingKind = AnalysisDefect and f.upstream in rejected_inputs and
      no f.downstream and f.severity = High)
    or (f.findingKind = UnsupportedRef and f.upstream in AnalysisState.graphClaims and
      analyzable_claim[f.upstream] and reference_unsupported[f.affectedReference] and
      no f.downstream and f.severity = Medium)
    or (f.findingKind = CoverageGap and f.upstream in upstream_claims & AnalysisState.graphClaims and
      analyzable_claim[f.upstream] and claim_uncovered[f.upstream] and
      no f.downstream and f.severity = max_severity[f.upstream.obligation])
    or (f.findingKind = TaskGap and f.upstream in task_claims & AnalysisState.graphClaims and
      analyzable_claim[f.upstream] and task_claim_uncovered[f.upstream] and
      no f.downstream and f.severity = Medium)
    or (f.findingKind = Contradiction and f.severity = max_severity[f.upstream.obligation] and
      f.upstream + f.downstream in AnalysisState.graphClaims and
      some cp : ContradictionPair | cp.contra_upstream = f.upstream and cp.contra_downstream = f.downstream)
    or (f.findingKind = TaskConflict and f.severity = max_severity[f.downstream.obligation] and
      f.upstream + f.downstream in AnalysisState.graphClaims and
      some tc : TaskContradiction | tc.task_claim = f.upstream and tc.spec_claim = f.downstream)
    or (f.findingKind = SemanticDrift and f.upstream in upstream_claims & AnalysisState.graphClaims and
      claim_partially_covered[f.upstream] and f.severity = max_severity[f.upstream.obligation] and
      some link : CoverageLink | link.upstreamClaim = f.upstream and
        link.downstreamClaim = f.downstream and link.downstreamClaim in AnalysisState.graphClaims and
        f.omissions = link.omittedDetails and link.partial = True)
  ) } +
  { f : Finding | f.findingKind = MissingSpecFile and some f.affectedCapability and
    capability_missing_spec[f.affectedCapability] and no f.upstream + f.downstream and f.severity = High }
}
// Explicit finite-scope resource premise, not a global fact or scheduling rule.
// If the scope lacks a necessary descriptor, candidate-capacity checks/witnesses
// expose the shortage instead of calling the input fairly completable.
pred reporting_capacity { analysis_results_present[reporting_candidates] }
pred reporting_enabled {
  AnalysisState.phase = Analyzing
  some reporting_candidates - AnalysisState.graphFindings
}
// Event family: actual guarded reporting actions, not assumed result growth.
pred reporting_step {
  (some c : Claim | emit_coverage_gap[c] or emit_semantic_drift[c] or
    emit_task_gap[c] or reject_provenance_free_claim[c] or reject_capability_free_spec_claim[c])
  or (some cp : ContradictionPair | emit_contradiction[cp])
  or (some cap : Capability | emit_missing_spec_file[cap])
  or (some r : Reference | emit_unsupported_ref[r])
  or (some tc : TaskContradiction | emit_task_conflict[tc])
}

// Weak action-service fairness excludes endless stuttering for enabled work.
// It schedules concrete actions, never assumes that all results already exist.
pred analysis_fairness {
  // Guard: Idle with selected artifacts (including proposal-only inputs).
  always ((AnalysisState.phase = Idle and merge_precondition) implies eventually start_merge)
  // If merge is in progress, it eventually completes
  always (AnalysisState.phase = Merging implies eventually complete_merge)
  always ((AnalysisState.phase = Normalizing and AnalysisState.graphClaims != graph_input)
    implies eventually normalize_claims)
  always ((AnalysisState.phase = Normalizing and AnalysisState.graphClaims = graph_input)
    implies eventually begin_analysis)
  always (reporting_enabled implies eventually reporting_step)
  always ((AnalysisState.phase = Analyzing and analysis_postcondition)
    implies eventually complete_analysis)
}

// Liveness: with enough descriptor capacity at analysis, fair actions complete.
assert analysis_eventually_completes {
  analysis_fairness and always (AnalysisState.phase = Analyzing implies reporting_capacity)
    implies eventually AnalysisState.phase = Complete
}

// Liveness: fair reporting drains all required results when capacity suffices.
assert fair_analysis_eventually_reports_all_results {
  analysis_fairness and always (AnalysisState.phase = Analyzing implies reporting_capacity) implies eventually
    (AnalysisState.phase = Complete and analysis_postcondition)
}
// Liveness: rejected inputs eventually receive defects under the same premises.
assert fair_defect_reporting {
  analysis_fairness and always (AnalysisState.phase = Analyzing implies reporting_capacity) implies
    always (all c : rejected_inputs | eventually
      (some f : AnalysisState.graphFindings | f.findingKind = AnalysisDefect and f.upstream = c))
}
// Safety: pending obligations have a concrete candidate when capacity suffices.
assert pending_results_have_candidates {
  always (AnalysisState.phase = Analyzing and reporting_capacity and not analysis_postcondition
    implies reporting_enabled)
}
// Safety: a reporting action emits a new candidate and cannot silently stutter.
assert reporting_actions_make_progress {
  always (reporting_step implies one AnalysisState.graphFindings' - AnalysisState.graphFindings and
    AnalysisState.graphFindings' - AnalysisState.graphFindings in reporting_candidates)
}

// Safety: once complete, no new findings are added
assert complete_is_stable {
  always (AnalysisState.phase = Complete implies
    AnalysisState.graphFindings' = AnalysisState.graphFindings)
}

// --- Monotonicity invariants ---

// Safety: the claim set never shrinks (claims are never removed)
assert claims_monotonic {
  always (AnalysisState.graphClaims in AnalysisState.graphClaims')
}

// Safety: the findings set never shrinks (findings are never retracted)
assert findings_monotonic {
  always (AnalysisState.graphFindings in AnalysisState.graphFindings')
}

// Safety: once a finding is emitted, it remains emitted (irreversible)
assert emission_irreversible {
  always (all f : Finding |
    f.emitted = True implies after f.emitted = True)
}

// --- Phase-event consistency ---

// Safety: analysis events only fire during the Analyzing phase
assert analysis_events_respect_phase {
  always (
    (some c : Claim | emit_coverage_gap[c]) or
    (some cp : ContradictionPair | emit_contradiction[cp]) or
    (some c : Claim | emit_semantic_drift[c]) or
    (some cap : Capability | emit_missing_spec_file[cap]) or
    (some r : Reference | emit_unsupported_ref[r]) or
    (some tc : TaskContradiction | emit_task_conflict[tc]) or
    (some c : Claim | emit_task_gap[c]) or
    (some c : Claim | reject_provenance_free_claim[c]) or
    (some c : Claim | reject_capability_free_spec_claim[c])
      implies AnalysisState.phase = Analyzing
  )
}

// Safety: no findings exist in the graph before analysis begins
assert no_findings_before_analysis {
  always (AnalysisState.phase in (Idle + Merging + Normalizing) implies
    no AnalysisState.graphFindings)
}

// Safety: no claims exist before normalization begins
assert no_claims_before_normalization {
  always (AnalysisState.phase in (Idle + Merging) implies
    no AnalysisState.graphClaims)
}

// --- Coverage link well-formedness ---

// Fact: coverage links connect upstream artifacts to downstream artifacts
fact coverage_link_wellformedness {
  all link : CoverageLink {
    link.upstreamClaim in upstream_claims + task_claims
    link.downstreamClaim in downstream_claims
  }
}

// Fact: coverage links only reference claims from active (non-empty) capabilities
fact coverage_links_respect_merge {
  all link : CoverageLink |
    (some link.downstreamClaim.capability) implies
      capability_active_for_coverage[link.downstreamClaim.capability]
}

// Semantic comparison results are immutable inputs over normalized,
// traceable claims. Defective claims remain reviewable, without conclusions.
fact comparison_inputs_are_traceable {
  all link : CoverageLink | {
    link.upstreamClaim + link.downstreamClaim in normalized_input
    analyzable_claim[link.upstreamClaim]
    analyzable_claim[link.downstreamClaim]
  }
  all cp : ContradictionPair | {
    cp.contra_upstream + cp.contra_downstream in normalized_input
    analyzable_claim[cp.contra_upstream]
    analyzable_claim[cp.contra_downstream]
  }
  all tc : TaskContradiction | {
    tc.task_claim + tc.spec_claim in normalized_input
    analyzable_claim[tc.task_claim]
    analyzable_claim[tc.spec_claim]
  }
}

// Fact: uniqueness uses the five-field identity (kind, upstream, downstream,
// capability, reference); two unsupported citations on one claim stay distinct.
fact finding_uniqueness {
  all disj f1, f2 : Finding |
    not (f1.findingKind = f2.findingKind and
         f1.upstream = f2.upstream and
         f1.downstream = f2.downstream and
         f1.affectedCapability = f2.affectedCapability and
         f1.affectedReference = f2.affectedReference)
}

// --- Completeness liveness ---

// Finite immutable input and monotone findings make fair reporting drain.
pred analysis_event_fairness {
  analysis_fairness
}

// Liveness: analyzable contradictions are eventually reported, independently
// of the completed-state reporting guard.
assert all_contradictions_surfaced {
  analysis_event_fairness and always (AnalysisState.phase = Analyzing implies reporting_capacity) implies
    always (AnalysisState.phase = Analyzing implies
      all cp : ContradictionPair |
        (cp.contra_upstream in AnalysisState.graphClaims and
         cp.contra_downstream in AnalysisState.graphClaims and
         analyzable_claim[cp.contra_upstream] and analyzable_claim[cp.contra_downstream]) implies
          eventually some f : AnalysisState.graphFindings |
            f.findingKind = Contradiction and
            f.upstream = cp.contra_upstream and
            f.downstream = cp.contra_downstream)
}

// Liveness: with event fairness, all unsupported refs are eventually surfaced
assert all_unsupported_refs_surfaced {
  analysis_event_fairness and always (AnalysisState.phase = Analyzing implies reporting_capacity) implies
    always (AnalysisState.phase = Analyzing implies
      all r : Reference |
        (reference_unsupported[r] and r.refSource in AnalysisState.graphClaims and
         analyzable_claim[r.refSource]) implies
          eventually some f : AnalysisState.graphFindings |
            f.findingKind = UnsupportedRef and f.affectedReference = r)
}

// Liveness: with event fairness, all semantic drift is eventually surfaced
assert all_drift_surfaced {
  analysis_event_fairness and always (AnalysisState.phase = Analyzing implies reporting_capacity) implies
    always (AnalysisState.phase = Analyzing implies
      all c : upstream_claims & AnalysisState.graphClaims |
        (claim_partially_covered[c] and analyzable_claim[c]) implies
          eventually some f : AnalysisState.graphFindings |
            f.findingKind = SemanticDrift and f.upstream = c)
}

// Safety postcondition: all empty capabilities have merge skip evidence.
assert all_empty_caps_surfaced {
    always (AnalysisState.phase = Complete implies
      all cap : Capability |
        capability_merged_empty[cap] implies
          some mf : cap.mergedView.mergeFindings | mf.mfKind = MergeEmptyCapSkipped)
}

// Merge-result identity is constrained by merged_view_consistency above.
// Cross-run merge determinism belongs to the authoritative merge model/tests;
// having one view per capability does not independently establish that property.

// --- Verification commands ---
// Default scopes include source structure and evidence vocabulary. These
// commands check finite lasso traces; passing checks are bounded evidence.

run show_claim_graph {} for 3 but 8 steps expect 1

run scenario_coverage_gap_found {
  completes_after_reporting_kind[CoverageGap]
} for 3 but 15 steps expect 1

run scenario_contradiction_found {
  completes_after_reporting_kind[Contradiction]
} for 3 but 15 steps expect 1

run scenario_full_analysis {
  analysis_fairness
  always (AnalysisState.phase = Analyzing implies reporting_capacity)
  eventually some AnalysisState.graphClaims
  eventually #(AnalysisState.graphFindings) >= 3
  eventually AnalysisState.phase = Complete
} for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 15 steps expect 1

run scenario_merge_then_analyze {
  eventually (AnalysisState.phase = Merging) ;
  eventually (AnalysisState.phase = Normalizing) ;
  eventually (AnalysisState.phase = Complete)
} for 3 but 10 steps expect 1

run scenario_empty_cap_skipped {
  some cap : Capability | capability_merged_empty[cap] and
    some mf : cap.mergedView.mergeFindings | mf.mfKind = MergeEmptyCapSkipped
  eventually AnalysisState.phase = Complete
} for 3 but 8 steps expect 1

run scenario_removed_req_excluded {
  some mc : MergedCapabilitySpec | some mc.removedBaseReqs and some mc.activeReqs and
    some s : SourceItem | s.parentRequirement in mc.removedBaseReqs and
      some s.parsedScenario and
      eventually (AnalysisState.phase = Complete and some AnalysisState.graphClaims and
        no c : AnalysisState.graphClaims | c.source = s)
} for 3 but 4 ParsedRequirement, 4 ReqIdentifier, 15 steps expect 1

// --- Existing safety and liveness checks ---

// Preserve the earlier useful claim/finding/requirement scopes and 20-step
// liveness horizon. New source-identity scopes match the four-claim budget.
check provenance_integrity for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
check mandatory_produces_high_severity for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check advisory_produces_medium_severity for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check informational_no_high_severity for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check contradiction_cites_both for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check drift_identifies_omission for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check archived_refs_never_flagged for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check task_conflict_cites_both for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check findings_have_evidence for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check complete_is_stable for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check analysis_eventually_completes for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
// Alloy lasso counterexamples are real model behaviors, not spurious merely
// because they stutter. Scheduler fairness is stated explicitly above.

// --- Extended property checks ---

check claims_monotonic for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check findings_monotonic for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check emission_irreversible for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check analysis_events_respect_phase for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check no_findings_before_analysis for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check all_contradictions_surfaced for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check all_unsupported_refs_surfaced for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check all_drift_surfaced for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0

// --- Merge-related property checks (new) ---

check spec_claims_carry_capability for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
check no_claims_from_empty_capabilities for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
check empty_caps_produce_no_claims for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
check empty_caps_excluded_from_coverage for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
check removed_reqs_never_produce_claims for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
check no_silent_delta_discard for 3 but 4 ParsedRequirement, 4 ReqIdentifier, 1 steps expect 0
check all_empty_caps_surfaced for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
check phase_monotonic for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check no_claims_before_normalization for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0

// --- Merge-coverage initiation and reachable-state checks ---

check merge_coverage_initiation for 4 but 6 ParsedRequirement, 6 ReqIdentifier, 1 steps expect 0
check merge_coverage_reachable_invariant for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0

// --- Source, modality, admission, failure-boundary and determinism checks ---
run scenario_provenance_defect {
  some c : rejected_source_input | not sufficient_provenance[c] and
    eventually (some f : AnalysisState.graphFindings |
      f.findingKind = AnalysisDefect and f.upstream = c and f.severity = High)
  eventually AnalysisState.phase = Complete
} for 3 but 8 steps expect 1
run scenario_supported_live_reference {
  some r : Reference | r.isArchived = False and reference_supported[r] and
    eventually (AnalysisState.phase = Complete and r.refSource in AnalysisState.graphClaims and
      no f : AnalysisState.graphFindings | f.affectedReference = r)
} for 3 but 8 steps expect 1
run scenario_mixed_archive_and_unsupported_reference {
  some disj historical, bad : Reference | historical.refSource = bad.refSource and
    historical.isArchived = True and reference_unsupported[bad]
  eventually (some f : AnalysisState.graphFindings | f.findingKind = UnsupportedRef)
} for 3 but 8 steps expect 1
run scenario_permission_conflicts_with_prohibition {
  some disj p, prohibition : SemanticRule |
    p.ruleClaim in normalized_input and prohibition.ruleClaim in normalized_input and
    p.ruleClaim.permission = True and prohibition.ruleClaim.obligation = Mandatory and
    permission_conflicts_with_baseline[p, prohibition]
} for 3 but 1 steps expect 1
run scenario_duplicate_display_ids_remain_distinct {
  some disj c, d : normalized_input | some c.source.displayIdentifier and
    c.source.displayIdentifier = d.source.displayIdentifier and
    c.source.sourceArtifact + d.source.sourceArtifact in CapabilitySpec and
    c.source.parentRequirement = d.source.parentRequirement and
    some c.source.parsedScenario and some d.source.parsedScenario
} for 3 but 1 steps expect 1
run scenario_excluded_statement_and_sample_error {
  some a : Admission | some a.excluded and some a.eligible and
    some o : SampleOutcome | o.admission = a and o.status = ErrorSample
} for 3 but 1 steps expect 1
run scenario_two_equal_runs {
  some disj a, b : AnalysisRun | same_input[a, b] and snapshot_matches_invocation[a] and
    some a.runGraph and eventually (AnalysisState.phase = Complete and
      a.runGraph = AnalysisState.graphClaims)
} for 3 but 15 steps expect 1
run scenario_merge_failure {
  some mc : MergedCapabilitySpec, r : ParsedRequirement |
    r in mc.skippedReqs and r.reqDeltaOp in DeltaModified + DeltaRemoved and
    some mf : mc.mergeFindings | mf.mfAffectedReq = r
} for 3 but 1 steps expect 1
run scenario_task_coverage_link {
  some link : CoverageLink | link.upstreamClaim in task_claims
  no DownstreamInput.received
  all link : CoverageLink | link.partial = False
  eventually AnalysisState.phase = Complete
} for 3 but exactly 2 Claim, exactly 2 SourceItem, 2 Artifact,
  0 Finding, 0 Reference, 0 SemanticRule, 0 AnalysisRun, 0 Admission,
  0 SampleOutcome, 0 ParsedScenario, 0 ContradictionPair, 0 TaskContradiction,
  1 Capability, 1 MergedCapabilitySpec, 1 ParsedRequirement,
  exactly 1 CoverageLink, 8 steps expect 1

check normalization_preserves_source_structure for 3 but 8 steps expect 0
check defective_inputs_are_reported for 3 but 8 steps expect 0
check structural_modal_is_authoritative for 3 but 8 steps expect 0
check advisory_and_permission_do_not_constrain_baseline for 3 but 1 steps expect 0
check permission_absence_is_not_a_violation for 3 but 1 steps expect 0
check completed_reference_validation for 3 but 8 steps expect 0
check unsupported_reference_names_exact_target for 3 but 8 steps expect 0
check missing_specs_surfaced for 3 but 8 steps expect 0
check uncovered_claims_surfaced for 3 but 8 steps expect 0
check task_gaps_surfaced for 3 but 8 steps expect 0
check claim_graph_is_deterministic_function for 3 but 1 steps expect 0
check snapshot_matches_operational_graph for 3 but 15 steps expect 0
check disposition_partition_is_total for 3 but 1 steps expect 0
check excluded_statements_remain_reviewable for 3 but 1 steps expect 0
check display_identifiers_cannot_merge_claims for 3 but 1 steps expect 0
check eligible_indexes_follow_filter for 3 but 1 steps expect 0
check sample_errors_do_not_change_disposition for 3 but 1 steps expect 0
check sample_outcomes_join_source_local_identity for 3 but 1 steps expect 0
check fair_analysis_eventually_reports_all_results for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check fair_defect_reporting for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0

// Nonvacuity: exercise pending work and the actual reporting actions before
// completion, rather than relying solely on Complete => reporting postconditions.
pred completes_after_reporting_kind[k : FindingKind] {
  eventually (AnalysisState.phase = Analyzing and reporting_enabled and reporting_step and
    some f : AnalysisState.graphFindings' - AnalysisState.graphFindings | f.findingKind = k)
  eventually AnalysisState.phase = Complete
}
run scenario_drift_action { completes_after_reporting_kind[SemanticDrift] }
  for 3 but 15 steps expect 1
run scenario_missing_spec_action { completes_after_reporting_kind[MissingSpecFile] }
  for 3 but 15 steps expect 1
run scenario_unsupported_ref_action { completes_after_reporting_kind[UnsupportedRef] }
  for 3 but 15 steps expect 1
run scenario_task_conflict_action { completes_after_reporting_kind[TaskConflict] }
  for 3 but 15 steps expect 1
run scenario_task_gap_action { completes_after_reporting_kind[TaskGap] }
  for 3 but 15 steps expect 1
run scenario_defect_action { completes_after_reporting_kind[AnalysisDefect] }
  for 3 but 15 steps expect 1
run scenario_rejected_spec_remains_in_scope {
  some a : Admission, c : a.extracted & rejected_source_input |
    c in a.excluded & a.reviewable & a.coverageContext & a.scopeReported and
    c not in a.eligible and
    eventually (AnalysisState.phase = Complete and c not in AnalysisState.graphClaims)
} for 3 but 15 steps expect 1
run scenario_insufficient_finding_scope {
  some rejected_source_input
  analysis_fairness
  eventually always (AnalysisState.phase = Analyzing and not analysis_postcondition and
    not reporting_capacity and not reporting_enabled)
} for 3 but 0 Finding, 15 steps expect 1

check no_silent_orphan_consumption for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check conclusion_provenance_integrity for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check skipped_and_replaced_blocks_never_produce_claims for 3 but 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
check graph_scenarios_follow_merge_handoff for 3 but 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
check pending_results_have_candidates for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check reporting_actions_make_progress for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 20 steps expect 0
check only_active_caps_analyzed for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
check empty_caps_surfaced for 3 but 4 Claim, 4 SourceItem, 4 SourceIdentity, 4 Finding, 4 ParsedRequirement, 4 ReqIdentifier, 20 steps expect 0
```

**Verification boundary:** Commands use the explicit scopes above, including the restored four-claim/four-finding budgets and up to 20 trace steps. Merge decisions, concrete semantic comparison and serialization require the authoritative merge model and implementation evidence cited above. Completion postconditions, action reachability and fairness-conditioned progress are distinct checks; insufficient finding capacity is explicitly witnessed rather than silently assumed away. The previous 2026-11-15 results apply to the earlier model, not this revision.

Reproduce with `java -jar /path/to/alloy-6.2.0.jar exec -s minisat -c '*' -t none -o /path/to/results openspec/specs/claim-graph-and-coverage/spec.md`.
