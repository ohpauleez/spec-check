# Richer EARS-To-SMT Semantics

The project needs a semantic layer, not simply a broader raw SMT-LIB vocabulary.

## Make EARS Strict

Current classification is keyword-presence matching (`src/domain/parser/spec.ts:351-385`), so malformed prose can be accepted. Replace it with an anchored lexer/parser that produces a discriminated EARS AST.

| Form | Required AST fields | Temporal meaning |
| --- | --- | --- |
| Ubiquitous | system, modal, response | invariant |
| Event-driven | trigger, system, modal, response | event response |
| State-driven | state, system, modal, response | state invariant |
| Unwanted-behavior | condition, system, modal, response | guarded safety rule |
| Complex | state, trigger, system, modal, response | state-qualified event response |

Recommended policy:

- Remove `conditional` as an accepted EARS type. `IF ..., THEN ...` is the unwanted-behavior syntax; detecting "negative" language with substring heuristics is not sound.
- Treat `WHERE ...` as an explicit extension, not a core EARS form, unless the project deliberately adopts a six-form profile.
- Require exact clause order, commas, nonempty clauses, one modal, subject, response, and end-of-statement handling.
- Give invalid forms precise diagnostics, such as missing `THEN`, reversed clauses, empty trigger, or unsupported modal.
- Represent a non-EARS escape hatch explicitly with its justification; do not silently formalize malformed requirements as though they were valid EARS.
- Parse scenarios structurally rather than treating markdown fields such as `**Postcondition:**` as ordinary prose.

This resolves current taxonomy drift across `docs/design.md`, `ARCHITECTURE.md`, and `openspec/specs/`, and prevents invalid claims entering formalization.

## Introduce Versioned Semantics

Keep the current IR and analysis as `static-v1`. It should remain available unchanged for existing regression fixtures, reports, clustering, global SAT, conditional-conflict, completeness, and cross-implication behavior.

Add `temporal-v2`, backed by a typed semantic IR rather than SMT expression strings. The current raw expression IR (`src/domain/logic-ir.ts`) and validator only check shallow shape and parentheses (`src/domain/formal/validate.ts`), so neither can establish that generated SMT preserves EARS intent.

The new IR should model:

- Typed expressions and full type, symbol, and function-arity checking.
- Domain sorts: booleans, mathematical integers/reals, enums or algebraic datatypes, records, optional values, sets/maps/arrays, and uninterpreted sorts only where domain behavior is intentionally unspecified.
- State variables, immutable configuration, events, initial conditions, transition rules, environment assumptions, frame conditions, and fairness assumptions.
- Requirement provenance on every semantic clause.
- Response timing: `same-step`, `next-step`, `within(k)`, `eventually`, or `unspecified`.

Do not invent timing from an EARS keyword. If timing is not written, retain `static-v1` semantics and report that temporal interpretation is unresolved, or require an explicit project-level timing profile.

## Compile Temporal Semantics With BMC

Compile `temporal-v2` into bounded, time-indexed SMT:

- `StateField(t)` represents state at step `t`.
- `Event(t)` represents an occurrence, not a timeless Boolean.
- Event-driven rules become `Event(t) => Response(t + delay)`.
- State-driven rules become `State(t) => Response(t)`.
- Complex rules become `State(t) and Event(t) => Response(t + delay)`.
- Ubiquitous rules become invariants over all bounded steps.
- Frame conditions preserve state not modified by a transition.

Use a deliberately conservative Z3 subset by default: quantifier-free bounded encodings, algebraic datatypes/enums for finite modes, arrays/sets for collections, and `Int`/`Real` only when the requirement demands arithmetic. Avoid unrestricted quantifiers, strings, and bit-vectors unless a requirement specifically needs their semantics.

## Preserve And Improve Analysis

Run analyses side by side, labeled by semantic version:

- `static-v1`: preserve the existing SAT, unsat-core, guard activation, and static coverage behavior exactly.
- `temporal-v2`: add initial-state satisfiability, bounded invariant violation, reachable co-enabled event conflicts, transition/frame conflicts, reachable coverage gaps, and bounded response/liveness counterexamples.
- Emit decoded counterexample traces with time step, triggering event, relevant state values, source requirement IDs, and assumptions.
- Keep "unreachable" distinct from "not proven reachable," and "boundedly checked" distinct from proof.
- Run cross-side implication only between artifacts using the same semantic version and compatible symbol model.

This fixes the current misuse of "reachable": the completeness check currently searches arbitrary assignments, not states reachable from initial conditions and transitions (`src/domain/formal/logic-analysis-checks.ts:483-567`).

## Implementation Sequence

1. Define one normative EARS profile in OpenSpec and documentation, with a formal grammar, modal policy, escape-hatch syntax, and explicit treatment of `WHERE`.
2. Add the deterministic EARS AST and strict parser; block invalid requirements from semantic formalization while preserving them as traceable degraded evidence.
3. Lock down `static-v1` with golden SMT and finding-regression tests.
4. Add the typed semantic IR, symbol registry, expression type checker, and semantic provenance validation.
5. Update formalization prompts so the LLM maps clause contents into typed predicates, while the deterministic EARS AST controls the guard, response, modality, and timing skeleton.
6. Implement time-indexed `temporal-v2` compilation and bounded trace decoding.
7. Add temporal checks and reporting alongside existing static findings.
8. Migrate cross-implication and code-derived formalization after semantic-version compatibility is enforced.

## Tests To Add

- Parser negative cases: keyword substrings, reversed clauses, missing delimiters, empty clauses, invalid modality, malformed `IF`, and invalid escape hatches.
- AST-to-semantics golden tests for every EARS form.
- Type/arity/sort/reference validation tests for the new IR.
- BMC fixtures for vacuous triggers, conflicting simultaneous events, delayed responses, frame-condition violations, reachable versus merely satisfiable gaps, and bounded liveness.
- Metamorphic tests for stuttering and time-shift invariance.
- Compatibility tests proving `static-v1` output and existing findings do not change.

## Decisions Needed

1. Should `WHERE ...` remain a supported extension, or should the parser accept only the five core forms?
2. For `WHEN` requirements without explicit timing, should the tool require authors to specify timing, or apply a documented default such as same-step?
