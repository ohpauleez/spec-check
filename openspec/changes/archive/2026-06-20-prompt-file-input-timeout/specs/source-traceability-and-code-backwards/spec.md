## ADDED Requirements

### Requirement: Attach Large Source Context As Files [STC-SOURCE-FILE-CTX]
WHEN source-backed analysis sends large source context to an external LLM, THE spec-check tool SHALL provide the bounded instruction prompt separately from the selected source files and SHALL attach the selected source files as reference inputs rather than embedding their full contents inline.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Deliver large analysis context through file attachments`

#### Scenario: Attach In-Budget Source Files [STC-SOURCE-FILE-BUDGET]
WHEN source-backed generation selects source files within the configured content budget, THE spec-check tool SHALL attach exactly those in-budget files to the LLM invocation.

**Postcondition:** Large source context remains available to generation without relying on oversized inline arguments.

#### Scenario: Keep Blind Boundary In File Transport [STC-SOURCE-FILE-BLIND]
WHEN the spec-check tool attaches source files for code-derived generation, THE spec-check tool SHALL NOT attach original proposal, design, or requirement documents to that invocation.

**Postcondition:** File-based transport preserves the same blind boundary as inline transport.

## MODIFIED Requirements

### Requirement: Generate Code-Derived Specifications From Source [STC-GEN-SPECS]
WHEN source-backed analysis is enabled, THE spec-check tool SHALL generate EARS-preferring behavioral specification files per declared capability using only source-scoped evidence, blind to original requirement text, SHALL persist the generated specifications as Markdown files in a `gen_specs/` directory under the configured output directory, and SHALL use the run-configured universal timeout for every external LLM generation invocation.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Motivation`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Assumptions and Dependencies`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Deliver large analysis context through file attachments`

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

#### Scenario: Universal LLM Timeout For Code-Derived Generation [STC-GEN-TIMEOUT]
WHEN the spec-check tool invokes an external LLM to generate code-derived specifications, THE spec-check tool SHALL use the run-configured universal timeout budget.

**Postcondition:** Generation timeout behavior matches every other LLM-backed phase in the run.

### Requirement: Formalize Code-Derived Specifications [STC-GEN-FORMAL]
WHEN code-derived specifications have been generated, THE spec-check tool SHALL formalize them using the same pipeline as specs-forward analysis: bounded LLM sampling, schema validation against the logic IR, equivalence clustering with solver-backed implication checks, and representative selection based on the configured stability threshold. THE spec-check tool SHALL persist the resulting SMT-LIB artifacts in a `gen_specs_smt/` directory under the output directory and SHALL use the run-configured universal timeout for every external LLM formalization invocation on generated claims.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Quality Attributes`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`

#### Scenario: Stable Code-Derived Formalization [STC-FORMAL-STABLE]
WHEN formalization sampling for a code-derived claim produces an equivalence cluster that meets the configured stability threshold, THE spec-check tool SHALL select the highest-confidence sample as the representative formalization for that code-derived claim.

**Postcondition:** Code-derived claims have representative formalizations suitable for cross-side implication analysis.

#### Scenario: Ambiguous Code-Derived Formalization [STC-FORMAL-AMBIG]
IF no equivalence cluster meets the stability threshold for a code-derived claim, THEN THE spec-check tool SHALL emit an ambiguity finding and SHALL preserve the distinct interpretations as evidence.

**Postcondition:** Ambiguity in code-derived meaning is surfaced rather than hidden behind an arbitrary selection.

#### Scenario: Code-Derived Formalization Failure [STC-FORMAL-FAIL]
IF all formalization samples for a code-derived claim are invalid after bounded retries, THEN THE spec-check tool SHALL record the failure as an error-severity finding for that capability and SHALL continue with remaining capabilities. THE tool SHALL NOT abort the entire pipeline for a per-capability formalization failure.

**Postcondition:** Per-capability formalization failures are surfaced as error findings; remaining capabilities proceed to cross-side analysis.

#### Scenario: Universal LLM Timeout For Code-Derived Formalization [STC-FORMAL-TIMEOUT]
WHEN the spec-check tool invokes an external LLM to formalize generated claims, THE spec-check tool SHALL use the run-configured universal timeout budget.

**Postcondition:** Indirect code-derived formalization follows the same timeout policy as direct specs-forward formalization.

