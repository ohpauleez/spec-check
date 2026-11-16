# Review: Richer EARS-to-SMT Semantics

This review compares `smt_ideas_a.md`, `smt_ideas_b.md`, and
`smt_ideas_c.md` against the current implementation, design documentation,
and active OpenSpec contracts.

## Executive Assessment

The plans work at different layers:

| Plan | Primary strategy | Strongest contribution | Main weakness |
| --- | --- | --- | --- |
| A | Versioned transition-system semantics | Sound temporal architecture and an honest preservation boundary | Less implementation detail; its taxonomy policy is a breaking change |
| B | Typed SMT expression AST plus staged enrichment | Best incremental implementation roadmap for parsing and type checking expressions | Overstates compatibility and does not specify a complete temporal model |
| C | Strict EARS recognition plus shared vocabulary | Correctly identifies semantic concept alignment as high value | Misstates current compiler behavior and does not address temporal meaning |

Recommendation: use Plan A as the architectural foundation, Plan B's typed
expression parser and validator as the implementation foundation, and Plan
C's vocabulary insight as a prerequisite semantic service. Do not adopt any
plan unchanged.

Plan A is the only plan that can credibly offer richer semantics without
changing the meaning of existing analysis, because it explicitly separates
legacy static analysis from temporal analysis. Plans B and C retain similarly
named checks, but many of their changes alter the accepted model set and the
resulting findings.

## Current Baseline

### EARS structure does not reach formalization

The parser classifies EARS using unordered substring matching
(`src/domain/parser/spec.ts:326-385`). Requirements are flattened into one
body string (`src/domain/parser/spec.ts:156-185`), and scenarios are likewise
flattened (`src/domain/parser/spec.ts:252-280`).

The claim graph then drops the parsed `earsType` and retains only prose,
obligation, provenance, and references (`src/domain/claim-graph.ts:269-300`).
Thus the formalization stage cannot depend on parser-established EARS clauses.
A stricter parser alone will not improve SMT semantics unless the resulting
clause structure becomes part of the claim/formalization contract.

### The current IR has typed declarations, not typed expressions

The current Logic IR already supports `Bool`, `Int`, `Real`, `String`, and
typed uninterpreted functions (`src/domain/logic-ir.ts:19-49`). It is
therefore inaccurate to describe the project as exclusively propositional.

The actual limitation is that assertion bodies are opaque SMT-LIB strings
(`src/domain/logic-ir.ts:51-61`). Validation checks JSON shape and balanced
parentheses, but not referenced symbols, arity, expression sorts, operator
sorts, or solver commands (`src/domain/formal/validate.ts:289-374`).

The current compiler also rewrites identifier-like tokens inside string
literals (`src/domain/formal/smtlib.ts:144-175`). String enrichment should not
precede a literal-aware parser and renderer.

### Existing analysis is static and valuation-based

The prompt maps `WHEN`, `WHILE`, and complex EARS forms to timeless Boolean
implications (`src/domain/prompts/formalization.ts:71-103`). There are no
initial states, transitions, event occurrences, response delays, or traces.

Global SAT asks whether constraints share a model. Pairwise checking forces
two guards in an arbitrary valuation. Completeness negates all guards and
searches for an arbitrary satisfying valuation
(`src/domain/formal/logic-analysis-checks.ts:483-567`).

Consequently, the current code and the active OpenSpec contract misuse
"reachable state". Without `Init` and `Trans`, the check establishes a
possible valuation, not reachability. See
`openspec/specs/formalization-and-logic-analysis/spec.md:1792-1827`.

### Compatible declarations already unify

Plan C claims that `compileSpecSmtlib` excludes colliding claims. This is not
true for compatible declarations: same-name declarations with compatible
sorts/signatures are deduplicated and both claims remain included
(`src/domain/formal/smtlib.ts:435-497`; also
`openspec/specs/formalization-and-logic-analysis/spec.md:864-881`).

The actual missing feature is semantic symbol alignment. Separate LLM outputs
may name the same concept differently, or use the same name for different
concepts. Compiler-level declaration deduplication cannot fix either problem.

## Plan A

### Approach

Plan A proposes two semantic versions:

- `static-v1`, preserving current static analysis.
- `temporal-v2`, using a typed semantic IR and bounded, time-indexed SMT.

