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
- **Merged Capability Spec**: The active capability view produced from zero or one finalized parsed spec plus zero or one selected delta parsed spec. This is not a filesystem document; it is a logical analysis view with a synthetic identity for grouping and artifact naming.
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

## Preconditions, Postconditions, and Invariants

### Preconditions
- Each parsed spec participating in merging has a corresponding catalog document with `type: "spec"` and a defined capability.
- Catalog resolution has already selected at most one active delta per capability.
- Delta matching relies on canonical identifiers where modification or removal semantics require a target.

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
- **Termination**: the merge layer always terminates and produces a result for every capability in the input. It is synchronous, performs no I/O, and cannot loop or block.
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

## Summary

This change aligns the analysis model with the OpenSpec authoring model: one merged active specification per capability. It does so while preserving original provenance, surfacing all malformed or unsupported delta behavior explicitly, enforcing deterministic grouping and artifact naming, and requiring verification evidence consistent with the lightweight formal methods workflow in `docs/lfm.md` and the implementation discipline in `docs/typescript_style.md`.
