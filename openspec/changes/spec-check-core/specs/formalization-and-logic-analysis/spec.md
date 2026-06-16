## ADDED Requirements

### Requirement: Formalize Requirement And Scenario Claims Into Logic Artifacts [FLA-FORMALIZE-CLAIMS]
WHEN requirement and scenario claims are available for formal analysis, THE spec-check tool SHALL translate each claim into a typed logic representation and generated SMT-LIB artifacts that preserve the claim identifier, source provenance, obligation level, and supporting declarations needed for solver analysis.

**References:**
- `proposal.md#Scope`
- `proposal.md#Domain Model`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Generate Inspectable Logic Artifacts [FLA-FORMAL-ARTS]
WHEN a claim is selected for formalization, THE spec-check tool SHALL emit inspectable logic and SMT artifacts that let a reviewer trace the formal result back to the originating requirement or scenario.

**Postcondition:** Formal analysis inputs are available as reviewable evidence linked to their source claims.

#### Scenario: Fail Unusable Formalization [FLA-FORMAL-FAIL]
IF required formalization output remains unavailable or invalid after bounded retries, THEN THE spec-check tool SHALL stop the run with exit code `2` rather than continue with incomplete formal evidence.

**Postcondition:** No solver conclusion is produced from an unvalidated formalization step.

### Requirement: Formalization Sample Schema Validation [FLA-VALIDATE-SAMPLE]
WHEN the spec-check tool receives a formalization sample from `opencode`, THE spec-check tool SHALL validate the sample against the logic IR schema including sort consistency, assertion well-formedness, and identifier format before accepting it into clustering.

**References:**
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Failure Modes`

#### Scenario: Valid Sample Accepted [FLA-SAMPLE-ACCEPT]
WHEN a formalization sample passes schema validation for sort consistency, assertion well-formedness, and identifier format, THE spec-check tool SHALL accept it as a clustering candidate.

**Postcondition:** Only structurally valid samples enter the clustering phase.

#### Scenario: Invalid Sample Rejected [FLA-SAMPLE-REJECT]
IF a formalization sample violates the logic IR schema, THEN THE spec-check tool SHALL reject it from clustering and preserve the invalid sample as evidence.

**Postcondition:** Invalid formalizations are visible to reviewers without corrupting downstream analysis.

#### Scenario: All Samples Invalid After Retries [FLA-SAMPLE-EXHAUST]
IF all formalization samples for a claim are invalid after bounded retries, THEN THE spec-check tool SHALL treat this as a fatal analysis failure and exit with code `2`.

**Postcondition:** No solver analysis proceeds with zero valid formalizations.

### Requirement: SMT-LIB Compilation And Identifier Sanitization [FLA-SMTLIB-COMPILE]
WHEN the spec-check tool compiles logic IR into SMT-LIB artifacts, THE spec-check tool SHALL sanitize user-derived identifiers to prevent solver syntax collisions and SHALL include reversible mapping comments that link sanitized identifiers back to their original claim identifiers.

**References:**
- `proposal.md#Constraints`
- `proposal.md#Quality Attributes`

#### Scenario: Unsafe Identifier Sanitized [FLA-SMTLIB-SANITIZE]
WHEN a claim identifier contains characters that conflict with SMT-LIB syntax (parentheses, pipe characters, whitespace, or special SMT-LIB reserved characters), THE spec-check tool SHALL replace them with a deterministic encoding (underscore plus hex escape) and emit a mapping comment.

**Postcondition:** The SMT-LIB file is syntactically valid and the original identifier is recoverable from the mapping comment.

#### Scenario: Valid Identifier Preserved [FLA-SMTLIB-PRESERVE]
WHEN a claim identifier contains only SMT-LIB-safe characters, THE spec-check tool SHALL use the identifier unchanged in the SMT-LIB output.

**Postcondition:** No unnecessary transformation is applied to safe identifiers.

### Requirement: Surface Ambiguity Through Sample Clustering [FLA-CLUSTER-AMBIG]
WHEN multiple formalization samples are produced for the same claim, THE spec-check tool SHALL compare the samples for semantic equivalence using solver-backed implication checks, select a stable interpretation only when it meets the configured stability threshold, and SHALL surface divergent interpretations as ambiguity findings with rationale.

**References:**
- `proposal.md#Motivation`
- `proposal.md#Failure Modes`
- `proposal.md#Quality Attributes`

#### Scenario: Select Stable Interpretation [FLA-CLUSTER-STABLE]
WHEN one equivalence cluster exceeds the configured stability threshold, THE spec-check tool SHALL select the highest-confidence sample from that cluster as the representative formalization for the claim.

**Postcondition:** Downstream solver analysis uses one explicit representative interpretation with preserved clustering evidence.

#### Scenario: Surface Divergent Interpretations [FLA-CLUSTER-DIVERGE]
IF no equivalence cluster meets the configured stability threshold, THEN THE spec-check tool SHALL emit an ambiguity finding that preserves the distinct surviving interpretations for reviewer inspection.

**Postcondition:** Weak or unstable claim meaning becomes a surfaced finding instead of a hidden assumption.

#### Scenario: Inconclusive Implication Check Preserved [FLA-CLUSTER-INCON]
IF the solver returns timeout or unknown for a pairwise implication check, THE spec-check tool SHALL record the inconclusive pair as evidence and SHALL NOT treat the pair as either equivalent or distinct.

**Postcondition:** Inconclusive solver results do not corrupt cluster construction.

### Requirement: Clustering Determinism And Symmetry [FLA-CLUSTER-PROPERTIES]
WHEN the spec-check tool performs equivalence clustering on the same set of formalization samples with the same solver results, THE spec-check tool SHALL produce identical clusters.

**References:**
- `proposal.md#Quality Attributes`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Symmetric Implication Produces Same Cluster [FLA-CLUSTER-SYMM]
WHEN sample A implies sample B and sample B implies sample A, THE spec-check tool SHALL place both samples in the same equivalence cluster.

**Postcondition:** Mutual implication is correctly classified as equivalence.

#### Scenario: Deterministic Clustering [FLA-CLUSTER-DETERM]
WHEN the same formalization samples and solver results are processed on two separate runs, THE spec-check tool SHALL produce identical equivalence clusters and identical representative selections.

**Postcondition:** Clustering is a deterministic function of its inputs.

### Requirement: Run Obligation-Aware Solver Analysis [FLA-RUN-LOGIC]
WHEN formal artifacts are available, THE spec-check tool SHALL run solver analysis that respects obligation strength, SHALL classify contradictory or gap-indicating results with severity appropriate to the obligation pass, and SHALL preserve counterexamples, models, timeouts, and unknown results as evidence.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Quality Attributes`

#### Scenario: Report Mandatory Contradiction [FLA-LOGIC-CORE]
WHEN mandatory claims alone produce an unsatisfied or contradictory result, THE spec-check tool SHALL report the finding at mandatory-analysis severity and SHALL preserve the solver evidence that demonstrates the contradiction.

**Postcondition:** Reviewers can inspect the preserved solver result for mandatory-claim failures.

#### Scenario: Report Advisory Contradiction At Lower Severity [FLA-LOGIC-ADVISORY]
WHEN advisory claims produce a contradictory result, THE spec-check tool SHALL report the finding at advisory-analysis severity, which is lower than mandatory-analysis severity.

**Postcondition:** Advisory contradictions are visible but clearly distinguished from mandatory violations.

#### Scenario: Preserve Inconclusive Solver Result [FLA-LOGIC-TIMEOUT]
IF the solver returns timeout or unknown for a query, THEN THE spec-check tool SHALL preserve the inconclusive result as evidence and SHALL continue according to the non-fatal per-query policy.

**Postcondition:** Inconclusive logic results remain visible to reviewers and do not masquerade as success.

### Requirement: Bounded Solver Timeouts [FLA-SOLVER-TIMEOUT]
WHEN the spec-check tool submits a query to `z3`, THE spec-check tool SHALL enforce a per-query timeout (default 30 seconds) and SHALL classify timeout results as inconclusive rather than as success or failure.

**References:**
- `proposal.md#Quality Attributes`
- `proposal.md#Failure Modes`

#### Scenario: Query Completes Within Timeout [FLA-TIMEOUT-PASS]
WHEN the solver returns a definitive result (sat or unsat) within the per-query timeout, THE spec-check tool SHALL use the result for finding classification.

**Postcondition:** Timely solver results are used normally.

#### Scenario: Query Exceeds Timeout [FLA-TIMEOUT-EXCEED]
IF the solver does not return a result within the per-query timeout, THEN THE spec-check tool SHALL terminate the query, record the timeout as evidence, and continue with remaining queries.

**Postcondition:** A single slow query does not block the entire solver analysis phase.

### Requirement: Solver Evidence Persistence [FLA-SOLVER-PERSIST]
WHEN the spec-check tool runs solver analysis, THE spec-check tool SHALL persist all solver inputs (SMT-LIB files) and outputs (stdout, stderr, exit classification) verbatim under the output directory.

**References:**
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Quality Attributes`

#### Scenario: Sat Result Persisted [FLA-PERSIST-SAT]
WHEN a solver query returns sat with a model, THE spec-check tool SHALL persist the SMT-LIB input file and the complete model output.

**Postcondition:** The satisfiable result and its model are available for reviewer inspection.

#### Scenario: Unsat Core Persisted [FLA-PERSIST-UNSAT]
WHEN a solver query returns unsat, THE spec-check tool SHALL persist the SMT-LIB input file and any unsat core output.

**Postcondition:** The contradictory subset of assertions is available for reviewer inspection.

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements
