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

#### Scenario: Abort On Complete Formalization Failure [FLA-FORMAL-FAIL]
IF no formalization candidates are produced for the entire phase after bounded retries, THEN THE spec-check tool SHALL abort the run with exit code `2` rather than continue with zero formal evidence.

**Postcondition:** No solver conclusion is produced when the formalization phase yields zero candidates.

#### Scenario: Continue With Partial Formalization Results [FLA-FORMAL-PARTIAL]
IF some claims fail formalization but at least one claim succeeds, THEN THE spec-check tool SHALL continue with the successful candidates, SHALL collect per-claim failures as errors in the formalization output, and SHALL let callers decide severity based on the ratio of successes to failures.

**Postcondition:** Partial formalization results are preserved and downstream phases proceed with available candidates.

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
IF all formalization samples for a claim are invalid after bounded retries, THEN THE spec-check tool SHALL record the failure as an error in the formalization output and SHALL exclude that claim from clustering. THE tool SHALL NOT abort the entire phase unless no claims produce valid candidates.

**Postcondition:** Per-claim formalization failures are collected as errors; remaining valid claims proceed to clustering.

### Requirement: SMT-LIB Compilation And Identifier Sanitization [FLA-SMTLIB-COMPILE]
WHEN the spec-check tool compiles logic IR into SMT-LIB artifacts, THE spec-check tool SHALL sanitize user-derived identifiers to prevent solver syntax collisions, SHALL include reversible mapping comments that link sanitized identifiers back to their original claim identifiers, SHALL emit only declarations and assertions without solver commands (`(check-sat)`), and SHALL expose decomposed assertion expressions alongside the compiled text for downstream query construction.

**References:**
- `proposal.md#Constraints`
- `proposal.md#Quality Attributes`

#### Scenario: Unsafe Identifier Sanitized [FLA-SMTLIB-SANITIZE]
WHEN a claim identifier contains characters that conflict with SMT-LIB syntax (parentheses, pipe characters, whitespace, or special SMT-LIB reserved characters), THE spec-check tool SHALL replace them with a deterministic encoding (underscore plus hex escape) and emit a mapping comment.

**Postcondition:** The SMT-LIB file is syntactically valid and the original identifier is recoverable from the mapping comment.

#### Scenario: Valid Identifier Preserved [FLA-SMTLIB-PRESERVE]
WHEN a claim identifier contains only SMT-LIB-safe characters, THE spec-check tool SHALL use the identifier unchanged in the SMT-LIB output.

**Postcondition:** No unnecessary transformation is applied to safe identifiers.

#### Scenario: Compiled Output Excludes Solver Commands [FLA-SMTLIB-QUERYSAT]
WHEN the spec-check tool compiles logic IR into SMT-LIB text, THE compiled output SHALL contain declarations (`declare-sort`, `declare-fun`) and assertions (`assert`) but SHALL NOT include `(check-sat)`. Callers SHALL append `(check-sat)` at query execution time.

**Postcondition:** Compiled SMT-LIB is a reusable component that can be composed into different query types (satisfiability, implication) without stripping embedded solver commands.

#### Scenario: Assertion Expressions Exposed [FLA-SMTLIB-ASSERTEXPRS]
WHEN the spec-check tool compiles logic IR into SMT-LIB, THE compiled output SHALL include the decomposed inner assertion expressions (without the `(assert ...)` wrapper) for use in downstream implication query construction.

**Postcondition:** Downstream consumers can construct negated or combined assertions from the compiled output without re-parsing the SMT-LIB text.

### Requirement: Per-Spec Combined SMT-LIB Compilation [FLA-SPEC-COMBINE]
WHEN the spec-check tool performs logic analysis, THE spec-check tool SHALL combine all formalized claims from a single spec file into exactly one SMT-LIB file, SHALL deduplicate sort and function declarations across claims, SHALL use named assertions (`(assert (! expr :named label))`) to enable unsat-core identification, and SHALL include `(set-option :produce-unsat-cores true)` as the first solver command.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Quality Attributes`

#### Scenario: Sort And Function Deduplication [FLA-SPEC-DEDUP]
WHEN multiple claims from the same spec declare identical sort or function names with identical signatures, THE spec-check tool SHALL emit only one declaration in the combined output.

**Postcondition:** The combined SMT-LIB file has no duplicate declarations from compatible claims.

#### Scenario: Function Signature Conflict Detection [FLA-SPEC-CONFLICT]
IF two claims from the same spec declare the same function name with incompatible signatures, THEN THE spec-check tool SHALL emit a `logic.merge_conflict` finding, SHALL exclude the conflicting claim from the combined file, and SHALL preserve both claim identifiers in the finding evidence.

**Postcondition:** Signature conflicts are surfaced as findings rather than producing malformed solver input.

#### Scenario: Named Assertion Labels Map To Claims [FLA-SPEC-NAMED]
WHEN the spec-check tool generates named assertions in the combined SMT-LIB, THE label for each assertion SHALL encode the source claim identifier and assertion index so that unsat-core results can be mapped back to specific claims.

**Postcondition:** The assertion-name-to-claim-ID mapping is deterministic and reversible.

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

#### Scenario: Single Solver Command Per Implication Query [FLA-CLUSTER-QUERY]
WHEN the spec-check tool constructs a pairwise implication query to test whether sample A entails sample B, THE query SHALL assert A's declarations and assertions as the premise, SHALL assert the negation of B's assertions as the consequent test, and SHALL contain exactly one `(check-sat)` command at the end.

**Postcondition:** Each implication query produces exactly one solver result; multiple `(check-sat)` commands cannot produce ambiguous or contradictory output within a single query.

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

### Requirement: Run Per-Spec Combined Solver Analysis [FLA-RUN-LOGIC]
WHEN formal artifacts are available, THE spec-check tool SHALL group representative claims by source spec file, SHALL compile each group into a single combined SMT-LIB file with named assertions, SHALL invoke Z3 once per spec group with unsat-core support, and SHALL classify contradictions with severity derived from the highest-obligation claim in the unsat core.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Quality Attributes`

#### Scenario: Report Contradiction With Unsat-Core Identification [FLA-LOGIC-CORE]
WHEN a per-spec combined query returns unsat, THE spec-check tool SHALL parse the unsat core to identify the specific conflicting claims, SHALL report a `logic.contradiction` finding referencing those claims, and SHALL derive severity from the highest-obligation claim in the core (mandatory → error, advisory → warning, informational → info).

**Postcondition:** Reviewers can identify which specific claims within a spec are mutually contradictory.

#### Scenario: Advisory-Only Core Reported At Lower Severity [FLA-LOGIC-ADVISORY]
WHEN the unsat core contains only advisory or informational claims with no mandatory claims, THE spec-check tool SHALL report the contradiction at warning or info severity respectively.

**Postcondition:** Contradictions among advisory claims are visible but clearly distinguished from mandatory violations.

#### Scenario: Preserve Inconclusive Solver Result [FLA-LOGIC-TIMEOUT]
IF the solver returns timeout or unknown for a per-spec query, THEN THE spec-check tool SHALL preserve the inconclusive result as evidence and SHALL emit a `logic.inconclusive` finding at warning severity.

**Postcondition:** Inconclusive logic results remain visible to reviewers and do not masquerade as success.

#### Scenario: Sat Result Indicates Mutual Consistency [FLA-LOGIC-SAT]
WHEN a per-spec combined query returns sat, THE spec-check tool SHALL NOT emit a contradiction finding for that spec, indicating that all claims within the spec are mutually satisfiable.

**Postcondition:** Consistent specs produce no logic findings.

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
WHEN the spec-check tool runs solver analysis, THE spec-check tool SHALL persist all solver inputs (combined per-spec SMT-LIB files) and outputs (stdout including unsat core, stderr, exit classification) verbatim under the output directory with one artifact set per spec group.

**References:**
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Quality Attributes`

#### Scenario: Sat Result Persisted [FLA-PERSIST-SAT]
WHEN a per-spec solver query returns sat, THE spec-check tool SHALL persist the combined SMT-LIB input file and the solver stdout/stderr.

**Postcondition:** The satisfiable result is available for reviewer inspection.

#### Scenario: Unsat Core Persisted [FLA-PERSIST-UNSAT]
WHEN a per-spec solver query returns unsat, THE spec-check tool SHALL persist the combined SMT-LIB input file, the solver stdout (containing the unsat core), and the solver stderr.

**Postcondition:** The contradictory assertion subset (unsat core) is available for reviewer inspection and maps back to specific claims via named assertion labels.

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements
