## ADDED Requirements

## MODIFIED Requirements

### Requirement: Per-Spec Combined SMT-LIB Compilation [FLA-SPEC-COMBINE]
WHEN the spec-check tool performs specs-forward logic analysis, THE spec-check tool SHALL combine all formalized claims from a single merged capability analysis unit into exactly one SMT-LIB file, SHALL deduplicate variable and function declarations across claims, and SHALL use named assertions (`(assert (! expr :named label))`) to enable unsat-core identification. The compiled output SHALL NOT include solver commands (`check-sat`, `set-option`, `get-unsat-core`) — the logic analysis orchestrator appends these at query time using a two-phase approach (Phase 1: satisfiability check only; Phase 2: re-run with `(set-option :produce-unsat-cores true)` and `(get-unsat-core)` only when UNSAT is detected).

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/merge-delta-spec-logic/proposal.md#Scope`
- `openspec/changes/merge-delta-spec-logic/design.md#Interaction Protocols`

#### Scenario: Variable And Function Deduplication [FLA-SPEC-DEDUP]
WHEN multiple claims from the same merged capability analysis unit declare identical variable or function names with identical sorts or signatures, THE spec-check tool SHALL emit only one declaration in the combined output.

**Postcondition:** The combined SMT-LIB file has no duplicate declarations from compatible claims.

#### Scenario: Function Signature Conflict Detection [FLA-SPEC-CONFLICT]
IF two claims from the same merged capability analysis unit declare the same function name with incompatible signatures, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding, SHALL exclude the conflicting claim from the combined file, and SHALL preserve both claim identifiers in the finding evidence.

**Postcondition:** Signature conflicts are surfaced as findings rather than producing malformed solver input.

#### Scenario: Named Assertion Labels Map To Claims [FLA-SPEC-NAMED]
WHEN the spec-check tool generates named assertions in the combined SMT-LIB, THE label for each assertion SHALL encode the source claim identifier and assertion index so that unsat-core results can be mapped back to specific claims.

**Postcondition:** The assertion-name-to-claim-ID mapping is deterministic and reversible.

### Requirement: Run Per-Spec Combined Solver Analysis [FLA-RUN-LOGIC]
WHEN formal artifacts are available, THE spec-check tool SHALL group representative spec-derived claims by merged capability analysis unit, SHALL compile each group into a single combined SMT-LIB file with named assertions, SHALL invoke Z3 per merged capability group using a two-phase approach (Phase 1: satisfiability check only; Phase 2: re-invoke with unsat-core support only when contradiction is detected), and SHALL classify contradictions with severity derived from the highest-obligation claim in the unsat core.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/merge-delta-spec-logic/proposal.md#Quality Attributes`
- `openspec/changes/merge-delta-spec-logic/design.md#Interaction Protocols`

#### Scenario: Report Contradiction With Unsat-Core Identification [FLA-LOGIC-CORE]
WHEN a per-merged-capability combined query returns unsat, THE spec-check tool SHALL parse the unsat core to identify the specific conflicting claims, SHALL report a `logic.contradiction` finding referencing those claims, and SHALL derive severity from the highest-obligation claim in the core (mandatory → error, advisory → warning, informational → info).

**Postcondition:** Reviewers can identify which specific claims within a merged capability view are mutually contradictory.

#### Scenario: Advisory-Only Core Reported At Lower Severity [FLA-LOGIC-ADVISORY]
WHEN the unsat core contains only advisory or informational claims with no mandatory claims, THE spec-check tool SHALL report the contradiction at warning or info severity respectively.

**Postcondition:** Contradictions among advisory claims are visible but clearly distinguished from mandatory violations.

#### Scenario: Preserve Inconclusive Solver Result [FLA-LOGIC-TIMEOUT]
IF the solver returns timeout or unknown for a per-merged-capability query, THEN THE spec-check tool SHALL preserve the inconclusive result as evidence and SHALL emit a `logic.inconclusive` finding at warning severity.

**Postcondition:** Inconclusive logic results remain visible to reviewers and do not masquerade as success.

#### Scenario: Sat Result Triggers Deeper Analysis [FLA-LOGIC-SAT]
WHEN a per-merged-capability combined query returns sat, THE spec-check tool SHALL NOT emit a global contradiction finding for that merged capability, but SHALL proceed with pairwise guard-activation contradiction checks and completeness gap detection to identify conditional contradictions and unspecified states that the global satisfiability check cannot surface.

**Postcondition:** A globally satisfiable merged capability is not assumed free of all issues; deeper conditional analysis follows.

#### Scenario: Solver Error Produces Finding [FLA-LOGIC-ERROR]
IF the solver emits error diagnostics (such as `(error ...)` lines in stdout) indicating malformed input, THEN THE spec-check tool SHALL emit a `logic.solver_error` finding at error severity referencing all claims in the affected merged capability group, and SHALL persist the solver input and output as evidence.

**Postcondition:** Solver errors are surfaced as explicit findings rather than silently treated as successful analysis.

### Requirement: Group Specs-Forward Logic By Merged Capability [FLA-GROUP-MERGED]
WHEN the spec-check tool prepares specs-forward logical analysis, THE spec-check tool SHALL group spec-derived claims by merged capability identity rather than by raw source-spec file path, SHALL use the merged capability `logicalFile` as the artifact-naming and report-grouping key, and SHALL exclude non-spec claims from this capability-grouped logic path.

**References:**
- `openspec/changes/merge-delta-spec-logic/proposal.md#Postconditions`
- `openspec/changes/merge-delta-spec-logic/design.md#Provenance And Grouping Contract`
- `openspec/changes/merge-delta-spec-logic/design.md#Verification Strategy`

#### Scenario: One Logic Group Per Merged Capability [FLA-GROUP-ONE]
WHEN one capability has finalized-plus-delta inputs that merge into one active capability view, THE spec-check tool SHALL produce exactly one specs-forward logical-analysis group for that capability.

**Postcondition:** Base and delta files for the same capability are no longer analyzed as separate solver groups.

#### Scenario: Synthetic Logical Key Drives Artifact Naming [FLA-GROUP-LOGICAL]
WHEN the spec-check tool persists solver artifacts or reports for a merged capability logic group, THE spec-check tool SHALL derive those artifact names from the merged capability `logicalFile` key rather than from the original base or delta source file paths.

**Postcondition:** Capability-scoped logic artifacts align with merged capability semantics while original claim provenance remains unchanged.

#### Scenario: Sanitized Logical Key Collision Aborts Pipeline [FLA-GROUP-COLLISION]
IF two merged capability logical keys would sanitize to the same artifact-path key, THEN THE spec-check tool SHALL abort the pipeline before writing any logic artifacts.

**Postcondition:** Persisted solver evidence remains deterministic and collision-free.

## REMOVED Requirements

## RENAMED Requirements
