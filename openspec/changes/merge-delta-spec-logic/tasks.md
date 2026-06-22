## Implementation Discipline

- [x] Ensure all implementation and verification work for this change follows `docs/lfm.md`.
- [x] Ensure all code changes for this change follow `docs/typescript_style.md`, including deterministic core logic, explicit invariants, required TSDoc, bounded control flow, and evidence-producing tests.

## 1. Parser And Model Foundations

- [x] 1.1 Add `DeltaOperation` (with domain `"base" | "pre-section" | "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED"`), `MergedCapabilitySpec`, and parsed-item metadata fields in `src/domain/model.ts`.
- [x] 1.2 Add `deltaOperation` as a required field on `ParsedRequirement` and `ParsedScenario`.
- [x] 1.3 Add `parentRequirementIdentifier?: string` to `ParsedScenario`.
- [x] 1.4 Retain `ParsedSpec.deltaSections` as the file-level summary of encountered delta headings.
- [x] 1.5 Update `src/domain/parser/spec.ts` and parsing entry points to pass source context, assign per-item delta operations, and record scenario-parent associations.
- [x] 1.6 Implement exact delta-heading recognition for `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`, and `## RENAMED Requirements` only.
- [x] 1.7 Assign `deltaOperation: "pre-section"` to items in a delta spec that appear before the first recognized delta section heading, so the merge layer can emit deterministic `spec_merge.pre_section_content` findings.
- [x] 1.8 Preserve standalone scenarios in delta sections structurally so the merge layer can emit deterministic `spec_merge.standalone_scenario_unsupported` findings.
- [x] 1.9 Treat all finalized-spec parsed items as `deltaOperation: "base"`, even when finalized specs contain malformed delta headings.
- [x] 1.10 Update existing parser and claim-related test fixtures to include the new parsed-item fields required for finalized specs.

### Parser And Model Foundations change summary
- What changed: added `DeltaOperation` type (`"base" | "pre-section" | "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED"`) and `MergedCapabilitySpec` interface (with `capability`, `sourceFiles`, `logicalFile`, `requirements`, `scenarios`, `findings`) to `src/domain/model.ts`. Added `deltaOperation: DeltaOperation` as a required field on both `ParsedRequirement` and `ParsedScenario`. Added `parentRequirementIdentifier?: string` to `ParsedScenario`.
- Why this shape: `deltaOperation` is per-item (not per-file) to support mixed-operation delta documents and to give the merge layer exact per-block context. `parentRequirementIdentifier` enables the merge layer to surface standalone scenario findings. `MergedCapabilitySpec` uses a synthetic `logicalFile` field (format `<merged-spec/{capability}>`) to provide stable artifact naming without colliding with real filesystem paths.
- Parser changes: `parseSpec(file, source = "final")` gained a `source` parameter. When `source === "delta"`, a `currentDeltaOperation` state variable starts at `"pre-section"` and transitions when exact delta section headings are encountered. When `source === "final"`, all items always receive `"base"` regardless of malformed headings.
- Exact heading recognition: uses a constant `Set` containing exactly `"ADDED Requirements"`, `"MODIFIED Requirements"`, `"REMOVED Requirements"`, and `"RENAMED Requirements"`. Case-variant or approximate headings (e.g., `## Added requirements`, `## ADDED Reqs`) are not recognized and do not change delta-section context.
- Finalized spec protection: if a finalized spec (`source === "final"`) contains delta headings, `currentDeltaOperation` is never updated -- all items remain `"base"`. The detected headings are still recorded in `deltaSections` so the merge layer can emit `spec_merge.finalized_spec_delta_heading_ignored`.
- Fixture migration: existing parser and claim test fixtures were updated to include `deltaOperation: "base"` on all requirements and scenarios. All existing tests pass without behavioral changes.
- Developer handoff notes: the `parseRequirement` and `parseScenario` internal helpers accept `deltaOperation` as a parameter rather than reading module-level state. This keeps them pure and testable in isolation. The `parentRequirementIdentifier` is resolved via a simple `lastParsedRequirementIdentifier` accumulator in the parse loop.

