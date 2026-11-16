# Plan: Stricter EARS Validation + Richer SMT Encoding

## Goals (from direction)

1. **Canonical 5 EARS patterns.** Warn on non-canonical patterns; `--strict-ears` turns those into hard errors.
2. **Structurally strict classification** (not substring guessing).
3. **Richer SMT (no quantifiers yet):** unify Bool/predicate vocabulary across requirements in a capability, and enrich datatypes (String, Int, enums) beyond bare Bools.
4. **Quantifiers + bounded scope deferred** to a later, CLI-gated phase.

## The canonical 5 (decision baked into plan)

Per EARS canon, the 5 are: **Ubiquitous, State-driven (WHILE), Event-driven (WHEN), Optional (WHERE), Unwanted (IF/THEN)**. Complex (WHILE+WHEN) is the standard combination of two canonical drivers, so it is treated as **canonical-composite (allowed, no warning)**. The tool's current extra `conditional` (bare IF/THEN without a negative indicator) becomes **non-canonical → warning / strict-error**, since canonically IF/THEN is the unwanted-behavior pattern.

> Confirm: treat `complex` as allowed-canonical-composite (recommended), and demote `conditional` to non-canonical? If `complex` should also warn, adjust one table entry.

---

## Phase 1 — Strict EARS classification + `--strict-ears`

**1.1 Structural recognizer** — rewrite `classifyEarsType` in `src/domain/parser/spec.ts:351` into a grammar-based recognizer returning a richer result: `{ earsType, canonical: boolean, structuralIssues: EarsStructuralIssue[] }`.
- Anchor patterns with ordered, comma-aware regexes instead of unordered `includes()`:
  - Ubiquitous: `^THE .+ SHALL .+\.$`
  - State-driven: `^WHILE .+, THE .+ SHALL .+\.$`
  - Event-driven: `^WHEN .+, THE .+ SHALL .+\.$`
  - Optional: `^WHERE .+, THE .+ SHALL .+\.$`
  - Unwanted: `^IF .+, THEN THE .+ SHALL .+\.$`
  - Complex (composite): `^WHILE .+, WHEN .+, THE .+ SHALL .+\.$`
- Detect and report specific malformations as `EarsStructuralIssue` kinds: `keywords-out-of-order`, `missing-then`, `missing-the-shall`, `missing-comma-delimiter`, `multiple-primary-keywords`, `trailing-clause-after-shall`.
- Keyword matching stays case-insensitive on EARS keywords but position-sensitive.

**1.2 Type model** — in `src/domain/model.ts:108`:
- Keep `EarsType` union but add a canonical classifier. Introduce `CanonicalEarsType = "ubiquitous" | "state-driven" | "event-driven" | "optional" | "unwanted-behavior" | "complex"`.
- Add to `ParsedRequirement`: `canonicalEars: boolean` and optional `earsIssues: readonly EarsStructuralIssue[]`.

**1.3 Finding severity** — in `parseRequirement` (spec.ts):
- Non-canonical but recognizable (e.g. bare `conditional`): **warning** finding `parse.ears.non-canonical` with the detected type and suggested canonical rewrite.
- Structurally malformed EARS: **warning** `parse.ears.malformed` listing issue kinds.
- `non-ears` with no escape hatch: existing warning retained.
- The parser stays deterministic and does **not** know about `--strict-ears`; it always emits findings with a stable severity plus a machine-readable `earsCanonical` flag on the finding payload.

**1.4 `--strict-ears` flag** — threaded as config, applied at a post-parse gate:
- `parse-argv.ts`: add boolean flag handling like `--allow-archive` (add `strictEars: boolean` to `CliArgs`, add to `FLAG_KEYS` handling as a valueless flag, include in returned object).
- `config.ts`: add `strictEars` to `RunConfig` (line 25) and the file-config shape/merge (additive like `allowArchive`, line 248).
- `run-cli.ts` (ingestion phase, ~line 225): after parsing/merge, a deterministic **strict-EARS gate** promotes every `parse.ears.non-canonical` / `parse.ears.malformed` finding to `error` severity when `config.strictEars`. Because findings are append-only, this is implemented as an escalation pass that re-emits at higher severity (or sets an `escalated` flag), preserving the Finding Preservation invariant. If any error-level EARS finding results, the run still completes reporting but exits non-zero (existing findings→exit-1 path; consider a dedicated exit for strict violations).

**1.5 Tests** — extend `test/contract/parser.test.ts` and `test/oracle/*`: out-of-order keywords now flagged; bare conditional flagged non-canonical; strict-mode escalation; determinism property test for the new recognizer.

**1.6 Docs** — update the EARS tables in `docs/design.md` (§4.4) and `ARCHITECTURE.md` to mark the canonical 5 (+complex composite) and note non-canonical warnings / `--strict-ears`.

---

## Phase 2 — Shared capability vocabulary (unify Bools & predicates)

This is the highest-leverage semantic improvement: today every claim invents private Bool names, so cross-requirement contradiction/redundancy is undetectable and `compileSpecSmtlib` *excludes* colliding claims.

