## Purpose

Define the source traceability and code-backwards comparison behavior for the spec-check tool: relating requirements to source evidence, generating EARS-preferring code-derived specifications from source, formalizing code-derived specifications through the same sampling and clustering pipeline, using solver-backed cross-side implication as the primary strength classifier, and providing blind LLM comparison as the explanatory rationale layer.

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

#### Scenario: Report Weakly Supported Trace [STC-TRACE-WEAK]
IF a requirement or scenario identifier appears in source but the located evidence does not demonstrate the behavioral correctness of the claim (e.g., identifier in a comment without corresponding implementation), THEN THE spec-check tool SHALL classify the trace as `weakly supported` and SHALL note that the evidence establishes a link but not behavioral proof.

**Postcondition:** Weak traceability links are distinguished from strong behavioral evidence.

#### Scenario: Report Missing Trace [STC-TRACE-MISSING]
IF a requirement or scenario cannot be traced to any source-backed evidence, THEN THE spec-check tool SHALL emit a traceability gap finding for that claim.

**Postcondition:** Unimplemented or unverified claims remain visible to reviewers.

### Requirement: Canonical Identifier Traceability [STC-TRACE-IDENTIFIERS]
WHEN tracing requirements to source evidence, THE spec-check tool SHALL search for canonical bracketed identifiers (e.g., `[CAT-DISCOVER-INPUTS]`) in source files, test files, and verified contracts to establish traceability links.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Identifier Found In Test File [STC-ID-TEST]
WHEN a canonical requirement or scenario identifier appears in a test file within the declared source scope, THE spec-check tool SHALL record the test file as a traceability link for that claim. This establishes that the claim was considered during testing but does not alone constitute proof of behavioral correctness.

**Postcondition:** Test-to-requirement traceability is established through canonical identifiers; the evidence hierarchy determines how strongly this link supports the claim.

#### Scenario: Identifier Found In Source Comment [STC-ID-SOURCE]
WHEN a canonical requirement or scenario identifier appears in a source code comment within the declared source scope, THE spec-check tool SHALL record the source file as a traceability link for that claim. This establishes that the claim was considered during implementation but does not alone constitute proof of behavioral correctness.

**Postcondition:** Implementation-to-requirement traceability is established through canonical identifiers; the evidence hierarchy determines how strongly this link supports the claim.

#### Scenario: Unknown Identifier In Source [STC-ID-UNKNOWN]
IF a bracketed identifier is found in source that does not match any known requirement or scenario identifier, THEN THE spec-check tool SHALL emit a finding noting the unknown traceability reference.

**Postcondition:** Orphaned source references are surfaced rather than silently ignored.

### Requirement: Source Scope Confinement [STC-SCOPE-CONFINE]
WHEN the spec-check tool scans source evidence, THE spec-check tool SHALL confine scanning to the declared source directory provided via `--src` and SHALL NOT traverse outside that directory.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Source Within Scope Scanned [STC-SCOPE-IN]
WHEN a source file exists within the declared source directory, THE spec-check tool SHALL include it in the traceability scan.

**Postcondition:** All in-scope source files contribute to traceability analysis.

#### Scenario: Source Outside Scope Excluded [STC-SCOPE-OUT]
IF a symlink or reference points to a file outside the declared source directory, THEN THE spec-check tool SHALL exclude that file from traceability scanning.

**Postcondition:** Source-backed evidence remains bounded to declared scope.

#### Scenario: Unreadable Source Directory Rejected [STC-SCOPE-FAIL]
IF the `--src` path does not exist or is not readable, THEN THE spec-check tool SHALL exit with code `2` and a diagnostic message before source-backed analysis begins.

**Postcondition:** No source traceability results are produced from an invalid source path.

### Requirement: Source File Read-Only Treatment [STC-SOURCE-READONLY]
WHEN the spec-check tool performs source traceability or code-backwards analysis, THE spec-check tool SHALL treat all source files as read-only and SHALL NOT modify, create, or delete any file in the source directory.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`

#### Scenario: Source Files Unchanged After Analysis [STC-READONLY-VERIFY]
WHEN source-backed analysis completes, THE spec-check tool SHALL have made zero modifications to any file in the source directory.

**Postcondition:** The source tree is identical before and after analysis.

### Requirement: Generate Code-Derived Specifications From Source [STC-GEN-SPECS]
WHEN source-backed analysis is enabled, THE spec-check tool SHALL generate EARS-preferring behavioral specification files per declared capability using only source-scoped evidence, blind to original requirement text, and SHALL persist the generated specifications as Markdown files in a `gen_specs/` directory under the configured output directory.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Assumptions and Dependencies`