It models state, configuration, events, initial conditions, transitions,
environment assumptions, frame conditions, fairness, provenance, and explicit
response timing.

### Strengths

1. It recognizes that temporal meaning requires a transition-system model,
   rather than a broader list of SMT-LIB operators.
2. It correctly refuses to infer same-step, next-step, or eventual timing from
   `WHEN` alone.
3. It proposes bounded, quantifier-free model checking as the default, which
   fits the project's bounded-work and evidence-oriented design.
4. It distinguishes bounded checks from proof and calls for decoded traces.
5. It accurately identifies that current completeness checking is not
   reachability analysis.

### Weaknesses

1. Removing `conditional` and treating `WHERE` as a non-core extension would
   change the documented and active project profile. `docs/design.md:438-455`
   includes both, while the current OpenSpec contract explicitly requires
   conditional recognition (`openspec/specs/catalog-and-parse/spec.md:915-931`).
2. Preserving only the old compiler is not enough for `static-v1`
   compatibility. Stricter parsing can change claim eligibility before
   formalization. A truly frozen legacy path must preserve parser acceptance,
   claim eligibility, prompts, validation, rendering, queries, and findings.
3. Its temporal compilation equations assume a response delay even though its
   policy permits unresolved timing. Claims with unresolved timing should stay
   static or be temporally ineligible until a declared timing profile resolves
   them.
4. Frame conditions require an explicit transition write set. Otherwise a
   compiler cannot decide whether unmentioned state persists or is unconstrained.
5. It does not yet provide a concept/ontology service for stable symbol
   identity across requirements and cross-side analysis.

### Assessment

Plan A is the best target architecture. Its main gaps are migration detail,
taxonomy governance, and concept alignment rather than core semantic design.

## Plan B

### Approach

Plan B parses LLM-produced expression strings into a typed AST, type-checks
them, then canonically renders SMT-LIB for existing downstream consumers. It
adds structured EARS clauses, arithmetic and strings, quantified/collection
tiers, and a temporal tier.

### Strengths

1. A deterministic S-expression parser, typed expression AST, sort checker,
   and canonical renderer are essential improvements over balanced-parentheses
   validation.
2. Parser-derived EARS clause scaffolding appropriately narrows the LLM's
   role: it should formalize predicate content, not rediscover EARS structure.
3. The staged rollout is practical: structured parsing, typed expression
   validation, prompt integration, scalar enrichment, then broader semantics.
4. Vacuous-guard checks are a valuable static extension.

### Weaknesses

1. Its claims of byte-identical output, identical query text, unchanged
   findings, and unmodified tests are not credible. Typed validation changes
   which samples survive; canonical rendering changes evidence; structure-aware
   extraction can change clustering and downstream findings.
2. Replacing dangling-reference solver errors with early invalid-formalization
   failures changes an explicitly current finding path
   (`openspec/specs/formalization-and-logic-analysis/spec.md:996-1003`).
3. Its AST is an SMT syntax tree, not a semantic IR. It does not inherently
   distinguish state, configuration, inputs, outputs, events, actions,
   assumptions, or transition relations.
4. Its Tier 3 time-indexed sketch is not a transition system. A time parameter
   or uninterpreted step function without `Init`, `Trans`, event occurrence
   semantics, and frames cannot establish reachability.
5. Claims that broad arithmetic/string queries retain decidability and similar
   timeout risk are unjustified. Unrestricted multiplication can be nonlinear;
   mixed strings and arithmetic can be expensive; MBQI is a heuristic rather
   than a completeness guarantee.
6. Its statement that compound guards and consequents are currently invisible
   is overstated. The current extractor accepts nested forms as operands of an
   outer binary implication (`src/domain/formal/logic-analysis-sexpr.ts:114-154`).
7. Its datatype compatibility assertion is incorrect:
   `parseSmtlibContent` does not preserve `declare-datatype(s)` forms
   (`src/domain/formal/smtlib.ts:571-587`).

### Assessment

Plan B is the best near-term implementation roadmap for typed expressions.
It should be adopted below a versioned semantic boundary, not as an in-place
claim of full compatibility. Its temporal tier should be replaced by Plan A's
transition-system/BMC model.

## Plan C

### Approach

