# Final Design and Plan: Richer EARS-to-SMT Analysis

## 1. Recommendation and Confirmed Decisions

Build **one improved static analysis engine in place**, using:

- **Plan A's separation of syntax, semantics, and temporal behavior**.
- **Plan B's typed expression parser, validator, and renderer**.
- **Plan C's shared vocabulary**, redesigned as a frozen, evidence-backed concept registry.

Deliver the static engine first. Define temporal analysis as a separate follow-up that requires explicit modeling inputs.

The central design rule is:

> The deterministic engine owns requirement structure and query meaning. The LLM supplies candidate interpretations of clause content. Every conclusion states what those interpretations and queries establish.

### Confirmed product decisions

1. `spec-check` is still in development. Changes can be made in place, using the current version identifiers. A permanent legacy engine, parallel semantic-version profiles, and a compatibility migration are not required.
2. Invariants, behaviors, semantics, and failure modes must be documented through OpenSpec, Alloy models, and lightweight formal methods, aligned with [docs/lfm.md](docs/lfm.md).
3. Ship improved static semantics first. Temporal bounded model checking is a separately gated follow-up.
4. Missing temporal details must come from explicit source declarations or configuration. LLM-proposed details are evidence, not silently admitted premises.
5. Keep embedded Alloy models separate from the EARS-to-SMT pipeline.
6. Adopt the simplified strict EARS parsing approach from [Plan A](smt_ideas_a.md).
7. Give mandatory obligations, advisory obligations, and permissions distinct analysis semantics.
8. Allow a bounded, evidence-preserved concept-discovery pass per capability before claim formalization.

Record exact analysis configuration, source hashes, prompt hashes, and compiler identity so results remain auditable without introducing parallel legacy engines.

## 2. Findings from the Review and Linked Sources

The [review](smt_ideas_review.md) is substantially correct. Richer SMT syntax, shared concepts, and temporal semantics solve different problems and must be designed separately.

### 2.1 Findings confirmed in the implementation

| Finding | Evidence | Design consequence |
| --- | --- | --- |
| EARS classification uses unordered substring matching | [parser/spec.ts](src/domain/parser/spec.ts) | Replace it with a bounded structural parser. |
| EARS structure disappears during claim construction | [claim-graph.ts](src/domain/claim-graph.ts) | Carry clause structure through the claim graph and batch transport. |
| Declarations are typed, but assertion expressions are opaque strings | [logic-ir.ts](src/domain/logic-ir.ts) | Introduce typed expressions rather than merely adding more sorts. |
| Assertion validation checks parentheses, not expression meaning | [formal/validate.ts](src/domain/formal/validate.ts) | Validate symbols, operators, sorts, arity, and the admitted fragment before solving. |
| Sanitization rewrites identifier-like text inside literals | [formal/smtlib.ts](src/domain/formal/smtlib.ts) | Render resolved symbol nodes; never perform textual identifier substitution. |
| Compatible declarations already unify | [formal/smtlib.ts](src/domain/formal/smtlib.ts) | Improve semantic identity before compilation. |
| Current checks establish facts about valuations, not execution traces | [formal/logic-analysis-checks.ts](src/domain/formal/logic-analysis-checks.ts) | Remove reachability claims from static reporting. |

### 2.2 Additional correctness gaps

These belong in the static delivery:

1. **Implication queries need shared-signature construction.** Clustering and cross-side implication can concatenate duplicate declarations. A read-only Z3 probe confirmed that Z3 rejects this, even if it subsequently prints `unsat`.
2. **Guarded-versus-unconditional conflicts are missed.** The pairwise pass selects implication-to-implication pairs. A requirement such as `g => response` can conflict with an unconditional prohibition without making the global model UNSAT.
3. **The parser and prompt disagree about modality.** The parser recognizes `SHALL` patterns, while documentation supports `MUST`, `SHOULD`, and `MAY`. Claim obligation derivation also omits `MUST`.
4. **Generated requirements bypass the source parser.** [gen-formal.ts](src/domain/code-backwards/gen-formal.ts) constructs synthetic mandatory claims directly. The improved pipeline must parse generated requirements through the same structural and modal rules.
5. **Evidence persistence is less complete than the plans assume.** Attached-attempt envelopes preserve pointers and hashes, not complete responses. Deeper static checks currently return findings without durable per-query evidence. Evidence expansion is implementation work, not an already-satisfied prerequisite.

