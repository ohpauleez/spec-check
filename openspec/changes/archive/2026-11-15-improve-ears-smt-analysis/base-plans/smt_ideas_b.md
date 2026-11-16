# Plan: Richer, More Accurate SMT Encodings for spec-check

## Problem Statement (as observed in code)

**A. Invalid EARS accepted.** `classifyEarsType` in `src/domain/parser/spec.ts:351` is pure substring matching on an uppercased body: `normalized.includes("WHILE")` etc. Consequences:
- `WHEN ... IF ... THE ... SHALL` silently classifies as `event-driven`; `WHILE`+`WHEN`+`IF` mixtures silently classify as `complex`.
- Substring false positives: "WHENCE", "OTHERWISE", "THEN" appearing in prose, or `IF` inside a word boundary all misclassify.
- There is no positional/grammatical validation: nothing checks that `WHEN` precedes `THE`, that exactly one response keyword exists, that SHALL NOT is handled, that a complex requirement's `WHILE` comes before `WHEN`, etc.
- `non-ears` produces only a soft structural finding; the claim still flows into formalization where the LLM is asked to formalize a pattern the prompt says is out of scope.

**B. Simplistic SMT encoding.** The Logic IR (`src/domain/logic-ir.ts`) is untyped propositional skeleton + raw SMT-LIB expression strings:
- Assertions are opaque strings; validation is balanced-parentheses only (`isWellFormedAssertion`, `validate.ts:356`). No sort-checking of expressions, no arity checking, no check that referenced symbols are declared (that is deferred to a *solver error* at run time — see `FLA-SPEC-DANGLING-REF`).
- Deeper analysis (`logic-analysis-sexpr.ts extractImplications`) recognizes only top-level `(=> g c)`. Negations, conjunctions of responses, arithmetic comparisons in guards, and `ite` structures are invisible to pairwise/completeness checks.
- Everything is a free Boolean constant, so "requirements consistency" reduces to propositional satisfiability — the tool cannot express, let alone check, "response within 200ms", "at most 3 retries", "queue length never exceeds capacity", state invariants over traces, or set/collection constraints.
- No quantifiers, no datatypes, no sequences/sets/maps, no temporal structure — despite Z3 supporting all of these.

**C. Constraints that must be preserved** (from specs, esp. `formalization-and-logic-analysis/spec.md`):
- Deterministic core; nondeterminism only at `opencode` and `z3` boundaries.
- Evidence preservation: every solver input/output persisted verbatim; compiled SMT-LIB never contains `(check-sat)` (D-9); injective identifier sanitization (D-6); named assertions for unsat-core mapping (FLA-SPEC-NAMED).
- Existing analyses keep working: global check-sat, unsat-core severity derivation, pairwise guard-activation, completeness gap, clustering implication, cross-side implication (which consumes `parseSmtlibContent` output — line-oriented `(declare-const|declare-fun|assert)` forms).
- Bounded work: pair budgets, 30s/10s timeouts; inconclusive verdicts surfaced, never silently treated as clean.
- Findings append-only; malformed findings replaced with defects.

## Decisions (from user answers)

1. **EARS strictness**: configurable via a new `--strict-ears` flag (CLI > config file > default off). Default stays report-only.
2. **EARS structure extraction**: parser-driven. The parser produces a structured `EarsClauses` object; the formalization prompt receives pre-extracted structure as a scaffold.
3. **Encoding scope**: staged — design for all three tiers, land them incrementally behind the same IR extension so each tier is independently shippable and revertible.

## Preservation of Existing Analysis (clarification)

**Every existing finding category and analysis pass is preserved, with zero additional formalization (LLM) passes.**

### What "formalization pass" means in the current pipeline

Looking at the pipeline (`run-cli.ts` → `formalize.ts` → `clustering.ts` → `logic-analysis.ts`), there is exactly **one** LLM-backed formalization stage per claim (plus bounded retries and optional additional samples within that same stage — the `FormalizationAttemptSet` machinery). Everything downstream of it — clustering, compilation, global check-sat, unsat-core, pairwise guard-activation, completeness — is **deterministic transformation or solver querying over the same IR samples**.

This plan adds **zero** LLM passes. The IR upgrade changes the *shape* of what that one existing pass returns, not how many times it's invoked.

### How each existing finding survives the IR migration

The key is that the migration is **string-compatible in the downgrade direction**: every Logic IR v2 AST renders canonically to the same SMT-LIB string the current pipeline already consumes.

| Current analysis (spec requirement) | Where it lives | What it consumes | How it's preserved |
|---|---|---|---|
| Global check-sat + two-phase unsat core (`FLA-RUN-LOGIC`, `FLA-LOGIC-CORE`) | `logic-analysis.ts analyzeSpecGroup` | `compiled.smtlib` string | `compileSpecSmtlib` renders the AST to identical `(assert (! ... :named label))` lines. Same query text, same verdicts, same core-label→claim resolution via `assertionNameMap`. **Byte-identical for tier-0 claims.** |
| Merge-conflict detection (`FLA-SPEC-CONFLICT`, `FLA-SPEC-VARSORT-CONFLICT`, `FLA-SPEC-SYMKIND-CONFLICT`, `FLA-SPEC-CONFLICT-ORDER`) | `compileSpecSmtlib` | `variables`/`functions` declarations | Declarations are unchanged in shape (just richer sort *values* in later tiers). The first-wins dedup/conflict logic is untouched. |
| Severity derivation (`FLA-LOGIC-ADVISORY`, `FLA-PAIRWISE-SEV`) | `logic-analysis-sexpr.ts deriveSeverityFromClaims` | claim obligations | Obligations unchanged; still parser-derived. |
| Pairwise guard-activation (`FLA-PAIRWISE`) | `logic-analysis-checks.ts` | `ParsedImplication` from `extractImplications` | This is the one place that gets *strictly better*, not replaced. Today `extractImplications` string-matches `(=> g c)`; in IR v2 the guard/consequent are AST fields, so `sanitizedGuard`/`sanitizedConsequent` are produced by the renderer instead of regex extraction. The two-phase solver queries built in `checkPairContradiction` are constructed from the same rendered strings — **identical query text**. |
| Completeness gap (`FLA-COMPLETENESS`) | `runCompletenessCheck` | negated guard strings | Same: guards render to the same strings; the "all guards negated" query is unchanged. |
| Clustering implication (`FLA-CLUSTER-QUERY`) | `clustering.ts buildImplicationQuery` | compiled declarations + assertion exprs | Unchanged — it composes declaration preamble + `(assert (not (and ...)))` from rendered strings. |
| Cross-side implication | `cross-implication-smt.ts` | `parseSmtlibContent` output (line-oriented) | The renderer still emits one-line `(declare-const ...)`, `(declare-fun ...)`, `(assert ...)` forms, which is exactly what `parseSmtlibContent` recognizes. (For tier 2, `declare-sort`/`declare-datatype` are already tolerated by its prefix check.) |
| Inconclusive/error aggregation | `logic-analysis.ts`, `logic-analysis-checks.ts` | solver verdicts | Untouched. |

### The migration mechanism: one IR, two views

The design is a **single IR with two projections**, not two IRs:

```
LLM response (expr strings, as today)
      │
      ▼  parse (deterministic s-expr parser — NEW, replaces "balanced parens only")
Typed AST  ──────►  sort-check (NEW: rejects ill-typed/undeclared/arity errors at validation)
      │
      ▼  render (deterministic, canonical)
SMT-LIB string  ──────►  everything downstream unchanged
```

- **Downstream consumers never see the AST** unless they opt in. `CompiledSmtlib.smtlib` and `assertionExprs` remain strings with identical content for existing claims. This is what makes "all existing tests pass unmodified" a meaningful regression gate for Change B.
- **Where structure is needed** (pairwise extraction, vacuous-guard check, negation handling), the code reads the AST view of the *same* in-memory claim object — no re-formalization, no re-parsing at analysis time, no second LLM call.
- **Guard/consequent for deeper checks** come from the parser-extracted `EarsClauses` (Stage 0) *and* the AST: for a claim whose formalization follows the scaffold, the implication structure is known by construction, so `extractImplications` becomes "read the antecedent/consequent nodes" instead of "regex the string". Claims that don't fit the scaffold (free-form tier-0 assertions from old-style prompts) fall back to the current string-matching path, so nothing that is detected today stops being detected.

### What actually changes in analysis coverage (additive only)

- The pairwise/completeness checks currently *miss* conditionals whose assertions aren't literally top-level `(=> ...)` strings — e.g. an LLM that emits `(=> (and a b) c)` is fine but anything more exotic is silently skipped (noted as a "known detection delta" in the `logic-analysis-checks.ts` header comment). With the AST, those become visible. **No finding is removed; some that were silently skipped start being detected.**
- One *new* finding category (`logic.vacuous_guard`) and the malformed-EARS structural findings are additive; all severities follow the existing obligation model.

### One genuine risk to flag

The only place "same query text" could break is if the canonical renderer produces *different but equivalent* strings than the LLM originally emitted (e.g. whitespace normalization, `(- x)` vs `(- 0 x)`). That's fine for solver semantics (Z3 doesn't care), but it means **evidence artifacts** (`.smt2` files) could differ textually from the raw LLM response. The mitigation, matching the project's evidence-preservation rule (I-2/I-4): the raw LLM response is already preserved verbatim in attempt evidence; the `.smt2` artifact documents the rendered form; and the IR sample JSON (also preserved) carries the original expression strings. So provenance is maintained at each hop — nothing rests on an unpreserved transformation.

## Proposed Design

### Stage 0 — Structured EARS parsing (prerequisite for everything)

Extend `ParsedRequirement` with an optional structured clause extraction, produced deterministically at parse time:

```ts
// model.ts
interface EarsClauses {
  readonly state?: ClauseSpan;      // WHILE ... (position + text)
  readonly trigger?: ClauseSpan;    // WHEN ...
  readonly condition?: ClauseSpan;  // IF ...
  readonly feature?: ClauseSpan;    // WHERE ...
  readonly response: ClauseSpan;    // THE <system> SHALL[ NOT] ...
  readonly negatedResponse: boolean;
  readonly keyword: "SHALL" | "SHOULD" | "MAY" | "MUST";
}
```

- Replace `classifyEarsType`'s substring matching with a tokenizing clause scanner: anchored keyword matching (word-boundary, start-of-clause positions), ordered pattern grammar per the 5+2 EARS forms. Classification falls out of *which* clauses were extracted, not from `includes()`.
- Emit precise structural findings for malformed EARS: mixed `WHEN`/`IF`, missing response keyword, multiple `SHALL`s, `WHILE` after `WHEN`, etc. Each finding carries line provenance. (These are the "incorrectly supported invalid EARS statements" — they become visible, deterministically.)
- `--strict-ears` (new flag in `parse-argv.ts`, config key in `config.ts`): in strict mode, `non-ears` and malformed-EARS requirements become error-severity findings and are excluded from formalization eligibility; in default mode, current warn-and-continue behavior is preserved.
- The tokenizer is the single source of truth: `earsType` becomes a pure function of extracted clauses. Property tests: classification determinism, no substring false-positives ("WHENCE", "OTHERWISE"), round-trip clause positions.

### Stage 1 — Typed Logic IR v2 (foundation)

Evolve `logic-ir.ts` from stringly-typed assertions into a typed AST, keeping the string form as the compilation target:

```ts
// Closed sort universe, extended in tiers
type LogicSort =
  | "Bool" | "Int" | "Real" | "String"                       // tier 1
  | { readonly set: LogicSort }                               // tier 2a
  | { readonly seq: LogicSort }                               // tier 2b
  | { readonly array: { domain: LogicSort; range: LogicSort } }
  | { readonly datatype: string };                            // tier 2c (declared)

// Assertion becomes an AST with a faithful SMT-LIB renderer
type LogicExpr =
  | { kind: "var"; name: string }
  | { kind: "lit"; value: boolean | number | string }
  | { kind: "not" | "and" | "or" | "=>" | "ite"; args: readonly LogicExpr[] }
  | { kind: "cmp"; op: "=" | "<" | "<=" | ">" | ">=" | "distinct"; args: readonly LogicExpr[] }
  | { kind: "arith"; op: "+" | "-" | "*" | "div" | "mod"; args: readonly LogicExpr[] }
  | { kind: "apply"; fn: string; args: readonly LogicExpr[] }
  | { kind: "forall" | "exists"; bound: readonly LogicVariableDeclaration[]; body: LogicExpr }  // tier 2
  | { kind: "str"; op: "str.contains" | "str.prefixof" | "str.len" | ...; args: readonly LogicExpr[] };
```