Plan C narrows the initial scope to strict EARS recognition, a `--strict-ears`
mode, shared capability vocabulary, scalar/enumeration sorts, and deferred
quantifiers.

### Strengths

1. It identifies concept alignment as the highest-leverage near-term semantic
   improvement. Independent names for one concept prevent contradictions and
   redundancy from being detected.
2. Deferring quantifiers is prudent.
3. Its five base forms plus an allowed complex composite are closer to a
   coherent EARS profile than the repository's current mixed taxonomy.

### Weaknesses

1. A vocabulary that accumulates while batches formalize is nondeterministic
   under concurrent physical batch processing. A signature/ontology must be
   created in a deterministic pre-pass, frozen, versioned, and supplied to all
   batches.
2. A shared name list is not an ontology. It needs stable concept IDs,
   canonical symbols, sorts and units, semantic roles, scope, aliases,
   provenance, confidence, and collision resolution.
3. Its compiler-unification proposal mostly describes existing behavior; the
   improvement must occur before compilation during concept discovery and
   formalization.
4. Its recognizer examples admit only `SHALL`, despite documented support for
   `MUST`, `SHOULD`, and `MAY` (`docs/design.md:453-465`).
5. `IF ..., THEN ...` cannot distinguish unwanted behavior from generic
   conditional syntax without an explicit policy or annotation. Negative-word
   heuristics are unsound, but Plan C does not replace them.
6. Escalating a warning alone does not make strict EARS a hard eligibility
   gate. The claim must be marked ineligible for the selected semantic profile
   if strict mode is meant to prevent formalization.
7. It does not address timing, transitions, reachability, frame conditions,
   liveness, or semantic-version compatibility.

### Assessment

Plan C identifies a valuable priority and a safe scope boundary, but it is not
a complete semantic strategy. Its ontology lifecycle and compiler premise need
revision.

## Direct Comparison

| Concern | Plan A | Plan B | Plan C |
| --- | --- | --- | --- |
| Structural EARS parser | Strong | Strong | Moderate; regex-oriented |
| Parser structure reaches formalization | Yes | Yes | Intended but incomplete |
| Configurable strictness | Unclear | Yes | Yes |
| Typed expression validation | Yes | Strongest detail | Partial |
| Semantic roles and transition system | Strong | Insufficient | Deferred |
| Shared vocabulary | Missing | Implicit only | Strong priority, weak mechanism |
| Temporal reachability | BMC-based | Not fully specified | Deferred |
| Quantifier risk control | Conservative default | Overly broad | Safely deferred |
| Honest compatibility model | Strongest | Overclaimed | Overclaimed by implication |

## Non-Conservative Changes

The following are not merely additive extensions, even if existing category
names remain:

1. Strict EARS parsing changes which claims are accepted and formalized.
2. Removing generic conditional changes the documented profile.
3. Typed rejection removes samples that formerly reached Z3.
4. Canonical rendering changes evidence bytes and may correct old malformed
   token rewriting.
5. Shared symbol alignment equates formerly independent values and can turn
   SAT into UNSAT.
6. Enums impose exclusivity/exhaustiveness absent from separate Booleans.
7. Temporal lifting changes a one-valuation proposition into a trace property.
8. More complete implication extraction can change clusters and representatives.
9. New findings can alter report conclusions and exit behavior.

Only an explicit semantic-version boundary can preserve old behavior while
introducing these changes.

## Recommended Combined Plan

### 1. Define versioned semantic profiles first

Establish at least:

- `legacy-ears-v1` / `static-v1`: frozen current parser and static analysis.
- `static-v2`: structured EARS, typed expressions, and aligned vocabulary;
  still valuation-based.
- `temporal-v2`: transition-system semantics compiled with BMC.

Before implementation, resolve the EARS profile in OpenSpec:

- Canonical base forms: ubiquitous, state-driven, event-driven,
  unwanted-behavior, optional.
- Complex: allowed composition of state and event drivers.
- Generic conditional: either an explicit project extension, one unified
  `IF/THEN` form, or a syntax requiring explicit intent.
- Modal policy for SHALL/MUST/SHOULD/MAY and `SHALL NOT`.
- Non-EARS escape-hatch syntax and justification requirements.
- Scenario grammar and response-timing policy.

### 2. Introduce three distinct representations

Do not conflate source syntax, SMT syntax, and behavior semantics.