### 2.3 Lessons from external references

- [The EARS author's reference](https://alistairmavin.com/ears/) establishes ordered clauses, `WHERE` as an optional-feature pattern, and complex compositions. The simplified grammar in this plan is **spec-check's chosen EARS profile**, not the whole EARS language.
- [AWS's requirements-analysis article](https://kiro.dev/blog/deep-spec-analysis/) reinforces the value of a shared schema and background domain knowledge. Its published implication encoding does not provide the transition semantics needed for reachability.
- [Claimcheck](https://midspiral.com/blog/claimcheck-narrowing-the-gap-between-proof-and-intent/) reinforces structural separation between independent derivation and comparison. Its results are probabilistic intent checks, not proof that a formalization captures the source.
- The [srs-driven template](https://raw.githubusercontent.com/ohpauleez/openspec_srs-driven/main/openspec/schemas/srs-driven/templates/spec.md) uses EARS scenarios with postconditions. These must be distinguished from concrete example witnesses.
- The [SMT-LIB standard](https://smt-lib.org/language.shtml) the [Z3 Guide](https://microsoft.github.io/z3guide/docs/logic/intro/) and [Programming Z3](https://theory.stanford.edu/~nikolaj/programmingz3.html) support a conservative initial fragment and explicit query contracts.

The adjacent [ontology note](smt_ideas_ontologies.md) is useful motivation for concept alignment, but this plan does not adopt its OWL/RDF subsystem or combined Alloy-to-SMT translation.

## 3. Target Architecture

Use three distinct representations, plus a shared concept registry:

```text
Read-only source documents
          |
          v
Loss-aware document extraction
          |
          v
Surface AST
  EARS clauses, scenarios, modality, source spans
          |
          +--> Concept discovery --> validate/reconcile --> frozen registry
          |                                                    |
          +--------------------------+-------------------------+
                                     v
                          LLM clause interpretation
                                     |
                                     v
                           Typed expression AST
                                     |
                                     v
                              Semantic IR
                      rules / assumptions / scenarios
                                     |
                                     v
                        Query planning and compilation
                                     |
                                     v
                           Z3 + durable evidence
                                     |
                                     v
                        Findings and bounded assessment
```

### Responsibilities

| Representation | Owns |
| --- | --- |
| **Surface AST** | Source structure, clause order, modal, negation, exact spans, scenario fields |
| **Typed expression AST** | Resolved references, literals, applications, operators, sorts |
| **Semantic IR** | Rule guards and responses, assumptions, modal tracks, scenario meaning |
| **Concept registry** | Concept identity, signatures, roles, units, aliases, provenance, uncertainty |

Downstream analyses consume structured artifacts. SMT-LIB becomes an output language, not an internal interchange format that modules repeatedly reparse.

Keep deterministic rules in the domain layer, effects at adapters, and composition in the CLI layer, consistent with [ARCHITECTURE.md](ARCHITECTURE.md).

## 4. Strict Source Parsing

### 4.1 Simplified project EARS profile

The core forms are:

| Form | Structure |
| --- | --- |
| Ubiquitous | `THE system MODAL response.` |
| State-driven | `WHILE state, THE system MODAL response.` |
| Event-driven | `WHEN trigger, THE system MODAL response.` |
| Unwanted-behavior | `IF condition, THEN THE system MODAL response.` |
| Complex | `WHILE state, WHEN trigger, THE system MODAL response.` |

Policy:

- Remove the separate `conditional` classification.
- Recognize `IF/THEN` structurally; remove negative-word heuristics.
- Treat `WHERE` as a documented, explicitly enabled extension.
- Accept `SHALL`, `MUST`, `SHOULD`, and `MAY`.
- Represent response negation explicitly.
- Require ordered clauses, nonempty content, required delimiters, and complete statement consumption.
- Recognize keywords only in structural positions, outside quoted and inline-code content.

`SHALL NOT`, `MUST NOT`, and `SHOULD NOT` have clear negative-response meanings. Ambiguous forms such as `MAY NOT` receive a diagnostic rather than silently becoming prohibitions.

### 4.2 Extract statements before parsing them

A strict parser cannot operate correctly on the current flattened requirement body, which can include models, postconditions, evidence, and supplementary prose.

Extract separately:

- Requirement statement
- References
- Format justification
- Scenario statement and postcondition
- Fenced models and evidence
- Supplementary or unmatched content

Preserve exact source ranges and a mapping from normalized text back to those ranges.

### 4.3 Explicit eligibility

Each extracted claim receives a formal eligibility result:

- Structured EARS
- Supported explicit non-EARS representation
- Ineligible, with reasons

Malformed requirements remain visible in qualitative review, coverage, and reports. They do not enter formalization under a guessed structure.

A justified escape hatch permits another representation; it does not automatically make arbitrary prose solver-ready. Unsupported tables or mathematical forms receive an explicit limitation.

No separate `--strict-ears` switch is needed initially: structural validity is the formalization contract.

## 5. Frozen Capability Concept Registry

Add a bounded discovery pre-pass before claim formalization.

### 5.1 Lifecycle

```text
Merged capability
    -> candidate discovery
    -> deterministic validation and reconciliation
    -> explicit unresolved alternatives
    -> freeze
    -> all formalization batches and samples
```

The pre-pass may use LLM extraction. Determinism means identical inputs and fixed boundary responses produce identical reconciliation, registry bytes, and formalization contexts.

### 5.2 Registry contents

Each concept contains:

- Stable identity within its namespace
- Canonical solver symbol
- Natural-language definition
- Sort
- Units and exact conversion rules
- Semantic role: configuration, state, environment input, event, system output, or derived value
- Capability and entity scope
- Aliases and source spans
- Discovery origin and confidence
- Resolution status and unresolved collisions

Use a lightweight typed registry, not an OWL/RDF reasoning subsystem. Embedded Alloy remains separate.

### 5.3 Identity and assumptions are different

The registry distinguishes:

1. **Naming alignment:** two phrases refer to the same concept.
2. **Domain constraints:** assertions about that concept, such as a quantity being nonnegative.
3. **Behavioral obligations:** what the system must do.

Discovering a duration does not authorize silently asserting that it is positive. Discovering two mode names does not authorize making them an exhaustive enum.

Source-grounded alignments may be accepted under a documented resolution policy. Ambiguous identities remain explicit alternatives or unresolved mappings. Confidence alone must not manufacture domain axioms.

Enums require evidence that their alternatives are mutually exclusive and exhaustive. Otherwise, preserve the weaker representation.

### 5.4 Freeze throughout sampling

Every batch, retry, fallback, and additional sample receives the same registry. A formalizer cannot extend it opportunistically.

If formalization discovers a missing concept:

- Preserve the proposed addition as evidence.
- Mark the affected sample unresolved.
- Use only a bounded, explicitly modeled reconciliation/reformalization cycle if the implementation supports one.

For the first delivery, a single discovery-and-freeze cycle is sufficient. Unresolved concepts produce localized limitations.

Report that interpretation stability is **conditional on the registry**: agreement between samples cannot independently validate a shared mistaken concept mapping.

## 6. Typed Expressions and Deterministic Semantic Construction

### 6.1 Wire format

Keep compact expression strings in the LLM response, but return them **per source clause**, rather than asking the LLM to produce complete assertions.

For example:

```text
state predicate
trigger predicate
response predicate
source-clause references
```

The engine parses these expressions, resolves references against the registry, and constructs the implication itself.

The LLM must not control:

- Source identity or obligation
- EARS clause arrangement
- Whether a response is required or permitted
- Placement of modal negation
- Solver commands
- Temporal interpretation

### 6.2 Validation

The expression boundary checks:

- Exactly one complete expression
- Declared and correctly scoped symbols
- Operator allowlist and arity
- Function argument and result sorts
- Boolean sort for predicates
- Numeric sorts and explicit coercions
- Units and permitted conversions
- Expression size, nesting depth, and declaration bounds
- Admitted solver fragment

Use exact numeral representations: integer strings or `bigint` internally, and rational numerator/denominator values for exact reals. Do not pass mathematical quantities through JavaScript floating-point arithmetic.

Reject solver commands and unsupported constructs structurally. Render only validated AST nodes.

### 6.3 Initial solver fragment

Support:

- Booleans
- Explicit finite enums
- Quantifier-free linear integer arithmetic
- Exact linear real arithmetic where required
- Typed uninterpreted functions where their intentionally unspecified meaning is appropriate

Initially defer:

- Unrestricted strings
- Nonlinear arithmetic
- General quantifiers
- Collections requiring quantified semantics
- Recursive datatypes and arbitrary relational encodings

Multiplication is linear only when at most one operand is nonconstant. Division, remainder, machine overflow, and rounding require separately specified semantics.

The parser is literal-aware from the beginning even where particular literal sorts remain unsupported.

Classify the **assembled query's** feature set, not just individual claims. Supported claims can otherwise combine into an unsupported query.

## 7. Semantic IR and Modality

Represent rules directly:

```text
Rule
  source identity and spans
  activation predicate
  response predicate
  modality
  concept dependencies
  interpretation provenance
```

Assumptions, domain definitions, permissions, and scenarios have separate variants.

### 7.1 Modal tracks

| Modal | Analysis meaning |
| --- | --- |
| `SHALL` / `MUST` | Mandatory constraint |
| `SHOULD` | Advisory obligation, evaluated against the mandatory baseline |
| `MAY` | Explicit permission; never converted into a required response |

Check advisory rules individually against mandatory constraints, and check advisory combinations separately. An advisory conflict must not make the mandatory specification appear inconsistent.

A permission can be tested for feasibility under its guard. If mandatory constraints forbid every realization of the explicitly permitted response, report a permission conflict. A feasible permission does not require the system to exercise it.

Keep modality separate from diagnostic severity. Parser defects, unsupported expressions, solver uncertainty, and behavioral conflicts have different severity policies.

### 7.2 Scenario semantics

Do not assign all scenarios one logical interpretation merely because they share a Markdown heading.

- **EARS scenario refinements:** guarded obligations, consistent with the srs-driven schema.
- **Explicit concrete examples:** satisfiability witnesses under stated inputs.
- **Explicit prohibited examples:** exclusion checks.
- **Postconditions:** structured consequences associated with their scenario, not detached global facts.

A concrete example must not become an unconditional assertion about every valuation.

## 8. Correct Static Analyses

Let:

- `B` be admitted domain constraints and explicit environment assumptions.
- `G_i` be rule `i`'s activation predicate.
- `R_i` be its required response.
- `C` be the conjunction of mandatory rules.

Each query template has a documented meaning, preconditions, result interpretation, and evidence contract.

### 8.1 Background consistency

Check `SAT(B)` first.

If the background is inconsistent, subsequent implication and coverage results are vacuous. Report the inconsistent assumptions and suppress conclusions that depend on their satisfiability.

### 8.2 Global consistency

Check `SAT(B and C)`.

- `UNSAT`: the formalized mandatory constraints have no shared valuation.
- `SAT`: at least one shared valuation exists.

Do not describe `SAT` as proof that the requirements admit an implementation for every allowed input.

### 8.3 Guard satisfiability and activation feasibility

For each rule:

1. Check `SAT(B and G_i)`.
2. If satisfiable, check `SAT(B and G_i and C)`.

This distinguishes:

- An impossible guard under the admitted background
- A possible activation that cannot coexist with the mandatory requirement set
- An activation with at least one compatible response valuation

This catches guarded-versus-unconditional conflicts and conflicts involving more than two rules.

Also check a rule's own response feasibility where useful, so self-conflicts receive precise attribution.

### 8.4 Co-activation conflicts

For selected pairs:

1. Check whether their guards can coexist under `B`.
2. Check whether the mandatory constraints permit that co-activation.
3. Extract a source-mapped unsat core when the second query is UNSAT.

Use AST dependencies for candidate selection. Treat dependency filtering as an optimization with documented limitations, not a completeness argument.

An unsat core is a sufficient conflicting subset; do not call it minimal unless minimization was actually performed.

### 8.5 Coverage

Replace the current group-wide heuristic with **coverage obligations scoped to a behavior or response family**.

For an explicitly identified applicability domain `K`, check:

```text
B and K and not (G_1 or ... or G_n)
```

A satisfying model is a valuation uncovered by those guards.

Policies:

- An unrelated ubiquitous constraint does not suppress coverage analysis.
- Idle valuations are not automatically missing behavior.
- Guard exhaustiveness does not prove that responses fully specify behavior.
- Without an explicit coverage expectation, report a potential gap for review rather than a proven completeness defect.
- Excluded or unresolved rules make the analyzed scope partial.

### 8.6 Scenario and permission checks

Check examples, prohibited examples, and permissions through their dedicated semantics. Persist witness assignments or conflicting cores.

### 8.7 Strength boundary

Quantifier-free satisfiability does not establish the general obligation:

```text
For every allowed input, there exists a valid system response.
```

The first delivery explicitly documents this limitation. It may exhaustively analyze finite input domains within a declared budget, but sampled integer valuations must not be presented as exhaustive realizability analysis.

## 9. Clustering and Source-Backed Comparison

These are part of completing the static upgrade, although they follow the foundational changes.

### 9.1 Shared query construction

Use one checked signature builder for:

- Global analysis
- Activation checks
- Clustering
- Cross-side implication

It deduplicates compatible declarations, rejects incompatible signatures, namespaces enum constructors, and emits declarations in deterministic dependency order.

Remove SMT-LIB line parsing from the production comparison path. Compare structured semantic artifacts directly.

### 9.2 Clustering

Compare candidates under the same registry and admissible background.

Before treating mutual implication as interpretation agreement:

- Establish that the background is satisfiable.
- Identify inconsistent candidates separately.
- Preserve unknown/error outcomes.
- Avoid treating multiple inconsistent encodings as evidence of a stable intended interpretation.
- Report sample count and shortfalls.

A single sample is a selected interpretation, not evidence of cross-sample stability.

If no stable interpretation exists, preserve alternatives and mark downstream conclusions interpretation-dependent. Do not silently turn the first sample into an authoritative specification.

### 9.3 Cross-side alignment

Preserve the blind boundary:

1. Generate code-derived requirements independently.
2. Parse and formalize them through the same structural pipeline.
3. Discover their registry independently.
4. Freeze both sides.
5. Produce a separate alignment artifact.
6. Translate aligned concepts into a checked joint signature.

The alignment artifact records aliases, sort compatibility, units, scope, and unresolved mappings. It must not feed original-spec concepts back into source-derived generation.

Before implication, require compatible assumptions and nonvacuous premises. An inconsistent code-derived premise must not earn a favorable `stronger` verdict.

Use distinct outcomes for:

- Aligned semantic relationship
- Unmapped concepts
- Incompatible models
- Partial comparison
- Solver uncertainty

An LLM explanation may supplement these outcomes, but cannot convert an unmapped or inconclusive comparison into solver-established equivalence.

## 10. Evidence and Operational Contracts

Retain current version identifiers. Add precise content identity rather than a parallel legacy-engine scheme.

### 10.1 Durable evidence

Persist:

- Source and selected-input hashes
- Surface AST and source spans
- Eligibility decisions
- Candidate and frozen registries
- Registry resolution decisions
- Raw formalization responses and validation failures
- Accepted typed expressions and semantic IR
- Prompt/configuration/compiler fingerprints
- Exact solver query text
- Solver version, options, stdout, stderr, and terminal status
- Decoded assignments and unsat-core mappings
- Comparison alignment maps
- Planned, executed, skipped, and inconclusive check counts

Keep pointer-only attempt metadata separate from raw-response artifacts. Persist accepted and rejected responses across attached, inline, retry, and complete-failure paths.

Every query needs a stable identifier and source attribution. The persisted query includes the commands actually sent to Z3; a declaration/assertion fragment alone is insufficient replay evidence.

### 10.2 Bounds

Document and enforce:

- Discovery input/output and retry budgets
- Registry size
- Expression bytes, nodes, and depth
- Samples and formalization attempts
- Candidate-pair enumeration
- Solver queries and aggregate concurrency
- Evidence volume and model decoding limits

Wire the configured pair budget through static checks; currently the static path can use its internal default independently of the CLI setting.

Budget exhaustion is a reported skipped scope, not a clean result.

### 10.3 Failure behavior

| Failure | Outcome |
| --- | --- |
| Malformed source or unsupported representation | Preserve claim; emit diagnostic; exclude affected formal scope |
| Unresolved registry concept | Localized limitation; dependent checks remain partial |
| Invalid expression | Preserve response and reason; bounded retry |
| Some eligible claims fail | Continue with explicit coverage limitations |
| All eligible formalization attempts fail | Existing fatal formalization-error path |
| No claims are eligible because of source defects | Complete diagnostic reporting with no formal verdict |
| Inconsistent assumptions | Report contradiction; suppress vacuous dependent conclusions |
| Solver error/timeout/unknown | Preserve evidence; inconclusive result |
| Required evidence write fails | Output failure; no successful core manifest |

Keep the current exit-code structure. Reconcile contradictory documentation: `FLA-FORMAL-FAIL` currently names exit `2`, while orchestration uses `FormalizationError`, mapped to exit `9`.

A completed manifest means the evidence bundle is complete, not that every claim was successfully analyzed.

Preserve read-only inputs, output confinement, atomic writes, append-only findings, and the post-manifest optional-report lifecycle. Extend managed-output cleanup and manifest inclusion to every new evidence artifact.

## 11. Temporal Follow-Up Architecture

Temporal analysis is a separate opt-in delivery using the same front end and typed expressions.

Require explicit:

- Initial-state predicate
- State and immutable configuration
- Environment inputs and event occurrence semantics
- Transition relation
- Transition write sets and frame policy
- Response timing
- Event concurrency or scheduling policy
- Terminal-state behavior
- Analysis horizon

Missing details produce temporal-ineligibility findings. The LLM may propose model candidates as evidence, but those candidates do not silently become temporal premises.

### 11.1 Critical semantic rules

- A step is not a millisecond without an explicit clock interpretation.
- Events represent occurrences; they do not persist automatically.
- Frames apply to state according to declared write sets, not to transient outputs or inputs.
- Concurrent writes require an explicit composition policy.
- Request/response correlation requires explicit identity and bounded outstanding-instance semantics.
- Checking a property must not assert that same property as part of the behavioral model.
- Specification-consistency checks and conformance checks against a supplied behavior model are distinct query families.

For bounded responses, check only obligations whose deadlines are observable within the trace. Obligations still pending at the horizon are not successful responses or violations.

Analyze prefixes so that a dead end before the requested horizon cannot disappear merely because it has no longer execution.

### 11.2 Conclusion vocabulary

Report:

- Counterexample at step `n`
- No counterexample within the checked bound
- Guard not reached through the bound
- Pending response at the horizon
- Reachability unknown

Defer unbounded eventuality, fairness-based liveness, induction, and general realizability until their encodings and acceptance criteria are separately specified.

## 12. Implementation Sequence

Each increment includes its OpenSpec deltas, model changes, implementation tasks, and evidence-producing acceptance criteria.

| Increment | Deliverable | Acceptance gate |
| --- | --- | --- |
| **1. Semantic contracts** | Grammar, modality, scenario meaning, assumptions policy, query definitions, failure table | All changed behaviors explicitly specified |
| **2. Structured extraction** | Statement/block separation, spans, strict EARS AST, eligibility, claim and batch propagation | No silent source loss; generated and authored requirements use the same parser |
| **3. Typed expressions** | Bounded parser, resolution, sorts/units, fragment classifier, canonical renderer | Accepted expressions compile to valid Z3 input; malformed input cannot introduce commands |
| **4. Concept discovery** | Bounded pre-pass, reconciliation, frozen registry, uncertainty evidence | Fixed responses produce identical registries independent of completion order |
| **5. Formalization integration** | Clause-oriented prompts, deterministic rule construction, modal tracks, complete attempt evidence | Source structure and modality cannot be overridden by model output |
| **6. Static query engine** | Shared signatures, activation/self-conflict checks, scoped coverage, scenarios and permissions | Known correctness gaps detected with replayable evidence |
| **7. Clustering and comparison** | Nonvacuous clustering, independent registries, explicit alignment, compatibility outcomes | No duplicate declarations, blind-boundary leakage, or favorable verdicts from inconsistent premises |
| **8. Release assessment** | End-to-end corpus, performance measurements, documentation and distribution parity | Full verification and semantic acceptance corpus pass |
| **9. Temporal follow-up** | Explicit transition-model contract, BMC compiler, trace decoding | Independent bounded-trace oracle agrees with emitted queries |

### 12.1 Implementation boundaries

Primary code change boundaries:

- `src/domain/parser/`: block extraction, EARS/scenario parsing, and spans
- `src/domain/model.ts`: surface models and eligibility
- `src/domain/claim-graph.ts`: structure, modality, and provenance propagation
- `src/domain/logic-ir.ts` and `src/domain/formal/`: typed expressions, concept registry, semantic IR, sampling, compilation, queries, clustering, and evidence
- `src/domain/prompts/`: clause-oriented formalization and source-derived generation contracts
- `src/domain/code-backwards/`: symmetric parsing/formalization, independent registries, alignment, and structured comparison
- `src/domain/reporting/`: scope-aware conclusions, evidence artifacts, and manifest integration
- `src/adapters/`: boundary evidence capture and existing confined persistence/process mechanics
- `src/cli/`: orchestration, immutable controls, budgets, phase progress, and managed-output cleanup

### 12.2 Specification and documentation boundaries

Update the relevant active contracts through OpenSpec changes:

- [catalog-and-parse](openspec/specs/catalog-and-parse/spec.md)
- [claim-graph-and-coverage](openspec/specs/claim-graph-and-coverage/spec.md)
- [formalization-and-logic-analysis](openspec/specs/formalization-and-logic-analysis/spec.md)
- [source-traceability-and-code-backwards](openspec/specs/source-traceability-and-code-backwards/spec.md)
- [reporting-and-evidence](openspec/specs/reporting-and-evidence/spec.md)
- [merged-capability-analysis](openspec/specs/merged-capability-analysis/spec.md), where richer claim propagation or eligibility changes its downstream contracts

Keep [docs/design.md](docs/design.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [README.md](README.md) aligned with the resulting behavior. Follow [docs/typescript_style.md](docs/typescript_style.md) and [docs/spec_traceability.md](docs/spec_traceability.md).

## 13. Lightweight Formal-Methods Verification

Follow [docs/lfm.md](docs/lfm.md): explicit claims, small models, independent oracles, generated histories, and traceability.

### 13.1 Alloy models of the analyzer

Model the analyzer's lifecycle and relationships, not an automatic translation of input Alloy.

Check:

- Registry freezing precedes formalization.
- No batch changes the frozen registry.
- Every source claim receives an explicit eligibility disposition.
- Eligible claims have disjoint, exhaustive terminal outcomes.
- Excluded claims cannot contribute assertions.
- Every conclusion references a compatible signature and query.
- Unknown, skipped, and failed checks cannot become clean conclusions.
- Evidence finalization precedes manifest completion.

Use satisfiable witness runs as well as invariant checks. Behavioral models need explicit transitions, frames, and appropriate stuttering. Record checked scopes and results.

### 13.2 Independent executable oracles

Build a small evaluator for the finite Boolean/enum fragment. Compare its truth tables against compiled SMT queries.

For temporal work, add an independent bounded trace enumerator and compare:

- Reachable prefixes
- Enabled events
- Frame behavior
- Response deadlines
- Counterexample traces

These detect shared semantic mistakes that tests checking only whether Z3 accepts the output cannot detect.

### 13.3 Semantic acceptance corpus

Include at least:

- Malformed EARS and keyword-substring traps
- `MUST`, advisory conflict, and permission/prohibition cases
- Alias alignment and same-name/different-concept collisions
- Exact numeric boundaries and unit mismatches
- Guarded-versus-unconditional conflict
- Self-conflict and three-rule conflict
- An unrelated ubiquitous rule alongside a coverage gap
- Concrete scenarios that must not become universal facts
- Duplicate-declaration implication queries
- Inconsistent implication premises
- Missing mappings and partial formalization
- Budget exhaustion and evidence-write failure

Property tests cover literal-safe rendering, expression round trips, signature uniqueness, source-span accuracy, and deterministic outcomes under reordered concurrent completion.

Temporal metamorphic tests must respect timing semantics: inserting a step does **not** generally preserve a next-step or bounded-deadline property.

### 13.4 Release checks and evaluation

Run the project's full `make check`, real-Z3 integration checks, traced specification coverage, Alloy checks, and compiled/bundled parity.

Measure the new discovery pass's token cost, latency, accepted formal coverage, and inconclusive rate on a fixed evaluation corpus. Record the corpus, model, prompts, configuration, and solver identity alongside results. Do not infer semantic accuracy merely from a higher formalization acceptance rate.

## 14. Final Design Position

The first delivery makes the analyzer substantially better at answering:

> Under these explicit assumptions and these recorded interpretations, which requirements conflict, which activations have no compatible response, and which expected input regions lack a governing rule?

That is a useful, defensible static-analysis contract. The temporal follow-up extends it to executions through explicitly supplied initial states, transitions, events, frames, and timing.

This retains the strongest findings from all three proposals while correcting their compatibility claims, query gaps, and tendency to equate richer SMT syntax with stronger behavioral guarantees.
