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

#### `DeltaOperation` Domain

```ts
type DeltaOperation = "base" | "pre-section" | "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED";
```

- `"pre-section"` is assigned to items in a delta spec that appear before the first delta heading. These items are structurally invalid and the merge layer emits `spec_merge.pre_section_content` for each and excludes them.
- Parsed finalized specs always assign `deltaOperation: "base"`, even if malformed delta headings appear.
- Parsed delta specs assign delta-operation context from exact section headings only.

#### Scenario-Parent Association

- `parentRequirementIdentifier` records the most recently parsed requirement identifier when a scenario is encountered; it is `undefined` when no parent requirement identifier exists.
- Scenario-to-requirement grouping is positional: the parser assigns each scenario to the most recently parsed requirement regardless of whether that requirement has an identifier. Scenarios move with their enclosing requirement block as a unit during all merge operations.

#### `ParsedSpec.deltaSections`

`ParsedSpec.deltaSections` remains present as a file-level summary even though per-item `deltaOperation` is added, because section-presence reporting is still useful even when a section contains no parseable items.

#### `MergedCapabilitySpec` Fields

```ts
interface MergedCapabilitySpec {
  readonly capability: CapabilityName;
  readonly sourceFiles: readonly string[];
  readonly logicalFile: string;
  readonly requirements: readonly ParsedRequirement[];
  readonly scenarios: readonly ParsedScenario[];
  readonly findings: readonly Finding[];
}
```

Field specifications:

1. `capability`: branded `CapabilityName` value, inferred from the `specs/<capability-name>/spec.md` path segment by `inferCapabilityName()`. Domain: UTF-8 string, ASCII subset `[a-z0-9-]+`, case-sensitive logical key.
2. `sourceFiles`: absolute paths to the contributing base and/or delta files, in the order `[base, delta]` when both are present. Encoding: UTF-8 path strings as returned by `node:path.resolve()`.
3. `logicalFile`: a synthetic group key used for logical-analysis artifact naming and report provenance. Format: `<merged-spec/{capability}>` where `{capability}` is the value of the `capability` field. The angle brackets are literal characters. This value must never be dereferenced as a filesystem path for any read or stat operation.
4. `requirements`: the merged active requirement set after delta operations have been applied. Each requirement title/body is UTF-8 markdown text preserved from parser output without merge-layer rewriting.
5. `scenarios`: the merged active scenario set after delta operations have been applied. Each scenario title/body is UTF-8 markdown text preserved from parser output without merge-layer rewriting.
6. `findings`: merge-layer findings emitted during delta application for this capability.

Invariant: individual requirements and scenarios retain their original `provenance.file` pointing to the actual contributing base or delta file.

#### Encoding And String Handling

All text processing in the merge layer operates on UTF-8 decoded strings as produced by the parser. Specifically:

- Capability names are constrained to the ASCII subset `[a-z0-9-]+` by `inferCapabilityName()`. No Unicode normalization is relevant for capability identity.
- Canonical requirement and scenario identifiers are constrained to the ASCII subset `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+` by the parser. No Unicode normalization is relevant for identifier matching.
- Requirement titles and bodies are preserved as UTF-8 markdown text byte-for-byte from parser output. The merge layer performs no normalization, rewriting, or re-encoding of content.
- Identifier matching uses the bracket-stripped string value produced by the parser with no additional case folding or normalization.

#### Logical File Format

The `logicalFile` field uses the format `<merged-spec/{capability}>` where `{capability}` is the literal `CapabilityName` string value (e.g., `<merged-spec/catalog-and-parse>`).

Specification:

1. The angle brackets `<` and `>` are literal characters in the string value.
2. The value contains only ASCII characters: `<`, `>`, `-`, `/`, lowercase alphanumeric.
3. The value must never be used as a filesystem path for read, stat, or write operations on the local filesystem. It is a logical key only.
4. The value is used for:
   - SMT artifact subdirectory naming (the `sanitizedSpecId` derived from it for paths under `smt/`)
   - report markdown headings
   - finding provenance when the finding relates to the merged capability as a whole rather than a specific source line
5. Downstream code that derives filesystem paths from this value must sanitize it using the artifact-key sanitization algorithm specified below.

#### Artifact-Key Sanitization Algorithm

When downstream code derives a filesystem path from `logicalFile`, it must apply the following sanitization:

1. Strip the leading `<` and trailing `>` characters.
2. Replace all `/` characters with `-`.
3. The result is the sanitized artifact key (e.g., `<merged-spec/catalog-and-parse>` becomes `merged-spec-catalog-and-parse`).

This algorithm is safe against path traversal because capability names are constrained to `[a-z0-9-]+` by `inferCapabilityName()`, which excludes `.`, `/`, `\`, and all other path-sensitive characters. The sanitized result is guaranteed to match `[a-z-]+` after step 2.

The sanitized artifact key must be unique across all merged capabilities in a run. A collision is fatal and aborts the pipeline before any artifact write occurs. Given the current `CapabilityName` domain constraint (unique capability names derived from unique directory paths), a sanitized-key collision is impossible unless the capability naming invariant is violated upstream.

#### Identifier Namespaces

Requirement identifiers and scenario identifiers remain separate namespaces for collision detection. A requirement identifier does not collide with a scenario identifier merely because their text matches.

#### Merge Application Unit

Merge application unit is one requirement block plus all associated scenarios.

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

### Merge Semantics

#### Input Model

For each capability, the merge layer receives:
- zero or one finalized `ParsedSpec` (source `"final"`)
- zero or one active delta `ParsedSpec` (source `"delta"`)

Catalog resolution remains responsible for selecting at most one active delta per capability and surfacing conflicts before merge begins.

#### Matching Unit

One merge operation is one parsed requirement block plus all scenarios associated with that requirement.

Consequences:
- `ADDED`, `MODIFIED`, and `REMOVED` semantics apply only to requirement blocks.
- A skipped requirement-block operation emits exactly one merge finding.
- Standalone malformed items outside a requirement block are structural input errors and each emit their own finding.

#### Operation Application Order

Delta operations are applied in a defined logical sequence:

1. **REMOVED** operations are applied first. Each matched base requirement block and its nested scenarios are deleted from the working state.
2. **MODIFIED** operations are applied second. Each matched base requirement block is replaced with the delta replacement block. Collision checking for MODIFIED operates against the working state after all REMOVED operations have been applied, excluding the matched block being replaced.
3. **ADDED** operations are applied last. New requirement blocks are appended to the working state. Collision checking for ADDED operates against the fully projected state (base minus all REMOVED targets, with all MODIFIED replacements applied).

Within each operation group (e.g., multiple REMOVED blocks), the order of application is irrelevant because:
- Each operation targets a distinct base block (enforced by duplicate-delta-identifier checking within the same section).
- No operation within a group can affect another operation within the same group.

The term "surviving merged requirements" used in collision checking refers to the projected final state: the base requirement set after all REMOVED deletions and all MODIFIED replacements have been applied.

#### Matching Rules

- Matching is requirement-block only.
- Matching uses canonical identifiers.
- Matching is case-sensitive.
- Matching uses the bracket-stripped identifier value produced by the parser.
- The canonical identifier format is `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`.
- The merge layer performs no additional normalization of identifiers, titles, or bodies.
- Titles and bodies are treated as UTF-8 markdown text and preserved byte-for-byte from parser output.

#### Base Initialization

- If a finalized spec exists, its requirements and scenarios form the initial base.
- If no finalized spec exists but a delta exists (delta-only capability), the initial base is empty.
- In a delta-only capability, `ADDED` operations produce the merged output. `MODIFIED` and `REMOVED` operations each emit an error finding (`spec_merge.modified_target_not_found` / `spec_merge.removed_target_not_found`) and are skipped, because there is no base item to modify or remove.
- `RENAMED` sections in delta-only capabilities still emit `spec_merge.rename_unsupported` warnings and do not affect merged output.

#### `ADDED`

- Add new requirements and their nested scenarios to the merged output.
- If the added requirement identifier collides with a surviving merged requirement identifier, emit `spec_merge.duplicate_added_identifier` and skip the entire requirement block. The finding message must identify the colliding identifier value and state that the collision is in the requirement namespace.
- If any nested scenario identifier collides with a surviving merged scenario identifier, emit `spec_merge.duplicate_added_identifier` and skip the entire requirement block. The finding message must identify the colliding identifier value and state that the collision is in the scenario namespace.
- Items without identifiers are added without collision checking.
- Standalone scenarios in an `ADDED` section that are not associated with any requirement block emit `spec_merge.standalone_scenario_unsupported` and are excluded. These are structural input errors that receive defined error handling; standalone scenario-level delta operations are not supported in the first pass.

#### `MODIFIED`

- A `MODIFIED` requirement block fully replaces the matched base requirement and all of that base requirement's nested scenarios.
- Matching requires a canonical identifier on the delta requirement.
- If the delta requirement has no identifier, emit `spec_merge.modified_missing_identifier` and skip the operation.
- If no matching base requirement exists, emit `spec_merge.modified_target_not_found` and skip the operation.
- Before replacement, validate that the replacement requirement identifier does not collide with another surviving merged requirement outside the matched base block, and that replacement scenario identifiers do not collide with surviving merged scenarios outside the matched block.
- If such a collision would be introduced, emit `spec_merge.duplicate_modified_identifier`, skip the replacement, and preserve the original base block unchanged.
- Standalone scenarios in a `MODIFIED` section that are not associated with any requirement block emit `spec_merge.standalone_scenario_unsupported` and are excluded.

#### `REMOVED`

- A `REMOVED` requirement block deletes the matched base requirement and all of its nested scenarios.
- Removed entries may be sparse and need not reproduce the full body, but an identifier is required.
- If the delta requirement has no identifier, emit `spec_merge.removed_missing_identifier` and skip the operation.
- If no matching base requirement exists, emit `spec_merge.removed_target_not_found` and skip the operation.
- Standalone scenarios in a `REMOVED` section that are not associated with any requirement block emit `spec_merge.standalone_scenario_unsupported` and are excluded.

#### `RENAMED`

- Full rename application is deferred in the first implementation.
- Emit one `spec_merge.rename_unsupported` warning per delta spec file when that file contains one or more `RENAMED` sections.
- Rename sections do not transform the merged output.

#### Duplicate Handling

**Finalized base duplicates:**
- If duplicate canonical requirement identifiers exist within a single finalized base spec, emit `spec_merge.duplicate_base_identifier` for each duplicate occurrence after the first.
- The first base occurrence remains authoritative.
- Later duplicate base blocks are excluded from merged output and cannot be selected as future match targets.
- Rationale: finalized specs have a natural document order. The first occurrence is authoritative by convention, preserving deterministic behavior while surfacing the malformed duplicate.

**Delta section duplicates:**
- If duplicate canonical identifiers appear more than once within the same delta operation section for one capability, emit `spec_merge.duplicate_delta_identifier` for each conflicting block in that duplicate group.
- All conflicting duplicate blocks in that delta duplicate group are excluded from merge application.
- Rationale: delta blocks within the same section represent competing edits with no natural ordering authority. Excluding all conflicting blocks prevents arbitrary choice and surfaces the conflict for human resolution.

#### Pre-Section Content And Finalized Delta Headings

- If a delta spec contains requirements or scenarios before the first exact `## ADDED/MODIFIED/REMOVED/RENAMED Requirements` heading, those items receive `deltaOperation: "pre-section"`. The merge layer emits `spec_merge.pre_section_content` for each such item and excludes it from merge.
- If a finalized spec contains delta headings, emit at most one `spec_merge.finalized_spec_delta_heading_ignored` warning per finalized spec file, include the guidance text `finalized specs should not have Delta Spec Headings`, and treat all parsed items in that file as base content.

#### Standalone Scenarios

Standalone scenarios in any delta section (not associated with any requirement block by positional parsing) emit `spec_merge.standalone_scenario_unsupported` and are excluded. These are structural input errors that receive defined error handling; standalone scenario-level delta operations are not supported in the first pass.

#### Empty Capability Handling

If a capability has zero surviving merged requirements after exclusions and removals, emit `spec_merge.empty_capability_skipped` with severity `warning` and omit that capability from downstream specs-forward claim extraction, logic analysis, and coverage.

### Findings Catalog

The merge layer introduces findings in the `spec_merge.` namespace:

| Category | Severity | Description |
|---|---|---|
| `spec_merge.duplicate_added_identifier` | `error` | An `ADDED` item's identifier collides with an existing surviving item in its namespace |
| `spec_merge.modified_missing_identifier` | `error` | A `MODIFIED` item has no identifier and cannot be matched |
| `spec_merge.removed_missing_identifier` | `error` | A `REMOVED` item has no identifier and cannot be matched |
| `spec_merge.modified_target_not_found` | `error` | A `MODIFIED` item's identifier does not match any surviving base item |
| `spec_merge.removed_target_not_found` | `error` | A `REMOVED` item's identifier does not match any surviving base item |
| `spec_merge.rename_unsupported` | `warning` | A delta spec contains `RENAMED` sections that are not yet applied |
| `spec_merge.pre_section_content` | `error` | A delta spec contains items before the first delta section heading |
| `spec_merge.standalone_scenario_unsupported` | `error` | A delta spec contains a scenario item outside a requirement-block merge unit |
| `spec_merge.duplicate_base_identifier` | `error` | A finalized base spec contains a duplicate canonical identifier after the first occurrence |
| `spec_merge.finalized_spec_delta_heading_ignored` | `warning` | A finalized spec contains delta section headings; headings are ignored and items are treated as base content |
| `spec_merge.duplicate_delta_identifier` | `error` | A delta operation section contains conflicting duplicate canonical identifiers; all conflicting blocks are excluded |
| `spec_merge.empty_capability_skipped` | `warning` | A capability produced zero merged requirements and is omitted from downstream specs-forward phases |
| `spec_merge.duplicate_modified_identifier` | `error` | A `MODIFIED` replacement would introduce a requirement or scenario identifier collision outside the replaced base block |

#### Pipeline Error Handling Interaction

Merge findings with severity `error` are non-fatal to the pipeline. They cause the affected delta operation to be skipped, but the merge layer continues processing remaining operations and remaining capabilities. The pipeline continues to formalization and logical analysis with whatever was successfully merged.

Warnings for malformed but tolerated input (`spec_merge.finalized_spec_delta_heading_ignored`, `spec_merge.rename_unsupported`, `spec_merge.empty_capability_skipped`) are also non-fatal.

Unexpected internal merge failures and sanitized artifact-key collisions are fatal and abort the pipeline. There is no fallback to pre-merge per-file analysis because that would silently violate the active-capability analysis model. This is consistent with the existing pipeline pattern where `error` severity findings are accumulated and reported but do not abort the run (pipeline aborts use `PipelineAbortError` exceptions, not finding severity).

#### Finding Message Requirements

- `spec_merge.duplicate_added_identifier` messages must identify the colliding identifier value and state whether the collision is in the requirement namespace or the scenario namespace.
- `spec_merge.duplicate_modified_identifier` messages must identify the colliding identifier value and state which namespace the collision occurred in.
- All finding messages must include enough context for a user to locate and fix the problem in their source files.

### Ordering Contract
- Base requirements remain in original order, minus removals, with modifications replaced in place.
- Added requirements append after surviving base requirements in delta-document order.
- Base scenarios remain in original order, minus removals, with modified nested scenarios replaced in place.
- Added nested scenarios append in delta-document order.
- Within a `MODIFIED` replacement, the delta requirement's nested scenarios replace the base requirement's nested scenarios entirely. The replacement scenarios appear in delta-document order at the position formerly occupied by the base requirement's scenarios.
- Outer merged capability ordering preserves first-seen catalog order and performs no additional lexicographic sorting.

Invariant: given the same base spec and the same delta spec, the merged output is identical across runs.

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
- Any derived artifact-path key must sanitize the logical identifier using the artifact-key sanitization algorithm specified in the Data Design section above.
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

### Graceful Degradation

If the merge layer encounters an unexpected internal error (e.g., an assertion violation, a programming error in the merge logic, or a sanitized artifact-key collision):

1. The error propagates as an uncaught exception to the pipeline orchestrator.
2. The pipeline orchestrator catches it and emits a `PipelineAbortError` with category `"PipelineError"`.
3. There is no fallback to pre-merge per-file analysis. A merge failure is a pipeline failure.

