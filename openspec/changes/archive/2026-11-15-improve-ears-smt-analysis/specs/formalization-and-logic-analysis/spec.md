## MODIFIED Requirements

### Requirement: Formalize Requirement And Scenario Claims Into Logic Artifacts [FLA-FORMALIZE-CLAIMS]
WHEN admitted requirement and scenario claims are available, THE spec-check tool SHALL formalize source-established clause predicates against a frozen semantic-group registry while preserving source identity, modality, provenance, and explicit analyzed scope.

**Postcondition:** Attached claim context retains parser-owned subject, form and scenario kind on batch, singleton recovery and additional-sample paths. Context is not an extra response predicate slot; source modality and negation remain deterministic.

**References:**
- [Design: Interaction Protocols](../../design.md#interaction-protocols)
- [Design: Interface Contracts](../../design.md#interface-contracts)

#### Scenario: Generate Inspectable Logic Artifacts [FLA-FORMAL-ARTS]
WHEN a claim is formalized, THE spec-check tool SHALL persist raw attempts, accepted typed predicates, source-derived semantic rules, registry identity, and compiled artifacts linked to its source clauses.

#### Scenario: Abort On Complete Formalization Failure [FLA-FORMAL-FAIL]
IF attempted eligible claims produce zero candidates after bounded recovery, THEN THE spec-check tool SHALL preserve their attempt evidence and SHALL abort specs-forward formalization with `FormalizationError` exit `9`.

#### Scenario: Continue With Partial Formalization Results [FLA-FORMAL-PARTIAL]
IF some eligible claims fail while others produce candidates, THEN THE spec-check tool SHALL continue with candidates and SHALL report per-claim failures and incomplete analyzed scope.

#### Scenario: Universal LLM Timeout For Formalization [FLA-FORMAL-TIMEOUT]
WHEN discovery or formalization invokes the external model, THE spec-check tool SHALL use the run-configured universal LLM timeout and existing bounded retry policy.

#### Scenario: Semantic Groups May Span Provenance Files [FLA-FORMAL-SPAN]
WHEN one merged capability contains claims from multiple files, THE spec-check tool SHALL use one semantic group and frozen registry while preserving each source span.

#### Scenario: All-Ineligible Input Completes Diagnostics [FLA-FORMAL-NO-ELIGIBLE]
WHEN source admission yields no eligible claims, THE spec-check tool SHALL skip formalization model calls and SHALL complete diagnostic reporting with no formal verdict rather than fabricate candidates or treat source ineligibility as an adapter failure.

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) checks source admission, candidate/error partition, immutable frozen registry use, and handled completion. It abstracts the model response and does not prove translation fidelity.

### Requirement: Formalization Sample Schema Validation [FLA-VALIDATE-SAMPLE]
WHEN a clause interpretation is received, THE spec-check tool SHALL validate its source index, registry hash, expected clause slots, complete expressions, symbol resolution, sorts, units, arity, and supported fragment before admitting it to clustering.

**References:**
- [Design: Expression and semantic IR](../../design.md#expression-and-semantic-ir)

#### Scenario: Valid Sample Accepted [FLA-SAMPLE-ACCEPT]
WHEN every expected clause predicate validates against the frozen signature, THE spec-check tool SHALL construct the rule skeleton and modality from the source AST and SHALL accept the typed sample.

#### Scenario: Invalid Sample Rejected [FLA-SAMPLE-REJECT]
IF a sample has undeclared references, wrong sorts/units/arity, missing or duplicate clause slots, unsupported operators, trailing expressions, or solver commands, THEN THE spec-check tool SHALL reject it before solver execution and SHALL preserve the raw response and validation reason.

#### Scenario: Same-Claim Declaration Collisions Rejected [FLA-SAMPLE-SAMECLAIM]
IF a sample attempts conflicting or duplicate declarations or shadows a registry/builtin symbol, THEN THE spec-check tool SHALL reject it without changing the frozen signature.

#### Scenario: All Samples Invalid After Retries [FLA-SAMPLE-EXHAUST]
IF a claim exhausts bounded attempts without a valid sample, THEN THE spec-check tool SHALL return one claim error and SHALL preserve all rejected attempts while successful siblings continue.

#### Scenario: Logical Inconsistency Is Not Schema Invalidity [FLA-SAMPLE-INCONSISTENT]
WHEN a type-valid predicate is logically inconsistent, THE spec-check tool SHALL retain it for inconsistency diagnosis rather than discard it as a parsing or type error.

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) gates execution on typed/compatible query inputs. Independent expression/type/fragment oracles establish the validity of that gate in implementation.

### Requirement: SMT-LIB Compilation And Identifier Sanitization [FLA-SMTLIB-COMPILE]
WHEN typed semantic artifacts are compiled, THE spec-check tool SHALL render resolved AST nodes with injective namespaced identifiers, reversible source mappings, and declarations/assertions only.

**References:**
- [Design: Expression and semantic IR](../../design.md#expression-and-semantic-ir)

#### Scenario: Unsafe Identifier Sanitized [FLA-SMTLIB-SANITIZE]
WHEN an identifier needs escaping, THE spec-check tool SHALL preserve the existing Unicode-code-point encoding using `_` and six uppercase hexadecimal digits with reversible mapping comments.

#### Scenario: Valid Identifier Preserved [FLA-SMTLIB-PRESERVE]
WHEN the injective identifier encoder receives a non-digit-leading ASCII alphanumeric identifier, THE spec-check tool SHALL preserve that identifier's characters within its assigned namespace.

#### Scenario: Compiled Output Excludes Solver Commands [FLA-SMTLIB-QUERYSAT]
WHEN reusable SMT-LIB is compiled, THE spec-check tool SHALL omit `check-sat`, `set-option`, model/core requests, and other query commands until query assembly.

#### Scenario: Assertion Expressions Exposed [FLA-SMTLIB-ASSERTEXPRS]
WHEN compilation completes, THE spec-check tool SHALL expose typed predicate/assertion structures and their rendered expressions so downstream builders do not reparse emitted SMT-LIB.

#### Scenario: Literal Contents Are Not Renamed [FLA-SMTLIB-LITERALS]
WHEN the expression parser encounters literal content, THE spec-check tool SHALL preserve its lexical meaning without identifier substitution and SHALL reject unsupported literal sorts before compilation.

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) captures query admission, not identifier encoding. Injectivity, literal preservation, and absence of embedded commands require encoder properties and real-Z3 integration checks.

### Requirement: Per-Spec Combined SMT-LIB Compilation [FLA-SPEC-COMBINE]
WHEN a merged capability's admitted mandatory rules are compiled, THE spec-check tool SHALL construct a checked shared signature and named assertions with an authoritative surviving-claim set while separating reusable compilation from query commands.

**References:**
- [Design: Concepts and assumptions](../../design.md#concepts-and-assumptions)
- [Design: Expression and semantic IR](../../design.md#expression-and-semantic-ir)

#### Scenario: Variable And Function Deduplication [FLA-SPEC-DEDUP]
WHEN compatible declarations refer to the same resolved concept, THE spec-check tool SHALL emit one declaration and SHALL retain all compatible claims, including in clustering and cross-side queries.

#### Scenario: Function Signature Conflict Detection [FLA-SPEC-CONFLICT]
IF a residual compiler input conflicts with an established function signature, THEN THE spec-check tool SHALL emit `logic.merge_conflict`, exclude the later offending claim, and preserve both signatures and source identities.

#### Scenario: Variable Sort Conflict Detection [FLA-SPEC-VARSORT-CONFLICT]
IF a residual compiler input conflicts with an established variable sort, THEN THE spec-check tool SHALL emit `logic.merge_conflict` for `variable_sort_mismatch` and SHALL exclude the later offending claim with both sorts preserved.

#### Scenario: Symbol Kind Collision Detection [FLA-SPEC-SYMKIND-CONFLICT]
IF residual declarations bind one solver symbol as both constant and function, THEN THE spec-check tool SHALL report `symbol_kind_collision` and SHALL exclude the offending claim.

#### Scenario: Single Conflict Reason With Fixed Precedence [FLA-SPEC-CONFLICT-ORDER]
IF a residual offending claim has multiple declaration conflict kinds, THEN THE spec-check tool SHALL retain one compiler exclusion reason in the existing variable-sort, function-signature, then symbol-kind precedence.

**Postcondition:** These defensive compiler exclusions do not authorize first-wins resolution of ambiguous semantic identities during concept discovery.

#### Scenario: Surviving Claim Set Is Authoritative [FLA-SPEC-CLAIMIDS]
WHEN compilation excludes claims, THE spec-check tool SHALL expose the exact surviving set in input order and SHALL use that set for assertions, dependencies, labels, and downstream scope accounting.

#### Scenario: Duplicate Claim Identifier Rejected Before Solver Execution [FLA-SPEC-DUPLICATE-CLAIM-ID]
IF a compile group violates the existing raw or sanitized claim-label uniqueness precondition, THEN THE spec-check tool SHALL report `logic.invalid_group` before compilation or solver execution without merging distinct source-local claims.

#### Scenario: Oversized Compile Group Rejected Before Solver Execution [FLA-SPEC-GROUP-BOUNDS]
IF a compile group exceeds its claim or declaration bounds, THEN THE spec-check tool SHALL report `logic.invalid_group` before compilation, solver-artifact writing, or solver execution for that group while valid siblings proceed.

#### Scenario: Dangling Assertion Reference Becomes Solver Error [FLA-SPEC-DANGLING-REF]
IF a dependency becomes unresolved after exclusion, THEN THE spec-check tool SHALL mark dependent formal scope invalid before querying and SHALL preserve the unresolved-reference evidence rather than deliberately delegate detection to Z3.

**Postcondition:** The historical scenario identifier is retained, but its solver-error-only behavior is replaced by early dependency validation; unexpected solver rejection remains a backstop.

#### Scenario: Untrusted Comment Text Stays Inert [FLA-SPEC-COMMENT-SAFE]
WHEN mapping comments contain untrusted text, THE spec-check tool SHALL neutralize line breaks so the text cannot introduce solver commands.

#### Scenario: Named Assertion Labels Map To Claims [FLA-SPEC-NAMED]
WHEN assertions are named, THE spec-check tool SHALL map every unique label to an included source-local claim and assertion index with authored IDs retained as display metadata.

#### Scenario: Assertion Label Encoding Is Injective [FLA-SPEC-LABEL-ENCODE]
WHEN labels are encoded, THE spec-check tool SHALL preserve the existing injective identifier mapping and an unambiguous assertion-index separator while separating concept, constructor, and assertion namespaces.

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) checks admitted candidate ownership and compatible query prerequisites. Shared-signature uniqueness and exclusion behavior require declaration/IR contract tests and the independent semantic corpus.

### Requirement: Surface Ambiguity Through Sample Clustering [FLA-CLUSTER-AMBIG]
WHEN multiple candidate interpretations exist, THE spec-check tool SHALL compare compatible candidates under a satisfiable background and SHALL qualify stability by the frozen registry, sample count, and measured equivalence evidence.

**References:**
- [Design: Clustering and alignment](../../design.md#clustering-and-alignment)

#### Scenario: Select Stable Interpretation [FLA-CLUSTER-STABLE]
WHEN a nonvacuous equivalence cluster meets the configured stability threshold, THE spec-check tool SHALL select its highest-confidence candidate with deterministic input-index tie-breaking and SHALL preserve evidence and registry-dependent qualifications.

#### Scenario: Surface Divergent Interpretations [FLA-CLUSTER-DIVERGE]
IF no compatible nonvacuous cluster meets the threshold, THEN THE spec-check tool SHALL preserve alternatives and SHALL label any diagnostic representative analysis interpretation-dependent rather than authoritative.

**Postcondition:** Selected artifacts retain single/stable/unstable assessment, sample count, selected input index and cluster membership on both source sides, including downstream evidence and comparisons. Single samples are not measured stable.

#### Scenario: Inconclusive Implication Check Preserved [FLA-CLUSTER-INCON]
IF an equivalence query returns timeout, unknown, or error, THEN THE spec-check tool SHALL preserve that outcome without treating the pair as equivalent or proved distinct.

**Postcondition:** Only an UNSAT sample premise is categorized as inconsistent. Unknown, timeout, and error premises are inconclusive; admission-skipped premises are unassessed. Dependent equivalence checks remain blocked scope rather than proof of inconsistency.

#### Scenario: Single Solver Command Per Implication Query [FLA-CLUSTER-QUERY]
WHEN compatible satisfiable samples A and D are compared, THE spec-check tool SHALL emit one shared declaration signature and the formula `B and A and not(D)` with exactly one `check-sat` per implication script.

#### Scenario: Impossible Samples Do Not Establish Stable Meaning [FLA-CLUSTER-VACUOUS]
IF samples are inconsistent under the background, THEN THE spec-check tool SHALL identify their inconsistency separately and SHALL NOT use their vacuous mutual implication to claim stable intended meaning.

#### Scenario: Single Sample Does Not Establish Agreement [FLA-CLUSTER-SINGLE]
WHEN only one valid sample exists, THE spec-check tool SHALL report a selected interpretation and sample count without claiming observed cross-sample stability.

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) prohibits favorable outcomes without premise satisfiability. The [finite static model](../../models/static-semantics.als) defines nonvacuous set equivalence over the explicit background; its assertion replaces an abstraction that could group impossible samples through vacuous implication. Cluster construction is additionally checked against the independent oracle.

### Requirement: Run Per-Spec Combined Solver Analysis [FLA-RUN-LOGIC]
WHEN static semantic artifacts are available, THE spec-check tool SHALL analyze each merged capability under explicit background premises and separate mandatory, advisory, permission, and scenario tracks with valuation-based result meanings.

**References:**
- [Design: Static query contracts](../../design.md#static-query-contracts)

#### Scenario: Report Contradiction With Unsat-Core Identification [FLA-LOGIC-CORE]
WHEN `B and C` is UNSAT after a satisfiable background check, THE spec-check tool SHALL report a mandatory `logic.contradiction` and SHALL attempt a source-mapped sufficient unsat core without calling it minimal unless minimized.

#### Scenario: Advisory-Only Core Reported At Lower Severity [FLA-LOGIC-ADVISORY]
WHEN an advisory extension conflicts with the mandatory baseline or other advisories, THE spec-check tool SHALL report the advisory conflict at warning severity without declaring the mandatory model inconsistent because of the advisory addition.

#### Scenario: Preserve Inconclusive Solver Result [FLA-LOGIC-TIMEOUT]
IF a required static query returns timeout or unknown, THEN THE spec-check tool SHALL preserve it and SHALL emit a warning-scoped inconclusive outcome instead of a clean result.

#### Scenario: Sat Result Triggers Deeper Analysis [FLA-LOGIC-SAT]
WHEN the mandatory global query is SAT, THE spec-check tool SHALL describe a shared satisfying valuation and SHALL plan bounded guard, activation, self-response, pair, coverage, permission, and scenario checks where their prerequisites hold.

#### Scenario: Solver Error Produces Finding [FLA-LOGIC-ERROR]
IF Z3 emits an error diagnostic even alongside SAT or UNSAT, THEN THE spec-check tool SHALL classify the query as an error and SHALL preserve the exact script and captured outputs.

#### Scenario: Inconsistent Background Blocks Favorable Conclusions [FLA-LOGIC-BACKGROUND]
IF the background is UNSAT, THEN THE spec-check tool SHALL report inconsistent premises and SHALL block dependent favorable coverage, implication, stability, and feasibility conclusions.

#### Scenario: Failed Core Extraction Preserves Original Outcome [FLA-LOGIC-CORE-FAIL]
IF an auxiliary core query fails after an UNSAT primary query, THEN THE spec-check tool SHALL preserve both executions and the original UNSAT outcome with attribution explicitly unavailable.

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) checks admission and evidence ordering. The [finite static model](../../models/static-semantics.als) defines mandatory-only allowed valuations and demonstrates activation conflicts despite global satisfiability. This replaces severity-only and unconditional-versus-conditional model shortcuts; arithmetic/type semantics remain independent fixture obligations.

### Requirement: Pairwise Guard-Activation Contradiction Checking [FLA-PAIRWISE]
WHEN prerequisite static queries permit co-activation analysis, THE spec-check tool SHALL select bounded pairs using typed dependencies and SHALL check guard coexistence before testing the full mandatory set under both guards.

**References:**
- [Design: Static query contracts](../../design.md#static-query-contracts)

#### Scenario: Conditional Contradiction Detected [FLA-PAIRWISE-CONTRA]
WHEN `B and G_i and G_j` is SAT and adding `C` is UNSAT, THE spec-check tool SHALL report `logic.conditional_contradiction` with the selected activation and actual sufficient conflicting rules.

#### Scenario: Compatible Conditional Assertions Produce No Finding [FLA-PAIRWISE-COMPAT]
WHEN co-active guards and the mandatory constraints admit a shared valuation, THE spec-check tool SHALL omit a pair-conflict finding without claiming that every input in the guard region has a valid response.

#### Scenario: Pairwise Check Bounded By Pair Count [FLA-PAIRWISE-BOUND]
WHEN candidate pairs exceed effective `pairBudget` with default 200, THE spec-check tool SHALL execute only the deterministic admitted prefix and SHALL report remaining scope while using the shared run-wide solver pool.

**Postcondition:** A candidate is a pair surviving the conservative dependency-component filter. Examining an admitted candidate consumes one pair allowance before guard-feasibility/co-activation results; compatible, infeasible, and unestablished candidates still count. This is not a findings quota or an actual-script counter. Unissued co-activation/conflict plans are reported with prerequisite or admission reasons, compactly aggregated where needed. Advisory pair examinations have their own bounded prefix; all actual scripts additionally consume the shared script allowance.

#### Scenario: Severity Derived From Paired Claims [FLA-PAIRWISE-SEV]
WHEN a mandatory-track co-activation conflict is established, THE spec-check tool SHALL derive attribution from its actual sufficient core and SHALL report it as an error while advisory-track conflicts remain warnings.

**Postcondition:** A multi-rule core is not falsely attributed only to the selected pair.

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) checks query/evidence controls. The [finite static model](../../models/static-semantics.als) has a positive three-rule activation-conflict witness with each response pair satisfiable, replacing pair-only consistency assumptions. Actual query/core construction is checked by the independent oracle.

### Requirement: Completeness Gap Detection [FLA-COMPLETENESS]
WHEN an explicit coverage obligation identifies applicability predicate K and a behavior family with guards, THE spec-check tool SHALL search for `B and K and not(or guards)` and SHALL report its outcome as scoped guard coverage over valuations.

**References:**
- [Design: Static query contracts](../../design.md#static-query-contracts)

#### Scenario: Gap Detected In All-Conditional Spec [FLA-COMPLETENESS-GAP]
WHEN the scoped coverage query is SAT, THE spec-check tool SHALL report `logic.completeness_gap` with a decoded uncovered valuation, applicability domain, behavior family, and included/excluded rule scope.

#### Scenario: No Gap When Ubiquitous Assertions Exist [FLA-COMPLETENESS-UBIQ]
WHEN a group contains ubiquitous assertions unrelated to the selected behavior family, THE spec-check tool SHALL continue the scoped coverage query rather than suppress coverage for the entire group.

**Postcondition:** The historical unconditional-suppression behavior is intentionally replaced; a relevant ubiquitous behavior rule may cover its own family.

#### Scenario: Exhaustive Guards Produce No Gap Finding [FLA-COMPLETENESS-EXHAUST]
WHEN the scoped coverage query is UNSAT under satisfiable premises, THE spec-check tool SHALL report no uncovered valuation in that scope without claiming response completeness or temporal reachability.

#### Scenario: Missing Coverage Expectation Is A Suggestion [FLA-COVERAGE-POTENTIAL]
WHEN a guard-gap search has no explicit applicability expectation, THE spec-check tool SHALL label any result a potential gap for review rather than a proven completeness defect or missing idle behavior.

#### Scenario: Inconclusive Coverage Remains Visible [FLA-COVERAGE-UNKNOWN]
IF coverage is skipped, blocked, timed out, or unknown, THEN THE spec-check tool SHALL record that scope as unestablished rather than exhaustive.

#### Requirement model

The [finite static model](../../models/static-semantics.als) computes gaps relative to explicitly selected behavior-family guards and applicability valuations, replacing global unconditional-assertion suppression. The [analysis lifecycle model](../../models/analysis-lifecycle.als) retains nonvacuity controls. Neither model asserts reachability or assumes desired coverage verdicts as facts.

### Requirement: Solver Evidence Persistence [FLA-SOLVER-PERSIST]
WHEN a solver script executes, THE spec-check tool SHALL persist its exact commands, checked signature and assumptions, source attribution, captured stdout/stderr, solver identity/options, and terminal status under a stable query identifier.

**References:**
- [Design: Interface Contracts](../../design.md#interface-contracts)

#### Scenario: Sat Result Persisted [FLA-PERSIST-SAT]
WHEN a query is SAT, THE spec-check tool SHALL preserve the executed script including `check-sat`, its outputs, and any separately executed witness/model script and decoding status.

**Postcondition:** Value decoding requires an exact standalone top-level SAT verdict supporting LF or CRLF output. Missing/non-SAT verdicts, duplicate bindings, malformed scalar values, and unexpected symbols cannot become a complete witness. Completeness refers to the explicitly requested scalar names; partial and unavailable decoding remain distinct from complete assignment evidence. Raw stdout is preserved unchanged.

#### Scenario: Unsat Core Persisted [FLA-PERSIST-UNSAT]
WHEN a query is UNSAT, THE spec-check tool SHALL preserve the primary script and outputs plus every executed core-extraction script, output, and label mapping.

#### Scenario: Deeper And Failed Queries Are Persisted [FLA-PERSIST-ALL]
WHEN clustering, activation, pair, coverage, advisory, permission, scenario, or comparison scripts execute, THE spec-check tool SHALL preserve each execution even if it errors, times out, is unknown, or fails auxiliary extraction.

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) checks that executed queries are captured and persisted before completion and favorable publication. Raw-byte preservation and filesystem atomicity require adapter fault-injection tests.

### Requirement: Dedicated Attached-Context Prompt [FLA-ATTACH-PROMPT]
WHEN a multi-claim attached attempt is issued, THE spec-check tool SHALL use a dedicated predicate-formalization prompt with the current wire schema, source-index matching, frozen registry hash, untrusted-data instruction, and source-owned clause slots without embedding claim bodies inline.

**References:**
- [Design: Interaction Protocols](../../design.md#interaction-protocols)

#### Scenario: Prompt References Attached Context [FLA-ATTACHP-REFERENCES]
WHEN an attached attempt begins, THE spec-check tool SHALL identify attached claim/context data as the only claim-text source and SHALL keep claim bodies out of the instruction prompt.

#### Scenario: Attached JSON Marked Untrusted [FLA-ATTACHP-UNTRUSTED]
WHEN JSON is attached, THE spec-check tool SHALL state that its text, registry descriptions, and predicate content are untrusted data rather than instructions.

#### Scenario: No Stale Same-File Language [FLA-ATTACHP-NO-STALE]
WHEN semantic-group claims span files, THE spec-check tool SHALL avoid stale same-file or presented-below wording.

#### Scenario: Response Matching Authority Stated [FLA-ATTACHP-MATCHING]
WHEN a batch is formalized, THE spec-check tool SHALL require exactly one entry per attached eligible index and SHALL state that display IDs and array position are not response-matching authority.

#### Scenario: Response Index Validated [FLA-ATTACHP-INDEX-VALID]
IF response indexes are missing, unknown, duplicated, or incomplete, THEN THE spec-check tool SHALL preserve the raw response and SHALL follow existing bounded schema-failure degradation without changing registry or source identity.

## ADDED Requirements

### Requirement: Freeze Evidence-Backed Capability Concepts [FLA-CONCEPT-FREEZE]
WHEN eligible claims are prepared for formalization, THE spec-check tool SHALL perform one bounded discovery pass per semantic group and source side, reconcile candidates deterministically, and freeze a registry before dependent batches start.

**References:**
- [Design: Concepts and assumptions](../../design.md#concepts-and-assumptions)

#### Scenario: Every Sample Uses The Same Registry [FLA-CONCEPT-SHARED]
WHEN batches, inline calls, retries, fallbacks, or additional samples run, THE spec-check tool SHALL supply the same immutable registry and content hash for their semantic group.

#### Scenario: Missing Concepts Do Not Mutate Frozen State [FLA-CONCEPT-MISSING]
IF a predicate proposes an undeclared concept, THEN THE spec-check tool SHALL preserve the proposal and SHALL mark dependent formal scope unresolved without extending the frozen registry.

#### Scenario: Discovery Completion Order Is Irrelevant [FLA-CONCEPT-ORDER]
WHEN fixed discovery responses complete in different worker orders, THE spec-check tool SHALL produce identical registry bytes and identity-resolution outcomes using source-order reconciliation.

#### Scenario: Conflicting Explicit Concepts Are Not First-Wins [FLA-CONCEPT-COLLISION]
IF explicit concept keys have incompatible signatures, roles, scope, or units, THEN THE spec-check tool SHALL report a model-validation conflict and SHALL block dependent bindings rather than silently select one.

### Requirement: Separate Identity From Assumption Authority [FLA-PREMISE-AUTHORITY]
WHEN concept or background candidates are considered, THE spec-check tool SHALL distinguish explicit identities, grounded model-proposed identities, unresolved identities, and explicitly admitted domain premises.

**References:**
- [Design: Concepts and assumptions](../../design.md#concepts-and-assumptions)

#### Scenario: Plausible Domain Knowledge Remains A Proposal [FLA-PREMISE-INFERRED]
IF discovery proposes positivity, mode exclusivity, exhaustive alternatives, or other domain facts without explicit authority, THEN THE spec-check tool SHALL preserve them as proposals without adding them to background B.

#### Scenario: Enum Requires Declared Meaning [FLA-PREMISE-ENUM]
WHEN finite enum encoding is selected, THE spec-check tool SHALL require explicit evidence of exclusivity and exhaustiveness and SHALL otherwise retain a weaker or unresolved representation.

#### Scenario: Proposed Identity Qualifies Stability [FLA-PREMISE-CONDITIONAL]
WHEN a registry accepts grounded model-proposed identity alignment, THE spec-check tool SHALL label dependent interpretation agreement and conclusions conditional on that alignment rather than independently validated natural-language fidelity.

### Requirement: Enforce A Conservative Typed Solver Fragment [FLA-TYPED-FRAGMENT]
WHEN expressions or assembled queries are admitted, THE spec-check tool SHALL enforce the supported quantifier-free Boolean, finite-enum, exact linear integer/real, and typed uninterpreted-function fragment with explicit sort coercions and units.

**References:**
- [Design: Expression and semantic IR](../../design.md#expression-and-semantic-ir)
- [Design: Resource bounds and encoding](../../design.md#resource-bounds-and-encoding)

#### Scenario: Numeric Values Remain Exact [FLA-TYPED-EXACT]
WHEN an integer, rational, or unit conversion is processed, THE spec-check tool SHALL preserve exact canonical values without JavaScript floating-point rounding.

#### Scenario: Unsupported Meaning Is Not Approximated [FLA-TYPED-UNSUPPORTED]
IF a claim requires nonlinear products, division/remainder, strings, quantifiers, collections, recursive datatypes, or temporal timing, THEN THE spec-check tool SHALL report unsupported scope rather than replace the required meaning with an opaque proposition or weaker arithmetic.

#### Scenario: Whole Query Features Are Checked [FLA-TYPED-COMBINED]
WHEN individually accepted expressions are combined, THE spec-check tool SHALL classify and validate the assembled feature set before invoking Z3.

### Requirement: Separate Mandatory Advisory And Permission Tracks [FLA-MODAL-TRACKS]
WHEN rules are analyzed, THE spec-check tool SHALL place only mandatory obligations in C and SHALL evaluate advisory obligations and explicit permissions in separate tracks.

**References:**
- [Design: Static query contracts](../../design.md#static-query-contracts)

#### Scenario: Advisory Conflict Does Not Poison Mandatory Model [FLA-MODAL-ADVISORY]
WHEN an advisory extension conflicts with a satisfiable mandatory baseline, THE spec-check tool SHALL issue a warning-scoped advisory conflict without claiming mandatory global inconsistency.

#### Scenario: Permission Is Not Required Action [FLA-MODAL-PERMISSION]
WHEN a `MAY` response is absent from a satisfying mandatory valuation, THE spec-check tool SHALL omit a missing-response violation for that permission.

#### Scenario: Permission Conflicting With Prohibition Is Visible [FLA-MODAL-PROHIBITION]
WHEN `B and G_p` is SAT but `B and G_p and C and R_p` is UNSAT, THE spec-check tool SHALL report permission infeasibility with its admitted premises and conflicting evidence.

### Requirement: Check Individual Rule Activation Feasibility [FLA-RULE-ACTIVATION]
WHEN mandatory rule checks are planned, THE spec-check tool SHALL test guard satisfiability, self-response feasibility, and full-set activation feasibility under explicit background premises.

**References:**
- [Design: Static query contracts](../../design.md#static-query-contracts)

#### Scenario: Guard Against Unconditional Prohibition [FLA-ACTIVATE-UBIQUITOUS]
WHEN a satisfiable guard demands a response forbidden by an unconditional mandatory rule, THE spec-check tool SHALL report the activation conflict even when the unforced global model is SAT.

#### Scenario: Self-Conflict Needs No Cross-Claim Pair [FLA-ACTIVATE-SELF]
WHEN `B and G_i` is SAT but adding the rule's response is UNSAT, THE spec-check tool SHALL report the self-response conflict without requiring another claim or a shared-symbol pair.

#### Scenario: Multi-Rule Conflict Is Attributed Honestly [FLA-ACTIVATE-MULTI]
WHEN activation is infeasible because of three or more mandatory rules, THE spec-check tool SHALL preserve the actual sufficient core rather than require a contradictory pair.

#### Scenario: Impossible Guard Is Static Vacuity [FLA-ACTIVATE-VACUOUS]
WHEN `B and G_i` is UNSAT, THE spec-check tool SHALL report static guard vacuity under B without claiming temporal unreachability.

### Requirement: Preserve Scenario Logical Meaning [FLA-SCENARIO-MEANING]
WHEN scenario artifacts are formalized, THE spec-check tool SHALL preserve refinement, example, and prohibited-example semantics with scenario-scoped postconditions.

**References:**
- [Design: Static query contracts](../../design.md#static-query-contracts)

#### Scenario: Example Does Not Assert A Global Fact [FLA-SCENARIO-WITNESS]
WHEN a concrete positive example is checked, THE spec-check tool SHALL query `B and C and input and expected` as a witness without adding its concrete input or expected response to every valuation.

#### Scenario: Prohibited Example Checks Allowed Bad Behavior [FLA-SCENARIO-PROHIBITED]
WHEN a prohibited example is checked, THE spec-check tool SHALL report SAT of `B and C and input and forbidden` as allowed prohibited behavior and SHALL report UNSAT only as exclusion within the admitted scope.

### Requirement: Bound Every New Analysis Stage [FLA-ANALYSIS-BOUNDS]
WHEN discovery, expression processing, query planning, or evidence-producing solver work begins, THE spec-check tool SHALL enforce the effective named count, byte, depth, time, and concurrency limits documented in the design.

**References:**
- [Design: Resource bounds and encoding](../../design.md#resource-bounds-and-encoding)

#### Scenario: Enumeration And Solver Work Remain Bounded [FLA-BOUNDS-QUERIES]
WHEN the per-group script ceiling of 1,000 or run-wide solver concurrency ceiling of 16 applies, THE spec-check tool SHALL count clustering, auxiliary, and comparison scripts within the same resource accounting and SHALL report unexecuted scope.

**Postcondition:** The shared per-capability actual-script allowance and run-owned recorder also apply when all original statements are excluded and only generated typed artifacts exist. Empty generated scope executes no scripts.

#### Scenario: Expression Limits Precede Solver Work [FLA-BOUNDS-EXPRESSIONS]
IF an expression exceeds its effective 65,536-byte, 8,192-node, or depth-128 default limit, THEN THE spec-check tool SHALL reject it with attributed evidence before compilation or solver execution.

**Postcondition:** The effective configured limits apply equally to foreground predicates, authored background, and coverage applicability. Cached registry preparation must include the limit tuple or be bound to one limit set; reusing a registry cannot bypass a tighter limit.

#### Scenario: Discovery Limits Are Not Silent Truncation [FLA-BOUNDS-DISCOVERY]
IF discovery exceeds its default 1-MiB group context, 256-KiB chunk, 32-chunk, or 2,048-concept limits, THEN THE spec-check tool SHALL record affected unresolved scope instead of silently omitting concepts.

#### Scenario: Disabling Physical Splitting Does Not Remove Bounds [FLA-BOUNDS-BATCH-ZERO]
WHEN `maxBatchSize` is zero, THE spec-check tool SHALL preserve the single-chunk transport behavior while still enforcing semantic context, expression, query, and evidence bounds.
