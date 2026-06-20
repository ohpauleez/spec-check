## Context

### Current State
The current pipeline resolves active capability documents correctly at catalog time, but downstream spec analysis remains file-oriented. Parsing produces one `ParsedSpec` per input file, requirements and scenarios are stored as flat arrays, claim extraction iterates parsed specs independently, coverage infers capability identity from source file paths, and solver grouping batches claims by `claim.provenance.file`.

This means the active capability state chosen by catalog resolution is not preserved into analysis. A finalized capability spec and its selected delta spec can both be present in the run, yet the logic layer still sees them as independent spec groups.

### Constraints And Architecture Drivers
- Preserve deterministic behavior across parsing, merging, grouping, and artifact naming.
- Preserve original provenance on source requirements, scenarios, and derived claims.
- Keep parser responsibilities structural and keep merge semantics in a dedicated domain step.
- Reuse existing capability concepts where possible instead of introducing redundant lookup layers.
- Continue surfacing malformed input as findings rather than as hard aborts, except where merge failure would make artifact output unsafe.
- Follow the lightweight formal methods workflow in `docs/lfm.md`: explicit properties, direct evidence, executable/formal artifacts kept aligned with implementation, and no self-certifying fallback behavior.
- Require the implementation to follow `docs/typescript_style.md`, especially deterministic cores, explicit invariants, bounded control flow, and evidence-producing tests.

## Goals

- Introduce a capability-merge phase that converts resolved finalized-plus-delta spec inputs into one active merged capability view per capability.
- Feed the same merged capability view into claim extraction, coverage analysis, and logic grouping.
- Keep parser diagnostics and qualitative review anchored to raw parsed files in the first pass.
- Make merge behavior explicit, deterministic, testable, and documented.

### Non-Goals
- Full rename application semantics for `RENAMED` sections.
- Scenario-only delta operations outside requirement-block replacement.
- Qualitative-pass migration to merged inputs.
- Any archive policy or multi-delta policy change.
- Silent compatibility fallback to pre-merge file grouping.

## Proposed Design

### System Model

```mermaid
flowchart LR
  A[Catalog Documents] --> B[parseAllDocuments]
  B --> C[ParsedSpec[]]
  C --> D[mergeSpecsByCapability]
  D --> E[MergedCapabilitySpec[]]
  C --> F[Parser Findings]
  E --> G[buildClaimGraph]
  E --> H[analyzeCoverage]
  G --> I[Formalization]
  I --> J[Representative Claims]
  J --> K[Group by capability/logicalFile]
  K --> L[runLogicAnalysis]
```

The design inserts one new pure domain transformation after parsing and before specs-forward analysis. Raw parsed specs remain available for parser findings and qualitative review; merged capability specs become the analysis truth for claim extraction, coverage, and logic.

### Component Descriptions
- **Parser enrichment**: Adds explicit `deltaOperation` metadata to parsed requirements and scenarios, plus scenario-parent association.
- **Merge layer**: Groups parsed specs by capability and applies finalized-plus-delta merge semantics to produce `MergedCapabilitySpec` outputs and merge findings.
- **Claim extraction update**: Consumes merged capability specs and populates `Claim.capability` while preserving original claim provenance.
- **Coverage update**: Consumes merged capability specs so proposal-to-spec checks and downstream requirement coverage operate on the active capability view.
- **Logic grouping update**: Groups formalized spec-derived claims by capability and merged logical identity rather than raw source file paths.

### System Invariant Tactics
- Preserve `provenance.file` and `provenance.line` on parsed requirements and scenarios unchanged through merge output.
- Use a separate `logicalFile` synthetic identifier for merged grouping so artifact naming does not overload real filesystem provenance.
- Apply merge operations only at the requirement-block level to avoid partial scenario mutation ambiguity.
- Exclude unsupported or duplicate inputs only with surfaced `spec_merge.*` findings.
- Preserve catalog encounter order and document order explicitly so merged outputs remain deterministic.

### Quality Attribute Tactics
- **Determinism**: Use stable capability ordering from catalog encounter order, base-first merge order, and explicit duplicate-resolution rules.
- **Traceability**: Keep raw provenance on leaf items; use `Claim.capability` for grouping and `logicalFile` for report/evidence names.
- **Reliability**: Emit one merge finding per skipped requirement-block operation or malformed standalone item.
- **Correctness**: Feed one merged capability view into all specs-forward phases so logic and coverage reason over the same active state.
- **Safety**: Treat sanitized artifact-key collisions and unexpected internal merge failures as pipeline-aborting conditions.

### Interaction Protocols
- `parseAllDocuments()` must pass catalog `source` information into `parseSpec()` so item-level delta semantics can be assigned consistently.
- `mergeSpecsByCapability()` accepts catalog spec documents plus their corresponding parsed specs and returns ordered merged capability outputs.
- `buildClaimGraph()` accepts merged capability specs for the spec-derived portion of the graph and must populate `Claim.capability` on those claims.
- Coverage analysis consumes merged specs and the claim graph together; proposal, design, and task claims remain unchanged.
- Logic analysis continues accepting groups of claims plus a string grouping key, but that key becomes the merged capability `logicalFile` rather than a raw source path.

### Forward Evolution
- The merge layer creates a clean seam for later support of full rename application or scenario-level delta semantics.
- Preserving both raw parsed specs and merged capability specs allows later migration of qualitative review without changing parser diagnostics.
- Capability-based grouping can support future analysis passes that reason about one active capability state across multiple evidence types.

### Costs
- Additional domain complexity in parser metadata, merge logic, and test fixtures.
- Broader regression surface because parser types, claim extraction, coverage, and logic grouping all touch the change.
- Documentation and Alloy model updates are non-trivial because pipeline and domain diagrams must reflect the new phase.

### Alternatives Considered
- **Only regroup logic analysis by capability without merging parsed specs**: Rejected because stale base requirements, removed requirements, and duplicate modified requirements would still enter the claim set.
- **Fold merge semantics into the parser**: Rejected because parser responsibilities would become semantic and cross-document rather than structural and file-local.
- **Replace provenance with merged synthetic provenance**: Rejected because it would destroy source traceability for findings and evidence.

## Component Design

### Key Components
- **`ParsedRequirement` / `ParsedScenario` model changes**: Add required `deltaOperation`; add optional `parentRequirementIdentifier` to scenarios.
- **`MergedCapabilitySpec`**: New domain type containing `capability`, ordered `sourceFiles`, synthetic `logicalFile`, merged `requirements`, merged `scenarios`, and `findings`.
- **`mergeSpecsByCapability()`**: New synchronous domain helper, under `src/domain/parser/merge.ts`, responsible for grouping, matching, application, and merge findings.
- **Pipeline context expansion**: Analysis helpers need access to merged capability specs in addition to raw parsed specs.

### Data Design
- `DeltaOperation` domain: `"base" | "pre-section" | "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED"`.
- `"pre-section"` is assigned to items in a delta spec that appear before the first delta heading. These items are structurally invalid and the merge layer emits `spec_merge.pre_section_content` for each and excludes them.
- Parsed finalized specs always assign `deltaOperation: "base"`, even if malformed delta headings appear.
- Parsed delta specs assign delta-operation context from exact section headings only.
- `parentRequirementIdentifier` records the most recently parsed requirement identifier when a scenario is encountered; it is `undefined` when no parent requirement identifier exists. Scenario-to-requirement grouping is positional: the parser assigns each scenario to the most recently parsed requirement regardless of whether that requirement has an identifier. Scenarios move with their enclosing requirement block as a unit during all merge operations.
- `ParsedSpec.deltaSections` remains present as a file-level summary even though per-item `deltaOperation` is added, because section-presence reporting is still useful even when a section contains no parseable items.
- `MergedCapabilitySpec.logicalFile` format: `<merged-spec/{capability}>` where angle brackets are literal characters and `{capability}` is the literal `CapabilityName` value (e.g., `<merged-spec/catalog-and-parse>`). The value contains only ASCII characters: `<`, `>`, `-`, `/`, and lowercase alphanumeric.
- Requirement and scenario identifiers remain separate namespaces for collision detection.
- Merge application unit is one requirement block plus all associated scenarios.

### Parser Contract
- `parseSpec(file, source)` remains file-local and performs no cross-document merge.
- `source` is explicit and is one of `"final" | "delta"`.
- The parser tracks the current delta section heading for delta inputs only.
- Delta heading recognition is exact-text only: `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`, and `## RENAMED Requirements`.
- No additional case folding or whitespace normalization is applied beyond existing line handling.
- In finalized specs, delta headings are recorded as ignored malformed structure and do not alter item semantics.
- Requirements and scenarios parsed before the first delta heading in a delta spec receive `deltaOperation: "pre-section"` to signal structurally invalid placement for deterministic merge-layer exclusion.
- A scenario parsed before any requirement block in a delta section remains available for diagnostics and later `spec_merge.standalone_scenario_unsupported` emission.

### Merge Contract
- `mergeSpecsByCapability(catalogDocs, parsedSpecs)` is pure and synchronous.
- Correlation: each parsed spec is matched to its catalog document by file path. The catalog document provides `source` (`"final"` or `"delta"`) and `capability` classification.
- Input preconditions:
  - every parsed spec has a corresponding catalog document with `type: "spec"` and a defined capability
  - catalog resolution has already selected at most one delta per capability
- Runtime assertion: `mergeSpecsByCapability()` validates at entry that no capability has more than one delta spec in the input. Violation is an assertion failure that propagates as a fatal pipeline exception (consistent with the graceful degradation strategy for internal errors).
- Output postconditions:
  - one `MergedCapabilitySpec` per capability in catalog encounter order
  - merged requirement and scenario sets reflect the active capability state after delta application
  - merge findings are non-fatal unless an unexpected internal merge error or artifact-key collision makes continuation unsafe
  - duplicate base requirement blocks excluded due to `spec_merge.duplicate_base_identifier` do not appear in output and cannot be matched later

### Merge Semantics By Operation

#### Operation Application Order

Delta operations are applied in a defined logical sequence:

1. **REMOVED** operations are applied first. Each matched base requirement block and its nested scenarios are deleted from the working state.
2. **MODIFIED** operations are applied second. Each matched base requirement block is replaced with the delta replacement block. Collision checking operates against the working state after all REMOVED operations, excluding the matched block being replaced.
3. **ADDED** operations are applied last. New requirement blocks are appended. Collision checking operates against the fully projected state (base minus REMOVED targets, with MODIFIED replacements applied).

Within each operation group, application order is irrelevant because duplicate-delta-identifier checking within the same section ensures each operation targets a distinct base block.

The term "surviving merged requirements" in collision checking refers to the projected final state: the base requirement set after all REMOVED deletions and all MODIFIED replacements have been applied.

#### Base Initialization
- Finalized spec present: initialize merged output from finalized requirements and scenarios.
- Delta-only capability: initialize from empty base.
- Delta-only `MODIFIED` and `REMOVED` operations emit `spec_merge.modified_target_not_found` and `spec_merge.removed_target_not_found` respectively and are skipped.
- Delta-only `RENAMED` sections still emit `spec_merge.rename_unsupported` warnings.

#### `ADDED`
- Add a new requirement block and all nested scenarios.
- Requirement and scenario collisions are checked in separate namespaces.
- A requirement identifier collision with a surviving merged requirement emits `spec_merge.duplicate_added_identifier` and skips the whole block. The finding message identifies the colliding identifier and states the collision is in the requirement namespace.
- A nested scenario identifier collision with a surviving merged scenario emits `spec_merge.duplicate_added_identifier` and skips the whole block. The finding message identifies the colliding identifier and states the collision is in the scenario namespace.
- Unidentified items are added without collision checking.

#### `MODIFIED`
- Full replacement semantics: replace the matched base requirement and all nested scenarios with the delta block.
- Match by canonical requirement identifier.
- Missing identifier emits `spec_merge.modified_missing_identifier`.
- No matching base target emits `spec_merge.modified_target_not_found`.
- A replacement that would collide with a surviving identifier outside the matched block emits `spec_merge.duplicate_modified_identifier`, skips the replacement, and preserves the original base block.

#### `REMOVED`
- Remove the matched base requirement and all nested scenarios.
- Entries may be sparse, but identifier presence is mandatory.
- Missing identifier emits `spec_merge.removed_missing_identifier`.
- No matching target emits `spec_merge.removed_target_not_found`.

#### `RENAMED`
- Rename application is deferred.
- Emit exactly one `spec_merge.rename_unsupported` warning per delta spec file that contains one or more rename sections.
- Rename sections do not mutate merged output.

#### Standalone Scenarios And Pre-Section Content
- Standalone scenarios in any delta section (not associated with any requirement block by positional parsing) emit `spec_merge.standalone_scenario_unsupported` and are excluded. These are structural input errors that receive defined error handling; standalone scenario-level delta operations are not supported in the first pass.
- Pre-section requirements or scenarios in a delta spec (those with `deltaOperation: "pre-section"`) emit `spec_merge.pre_section_content` per item and are excluded.

#### Duplicate Handling
- Finalized base duplicate canonical identifiers emit `spec_merge.duplicate_base_identifier` for each occurrence after the first; later duplicates are excluded from merged output and matching.
- Duplicate canonical identifiers within the same delta operation section emit `spec_merge.duplicate_delta_identifier`; all conflicting blocks in that duplicate group are excluded.

#### Empty Capability Handling
- If a capability has zero surviving merged requirements after exclusions and removals, emit `spec_merge.empty_capability_skipped`.
- Omit that capability from downstream specs-forward claim extraction, logic analysis, and coverage.

### Ordering Contract
- Base requirements remain in original order, minus removals, with modifications replaced in place.
- Added requirements append after surviving base requirements in delta-document order.
- Base scenarios remain in original order, minus removals, with modified nested scenarios replaced in place.
- Added nested scenarios append in delta-document order.
- Outer merged capability ordering preserves first-seen catalog order and performs no additional lexicographic sorting.

### Worked Example

**Finalized base spec** (`openspec/specs/auth-session/spec.md`):

| # | Requirement | Identifier | Scenarios |
|---|---|---|---|
| 1 | Session tokens expire after 30 minutes | `AUTH-EXPIRE-1` | `AUTH-EXPIRE-1-S1` |
| 2 | Sessions are invalidated on password change | `AUTH-INVALIDATE-1` | `AUTH-INVALIDATE-1-S1`, `AUTH-INVALIDATE-1-S2` |
| 3 | Concurrent session limit is 5 | `AUTH-LIMIT-1` | (none) |

**Active delta spec** (`openspec/changes/my-change/specs/auth-session/spec.md`):

```markdown
## REMOVED Requirements
### [AUTH-LIMIT-1] Concurrent session limit is 5

## MODIFIED Requirements
### [AUTH-EXPIRE-1] Session tokens expire after 15 minutes
#### Scenario: [AUTH-EXPIRE-1-S1] Token expires and user is redirected
(updated scenario body)
#### Scenario: [AUTH-EXPIRE-1-S2] Expired token cannot access protected resource
(new scenario under modified requirement)

## ADDED Requirements
### [AUTH-REFRESH-1] Refresh tokens extend session without re-authentication
#### Scenario: [AUTH-REFRESH-1-S1] Valid refresh token issues new session token
```

**Merge application (REMOVED → MODIFIED → ADDED)**:

1. REMOVED: `AUTH-LIMIT-1` and its scenarios are deleted from base.
2. MODIFIED: `AUTH-EXPIRE-1` and its scenario `AUTH-EXPIRE-1-S1` are replaced with the delta version (new title, updated `AUTH-EXPIRE-1-S1`, and new `AUTH-EXPIRE-1-S2`).
3. ADDED: `AUTH-REFRESH-1` and `AUTH-REFRESH-1-S1` are appended.

**Merged output** (requirements in order):

| # | Requirement | Identifier | Source | Scenarios |
|---|---|---|---|---|
| 1 | Session tokens expire after 15 minutes | `AUTH-EXPIRE-1` | delta (modified) | `AUTH-EXPIRE-1-S1`, `AUTH-EXPIRE-1-S2` |
| 2 | Sessions are invalidated on password change | `AUTH-INVALIDATE-1` | base (unchanged) | `AUTH-INVALIDATE-1-S1`, `AUTH-INVALIDATE-1-S2` |
| 3 | Refresh tokens extend session without re-authentication | `AUTH-REFRESH-1` | delta (added) | `AUTH-REFRESH-1-S1` |

**Findings**: none (all operations matched valid targets, no collisions).

**Provenance**: each requirement and scenario retains `provenance.file` pointing to either the base or delta file. The merged capability uses `logicalFile: "<merged-spec/auth-session>"` for artifact naming and grouping.

### Provenance And Grouping Contract
- The merge layer must never rewrite `provenance.file` or `provenance.line` on requirements or scenarios.
- Claim extraction from merged specs must set `Claim.capability` for all spec-derived claims.
- Specs-forward logic groups claims by `Claim.capability` and uses `MergedCapabilitySpec.logicalFile` as the artifact-naming and reporting key.
- Non-spec claims remain part of the broader claim graph but are excluded from the capability-grouped specs-forward logical-analysis path after this change.

### Artifact-Key Contract
- `logicalFile` is a logical identifier only and must not be used directly as a filesystem path.
- Any derived artifact-path key must sanitize the logical identifier using the following algorithm:
  1. Strip the leading `<` and trailing `>` characters.
  2. Replace all `/` characters with `-`.
  3. The result is the sanitized artifact key (e.g., `<merged-spec/catalog-and-parse>` becomes `merged-spec-catalog-and-parse`).
- This algorithm is safe against path traversal because capability names are constrained to `[a-z0-9-]+` by `inferCapabilityName()`, which excludes all path-sensitive characters.
- Sanitized artifact keys must be unique across all merged capabilities in a run.
- A sanitized-key collision is fatal and must abort the pipeline before any artifact write occurs.

### Code Map
- `src/domain/model.ts`: add `DeltaOperation`, enrich parsed models, add `MergedCapabilitySpec`.
- `src/domain/parser/spec.ts`: add source-aware parsing and item-level delta metadata.
- `src/cli/pipeline-helpers.ts`: pass parser source context, invoke merge phase, route merged specs to claim graph and coverage, and emit merge findings before downstream phases.
- `src/cli/pipeline-types.ts`: carry merged capability specs through analysis context.
- `src/domain/parser/merge.ts`: new merge implementation.
- `src/domain/claim-graph.ts`: accept merged spec inputs and populate `Claim.capability`.
- `src/domain/spec-forward/coverage.ts`: switch capability/file checks from raw file-local specs to merged capability specs.
- `src/cli/run-cli.ts` and `src/domain/formal/logic-analysis.ts`: use capability/logicalFile grouping for specs-forward logic.
- `docs/design.md`, `ARCHITECTURE.md`, `README.md`, and affected Alloy-backed capability specs: update pipeline and domain descriptions.

## Failure And Reliability

### Failure Mode Analysis
- **Unsafe inputs**: delta files with missing identifiers, unsupported standalone scenarios, or pre-section content can create ambiguous semantics.
- **Fragile formats**: exact delta headings are intentional; near-miss headings must remain ordinary content to avoid accidental semantic reinterpretation.
- **Inadequate control actions**: replacing grouping logic without replacing claim inputs would still let stale base content through.
- **Process model flaws**: using capability identity inferred from source paths in one phase and merged capability identity in another could reintroduce split-brain analysis.
- **Coordination failures**: merge findings must be emitted before formalization and logic so downstream phases see the correct merged-capability set.

### Control And Recovery
- Detect malformed delta operations during merge and emit one explicit finding per skipped operation.
- Detect duplicate base or delta identifiers before they influence future matching.
- Preserve the original base block when a `MODIFIED` replacement would introduce collisions.
- Skip downstream analysis for capabilities with zero surviving merged requirements after emitting a warning.
- Abort the pipeline on sanitized artifact-key collisions or unexpected internal merge exceptions rather than silently falling back.

## Operational Concerns

### Observability
- Merge findings use the dedicated `spec_merge.*` namespace so reports clearly distinguish parser findings from merge semantics.
- Report provenance continues pointing to original source files for item-level issues and uses the merged logical key only for capability-level artifacts.
- Documentation identifies the merge phase explicitly in pipeline diagrams and per-phase contracts.

### Deployment And Rollout
- Land the merge layer and downstream routing together; partial rollout would produce inconsistent analysis semantics.
- Keep qualitative review on raw parsed specs in the first pass to minimize blast radius while the merge layer stabilizes.
- Use the new parser, merge, pipeline, determinism, and artifact-key tests as rollout gates.

### Capacity And Scaling
- The merge layer is pure in-memory computation over already parsed specs, so its cost is linear in requirements and scenarios per capability.
- Grouping by capability may slightly reduce solver invocations when base and delta files previously ran separately.
- Additional collision checks add bounded set-lookup overhead relative to existing pipeline costs.

## Security

No new authentication or authorization concerns are introduced. The main safety issue is integrity of persisted solver evidence: merged artifact keys must be deterministic and collision-free after sanitization so one capability cannot overwrite another capability's outputs.

## Risks / Trade-offs

- [Raw specs and merged specs coexist in the first pass] -> Limit merged routing to specs-forward phases and document clearly that qualitative review remains file-local.
- [Parser type changes force wide fixture churn] -> Treat fixture updates as a dedicated mechanical task and keep the new fields simple and explicit.
- [Synthetic logical IDs could be reused accidentally as paths] -> Specify that `logicalFile` is a logical key only and validate/sanitize path derivation centrally.
- [First-pass rename handling is incomplete] -> Emit `spec_merge.rename_unsupported` warnings rather than pretending renames were applied.

## Migration Plan

1. Enrich parsed spec types and parsing logic with source-aware delta metadata.
2. Add the merge helper and its tests.
3. Integrate merged capability specs into pipeline context and emit merge findings.
4. Switch claim extraction, coverage, and logic grouping to merged capability inputs.
5. Update docs, Alloy models, and downstream tests.
6. Roll back by reverting the change set as a unit if merged routing causes regressions; do not leave partially migrated grouping behavior in place.

## Verification Strategy

The verification strategy for this change is intentionally detailed because the project follows the lightweight formal methods workflow in `docs/lfm.md`. The implementation is not considered complete merely because the code compiles; it must produce direct evidence that the new merge semantics preserve the stated invariants and pipeline contracts. The implementation and its tests must also follow the design and implementation discipline required by `docs/typescript_style.md`.

### Parser Verification
- Tests for exact heading recognition and exact mapping to `deltaOperation` values.
- Tests for `parentRequirementIdentifier` behavior for normal and malformed scenario placement.
- Tests showing finalized specs always emit `deltaOperation: "base"` even if malformed delta headings appear.
- Tests showing pre-section delta content receives `deltaOperation: "pre-section"` for deterministic exclusion by the merge layer.

### Merge Verification
- Unit tests for finalized-only, delta-only, `ADDED`, `MODIFIED`, `REMOVED`, and deferred `RENAMED` behavior.
- Tests for duplicate-base handling, duplicate-delta handling, and duplicate-introduced-by-modification handling.
- Tests for standalone scenarios, pre-section content, empty-capability skip behavior, and deterministic ordering.
- Repeated-run determinism checks for merged outputs and findings.

### Determinism Verification
- Determinism tests must run at least 3 repeated invocations with identical inputs and assert byte-for-byte identical merged outputs and findings arrays.
- Since `mergeSpecsByCapability()` is pure and synchronous with explicit ordering rules (no Map iteration for output ordering), hash-map ordering sensitivity does not apply.
- Determinism must be verified for: merged requirement order, merged scenario order, findings order, and capability output order.

### Property-Based Testing
- Property-based tests must generate random valid base+delta combinations and verify the following invariants hold across at least 100 generated inputs:
  - **Determinism**: the same generated inputs produce identical merged outputs across 3 repeated invocations.
  - **No silent discard**: every base requirement block appears in the merged output OR is targeted by a REMOVED operation OR has a corresponding exclusion finding.
  - **No phantom introduction**: every item in the merged output has provenance traceable to either the base or delta input.
  - **Provenance preservation**: no merged requirement or scenario has modified `provenance.file` or `provenance.line` relative to its source.
  - **Finding completeness**: every skipped operation produces exactly one finding.
- The test generator must produce structurally valid inputs covering: empty base, non-empty base with identifiers, delta with ADDED/MODIFIED/REMOVED sections, duplicate identifiers, and mixed operations.

### Safety And Property Verification
- Tests for provenance preservation.
- Tests for exactly-one-finding-per-skipped-operation behavior.
- Tests for capability isolation so one capability's failures do not affect another capability.
- Tests showing non-fuzzy exact identifier matching and exact heading recognition.

### Liveness Verification
- Tests that every non-empty merged capability (at least one surviving requirement) is submitted to claim extraction, coverage analysis, and logical analysis exactly once.
- Tests that the count of capabilities analyzed by specs-forward logic equals the count of non-empty merged capabilities.
- Tests that no non-empty merged capability is silently omitted from downstream processing.

### Pipeline Verification
- Integration tests showing one specs-forward logic group per capability.
- Integration tests showing contradictions across base-plus-delta content are detected within a single logic run.
- Integration tests showing removed requirements disappear from downstream logic and coverage.
- Integration tests showing modified requirements appear only in modified form.
- Tests showing `Claim.capability` drives grouping rather than `claim.provenance.file`.
- Tests showing logical artifacts are keyed by sanitized `logicalFile`.
- Tests showing sanitized key collisions abort before artifact writes.
- Tests showing non-spec claims are excluded from capability-grouped specs-forward logic.

### Evidence And Artifact Verification
- Update or add Alloy-backed capability artifacts so they reflect merged capability semantics.
- Review documentation updates for consistency with implementation and tests.
- Capture verification evidence in a form suitable for archive so future readers can trace scenarios, invariants, and outcomes.

## Documentation Updates

### `docs/design.md` (heavy impact)
1. Insert a `per-capability merge` node between structured parsing and claim-graph construction in the main pipeline flowchart.
2. Add a merge component row describing responsibilities, inputs, outputs, and findings.
3. Update the source-of-truth discussion for capability behavior so the active capability state is defined by finalized-plus-delta merge semantics.
4. Add a `MergedSpec` or merged-capability entity to the conceptual ER/domain model.
5. Update the domain-entity and conceptual-relationship sections so claim extraction operates on merged specs.
6. Add merge determinism and merged-active-view invariants to the invariants table.
7. Add a merge phase row to per-phase contracts with preconditions, postconditions, and non-fatal finding behavior.
8. Update ingestion/specs-forward state-machine and sequence diagrams to include merge between parsing and claim-graph construction.
9. Update repository layout and pipeline summary tables to mention `src/domain/parser/merge.ts`.

### `ARCHITECTURE.md` (moderate impact)
1. Insert merge between parsing and normalization/claim-graph analysis in the overview diagram.
2. Update `run-cli.ts` phase grouping so merge is explicit.
3. Revise parsed-model and parser/catalog descriptions so claim graph is no longer described as the direct hinge between parsing and analysis.
4. Mention per-capability merge before analysis begins.

### `README.md` (light impact)
1. Update the `src/domain/` directory listing to mention the merge module.
2. Update feature overview wording so specs-forward analysis is described as operating on merged capability views when active deltas are present.

### Alloy Models
- Update embedded Alloy models within affected capability specs so the executable/formal artifacts match the new merge behavior, active capability view, and state transitions introduced by the merge phase.

### Files Not Requiring Changes
- `docs/state_machines.md`
- `docs/spec_traceability.md`
- `docs/lfm.md`
- `docs/typescript_style.md`

## Open Questions

- Should a later change move qualitative review onto merged capability specs as well, or should it remain intentionally file-local?
- When rename semantics are implemented in the future, should they operate only on requirement titles or also on scenario and identifier lineage?
- Should capability identity be made explicit in more downstream types to eliminate remaining path-based inference entirely?
