## ADDED Requirements

### Requirement: Shared Logical-File Grouping Authority [MCA-GROUP-KEY]
THE spec-check tool SHALL treat merged capability logical-file keys as the shared grouping authority for both requirement claims and scenario claims: the logical-file map SHALL map every provided merged capability to its non-empty `logicalFile`, the map-building step SHALL validate that each provided `spec.logicalFile` is a non-empty string, and scenario-only merged specs (specs with at least one scenario and no requirements) SHALL contribute logical-file map entries. The scenario-only rule is defensive: in the current merge domain model, merged scenarios derive only from requirement blocks, so a scenario-only merged spec cannot be produced; the rule exists to keep grouping correct if the domain model ever admits standalone scenario claims. Capability uniqueness within the map follows from the merge layer's `capabilityOrder` first-occurrence deduplication and is not re-enforced by the map builder.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Domain Model`
- `openspec/changes/semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/semantic-batching/design.md#Component Descriptions`

#### Scenario: Scenario-Only Spec Contributes Map Entry [MCA-GROUP-KEY-SCEN]
WHEN a merged capability spec contains at least one scenario and no requirements (a defensive case that is unreachable in the current merge domain model), THE spec-check tool SHALL include that capability in the logical-file map used for grouping.

**Postcondition:** Scenario-level claims of the capability receive the merged logical file as their semantic key.

#### Scenario: Empty Logical File Rejected [MCA-GROUP-KEY-EMPTY]
IF a merged capability spec supplied to the map builder has an empty `logicalFile` string, THEN THE spec-check tool SHALL reject it as a validation failure.

**Postcondition:** Empty logical-file values never silently enter the grouping map.

#### Scenario: Every Provided Capability Mapped [MCA-GROUP-KEY-COMPLETE]
WHEN the map builder receives a set of merged capability specs, THE resulting map SHALL contain exactly one entry for every provided capability, consistent with merge-layer capability uniqueness invariants.

**Postcondition:** No provided capability is silently omitted from the map.

#### Requirement model

```alloy
// --- Grouping-map authority: completeness, active-spec filter (structural) ---
// Structural model: the map builder is a pure total function over provided
// active merged specs; the active filter only broadens the map relative to
// the solver-input filter, never narrows it.

sig Capability {}

// Whether a merged spec has requirements / scenarios.
abstract sig Presence {}
one sig NoneP, SomeP extends Presence {}

sig MergedSpec {
  cap   : one Capability,
  reqs  : one Presence,
  scens : one Presence
}

// Distinct merged specs have distinct capabilities (merge-layer uniqueness,
// observed from capabilityOrder deduplication; stated, not re-enforced).
fact capability_unique {
  all disj s1, s2 : MergedSpec | s1.cap != s2.cap
}

// Active for grouping: requirements present OR scenarios present
// [MCA-ACTIVE-SPECS]. The scenarios clause is defensive: unreachable today.
fun activeForGrouping : set MergedSpec {
  { s : MergedSpec | s.reqs = SomeP or s.scens = SomeP }
}

// Defensive-domain fact: in the current merge model, a spec with scenarios
// always has requirements. Models "scenario-only is unreachable today" while
// keeping the filter correct if the domain evolves.
fact scenarios_imply_requirements_today {
  all s : MergedSpec | s.scens = SomeP implies s.reqs = SomeP
}

// Solver-input activity filter (unchanged): requirements only.
fun activeForSolverInput : set MergedSpec {
  { s : MergedSpec | s.reqs = SomeP }
}

sig LogicalFile {}

// The built map: one entry per provided (active-for-grouping) capability
// [MCA-GROUP-KEY-COMPLETE].
sig BuiltMap {
  entries : Capability -> one LogicalFile
}

fact map_covers_active_specs {
  all m : BuiltMap |
    m.entries.LogicalFile = activeForGrouping.cap
}

// Safety: grouping map is never narrower than the solver-input set — every
// spec that contributes claims to the solver has a map entry.
assert grouping_map_covers_solver_inputs {
  all m : BuiltMap |
    activeForSolverInput.cap in m.entries.LogicalFile
}

// Safety: scenario-only specs (if ever produced) get map entries
// [MCA-GROUP-KEY-SCEN]. Vacuously true today under the defensive-domain fact;
// stated so a future domain change that relaxes the fact surfaces here.
assert scenario_only_specs_mapped {
  all m : BuiltMap, s : MergedSpec |
    (s.scens = SomeP and s.reqs = NoneP)
    implies s.cap in m.entries.LogicalFile
}

// Safety: empty specs (no requirements, no scenarios) contribute no entries
// [MCA-ACTIVE-EMPTY].
assert empty_specs_excluded {
  all m : BuiltMap, s : MergedSpec |
    (s.reqs = NoneP and s.scens = NoneP)
    implies s.cap not in m.entries.LogicalFile
}

check grouping_map_covers_solver_inputs for 5 expect 0
check scenario_only_specs_mapped for 5 expect 0
check empty_specs_excluded for 5 expect 0
run sanity_map { some MergedSpec and some BuiltMap } for 3 expect 1
```