| Layer | Responsibility |
| --- | --- |
| Surface AST | EARS/scenario clauses, modal, negation, exact source spans |
| Typed expression AST | literals, symbols, operators, arity, and sorts |
| Semantic IR | static constraints or transition-system elements |

Use Plan B's deterministic parser and type checker for the expression layer.
Use Plan A's semantic IR for temporal behavior.

### 3. Build a frozen, versioned capability ontology

Before parallel claim formalization, derive and freeze a capability-scoped
registry containing:

- Stable concept ID and canonical SMT symbol
- Semantic role: state, configuration, event, input, output, or derived value
- Sort and units
- Scope and aliases
- Source provenance and confidence
- Explicit unresolved collisions

Every batch receives the same frozen registry. Do not accumulate vocabulary
from concurrently completing LLM batches.

For code-backwards comparison, derive each side's registry independently to
maintain the blind boundary, then persist an explicit alignment map. Rename
both sides into a checked joint signature before implication. Unmapped or
incompatible concepts should produce `incompatible`/`unmapped`, not a semantic
`different` verdict.

### 4. Preserve static analysis honestly

Keep `static-v1` frozen for regression and historic report compatibility.

Run `static-v2` alongside it with:

- Typed validation
- Literal-safe canonical rendering
- Concept-aligned declarations
- Vacuous-guard checks
- Numeric overlap and contradiction checking
- Better implication extraction
- Coverage over satisfying valuations

In `static-v2`, rename current reachability wording to "satisfying valuation."
A valuation model cannot prove a state is executable.

### 5. Add only conservative solver fragments first

The first enriched profile should support:

- `Bool`
- Finite enums/algebraic datatypes
- Quantifier-free linear integer arithmetic
- Limited exact real arithmetic only where necessary

Delay unrestricted strings, nonlinear arithmetic, sequences, arrays with
quantifiers, and general quantifiers. Declare each artifact's solver-fragment
profile and reject or mark unsupported combinations inconclusive before
querying Z3.

### 6. Add `temporal-v2` as explicit opt-in BMC

Require a temporal profile defining:

- Initial-state predicate
- Transition relation
- State/configuration/event declarations
- Event occurrence semantics
- Response timing semantics
- Transition write sets and frame policy
- Environment assumptions
- Fairness/progress assumptions where needed
- BMC horizon

Claims whose timing is unresolved remain static or receive a temporal-
ineligibility finding. Do not silently assign a delay.

Temporal analysis should separately check initial-state satisfiability,
reachable guard co-enablement, response conflicts at the required time,
transition/frame conflicts, coverage gaps, and bounded response violations.

### 7. Label conclusions according to their strength

Reports should distinguish:

- Counterexample at step `n`
- Not reached through bound `k`
- Reachability unknown
- Safe through bound `k`
- Proven invariant only when an induction/fixpoint method actually establishes it

For unbounded `eventually`, finite BMC is insufficient. Support only bounded
responses initially, or add lasso/fairness encodings with explicit caveats.

### 8. Migrate clustering and cross-side implication last

Equivalence and implication are meaningful only for compatible artifacts:

- Same semantic profile
- Aligned ontology/signature
- Compatible assumptions
- Compatible timing and frame policy
- Compatible solver fragment
- Same BMC horizon for bounded claims

Bounded equivalence must be reported as `equivalent-through-k`, not simply
`same`.

### 9. Expand semantic provenance and evidence

Persist, for every artifact and query:

- Parser/EARS profile and source spans
- IR schema and semantic-profile version
- Ontology version/hash
- Prompt/model version
- Compiler/query-template version
- Solver version/options and fragment classification
- Assumptions, timing, fairness, and frame policy
- BMC horizon
- Raw formalization response and accepted normalized IR
- Solver input/output for deeper pairwise, coverage, and temporal queries

This is required to make semantic-versioned results auditable.

## Final Ranking

1. Plan A: best architecture and semantic correctness.
2. Plan B: best implementation detail, especially typed expression handling.
3. Plan C: best prioritization of vocabulary alignment and quantifier deferral,
   but not a complete solution.

The recommended direction is Plan A's semantic versioning and bounded model
checking, implemented through Plan B's typed parser/validator, with Plan C's
vocabulary idea redesigned as a frozen versioned ontology.
