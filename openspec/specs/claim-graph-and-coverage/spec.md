---
title: ClaimGraphAndCoverage
---

## Purpose

Define the claim graph construction and coverage analysis behavior for the spec-check tool: normalizing parsed content into typed claims and analyzing coverage, contradiction, and semantic alignment across proposal, design, and capability specs.

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

// Obligation levels (EARS keyword classification)
abstract sig ObligationLevel {}
one sig Mandatory, Advisory, Informational extends ObligationLevel {}

// Claim kinds
abstract sig ClaimKind {}
one sig Behavioral, Structural, Constraint extends ClaimKind {}

// A typed claim: the core unit of the claim graph
sig Claim {
  kind : one ClaimKind,
  obligation : one ObligationLevel,
  provenance : lone Provenance
}

// Finding severity levels (ordered)
abstract sig Severity {}
one sig High, Medium, Low extends Severity {}

// Finding kinds emitted by analysis
abstract sig FindingKind {}
one sig CoverageGap, Contradiction, SemanticDrift,
        MissingSpecFile, UnsupportedRef, TaskConflict,
        TaskGap, AnalysisDefect extends FindingKind {}

// A finding: the result of coverage analysis
sig Finding {
  findingKind : one FindingKind,
  severity : one Severity,
  upstream : lone Claim,
  downstream : lone Claim,
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
  all f : Finding, r : Reference |
    (f.findingKind = UnsupportedRef and f.upstream = r.refSource) implies
      r.isArchived = False
}

// Bool (via the module import) for tracking emission state

// Capability declared in a proposal
sig Capability {
  declaredIn : one Proposal,
  specFile : lone CapabilitySpec
}

// References from requirements to upstream content
sig Reference {
  refSource : one Claim,       // the claim that declares the reference
  refTarget : one Section,     // the upstream section referenced
  isArchived : one Bool        // whether target is in changes/archive/
}

// Coverage relation: semantic alignment between claims
sig CoverageLink {
  upstreamClaim : one Claim,
  downstreamClaim : one Claim,
  partial : one Bool           // whether coverage is only partial
}

// --- Analysis state ---

one sig AnalysisState {
  var phase : one Phase,
  var graphClaims : set Claim,
  var graphFindings : set Finding,
  var analysisComplete : one Bool
}

abstract sig Phase {}
one sig Idle, Normalizing, Analyzing, Complete extends Phase {}
```

## Requirements

### Requirement: Normalize Parsed Content Into Typed Claims [CGC-NORMALIZE-CLAIMS]
WHEN parsed proposal, design, merged capability spec, or task content is available, THE spec-check tool SHALL normalize the content into typed claims that preserve claim kind, source text, obligation level when present, original source provenance needed for downstream analysis, and capability identity for all spec-derived claims.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Interaction Protocols`

#### Scenario: Preserve Claim Provenance [CGC-CLAIM-PROVEN]
WHEN the tool derives a claim from a requirement, scenario, design section, or task summary, THE spec-check tool SHALL attach the source file and nearest heading needed to trace that claim back to its origin.

**Postcondition:** Every derived claim can be traced back to its originating artifact section.

##### Evidence
- Implementation: [claim-graph.ts:152 buildClaimGraph()](/src/domain/claim-graph.ts#L152), [claim-graph.ts:208 claimFromRequirement()](/src/domain/claim-graph.ts#L208), [claim-graph.ts:229 claimFromScenario()](/src/domain/claim-graph.ts#L229)
- Test: [claim-graph.test.ts:7 assigns obligation levels and keeps provenance](/test/contract/claim-graph.test.ts#L7), [safety-liveness.invariant.test.ts:45 no claim enters graph without provenance](/test/invariant/safety-liveness.invariant.test.ts#L45)
- Test (property): [claim-graph.property.test.ts:9 every claim has provenance with a file](/test/property/claim-graph.property.test.ts#L9)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const req = { title: "R1", identifier: "R1", body: "THE system SHALL respond", earsType: "event-driven", references: [], provenance: { file: "spec.md", line: 1 } };
const spec = { file: "spec.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const { graph } = buildClaimGraph({ specs: [spec] }); //*
graph.claims[0].provenance.file; //=> spec.md
```

#### Scenario: Reject Provenance-Free Finding Input [CGC-CLAIM-FAIL]
IF a downstream analysis step would consume a claim without sufficient provenance, THEN THE spec-check tool SHALL treat that condition as an analysis defect and SHALL surface it as a finding instead of issuing an untraceable conclusion.

**Postcondition:** Downstream analysis does not rely on orphaned claims.

##### Evidence
- Implementation: [claim-graph.ts:396 detectOrphanClaims()](/src/domain/claim-graph.ts#L396)
- Test: [claim-graph.test.ts:48 surfaces orphaned claim without provenance](/test/contract/claim-graph.test.ts#L48)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const req = { title: "R1", identifier: "R1", body: "SHALL do X", earsType: "event-driven", references: [], provenance: { file: "", line: 1 } };
const spec = { file: "", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const result = buildClaimGraph({ specs: [spec] }); //*
result.findings[0].category; //=> claim_graph.orphaned_claim
```

#### Scenario: Populate Capability Identity On Spec-Derived Claims [CGC-CLAIM-CAP]
WHEN the tool derives a claim from a merged capability requirement or scenario, THE spec-check tool SHALL attach the capability identity of the merged capability view to that claim.

**Postcondition:** Downstream specs-forward grouping can use capability identity without re-inferring it from source file paths.

#### Requirement model

```alloy
// --- Claim normalization: provenance and typing ---

// Precondition: normalization requires parsed content from at least one artifact
pred normalization_precondition {
  some Section
  some Artifact
}

// Postcondition: every claim in the graph has valid provenance
pred all_claims_have_provenance {
  all c : AnalysisState.graphClaims | some c.provenance
}

// Event: normalize parsed content into claims
pred normalize_claims {
  // Guard: in normalizing phase with parsed content available
  AnalysisState.phase = Normalizing
  normalization_precondition
  // Effect: claims are added to the graph with provenance (monotonic growth)
  AnalysisState.graphClaims in AnalysisState.graphClaims'
  all c : AnalysisState.graphClaims' - AnalysisState.graphClaims |
    some c.provenance
  // Phase advances
  AnalysisState.phase' = Analyzing
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  AnalysisState.graphFindings' = AnalysisState.graphFindings
  // Findings emission unchanged
  all f : Finding | f.emitted' = f.emitted
}

// Failure mode: provenance-free claim detected during analysis
pred reject_provenance_free_claim [c : Claim] {
  // Guard: claim has no provenance and is about to be consumed
  no c.provenance
  c in AnalysisState.graphClaims
  AnalysisState.phase = Analyzing
  // Effect: emit an analysis-defect finding instead of using the claim
  some f : Finding {
    f.findingKind = AnalysisDefect
    f.upstream = c
    no f.downstream
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

// Safety: no claim in graph ever lacks provenance after normalization completes
assert provenance_integrity {
  always (AnalysisState.phase = Analyzing implies all_claims_have_provenance)
}

// Safety: provenance-free claims are never silently consumed
assert no_silent_orphan_consumption {
  always (all c : Claim |
    (no c.provenance and c in AnalysisState.graphClaims and AnalysisState.phase = Analyzing)
      implies (some f : AnalysisState.graphFindings' |
        f.findingKind = AnalysisDefect and f.upstream = c))
}
```

### Requirement: Obligation Level Assignment [CGC-OBLIGATION-LEVEL]
WHEN the spec-check tool normalizes a claim from a requirement or scenario, THE spec-check tool SHALL assign an obligation level (mandatory, advisory, or informational) based on the source structure and EARS pattern keywords.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: SHALL Requirement Classified As Mandatory [CGC-OBLIG-MANDATORY]
WHEN a requirement uses the keyword SHALL without qualification, THE spec-check tool SHALL assign the mandatory obligation level to that claim.

**Postcondition:** Mandatory claims produce higher-severity findings in downstream analysis when violated.

##### Evidence
- Implementation: [claim-graph.ts:376 deriveObligation()](/src/domain/claim-graph.ts#L376)
- Test: [claim-graph.test.ts:7 assigns obligation levels and keeps provenance](/test/contract/claim-graph.test.ts#L7)
- Test (property): [claim-graph.property.test.ts:39 obligation assignment is consistent across EARS patterns](/test/property/claim-graph.property.test.ts#L39)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const req = { title: "R1", identifier: "R1", body: "THE system SHALL process it", earsType: "event-driven", references: [], provenance: { file: "s.md", line: 1 } };
const spec = { file: "s.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const { graph } = buildClaimGraph({ specs: [spec] }); //*
graph.claims[0].obligation; //=> mandatory
```

#### Scenario: SHOULD Requirement Classified As Advisory [CGC-OBLIG-ADVISORY]
WHEN a requirement uses the keyword SHOULD, THE spec-check tool SHALL assign the advisory obligation level to that claim.

**Postcondition:** Advisory claims produce lower-severity findings than mandatory claims when violated.

##### Evidence
- Implementation: [claim-graph.ts:376 deriveObligation()](/src/domain/claim-graph.ts#L376)
- Test: [claim-graph.test.ts:7 assigns obligation levels and keeps provenance](/test/contract/claim-graph.test.ts#L7)
- Test (property): [claim-graph.property.test.ts:39 obligation assignment is consistent across EARS patterns](/test/property/claim-graph.property.test.ts#L39)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const req = { title: "R1", identifier: "R1", body: "THE system SHOULD log events", earsType: "event-driven", references: [], provenance: { file: "s.md", line: 1 } };
const spec = { file: "s.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const { graph } = buildClaimGraph({ specs: [spec] }); //*
graph.claims[0].obligation; //=> advisory
```

#### Scenario: Informational Content Classified [CGC-OBLIG-INFO]
WHEN a claim is derived from a design property, assumption, or informational section that does not use obligation keywords, THE spec-check tool SHALL assign the informational obligation level.

**Postcondition:** Informational claims contribute to coverage analysis without triggering mandatory-severity findings.

##### Evidence
- Implementation: [claim-graph.ts:376 deriveObligation()](/src/domain/claim-graph.ts#L376), [claim-graph.ts:251 extractProposalClaims()](/src/domain/claim-graph.ts#L251)
- Test: [claim-graph.test.ts:102 classifies informational content at informational obligation](/test/contract/claim-graph.test.ts#L102), [safety-liveness.invariant.test.ts:130 claims with non-standard obligation produce only informational findings](/test/invariant/safety-liveness.invariant.test.ts#L130)
- Test (property): [claim-graph.property.test.ts:39 obligation assignment is consistent across EARS patterns](/test/property/claim-graph.property.test.ts#L39)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const proposal = { file: "proposal.md", sections: new Map([["Scope", { heading: "Scope", lines: ["analysis covers formal methods"], startLine: 1, endLine: 2 }]]), unparsed: [] };
const { graph } = buildClaimGraph({ proposal, specs: [] }); //*
graph.claims[0].obligation; //=> informational
```

#### Scenario: MAY Requirement Classified As Informational [CGC-OBLIG-OPTIONAL]
WHEN a requirement uses the keyword MAY, THE spec-check tool SHALL assign the informational obligation level to that claim.

**Postcondition:** Optional behavior does not trigger mandatory- or advisory-severity findings when absent or deviated from.

##### Evidence
- Implementation: [claim-graph.ts:376 deriveObligation()](/src/domain/claim-graph.ts#L376)
- Test: [claim-graph.test.ts:74 classifies MAY requirement as informational obligation](/test/contract/claim-graph.test.ts#L74)
- Example:
```typescript
const { buildClaimGraph } = await import("./src/domain/claim-graph.ts");
const req = { title: "R1", identifier: "R1", body: "THE system MAY include color formatting", earsType: "event-driven", references: [], provenance: { file: "s.md", line: 1 } };
const spec = { file: "s.md", requirements: [req], scenarios: [], deltaSections: ["ADDED"], structuralFindings: [], unparsed: [] };
const { graph } = buildClaimGraph({ specs: [spec] }); //*
graph.claims[0].obligation; //=> informational
```

#### Requirement model

```alloy
// --- Obligation level assignment and severity mapping ---

// Severity mapping: obligation level determines finding severity ceiling
fun max_severity [o : ObligationLevel] : Severity {
  o = Mandatory implies High
  else o = Advisory implies Medium
  else Low
}

// Predicate: a finding respects the obligation-severity ceiling
pred finding_respects_obligation [f : Finding] {
  some f.upstream implies
    severity_leq[f.severity, max_severity[f.upstream.obligation]]
}

// Severity ordering: High > Medium > Low
pred severity_leq [s1, s2 : Severity] {
  s2 = High
  or (s1 = Medium and s2 != Low)
  or s1 = Low
}

// Safety: mandatory violations always produce High severity
assert mandatory_produces_high_severity {
  all f : Finding |
    (f.findingKind in (Contradiction + CoverageGap + SemanticDrift) and
     some f.upstream and f.upstream.obligation = Mandatory)
      implies f.severity = High
}

// Safety: advisory violations produce at most Medium severity
assert advisory_produces_medium_severity {
  all f : Finding |
    (f.findingKind in (Contradiction + CoverageGap + SemanticDrift) and
     some f.upstream and f.upstream.obligation = Advisory)
      implies f.severity in (Medium + Low)
}

// Safety: informational claims never produce mandatory-severity findings
assert informational_no_high_severity {
  all f : Finding |
    (f.findingKind in (Contradiction + CoverageGap + SemanticDrift) and
     some f.upstream and f.upstream.obligation = Informational)
      implies f.severity = Low
}

// Invariant: every claim has exactly one obligation level (structural from sig)
// Alloy's `one` multiplicity on the field enforces this statically.
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
- Implementation: [coverage.ts:212 detectCoverageGaps()](/src/domain/spec-forward/coverage.ts#L212)
- Test: [coverage.test.ts:44 detects uncovered upstream claims](/test/contract/coverage.test.ts#L44)
- Test (integration): [pipeline.integration.test.ts:70 coverage gaps produce expected findings](/test/integration/pipeline.integration.test.ts#L70)
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
- Implementation: [coverage.ts:253 detectContradictionsAndDrift()](/src/domain/spec-forward/coverage.ts#L253)
- Test: [coverage.test.ts:52 detects contradictions between upstream and downstream](/test/contract/coverage.test.ts#L52)
- Test (integration): [pipeline.integration.test.ts:96 contradictions produce expected findings](/test/integration/pipeline.integration.test.ts#L96)
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
- Implementation: [coverage.ts:253 detectContradictionsAndDrift()](/src/domain/spec-forward/coverage.ts#L253)
- Test: [coverage.test.ts:89 detects semantic drift for failure modes](/test/contract/coverage.test.ts#L89)
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
  AnalysisState.phase = Analyzing
  // Effect: emit finding
  some f : Finding {
    f.findingKind = CoverageGap
    f.upstream = c
    no f.downstream
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
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding {
    f.findingKind = Contradiction
    f.upstream = cp.contra_upstream
    f.downstream = cp.contra_downstream
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
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding, link : CoverageLink {
    link.upstreamClaim = c
    link.partial = True
    f.findingKind = SemanticDrift
    f.upstream = c
    f.downstream = link.downstreamClaim
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

// Safety: every uncovered upstream claim eventually gets a finding
// (bidirectional: downstream without upstream justification also surfaced)
assert uncovered_claims_surfaced {
  always (
    (AnalysisState.phase = Complete) implies
      (all c : upstream_claims & AnalysisState.graphClaims |
        claim_uncovered[c] implies
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
  all f : Finding |
    f.findingKind = SemanticDrift implies
      (some f.upstream and some f.downstream)
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
- Implementation: [coverage.ts:100 detectMissingSpecFiles()](/src/domain/spec-forward/coverage.ts#L100)
- Test: [coverage.test.ts:33 detects missing spec files for declared capabilities](/test/contract/coverage.test.ts#L33)
- Test (integration): [pipeline.integration.test.ts:70 coverage gaps produce expected findings](/test/integration/pipeline.integration.test.ts#L70)
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
- Implementation: [coverage.ts:156 detectUnsupportedReferences()](/src/domain/spec-forward/coverage.ts#L156), [coverage.ts:523 isArchivedChangeReference()](/src/domain/spec-forward/coverage.ts#L523)
- Test: [coverage.test.ts:69 detects unsupported requirement references](/test/contract/coverage.test.ts#L69), [coverage.test.ts:79 accepts archived change references as valid provenance](/test/contract/coverage.test.ts#L79)
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

### Requirement: Use Merged Capability Views For Coverage [CGC-MERGED-COVERAGE]
WHEN the spec-check tool performs proposal-to-spec mapping and downstream coverage analysis, THE spec-check tool SHALL use merged capability specs as the active capability source of truth rather than raw per-file parsed specs.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Postconditions`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Interaction Protocols`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Verification Strategy`

#### Scenario: Removed Requirements Do Not Participate In Coverage [CGC-COVERAGE-REMOVED]
WHEN a requirement is removed from the active merged capability view by a valid `REMOVED` delta operation, THE spec-check tool SHALL exclude that removed requirement from downstream coverage analysis.

**Postcondition:** Coverage reflects the same active capability behavior used by claim extraction and logic.

#### Scenario: Empty Merged Capability Skipped In Coverage [CGC-COVERAGE-EMPTY]
IF a capability produces zero surviving merged requirements and the merge layer emits `spec_merge.empty_capability_skipped`, THEN THE spec-check tool SHALL omit that capability from coverage analysis.

**Postcondition:** Coverage analysis does not report misleading results for vacuous capability groups.

#### Requirement model

```alloy
// --- Reference and capability mapping validation ---

// A capability is missing its spec file
pred capability_missing_spec [cap : Capability] {
  no cap.specFile
}

// A reference is semantically supported by its target
// (opaque to model: semantic analysis determines this)
pred reference_supported [r : Reference] {
  r.isArchived = True    // archived refs are always accepted
  // or semantic support exists (abstracted as non-archived + supported)
}

// A reference is unsupported (non-archived and semantically unsupported)
pred reference_unsupported [r : Reference] {
  r.isArchived = False
  not reference_supported[r]
}

// Event: emit missing-spec-file finding
pred emit_missing_spec_file [cap : Capability] {
  // Guard
  capability_missing_spec[cap]
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding {
    f.findingKind = MissingSpecFile
    no f.upstream
    no f.downstream
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

// Event: emit unsupported-reference finding
pred emit_unsupported_ref [r : Reference] {
  // Guard
  reference_unsupported[r]
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding {
    f.findingKind = UnsupportedRef
    f.upstream = r.refSource
    no f.downstream
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

// Safety: archived references are never flagged as unsupported
assert archived_refs_never_flagged {
  all r : Reference |
    r.isArchived = True implies
      no f : Finding | f.findingKind = UnsupportedRef and f.upstream = r.refSource
}

// Safety: missing spec files are always surfaced
assert missing_specs_surfaced {
  always (
    AnalysisState.phase = Complete implies
      all cap : Capability |
        capability_missing_spec[cap] implies
          some f : AnalysisState.graphFindings |
            f.findingKind = MissingSpecFile)
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
- Implementation: [coverage.ts:315 detectTaskEvidenceInconsistency()](/src/domain/spec-forward/coverage.ts#L315), [tasks-analysis.ts:29 analyzeTaskSourceConsistency()](/src/domain/tasks-analysis.ts#L29)
- Test: [tasks-analysis.test.ts:26 reports discrepancy when task text has no matching trace](/test/contract/tasks-analysis.test.ts#L26)
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
- Implementation: [coverage.ts:315 detectTaskEvidenceInconsistency()](/src/domain/spec-forward/coverage.ts#L315)
- Test: [tasks-analysis.test.ts:41 skips non-task-evidence claims](/test/contract/tasks-analysis.test.ts#L41)
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
  { c : Claim | some c.provenance and c.provenance.sourceFile in TaskFile }
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
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding {
    f.findingKind = TaskConflict
    f.upstream = tc.task_claim
    f.downstream = tc.spec_claim
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
  AnalysisState.phase = Analyzing
  // Effect
  some f : Finding {
    f.findingKind = TaskGap
    f.upstream = c
    no f.downstream
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
        task_claim_uncovered[c] implies
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
- Implementation: [claim-graph.ts:152 buildClaimGraph()](/src/domain/claim-graph.ts#L152)
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
// --- Claim graph determinism ---
// Determinism is modeled by asserting that the claim graph construction
// is a function: same inputs produce the same outputs (set equivalence).

// Two analysis runs share the same input if they have the same artifacts and sections
pred same_input [run1Claims, run2Claims : set Claim] {
  // Same provenance sources means same input
  run1Claims.provenance.sourceFile = run2Claims.provenance.sourceFile
  run1Claims.provenance.sourceSection = run2Claims.provenance.sourceSection
}

// Determinism: same input implies same claim set (set equivalence)
pred graph_deterministic [run1Claims, run2Claims : set Claim] {
  same_input[run1Claims, run2Claims] implies run1Claims = run2Claims
}

// Safety: construction is deterministic (set equivalence, not byte order)
assert claim_graph_is_deterministic_function {
  all run1Claims, run2Claims : set Claim |
    same_input[run1Claims, run2Claims] implies
      (run1Claims = run2Claims)
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
- Test: [extended.determinism.test.ts:235 coverage findings are identical across runs for same claim graph](/test/determinism/extended.determinism.test.ts#L235), [run.determinism.test.ts:18 produces stable summary output for same deterministic input](/test/determinism/run.determinism.test.ts#L18)
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
// --- Coverage analysis determinism ---
// Same claim graph as input produces the same set of findings.

pred same_claim_graph [run1Claims, run2Claims : set Claim] {
  run1Claims = run2Claims
}

// Determinism: same graph implies same findings (set equivalence)
assert coverage_analysis_deterministic {
  all run1Claims, run2Claims : set Claim,
      run1Findings, run2Findings : set Finding |
    same_claim_graph[run1Claims, run2Claims] implies
      run1Findings = run2Findings
}
```

### State machine, invariants, and verification commands

```alloy
// --- Transition system ---

pred stutter {
  AnalysisState.phase' = AnalysisState.phase
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.graphFindings' = AnalysisState.graphFindings
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  all f : Finding | f.emitted' = f.emitted
}

// Transition to analyzing phase (after normalization)
pred begin_analysis {
  AnalysisState.phase = Normalizing
  AnalysisState.phase' = Analyzing
  AnalysisState.graphClaims' = AnalysisState.graphClaims
  AnalysisState.graphFindings' = AnalysisState.graphFindings
  AnalysisState.analysisComplete' = False
  all f : Finding | f.emitted' = f.emitted
}

// Transition to complete phase
pred complete_analysis {
  AnalysisState.phase = Analyzing
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

// Start normalization from idle
pred start_normalization {
  AnalysisState.phase = Idle
  AnalysisState.phase' = Normalizing
  AnalysisState.graphFindings' = AnalysisState.graphFindings
  AnalysisState.analysisComplete' = AnalysisState.analysisComplete
  // Claims may be added during normalization
  AnalysisState.graphClaims in AnalysisState.graphClaims'
  all c : AnalysisState.graphClaims' - AnalysisState.graphClaims |
    some c.provenance
  all f : Finding | f.emitted' = f.emitted
}

fact transitions {
  init_state and always (
    // Phase transitions
    start_normalization
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
    // Failure mode
    or (some c : Claim | reject_provenance_free_claim[c])
    // Stutter
    or stutter
  )
}

// --- Global invariants ---

// Invariant: findings always have valid evidence (at least one side cited)
assert findings_have_evidence {
  always (all f : AnalysisState.graphFindings |
    some f.upstream or some f.downstream or f.findingKind = MissingSpecFile)
}

// Invariant: analysis phase progresses forward (no regression)
assert phase_monotonic {
  always (
    (AnalysisState.phase = Complete implies after AnalysisState.phase in (Complete + Complete))
    and (AnalysisState.phase = Idle implies after AnalysisState.phase in (Idle + Normalizing))
  )
}

// Liveness: analysis eventually completes (with strong fairness)
// Strong fairness: each phase transition eventually fires when enabled
pred analysis_fairness {
  // If start is enabled (in Idle), normalization eventually begins
  always (AnalysisState.phase = Idle implies eventually start_normalization)
  // If normalization is enabled (in Normalizing), it eventually fires
  always (AnalysisState.phase = Normalizing implies eventually normalize_claims)
  // If completion is enabled (in Analyzing), it eventually fires
  always (AnalysisState.phase = Analyzing implies eventually complete_analysis)
}

assert analysis_eventually_completes {
  analysis_fairness implies eventually AnalysisState.phase = Complete
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
    (some c : Claim | reject_provenance_free_claim[c])
      implies AnalysisState.phase = Analyzing
  )
}

// Safety: no findings exist in the graph before analysis begins
assert no_findings_before_analysis {
  always (AnalysisState.phase in (Idle + Normalizing) implies
    no AnalysisState.graphFindings)
}

// --- Coverage link well-formedness ---

// Fact: coverage links connect upstream artifacts to downstream artifacts
fact coverage_link_wellformedness {
  all link : CoverageLink {
    link.upstreamClaim in upstream_claims
    link.downstreamClaim in downstream_claims
  }
}

// Fact: no two findings report the same (kind, upstream, downstream) triple
// (structural uniqueness prevents duplicate reports)
fact finding_uniqueness {
  all disj f1, f2 : Finding |
    not (f1.findingKind = f2.findingKind and
         f1.upstream = f2.upstream and
         f1.downstream = f2.downstream)
}

// --- Completeness liveness ---

// Strong fairness for analysis events: if an event is infinitely often
// enabled, it eventually fires.
pred analysis_event_fairness {
  analysis_fairness
  // If a contradiction pair exists in the graph, it is eventually reported
  all cp : ContradictionPair |
    always (
      (cp.contra_upstream in AnalysisState.graphClaims and
       cp.contra_downstream in AnalysisState.graphClaims and
       AnalysisState.phase = Analyzing)
      implies eventually emit_contradiction[cp])
  // If an unsupported reference exists, it is eventually reported
  all r : Reference |
    always (
      (reference_unsupported[r] and AnalysisState.phase = Analyzing)
      implies eventually emit_unsupported_ref[r])
  // If a task contradiction exists, it is eventually reported
  all tc : TaskContradiction |
    always (
      (tc.task_claim in AnalysisState.graphClaims and
       tc.spec_claim in AnalysisState.graphClaims and
       AnalysisState.phase = Analyzing)
      implies eventually emit_task_conflict[tc])
  // If a partially covered claim exists, drift is eventually reported
  all c : Claim |
    always (
      (c in upstream_claims and c in AnalysisState.graphClaims and
       claim_partially_covered[c] and AnalysisState.phase = Analyzing)
      implies eventually emit_semantic_drift[c])
  // If an uncovered upstream claim exists, gap is eventually reported
  all c : Claim |
    always (
      (c in upstream_claims and c in AnalysisState.graphClaims and
       claim_uncovered[c] and AnalysisState.phase = Analyzing)
      implies eventually emit_coverage_gap[c])
}

// Liveness: with event fairness, all contradictions are eventually surfaced
assert all_contradictions_surfaced {
  analysis_event_fairness implies
    always (AnalysisState.phase = Complete implies
      all cp : ContradictionPair |
        (cp.contra_upstream in AnalysisState.graphClaims and
         cp.contra_downstream in AnalysisState.graphClaims) implies
          some f : AnalysisState.graphFindings |
            f.findingKind = Contradiction and
            f.upstream = cp.contra_upstream and
            f.downstream = cp.contra_downstream)
}

// Liveness: with event fairness, all unsupported refs are eventually surfaced
assert all_unsupported_refs_surfaced {
  analysis_event_fairness implies
    always (AnalysisState.phase = Complete implies
      all r : Reference |
        reference_unsupported[r] implies
          some f : AnalysisState.graphFindings |
            f.findingKind = UnsupportedRef and f.upstream = r.refSource)
}

// Liveness: with event fairness, all semantic drift is eventually surfaced
assert all_drift_surfaced {
  analysis_event_fairness implies
    always (AnalysisState.phase = Complete implies
      all c : upstream_claims & AnalysisState.graphClaims |
        claim_partially_covered[c] implies
          some f : AnalysisState.graphFindings |
            f.findingKind = SemanticDrift and f.upstream = c)
}

// --- Verification commands ---

run show_claim_graph {} for 3 Claim, 2 Finding, 2 Artifact, 2 Section, 2 Provenance, 2 Capability, 2 Reference, 1 CoverageLink, 1 ContradictionPair, 1 TaskContradiction, 5 steps

run scenario_coverage_gap_found {
  eventually (some f : AnalysisState.graphFindings | f.findingKind = CoverageGap)
} for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 0 ContradictionPair, 0 TaskContradiction, 8 steps

run scenario_contradiction_found {
  eventually (some f : AnalysisState.graphFindings | f.findingKind = Contradiction)
} for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 0 CoverageLink, 1 ContradictionPair, 0 TaskContradiction, 8 steps

run scenario_full_analysis {
  eventually AnalysisState.phase = Complete
} for 4 Claim, 4 Finding, 3 Artifact, 3 Section, 3 Provenance, 1 Capability, 2 Reference, 1 CoverageLink, 1 ContradictionPair, 1 TaskContradiction, 10 steps

check provenance_integrity for 3 Claim, 2 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 0 ContradictionPair, 0 TaskContradiction, 15 steps expect 0
check mandatory_produces_high_severity for 4 Claim, 4 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 1 ContradictionPair, 0 TaskContradiction, 10 steps expect 0
check informational_no_high_severity for 4 Claim, 4 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 1 ContradictionPair, 0 TaskContradiction, 10 steps expect 0
check contradiction_cites_both for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 0 Capability, 0 Reference, 0 CoverageLink, 1 ContradictionPair, 0 TaskContradiction, 10 steps expect 0
check drift_identifies_omission for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 0 Capability, 0 Reference, 1 CoverageLink, 0 ContradictionPair, 0 TaskContradiction, 10 steps expect 0
check archived_refs_never_flagged for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 2 Reference, 0 CoverageLink, 0 ContradictionPair, 0 TaskContradiction, 10 steps expect 0
check task_conflict_cites_both for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 0 Capability, 0 Reference, 0 CoverageLink, 0 ContradictionPair, 1 TaskContradiction, 10 steps expect 0
check findings_have_evidence for 4 Claim, 4 Finding, 3 Artifact, 3 Section, 3 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 1 ContradictionPair, 1 TaskContradiction, 15 steps expect 0
check complete_is_stable for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 0 ContradictionPair, 0 TaskContradiction, 15 steps expect 0
check analysis_eventually_completes for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 1 ContradictionPair, 1 TaskContradiction, 20 steps expect 0

// --- Extended property checks ---

check claims_monotonic for 3 Claim, 2 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 0 ContradictionPair, 0 TaskContradiction, 15 steps expect 0
check findings_monotonic for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 1 ContradictionPair, 0 TaskContradiction, 15 steps expect 0
check emission_irreversible for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 0 ContradictionPair, 0 TaskContradiction, 15 steps expect 0
check analysis_events_respect_phase for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 1 ContradictionPair, 1 TaskContradiction, 10 steps expect 0
check no_findings_before_analysis for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 1 Reference, 1 CoverageLink, 0 ContradictionPair, 0 TaskContradiction, 15 steps expect 0
check all_contradictions_surfaced for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 0 Capability, 0 Reference, 0 CoverageLink, 1 ContradictionPair, 0 TaskContradiction, 20 steps expect 0
check all_unsupported_refs_surfaced for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 1 Capability, 2 Reference, 0 CoverageLink, 0 ContradictionPair, 0 TaskContradiction, 20 steps expect 0
check all_drift_surfaced for 3 Claim, 3 Finding, 2 Artifact, 2 Section, 2 Provenance, 0 Capability, 0 Reference, 1 CoverageLink, 0 ContradictionPair, 0 TaskContradiction, 20 steps expect 0
```