## 2. Capability Merge Layer

- [x] 2.1 Add `mergeSpecsByCapability()` in `src/domain/parser/merge.ts` as a pure synchronous helper.
- [x] 2.2 Group parsed specs by capability using catalog-resolved finalized and selected delta documents, correlating by file path.
- [x] 2.3 Build `MergedCapabilitySpec` values with `capability`, `sourceFiles`, `logicalFile`, merged `requirements`, merged `scenarios`, and `findings`.
- [x] 2.4 Implement runtime precondition assertion that no capability has more than one delta spec in the input (violation is a fatal pipeline exception).
- [x] 2.5 Implement finalized-only pass-through behavior.
- [x] 2.6 Implement delta-only capability behavior: allow `ADDED`, reject `MODIFIED`/`REMOVED` with findings, and warn on `RENAMED`.
- [x] 2.7 Implement operation application order: REMOVED first, MODIFIED second, ADDED last. Collision checking uses the projected final state.
- [x] 2.8 Implement `ADDED` requirement-block semantics, including separate requirement/scenario collision namespaces. Finding messages must indicate which namespace the collision occurred in.
- [x] 2.9 Implement `MODIFIED` requirement-block replacement semantics with exact identifier matching and collision rollback.
- [x] 2.10 Implement `REMOVED` requirement-block deletion semantics with sparse-entry support.
- [x] 2.11 Implement deferred `RENAMED` behavior as one warning per delta spec file with no output transformation.
- [x] 2.12 Implement duplicate-base detection where the first occurrence survives and later duplicates are excluded from output and future matching.
- [x] 2.13 Implement duplicate-delta detection within a single operation section where all conflicting duplicate blocks are excluded.
- [x] 2.14 Implement `spec_merge.empty_capability_skipped` emission and downstream omission for capabilities with zero surviving merged requirements.
- [x] 2.15 Enforce deterministic merged ordering for requirements, scenarios, and capability output order.
- [x] 2.16 Ensure merge findings are complete, append-only, and non-fatal unless an unexpected internal error makes continuation unsafe.

### Capability Merge Layer change summary
- What changed: added `mergeSpecsByCapability(catalogDocuments, parsedSpecs)` as a pure synchronous function in `src/domain/parser/merge.ts`. It takes catalog documents (with `source`, `capability`, `path`) and parsed specs, and produces `readonly MergedCapabilitySpec[]`.
- Merge semantics: the merge operates at the requirement-block level (a requirement plus all its child scenarios grouped by provenance line proximity). Operations are applied in the order: REMOVED first, MODIFIED second, ADDED last. This ensures collision checking for ADDED uses the projected final state (after removals and replacements).
- Identifier matching: uses canonical identifiers from the requirement's parsed `identifier` field. Matching is exact string equality after extraction. Requirements without identifiers in MODIFIED/REMOVED sections emit `spec_merge.*_missing_identifier` findings and are skipped.
- Collision semantics: requirement and scenario identifiers are separate namespaces. An ADDED requirement with identifier `[FOO-BAR]` does not collide with a scenario with the same identifier, and vice versa. Finding messages explicitly state which namespace the collision occurred in (e.g., "Requirement identifier [X] collides..." or "Scenario identifier [X] collides...").
- MODIFIED collision rollback: if a MODIFIED replacement would introduce an identifier that already exists in the projected state (outside the matched block being replaced), the replacement is skipped, the original base block is preserved, and `spec_merge.duplicate_modified_identifier` is emitted.
- Duplicate handling: duplicate identifiers in the base spec use first-survivor semantics (first occurrence is authoritative, later duplicates excluded with `spec_merge.duplicate_base_identifier`). Duplicate identifiers within a single delta operation section exclude ALL conflicting blocks (not first-wins) with `spec_merge.duplicate_delta_identifier`, preventing arbitrary edit wins.
- Ordering: capabilities are emitted in catalog insertion order. Within each capability, base requirement blocks retain their document order; ADDED blocks are appended at the end in their delta-document order. `groupBlocks()` sorts by `provenance.line` ascending before grouping to ensure stable ordering.
- Precondition assertions: (1) at most one delta per capability (fatal assertion protecting against catalog bugs), (2) every catalog document path has a matching parsed spec in the map (protects against pipeline desync).
- Under-specified decision: `RENAMED` sections emit exactly one `spec_merge.rename_unsupported` warning per delta file regardless of how many items appear in the section. The merge output is unchanged. This was chosen because rename semantics (identifier rewriting across all references) are not defined in v1 and guessing would introduce silent correctness failures.
- Under-specified decision: the `logicalFile` format `<merged-spec/{capability}>` uses angle brackets deliberately to make it syntactically distinguishable from real filesystem paths. The sanitization algorithm strips these brackets and replaces `/` with `-` for artifact filenames.
- Developer handoff notes: all findings produced by the merge are `Finding` values with `spec_merge.*` category prefixes. They are append-only within the merge function -- no finding is ever removed or replaced. The function is stateless between capabilities: a failure in one capability cannot affect another's output.

## 3. Pipeline Integration And Analysis Routing

- [x] 3.1 Integrate merged capability specs into pipeline context and emit merge findings before downstream specs-forward phases.
- [x] 3.2 Keep raw parsed specs available for parser findings and qualitative review.
- [x] 3.3 Update `buildClaimGraph()` to consume merged capability specs for spec-derived claims and populate `Claim.capability`.
- [x] 3.4 Update coverage analysis to consume merged capability specs so it reflects the same active capability state used by claim extraction and logic.
- [x] 3.5 Exclude non-spec claims from the capability-grouped specs-forward logic path while leaving other claim-graph behavior unchanged.
- [x] 3.6 Replace per-file specs-forward logic grouping with merged capability grouping using `Claim.capability` and merged logical artifact keys.
- [x] 3.7 Implement artifact-key sanitization algorithm: strip leading `<` and trailing `>`, replace `/` with `-`. Validate that sanitized keys are unique before artifact writes.
- [x] 3.8 Abort the pipeline on sanitized artifact-key collisions or unexpected internal merge exceptions; do not fall back to pre-merge per-file analysis.

### Pipeline Integration And Analysis Routing change summary
- What changed: added `mergedSpecs: readonly MergedCapabilitySpec[]` as a required (non-optional) field on `PipelineContext` in `src/cli/pipeline-types.ts`. Added `runMergePhase()` in `src/cli/pipeline-helpers.ts` to filter catalog docs to spec-type documents and delegate to `mergeSpecsByCapability()`. Updated `src/cli/run-cli.ts` to execute the merge phase between parsing and claim-graph construction, with merge findings appended to run state before downstream phases.
- Coexistence of raw and merged specs: `PipelineContext` retains the raw `specs` array alongside `mergedSpecs`. Raw specs are still used by the qualitative review phase (which analyzes document structure, not merged semantics) and for parser findings. The claim graph and coverage analysis exclusively consume merged specs when `mergedSpecs.length > 0`.
- Claim graph routing: `buildClaimGraph()` gained an optional `mergedSpecs` parameter. When present and non-empty, it extracts claims exclusively from merged specs (via `extractMergedSpecClaims`), populating `Claim.capability` from the `MergedCapabilitySpec.capability` field. When absent, it falls back to the legacy per-file claim extraction. This ensures all spec-derived claims carry `capability` in the merged path.
- Coverage routing: `analyzeCoverage()` gained an optional `mergedSpecs` parameter. When present, capability names are read directly from `mergedSpec.capability` (bypassing path-heuristic parsing). Empty merged specs (zero surviving requirements) are filtered out before being passed to coverage analysis.
- Logic grouping: `groupRepresentativesBySpec()` gained an optional `mergedSpecs` parameter. When present, it groups representative claims by `Claim.capability` (resolved through the formalization candidate's provenance) rather than by `claim.provenance.file`. Each group uses the `logicalFile` from the corresponding merged spec. Non-spec claims (those without `capability`, e.g., `proposal_property`) are excluded from the capability-grouped logic path when `mergedSpecs` is provided.
- Bug fix: during implementation, non-spec claims (lacking `capability`) were leaking into the capability-grouped logic path, causing undefined behavior. Fixed by adding an explicit `capability === undefined` skip in `groupRepresentativesBySpec` when `mergedSpecs` are present. This is now covered by a permanent regression test.
- Artifact-key sanitization: `sanitizeLogicalFileForArtifacts()` strips leading `<` and trailing `>`, then replaces all `/` with `-`. This converts `<merged-spec/auth>` into `merged-spec-auth` for use as filesystem-safe artifact filenames. A `precondition()` assertion validates that sanitized keys are unique before artifact writes -- collision triggers a fatal pipeline abort.
- Abort semantics: on sanitized artifact-key collision or unexpected internal merge exceptions, the pipeline aborts via `PipelineAbortError`. There is no fallback to pre-merge per-file analysis -- partial merge results are never used.
- Developer handoff notes: the merge phase emits its own progress event (`phase: "merge"`) and its findings are appended to run state immediately after merge completion, before the claim-graph phase begins. This ensures merge findings appear in the final output in pipeline order.

## 4. Verification Work

### 4.1 Parser Tests
- [x] Add or update tests showing a requirement under `## ADDED Requirements` gets `deltaOperation: "ADDED"`.
- [x] Add or update tests showing a requirement under `## MODIFIED Requirements` gets `deltaOperation: "MODIFIED"`.
- [x] Add or update tests showing a requirement under `## REMOVED Requirements` gets `deltaOperation: "REMOVED"`.
- [x] Add or update tests showing a requirement under `## RENAMED Requirements` gets `deltaOperation: "RENAMED"`.
- [x] Add or update tests showing a scenario inherits the correct enclosing delta operation.
- [x] Add or update tests showing a scenario records `parentRequirementIdentifier` from the most recently parsed requirement.
- [x] Add or update tests showing a scenario with no preceding requirement has `parentRequirementIdentifier: undefined`.
- [x] Add or update tests showing finalized spec items always get `deltaOperation: "base"`.
- [x] Add or update tests showing delta-spec content before the first delta section heading gets `deltaOperation: "pre-section"`.
- [x] Add or update tests showing a finalized spec with delta headings emits `spec_merge.finalized_spec_delta_heading_ignored` and still assigns `deltaOperation: "base"`.
- [x] Add or update tests showing only exact delta heading text changes delta-section context.

### 4.2 Merge Unit Tests
- [x] Add or update tests showing a finalized-only capability passes through unchanged with no merge findings.
- [x] Add or update tests for `ADDED` appending a new requirement and its scenarios.
- [x] Add or update tests for `MODIFIED` replacing a base requirement and all its scenarios by identifier.
- [x] Add or update tests for `REMOVED` deleting a base requirement and all its scenarios by identifier.
- [x] Add or update tests showing unmatched `MODIFIED` emits `spec_merge.modified_target_not_found` and continues.
- [x] Add or update tests showing unmatched `REMOVED` emits `spec_merge.removed_target_not_found` and continues.
- [x] Add or update tests showing `ADDED` identifier collision emits `spec_merge.duplicate_added_identifier` and skips the block.
- [x] Add or update tests showing missing identifier in `MODIFIED` emits `spec_merge.modified_missing_identifier`.
- [x] Add or update tests showing missing identifier in `REMOVED` emits `spec_merge.removed_missing_identifier`.
- [x] Add or update tests showing `RENAMED` sections emit `spec_merge.rename_unsupported`.
- [x] Add or update tests showing pre-section content in a delta spec emits `spec_merge.pre_section_content` per item.
- [x] Add or update tests for delta-only capability behavior.
- [x] Add or update tests for deterministic merged output ordering.
- [x] Add or update tests showing standalone scenarios in delta sections emit `spec_merge.standalone_scenario_unsupported` and are excluded.
- [x] Add or update tests showing duplicate canonical identifier in a finalized base spec emits `spec_merge.duplicate_base_identifier` with first-survivor semantics.
- [x] Add or update tests showing `RENAMED` in delta-only capabilities still emits `spec_merge.rename_unsupported` and does not affect output.
- [x] Add or update tests showing duplicate canonical identifier within the same delta operation section emits `spec_merge.duplicate_delta_identifier` and excludes all conflicting blocks.
- [x] Add or update tests showing an empty merged capability emits `spec_merge.empty_capability_skipped` and is omitted downstream.
- [x] Add or update tests showing a `MODIFIED` replacement that would introduce an external collision emits `spec_merge.duplicate_modified_identifier`, skips replacement, and preserves the original base block.
- [x] Add or update tests showing requirement and scenario collisions are checked in separate namespaces.

### 4.3 Merge Safety Property Tests
- [x] Add or update tests verifying no base requirement block is removed without a matching `REMOVED` operation or duplicate-base exclusion finding.
- [x] Add or update tests verifying no merged item lacks provenance traceable to a source file.
- [x] Add or update tests verifying every skipped requirement-block operation produces exactly one finding and every malformed standalone delta item produces exactly one finding.
- [x] Add or update tests verifying `Claim.capability` is populated for all claims extracted from merged specs.
- [x] Add or update tests verifying merge findings are appended before downstream phases and remain visible in final run output.
- [x] Add or update tests verifying a failure or finding in one capability does not change another capability's merged output.
- [x] Add or update tests verifying approximate or case-variant delta headings do not alter merge semantics.

### 4.4 Liveness Verification Tests
- [x] Add or update tests verifying every non-empty merged capability is submitted to claim extraction, coverage analysis, and logical analysis exactly once.
- [x] Add or update tests verifying the count of capabilities analyzed by specs-forward logic equals the count of non-empty merged capabilities.
- [x] Add or update tests verifying no non-empty merged capability is silently omitted from downstream processing.

### 4.5 Property-Based Tests
- [x] Implement a test generator that produces structurally valid base+delta combinations covering: empty base, non-empty base with identifiers, delta with ADDED/MODIFIED/REMOVED sections, duplicate identifiers, and mixed operations.
- [x] Add property-based tests that generate at least 100 random valid inputs and verify determinism (3 repeated runs produce identical output).
- [x] Add property-based tests that verify no-silent-discard: every base requirement appears in output OR has a REMOVED operation OR has an exclusion finding.
- [x] Add property-based tests that verify no-phantom-introduction: every output item has provenance traceable to base or delta input.
- [x] Add property-based tests that verify provenance preservation: no item has modified provenance.file or provenance.line.
- [x] Add property-based tests that verify finding completeness: every skipped operation produces exactly one finding.

### 4.6 Determinism Verification
- [x] Add tests that run at least 3 repeated invocations with identical inputs and assert byte-for-byte identical merged outputs and findings arrays.
- [x] Verify determinism for: merged requirement order, merged scenario order, findings order, and capability output order.

### 4.7 Pipeline, Coverage, And Logic Tests
- [x] Add or update tests showing one specs-forward logical-analysis group is produced per merged capability.
- [x] Add or update tests showing contradictions across base-plus-delta items within one capability are detected in one logic run.
- [x] Add or update tests showing removed requirements no longer participate in logical analysis.
- [x] Add or update tests showing modified requirements appear only in their delta version in logical analysis.
- [x] Add or update tests showing logical-analysis artifacts are written under the synthetic `logicalFile` key.
- [x] Add or update tests showing `Claim.capability` drives grouping instead of `claim.provenance.file`.
- [x] Add or update tests showing coverage analysis consumes merged capability specs and excludes removed requirements.
- [x] Add or update tests showing non-spec claims are excluded from the capability-grouped logic path.
- [x] Add or update tests showing sanitized `logicalFile` collisions abort the pipeline before artifact writes.
- [x] Add or update tests showing capabilities with zero merged requirements are skipped downstream with `spec_merge.empty_capability_skipped`.

### 4.8 Evidence, Formal Artifacts, And Regression Discipline
- [x] Update or add merge-related Alloy or formal/design artifacts required by the affected capability specs.
- [x] Ensure every discovered bug or counterexample during implementation becomes a permanent regression test.
- [x] Ensure verification evidence is sufficient for archive and traceable to scenarios, invariants, and findings in this change.
- [x] Run the relevant test suites and record the evidence produced.

### Verification Work change summary
- What was tested: 7 dedicated test files with 29 merge-specific tests plus updates to existing test files. Full test suite passes: 433 tests, 0 failures.
- Test coverage by tier:
  - Contract tests (`test/contract/merge.test.ts`, 11 tests): covers all 21 MCA spec scenarios (parser delta assignment, merge unit behavior, finding emission, namespace separation, duplicate handling, empty capability skipping).
  - Contract tests (`test/contract/pipeline-helpers.test.ts`, 5 tests): covers `runClaimGraphPhase`, `groupRepresentativesBySpec` with merged specs, `sanitizeLogicalFileForArtifacts` collision detection, and non-spec claim exclusion.
  - Contract tests (`test/contract/merge-logic-routing.test.ts`, 3 tests): covers one-logic-group-per-capability, contradictions detected per-capability, artifacts written under synthetic `artifactKey`.
  - Integration tests (`test/integration/merge-pipeline.integration.test.ts`, 1 test): verifies merge findings are visible in final run output and ordered before downstream findings.
  - Integration tests (`test/integration/merge-liveness.integration.test.ts`, 2 tests): verifies every non-empty merged capability is processed exactly once by claim extraction, coverage, and logic analysis; verifies removed requirements do not participate in downstream analysis.
  - Property tests (`test/property/merge.property.test.ts`, 5 tests): 100-run fast-check properties for determinism, no-silent-discard, no-phantom-introduction, provenance preservation, and finding completeness.
  - Determinism tests (`test/determinism/merge.determinism.test.ts`, 2 tests): 3-run byte-for-byte JSON.stringify comparison of merged requirement order, scenario order, findings order, and capability output order.
- Invariants covered: [MCA-MERGE-CAP] one view per capability, [MCA-DELTA-SEM] operation order and collision semantics, [MCA-MERGE-FIND] finding completeness and no-silent-discard, [MCA-MERGE-PROVEN] provenance preservation, [MCA-LIVENESS] non-empty capabilities reach downstream phases exactly once.
- Formal artifact: created `openspec/changes/merge-delta-spec-logic/specs/merged-capability-analysis/alloy/merge.als` -- Alloy 6 structural model with 6 safety assertions (one-view-per-capability, provenance-preserved, non-empty-analyzed, no-phantom-introduction, excluded-ops-never-in-output, capability-isolation). Alloy Analyzer confirms: all 4 `run` scenarios SAT, all 6 `check` assertions UNSAT within scope 5-6.
- Counterexample discovered: non-spec claims (`proposal_property`, `design_property`) were leaking into the capability-grouped logic path when `mergedSpecs` was provided. The grouping function assumed all claims had a `capability` field. Fixed by adding an explicit skip for claims without `capability`. Permanent regression test in `test/contract/pipeline-helpers.test.ts`.
- Why evidence is sufficient: the verification pyramid covers structural correctness (contract tests per scenario), safety properties (property-based tests over generated inputs), determinism (repeated-run comparison), integration behavior (multi-phase pipeline composition), and formal modeling (Alloy bounded analysis). Every skipped operation, every namespace collision, and every malformed delta content pattern has at least one dedicated test case. The counterexample discovered during implementation is permanently captured as a regression test.

## 5. Documentation Updates

### 5.1 `docs/design.md`
- [x] Insert a `per-capability merge` node into the main pipeline flowchart between parsing and claim graph.
- [x] Add a component description row for the merge phase.
- [x] Update the capability source-of-truth discussion to describe finalized-plus-delta merge semantics.
- [x] Add a merged-spec conceptual entity and relationships into the domain model/ER material.
- [x] Update the domain-entities and conceptual-relationship sections so claim extraction operates on merged specs.
- [x] Add merge determinism and merged-active-view invariants.
- [x] Add a merge phase row to the per-phase contracts table.
- [x] Update state machines and sequence diagrams to include merge between parse and claim graph.
- [x] Add `src/domain/parser/merge.ts` to the documented repository layout and pipeline summaries.

### 5.2 `ARCHITECTURE.md`
- [x] Insert merge between parsing and normalization/claim-graph analysis in the pipeline overview diagram.
- [x] Update `run-cli.ts` phase grouping so merge is explicit.
- [x] Revise parsed-model and parser/catalog sections to describe the merge layer as the new hinge between parsing output and analysis input.
- [x] Mention per-capability merge before analysis begins.

### 5.3 `README.md`
- [x] Add the merge module to the `src/domain/` directory listing.
- [x] Update feature overview wording so specs-forward analysis is described as operating on merged capability views when active deltas are present.

### 5.4 Alloy Models And Capability Specs
- [x] Update embedded Alloy models and state-machine descriptions in affected capability specs so they reflect merged-capability behavior and active capability grouping.

### Documentation Updates change summary
- What changed: updated three documentation files (`docs/design.md`, `ARCHITECTURE.md`, `README.md`) and created one new Alloy formal model (`openspec/changes/merge-delta-spec-logic/specs/merged-capability-analysis/alloy/merge.als`) with a reference section in the capability spec.
- `docs/design.md` changes (9 edits):
  - Section 3.1: added `Merge["parser/merge.ts<br/>Per-capability delta merge"]` node and `Parser --> Merge --> Claims` edges in the high-level architecture Mermaid graph.
  - Section 3.2: inserted `CM[per-capability merge]` node between `C[structured parse]` and `D[claim graph]` in the pipeline flowchart.
  - Section 3.3: added component description row for `Per-capability merge` with key invariant "Output is deterministic; every skipped operation produces exactly one finding; no silent discard of base items".
  - Section 2.4: updated capability source-of-truth cell to describe finalized-plus-delta merge semantics.
  - Section 4.1: added `MergedCapabilitySpec` entity and relationships to the ER diagram.
  - Section 4.2: added "Merged Capability Spec" row to domain entities table; updated Claim entity to mention `capability` field.
  - Section 4.3: inserted "Per-Capability Merge" step between Structured Parser and Claim in the conceptual relationships diagram.
  - Section 4.8: added invariants D-11 (merge determinism), D-12 (merged active view no-silent-discard), D-13 (finding completeness).
  - Section 5.2: added merge phase row to per-phase contracts table with preconditions, postconditions, and error outcomes.
  - Section 6.2: added `MergePerCapability` state to ingestion state machine, added merge rows to decision table, added ING-5/ING-6 invariants.
  - Section 6.3: added note on `BuildClaimGraph` state indicating it consumes merged capability specs.
  - Section 7.1: added `MG as Merge` participant to sequence diagram with `C->>MG` and `MG-->>C` interactions.
  - Section 14.4: added `merge.ts` to the `parser/` directory listing.
- `ARCHITECTURE.md` changes (5 edits):
  - Overview diagram: inserted `+--> per-capability merge` phase between ingestion and normalization with `src/domain/parser/merge.ts`.
  - `run-cli.ts` section: added merge as explicit phase in the phase grouping list.
  - "Parsed Models and Claim Graph" section: revised to describe `parser/merge.ts` as the hinge between parsing and analysis.
  - "Parsing and Catalog" section: added `parser/merge.ts` entry with description.
  - "Ingestion" phase: added merge to the steps list and `merge.ts` to primary code listing.
  - "Specs-Forward Analysis" phase: annotated claim graph construction as operating "from merged capability views".
- `README.md` changes (2 edits):
  - Architecture directory listing: added "per-capability delta merge" to the parser directory description.
  - Feature overview: updated specs-forward analysis bullet to note merged capability views when deltas are present.
- Alloy model: created `merge.als` as a structural (non-temporal) formal model covering 6 safety assertions verified by bounded analysis. Added a "Formal Model" section to the `spec.md` capability spec referencing the Alloy artifact and listing verified properties.
- Documentation clarification: the `run-cli.ts` phase grouping in `ARCHITECTURE.md` already had merge explicit in the code (`runMergePhase` as a named phase with its own progress event). The documentation was brought into alignment with this existing code structure.
