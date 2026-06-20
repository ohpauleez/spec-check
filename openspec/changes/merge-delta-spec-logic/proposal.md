## Motivation

`spec-check` already resolves one finalized spec and at most one active delta spec per capability, but the specs-forward pipeline still analyzes each `spec.md` file independently. This creates a mismatch between the OpenSpec delta authoring model and the analysis model: a finalized capability spec and its active delta are treated as separate logical units even though they together define the active capability state.

This gap blocks meaningful logical analysis of evolving capabilities. Contradictions introduced by delta updates can be missed, removed requirements can continue participating in analysis, modified requirements can be analyzed twice as both stale base behavior and replacement delta behavior, and the specs-forward solver cannot reason over the full active capability as a single coherent specification.

## Scope

### In Scope
- Add a deterministic per-capability merge layer between structured parsing and specs-forward claim extraction.
- Enrich parsed requirement and scenario models with per-item delta operation context needed for merging.
- Associate scenarios with their enclosing requirement so requirement-block replacement and removal can be applied correctly.
- Apply finalized-plus-delta merge semantics for `ADDED`, `MODIFIED`, `REMOVED`, and first-pass `RENAMED` handling.
- Emit merge findings for malformed, conflicting, or unsupported delta content without silently discarding analysis input.
- Switch specs-forward claim extraction, coverage analysis, and solver grouping to consume merged capability views.
- Use a synthetic merged capability key for logic-analysis artifact grouping while preserving original source provenance on individual requirements, scenarios, and claims.
- Update documentation, Alloy-backed spec artifacts, and verification evidence to reflect the new merge phase and capability-scoped analysis model.

### Out of Scope
- Implement full rename application semantics for `RENAMED` sections.
- Support fuzzy matching by title or body when delta identifiers are missing.
- Support standalone scenario-only delta operations outside a requirement-block replacement model. (Note: while standalone scenario-level delta semantics are not implemented, the merge layer actively rejects these inputs with `spec_merge.standalone_scenario_unsupported` findings to provide defined error handling for structurally invalid input.)
- Change qualitative review behavior to consume merged specs in this first pass.
- Change archive admission policy or allow multiple active deltas per capability.
- Add fallback behavior that reverts to pre-merge per-file analysis when merge logic fails internally.

## Context

### Background
The current codebase already distinguishes finalized and in-development specs during catalog resolution, and it already limits the active input set to one finalized spec plus at most one delta per capability. However, later phases do not preserve that capability-level view. `parseSpec()` parses each file independently, `buildClaimGraph()` extracts claims per parsed file, coverage infers capability identity from source file paths, and logic analysis groups formalized claims by `claim.provenance.file`. As a result, active capability behavior is fragmented across files instead of being analyzed as one merged specification.

The existing OpenSpec `srs-driven` schema already models in-development capability edits with `ADDED`, `MODIFIED`, `REMOVED`, and `RENAMED` requirement sections. This change aligns the analysis pipeline with that authoring model by treating the active specification for a capability as the finalized base plus the selected delta operations.

### Affected Systems and Stakeholders
- `spec-check` developers maintaining parser, claim graph, coverage, and solver pipeline logic.
- Users relying on specs-forward contradiction detection and coverage analysis to reason about in-progress capability changes.
- Documentation maintainers for `docs/design.md`, `ARCHITECTURE.md`, and `README.md`.
- Capability-spec maintainers whose embedded Alloy models and state-machine descriptions must remain consistent with actual analysis behavior.
- Future change authors who depend on delta specs to behave like edits to an existing capability rather than independent specs.

### Assumptions and Dependencies
- Catalog resolution continues to provide at most one finalized spec and one selected active delta spec per capability.
- Capability identity remains derivable from `specs/<capability>/spec.md` path structure.
- Canonical requirement and scenario identifiers remain the authoritative matching mechanism for delta application.
- Existing downstream phases can accept capability-scoped grouping through existing domain fields such as `Claim.capability`.
- The current parser remains the source of truth for structural extraction and provenance, with the merge layer adding semantics rather than re-parsing documents.

### Engineering And Process Constraints
- This project follows the lightweight formal methods workflow documented in `docs/lfm.md`.
- The implementation for this change MUST follow the TypeScript implementation guidelines in `docs/typescript_style.md`.
- The change must preserve deterministic behavior across parsing, merging, grouping, artifact naming, and evidence generation.
- Original source provenance on requirements, scenarios, and claims must remain intact.
- Merge findings may be `error` severity but must remain non-fatal unless an unexpected internal failure makes the pipeline unsafe to continue.
- The first pass must fit the current `srs-driven` delta structure, where scenarios are nested beneath requirements.

### References
- `merge_spec_plan.md`
- `docs/lfm.md`
- `docs/typescript_style.md`
- `openspec/specs/catalog-and-parse/spec.md`
- `openspec/specs/claim-graph-and-coverage/spec.md`
- `openspec/specs/formalization-and-logic-analysis/spec.md`
- `src/domain/parser/catalog.ts`
- `src/domain/parser/spec.ts`
- `src/domain/claim-graph.ts`
- `src/domain/spec-forward/coverage.ts`
- `src/cli/pipeline-helpers.ts`

## Domain Model

The change introduces an explicit distinction between source specs and active capability specs.

Entities:
- **Catalog Document**: A discovered OpenSpec document classified by type, capability, and source (`final` or `delta`).
- **Parsed Spec**: The file-local structured representation of one spec document, including requirements, scenarios, structural findings, and file-level delta section presence.
- **Requirement Block**: One parsed requirement plus its associated scenarios, grouped by positional proximity in the source document. The parser assigns scenarios to the most recently parsed requirement regardless of whether that requirement has an identifier. This is the unit of delta application.
- **Delta Operation**: The semantic role of a requirement block or scenario within a spec: `"base"`, `"pre-section"`, `"ADDED"`, `"MODIFIED"`, `"REMOVED"`, or `"RENAMED"`.
- **Merged Capability Spec**: The active capability view produced from zero or one finalized parsed spec plus zero or one selected delta parsed spec.
- **Claim**: A normalized downstream analysis unit derived from merged requirements and scenarios, still carrying original source provenance and capability identity.
- **Merge Finding**: A surfaced diagnostic describing malformed, unsupported, or conflicting delta behavior encountered during merge.

Relationships:

```text
Catalog Document (final/delta)
        |
        v
    Parsed Spec
        |
        +--> Requirement Block(s)
        |         |
        |         v
        |     Scenario(s)
        |
        v
Merged Capability Spec
        |
        v
      Claim(s)
```

The merged capability spec is not a filesystem document. It is a logical analysis view with a synthetic identity for grouping and artifact naming.

### Encoding And String Handling

All text processing in the merge layer operates on UTF-8 decoded strings as produced by the parser. Specifically:

- Capability names are constrained to the ASCII subset `[a-z0-9-]+` by `inferCapabilityName()`. No Unicode normalization is relevant for capability identity.
- Canonical requirement and scenario identifiers are constrained to the ASCII subset `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+` by the parser. No Unicode normalization is relevant for identifier matching.
- Requirement titles and bodies are preserved as UTF-8 markdown text byte-for-byte from parser output. The merge layer performs no normalization, rewriting, or re-encoding of content.
- Identifier matching uses the bracket-stripped string value produced by the parser with no additional case folding or normalization.

### Merge Output Shape

`MergedCapabilitySpec` contains:
- `capability`: capability identity inferred from the `specs/<capability>/spec.md` path.
- `sourceFiles`: absolute source file paths in `[base, delta]` order when both exist.
- `logicalFile`: the synthetic logical grouping key `<merged-spec/{capability}>`.
- `requirements`: surviving merged requirements after delta application.
- `scenarios`: surviving merged scenarios after delta application.
- `findings`: merge-layer findings produced while building that capability view.

`logicalFile` is a logical key only. It must not be dereferenced as a filesystem path, and any downstream artifact-path derivation must sanitize it and validate uniqueness before writing artifacts.