### Requirement: Active Merged Specs For Grouping [MCA-ACTIVE-SPECS]
WHEN the spec-check tool selects merged specs for grouping-map construction, THE spec-check tool SHALL include a merged spec when it has at least one requirement or at least one scenario, and SHALL express this filtering in a dedicated, explicitly named helper rather than hiding it inside the map builder. This helper is used only for grouping-map construction; it SHALL NOT replace the claim-graph or solver-input activity filters (at least one requirement), so the grouping map can only be broader than the set of specs that contribute claims — never narrower. The scenarios clause is defensive: unreachable under the current merge domain model. If standalone scenario claims are ever admitted, this clause becomes load-bearing and the claim-graph activity filter must be broadened in the same change.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Scope`
- `openspec/changes/semantic-batching/design.md#Component Descriptions`
- `openspec/changes/semantic-batching/design.md#Interaction Protocols`

#### Scenario: Requirement-Bearing Spec Is Active [MCA-ACTIVE-REQ]
WHEN a merged spec has at least one requirement, THE spec-check tool SHALL treat it as active for grouping.

**Postcondition:** The spec is included in grouping-map construction.

#### Scenario: Scenario-Only Spec Is Active [MCA-ACTIVE-SCEN]
WHEN a merged spec has at least one scenario and no requirements (a defensive case that is unreachable in the current merge domain model), THE spec-check tool SHALL treat it as active for grouping.

**Postcondition:** Scenario-only capabilities keep their semantic grouping key.

#### Scenario: Empty Spec Is Inactive [MCA-ACTIVE-EMPTY]
WHEN a merged spec has zero requirements and zero scenarios, THE spec-check tool SHALL exclude it from grouping-map construction.

**Postcondition:** Vacuous specs contribute no grouping entries.

### Requirement: Solver Grouping Calls Shared Key Helper [MCA-SOLVER-SHARED-KEY]
WHEN the spec-check tool groups claims for solver analysis, THE solver grouping path SHALL obtain each claim's grouping key from the same shared semantic key helper used by formalization grouping, SHALL NOT duplicate capability fallback logic locally, SHALL consume the same logical-file map instance that the pipeline constructs once and passes to both phases, and SHALL perform any solver-specific claim filtering before grouping and document that filtering independently of the key function.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Scope`
- `openspec/changes/semantic-batching/design.md#Interaction Protocols`

#### Scenario: No Duplicated Fallback Logic [MCA-SOLVER-NODUP]
WHEN solver grouping computes a claim's grouping key, THE key SHALL be produced by the shared helper so that the capability fallback rule (mapped `logicalFile`, else `<merged-spec/{capability}>`) exists in exactly one place.

**Postcondition:** The capability fallback rule has a single authoritative implementation.

#### Scenario: Filtering Precedes Grouping [MCA-SOLVER-FILTER-FIRST]
WHEN solver analysis excludes claims (for example, non-spec claims), THE spec-check tool SHALL apply those exclusions before grouping and SHALL NOT encode solver-specific policy inside the shared key helper.

**Postcondition:** The key function remains policy-free and identical across phases.

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements
