## Implementation Discipline

- [ ] Ensure all implementation and verification work for this change follows `docs/lfm.md`.
- [ ] Ensure all code changes for this change follow `docs/typescript_style.md`, including deterministic core logic, explicit invariants, required TSDoc, bounded control flow, and evidence-producing tests.

## 1. Parser And Model Foundations

- [ ] 1.1 Add `DeltaOperation` (with domain `"base" | "pre-section" | "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED"`), `MergedCapabilitySpec`, and parsed-item metadata fields in `src/domain/model.ts`.
- [ ] 1.2 Add `deltaOperation` as a required field on `ParsedRequirement` and `ParsedScenario`.
- [ ] 1.3 Add `parentRequirementIdentifier?: string` to `ParsedScenario`.
- [ ] 1.4 Retain `ParsedSpec.deltaSections` as the file-level summary of encountered delta headings.
- [ ] 1.5 Update `src/domain/parser/spec.ts` and parsing entry points to pass source context, assign per-item delta operations, and record scenario-parent associations.
- [ ] 1.6 Implement exact delta-heading recognition for `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`, and `## RENAMED Requirements` only.
- [ ] 1.7 Assign `deltaOperation: "pre-section"` to items in a delta spec that appear before the first recognized delta section heading, so the merge layer can emit deterministic `spec_merge.pre_section_content` findings.
- [ ] 1.8 Preserve standalone scenarios in delta sections structurally so the merge layer can emit deterministic `spec_merge.standalone_scenario_unsupported` findings.
- [ ] 1.9 Treat all finalized-spec parsed items as `deltaOperation: "base"`, even when finalized specs contain malformed delta headings.
- [ ] 1.10 Update existing parser and claim-related test fixtures to include the new parsed-item fields required for finalized specs.

### Parser And Model Foundations change summary
Capture all model and parser changes here after implementation, including why the metadata shape was chosen, any exact heading-recognition decisions, any invariant/contract assertions added to the code, and any fixture-migration shortcuts or edge cases future developers should know about.

## 2. Capability Merge Layer

- [ ] 2.1 Add `mergeSpecsByCapability()` in `src/domain/parser/merge.ts` as a pure synchronous helper.
- [ ] 2.2 Group parsed specs by capability using catalog-resolved finalized and selected delta documents, correlating by file path.
- [ ] 2.3 Build `MergedCapabilitySpec` values with `capability`, `sourceFiles`, `logicalFile`, merged `requirements`, merged `scenarios`, and `findings`.
- [ ] 2.4 Implement runtime precondition assertion that no capability has more than one delta spec in the input (violation is a fatal pipeline exception).
- [ ] 2.5 Implement finalized-only pass-through behavior.
- [ ] 2.6 Implement delta-only capability behavior: allow `ADDED`, reject `MODIFIED`/`REMOVED` with findings, and warn on `RENAMED`.
- [ ] 2.7 Implement operation application order: REMOVED first, MODIFIED second, ADDED last. Collision checking uses the projected final state.
- [ ] 2.8 Implement `ADDED` requirement-block semantics, including separate requirement/scenario collision namespaces. Finding messages must indicate which namespace the collision occurred in.
- [ ] 2.9 Implement `MODIFIED` requirement-block replacement semantics with exact identifier matching and collision rollback.
- [ ] 2.10 Implement `REMOVED` requirement-block deletion semantics with sparse-entry support.
- [ ] 2.11 Implement deferred `RENAMED` behavior as one warning per delta spec file with no output transformation.
- [ ] 2.12 Implement duplicate-base detection where the first occurrence survives and later duplicates are excluded from output and future matching.
- [ ] 2.13 Implement duplicate-delta detection within a single operation section where all conflicting duplicate blocks are excluded.
- [ ] 2.14 Implement `spec_merge.empty_capability_skipped` emission and downstream omission for capabilities with zero surviving merged requirements.
- [ ] 2.15 Enforce deterministic merged ordering for requirements, scenarios, and capability output order.
- [ ] 2.16 Ensure merge findings are complete, append-only, and non-fatal unless an unexpected internal error makes continuation unsafe.

### Capability Merge Layer change summary
Capture the merge semantics actually implemented, why any edge-case behavior was chosen, what assertions/invariants were encoded in the implementation, how duplicate/collision behavior was made deterministic, and any deviations or clarifications discovered while translating the spec into code.

## 3. Pipeline Integration And Analysis Routing

- [ ] 3.1 Integrate merged capability specs into pipeline context and emit merge findings before downstream specs-forward phases.
- [ ] 3.2 Keep raw parsed specs available for parser findings and qualitative review.
- [ ] 3.3 Update `buildClaimGraph()` to consume merged capability specs for spec-derived claims and populate `Claim.capability`.
- [ ] 3.4 Update coverage analysis to consume merged capability specs so it reflects the same active capability state used by claim extraction and logic.
- [ ] 3.5 Exclude non-spec claims from the capability-grouped specs-forward logic path while leaving other claim-graph behavior unchanged.
- [ ] 3.6 Replace per-file specs-forward logic grouping with merged capability grouping using `Claim.capability` and merged logical artifact keys.
- [ ] 3.7 Implement artifact-key sanitization algorithm: strip leading `<` and trailing `>`, replace `/` with `-`. Validate that sanitized keys are unique before artifact writes.
- [ ] 3.8 Abort the pipeline on sanitized artifact-key collisions or unexpected internal merge exceptions; do not fall back to pre-merge per-file analysis.

### Pipeline Integration And Analysis Routing change summary
Capture how merged and raw specs coexist in the pipeline, why grouping or context boundaries were chosen, how artifact-key collision checks are enforced, and any compatibility constraints uncovered during integration.

## 4. Verification Work

### 4.1 Parser Tests
- [ ] Add or update tests showing a requirement under `## ADDED Requirements` gets `deltaOperation: "ADDED"`.
- [ ] Add or update tests showing a requirement under `## MODIFIED Requirements` gets `deltaOperation: "MODIFIED"`.
- [ ] Add or update tests showing a requirement under `## REMOVED Requirements` gets `deltaOperation: "REMOVED"`.
- [ ] Add or update tests showing a requirement under `## RENAMED Requirements` gets `deltaOperation: "RENAMED"`.
- [ ] Add or update tests showing a scenario inherits the correct enclosing delta operation.
- [ ] Add or update tests showing a scenario records `parentRequirementIdentifier` from the most recently parsed requirement.
- [ ] Add or update tests showing a scenario with no preceding requirement has `parentRequirementIdentifier: undefined`.
- [ ] Add or update tests showing finalized spec items always get `deltaOperation: "base"`.
- [ ] Add or update tests showing delta-spec content before the first delta section heading gets `deltaOperation: "pre-section"`.
- [ ] Add or update tests showing a finalized spec with delta headings emits `spec_merge.finalized_spec_delta_heading_ignored` and still assigns `deltaOperation: "base"`.
- [ ] Add or update tests showing only exact delta heading text changes delta-section context.

### 4.2 Merge Unit Tests
- [ ] Add or update tests showing a finalized-only capability passes through unchanged with no merge findings.
- [ ] Add or update tests for `ADDED` appending a new requirement and its scenarios.
- [ ] Add or update tests for `MODIFIED` replacing a base requirement and all its scenarios by identifier.
- [ ] Add or update tests for `REMOVED` deleting a base requirement and all its scenarios by identifier.
- [ ] Add or update tests showing unmatched `MODIFIED` emits `spec_merge.modified_target_not_found` and continues.
- [ ] Add or update tests showing unmatched `REMOVED` emits `spec_merge.removed_target_not_found` and continues.
- [ ] Add or update tests showing `ADDED` identifier collision emits `spec_merge.duplicate_added_identifier` and skips the block.
- [ ] Add or update tests showing missing identifier in `MODIFIED` emits `spec_merge.modified_missing_identifier`.
- [ ] Add or update tests showing missing identifier in `REMOVED` emits `spec_merge.removed_missing_identifier`.
- [ ] Add or update tests showing `RENAMED` sections emit `spec_merge.rename_unsupported`.
- [ ] Add or update tests showing pre-section content in a delta spec emits `spec_merge.pre_section_content` per item.
- [ ] Add or update tests for delta-only capability behavior.
- [ ] Add or update tests for deterministic merged output ordering.
- [ ] Add or update tests showing standalone scenarios in delta sections emit `spec_merge.standalone_scenario_unsupported` and are excluded.
- [ ] Add or update tests showing duplicate canonical identifier in a finalized base spec emits `spec_merge.duplicate_base_identifier` with first-survivor semantics.
- [ ] Add or update tests showing `RENAMED` in delta-only capabilities still emits `spec_merge.rename_unsupported` and does not affect output.
- [ ] Add or update tests showing duplicate canonical identifier within the same delta operation section emits `spec_merge.duplicate_delta_identifier` and excludes all conflicting blocks.
- [ ] Add or update tests showing an empty merged capability emits `spec_merge.empty_capability_skipped` and is omitted downstream.
- [ ] Add or update tests showing a `MODIFIED` replacement that would introduce an external collision emits `spec_merge.duplicate_modified_identifier`, skips replacement, and preserves the original base block.
- [ ] Add or update tests showing requirement and scenario collisions are checked in separate namespaces.

### 4.3 Merge Safety Property Tests
- [ ] Add or update tests verifying no base requirement block is removed without a matching `REMOVED` operation or duplicate-base exclusion finding.
- [ ] Add or update tests verifying no merged item lacks provenance traceable to a source file.
- [ ] Add or update tests verifying every skipped requirement-block operation produces exactly one finding and every malformed standalone delta item produces exactly one finding.
- [ ] Add or update tests verifying `Claim.capability` is populated for all claims extracted from merged specs.
- [ ] Add or update tests verifying merge findings are appended before downstream phases and remain visible in final run output.
- [ ] Add or update tests verifying a failure or finding in one capability does not change another capability's merged output.
- [ ] Add or update tests verifying approximate or case-variant delta headings do not alter merge semantics.

### 4.4 Liveness Verification Tests
- [ ] Add or update tests verifying every non-empty merged capability is submitted to claim extraction, coverage analysis, and logical analysis exactly once.
- [ ] Add or update tests verifying the count of capabilities analyzed by specs-forward logic equals the count of non-empty merged capabilities.
- [ ] Add or update tests verifying no non-empty merged capability is silently omitted from downstream processing.

### 4.5 Property-Based Tests
- [ ] Implement a test generator that produces structurally valid base+delta combinations covering: empty base, non-empty base with identifiers, delta with ADDED/MODIFIED/REMOVED sections, duplicate identifiers, and mixed operations.
- [ ] Add property-based tests that generate at least 100 random valid inputs and verify determinism (3 repeated runs produce identical output).
- [ ] Add property-based tests that verify no-silent-discard: every base requirement appears in output OR has a REMOVED operation OR has an exclusion finding.
- [ ] Add property-based tests that verify no-phantom-introduction: every output item has provenance traceable to base or delta input.
- [ ] Add property-based tests that verify provenance preservation: no item has modified provenance.file or provenance.line.
- [ ] Add property-based tests that verify finding completeness: every skipped operation produces exactly one finding.

### 4.6 Determinism Verification
- [ ] Add tests that run at least 3 repeated invocations with identical inputs and assert byte-for-byte identical merged outputs and findings arrays.
- [ ] Verify determinism for: merged requirement order, merged scenario order, findings order, and capability output order.

### 4.7 Pipeline, Coverage, And Logic Tests
- [ ] Add or update tests showing one specs-forward logical-analysis group is produced per merged capability.
- [ ] Add or update tests showing contradictions across base-plus-delta items within one capability are detected in one logic run.
- [ ] Add or update tests showing removed requirements no longer participate in logical analysis.
- [ ] Add or update tests showing modified requirements appear only in their delta version in logical analysis.
- [ ] Add or update tests showing logical-analysis artifacts are written under the synthetic `logicalFile` key.
- [ ] Add or update tests showing `Claim.capability` drives grouping instead of `claim.provenance.file`.
- [ ] Add or update tests showing coverage analysis consumes merged capability specs and excludes removed requirements.
- [ ] Add or update tests showing non-spec claims are excluded from the capability-grouped logic path.
- [ ] Add or update tests showing sanitized `logicalFile` collisions abort the pipeline before artifact writes.
- [ ] Add or update tests showing capabilities with zero merged requirements are skipped downstream with `spec_merge.empty_capability_skipped`.

### 4.8 Evidence, Formal Artifacts, And Regression Discipline
- [ ] Update or add merge-related Alloy or formal/design artifacts required by the affected capability specs.
- [ ] Ensure every discovered bug or counterexample during implementation becomes a permanent regression test.
- [ ] Ensure verification evidence is sufficient for archive and traceable to scenarios, invariants, and findings in this change.
- [ ] Run the relevant test suites and record the evidence produced.

### Verification Work change summary
Capture what was tested, which invariants or scenarios each test class covers, what formal or executable evidence was updated, any counterexamples discovered, and why the resulting evidence is sufficient for archive under the lightweight formal methods workflow.

## 5. Documentation Updates

### 5.1 `docs/design.md`
- [ ] Insert a `per-capability merge` node into the main pipeline flowchart between parsing and claim graph.
- [ ] Add a component description row for the merge phase.
- [ ] Update the capability source-of-truth discussion to describe finalized-plus-delta merge semantics.
- [ ] Add a merged-spec conceptual entity and relationships into the domain model/ER material.
- [ ] Update the domain-entities and conceptual-relationship sections so claim extraction operates on merged specs.
- [ ] Add merge determinism and merged-active-view invariants.
- [ ] Add a merge phase row to the per-phase contracts table.
- [ ] Update state machines and sequence diagrams to include merge between parse and claim graph.
- [ ] Add `src/domain/parser/merge.ts` to the documented repository layout and pipeline summaries.

### 5.2 `ARCHITECTURE.md`
- [ ] Insert merge between parsing and normalization/claim-graph analysis in the pipeline overview diagram.
- [ ] Update `run-cli.ts` phase grouping so merge is explicit.
- [ ] Revise parsed-model and parser/catalog sections to describe the merge layer as the new hinge between parsing output and analysis input.
- [ ] Mention per-capability merge before analysis begins.

### 5.3 `README.md`
- [ ] Add the merge module to the `src/domain/` directory listing.
- [ ] Update feature overview wording so specs-forward analysis is described as operating on merged capability views when active deltas are present.

### 5.4 Alloy Models And Capability Specs
- [ ] Update embedded Alloy models and state-machine descriptions in affected capability specs so they reflect merged-capability behavior and active capability grouping.

### Documentation Updates change summary
Capture exactly which documentation and formal artifacts were updated, which diagrams/tables/models changed, and any documentation clarifications that were required to keep the implementation, evidence, and narrative in sync.