The `logicalFile` format is `<merged-spec/{capability}>` where `{capability}` is the literal `CapabilityName` string value (e.g., `<merged-spec/catalog-and-parse>`). The angle brackets `<` and `>` are literal characters in the string value. The value contains only ASCII characters: `<`, `>`, `-`, `/`, and lowercase alphanumeric.

#### Artifact-Key Sanitization Algorithm

When downstream code derives a filesystem path from `logicalFile`, it must apply the following sanitization:

1. Strip the leading `<` and trailing `>` characters.
2. Replace all `/` characters with `-`.
3. The result is the sanitized artifact key (e.g., `merged-spec-catalog-and-parse`).

This algorithm is safe against path traversal because capability names are constrained to `[a-z0-9-]+` by `inferCapabilityName()`, which excludes `.`, `/`, `\`, and all other path-sensitive characters. The sanitized result is guaranteed to match `[a-z-]+` after step 2.

The sanitized artifact key must be unique across all merged capabilities in a run. A collision is fatal and aborts the pipeline before any artifact write occurs. Given the current `CapabilityName` domain constraint (unique capability names derived from unique directory paths), a sanitized-key collision is impossible unless the capability naming invariant is violated upstream.

## Merge Semantics

### Input Model
For each capability, the merge layer receives:
- zero or one finalized `ParsedSpec`
- zero or one selected active delta `ParsedSpec`

Catalog resolution remains responsible for selecting at most one active delta per capability and surfacing conflicts before merge begins.

### Matching Unit
One merge operation is one parsed requirement block plus all scenarios associated with that requirement.

Consequences:
- `ADDED`, `MODIFIED`, and `REMOVED` semantics apply only to requirement blocks.
- A skipped requirement-block operation emits exactly one merge finding.
- Standalone malformed items outside a requirement block are structural input errors and each emit their own finding.

### Base Initialization
- If a finalized spec exists, its requirements and scenarios form the initial base.
- If no finalized spec exists but a delta exists, the initial base is empty.
- In a delta-only capability, `ADDED` operations may produce merged output, while `MODIFIED` and `REMOVED` operations emit target-not-found findings and are skipped.
- `RENAMED` sections in delta-only capabilities still emit `spec_merge.rename_unsupported` warnings and do not affect merged output.

### Matching Rules
- Matching is requirement-block only.
- Matching uses canonical identifiers.
- Matching is case-sensitive.
- Matching uses the bracket-stripped identifier value produced by the parser.
- The merge layer performs no additional normalization of identifiers, titles, or bodies.
- Requirement identifiers and scenario identifiers remain separate namespaces for collision detection.

### Operation Application Order

Delta operations are applied in a defined logical sequence:

1. **REMOVED** operations are applied first. Each matched base requirement block and its nested scenarios are deleted from the working state.
2. **MODIFIED** operations are applied second. Each matched base requirement block is replaced with the delta replacement block. Collision checking for MODIFIED operates against the working state after all REMOVED operations have been applied, excluding the matched block being replaced.
3. **ADDED** operations are applied last. New requirement blocks are appended to the working state. Collision checking for ADDED operates against the fully projected state (base minus all REMOVED targets, with all MODIFIED replacements applied).

Within each operation group (e.g., multiple REMOVED blocks), the order of application is irrelevant because:
- Each operation targets a distinct base block (enforced by duplicate-delta-identifier checking within the same section).
- No operation within a group can affect another operation within the same group.

The term "surviving merged requirements" used in collision checking refers to the projected final state: the base requirement set after all REMOVED deletions and all MODIFIED replacements have been applied.

### Duplicate Handling Rationale

- **Base duplicates (first-wins)**: Finalized specs have a natural document order. The first occurrence is authoritative by convention, preserving deterministic behavior while surfacing the malformed duplicate.
- **Delta duplicates (exclude-all)**: Delta blocks within the same section represent competing edits with no natural ordering authority. Excluding all conflicting blocks prevents arbitrary choice and surfaces the conflict for human resolution.

### `ADDED`
- Add new requirements and their nested scenarios to the merged output.
- If the added requirement identifier collides with a surviving merged requirement identifier, emit `spec_merge.duplicate_added_identifier` and skip the entire requirement block. The finding message must identify the colliding identifier value and state that the collision is in the requirement namespace.
- If any nested scenario identifier collides with a surviving merged scenario identifier, emit `spec_merge.duplicate_added_identifier` and skip the entire requirement block. The finding message must identify the colliding identifier value and state that the collision is in the scenario namespace.
- Items without identifiers are added without collision checking.
- Standalone scenarios in an `ADDED` section that are not associated with any requirement block emit `spec_merge.standalone_scenario_unsupported` and are excluded. These are structural input errors that receive defined error handling; standalone scenario-level delta operations are not supported in the first pass.

### `MODIFIED`
- A `MODIFIED` requirement block fully replaces the matched base requirement and all of that base requirement's nested scenarios.
- Matching requires a canonical identifier on the delta requirement.
- If the delta requirement has no identifier, emit `spec_merge.modified_missing_identifier` and skip the operation.
- If no matching base requirement exists, emit `spec_merge.modified_target_not_found` and skip the operation.
- Before replacement, validate that the replacement requirement identifier does not collide with another surviving merged requirement outside the matched base block, and that replacement scenario identifiers do not collide with surviving merged scenarios outside the matched block.
- If such a collision would be introduced, emit `spec_merge.duplicate_modified_identifier`, skip the replacement, and preserve the original base block unchanged.
- Standalone scenarios in a `MODIFIED` section that are not associated with any requirement block emit `spec_merge.standalone_scenario_unsupported` and are excluded.

### `REMOVED`
- A `REMOVED` requirement block deletes the matched base requirement and all of its nested scenarios.
- Removed entries may be sparse and need not reproduce the full body, but an identifier is required.
- If the delta requirement has no identifier, emit `spec_merge.removed_missing_identifier` and skip the operation.
- If no matching base requirement exists, emit `spec_merge.removed_target_not_found` and skip the operation.
- Standalone scenarios in a `REMOVED` section that are not associated with any requirement block emit `spec_merge.standalone_scenario_unsupported` and are excluded.

### `RENAMED`
- Full rename application is deferred in the first implementation.
- Emit one `spec_merge.rename_unsupported` warning per delta spec file when that file contains one or more `RENAMED` sections.
- Rename sections do not transform the merged output.

### Duplicate Identifier Rules
- If duplicate canonical requirement identifiers exist within a single finalized base spec, emit `spec_merge.duplicate_base_identifier` for each duplicate occurrence after the first.
- The first base occurrence remains authoritative.
- Later duplicate base blocks are excluded from merged output and cannot be selected as future match targets.
- If duplicate canonical identifiers appear more than once within the same delta operation section for one capability, emit `spec_merge.duplicate_delta_identifier` for each conflicting block in that duplicate group.
- All conflicting duplicate blocks in that delta duplicate group are excluded from merge application.

### Pre-Section Content And Finalized Delta Headings
- If a delta spec contains requirements or scenarios before the first exact `## ADDED/MODIFIED/REMOVED/RENAMED Requirements` heading, those items receive `deltaOperation: "pre-section"`. The merge layer emits `spec_merge.pre_section_content` for each such item and excludes it from merge.
- If a finalized spec contains delta headings, emit at most one `spec_merge.finalized_spec_delta_heading_ignored` warning per finalized spec file, include the guidance text `finalized specs should not have Delta Spec Headings`, and treat all parsed items in that file as base content.

### Ordering Rules
- Base requirements keep original document order, minus removed blocks, with modified blocks replaced in place.
- `ADDED` requirements append after surviving base requirements in delta-document order.
- Scenarios follow the same principle: base scenarios remain in original order, modified nested scenarios replace in place, and added nested scenarios append in delta-document order.
- The outer merged capability array preserves catalog encounter order.

## Findings And Error Handling

The merge layer introduces findings in the `spec_merge.` namespace:
- `spec_merge.duplicate_added_identifier` (`error`)
- `spec_merge.modified_missing_identifier` (`error`)
- `spec_merge.removed_missing_identifier` (`error`)
- `spec_merge.modified_target_not_found` (`error`)
- `spec_merge.removed_target_not_found` (`error`)
- `spec_merge.rename_unsupported` (`warning`)
- `spec_merge.pre_section_content` (`error`)
- `spec_merge.standalone_scenario_unsupported` (`error`)
- `spec_merge.duplicate_base_identifier` (`error`)
- `spec_merge.finalized_spec_delta_heading_ignored` (`warning`)
- `spec_merge.duplicate_delta_identifier` (`error`)
- `spec_merge.empty_capability_skipped` (`warning`)
- `spec_merge.duplicate_modified_identifier` (`error`)

Merge findings with severity `error` are non-fatal to the pipeline. They skip only the affected merge operation or malformed item and allow remaining capabilities and operations to continue.