Key properties:
- **Typed validation**: `validate.ts` gains a real sort-checker (rejects `(< BoolVar 3)`, undeclared symbols, arity mismatches) *at validation time* instead of via solver error later. This converts a class of `logic.solver_error` findings into earlier, better-attributed `logic.invalid_formalization` findings — while the solver-error path remains as a backstop (preserving FLA-SPEC-DANGLING-REF behavior for anything the checker misses).
- **Structure-aware deeper analysis**: `extractImplications` no longer pattern-matches strings. Guards/consequents are AST nodes; negated responses (`SHALL NOT`), conjunctive consequents, and arithmetic guards are first-class. Pairwise guard-activation and completeness checks then work for *all* conditional shapes, not just top-level string `(=> g c)`.
- **Backward compatibility**: a `LogicExpr` renders canonically to the existing SMT-LIB string form, so `compileSmtlib`, `compileSpecSmtlib`, named assertions, unsat-core mapping, `parseSmtlibContent`, clustering implication queries, and cross-side implication all keep working byte-for-byte for tier-0-style claims. Existing golden fixtures remain valid; new golden samples added per tier.
- JSON wire format for the LLM stays nearly identical (exprs may be sent as strings and parsed by *us* into the AST — see Stage 3 — so the prompt contract barely changes).

### Stage 2 — Semantic enrichment tiers

**Tier 1 — Arithmetic & string semantics (decidable: QF_LIA/QF_LRA + strings).**
- Prompt encourages Int/Real variables for quantities ("at least N", "within T", "no more than") and String for textual constraints, with comparison/arithmetic operators.
- New analyses enabled: numeric guard overlap (e.g. two thresholds that conflict), completeness gaps over numeric ranges, vacuous-guard detection (`guard` unsat alone → requirement never fires — a genuinely new finding category `logic.vacuous_guard`).
- All queries stay in decidable fragments; timeout risk unchanged in practice.

**Tier 2 — Sets, sequences, datatypes, quantifiers.**
- Extend sorts and expression AST as above; `declare-sort`/`declare-datatype` support in `smtlib.ts` (parse side of `parseSmtlibContent` already tolerates `declare-sort`).
- Prompt patterns for collections ("for every item in the batch", "the set of active sessions", "the sequence of events preserves order").
- Risk control: quantified claims are compiled with `(set-option :smt.mbqi true)`-style pragmas in the query preamble (caller-appended, preserving D-9), and per-claim opt-in: if a sample uses quantifiers, its compile group gets a marker so timeout/unknown aggregation (existing `logic.inconclusive` machinery) attributes it correctly. No new finding shapes needed.

**Tier 3 — Explicit time/state modeling (opt-in per capability).**
- Standard encoding pattern (not a solver extension): add a declared `Time` sort (Int or Real) and model state-driven/ubiquitous claims as ∀t properties, event-driven claims as ∀t: trigger(t) ⇒ response(t) ∨ response(t+1)… — i.e., a bounded/trace-style encoding over an uninterpreted "step" function, or simpler: "always" axioms over a time variable.
- This enables genuinely new analysis: state invariant consistency ("while in maintenance mode, X always holds" vs an event that sets ¬X), reachability-flavored gap checks ("is there a time where no rule applies").
- Guarded by config (`--temporal` / config key) because it changes the encoding of every claim in a group and raises timeout risk; when enabled, obligation-aware severity and all existing finding categories still apply unchanged.

### Stage 3 — Prompt & pipeline integration

- `prompts/formalization.ts`: rewrite around the structured `EarsClauses` scaffold. The prompt now includes the parser-extracted clauses (trigger text, state text, response text, negation flag, keyword) and asks the LLM only for *predicate formalization of each clause* plus variable declarations — not for structure discovery. This shrinks the nondeterministic surface and directly addresses the "LLM invents structure" failure mode.
- The LLM still emits SMT-LIB expression *strings* per clause (minimal prompt churn); **we** parse them into the AST with a deterministic s-expression parser + sort-checker at validation time. String-in/AST-validated keeps the wire format stable while giving us structural knowledge.
- Obligation derivation stays parser-side (RFC 2119 keyword from `EarsClauses.keyword`), removing one more LLM judgment call.
- `informalize.ts` (code-backwards generation) gets the same structured-EARS contract so generated specs are classifiable by the same strict tokenizer — keeping both sides of cross-side implication symmetric.

### Stage 4 — New & preserved analysis capabilities

Preserved unchanged (contract-level): global check-sat + two-phase unsat core; merge-conflict detection; clustering; cross-side implication; finding shapes and severities; evidence persistence; all bounds.

New analyses (each maps to existing finding categories or one new category):
1. **Vacuous guard detection** (`logic.vacuous_guard`, warning): per conditional claim, `sat(guard)` alone. Cheap: one extra query per conditional claim, bounded by a budget like pairs.
2. **Numeric/typed completeness**: completeness check now covers arithmetic guards; gap evidence can include a `(get-model)`-derived witness assignment (persisted verbatim as evidence, matching I-4).
3. **Response-conflict precision**: pairwise checks work on AST consequents, so `(not X)` vs `X`, and `(< n 5)` vs `(>= n 5)` consequent conflicts are detected structurally rather than only via full solver queries (solver still authoritative; AST pre-filter saves budget).
4. **(Tier 3) temporal consistency**: state-vs-event contradictions over the time encoding.

### Stage 5 — Specs, tests, docs

- OpenSpec: new change under `openspec/changes/` (proposal/design/tasks/spec deltas) touching `catalog-and-parse` (strict EARS, structured clauses, new finding categories) and `formalization-and-logic-analysis` (Logic IR v2, typed validation, vacuous-guard, tier features). Per project convention, Alloy fragments updated where state machines/phase predicates change.
- Tests:
  - Contract: tokenizer/classifier table-driven tests (valid 5 forms, invalid mixtures, substring traps); sort-checker rejection tests; `--strict-ears` CLI/config tests.
  - Property (fast-check): classifier determinism; AST⇄string render round-trip; sanitizer injectivity preserved over new sort syntax; no-check-sat invariant; typed-validation soundness (anything passing the sort-checker compiles to Z3-accepted SMT-LIB — extend the existing z3 integration oracle pattern).
  - Oracle: extend `test/fixtures/ears-to-logic/golden-samples.json` with arithmetic, string, quantified, and (tier 3) temporal samples; integration tests assert Z3 accepts each tier's output.
  - Integration: end-to-end run on a fixture spec containing invalid EARS under both flag modes; a numeric-contradiction spec; a temporal fixture.
- Docs: `docs/design.md` §4.4 (EARS table + strictness), §16 pipeline summary; `ARCHITECTURE.md` code map (new modules); this plan references AGENTS-relevant conventions — no AGENTS.md exists at root, so nothing to update there.

### Suggested implementation order (each independently mergeable)

1. **Change A — Structured EARS tokenizer + `--strict-ears`** (parser, model, findings, CLI/config, tests). Zero impact on formal pipeline output for valid specs.
2. **Change B — Logic IR v2 AST + typed validation + canonical rendering** (logic-ir, validate, sexpr analysis, smtlib render path). Byte-compatible output for existing fixtures; all existing tests must pass unmodified (that's the regression gate).
3. **Change C — Prompt restructure around clause scaffolds + vacuous-guard check** (prompts, formalize wiring, new finding category, budgets).
4. **Change D — Tier 1 enrichment** (arithmetic/strings in prompts + golden samples + numeric completeness evidence).
5. **Change E — Tier 2 quantifiers/sets/sequences/datatypes** (sorts, declare-datatype, mbqi pragmas, inconclusive attribution).
6. **Change F — Tier 3 temporal encoding** (opt-in flag, time-sorted encoding, new temporal consistency findings).

## Open questions

1. **Tier 3 temporal modeling**: is bounded-trace (fixed horizon k, fully decidable) acceptable, or unbounded ∀t-style invariants (risk of `unknown`)? Bounded is far safer for a CLI tool.
2. **Wire format**: keep LLM output as expr *strings* parsed by us (recommended — smaller diff, keeps prompts stable), or switch the JSON schema to a structured AST directly (more robust, bigger prompt/validation rewrite)?
3. Should the new finding categories (`logic.vacuous_guard`, malformed-EARS categories) be error or warning severity by default under `--strict-ears`?