#### Scenario: Generate Capability-Aligned Derived Specs [STC-GEN-CAPABILITY]
WHEN the source tree contains sufficient evidence relevant to a declared capability, THE spec-check tool SHALL generate an EARS-preferring behavioral specification for that capability using only the provided source scope, implementation code, verified contracts, and traced tests as evidence.

**Postcondition:** A generated spec file exists in `gen_specs/` for each capability with sufficient source evidence.

#### Scenario: Capability Name Suggestions From Catalog [STC-GEN-SUGGEST]
WHEN generating code-derived specifications, THE spec-check tool SHALL provide the LLM with the list of known capability names derived from active catalog paths as soft suggestions for capability naming. THE spec-check tool SHALL NOT include requirement text, identifier lists, or spec content in the suggestions.

**Postcondition:** The LLM receives structural metadata (capability names only) that improves naming alignment without violating the blind boundary.

#### Scenario: EARS Preference With Structured Fallback [STC-GEN-EARS]
WHEN code semantics support EARS decomposition, THE spec-check tool SHALL generate requirements using EARS patterns. IF code semantics resist EARS decomposition for a code-derived requirement, THEN THE spec-check tool SHALL use structured behavioral prose and SHALL note the deviation.

**Postcondition:** Generated specs prefer EARS format but do not force unnatural EARS encoding at the expense of accuracy.

#### Scenario: Insufficient Source Evidence [STC-GEN-INSUFFICIENT]
IF a declared capability lacks sufficient source-scoped evidence for meaningful specification generation, THEN THE spec-check tool SHALL emit a limitation finding for that capability and SHALL NOT generate a spec file with unsupported claims.

**Postcondition:** Missing code-derived specs are surfaced as limitations rather than silently skipped.

#### Scenario: Blind Generation Boundary [STC-GEN-BLIND]
WHEN generating code-derived specifications, THE spec-check tool SHALL NOT provide original requirement text, proposal text, or design text to the generation process.

**Postcondition:** Code-derived specs reflect what the code actually guarantees rather than restating original intent.

#### Scenario: Restrict Unsupported Evidence [STC-GEN-SCOPE]
IF a candidate code-derived guarantee depends on evidence outside the provided source scope, THEN THE spec-check tool SHALL exclude that unsupported evidence and SHALL surface the resulting limitation.

**Postcondition:** Code-backed guarantees remain bounded to declared source scope and visible evidence.

### Requirement: Formalize Code-Derived Specifications [STC-GEN-FORMAL]
WHEN code-derived specifications have been generated, THE spec-check tool SHALL formalize them using the same pipeline as specs-forward analysis: bounded LLM sampling, schema validation against the logic IR, equivalence clustering with solver-backed implication checks, and representative selection based on the configured stability threshold. THE spec-check tool SHALL persist the resulting SMT-LIB artifacts in a `gen_specs_smt/` directory under the output directory.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Stable Code-Derived Formalization [STC-FORMAL-STABLE]
WHEN formalization sampling for a code-derived claim produces an equivalence cluster that meets the configured stability threshold, THE spec-check tool SHALL select the highest-confidence sample as the representative formalization for that code-derived claim.

**Postcondition:** Code-derived claims have representative formalizations suitable for cross-side implication analysis.

#### Scenario: Ambiguous Code-Derived Formalization [STC-FORMAL-AMBIG]
IF no equivalence cluster meets the stability threshold for a code-derived claim, THEN THE spec-check tool SHALL emit an ambiguity finding and SHALL preserve the distinct interpretations as evidence.

**Postcondition:** Ambiguity in code-derived meaning is surfaced rather than hidden behind an arbitrary selection.

#### Scenario: Code-Derived Formalization Failure [STC-FORMAL-FAIL]
IF all formalization samples for a code-derived claim are invalid after bounded retries, THEN THE spec-check tool SHALL record the failure as an error-severity finding for that capability and SHALL continue with remaining capabilities. THE tool SHALL NOT abort the entire pipeline for a per-capability formalization failure.

**Postcondition:** Per-capability formalization failures are surfaced as error findings; remaining capabilities proceed to cross-side analysis.

### Requirement: Solver Analysis Of Code-Derived Formalizations [STC-GEN-LOGIC]
WHEN code-derived formalizations are available, THE spec-check tool SHALL run obligation-aware solver analysis on the code-derived formal artifacts to check their internal consistency and SHALL persist all solver inputs and outputs verbatim under the output directory.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Internal Contradiction In Code-Derived Guarantees [STC-LOGIC-CONTRA]
WHEN solver analysis of code-derived formalizations produces an unsatisfied or contradictory result, THE spec-check tool SHALL report the finding with preserved solver evidence.

**Postcondition:** Internal inconsistencies in what the code guarantees are visible before cross-side comparison.

#### Scenario: Code-Derived Logic Report [STC-LOGIC-REPORT]
WHEN code-derived solver analysis completes, THE spec-check tool SHALL write the results to `report_2.logic.md` under the output directory.

**Postcondition:** Code-derived formal analysis is available as a distinct reviewable report.

#### Scenario: Solver Timeout On Code-Derived Query [STC-LOGIC-TIMEOUT]
IF the solver returns timeout or unknown for a code-derived query, THEN THE spec-check tool SHALL preserve the inconclusive result as evidence and SHALL continue with remaining queries.

**Postcondition:** A single slow query does not block code-derived solver analysis.

### Requirement: Cross-Side Implication Analysis [STC-CROSS-IMPLY]
WHEN both original formalizations (from specs-forward) and code-derived formalizations (from source analysis) exist, THE spec-check tool SHALL run a two-tiered comparison: first a capability-level aggregate bidirectional implication check per matched capability, then bounded pairwise bidirectional implication checks with greedy bipartite matching within each capability, and SHALL use the implication results as the primary strength classification mechanism.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Classify Same Guarantee [STC-IMPLY-SAME]
WHEN the solver confirms that original claim A implies code-derived claim B and code-derived claim B implies original claim A, THE spec-check tool SHALL classify the relationship as `same`.

**Postcondition:** Mutual implication produces a `same` classification with solver evidence.

#### Scenario: Classify Stronger Code-Derived Guarantee [STC-IMPLY-STRONGER]
WHEN the solver confirms that code-derived claim B implies original claim A but original claim A does not imply code-derived claim B, THE spec-check tool SHALL classify the code-derived guarantee as `stronger` than the original.

**Postcondition:** The code guarantees more than the spec requires, with formal evidence.

#### Scenario: Classify Weaker Code-Derived Guarantee [STC-IMPLY-WEAKER]
WHEN the solver confirms that original claim A implies code-derived claim B but code-derived claim B does not imply original claim A, THE spec-check tool SHALL classify the code-derived guarantee as `weaker` than the original.

**Postcondition:** The code guarantees less than the spec requires, with formal evidence.

#### Scenario: Classify Different Guarantee [STC-IMPLY-DIFFERENT]
WHEN the solver determines that neither original claim A implies code-derived claim B nor code-derived claim B implies original claim A, THE spec-check tool SHALL classify the relationship as `different`.

**Postcondition:** Non-comparable guarantees are explicitly identified with solver evidence.

#### Scenario: Classify Uncertain When Solver Inconclusive [STC-IMPLY-UNCERTAIN]
IF the solver returns timeout or unknown for either direction of an implication check, THEN THE spec-check tool SHALL classify the solver-layer result as `uncertain`, SHALL preserve the inconclusive result as evidence, and SHALL delegate final classification to the blind LLM comparison fallback as defined in [STC-COMPARE-FALLBACK].

**Postcondition:** Inconclusive solver results are preserved as evidence and trigger fallback classification rather than producing a terminal `uncertain` verdict.

#### Scenario: Persist Implication Evidence [STC-IMPLY-PERSIST]
WHEN cross-side implication checks complete, THE spec-check tool SHALL persist all implication queries and solver results verbatim under the output directory.