Warnings for malformed but tolerated input are also non-fatal.

Unexpected internal merge failures and sanitized artifact-key collisions are fatal and abort the pipeline. There is no fallback to pre-merge per-file analysis because that would silently violate the active-capability analysis model.

## Preconditions, Postconditions, and Invariants

### Preconditions
- Each parsed spec participating in merging has a corresponding catalog document with `type: "spec"` and a defined capability.
- Catalog resolution has already selected at most one active delta per capability.
- Delta matching relies on canonical identifiers where modification or removal semantics require a target.
- `mergeSpecsByCapability()` must validate at runtime that no capability has more than one delta spec in the input. Violation of this precondition is treated as an unexpected internal error (assertion failure) and propagates as a fatal pipeline exception consistent with the graceful degradation strategy.

### Postconditions
- Each active capability contributes at most one merged capability view to specs-forward claim extraction, coverage, and logic analysis.
- Merged requirement and scenario sets reflect finalized base content with selected delta operations applied in deterministic order.
- Unsupported or malformed delta content is surfaced through explicit findings rather than silently ignored.
- Claims extracted from merged capabilities retain original source provenance while gaining capability-scoped grouping identity.
- Capabilities with zero surviving merged requirements emit `spec_merge.empty_capability_skipped` and are omitted from downstream claim extraction, specs-forward logic, and coverage.

### Invariants
- No finalized requirement block is removed from the merged output without either an explicit matching `REMOVED` operation or an explicit surfaced exclusion finding.
- No merged requirement or scenario appears unless it originates from either a finalized base spec or the selected delta spec.
- Provenance on requirements, scenarios, and derived claims remains unchanged.
- Identifier matching remains exact, case-sensitive, and bracket-stripped; no fuzzy matching is introduced.
- Every skipped requirement-block merge operation produces exactly one merge finding, and every unsupported standalone malformed delta item produces exactly one finding.
- Capability-local merge failures do not change the merged output of other capabilities.
- Merged outputs, findings, and downstream grouping remain deterministic for the same inputs.
- Internal merge failures do not silently fall back to file-local analysis.

### Liveness Properties
- **Termination**: `mergeSpecsByCapability()` always terminates and produces a result for every capability in the input. It is synchronous, performs no I/O, and cannot loop or block.
- **Progress**: every requirement-block delta operation is either successfully applied or produces a finding. Every malformed standalone delta item produces a finding. No delta content is silently ignored or deferred indefinitely.
- **Phase progress**: every capability with at least one surviving merged requirement is submitted to downstream specs-forward claim extraction, coverage analysis, and logical analysis. Every capability with zero surviving merged requirements emits `spec_merge.empty_capability_skipped` and is intentionally omitted from downstream phases. No non-empty merged capability is silently skipped.

## Failure Modes

- **Delta operation cannot identify its target**: A `MODIFIED` or `REMOVED` block lacks an identifier or does not match a surviving base requirement.
  - **Rationale**: If the tool guesses or silently skips target resolution, the active capability view becomes untrustworthy and contradictions can be hidden.
- **Delta content appears outside a supported merge unit**: A delta file contains pre-section content or standalone scenarios outside a requirement block.
  - **Rationale**: These inputs are structurally ambiguous under the current schema and must be surfaced rather than misinterpreted.
- **Duplicate identifiers create conflicting active behavior**: Base or delta content introduces duplicate requirement or scenario identifiers within the same merge namespace.
  - **Rationale**: Duplicate identifiers make deterministic target selection impossible and can cause non-repeatable or contradictory analysis results.
- **Merged capability becomes empty after exclusions and removals**: A capability contributes no surviving merged requirements.
  - **Rationale**: Downstream logic and coverage phases should not analyze vacuous capability groups while pretending meaningful behavior remains.
- **Synthetic artifact grouping collides after sanitization**: Two merged capability keys map to the same artifact directory key.
  - **Rationale**: Artifact-path ambiguity would make persisted solver evidence non-deterministic and unsafe.
- **Unexpected merge-layer programming error**: Internal assertions or invariants fail during merge execution.
  - **Rationale**: Falling back to per-file analysis would produce misleading results that contradict the user-visible analysis model.

## Quality Attributes

- **Determinism**:
  - **Target/Threshold**: The same finalized and delta inputs SHALL produce identical merged outputs, findings, and downstream grouping across repeated runs.
  - **Influence**: Merge ordering, duplicate handling, and artifact key generation must all be explicit and stable.
- **Traceability**:
  - **Target/Threshold**: Every merged requirement, scenario, and resulting claim SHALL remain traceable to its original source file and line.
  - **Influence**: The merge layer must not rewrite provenance even when it changes the analysis grouping unit.
- **Reliability**:
  - **Target/Threshold**: Every skipped or unsupported merge operation SHALL emit an explicit finding; no delta content may fail silently.
  - **Influence**: Merge semantics must be conservative, surfacing ambiguity rather than guessing behavior.
- **Correctness of Logical Analysis**:
  - **Target/Threshold**: Specs-forward logic analysis SHALL reason over one active merged capability view per capability instead of isolated base and delta files.
  - **Influence**: The merge layer must feed the same active view into claim extraction, coverage, and solver grouping.
- **Operational Safety**:
  - **Target/Threshold**: Unexpected internal merge failures or artifact-key collisions SHALL abort the pipeline before unsafe artifact persistence.
  - **Influence**: The system must prefer explicit failure over silently producing misleading evidence.

## Capabilities

### New Capabilities
- `merged-capability-analysis`: defines deterministic merge semantics for finalized and selected delta specs and the active merged capability view consumed by specs-forward analysis.

### Modified Capabilities
- `catalog-and-parse`: parsed specs gain per-item delta-operation context and scenario-parent association needed to support capability merging.
- `claim-graph-and-coverage`: claim extraction and coverage analysis shift from raw per-file specs to merged capability views while preserving provenance.
- `formalization-and-logic-analysis`: solver grouping and persisted logic artifacts shift from source-spec files to merged capability analysis units.

## Verification Plan

This change must be verified in a way consistent with `docs/lfm.md`: explicit invariants, direct mechanical checks, deterministic evidence, and no self-certification by the implementation alone. The verification stack for this change must also follow the implementation and testing discipline required by `docs/typescript_style.md`.

### Parser Tests
- Requirement under `## ADDED Requirements` gets `deltaOperation: "ADDED"`.
- Requirement under `## MODIFIED Requirements` gets `deltaOperation: "MODIFIED"`.
- Requirement under `## REMOVED Requirements` gets `deltaOperation: "REMOVED"`.
- Requirement under `## RENAMED Requirements` gets `deltaOperation: "RENAMED"`.
- Scenario inherits the correct enclosing delta operation from its section heading.
- Scenario records `parentRequirementIdentifier` from the most recently parsed requirement.
- Scenario with no preceding requirement has `parentRequirementIdentifier: undefined`.
- Finalized spec items get `deltaOperation: "base"`.
- Delta spec with content before the first delta section heading assigns `deltaOperation: "pre-section"` to those items.
- Finalized spec with delta headings emits `spec_merge.finalized_spec_delta_heading_ignored` and still assigns `deltaOperation: "base"` to all items.
- Only exact delta heading text changes delta-section context in delta files.

### Merge Unit Tests
- Finalized-only capability passes through unchanged; no merge findings emitted.
- `ADDED` appends a new requirement and its scenarios.
- `MODIFIED` replaces a base requirement and all its scenarios by identifier.
- `REMOVED` deletes a base requirement and all its scenarios by identifier.
- Unmatched `MODIFIED` emits `spec_merge.modified_target_not_found` and continues.
- Unmatched `REMOVED` emits `spec_merge.removed_target_not_found` and continues.
- `ADDED` identifier collision emits `spec_merge.duplicate_added_identifier` and skips that requirement block.
- Missing identifier in `MODIFIED` emits `spec_merge.modified_missing_identifier`.
- Missing identifier in `REMOVED` emits `spec_merge.removed_missing_identifier`.
- `RENAMED` sections emit `spec_merge.rename_unsupported`.
- Pre-section content in a delta spec emits `spec_merge.pre_section_content` per item.
- Delta-only capability allows `ADDED` output and emits errors for `MODIFIED`/`REMOVED`.
- Merged output ordering is deterministic: base order preserved, adds appended in delta order, modified blocks replaced in place.
- Standalone scenario in any delta section emits `spec_merge.standalone_scenario_unsupported` and is excluded.
- Duplicate canonical identifier in finalized base spec emits `spec_merge.duplicate_base_identifier`; first occurrence survives, later duplicates are excluded from output and matching.
- `RENAMED` in a delta-only capability still emits `spec_merge.rename_unsupported` and does not affect output.
- Duplicate canonical identifier within the same delta operation section emits `spec_merge.duplicate_delta_identifier`; all conflicting blocks in that group are excluded.
- Capability with zero surviving merged requirements emits `spec_merge.empty_capability_skipped` and is omitted from downstream specs-forward phases.
- `MODIFIED` replacement that would introduce an identifier collision outside the replaced block emits `spec_merge.duplicate_modified_identifier`, skips the replacement, and preserves the original base block.
- Requirement and scenario identifier collisions are checked in separate namespaces.

### Merge Safety Property Tests
- No base requirement block is removed without either a matching `REMOVED` operation or a surfaced duplicate-base exclusion finding.
- No item in the merged output lacks provenance traceable to a source file.
- Every skipped requirement-block merge operation produces exactly one finding, and every malformed standalone delta item produces exactly one finding.
- `Claim.capability` is populated for all claims extracted from merged specs.
- Merge findings are appended before downstream phases and remain visible in final run output.
- A merge failure or finding in one capability does not change another capability's merged output.
- Approximate or case-variant delta headings do not alter merge semantics.

### Liveness Verification Tests
- Every non-empty merged capability (at least one surviving requirement) is submitted to claim extraction, coverage analysis, and logical analysis exactly once.
- The count of capabilities analyzed by the specs-forward logic phase equals the count of non-empty merged capabilities.
- No non-empty merged capability is silently omitted from downstream processing.

### Pipeline And Logical-Analysis Tests
- Merged capability produces one specs-forward logical-analysis group per capability.
- Contradiction across base plus delta items within one capability is detected in one logic run.
- Removed requirements no longer participate in logical analysis.
- Modified requirements appear only in their delta version in logical analysis.
- Logical-analysis artifacts are written under the synthetic `logicalFile` key rather than separate base and delta file paths.
- `Claim.capability` is used for downstream grouping instead of `claim.provenance.file`.
- Coverage analysis consumes merged capability specs and excludes removed requirements.
- Non-spec claims are excluded from the capability-grouped specs-forward logic path.
- Sanitized `logicalFile` collisions abort the pipeline before artifact writes.
- Capability with zero merged requirements is skipped from downstream specs-forward phases with `spec_merge.empty_capability_skipped`.