Rationale: falling back to per-file analysis silently would produce results that contradict the user's expectation of merged capability analysis. An explicit failure is preferable to silently incorrect results.

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

Path traversal is prevented by the `CapabilityName` domain constraint (`[a-z0-9-]+`), which excludes all path-sensitive characters. The sanitization algorithm handles only the structural characters introduced by the `logicalFile` format (`<`, `>`, `/`).

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
- Requirement under `## ADDED Requirements` gets `deltaOperation: "ADDED"`.
- Requirement under `## MODIFIED Requirements` gets `deltaOperation: "MODIFIED"`.
- Requirement under `## REMOVED Requirements` gets `deltaOperation: "REMOVED"`.
- Requirement under `## RENAMED Requirements` gets `deltaOperation: "RENAMED"`.
- Scenario inherits the correct enclosing delta operation from its section heading.
- Scenario records `parentRequirementIdentifier` from the most recently parsed requirement.
- Scenario with no preceding requirement has `parentRequirementIdentifier: undefined`.
- Only exact delta heading text changes delta-section context in delta files.
- Finalized spec with delta headings emits `spec_merge.finalized_spec_delta_heading_ignored` and still assigns `deltaOperation: "base"` to all items.

### Merge Verification
- Unit tests for finalized-only, delta-only, `ADDED`, `MODIFIED`, `REMOVED`, and deferred `RENAMED` behavior.
- Tests for duplicate-base handling, duplicate-delta handling, and duplicate-introduced-by-modification handling.
- Tests for standalone scenarios, pre-section content, empty-capability skip behavior, and deterministic ordering.
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
- Standalone scenario in any delta section emits `spec_merge.standalone_scenario_unsupported` and is excluded.
- Duplicate canonical identifier in finalized base spec emits `spec_merge.duplicate_base_identifier`; first occurrence survives, later duplicates are excluded from output and matching.
- `RENAMED` in a delta-only capability still emits `spec_merge.rename_unsupported` and does not affect output.
- Duplicate canonical identifier within the same delta operation section emits `spec_merge.duplicate_delta_identifier`; all conflicting blocks in that group are excluded.
- Capability with zero surviving merged requirements emits `spec_merge.empty_capability_skipped` and is omitted from downstream specs-forward phases.
- `MODIFIED` replacement that would introduce an identifier collision outside the replaced block emits `spec_merge.duplicate_modified_identifier`, skips the replacement, and preserves the original base block.
- Requirement and scenario identifier collisions are checked in separate namespaces.

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
- No base requirement block is removed without either a matching `REMOVED` operation or a surfaced duplicate-base exclusion finding.
- No item in the merged output lacks provenance traceable to a source file.
- Every skipped requirement-block merge operation produces exactly one finding, and every malformed standalone delta item produces exactly one finding.
- `Claim.capability` is populated for all claims extracted from merged specs.
- Merge findings are appended before downstream phases and remain visible in final run output.
- A merge failure or finding in one capability does not change another capability's merged output.
- Approximate or case-variant delta headings do not alter merge semantics.

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
- Merged capability produces one specs-forward logical-analysis group per capability.
- Coverage analysis consumes merged capability specs and excludes removed requirements.
- Sanitized `logicalFile` collisions abort the pipeline before artifact writes.
- Capability with zero merged requirements is skipped from downstream specs-forward phases with `spec_merge.empty_capability_skipped`.

### Evidence And Artifact Verification
- Update or add Alloy-backed capability artifacts so they reflect merged capability semantics.
- Review documentation updates for consistency with implementation and tests.
- Capture verification evidence in a form suitable for archive so future readers can trace scenarios, invariants, and outcomes.
- Unit and integration tests must be tagged or documented so each major scenario and invariant is traceable to the spec.
- Any Alloy-backed capability models affected by the merge phase must be updated so the executable/formal artifacts agree with the revised pipeline semantics.
- The change must preserve deterministic outputs across repeated runs for parser, merge, coverage, and logic-grouping evidence.
- Any counterexample or bug discovered during implementation must become a permanent regression test.

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
