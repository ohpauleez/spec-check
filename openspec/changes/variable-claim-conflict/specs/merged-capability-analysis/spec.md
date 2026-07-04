## MODIFIED Requirements

### Requirement: Preserve Source Provenance In Merged Output [MCA-MERGE-PROVEN]
WHEN the spec-check tool emits merged requirements, merged scenarios, and derived claims from a merged capability view, THE spec-check tool SHALL preserve the original source-file provenance on each contributing item, SHALL use a separate synthetic merged capability key only for grouping and artifact naming, and SHALL treat all claims grouped under one synthetic merged capability key as one downstream compile-group identity boundary for specs-forward logic analysis.

**References:**
- `openspec/changes/variable-claim-conflict/proposal.md#Context`
- `openspec/changes/variable-claim-conflict/proposal.md#Domain Model`
- `openspec/changes/variable-claim-conflict/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/variable-claim-conflict/design.md#Architecture Decisions`
- `openspec/changes/variable-claim-conflict/design.md#Component Design`

#### Scenario: Source Provenance Survives Merge [MCA-MERGE-SOURCE]
WHEN a merged requirement or scenario originates from either the finalized spec or the selected delta spec, THE spec-check tool SHALL preserve that item's original source file and line provenance in the merged output and any derived claim.

**Postcondition:** Reviewers can trace merged analysis results back to the original contributing file.

#### Scenario: Synthetic Logical Key Groups Capability Artifacts [MCA-MERGE-LOGICAL]
WHEN the spec-check tool persists specs-forward solver artifacts or report headings for a merged capability, THE spec-check tool SHALL use the deterministic synthetic merged capability key `<merged-spec/{capability}>` rather than a real filesystem source path.

**Postcondition:** Capability-scoped artifacts remain distinct from source-file provenance.

#### Scenario: Synthetic Logical Key Defines Compile-Group Boundary [MCA-MERGE-GROUP-KEY]
WHEN the specs-forward pipeline groups derived claims for combined SMT-LIB compilation, THE spec-check tool SHALL group all claims that share one synthetic merged capability key into the same compile group and SHALL preserve claim identifier uniqueness as a downstream precondition for that group.

**Postcondition:** Compile-group identity is consistent from merged-capability routing through logic analysis, and claim-ID safety checks are applied at the same grouping boundary used for solver submission.

**Data Boundary:** The synthetic merged capability key is the `specFile`/logical-file identity for specs-forward compilation and artifact naming. It is not necessarily a raw source path and SHALL be treated as untrusted text when emitted into SMT-LIB comments or reports.

**Identity Boundary:** All claims grouped under one synthetic merged capability key share one declaration namespace, one assertion-label namespace, one conflict-preflight scope, and one solver submission boundary. Raw and sanitized claim-ID uniqueness SHALL be enforced within this grouped boundary before solver work.

**Trace Properties:** VSC-10, VSC-10b.

#### Scenario: Merged Output Ordering Is Deterministic [MCA-MERGE-ORDER]
WHEN the same finalized and delta inputs are merged on separate runs, THE spec-check tool SHALL produce the same requirement order, scenario order, capability order, findings, and logical grouping identity on each run.

**Postcondition:** Merge output is a deterministic function of input specs and catalog selection.