### Evidence Expectations
- Unit and integration tests must be tagged or documented so each major scenario and invariant is traceable to the spec.
- Any Alloy-backed capability models affected by the merge phase must be updated so the executable/formal artifacts agree with the revised pipeline semantics.
- The change must preserve deterministic outputs across repeated runs for parser, merge, coverage, and logic-grouping evidence.
- Any counterexample or bug discovered during implementation must become a permanent regression test.

### Property-Based Testing
- Property-based tests must generate random valid base+delta combinations and verify the following invariants hold across at least 100 generated inputs:
  - **Determinism**: the same generated base+delta inputs produce identical merged outputs across 3 repeated invocations.
  - **No silent discard**: every base requirement block appears in the merged output OR is targeted by a REMOVED operation OR has a corresponding exclusion finding.
  - **No phantom introduction**: every item in the merged output has provenance traceable to either the base or delta input.
  - **Provenance preservation**: no merged requirement or scenario has modified `provenance.file` or `provenance.line` relative to its source.
  - **Finding completeness**: every skipped operation produces exactly one finding.
- The test generator must produce structurally valid inputs covering: empty base, non-empty base with identifiers, delta with ADDED/MODIFIED/REMOVED sections, duplicate identifiers, and mixed operations.

### Determinism Verification Criteria
- Determinism tests must run at least 3 repeated invocations with identical inputs and assert byte-for-byte identical merged outputs and findings arrays.
- Since `mergeSpecsByCapability()` is pure and synchronous with no Map iteration for output ordering (ordering is defined by explicit rules), hash-map ordering sensitivity does not apply. The determinism tests verify the implementation correctly follows the explicit ordering rules.
- Determinism must be verified for: merged requirement order, merged scenario order, findings order, and capability output order.

## Documentation Updates

The merge layer inserts a new phase between parsing and claim graph construction. Documentation that describes pipeline flow, data model, phase contracts, or per-file behavior must be updated.

### `docs/design.md`
- Insert a `per-capability merge` node into the main pipeline flowchart between structured parsing and claim-graph construction.
- Add a component row describing the merge phase, its responsibilities, inputs, outputs, and findings.
- Update the source-of-truth description so active capability behavior is defined by finalized-plus-selected-delta merge semantics rather than by side-by-side file analysis.
- Add a merged-spec conceptual entity and relationships from parsed documents to merged capability views to claims.
- Clarify that claim extraction operates on merged specs.
- Add merge determinism and active-capability-view invariants to the design invariants table.
- Update per-phase contracts, state machines, sequence diagrams, repository layout, and specs-forward summaries to show the merge phase and the new `src/domain/parser/merge.ts` module.

### `ARCHITECTURE.md`
- Insert the merge phase between parsing and normalization/claim-graph analysis in the pipeline overview.
- Update phase grouping around `run-cli.ts` so the merge phase is explicit.
- Revise the parser/catalog and parsed-model sections so claim graph is no longer described as the direct hinge between parsing and analysis.

### `README.md`
- Update the `src/domain/` directory listing to mention the merge module.
- Update feature overview wording so specs-forward analysis is described as operating on merged per-capability views when active deltas exist.

### Alloy Models And Capability Specs
- Update embedded Alloy models and state-machine descriptions in affected capability specs to reflect merged-capability behavior, active-capability grouping, and any new invariants introduced by the merge phase.

### Documentation That Does Not Need Changes
- `docs/state_machines.md`
- `docs/spec_traceability.md`
- `docs/lfm.md`
- `docs/typescript_style.md`

## Summary

This change aligns the analysis model with the OpenSpec authoring model: one merged active specification per capability. It does so while preserving original provenance, surfacing all malformed or unsupported delta behavior explicitly, enforcing deterministic grouping and artifact naming, and requiring verification evidence consistent with the lightweight formal methods workflow in `docs/lfm.md` and the implementation discipline in `docs/typescript_style.md`.