**Postcondition:** Every cross-side classification is auditable through preserved solver evidence.

#### Scenario: Single Solver Command Per Cross-Side Query [STC-IMPLY-QUERY]
WHEN the spec-check tool constructs a cross-side implication query to test whether original claim A entails code-derived claim B, THE query SHALL include declarations from both sides for shared context, SHALL assert A's assertions as the premise, SHALL assert the negation of the conjunction of B's assertions (i.e., `(assert (not (and b1 b2 ...)))`) as the consequent test, and SHALL contain exactly one `(check-sat)` command at the end. A result of `unsat` means A entails B; a result of `sat` means A does not entail B.

**Postcondition:** Each cross-side implication query produces exactly one solver result with unambiguous interpretation.

#### Scenario: Capability-Level Aggregate Comparison [STC-IMPLY-AGGREGATE]
WHEN a capability is present on both the original and code-derived sides, THE spec-check tool SHALL combine all SMT assertions from each side into a single conjunction per side and SHALL run a bidirectional implication check (2 Z3 calls) to produce a capability-level aggregate classification.

**Postcondition:** Each matched capability receives an aggregate strength classification before pairwise detail is attempted.

#### Scenario: Pair Budget Controls Pairwise Scope [STC-IMPLY-BUDGET]
WHEN the number of pairwise combinations (N original claims times M generated claims) within a capability exceeds the configured `--pair-budget`, THE spec-check tool SHALL emit a `pairwise_skipped` finding for that capability and SHALL NOT run detailed pairwise comparison for it.

**Postcondition:** Pairwise analysis is bounded by configurable budget; over-budget capabilities are honestly reported rather than silently truncated.

#### Scenario: Greedy Bipartite Matching Within Budget [STC-IMPLY-GREEDY]
WHEN pairwise comparison runs within budget for a capability, THE spec-check tool SHALL run all N times M bidirectional implication pairs and SHALL assign best matches using greedy bipartite matching sorted by classification score (same > stronger > uncertain > weaker > different), producing at most one matched pair per original claim and per generated claim.

**Postcondition:** Greedy matching is deterministic given the same inputs and produces the highest-quality cross-side pairings available within the capability.

#### Scenario: Report Unmatched Capabilities [STC-IMPLY-UNMATCHED-CAP]
WHEN a capability exists only on the generated side, THE spec-check tool SHALL emit a `novel_capability` finding. WHEN a capability exists only on the original side, THE spec-check tool SHALL emit an `unimplemented_capability` finding.

**Postcondition:** Capabilities present on only one side are surfaced with explanatory context noting possible causes (code gap, context budget limitation, or naming mismatch).

#### Scenario: Report Unmatched Claims Within Capability [STC-IMPLY-UNMATCHED-CLAIM]
WHEN greedy matching within a capability leaves original claims unpaired, THE spec-check tool SHALL emit `unmatched_original` findings. WHEN generated claims remain unpaired, THE spec-check tool SHALL emit `unmatched_generated` findings.

**Postcondition:** Claim-level pairing gaps within a capability are visible to reviewers.

### Requirement: Surface Semantic Divergence As First-Class Evidence [STC-DIVERGE-EVIDENCE]
WHEN cross-side implication analysis reveals divergence between original and code-derived formalizations, THE spec-check tool SHALL surface this divergence as first-class evidence in the comparison report with a per-capability summary that identifies the nature and extent of the divergence.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: High Divergence Surfaced [STC-DIVERGE-HIGH]
WHEN a capability has a majority of claims classified as `different` or `weaker`, THE spec-check tool SHALL surface the divergence prominently with the specific claims and solver evidence that demonstrate the gap.

**Postcondition:** Significant implementation-to-spec gaps are unmissable in the report.

#### Scenario: Low Divergence Noted [STC-DIVERGE-LOW]
WHEN a capability has all claims classified as `same` or `stronger`, THE spec-check tool SHALL note the alignment as supporting evidence for spec conformance.

**Postcondition:** Positive alignment is documented alongside gaps.