**2.1 Signature model** — add a per-capability **signature** to the Logic IR (`src/domain/logic-ir.ts`): a `LogicSignature` of shared declarations (predicates/constants/functions) that multiple `LogicIrClaim`s reference by name. New optional field on the compile group rather than per-claim, so single-claim compile stays valid.

**2.2 Formalization prompt change** (`src/domain/prompts/formalization.ts` + `ATTACHED_BATCH_FORMALIZATION_PROMPT`): when formalizing a batch for one capability, pass the **accumulating shared vocabulary** as attached context and instruct reuse of existing symbol names for the same concept (canonical naming guidance), only declaring new symbols for genuinely new concepts. Vocabulary is built deterministically per capability; the attached-context lifecycle and evidence hashing already exist for batches.

**2.3 Reconciliation instead of exclusion** — in `compileSpecSmtlib` (`smtlib.ts:278`): when the same sanitized name recurs with a **compatible** sort/signature, **unify** (declare once, shared) instead of excluding the later claim. Keep true `variable_sort_mismatch` / `function_signature_mismatch` / `symbol_kind_collision` as findings, but same-sort reuse becomes the intended path, not a conflict. This directly enables cross-requirement contradiction detection in existing `logic-analysis.ts` checks — **without adding any new solver query type**, so current analysis is preserved and strengthened.

**2.4 Validator** (`validate.ts`): allow assertions to reference symbols declared in the shared signature (not only the claim-local `variables`), by passing the signature's declared names into `validateFunctions`/assertion symbol-resolution. Keep collision rules for genuinely incompatible re-declarations.

**2.5 Tests** — new contract/integration tests proving two requirements sharing a condition now produce a solver-detectable contradiction; property test that unification is order-independent and deterministic.

---

## Phase 3 — Enrich datatypes (String, Int, enums)

**3.1 Enum sorts** — extend `LogicSort` (`logic-ir.ts:19`) from the closed `Bool|Int|Real|String` to also allow **declared enumeration sorts** via SMT-LIB `declare-datatypes` (e.g. system modes `maintenance|normal|degraded`). Add `LogicDatatypeDeclaration` to the IR and emit `(declare-datatypes ...)` in the compiler preamble (`smtlib.ts`). Validator learns the new sort kind; `usesDeclaredOrBuiltInSort` (validate.ts:341) extends to declared datatype names.

**3.2 Prompt guidance** — teach the formalizer to prefer Int/Real for quantities and thresholds (with real comparisons `<,<=,>,>=`), String for textual equality, and enum datatypes for mutually-exclusive modes/states, instead of collapsing to Bool. Add few-shot examples for a thresholded event-driven requirement (Int) and a mode-based state-driven requirement (enum).

**3.3 Compiler/identifier support** — ensure `sanitizeIdentifier` injectivity covers datatype constructor names; emit datatype decls before const/fun decls; keep the "no `(check-sat)`" invariant (D-9).

**3.4 Tests** — oracle tests for enum-exhaustiveness contradictions (e.g. two requirements asserting mutually exclusive modes simultaneously) and integer-threshold contradictions.

---

## Phase 4 (deferred, CLI-gated) — Quantifiers + bounded scope

Design-only stub in this plan, not implemented now:
- Add `--quantifiers` and `--bounded-scope <N>` flags (mirrors Phase 1.4 flag plumbing).
- Introduce quantified assertions over a bounded universe (finite-model / trace index) in the IR and compiler, guarded so the default remains quantifier-free.
- Noted caveat: value is limited given Alloy 6 already models the specs; likely lowest priority.

---

## Cross-cutting constraints honored

- **Deterministic core:** all new parser/compiler logic is pure and deterministic; nondeterminism stays at the `opencode`/`z3` boundaries.
- **Evidence preservation & append-only findings:** strict-mode escalation adds/annotates findings, never deletes; new SMT artifacts persist verbatim.
- **Injective sanitization (D-6), no `(check-sat)` in compiled output (D-9):** preserved.
- **Existing analysis preserved:** propositional implication checks remain the special case; unification and datatypes only *add* discriminating power.

## Suggested sequencing & risk

1. **Phase 1** (self-contained, high value, low risk) — do first.
2. **Phase 2** (biggest semantic win, moderate risk in `compileSpecSmtlib` and prompt) — do second.
3. **Phase 3** (additive) — third.
4. **Phase 4** — deferred.

## Files that will change (per phase)

- **P1:** `parser/spec.ts`, `model.ts`, `parse-argv.ts`, `config.ts`, `run-cli.ts`, `docs/design.md`, `ARCHITECTURE.md`, `test/contract/parser.test.ts`, `test/oracle/*`.
- **P2:** `logic-ir.ts`, `formal/smtlib.ts`, `formal/validate.ts`, `prompts/formalization.ts`, `formal/formalize.ts` (vocab accumulation), `test/*`.
- **P3:** `logic-ir.ts`, `formal/smtlib.ts`, `formal/validate.ts`, `prompts/formalization.ts`, `test/oracle/*`.

---

## Two confirmations before implementation

1. **`complex`** treated as allowed canonical-composite (no warning), and **`conditional`** demoted to non-canonical (warning / strict-error)?
2. **`--strict-ears` exit behavior:** reuse existing findings→exit-1, or add a distinct exit code for strict EARS violations?
