## MODIFIED Requirements

### Requirement: Formalize Code-Derived Specifications [STC-GEN-FORMAL]
WHEN code-derived specifications are available, THE spec-check tool SHALL parse, admit, discover concepts for, and formalize them through the same structural, modal, typed-predicate, clustering, and evidence pipeline as original claims while using an independently derived registry.

**References:**
- [Design: Interaction Protocols](../../design.md#interaction-protocols)
- [Design: Clustering and alignment](../../design.md#clustering-and-alignment)

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

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) checks identical admission/execution discipline for a claim universe from either side. Independent registry context isolation and generated-text parsing require boundary contract tests.

### Requirement: Cross-Side Implication Analysis [STC-CROSS-IMPLY]
WHEN original and generated artifacts are available, THE spec-check tool SHALL check their independently frozen vocabularies, explicit alignment, modality, background assumptions, nonvacuity, and solver fragment before aggregate or bounded pairwise implication.

**References:**
- [Design: Clustering and alignment](../../design.md#clustering-and-alignment)

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

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) gates favorable outcomes on compatible typed queries and satisfiable premises. The [finite static model](../../models/static-semantics.als) distinguishes nonvacuous equivalence and broader permission sets, replacing guarantee-only/vacuous comparison abstractions. Alignment correctness and actual implication direction require independent oracle and real-Z3 fixtures.

### Requirement: Two-Layer Comparison With Blind Boundary [STC-BLIND-COMPARE]
WHEN formal and qualitative comparison evidence is produced, THE spec-check tool SHALL keep formal classification distinct from explanatory assessment and SHALL prevent original requirement text, registry contents, and assumptions from influencing source-derived generation or registry discovery.

**References:**
- [Proposal: Constraints](../../proposal.md#constraints)
- [Design: Clustering and alignment](../../design.md#clustering-and-alignment)

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

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) keeps uncertain outcomes outside favorable publication. Boundary-isolation properties and prompt-capture tests establish the independent-derivation contract; this model does not assert natural-language fidelity.

## ADDED Requirements

### Requirement: Align Independent Frozen Vocabularies [STC-CONCEPT-ALIGNMENT]
WHEN both source sides have independently frozen registries, THE spec-check tool SHALL persist a post-derivation alignment map recording identities, signatures, units, scope, and unresolved alternatives before constructing a joint comparison signature.

**References:**
- [Design: Concepts and assumptions](../../design.md#concepts-and-assumptions)
- [Design: Clustering and alignment](../../design.md#clustering-and-alignment)

#### Scenario: Alias Alignment Uses A Checked Joint Signature [STC-ALIGN-ALIASES]
WHEN different symbols denote a supported common concept, THE spec-check tool SHALL map both sides into one checked joint signature without duplicate declarations or changes to the previously frozen registries.

#### Scenario: Unmapped And Incompatible Concepts Stay Distinct [STC-ALIGN-UNRESOLVED]
IF a comparison lacks a concept map or has incompatible signatures, units, or scope, THEN THE spec-check tool SHALL record `unmapped` or `incompatible` respectively and SHALL avoid a semantic `different` verdict for that reason alone.

#### Scenario: Alignment Does Not Feed Back Into Derivation [STC-ALIGN-BLIND]
WHEN joint alignment is produced, THE spec-check tool SHALL keep it outside original/generated discovery and generation inputs and SHALL preserve independent input hashes proving those stages used their own evidence.

**Postcondition:** Generation records selected source-byte snapshots, original path mappings and exact prompt/request identity before invocation. Private copies of those same captured bytes are attached across retries; original edits after capture cannot change generation input. Raw attempt/runtime/model/status evidence is managed and checksummed even on complete failure.

### Requirement: Compare Permissions Separately From Obligations [STC-PERMISSION-RELATION]
WHEN aligned explicit permissions are compared under compatible satisfiable premises, THE spec-check tool SHALL compare their allowed valuation relations using permission-specific verdicts rather than obligation stronger/weaker labels.

**References:**
- [Design: Clustering and alignment](../../design.md#clustering-and-alignment)
- [Resolved permission decision](../../design-issues.md#permission-track-cross-side-comparison)

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