### Requirement: Two-Layer Comparison With Blind Boundary [STC-BLIND-COMPARE]
WHEN comparing code-derived guarantees against original specifications, THE spec-check tool SHALL use solver-backed cross-side implication as the primary classification mechanism and SHALL use blind LLM comparison as the explanatory layer that provides human-readable rationale. THE spec-check tool SHALL NOT expose original requirement text to the code-derived side during any comparison phase.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Solver Implication As Primary Classifier [STC-COMPARE-PRIMARY]
WHEN cross-side implication results are available and conclusive (same, stronger, weaker, or different) for a claim pair, THE spec-check tool SHALL use the solver-backed classification as the final verdict.

**Postcondition:** Conclusive formal classification takes precedence over qualitative assessment.

#### Scenario: Blind Comparison As Explanatory Rationale [STC-COMPARE-EXPLAIN]
WHEN both solver implication results and blind LLM comparison results are available, THE spec-check tool SHALL attach the blind comparison rationale as supporting evidence that explains the formal classification in human-readable terms.

**Postcondition:** Reviewers receive both a formal verdict and a human-readable explanation.

#### Scenario: Blind Comparison As Fallback Classifier [STC-COMPARE-FALLBACK]
IF cross-side implication results are unavailable or the solver-layer classification is `uncertain` for a claim pair, THEN THE spec-check tool SHALL use the blind LLM comparison as the fallback classifier to produce the final verdict for that pair, and SHALL preserve the solver-layer `uncertain` evidence alongside the blind comparison result.

**Postcondition:** Claims without conclusive formal evidence receive a final classification through the blind comparison layer; both the inconclusive solver evidence and the blind comparison verdict are preserved.

#### Scenario: Prevent Requirement-Text Leakage [STC-COMPARE-BLIND]
IF the blind comparison boundary would expose original requirement text to the code-derived comparison side, THEN THE spec-check tool SHALL prevent that comparison path and SHALL surface the boundary violation as an analysis defect.

**Postcondition:** Blind comparison remains structurally separated from original requirement text.

#### Scenario: Sanitize Untrusted Content In Code Fences [STC-COMPARE-FENCE]
WHEN the spec-check tool embeds untrusted document content inside markdown code fences for comparison prompts, THE spec-check tool SHALL sanitize runs of three or more backticks in the content to prevent premature fence closure.

**Postcondition:** Untrusted content cannot break out of its code fence boundary, preserving prompt structure integrity.

### Requirement: Evidence Hierarchy For Source Analysis [STC-EVIDENCE-HIERARCHY]
WHEN the spec-check tool evaluates source-backed evidence, THE spec-check tool SHALL apply an evidence hierarchy: implementation code and verified contracts are primary evidence, traced tests are secondary evidence, and documentation within the source tree is supporting evidence only.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Assumptions and Dependencies`

#### Scenario: Implementation Code Weighted Higher [STC-HIER-CODE]
WHEN both implementation code and documentation reference the same behavior, THE spec-check tool SHALL treat the implementation code as the stronger evidence source.

**Postcondition:** Comparison verdicts reflect actual implementation rather than documentation claims.

#### Scenario: Documentation-Only Evidence Flagged [STC-HIER-DOCONLY]
IF a code-derived guarantee is supported only by documentation within the source tree and not by implementation or test evidence, THEN THE spec-check tool SHALL classify that guarantee at lower confidence and surface the limitation.

**Postcondition:** Reviewers are aware when derived guarantees rest on documentation rather than implementation.

### Requirement: Task-to-Claim Consistency When Source Available [STC-TASK-SOURCE]
WHEN both task change summaries and source-backed evidence are available, THE spec-check tool SHALL compare task-documented outcomes against source-derived behavior and SHALL report discrepancies.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`

#### Scenario: Task Claim Matches Source Evidence [STC-TASKSRC-MATCH]
WHEN a completed task change summary describes behavior consistent with source-derived evidence, THE spec-check tool SHALL note the consistency as supporting evidence.

**Postcondition:** Consistent task-source relationships strengthen the overall evidence case.

#### Scenario: Task Claim Contradicts Source Evidence [STC-TASKSRC-CONFLICT]
IF a completed task change summary describes behavior that contradicts source-derived evidence, THEN THE spec-check tool SHALL emit a finding citing both the task summary and the conflicting source evidence.

**Postcondition:** Discrepancies between documented and actual behavior are surfaced.

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements
