## MODIFIED Requirements

### Requirement: Preserve Evidence For Every Surfaced Conclusion [RAE-PRESERVE-EVID]
WHEN the spec-check tool emits a finding or final report conclusion, THE spec-check tool SHALL preserve the provenance, rationale, and supporting artifacts needed for a reviewer to inspect the basis of that conclusion, and SHALL render evidence-bearing report content so that preserved raw values remain inert data rather than report-structure control.

**References:**
- `openspec/changes/variable-claim-conflict/proposal.md#Scope`
- `openspec/changes/variable-claim-conflict/proposal.md#Failure Modes`
- `openspec/changes/variable-claim-conflict/proposal.md#Quality Attributes`
- `openspec/changes/variable-claim-conflict/design.md#Architecture Decisions`
- `openspec/changes/variable-claim-conflict/design.md#Security And Safety Considerations`

#### Scenario: Preserve Solver And Model Artifacts [RAE-EVID-ARTS]
WHEN a finding depends on solver analysis or sampled formalization output, THE spec-check tool SHALL preserve the related generated artifacts or references needed to inspect that evidence.

**Postcondition:** Logic-backed findings remain reviewable against their supporting artifacts.

#### Scenario: Preserve Cross-Side Implication Evidence [RAE-EVID-CROSSIMPLY]
WHEN a code-backwards classification depends on cross-side implication analysis, THE spec-check tool SHALL preserve the implication queries, solver results, and classification rationale as evidence attached to the finding.

**Postcondition:** Cross-side comparison verdicts are traceable to their formal basis.

#### Scenario: Prevent Unsupported Verdict [RAE-EVID-FAIL]
IF a final report conclusion would be emitted without preserved provenance or supporting evidence, THEN THE spec-check tool SHALL suppress that unsupported verdict and SHALL surface the missing-evidence condition as a defect.

**Postcondition:** Reported conclusions never outrun the preserved evidence set.

#### Scenario: Preserve LLM Response As Evidence [RAE-EVID-LLM]
WHEN a finding depends on an LLM-backed analysis response, THE spec-check tool SHALL preserve the full response content as evidence attached to the finding.

**Postcondition:** No final verdict rests on an unpreserved LLM response.

#### Scenario: Render Evidence Values As Inert Markdown Data [RAE-EVID-RENDER-SAFE]
WHEN the spec-check tool renders finding descriptions, provenance, related claim identifiers, or evidence values into Markdown reports, THE spec-check tool SHALL neutralize inline Markdown control syntax in those raw values so they cannot render as links, emphasis, inline code spans, headings, list items, block quotes, or extra table cells.

**Postcondition:** Evidence remains inspectable without creating synthetic report structure or misleading reviewer-visible findings.

**Security Cases:** Renderer tests SHALL cover at least raw payloads containing a link (`[x](http://evil)`), emphasis (`**x**` and `_x_`), an inline-code/backtick payload, a table-cell breakout pipe (`a | b`), and leading block markers (`#`, `>`, `-`). Each payload SHALL render inert, with no anchor, emphasis, extra cell, heading, block quote, code span, or list item introduced by the raw evidence.

**Boundary:** SMT-LIB comment escaping is owned by formalization-and-logic-analysis. Markdown neutralization is owned by reporting-and-evidence. Both boundaries are required because merge-conflict evidence can flow through compiler comments and final Markdown reports.

**Trace Properties:** VSC-12.

### Requirement: Finding Shape And Severity [RAE-FINDING-SHAPE]
WHEN the spec-check tool creates a finding, THE spec-check tool SHALL use a stable finding shape with required fields: severity, category, provenance, description, rationale, and evidence references. Optional fields include suggestion and related claim identifiers. When catalog-empty conditions are represented as findings or finding-like diagnostics, the same explanatory completeness SHALL apply.

**References:**
- `openspec/changes/variable-claim-conflict/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/variable-claim-conflict/proposal.md#Quality Attributes`
- `openspec/changes/variable-claim-conflict/design.md#Component Design`

#### Scenario: Finding With All Required Fields [RAE-SHAPE-COMPLETE]
WHEN a finding is created, THE spec-check tool SHALL populate severity, category, provenance, description, rationale, and at least one evidence reference.

**Postcondition:** Every finding is self-describing and reviewable without external context.

#### Scenario: Missing Required Field Rejected [RAE-SHAPE-FAIL]
IF a finding would be emitted without a required field, THEN THE spec-check tool SHALL treat this as an analysis defect and surface it rather than emitting an incomplete finding.

**Postcondition:** The finding pipeline never produces malformed findings.

#### Scenario: Catalog Diagnostic Remains Actionable [RAE-SHAPE-CATALOG]
WHEN the tool surfaces a catalog-empty diagnostic, THE spec-check tool SHALL include the empty-catalog cause and actionable remediation text in the surfaced message.

**Postcondition:** Catalog errors meet the same reviewability standard as normal findings.

#### Scenario: Merge And Invalid-Group Findings Preserve Conflict Evidence [RAE-SHAPE-MERGE-CONFLICT-EVIDENCE]
WHEN the logic-analysis pipeline emits `logic.merge_conflict` or `logic.invalid_group`, THE finding SHALL use severity `error`, SHALL include the category, provenance, description, rationale, and evidence references, and SHALL preserve claim-attributed details needed to diagnose the structural defect.

**Merge Evidence:** Function-signature conflicts SHALL preserve the shared sanitized symbol, both raw function names, both claim IDs, and the `[existingClaimId, excludedClaimId]` tuple. Variable-sort conflicts SHALL additionally preserve expected and conflicting sorts. Symbol-kind collisions SHALL preserve both raw symbol names and both declaration kinds, including the same-claim `[claimId, claimId]` edge case.

**Invalid-Group Evidence:** Duplicate raw claim-ID findings SHALL list duplicated raw IDs and affected claims. Sanitized-ID collision findings SHALL list colliding raw IDs and the shared sanitized ID. These findings are structural identity errors, not merge conflicts.

**Severity:** Merge conflicts and invalid compile groups SHALL be `error` severity independent of source obligation, because declaration conflicts and identity aliasing are structural defects rather than satisfiability outcomes.