### Requirement: Cross-Side Implication Analysis [STC-CROSS-IMPLY]
WHEN both original formalizations (from specs-forward) and code-derived formalizations (from source analysis) exist, THE spec-check tool SHALL run a two-tiered comparison: first a capability-level aggregate bidirectional implication check per matched capability, then bounded pairwise bidirectional implication checks with greedy bipartite matching within each capability, and SHALL use the implication results as the primary strength classification mechanism. IF any comparison step invokes an external LLM-backed fallback or explanation phase, THE spec-check tool SHALL use the run-configured universal timeout for each such LLM call.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Motivation`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Quality Attributes`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`

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
WHEN the spec-check tool constructs a cross-side implication query to test whether original claim A entails code-derived claim B, THE query SHALL include declarations from both sides for shared context, SHALL assert A's assertions as the premise, SHALL assert the negation of the conjunction of B's assertions as the consequent test, and SHALL contain exactly one `(check-sat)` command at the end.

**Postcondition:** Each cross-side implication query produces exactly one solver result with unambiguous interpretation.

#### Scenario: Capability-Level Aggregate Comparison [STC-IMPLY-AGGREGATE]
WHEN a capability is present on both the original and code-derived sides, THE spec-check tool SHALL combine all SMT assertions from each side into a single conjunction per side and SHALL run a bidirectional implication check to produce a capability-level aggregate classification.

**Postcondition:** Each matched capability receives an aggregate strength classification before pairwise detail is attempted.

#### Scenario: Pair Budget Controls Pairwise Scope [STC-IMPLY-BUDGET]
WHEN the number of pairwise combinations within a capability exceeds the configured `--pair-budget`, THE spec-check tool SHALL emit a `pairwise_skipped` finding for that capability and SHALL NOT run detailed pairwise comparison for it.

**Postcondition:** Pairwise analysis is bounded by configurable budget; over-budget capabilities are honestly reported rather than silently truncated.

#### Scenario: Greedy Bipartite Matching Within Budget [STC-IMPLY-GREEDY]
WHEN pairwise comparison runs within budget for a capability, THE spec-check tool SHALL run all bounded bidirectional implication pairs and SHALL assign best matches using greedy bipartite matching sorted by classification score, producing at most one matched pair per original claim and per generated claim.

**Postcondition:** Greedy matching is deterministic given the same inputs and produces the highest-quality cross-side pairings available within the capability.

#### Scenario: Report Unmatched Capabilities [STC-IMPLY-UNMATCHED-CAP]
WHEN a capability exists only on the generated side, THE spec-check tool SHALL emit a `novel_capability` finding. WHEN a capability exists only on the original side, THE spec-check tool SHALL emit an `unimplemented_capability` finding.

**Postcondition:** Capabilities present on only one side are surfaced with explanatory context noting possible causes.

#### Scenario: Report Unmatched Claims Within Capability [STC-IMPLY-UNMATCHED-CLAIM]
WHEN greedy matching within a capability leaves original claims unpaired, THE spec-check tool SHALL emit `unmatched_original` findings. WHEN generated claims remain unpaired, THE spec-check tool SHALL emit `unmatched_generated` findings.

**Postcondition:** Claim-level pairing gaps within a capability are visible to reviewers.

### Requirement: Two-Layer Comparison With Blind Boundary [STC-BLIND-COMPARE]
WHEN comparing code-derived guarantees against original specifications, THE spec-check tool SHALL use solver-backed cross-side implication as the primary classification mechanism and SHALL use blind LLM comparison as the explanatory layer that provides human-readable rationale. THE spec-check tool SHALL NOT expose original requirement text to the code-derived side during any comparison phase, and SHALL use the run-configured universal timeout for every blind comparison invocation.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Failure Modes`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Quality Attributes`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`

#### Scenario: Solver Implication As Primary Classifier [STC-COMPARE-PRIMARY]
WHEN cross-side implication results are available and conclusive for a claim pair, THE spec-check tool SHALL use the solver-backed classification as the final verdict.

**Postcondition:** Conclusive formal classification takes precedence over qualitative assessment.

#### Scenario: Blind Comparison As Explanatory Rationale [STC-COMPARE-EXPLAIN]
WHEN both solver implication results and blind LLM comparison results are available, THE spec-check tool SHALL attach the blind comparison rationale as supporting evidence that explains the formal classification in human-readable terms.

**Postcondition:** Reviewers receive both a formal verdict and a human-readable explanation.

#### Scenario: Blind Comparison As Fallback Classifier [STC-COMPARE-FALLBACK]
IF cross-side implication results are unavailable or the solver-layer classification is `uncertain` for a claim pair, THEN THE spec-check tool SHALL use the blind LLM comparison as the fallback classifier to produce the final verdict for that pair, and SHALL preserve the solver-layer `uncertain` evidence alongside the blind comparison result.

**Postcondition:** Claims without conclusive formal evidence receive a final classification through the blind comparison layer.

#### Scenario: Universal LLM Timeout For Blind Comparison [STC-COMPARE-TIMEOUT]
WHEN the spec-check tool invokes blind comparison, THE spec-check tool SHALL use the run-configured universal timeout budget.

**Postcondition:** Blind comparison timeout behavior matches all other LLM-backed phases.

## REMOVED Requirements

## RENAMED Requirements
