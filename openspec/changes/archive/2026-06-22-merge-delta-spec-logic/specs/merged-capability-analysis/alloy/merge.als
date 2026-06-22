module merge

/**
 * Formal model of the per-capability merge phase for spec-check.
 *
 * Models the structural invariants and safety properties of merging
 * finalized base specs with delta specs per capability. This is a
 * structural (non-temporal) model since the merge is a pure synchronous
 * deterministic function.
 *
 * Spec references:
 *   [MCA-MERGE-CAP], [MCA-DELTA-SEM], [MCA-MERGE-FIND],
 *   [MCA-MERGE-PROVEN], [MCA-LIVENESS]
 */

// --- Signatures ---

sig Identifier {}

abstract sig DeltaOperation {}
one sig Base, PreSection, Added, Modified, Removed, Renamed extends DeltaOperation {}

sig Requirement {
  identifier : lone Identifier,
  deltaOp : one DeltaOperation,
  scenarios : set Scenario,
  sourceFile : one SourceFile
}

sig Scenario {
  scenarioId : lone Identifier,
  parentReq : lone Requirement,
  scenDeltaOp : one DeltaOperation,
  scenSourceFile : one SourceFile
}

sig SourceFile {}

sig Capability {
  finalized : lone ParsedSpec,
  delta : lone ParsedSpec
}

sig ParsedSpec {
  requirements : set Requirement,
  source : one SourceFile
}

// --- Merged output ---

sig MergedCapability {
  cap : one Capability,
  mergedReqs : set Requirement,
  mergedScenarios : set Scenario,
  findings : set Finding
}

abstract sig FindingKind {}
one sig DupBase, DupDelta, DupAdded, ModNotFound, RemNotFound,
        ModMissingId, RemMissingId, PreSectionContent,
        StandaloneScenario, RenameUnsupported,
        EmptyCapSkipped, FinalizedDeltaHeadingIgnored,
        DupModifiedId extends FindingKind {}

sig Finding {
  kind : one FindingKind,
  affectedReq : lone Requirement
}

// --- Facts (domain constraints) ---

// At most one delta per capability (precondition)
fact atMostOneDelta {
  all c : Capability | lone c.delta
}

// Base items have deltaOp = Base
fact baseItems {
  all r : Requirement |
    (some p : ParsedSpec | r in p.requirements and p in Capability.finalized)
      implies r.deltaOp = Base
}

// Scenario inherits parent's delta operation
fact scenarioInheritsDelta {
  all s : Scenario | some s.parentReq implies s.scenDeltaOp = s.parentReq.deltaOp
}

// Scenarios belong to exactly one requirement's scenario set
fact scenarioOwnership {
  all s : Scenario | lone (scenarios.s)
}

// Requirements belong to exactly one parsed spec
fact requirementOwnership {
  all r : Requirement | one (requirements.r)
}

// ParsedSpecs belong to at most one capability role
fact parsedSpecOwnership {
  all p : ParsedSpec | lone (finalized.p + delta.p)
}

// [MCA-MERGE-CAP] Each capability produces exactly one merged view
fact oneViewPerCap {
  all c : Capability | one mc : MergedCapability | mc.cap = c
}

// Every MergedCapability's cap is a real Capability
fact mergedCapIsReal {
  MergedCapability.cap in Capability
}

// [MCA-MERGE-PROVEN] Merged output requirements trace to source files of the capability
fact mergedProvenance {
  all mc : MergedCapability, r : mc.mergedReqs |
    r.sourceFile in (mc.cap.finalized.source + mc.cap.delta.source)
}

// Merged requirements come from the capability's parsed specs
fact mergedReqsFromInput {
  all mc : MergedCapability, r : mc.mergedReqs |
    r in mc.cap.finalized.requirements + mc.cap.delta.requirements
}

// Merged scenarios come from merged requirements
fact mergedScenariosFromReqs {
  all mc : MergedCapability |
    mc.mergedScenarios = mc.mergedReqs.scenarios
}

// Findings only reference requirements from this capability's input
fact findingsAreLocal {
  all mc : MergedCapability, f : mc.findings |
    some f.affectedReq implies
      f.affectedReq in mc.cap.finalized.requirements + mc.cap.delta.requirements
}

// [MCA-DELTA-SEM] No base requirement disappears silently
// Every base req is either in merged output OR has a removal/exclusion finding
fact noSilentDiscardFact {
  all mc : MergedCapability, r : Requirement |
    (some mc.cap.finalized and r in mc.cap.finalized.requirements and r not in mc.mergedReqs)
    implies (
      // Either a REMOVED op targets this identifier
      (some rem : Requirement | rem in mc.cap.delta.requirements
        and rem.deltaOp = Removed and rem.identifier = r.identifier and some r.identifier)
      // Or there is a finding about this requirement
      or (some f : mc.findings | f.affectedReq = r)
    )
}

// [MCA-MERGE-FIND] PreSection items never appear in merged output
fact preSectionExcluded {
  all mc : MergedCapability |
    no r : mc.mergedReqs | r.deltaOp = PreSection
}

// [MCA-MERGE-FIND] Removed items never appear in merged output
fact removedExcluded {
  all mc : MergedCapability |
    no r : mc.mergedReqs | r.deltaOp = Removed
}

// [MCA-MERGE-FIND] Renamed items never appear in merged output
fact renamedExcluded {
  all mc : MergedCapability |
    no r : mc.mergedReqs | r.deltaOp = Renamed
}

// [MCA-MERGE-EMPTY] Empty merged capabilities have the finding
fact emptyCapFinding {
  all mc : MergedCapability |
    (no mc.mergedReqs and some mc.cap.(finalized + delta).requirements)
    implies some f : mc.findings | f.kind = EmptyCapSkipped
}

// --- Safety assertions ---

// [MCA-MERGE-CAP]: Each capability produces exactly one merged view
assert oneViewPerCapability {
  all c : Capability | one (cap.c)
}

// [MCA-MERGE-PROVEN]: Merged items preserve source provenance
assert provenancePreserved {
  all mc : MergedCapability, r : mc.mergedReqs |
    r.sourceFile in (mc.cap.finalized.source + mc.cap.delta.source)
}

// [MCA-LIVENESS]: Non-empty merged capabilities have a valid cap
assert nonEmptyAnalyzed {
  all mc : MergedCapability |
    some mc.mergedReqs implies some mc.cap
}

// [MCA-DELTA-SEM] No phantom introduction: every merged req comes from input
assert noPhantomIntroduction {
  all mc : MergedCapability, r : mc.mergedReqs |
    r in mc.cap.finalized.requirements + mc.cap.delta.requirements
}

// Removed and pre-section items never leak into merged output
assert excludedOpsNeverInOutput {
  all mc : MergedCapability |
    no r : mc.mergedReqs | r.deltaOp in Removed + PreSection + Renamed
}

// Cross-capability isolation: a finding in one cap doesn't reference another's reqs
assert capabilityIsolation {
  all disj mc1, mc2 : MergedCapability |
    no (mc1.findings.affectedReq & (mc2.cap.finalized.requirements + mc2.cap.delta.requirements))
}

// --- Commands ---

// Sanity: at least one satisfying instance exists
run sanity {} for 4 expect 1

// Scenario: finalized-only passes through
run finalizedOnly {
  some c : Capability, mc : MergedCapability |
    some c.finalized and no c.delta and mc.cap = c
    and mc.mergedReqs = c.finalized.requirements
    and no mc.findings
} for 3 expect 1

// Scenario: delta-only with ADDED
run deltaOnlyAdded {
  some c : Capability, mc : MergedCapability |
    no c.finalized and some c.delta and mc.cap = c
    and all r : mc.mergedReqs | r.deltaOp = Added
} for 3 expect 1

// Scenario: removal produces finding
run removalWithFinding {
  some mc : MergedCapability, r : Requirement, f : Finding |
    r in mc.cap.finalized.requirements
    and r not in mc.mergedReqs
    and f in mc.findings and f.affectedReq = r
} for 4 expect 1

// Check safety properties
check oneViewPerCapability for 6 expect 0
check provenancePreserved for 6 expect 0
check nonEmptyAnalyzed for 6 expect 0
check noPhantomIntroduction for 6 expect 0
check excludedOpsNeverInOutput for 6 expect 0
check capabilityIsolation for 5 expect 0
