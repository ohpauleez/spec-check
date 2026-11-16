---
title: SourceTraceability
---

## Purpose

Define the source traceability and code-backwards comparison behavior for the spec-check tool: relating requirements to source evidence, generating EARS-preferring code-derived specifications from source, formalizing code-derived specifications through the same sampling and clustering pipeline, using solver-backed cross-side implication as the primary strength classifier, and providing blind LLM comparison as the explanatory rationale layer.

All Alloy fences below form one Alloy 6 module in document order. Source bytes, lexical correctness, OS effects, and concrete serialization are explicit implementation-test boundaries; the model checks relational preservation and analyzer control. Safety assertions permit stuttering. Liveness is conditional on the stated action scheduling and resource premises.

```alloy
module SourceTraceability
open util/boolean
open util/ordering[Item] as sourceOrder

// --- Domain vocabulary: independent source sides and source-local identities ---
abstract sig Side {}
one sig OriginalSide, GeneratedSide extends Side {}
sig Capability {}
sig Identifier {}
sig Bytes {}
abstract sig EvidenceKind {}
one sig Implementation, VerifiedContract, TracedTest, Documentation extends EvidenceKind {}
sig SourceFile {
  inScope : one Bool, readable : one Bool, kind : one EvidenceKind,
  selectedWithinContentBudget : one Bool,
  identifiers : set Identifier, var currentBytes : one Bytes
}
abstract sig Modal {}
one sig Mandatory, Advisory, Permission extends Modal {}
abstract sig FormalStatus {}
one sig Single, Stable, Ambiguous, Failed, Excluded extends FormalStatus {}
abstract sig Item { cap : one Capability, id : lone Identifier, modal : one Modal, plannedStatus : one FormalStatus }
sig Original extends Item {}
sig Generated extends Item {}
sig TraceLink { claim : one Original, file : one SourceFile, behaviorVerified : one Bool }
fact trace_links_are_observations {
  all l : TraceLink | l.file.inScope = True and some l.claim.id and l.claim.id in l.file.identifiers
}
abstract sig TraceStrength {}
one sig Supported, WeaklySupported, Missing extends TraceStrength {}
sig Registry { side : one Side, cap : one Capability, hash : one Bytes }
fact registries_independent {
  all disj a, b : Registry | a.side != b.side or a.cap != b.cap
  all c : Capability, s : Side | one r : Registry | r.cap = c and r.side = s
}
abstract sig Relation {}
one sig Same, Stronger, Weaker, Different, Uncertain, Unmapped, Incompatible,
  PermissionEquivalent, PermissionBroader, PermissionNarrower, PermissionDifferent extends Relation {}
abstract sig MappingScope {}
one sig CompleteScope, PartialScope extends MappingScope {}
sig Valuation {}
abstract sig SolverStatus {}
one sig Sat, Unsat, Unknown, Timeout, SolverError extends SolverStatus {}
sig Comparison {
  cap : one Capability, modal : one Modal,
  isAggregate : one Bool,
  originalMeaning : set Valuation, generatedMeaning : set Valuation,
  originalBackground : set Valuation, generatedBackground : set Valuation,
  mapped : one Bool, compatible : one Bool, fullScope : one Bool,
  originalPresent : one Bool, generatedPresent : one Bool,
  originalUnstable : one Bool, generatedUnstable : one Bool,
  precheck : one SolverStatus, forward : one SolverStatus, reverse : one SolverStatus
}
sig Pair { original : one Original, generated : one Generated, comparison : one Comparison }
fact pair_shape {
  all p : Pair | p.original.cap = p.generated.cap and p.comparison.cap = p.original.cap and
    p.original.modal = p.generated.modal and p.comparison.modal = p.original.modal and p.comparison.isAggregate = False
  all p : Pair | one c : Comparison | c.isAggregate = True and c.cap = p.original.cap and c.modal = p.original.modal
  all disj p, q : Pair | p.original != q.original or p.generated != q.generated
}
fact comparison_presence {
  all c : Comparison | {
    (c.originalPresent = True iff some o : Original | o.cap = c.cap and o.modal = c.modal and o.plannedStatus not in Failed + Excluded)
    (c.generatedPresent = True iff generation_blind and Config.sourceDirectoryReadable = True and
      (some f : SourceFile | f.inScope = True and f.readable = True and f.selectedWithinContentBudget = True) and
      (some g : Generated | g.cap = c.cap and g.modal = c.modal and g.plannedStatus not in Failed + Excluded))
    (some o : Original | o.cap = c.cap and (o.modal = c.modal or (c.modal = Permission and o.modal = Mandatory)) and o.plannedStatus = Ambiguous)
      implies c.originalUnstable = True
    (some g : Generated | g.cap = c.cap and (g.modal = c.modal or (c.modal = Permission and g.modal = Mandatory)) and g.plannedStatus = Ambiguous)
      implies c.generatedUnstable = True
    (some i : Item | i.cap = c.cap and i.modal = c.modal and i.plannedStatus in Failed + Excluded)
      implies c.fullScope = False
  }
}
sig GenerationPlan { cap : one Capability, sufficient : one Bool, claims : set Generated }
fact generation_plans {
  all c : Capability | one p : GenerationPlan | p.cap = c
  all p : GenerationPlan | p.claims = { g : Generated | g.cap = p.cap }
  all p : GenerationPlan | p.sufficient = False implies no p.claims
}
one sig Config { sourceDirectoryReadable : one Bool, knownNames : set Capability, pairBudget : one Int }
one sig GenerationBoundary { requestedOriginalText : set Original, requestedRegistries : set Registry }
pred generation_blind { no GenerationBoundary.requestedOriginalText + GenerationBoundary.requestedRegistries }
fact budget_shape { Config.pairBudget >= 0 }
abstract sig Phase {}
one sig ValidateSource, Trace, Generate, Formalize, Aggregate, Match, Explain, Complete, Aborted extends Phase {}
one sig Run {
  var phase : one Phase,
  var scanned : set SourceFile,
  var snapshot : SourceFile -> lone Bytes,
  var attachments : SourceFile -> lone Bytes,
  var generated : set Generated,
  var traceResults : Original -> lone TraceStrength,
  var frozen : set Registry,
  var formalized : set Generated,
  var aggregates : set Comparison,
  var evaluatedPairs : set Pair,
  var matches : set Pair,
  var skippedCaps : set Capability,
  var explanations : set Capability,
  var writes : set SourceFile
}
// Findings carry the actual affected source object/capability, not just a kind.
fun trace_gaps : set Original { { c : Original | Run.traceResults[c] = Missing } }
fun unknown_references : SourceFile -> Identifier {
  { f : Run.scanned, i : f.identifiers | i not in Original.id }
}
fun source_limitations : set Capability {
  Run.phase in Formalize + Aggregate + Match + Explain + Complete =>
    (Config.knownNames + Original.cap) - Run.generated.cap else none
}
fun selected_source_files : set SourceFile { { f : Run.scanned | f.selectedWithinContentBudget = True } }
fun formal_errors : set Generated { { g : Run.formalized | g.plannedStatus = Failed } }
fun qualified_scope[c : Comparison] : one MappingScope { c.fullScope = True => CompleteScope else PartialScope }
pred comparison_missing[c : Comparison] { c.originalPresent = False or c.generatedPresent = False or c.mapped = False }
pred comparison_incompatible[c : Comparison] { c.compatible = False or c.originalBackground != c.generatedBackground }
pred comparison_uncertain[c : Comparison] {
  c.precheck != Sat or no (c.originalMeaning & c.originalBackground) or no (c.generatedMeaning & c.generatedBackground) or
    c.forward not in (Sat + Unsat) or c.reverse not in (Sat + Unsat)
}
fun original_values[c : Comparison] : set Valuation { c.originalMeaning & c.originalBackground }
fun generated_values[c : Comparison] : set Valuation { c.generatedMeaning & c.generatedBackground }
fact implication_observations {
  all c : Comparison | {
    c.forward = Unsat implies no original_values[c] - generated_values[c]
    c.forward = Sat implies some original_values[c] - generated_values[c]
    c.reverse = Unsat implies no generated_values[c] - original_values[c]
    c.reverse = Sat implies some generated_values[c] - original_values[c]
  }
}
fun relation[c : Comparison] : one Relation {
  comparison_missing[c] => Unmapped else
  (comparison_incompatible[c] => Incompatible else
  (comparison_uncertain[c] => Uncertain else
  (c.modal = Permission =>
    (original_values[c] = generated_values[c] => PermissionEquivalent else
      (original_values[c] in generated_values[c] => PermissionBroader else
      (generated_values[c] in original_values[c] => PermissionNarrower else PermissionDifferent))) else
    (original_values[c] = generated_values[c] => Same else
      (generated_values[c] in original_values[c] => Stronger else
      (original_values[c] in generated_values[c] => Weaker else Different))))))
}
pred credit[c : Comparison] {
  qualified_scope[c] = CompleteScope
  c.originalUnstable = False and c.generatedUnstable = False
  relation[c] not in Unmapped + Incompatible
}
fun score[c : Comparison] : one Int {
  not credit[c] => -1 else
  (relation[c] in Same + PermissionEquivalent => 4 else
  (relation[c] = Stronger => 3 else (relation[c] = Uncertain => 2 else
  (relation[c] = Weaker => 1 else 0))))
}
pred preferred[p, q : Pair] {
  score[p.comparison] > score[q.comparison] or
  (score[p.comparison] = score[q.comparison] and
    (p.original in sourceOrder/prevs[q.original] or
      (p.original = q.original and p.generated in sourceOrder/prevs[q.generated])))
}
```

## Requirements

### Requirement: Trace Requirements To Source-Backed Evidence [STC-TRACE-SOURCE]
WHEN a readable source directory is provided via `--src`, THE spec-check tool SHALL trace requirement and scenario claims to relevant source artifacts and SHALL classify each claim as `supported` (located evidence demonstrates the intended behavior), `weakly supported` (located evidence references the claim but does not demonstrate behavioral correctness), or `missing` (no relevant source evidence found).

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Assumptions and Dependencies`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Capabilities`

#### Scenario: Report Supported Trace [STC-TRACE-SUPPORTED]
WHEN source code, traced tests, or verified contracts support a requirement or scenario claim, THE spec-check tool SHALL report the linked source evidence and the supported claim identifier.

**Postcondition:** The output identifies which source artifacts support each traced requirement or scenario.

##### Evidence
- Implementation: [trace.ts:118 traceClaimsToSource](/src/domain/code-backwards/trace.ts#L118), [trace.ts:344 classifyEvidenceLevel](/src/domain/code-backwards/trace.ts#L344)
- Test: [traceability.test.ts:12 links canonical identifiers and reports unknown identifier](/test/contract/traceability.test.ts#L12)

#### Scenario: Report Weakly Supported Trace [STC-TRACE-WEAK]
IF a requirement or scenario identifier appears in source but the located evidence does not demonstrate the behavioral correctness of the claim (e.g., identifier in a comment without corresponding implementation), THEN THE spec-check tool SHALL classify the trace as `weakly supported` and SHALL note that the evidence establishes a link but not behavioral proof.

**Postcondition:** Weak traceability links are distinguished from strong behavioral evidence.

##### Evidence
- Implementation: [trace.ts:200 traceClaimsToSource](/src/domain/code-backwards/trace.ts#L200) (weakly_supported classification)

#### Scenario: Report Missing Trace [STC-TRACE-MISSING]
IF a requirement or scenario cannot be traced to any source-backed evidence, THEN THE spec-check tool SHALL emit a traceability gap finding for that claim.

**Postcondition:** Unimplemented or unverified claims remain visible to reviewers.

##### Evidence
- Implementation: [trace.ts:179 traceClaimsToSource](/src/domain/code-backwards/trace.ts#L179) (missing trace gap finding)

#### Requirement model

```alloy
fun observed_strength[c : Original] : one TraceStrength {
  no { l : TraceLink | l.claim = c and l.file in Run.scanned } => Missing else
  ((some l : TraceLink | l.claim = c and l.file in Run.scanned and l.file.kind != Documentation and l.behaviorVerified = True) => Supported else WeaklySupported)
}
pred trace {
  Run.phase = Trace
  Run.traceResults' = { c : Original, s : TraceStrength | s = observed_strength[c] }
  Run.phase' = Generate
  Run.scanned' = Run.scanned
  Run.snapshot' = Run.snapshot
  Run.attachments' = Run.attachments
  Run.writes' = Run.writes
  keep_generation
  keep_comparison
}
// Safety: each original claim receives exactly its own evidence classification.
assert trace_total { always (Run.phase in Generate + Formalize + Aggregate + Match + Explain + Complete implies
  all c : Original | one Run.traceResults[c] and Run.traceResults[c] = observed_strength[c]) }
```

### Requirement: Canonical Identifier Traceability [STC-TRACE-IDENTIFIERS]
WHEN tracing requirements to source evidence, THE spec-check tool SHALL search for canonical bracketed identifiers (e.g., `[CAT-DISCOVER-INPUTS]`) in source files, test files, and verified contracts to establish traceability links.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Identifier Found In Test File [STC-ID-TEST]
WHEN a canonical requirement or scenario identifier appears in a test file within the declared source scope, THE spec-check tool SHALL record the test file as a traceability link for that claim. This establishes that the claim was considered during testing but does not alone constitute proof of behavioral correctness.

**Postcondition:** Test-to-requirement traceability is established through canonical identifiers; the evidence hierarchy determines how strongly this link supports the claim.

##### Evidence
- Implementation: [trace.ts:259 scanFileForIdentifiers](/src/domain/code-backwards/trace.ts#L259), [trace.ts:344 classifyEvidenceLevel](/src/domain/code-backwards/trace.ts#L344)
- Test: [traceability.test.ts:12 links canonical identifiers and reports unknown identifier](/test/contract/traceability.test.ts#L12), [traceability.test.ts:48 ignores regex character-class fragments like [A-Z] and [A-Z0-9]](/test/contract/traceability.test.ts#L48)

#### Scenario: Identifier Found In Source Comment [STC-ID-SOURCE]
WHEN a canonical requirement or scenario identifier appears in a source code comment within the declared source scope, THE spec-check tool SHALL record the source file as a traceability link for that claim. This establishes that the claim was considered during implementation but does not alone constitute proof of behavioral correctness.

**Postcondition:** Implementation-to-requirement traceability is established through canonical identifiers; the evidence hierarchy determines how strongly this link supports the claim.

##### Evidence
- Implementation: [trace.ts:173 traceClaimsToSource](/src/domain/code-backwards/trace.ts#L173) (claim-to-file matching loop)
- Test: [traceability.test.ts:12 links canonical identifiers and reports unknown identifier](/test/contract/traceability.test.ts#L12)

#### Scenario: Unknown Identifier In Source [STC-ID-UNKNOWN]
IF a bracketed identifier is found in source that does not match any known requirement or scenario identifier, THEN THE spec-check tool SHALL emit a finding noting the unknown traceability reference.

**Postcondition:** Orphaned source references are surfaced rather than silently ignored.

##### Evidence
- Implementation: [trace.ts:226 traceClaimsToSource](/src/domain/code-backwards/trace.ts#L226) (unknown identifier detection loop)
- Test: [traceability.test.ts:12 links canonical identifiers and reports unknown identifier](/test/contract/traceability.test.ts#L12)

#### Requirement model

```alloy
// Canonical-token lexing is external. Known IDs cannot create unknown findings.
// Safety: unknown ids exact.
assert unknown_ids_exact { always (all f : SourceFile, i : Identifier |
  f -> i in unknown_references iff f in Run.scanned and i in f.identifiers and i not in Original.id) }
```

### Requirement: Source Scope Confinement [STC-SCOPE-CONFINE]
WHEN the spec-check tool scans source evidence, THE spec-check tool SHALL confine scanning to the declared source directory provided via `--src` and SHALL NOT traverse outside that directory.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Source Within Scope Scanned [STC-SCOPE-IN]
WHEN a source file exists within the declared source directory, THE spec-check tool SHALL include it in the traceability scan.

**Postcondition:** All in-scope source files contribute to traceability analysis.

##### Evidence
- Implementation: [trace.ts:294 collectFiles](/src/domain/code-backwards/trace.ts#L294), [trace.ts:118 traceClaimsToSource](/src/domain/code-backwards/trace.ts#L118)
- Test: [traceability.test.ts:12 links canonical identifiers and reports unknown identifier](/test/contract/traceability.test.ts#L12)

#### Scenario: Source Outside Scope Excluded [STC-SCOPE-OUT]
IF a symlink or reference points to a file outside the declared source directory, THEN THE spec-check tool SHALL exclude that file from traceability scanning.

**Postcondition:** Source-backed evidence remains bounded to declared scope.

##### Evidence
- Implementation: [trace.ts:294 collectFiles](/src/domain/code-backwards/trace.ts#L294) (resolves path and checks `startsWith(root)`)

#### Scenario: Unreadable Source Directory Rejected [STC-SCOPE-FAIL]
IF the `--src` path does not exist or is not readable, THEN THE spec-check tool SHALL exit with code `2` and a diagnostic message before source-backed analysis begins.

**Postcondition:** No source traceability results are produced from an invalid source path.

##### Evidence
- Implementation: [trace.ts:118 traceClaimsToSource](/src/domain/code-backwards/trace.ts#L118)

#### Requirement model

```alloy
pred validate_source {
  Run.phase = ValidateSource
  Run.phase' = (Config.sourceDirectoryReadable = False => Aborted else Trace)
  Run.scanned' = (Config.sourceDirectoryReadable = True => { f : SourceFile | f.inScope = True and f.readable = True } else none)
  Run.snapshot' = { f : Run.scanned', b : Bytes | f.selectedWithinContentBudget = True and b = f.currentBytes }
  Run.attachments' = Run.attachments
  Run.traceResults' = Run.traceResults
  Run.writes' = Run.writes
  keep_generation
  keep_comparison
}
// Safety: scanning includes all readable eligible files and excludes outside files.
assert scope_exact { always (Run.phase != ValidateSource and Run.phase != Aborted implies
  Run.scanned = { f : SourceFile | f.inScope = True and f.readable = True }) }
```

### Requirement: Source File Read-Only Treatment [STC-SOURCE-READONLY]
WHEN the spec-check tool performs source traceability or code-backwards analysis, THE spec-check tool SHALL treat all source files as read-only and SHALL NOT modify, create, or delete any file in the source directory.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`

#### Scenario: Source Files Unchanged After Analysis [STC-READONLY-VERIFY]
WHEN source-backed analysis completes, THE spec-check tool SHALL have made zero modifications to any file in the source directory.

**Postcondition:** The source tree is identical before and after analysis.

##### Evidence
- Implementation: [trace.ts:118 traceClaimsToSource](/src/domain/code-backwards/trace.ts#L118) (read-only filesystem operations only)
- Test (integration): [global.invariant.test.ts:31 INV-1: input files are never mutated by any analysis phase](/test/invariant/global.invariant.test.ts#L31)

#### Requirement model

```alloy
// Environment edits are separate from writes performed by this analyzer.
// Safety: source readonly.
assert source_readonly { always no Run.writes }
```

### Requirement: Attach Large Source Context As Files [STC-SOURCE-FILE-CTX]
WHEN source-backed analysis sends large source context to an external LLM, THE spec-check tool SHALL provide the bounded instruction prompt separately from the selected source files and SHALL attach the selected source files as reference inputs rather than embedding their full contents inline.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Deliver large analysis context through file attachments`

#### Scenario: Attach In-Budget Source Files [STC-SOURCE-FILE-BUDGET]
WHEN source-backed generation selects source files within the configured content budget, THE spec-check tool SHALL attach exactly those in-budget files to the LLM invocation.

**Postcondition:** Large source context remains available to generation without relying on oversized inline arguments.

##### Evidence
- Implementation: [derive.ts:96 deriveSpecsFromSource](/src/domain/code-backwards/derive.ts#L96), [derive.ts:129 callOpencode files attachment](/src/domain/code-backwards/derive.ts#L129)
- Test: [derive.test.ts:57 produces EARS-preferring markdown from LLM informalization response](/test/contract/derive.test.ts#L57)

#### Scenario: Keep Blind Boundary In File Transport [STC-SOURCE-FILE-BLIND]
WHEN the spec-check tool attaches source files for code-derived generation, THE spec-check tool SHALL NOT attach original proposal, design, or requirement documents to that invocation.

**Postcondition:** File-based transport preserves the same blind boundary as inline transport.

##### Evidence
- Implementation: [derive.ts:330 buildInformalizationPrompt](/src/domain/code-backwards/derive.ts#L330)
- Test: [derive.test.ts:109 generated output contains source-derived text only (no original requirements)](/test/contract/derive.test.ts#L109)

#### Requirement model

```alloy
// Event: attach private copies of captured source bytes, never live original paths.
pred generate {
  Run.phase = Generate
  Run.attachments' = Run.snapshot
  Run.generated' = (generation_blind and some selected_source_files => GenerationPlan.claims else none)
  Run.phase' = Formalize
  Run.scanned' = Run.scanned
  Run.snapshot' = Run.snapshot
  Run.traceResults' = Run.traceResults
  Run.writes' = Run.writes
  Run.frozen' = Run.frozen
  Run.formalized' = Run.formalized
  keep_comparison
}
// Safety: selected context preserves exactly the captured bytes and source scope.
assert attachments_are_snapshots { always (Run.phase in Formalize + Aggregate + Match + Explain + Complete implies
  Run.attachments = Run.snapshot and Run.attachments.Bytes = selected_source_files) }
```

### Requirement: Generate Code-Derived Specifications From Source [STC-GEN-SPECS]
WHEN source-backed analysis is enabled, THE spec-check tool SHALL generate EARS-preferring behavioral specification files per declared capability using only source-scoped evidence, blind to original requirement text, SHALL persist the generated specifications as Markdown files in a `gen_specs/` directory under the configured output directory, and SHALL use the run-configured universal timeout for every external LLM generation invocation.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Assumptions and Dependencies`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Deliver large analysis context through file attachments`

#### Scenario: Generate Capability-Aligned Derived Specs [STC-GEN-CAPABILITY]
WHEN the source tree contains sufficient evidence relevant to a declared capability, THE spec-check tool SHALL generate an EARS-preferring behavioral specification for that capability using only the provided source scope, implementation code, verified contracts, and traced tests as evidence.

**Postcondition:** A generated spec file exists in `gen_specs/` for each capability with sufficient source evidence.

##### Evidence
- Implementation: [derive.ts:96 deriveSpecsFromSource](/src/domain/code-backwards/derive.ts#L96)
- Test: [derive.test.ts:57 produces EARS-preferring markdown from LLM informalization response](/test/contract/derive.test.ts#L57), [derive.test.ts:134 persists gen_specs/{capability}.md via writeOutputAtomic](/test/contract/derive.test.ts#L134), [derive.test.ts:160 returns multiple capabilities from LLM response](/test/contract/derive.test.ts#L160)

#### Scenario: Capability Name Suggestions From Catalog [STC-GEN-SUGGEST]
WHEN generating code-derived specifications, THE spec-check tool SHALL provide the LLM with the list of known capability names derived from active catalog paths as soft suggestions for capability naming. THE spec-check tool SHALL NOT include requirement text, identifier lists, or spec content in the suggestions.

**Postcondition:** The LLM receives structural metadata (capability names only) that improves naming alignment without violating the blind boundary.

##### Evidence
- Implementation: [derive.ts:330 buildInformalizationPrompt](/src/domain/code-backwards/derive.ts#L330)
- Test: [derive.test.ts:246 includes suggested capability names in LLM prompt when provided](/test/contract/derive.test.ts#L246)

#### Scenario: EARS Preference With Structured Fallback [STC-GEN-EARS]
WHEN code semantics support EARS decomposition, THE spec-check tool SHALL generate requirements using EARS patterns. IF code semantics resist EARS decomposition for a code-derived requirement, THEN THE spec-check tool SHALL use structured behavioral prose and SHALL note the deviation.

**Postcondition:** Generated specs prefer EARS format but do not force unnatural EARS encoding at the expense of accuracy.

##### Evidence
- Implementation: [derive.ts:96 deriveSpecsFromSource](/src/domain/code-backwards/derive.ts#L96), [derive.ts:551 formatCapabilityMarkdown](/src/domain/code-backwards/derive.ts#L551)
- Test: [derive.test.ts:57 produces EARS-preferring markdown from LLM informalization response](/test/contract/derive.test.ts#L57)

#### Scenario: Insufficient Source Evidence [STC-GEN-INSUFFICIENT]
IF a declared capability lacks sufficient source-scoped evidence for meaningful specification generation, THEN THE spec-check tool SHALL emit a limitation finding for that capability and SHALL NOT generate a spec file with unsupported claims.

**Postcondition:** Missing code-derived specs are surfaced as limitations rather than silently skipped.

##### Evidence
- Implementation: [derive.ts:96 deriveSpecsFromSource](/src/domain/code-backwards/derive.ts#L96)
- Test: [derive.test.ts:88 returns no specs and warning finding when LLM call fails](/test/contract/derive.test.ts#L88)

#### Scenario: Blind Generation Boundary [STC-GEN-BLIND]
WHEN generating code-derived specifications, THE spec-check tool SHALL NOT provide original requirement text, proposal text, or design text to the generation process.

**Postcondition:** Code-derived specs reflect what the code actually guarantees rather than restating original intent.

##### Evidence
- Implementation: [derive.ts:330 buildInformalizationPrompt](/src/domain/code-backwards/derive.ts#L330)
- Test: [derive.test.ts:109 generated output contains source-derived text only (no original requirements)](/test/contract/derive.test.ts#L109)
- Test (property): [code-derived.property.test.ts:12 formalization prompts never include original proposal/design text verbatim](/test/property/code-derived.property.test.ts#L12)
- Test (integration): [global.invariant.test.ts:161 INV-14: code-derived spec generation never receives original requirement text](/test/invariant/global.invariant.test.ts#L161)

#### Scenario: Restrict Unsupported Evidence [STC-GEN-SCOPE]
IF a candidate code-derived guarantee depends on evidence outside the provided source scope, THEN THE spec-check tool SHALL exclude that unsupported evidence and SHALL surface the resulting limitation.

**Postcondition:** Code-backed guarantees remain bounded to declared source scope and visible evidence.

##### Evidence
- Implementation: [derive.ts:96 deriveSpecsFromSource](/src/domain/code-backwards/derive.ts#L96)
- Test: [derive.test.ts:196 returns empty specs when source directory has no scannable files](/test/contract/derive.test.ts#L196)

#### Scenario: Universal LLM Timeout For Code-Derived Generation [STC-GEN-TIMEOUT]
WHEN the spec-check tool invokes an external LLM to generate code-derived specifications, THE spec-check tool SHALL use the run-configured universal timeout budget.

**Postcondition:** Generation timeout behavior matches every other LLM-backed phase in the run.

##### Evidence
- Implementation: [derive.ts:131 deriveSpecsFromSource](/src/domain/code-backwards/derive.ts#L131) (passes timeoutMs to callOpencode)
- Test: [derive.test.ts:57 produces EARS-preferring markdown from LLM informalization response](/test/contract/derive.test.ts#L57)

#### Requirement model

```alloy
// GenerationPlan is a model-output observation, independent of original text.
// Novel capabilities are permitted; name suggestions are metadata only.
// Safety: insufficient no invention.
assert insufficient_no_invention { always (all g : Run.generated |
  some p : GenerationPlan | p.cap = g.cap and p.sufficient = True) }
```

### Requirement: Formalize Code-Derived Specifications [STC-GEN-FORMAL]
WHEN code-derived specifications are available, THE spec-check tool SHALL parse, admit, discover concepts for, and formalize them through the same structural, modal, typed-predicate, clustering, and evidence pipeline as original claims while using an independently derived registry.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- [Design: Interaction Protocols](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#interaction-protocols)
- [Design: Clustering and alignment](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#clustering-and-alignment)

#### Scenario: Stable Code-Derived Formalization [STC-FORMAL-STABLE]
WHEN compatible nonvacuous generated samples meet the stability threshold, THE spec-check tool SHALL select the highest-confidence representative with deterministic input-index tie-breaking and SHALL persist its qualifications and SMT artifact under `gen_specs_smt/`.

#### Scenario: Ambiguous Code-Derived Formalization [STC-FORMAL-AMBIG]
IF no compatible nonvacuous cluster meets the threshold, THEN THE spec-check tool SHALL preserve alternative generated interpretations and SHALL mark dependent comparison scope interpretation-dependent.

#### Scenario: Code-Derived Formalization Failure [STC-FORMAL-FAIL]
IF generated claims exhaust formalization attempts without valid candidates, THEN THE spec-check tool SHALL persist their attempt evidence, report the affected capability's failure, and continue unaffected capabilities rather than abort the entire pipeline for that capability.

#### Scenario: Universal LLM Timeout For Code-Derived Formalization [STC-FORMAL-TIMEOUT]
WHEN generated discovery or formalization invokes the model, THE spec-check tool SHALL use the run-configured universal timeout and existing bounded retry policy.

#### Scenario: Generated Modality Comes From Parsed Source [STC-FORMAL-MODAL]
WHEN generated text uses `SHOULD` or `MAY`, THE spec-check tool SHALL preserve its advisory or permission meaning rather than unconditionally construct a mandatory synthetic claim.

#### Scenario: Unsupported Generated Prose Is Explicit Scope [STC-FORMAL-ELIGIBILITY]
IF a generated statement is malformed EARS or unsupported justified prose, THEN THE spec-check tool SHALL preserve it with an exclusion reason and SHALL qualify the capability's formal coverage.

##### Historical verification evidence
- Implementation: [gen-formal.ts:71 formalizeGeneratedSpecs](/src/domain/code-backwards/gen-formal.ts#L71)
- Test: [gen-formal.test.ts:58 applies formalizeClaims with schema validation (same pipeline as specs-forward)](/test/contract/gen-formal.test.ts#L58), [gen-formal.test.ts:83 applies clustering with stability threshold 0.6](/test/contract/gen-formal.test.ts#L83)
- Test: [gen-formal.test.ts:133 with single sample clustering never produces ambiguity finding](/test/contract/gen-formal.test.ts#L133)
- Test: [gen-formal.test.ts:156 records error finding on formalization failure (all samples invalid)](/test/contract/gen-formal.test.ts#L156)
- Implementation: [gen-formal.ts:71 formalizeGeneratedSpecs](/src/domain/code-backwards/gen-formal.ts#L71) (passes timeoutMs to formalizeClaims)
- Test: [gen-formal.test.ts:58 applies formalizeClaims with schema validation (same pipeline as specs-forward)](/test/contract/gen-formal.test.ts#L58)

#### Requirement model

```alloy
pred formalize[g : Generated] {
  Run.phase = Formalize and g in Run.generated - Run.formalized
  Run.formalized' = Run.formalized + g
  Run.frozen' = Run.frozen + { r : Registry | r.cap = g.cap and r.side = GeneratedSide }
  Run.generated' = Run.generated
  Run.phase' = Run.phase
  keep_sources
  keep_comparison
}
pred end_formalization {
  Run.phase = Formalize and Run.formalized = Run.generated
  Run.phase' = Aggregate
  keep_sources
  keep_generation
  keep_comparison
}
// Safety: a failed generated interpretation cannot silently become stable.
assert formal_status_retained { always (formal_errors in Run.generated) }
```

### Requirement: Solver Analysis Of Code-Derived Formalizations [STC-GEN-LOGIC]
WHEN code-derived formalizations are available, THE spec-check tool SHALL run obligation-aware solver analysis on the code-derived formal artifacts to check their internal consistency and SHALL persist all solver inputs and outputs verbatim under the output directory.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Internal Contradiction In Code-Derived Guarantees [STC-LOGIC-CONTRA]
WHEN solver analysis of code-derived formalizations produces an unsatisfied or contradictory result, THE spec-check tool SHALL report the finding with preserved solver evidence.

**Postcondition:** Internal inconsistencies in what the code guarantees are visible before cross-side comparison.

##### Evidence
- Implementation: [gen-logic.ts:40 analyzeGeneratedLogic](/src/domain/code-backwards/gen-logic.ts#L40)
- Test: [gen-logic.test.ts:55 reports internal contradiction in code-derived formalizations](/test/contract/gen-logic.test.ts#L55)

#### Scenario: Code-Derived Logic Report [STC-LOGIC-REPORT]
WHEN code-derived solver analysis completes, THE spec-check tool SHALL write the results to `report_2.logic.md` under the output directory.

**Postcondition:** Code-derived formal analysis is available as a distinct reviewable report.

##### Evidence
- Implementation: [gen-logic.ts:40 analyzeGeneratedLogic](/src/domain/code-backwards/gen-logic.ts#L40)
- Test: [gen-logic.test.ts:36 delegates to runLogicAnalysis and returns its findings and report](/test/contract/gen-logic.test.ts#L36)

#### Scenario: Solver Timeout On Code-Derived Query [STC-LOGIC-TIMEOUT]
IF the solver returns timeout or unknown for a code-derived query, THEN THE spec-check tool SHALL preserve the inconclusive result as evidence and SHALL continue with remaining queries.

**Postcondition:** A single slow query does not block code-derived solver analysis.

##### Evidence
- Implementation: [gen-logic.ts:40 analyzeGeneratedLogic](/src/domain/code-backwards/gen-logic.ts#L40)
- Test: [gen-logic.test.ts:75 handles solver timeout without blocking](/test/contract/gen-logic.test.ts#L75)

#### Requirement model

```alloy
// Generated solver statuses remain explicit observations; timeout/error is not
// an implementation contradiction. Exact script persistence uses the shared
// query/evidence workflow in formalization-and-logic-analysis.
fun uncertain_comparisons : set Comparison { { c : Run.aggregates | relation[c] = Uncertain } }
// Safety: inconclusive not alignment.
assert inconclusive_not_alignment { always (no { c : uncertain_comparisons | relation[c] in Same + Stronger + PermissionEquivalent }) }
```

### Requirement: Cross-Side Implication Analysis [STC-CROSS-IMPLY]
WHEN original and generated artifacts are available, THE spec-check tool SHALL check their independently frozen vocabularies, explicit alignment, modality, background assumptions, nonvacuity, and solver fragment before aggregate or bounded pairwise implication.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- [Design: Clustering and alignment](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#clustering-and-alignment)

#### Scenario: Classify Same Guarantee [STC-IMPLY-SAME]
WHEN fully mapped compatible satisfiable original and generated predicates mutually entail each other, THE spec-check tool SHALL classify their scoped relationship as `same` with the admitted assumptions and interpretation qualifications.

#### Scenario: Classify Stronger Code-Derived Guarantee [STC-IMPLY-STRONGER]
WHEN compatible satisfiable generated predicates entail original predicates but not conversely, THE spec-check tool SHALL classify the generated formalization as `stronger` within the mapped scope without claiming independent proof of implemented behavior.

#### Scenario: Classify Weaker Code-Derived Guarantee [STC-IMPLY-WEAKER]
WHEN compatible satisfiable original predicates entail generated predicates but not conversely, THE spec-check tool SHALL classify the generated formalization as `weaker` within the mapped scope.

#### Scenario: Classify Different Guarantee [STC-IMPLY-DIFFERENT]
WHEN fully mapped compatible satisfiable artifacts fail implication in both directions, THE spec-check tool SHALL classify their scoped relationship as `different` rather than use that classification for unmapped or incompatible concepts.

#### Scenario: Classify Uncertain When Solver Inconclusive [STC-IMPLY-UNCERTAIN]
IF either required implication direction or nonvacuity precheck is inconclusive, THEN THE spec-check tool SHALL retain terminal formal status `uncertain` and SHALL preserve any qualitative explanation as separate nonauthoritative evidence.

#### Scenario: Persist Implication Evidence [STC-IMPLY-PERSIST]
WHEN a comparison query executes, THE spec-check tool SHALL persist its joint signature, alignment, assumptions, exact script, solver identity, outputs, and scope.

#### Scenario: Single Solver Command Per Cross-Side Query [STC-IMPLY-QUERY]
WHEN compatible premise A and target D are compared, THE spec-check tool SHALL declare every joint symbol once and SHALL execute `B and A and not(D)` with exactly one `check-sat` after successful background and premise satisfiability prechecks.

#### Scenario: Capability-Level Aggregate Comparison [STC-IMPLY-AGGREGATE]
WHEN matched capabilities have comparable artifacts, THE spec-check tool SHALL compare compatible modal tracks in aggregate before pairwise detail and SHALL retain unmapped, incompatible, excluded, unstable, or differing permission scope rather than claim whole-capability alignment from an obligation subset.

#### Scenario: Pair Budget Controls Pairwise Scope [STC-IMPLY-BUDGET]
WHEN original-count times generated-count exceeds effective `pairBudget`, THE spec-check tool SHALL report `pairwise_skipped` for that capability and SHALL preserve available aggregate results without running detailed pairwise comparison.

#### Scenario: Greedy Bipartite Matching Within Budget [STC-IMPLY-GREEDY]
WHEN pairwise comparison is within pair and total query budgets, THE spec-check tool SHALL evaluate compatible obligation pairs in deterministic `same`, `stronger`, `uncertain`, `weaker`, `different` score order and SHALL match permission pairs separately with equivalent relations preferred over non-equivalent relations and source-identity tie-breaking, producing at most one match per claim.

**Postcondition:** Unmapped, incompatible, or partial results remain separate scope statuses and cannot be scored as semantic `different` or silently counted as aligned matches.

#### Scenario: Report Unmatched Capabilities [STC-IMPLY-UNMATCHED-CAP]
WHEN a capability exists on only one side, THE spec-check tool SHALL report `novel_capability` or `unimplemented_capability` with context and generation/coverage limitations rather than infer an implementation defect solely from missing comparison input.

#### Scenario: Report Unmatched Claims Within Capability [STC-IMPLY-UNMATCHED-CLAIM]
WHEN deterministic matching leaves claims unpaired, THE spec-check tool SHALL report the corresponding original/generated unmatched scope with alignment, eligibility, and budget reasons where applicable.

**Postcondition:** An unstable selected sample on either side or a contributing mandatory permission baseline retains its conditional relation separately from mapped scope and receives no matching credit.

#### Scenario: Inconsistent Premise Is Not Stronger [STC-IMPLY-VACUOUS]
IF either side's comparison premise is inconsistent, THEN THE spec-check tool SHALL report its inconsistency and SHALL suppress favorable `same` or `stronger` classification derived from vacuous implication.

#### Scenario: Assumption Mismatch Is Incompatible [STC-IMPLY-ASSUMPTIONS]
IF background assumptions differ after checked alignment and normalization, THEN THE spec-check tool SHALL report `incompatible` rather than silently conjoin one side's stronger assumptions.

##### Historical verification evidence
- Implementation: [cross-implication-smt.ts:203 classifyRelationship](/src/domain/code-backwards/cross-implication-smt.ts#L203)
- Test: [cross-implication.test.ts:39 mutual unsat classifies as same](/test/contract/cross-implication.test.ts#L39)
- Test (property): [cross-implication.property.test.ts:8 classification is deterministic and symmetric by inverse strength labels](/test/property/cross-implication.property.test.ts#L8)
- Test (integration): [safety-liveness.invariant.test.ts:386 LIVE-13: if z3 responds within timeout, cross-side implication completes](/test/invariant/safety-liveness.invariant.test.ts#L386)
- Test: [cross-implication.test.ts:59 forward-sat + reverse-unsat classifies as stronger](/test/contract/cross-implication.test.ts#L59)
- Test: [cross-implication.test.ts:77 forward-unsat + reverse-sat classifies as weaker](/test/contract/cross-implication.test.ts#L77)
- Test: [cross-implication.test.ts:95 both sat classifies as different](/test/contract/cross-implication.test.ts#L95)
- Implementation: [cross-implication-smt.ts:170 classifyDirection](/src/domain/code-backwards/cross-implication-smt.ts#L170), [cross-implication-smt.ts:203 classifyRelationship](/src/domain/code-backwards/cross-implication-smt.ts#L203)
- Test: [cross-implication.test.ts:114 timeout in either direction classifies as uncertain](/test/contract/cross-implication.test.ts#L114)
- Implementation: [cross-implication.ts:66 runCrossImplication](/src/domain/code-backwards/cross-implication.ts#L66)
- Test: [cross-implication.test.ts:131 persists forward/reverse queries and outputs](/test/contract/cross-implication.test.ts#L131)
- Implementation: [cross-implication-smt.ts:130 buildImplicationQuery](/src/domain/code-backwards/cross-implication-smt.ts#L130)
- Test: [implication-query.test.ts:79 contains exactly one (check-sat) command](/test/contract/implication-query.test.ts#L79), [implication-query.test.ts:87 negates the consequent (right-side) assertions](/test/contract/implication-query.test.ts#L87), [implication-query.test.ts:95 preserves left-side assertions directly](/test/contract/implication-query.test.ts#L95)
- Implementation: [cross-implication.ts:181 runCapabilityAggregateComparison](/src/domain/code-backwards/cross-implication.ts#L181)
- Test: [cross-implication.test.ts:213 aggregate comparison combines per-capability assertions](/test/contract/cross-implication.test.ts#L213)
- Implementation: [cross-implication.ts:353 runBoundedPairwiseComparison](/src/domain/code-backwards/cross-implication.ts#L353)
- Test: [cross-implication.test.ts:250 pairwise skips when pair count exceeds budget](/test/contract/cross-implication.test.ts#L250)
- Implementation: [cross-implication.ts:428 runBoundedPairwiseComparison](/src/domain/code-backwards/cross-implication.ts#L428)
- Test: [cross-implication.test.ts:273 pairwise uses greedy matching to assign best pairs](/test/contract/cross-implication.test.ts#L273)
- Implementation: [cross-implication.ts:192 runCapabilityAggregateComparison](/src/domain/code-backwards/cross-implication.ts#L192)
- Test: [cross-implication.test.ts:234 aggregate reports unmatched capabilities on each side](/test/contract/cross-implication.test.ts#L234)
- Implementation: [cross-implication.ts:489 runBoundedPairwiseComparison](/src/domain/code-backwards/cross-implication.ts#L489)
- Test: [cross-implication.test.ts:308 pairwise reports unmatched claims on both sides](/test/contract/cross-implication.test.ts#L308)

#### Requirement model

```alloy
pred aggregate[c : Comparison] {
  Run.phase = Aggregate and c not in Run.aggregates
  c.isAggregate = True
  c.cap in Original.cap + Run.generated.cap
  Run.aggregates' = Run.aggregates + c
  Run.phase' = Run.phase
  keep_sources
  keep_generation
  keep_comparison_except_aggregates
}
fun ready_pairs : set Pair {
  { p : Pair | p.generated in Run.formalized and p.original.plannedStatus not in Failed + Excluded and
    p.generated.plannedStatus not in Failed + Excluded and
    (some c : Run.aggregates | c.cap = p.original.cap and c.modal = p.original.modal) }
}
pred begin_matching {
  Run.phase = Aggregate
  { c : Comparison | c.isAggregate = True and c.cap in Original.cap + Run.generated.cap } in Run.aggregates
  Run.skippedCaps' = { c : Capability | (#(cap.c & Original)).mul[#(cap.c & Run.generated)] > Config.pairBudget }
  Run.phase' = Match
  keep_sources
  keep_generation
  Run.aggregates' = Run.aggregates
  Run.evaluatedPairs' = Run.evaluatedPairs
  Run.matches' = Run.matches
  Run.explanations' = Run.explanations
}
pred match_next[p : Pair] {
  Run.phase = Match and p in ready_pairs - Run.evaluatedPairs
  p.original.cap not in Run.skippedCaps
  no q : ready_pairs - Run.evaluatedPairs | q.original.cap not in Run.skippedCaps and preferred[q,p]
  Run.evaluatedPairs' = Run.evaluatedPairs + p
  Run.matches' = Run.matches + (credit[p.comparison] and no p.original & Run.matches.original and
    no p.generated & Run.matches.generated => p else none)
  Run.phase' = Run.phase
  keep_sources
  keep_generation
  Run.aggregates' = Run.aggregates
  Run.skippedCaps' = Run.skippedCaps
  Run.explanations' = Run.explanations
}
fun novel_caps : set Capability { Run.generated.cap - Original.cap }
fun unimplemented_caps : set Capability { Original.cap - Run.generated.cap }
fun unmatched_original : set Original { Original - Run.matches.original }
fun unmatched_generated : set Generated { Run.generated - Run.matches.generated }
// Safety: aggregate evidence precedes pair evaluation; matching is one-to-one.
assert aggregate_before_pairs { always ((all p : Run.evaluatedPairs | some c : Run.aggregates | c.cap = p.original.cap and c.modal = p.original.modal) and
  all disj p,q : Run.matches | p.original != q.original and p.generated != q.generated) }
assert budget_skips_pairs { always (no Run.evaluatedPairs.original.cap & Run.skippedCaps) }
```

### Requirement: Surface Semantic Divergence As First-Class Evidence [STC-DIVERGE-EVIDENCE]
WHEN cross-side implication analysis reveals divergence between original and code-derived formalizations, THE spec-check tool SHALL surface this divergence as first-class evidence in the comparison report with a per-capability summary that identifies the nature and extent of the divergence.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: High Divergence Surfaced [STC-DIVERGE-HIGH]
WHEN a capability has a majority of claims classified as `different` or `weaker`, THE spec-check tool SHALL surface the divergence prominently with the specific claims and solver evidence that demonstrate the gap.

**Postcondition:** Significant implementation-to-spec gaps are unmissable in the report.

##### Evidence
- Implementation: [cross-implication.ts:538 summarizePerCapability](/src/domain/code-backwards/cross-implication.ts#L538)
- Test: [cross-implication.test.ts:158 high divergence at error severity when majority weaker/different](/test/contract/cross-implication.test.ts#L158)

#### Scenario: Low Divergence Noted [STC-DIVERGE-LOW]
WHEN a capability has all claims classified as `same` or `stronger`, THE spec-check tool SHALL note the alignment as supporting evidence for spec conformance.

**Postcondition:** Positive alignment is documented alongside gaps.

##### Evidence
- Implementation: [cross-implication.ts:538 summarizePerCapability](/src/domain/code-backwards/cross-implication.ts#L538)
- Test: [cross-implication.test.ts:190 low divergence at info severity when all same/stronger](/test/contract/cross-implication.test.ts#L190)

#### Requirement model

```alloy
fun divergent_pairs[c : Capability] : set Pair { { p : Run.matches | p.original.cap = c and relation[p.comparison] in Different + Weaker } }
fun prominent_divergence : set Capability {
  { c : Capability | #divergent_pairs[c] > #(cap.c & Original) - #divergent_pairs[c] }
}
fun wholly_aligned : set Capability {
  { c : Original.cap & Run.generated.cap | (cap.c & Original) in Run.matches.original and
    (cap.c & Run.generated) in Run.matches.generated and
    all p : Run.matches | p.original.cap = c implies relation[p.comparison] in Same + Stronger + PermissionEquivalent }
}
// Safety: prominent divergence uses the declared majority, not any one pair.
assert divergence_majority { always (all c : prominent_divergence | some divergent_pairs[c]) }
```

### Requirement: Two-Layer Comparison With Blind Boundary [STC-BLIND-COMPARE]
WHEN formal and qualitative comparison evidence is produced, THE spec-check tool SHALL keep formal classification distinct from explanatory assessment and SHALL prevent original requirement text, registry contents, and assumptions from influencing source-derived generation or registry discovery.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- [Proposal: Constraints](../../changes/archive/2026-11-15-improve-ears-smt-analysis/proposal.md#constraints)
- [Design: Clustering and alignment](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#clustering-and-alignment)

#### Scenario: Solver Implication As Primary Classifier [STC-COMPARE-PRIMARY]
WHEN a compatible nonvacuous comparison has a conclusive formal relationship, THE spec-check tool SHALL retain that scoped formal verdict independently of any qualitative explanation.

#### Scenario: Blind Comparison As Explanatory Rationale [STC-COMPARE-EXPLAIN]
WHEN generated-only explanatory context is available, THE spec-check tool SHALL attach its rationale as supporting evidence without presenting it as independent proof that the original intent is satisfied.

#### Scenario: Blind Comparison As Fallback Classifier [STC-COMPARE-FALLBACK]
IF formal comparison is uncertain, unmapped, incompatible, or partial, THEN THE spec-check tool SHALL preserve that formal status and SHALL label any model assessment qualitative rather than promote it to a solver-established final equivalence verdict.

**Postcondition:** The historical fallback-classifier behavior is intentionally replaced by evidence-separated assessment.

#### Scenario: Universal LLM Timeout For Blind Comparison [STC-COMPARE-TIMEOUT]
WHEN explanatory model calls execute, THE spec-check tool SHALL use the run-configured universal timeout.

#### Scenario: Prevent Requirement-Text Leakage [STC-COMPARE-BLIND]
IF a derivation or generated-side explanation path would receive original requirement text, registry content, or assumptions, THEN THE spec-check tool SHALL prevent that path and SHALL report the boundary violation.

#### Scenario: Sanitize Untrusted Content In Code Fences [STC-COMPARE-FENCE]
WHEN untrusted explanatory data is placed in a code fence, THE spec-check tool SHALL sanitize delimiter runs and SHALL keep the content in data position.

##### Historical verification evidence
- Implementation: [cross-implication-smt.ts:203 classifyRelationship](/src/domain/code-backwards/cross-implication-smt.ts#L203)
- Test: [cross-implication.test.ts:39 mutual unsat classifies as same](/test/contract/cross-implication.test.ts#L39), [safety-liveness.invariant.test.ts:145 SAFE-7: no cross-side classification is produced from unvalidated inputs](/test/invariant/safety-liveness.invariant.test.ts#L145)
- Implementation: [blind-compare.ts:54 runBlindComparison](/src/domain/code-backwards/blind-compare.ts#L54), [blind-compare.ts:156 extractRationale](/src/domain/code-backwards/blind-compare.ts#L156)
- Test: [blind-compare.test.ts:32 attaches rationale finding with classification and LLM-extracted rationale](/test/contract/blind-compare.test.ts#L32), [blind-compare.test.ts:130 extractRationale returns rationale field, falls back to explanation, defaults](/test/contract/blind-compare.test.ts#L130)
- Test (property): [blind-compare.property.test.ts:45 extractRationale never throws on arbitrary input](/test/property/blind-compare.property.test.ts#L45)
- Implementation: [blind-compare.ts:54 runBlindComparison](/src/domain/code-backwards/blind-compare.ts#L54)
- Test: [blind-compare.test.ts:55 uses warning severity for uncertain classifications, info for definitive](/test/contract/blind-compare.test.ts#L55)
- Implementation: [blind-compare.ts:54 runBlindComparison](/src/domain/code-backwards/blind-compare.ts#L54) (passes timeoutMs to callOpencode)
- Test: [blind-compare.test.ts:32 attaches rationale finding with classification and LLM-extracted rationale](/test/contract/blind-compare.test.ts#L32)
- Implementation: [blind-compare.ts:133 buildBlindPrompt](/src/domain/code-backwards/blind-compare.ts#L133)
- Test: [blind-compare.test.ts:87 emits blind_boundary_violation error when generated context is missing](/test/contract/blind-compare.test.ts#L87), [blind-compare.test.ts:101 buildBlindPrompt contains only generated-side context](/test/contract/blind-compare.test.ts#L101)
- Test (property): [blind-compare.property.test.ts:12 buildBlindPrompt never exposes original requirement text](/test/property/blind-compare.property.test.ts#L12)
- Test (integration): [global.invariant.test.ts:180 INV-15: blind comparison prompts never expose original requirement text](/test/invariant/global.invariant.test.ts#L180), [safety-liveness.invariant.test.ts:127 SAFE-5: no blind comparison exposes original requirement text](/test/invariant/safety-liveness.invariant.test.ts#L127)
- Implementation: [fence.ts:12 sanitizeForCodeFence](/src/domain/fence.ts#L12)
- Test: [blind-compare.test.ts:115 buildBlindPrompt escapes backtick runs in generatedSummary](/test/contract/blind-compare.test.ts#L115)

#### Requirement model

```alloy
// Boundary rejection is attributed to the actual forbidden original/registry
// inputs. Rejection starts no generation and cannot be hidden by a false flag.
fun blind_boundary_findings : set Original + Registry {
  Run.phase in Formalize + Aggregate + Match + Explain + Complete =>
    GenerationBoundary.requestedOriginalText + GenerationBoundary.requestedRegistries else none
}
// Safety: forbidden context cannot influence an issued generated artifact.
assert generation_rejects_forbidden_context { always (not generation_blind implies no Run.generated) }
pred explain {
  Run.phase = Match and ready_pairs - { p : Pair | p.original.cap in Run.skippedCaps } in Run.evaluatedPairs
  Run.phase' = Explain
  Run.explanations' = Original.cap + Run.generated.cap
  keep_sources
  keep_generation
  Run.aggregates' = Run.aggregates
  Run.evaluatedPairs' = Run.evaluatedPairs
  Run.matches' = Run.matches
  Run.skippedCaps' = Run.skippedCaps
}
// Safety: qualitative explanation never overwrites formal relations or scope.
assert explanation_does_not_promote { always (explain implies Run.aggregates' = Run.aggregates and Run.matches' = Run.matches) }
```

### Requirement: Evidence Hierarchy For Source Analysis [STC-EVIDENCE-HIERARCHY]
WHEN the spec-check tool evaluates source-backed evidence, THE spec-check tool SHALL apply an evidence hierarchy: implementation code and verified contracts are primary evidence, traced tests are secondary evidence, and documentation within the source tree is supporting evidence only.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Assumptions and Dependencies`

#### Scenario: Implementation Code Weighted Higher [STC-HIER-CODE]
WHEN both implementation code and documentation reference the same behavior, THE spec-check tool SHALL treat the implementation code as the stronger evidence source.

**Postcondition:** Comparison verdicts reflect actual implementation rather than documentation claims.

##### Evidence
- Implementation: [trace.ts:344 classifyEvidenceLevel](/src/domain/code-backwards/trace.ts#L344)
- Test: [traceability.test.ts:12 links canonical identifiers and reports unknown identifier](/test/contract/traceability.test.ts#L12)

#### Scenario: Documentation-Only Evidence Flagged [STC-HIER-DOCONLY]
IF a code-derived guarantee is supported only by documentation within the source tree and not by implementation or test evidence, THEN THE spec-check tool SHALL classify that guarantee at lower confidence and surface the limitation.

**Postcondition:** Reviewers are aware when derived guarantees rest on documentation rather than implementation.

##### Evidence
- Implementation: [trace.ts:200 traceClaimsToSource](/src/domain/code-backwards/trace.ts#L200)

#### Requirement model

```alloy
fun evidence_for[c : Original] : set SourceFile { { l : TraceLink | l.claim = c }.file & Run.scanned }
fun documentation_only : set Original { { c : Original | some evidence_for[c] and evidence_for[c].kind in Documentation } }
// Safety: another claim's implementation link cannot strengthen this claim.
assert support_is_claim_local { always (all c : Original | Run.traceResults[c] = Supported implies
  some l : TraceLink | l.claim = c and l.file in evidence_for[c] and l.behaviorVerified = True) }
```

### Requirement: Task-to-Claim Consistency When Source Available [STC-TASK-SOURCE]
WHEN both task change summaries and source-backed evidence are available, THE spec-check tool SHALL compare task-documented outcomes against source-derived behavior and SHALL report discrepancies.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`

#### Scenario: Task Claim Matches Source Evidence [STC-TASKSRC-MATCH]
WHEN a completed task change summary describes behavior consistent with source-derived evidence, THE spec-check tool SHALL note the consistency as supporting evidence.

**Postcondition:** Consistent task-source relationships strengthen the overall evidence case.

##### Evidence
- Implementation: [tasks-analysis.ts:29 analyzeTaskSourceConsistency](/src/domain/tasks-analysis.ts#L29)
- Test: [tasks-analysis.test.ts:8 reports consistent when task text matches traced identifier](/test/contract/tasks-analysis.test.ts#L8)

#### Scenario: Task Claim Contradicts Source Evidence [STC-TASKSRC-CONFLICT]
IF a completed task change summary describes behavior that contradicts source-derived evidence, THEN THE spec-check tool SHALL emit a finding citing both the task summary and the conflicting source evidence.

**Postcondition:** Discrepancies between documented and actual behavior are surfaced.

##### Evidence
- Implementation: [tasks-analysis.ts:54 analyzeTaskSourceConsistency](/src/domain/tasks-analysis.ts#L54)
- Test: [tasks-analysis.test.ts:26 reports discrepancy when task text has no matching trace](/test/contract/tasks-analysis.test.ts#L26)

#### Requirement model

```alloy
sig TaskEvidence { related : one Original, conflicts : one Bool, source : one SourceFile }
fun task_conflicts : set TaskEvidence { { t : TaskEvidence | t.conflicts = True and t.source in Run.scanned } }
fun task_supporting : set TaskEvidence { { t : TaskEvidence | t.conflicts = False and t.source in Run.scanned } }
// Safety: task discrepancy attribution retains both the task and source claim.
assert task_evidence_attributed { always (all t : task_conflicts | some t.related and t.source in Run.scanned) }
```

### Requirement: Align Independent Frozen Vocabularies [STC-CONCEPT-ALIGNMENT]
WHEN both source sides have independently frozen registries, THE spec-check tool SHALL persist a post-derivation alignment map recording identities, signatures, units, scope, and unresolved alternatives before constructing a joint comparison signature.

**References:**
- [Design: Concepts and assumptions](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#concepts-and-assumptions)
- [Design: Clustering and alignment](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#clustering-and-alignment)

#### Scenario: Alias Alignment Uses A Checked Joint Signature [STC-ALIGN-ALIASES]
WHEN different symbols denote a supported common concept, THE spec-check tool SHALL map both sides into one checked joint signature without duplicate declarations or changes to the previously frozen registries.

#### Scenario: Unmapped And Incompatible Concepts Stay Distinct [STC-ALIGN-UNRESOLVED]
IF a comparison lacks a concept map or has incompatible signatures, units, or scope, THEN THE spec-check tool SHALL record `unmapped` or `incompatible` respectively and SHALL avoid a semantic `different` verdict for that reason alone.

#### Scenario: Alignment Does Not Feed Back Into Derivation [STC-ALIGN-BLIND]
WHEN joint alignment is produced, THE spec-check tool SHALL keep it outside original/generated discovery and generation inputs and SHALL preserve independent input hashes proving those stages used their own evidence.

**Postcondition:** Generation records selected source-byte snapshots, original path mappings and exact prompt/request identity before invocation. Private copies of those same captured bytes are attached across retries; original edits after capture cannot change generation input. Raw attempt/runtime/model/status evidence is managed and checksummed even on complete failure.

#### Requirement model

```alloy
// Side-local registries freeze independently; alignment consumes their hashes
// after derivation and is never part of generation input or attached snapshots.
// Safety: independent registries.
assert independent_registries { all c : Capability | no { r : Registry | r.cap = c and r.side = OriginalSide } &
  { r : Registry | r.cap = c and r.side = GeneratedSide } }
```

### Requirement: Compare Permissions Separately From Obligations [STC-PERMISSION-RELATION]
WHEN aligned explicit permissions are compared under compatible satisfiable premises, THE spec-check tool SHALL compare their allowed valuation relations using permission-specific verdicts rather than obligation stronger/weaker labels.

**References:**
- [Design: Clustering and alignment](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design.md#clustering-and-alignment)
- [Resolved permission decision](../../changes/archive/2026-11-15-improve-ears-smt-analysis/design-issues.md#permission-track-cross-side-comparison)

#### Scenario: Equal Permitted Sets [STC-PERMISSION-EQUIVALENT]
WHEN permitted relations mutually include each other, THE spec-check tool SHALL report `permission-equivalent` within the admitted scope.

#### Scenario: Generated Permissions Are Broader [STC-PERMISSION-BROADER]
WHEN the original permitted relation is a strict subset of the generated relation, THE spec-check tool SHALL report `permission-broader` rather than an obligation `weaker` verdict.

#### Scenario: Generated Permissions Are Narrower [STC-PERMISSION-NARROWER]
WHEN the generated permitted relation is a strict subset of the original relation, THE spec-check tool SHALL report `permission-narrower` rather than an obligation `stronger` verdict.

#### Scenario: Permitted Sets Differ In Both Directions [STC-PERMISSION-DIFFERENT]
WHEN neither permitted relation includes the other, THE spec-check tool SHALL report `permission-different` with distinguishing valuation evidence.

#### Scenario: Missing Permission Does Not Imply Prohibition [STC-PERMISSION-ABSENT]
IF one side lacks an explicit comparable permission, THEN THE spec-check tool SHALL report unmapped permission scope instead of treating absence as an empty permitted set or proving whole-capability equivalence.

#### Requirement model

```alloy
// Safety: permissions use set-inclusion polarity, never obligation strength names.
assert permissions_separate { all c : Comparison | c.modal = Permission implies
  relation[c] not in Same + Stronger + Weaker + Different }
assert missing_permission_unmapped { all c : Comparison | c.modal = Permission and c.originalPresent = False implies relation[c] = Unmapped }
assert unstable_no_credit { all c : Comparison | c.originalUnstable = True or c.generatedUnstable = True implies not credit[c] }
```

### State machine and invariant checks

```alloy
pred keep_sources {
  Run.scanned' = Run.scanned
  Run.snapshot' = Run.snapshot
  Run.attachments' = Run.attachments
  Run.traceResults' = Run.traceResults
  Run.writes' = Run.writes
}
pred keep_generation { Run.generated' = Run.generated and Run.frozen' = Run.frozen and Run.formalized' = Run.formalized }
pred keep_comparison_except_aggregates {
  Run.evaluatedPairs' = Run.evaluatedPairs
  Run.matches' = Run.matches
  Run.skippedCaps' = Run.skippedCaps
  Run.explanations' = Run.explanations
}
pred keep_comparison { keep_comparison_except_aggregates and Run.aggregates' = Run.aggregates }
pred finish {
  Run.phase = Explain
  Run.phase' = Complete
  keep_sources
  keep_generation
  keep_comparison
}
pred environment_edit[f : SourceFile, b : Bytes] {
  currentBytes' = currentBytes ++ f -> b
  Run.phase' = Run.phase
  keep_sources
  keep_generation
  keep_comparison
}
pred stutter { Run.phase' = Run.phase and keep_sources and keep_generation and keep_comparison }
pred init {
  Run.phase = ValidateSource
  no Run.scanned + Run.generated + Run.formalized + Run.aggregates + Run.evaluatedPairs +
    Run.matches + Run.skippedCaps + Run.explanations + Run.writes
  no Run.snapshot
  no Run.attachments
  no Run.traceResults
  Run.frozen = { r : Registry | r.side = OriginalSide }
}
fact behavior {
  init and always (validate_source or trace or generate or end_formalization or begin_matching or explain or finish or stutter or
    (some g : Generated | formalize[g]) or (some c : Comparison | aggregate[c]) or
    (some p : Pair | match_next[p]) or (some f : SourceFile, b : Bytes | environment_edit[f,b]))
}
pred fairness {
  always (Run.phase = ValidateSource implies eventually validate_source)
  always (Run.phase = Trace implies eventually trace)
  always (Run.phase = Generate implies eventually generate)
  all g : Generated | always (Run.phase = Formalize and g in Run.generated - Run.formalized implies eventually formalize[g])
  always (Run.phase = Formalize and Run.generated = Run.formalized implies eventually end_formalization)
  all c : Comparison | always (Run.phase = Aggregate and c.isAggregate = True and c.cap in Original.cap + Run.generated.cap and c not in Run.aggregates implies eventually aggregate[c])
  always (Run.phase = Aggregate and { c : Comparison | c.isAggregate = True and c.cap in Original.cap + Run.generated.cap } in Run.aggregates implies eventually begin_matching)
  always (Run.phase = Match implies eventually (explain or some p : Pair | match_next[p]))
  always (Run.phase = Explain implies eventually finish)
}
// Liveness: finite serviced source work terminates even with environment edits.
assert pipeline_progress { fairness implies eventually Run.phase in Complete + Aborted }
// Safety: source edits after capture cannot replace immutable generation input.
assert snapshot_immutable { always (Run.phase != ValidateSource implies Run.snapshot' = Run.snapshot) }
// Safety: terminal phases cannot start additional analysis or mutate outcomes.
assert terminal_stable { always (Run.phase in Complete + Aborted implies Run.phase' = Run.phase and Run.matches' = Run.matches) }
run empty_readable_source { no SourceFile and Config.sourceDirectoryReadable = True and fairness and eventually Run.phase = Complete } for 3 but 5 Int, 14 steps expect 1
run invalid_source { Config.sourceDirectoryReadable = False and eventually Run.phase = Aborted } for 3 but 5 Int, 3 steps expect 1
run novel_generated_capability { some Generated and no Original and eventually (Run.phase = Complete and some novel_caps) } for 3 but 5 Int, 20 steps expect 1
run mixed_trace_strengths { eventually (Supported + WeaklySupported + Missing) in Run.traceResults[Original] } for 4 but 5 Int, 6 steps expect 1
run known_identifier_no_warning {
  eventually (Run.phase = Complete and some Run.scanned and no unknown_references and
    (some link : TraceLink | link.file in Run.scanned and some link.claim.id))
} for 3 but 5 Int, 20 steps expect 1
run edited_after_capture { eventually (Run.phase = Complete and some f : Run.snapshot.Bytes | Run.snapshot[f] != f.currentBytes) } for 3 but 5 Int, 20 steps expect 1
run sibling_formal_failure { some disj g,h : Generated | {
  g.plannedStatus = Failed and h.plannedStatus = Stable
  eventually (Run.phase = Complete and g + h in Run.formalized) } } for 4 but 5 Int, 24 steps expect 1
run conditional_not_credited { some p : Pair | p.comparison.originalUnstable = True and eventually (Run.phase = Complete and p in Run.evaluatedPairs - Run.matches) } for 3 but 5 Int, 24 steps expect 1
run broader_permission { some c : Comparison | relation[c] = PermissionBroader } for 3 but 5 Int, 1 steps expect 1
run narrower_permission { some c : Comparison | relation[c] = PermissionNarrower } for 3 but 5 Int, 1 steps expect 1
run incomparable_permission { some c : Comparison | relation[c] = PermissionDifferent } for 3 but 5 Int, 1 steps expect 1
run different_obligations { some c : Comparison | relation[c] = Different } for 3 but 5 Int, 1 steps expect 1
run same_obligations { some c : Comparison | relation[c] = Same } for 3 but 5 Int, 1 steps expect 1
run stronger_obligations { some c : Comparison | relation[c] = Stronger } for 3 but 5 Int, 1 steps expect 1
run weaker_obligations { some c : Comparison | relation[c] = Weaker } for 3 but 5 Int, 1 steps expect 1
run unmapped_scope { some c : Comparison | relation[c] = Unmapped } for 3 but 5 Int, 1 steps expect 1
run incompatible_assumptions { some c : Comparison | relation[c] = Incompatible and c.originalBackground != c.generatedBackground } for 3 but 5 Int, 1 steps expect 1
run uncertain_formal_status { some c : Comparison | relation[c] = Uncertain and c.forward = Timeout } for 3 but 5 Int, 1 steps expect 1
run novel_alongside_original { some Original and some Generated.cap - Original.cap
  eventually (Run.phase = Complete and some novel_caps) } for 4 but 5 Int, 24 steps expect 1
run forbidden_generation_context { some GenerationBoundary.requestedOriginalText
  eventually (Run.phase = Complete and some blind_boundary_findings and no Run.generated) } for 3 but 5 Int, 24 steps expect 1
run pair_budget_keeps_aggregate {
  Config.pairBudget = 0
  some p : Pair | p.original.plannedStatus = Stable and p.generated.plannedStatus = Stable and
    eventually (Run.phase = Complete and p.original.cap in Run.skippedCaps and some Run.aggregates and no Run.evaluatedPairs)
} for 3 but 5 Int, 24 steps expect 1
check trace_total for 4 but 5 Int, 20 steps expect 0
check unknown_ids_exact for 4 but 5 Int, 20 steps expect 0
check scope_exact for 4 but 5 Int, 20 steps expect 0
check source_readonly for 4 but 5 Int, 20 steps expect 0
check attachments_are_snapshots for 4 but 5 Int, 20 steps expect 0
check insufficient_no_invention for 4 but 5 Int, 20 steps expect 0
check formal_status_retained for 4 but 5 Int, 20 steps expect 0
check inconclusive_not_alignment for 4 but 5 Int, 20 steps expect 0
check aggregate_before_pairs for 4 but 5 Int, 20 steps expect 0
check budget_skips_pairs for 4 but 5 Int, 20 steps expect 0
check divergence_majority for 4 but 5 Int, 20 steps expect 0
check explanation_does_not_promote for 4 but 5 Int, 20 steps expect 0
check support_is_claim_local for 4 but 5 Int, 20 steps expect 0
check task_evidence_attributed for 4 but 5 Int, 20 steps expect 0
check independent_registries for 4 but 5 Int, 1 steps expect 0
check permissions_separate for 4 but 5 Int, 1 steps expect 0
check missing_permission_unmapped for 4 but 5 Int, 1 steps expect 0
check unstable_no_credit for 4 but 5 Int, 1 steps expect 0
check pipeline_progress for 3 but 5 Int, 24 steps expect 0
check snapshot_immutable for 4 but 5 Int, 20 steps expect 0
check terminal_stable for 4 but 5 Int, 20 steps expect 0
check generation_rejects_forbidden_context for 4 but 5 Int, 20 steps expect 0
```

**Verification boundary:** All commands use explicit finite scopes. Concrete byte/order preservation and external-process deadlines require the referenced contract/property and integration tests. Passing bounded checks does not prove natural-language fidelity or production refinement.
