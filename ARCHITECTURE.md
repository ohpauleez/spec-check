# Architecture

This document is a codemap for `spec-check`. It is aimed at contributors who need to answer two questions quickly:

- where does behavior for a given pipeline phase or concern live?
- what architectural boundaries should not be crossed when changing the code?

`spec-check` is a local TypeScript CLI for analyzing OpenSpec specifications that use the `srs-driven` schema. It is intentionally organized as a phase-oriented analysis pipeline with a deterministic core and two explicit nondeterministic boundaries:

- `opencode` for LLM-backed qualitative review, formalization, code-derived generation, and blind comparison
- `z3` for solver-backed equivalence, contradiction, completeness, and cross-side implication checks

The core product details are:

- input specs and source trees are read-only
- parsed structure, claims, findings, and reports are explicit typed artifacts
- preserved evidence matters as much as verdicts
- manifest presence is the completion marker for a trustworthy run

The living design doc under [`docs/design.md`](docs/design.md) is the durable design intent for the product. This file complements it by mapping that intent onto the code that exists in this repository today.

This project follows the lightweight formal methods guidance in [`docs/lfm.md`](docs/lfm.md).
All code adheres to the style guide defined in [`docs/typescript_style.md`](docs/typescript_style.md).

## Overview

At the highest level, `spec-check` uses a layered architecture that takes CLI/config input, resolves a catalog of OpenSpec documents, parses them into structured models, builds a claim graph, runs analysis phases, and writes reports plus a manifest into the configured output directory.

```text
user invocation
    |
    v
src/index.ts
    |
    v
src/cli/parse-argv.ts + src/cli/config.ts
    |
    v
src/cli/run-cli.ts
    |
    +--> ingestion
    |      src/domain/parser/catalog.ts
    |      src/domain/parser/{proposal,design,spec,task}.ts
    |
    +--> per-capability merge
    |      src/domain/parser/merge.ts
    |
    +--> normalization
    |      src/domain/claim-graph.ts
    |
    +--> specs-forward analysis
    |      src/domain/spec-forward/{coverage,qualitative}.ts
    |      src/domain/formal/{formalize,clustering,logic-analysis}.ts
    |
    +--> optional source-backed analysis (--src)
    |      src/domain/code-backwards/{trace,derive,gen-formal,gen-logic,cross-implication,blind-compare}.ts
    |
    +--> reporting
           src/domain/reporting/{render,manifest}.ts
                    |
                    v
              output directory
              reports + smt + gen_specs + manifest.json

external boundaries used along the way:
  src/adapters/opencode.ts -> opencode
  src/adapters/z3.ts       -> z3
  src/adapters/fs.ts       -> output filesystem
  src/adapters/process.ts  -> argv-only subprocess execution
```

The most important split is not “CLI vs library”, but “phase orchestration vs deterministic transformations vs external-tool boundaries”. `src/cli/run-cli.ts` is the orchestrator. Most reasoning lives in `src/domain/`. Boundary-specific mechanics live in `src/adapters/`.

One caveat about the current implementation: some parser and source-analysis modules in `src/domain/` still perform direct file reads. Treat them as part of the read-only analysis core, but do not use that as precedent for adding output-writing or subprocess side effects there.

## Code Map

### Repository Roots

- `src/`: implementation code for the CLI, analysis pipeline, and boundary adapters
- `test/`: contract, property, invariant, determinism, oracle, and integration tests
- `build/`: esbuild bundling entrypoint for `dist/spec-check.js`
- `dist/`: bundled CLI artifact output
- `openspec/`: proposal, design, tasks, and specs that define intended product behavior
- `docs/`: project-wide guidance including `lfm.md`, `typescript_style.md`, and `spec_traceability.md`
- `spec-check-output/`: sample/default output directory from local runs

### `src/index.ts`

`src/index.ts` is the entrypoint.

Start here when you need to understand the top-level CLI contract:

- raw argv parsing
- `--help` and `--version` fast paths
- config resolution before analysis begins
- top-level pipeline invocation
- mapping structured errors into fixed exit codes
- stdout/stderr split: progress JSON on stdout, fatal diagnostics on stderr

If you need to change CLI surface behavior, process exit semantics, or global error rendering, start here.

### `src/cli/`

`src/cli/` is the orchestration layer. It translates user input into a validated run configuration and then executes the phase pipeline.

#### `src/cli/parse-argv.ts`

This module owns the raw CLI contract:

- positional inputs
- `--output`
- `--src`
- `--caps`
- `--z3`
- `--model`
- `--config`
- `--pair-budget`
- `--timeout-ms`
- `--allow-archive`
- `--help` / `--version`
- unknown-flag and missing-value rejection

If a change starts with “the CLI should accept…”, start here.

#### `src/cli/config.ts`

This module resolves effective runtime configuration by merging CLI flags, JSON config file values, and defaults.

It also owns a key safety rule: output must not live inside the configured source tree.

If a change starts with “allow configuration for…” or “validate this run setting…”, start here.

#### `src/cli/run-cli.ts`

This is the orchestration center of the program.

It defines the actual runtime phase grouping:

- ingestion: dependency check, catalog, parse
- per-capability merge: merge finalized and delta specs into merged capability views
- analysis: claim graph, qualitative, formalization, clustering, logic
- optional source-backed phases when `--src` is set
- reporting and manifest writing

It also owns:

- progress-event emission
- append-only accumulation of findings into `RunState`
- typed pipeline abort propagation with `PipelineAbortError`
- wiring between specs-forward and code-backwards phases

If you need the end-to-end flow of the product, read this file before reading anything else.

### `src/domain/`

`src/domain/` is the analysis core. This is where the typed internal model lives and where most behavior should be expressed as deterministic transformations or explicit phase logic.

#### Core Contracts and Utilities

- `result.ts`: explicit `Result<T, E>` type used for expected failures
- `findings.ts`: the stable shape of surfaced analysis findings
- `errors.ts`: fatal error hierarchy and exit-code mapping
- `assert.ts`: runtime invariant utilities for programmer errors
- `branded.ts`: compile-time branded types for paths, IDs, model names, and SMT content
- `run-state.ts`: append-only run accumulator for findings and completed phases
- `progress.ts`: structured stdout progress events
- `fence.ts`: prompt-fencing helper used to neutralize code-fence injection

These files define the contracts that almost every other module depends on.

#### Parsed Models and Claim Graph

- `model.ts`: parsed document shapes and catalog document types
- `claim-graph.ts`: normalization from parsed artifacts into typed claims with obligation and provenance

`parser/merge.ts` is the hinge between parsing and analysis. It merges finalized and delta specs per capability into a single active view, applying ADDED/MODIFIED/REMOVED operations and emitting merge findings. The claim graph then consumes these merged capability specs rather than raw parsed specs for spec-derived claims.

If you are changing what a “claim” is, what counts as provenance, or how obligation level is derived, start at `claim-graph.ts`. If you are changing how delta specs affect the active capability state, start at `parser/merge.ts`.

#### Parsing and Catalog

- `parser/catalog.ts`: input discovery, OpenSpec document classification, archived-change exclusion, active-delta selection, and delta conflict findings
  - archive admission defaults to excluded; `--allow-archive` only admits explicitly provided archived inputs
- `parser/merge.ts`: per-capability merge of finalized and delta specs; applies ADDED/MODIFIED/REMOVED block semantics; emits deterministic merge findings
- `parser/shared.ts`: heading parsing, canonical ID extraction, provenance helpers, and unparsed-line collection
- `parser/proposal.ts`: line-oriented proposal section extraction
- `parser/design.ts`: line-oriented design section extraction
- `parser/spec.ts`: requirement/scenario parsing, EARS classification, references extraction, and structural findings
- `parser/task.ts`: task groups, checkbox extraction, and change summary parsing

This is where the repository’s `srs-driven` specialization is encoded. The parser is intentionally not a generic Markdown AST pipeline.

If you are changing recognized document structure or section conventions, start here before touching downstream analysis.

#### Specs-Forward Analysis

- `spec-forward/coverage.ts`: deterministic coverage, contradiction, drift, and task/spec consistency checks
- `spec-forward/qualitative.ts`: LLM-backed review passes, fenced prompt construction, and finding normalization

The important split here is:

- `coverage.ts` is deterministic and heuristic
- `qualitative.ts` is nondeterministic at the `opencode` boundary but validates returned structure before surfacing findings

If a change is about proposal/design/spec alignment, this is usually the first directory to inspect.

#### Prompt Construction

- `prompts/qualitative-base.ts`
- `prompts/qualitative-review.ts`
- `prompts/qualitative-properties.ts`
- `prompts/formalization.ts`
- `prompts/informalize.ts`
- `prompts/blind-compare.ts`

The prompt text is deliberately isolated from phase logic. If you need to tune LLM behavior without changing orchestration, this is the seam.
Prompt text can also be overridden in the config.

#### Formalization and Solver Analysis

- `logic-ir.ts`: typed logic intermediate representation
- `formal/validate.ts`: schema validation for formalization samples
- `formal/formalize.ts`: batch and per-claim formalization sampling through `opencode`
- `formal/smtlib.ts`: SMT-LIB compilation, identifier sanitization, unsat-core label handling, and parse helpers
- `formal/clustering.ts`: pairwise implication checks and equivalence clustering for alternate formalizations
- `formal/logic-analysis.ts`: per-spec combined solver analysis, contradiction detection, conditional contradiction checks, and completeness-gap detection

This area is the formal core of the product.

The key architectural choice is that ambiguity is not hidden. Multiple candidate formalizations are sampled, clustered, and either reduced to a stable representative or surfaced as ambiguity.

If you are changing solver semantics, contradiction severity, SMT generation, or clustering rules, these modules are more important than the CLI layer.

#### Source Traceability and Code-Backwards Analysis

- `code-backwards/trace.ts`: canonical identifier scanning and evidence-strength classification
- `tasks-analysis.ts`: task evidence vs traced-source consistency
- `code-backwards/derive.ts`: blind code-derived spec generation from source context
- `code-backwards/gen-formal.ts`: formalization of generated specs and `gen_specs_smt/` output
- `code-backwards/gen-logic.ts`: internal consistency analysis of code-derived formalizations
- `code-backwards/cross-implication.ts`: original-vs-generated implication checks, capability aggregate comparison, pair-budgeted pairwise matching, and divergence summaries
- `code-backwards/blind-compare.ts`: explanatory LLM rationale layered on top of formal cross-side classification

This is the most cross-cutting area of the codebase. It touches source evidence, formal artifacts, persisted comparison evidence, and a strict blind-boundary rule.

If you are changing `--src` behavior, capability matching, or the relationship between original and code-derived behavior, start here.

#### Reporting

- `reporting/render.ts`: phase report rendering and summary report generation
- `reporting/manifest.ts`: manifest entry construction, manifest-last completion semantics, and stale-manifest invalidation

This is where analysis results turn into repository-facing artifacts.

If you need to change output filenames, report structure, or completion semantics, start here.

### `src/adapters/`

`src/adapters/` contains boundary-specific mechanics.

#### `src/adapters/process.ts`

This is the lowest-level subprocess adapter.

Its main job is to keep external execution argv-based rather than shell-based. A large part of the project’s safety story depends on avoiding shell interpolation of user-derived values.

#### `src/adapters/opencode.ts`

This is the LLM boundary.

It owns:

- `opencode run --model ... --format json ...` argv construction
- ordered `--file <path>` attachments before the instruction prompt
- bounded retries and timeout handling
- prompt-size bound enforcement using UTF-8 byte counts
- NDJSON-like event parsing
- deterministic JSON extraction cascade (direct, fenced, wrapped)
- `type:"error"` event detection
- minimal phase-schema validation before returning payloads upstream

The rest of the system should not know how `opencode` streams events.

#### `src/adapters/z3.ts`

This is the solver boundary.

It owns:

- piping SMT-LIB over stdin
- timeout classification
- result classification into `sat` / `unsat` / `unknown` / `timeout` / `error`
- treating `(error ...)` diagnostics as solver failure, not success

The rest of the system should mostly reason in terms of implication and contradiction outcomes, not raw process mechanics.

#### `src/adapters/fs.ts`

This is the output-write boundary.

It owns:

- output-path confinement
- atomic file writes via temp file + rename
- checksum generation for manifest entries

All output artifact writes should pass through here.

#### `src/adapters/concurrency.ts`

This module provides bounded-concurrency utilities used across LLM calls, solver calls, and filesystem-heavy scans.

It preserves input ordering while allowing controlled parallelism.

### `build/`

- `build/esbuild.ts`: bundles `src/index.ts` into `dist/spec-check.js` and injects the build-time version constant

This is intentionally small. Packaging matters because the distributed CLI contract includes help/version parity and the bundled entrypoint.

### `test/`

The tests are split by verification style rather than mirroring `src/` exactly.

#### `test/contract/`

These are the highest-signal tests for public behavior and module contracts:

- CLI and config behavior
- parser behavior
- claim graph and coverage behavior
- adapter contracts for `opencode`, `z3`, `fs`, and `process`
- report and manifest behavior
- code-backwards and cross-implication contracts
- distribution and parity checks

If you are changing a stable contract, this directory is likely to need updates.

#### `test/property/`

These tests exercise invariants mechanically, especially with `fast-check`.

Representative concerns include:

- parser determinism and no-silent-loss behavior
- claim graph provenance invariants
- cross-implication classification properties
- manifest and run-state append-only behavior
- code-derived and blind-comparison boundary properties

If you are changing invariants, state machines, state transition logic, determinism-sensitive logic, this directory matters at least as much as the contract tests.

#### `test/invariant/`

These tests encode broader safety/liveness and global invariants across subsystems.

#### `test/determinism/`

These tests check that the pipeline and selected subsystems produce repeatable output under fixed boundary responses.

#### `test/integration/`

These tests validate multi-module composition:

- full pipeline flow
- specs-forward flow
- code-backwards flow
- Z3/SMT integration seams

Use them when you need confidence that several phases still compose after a change.

#### `test/oracle/`

These tests check expected logic behavior for known EARS-style inputs.

#### `test/support/`

Shared testing infrastructure lives here, especially spec traceability helpers.

## Pipeline Phases

The code is easiest to navigate if you think in terms of runtime phases.

### Ingestion

- dependency checks
- catalog discovery
- document parsing
- per-capability merge (finalized + delta → merged active view)

Primary code:

- `src/cli/run-cli.ts`
- `src/domain/parser/catalog.ts`
- `src/domain/parser/*` (including `merge.ts`)
- `src/adapters/process.ts`

### Specs-Forward Analysis

- claim graph construction (from merged capability views)
- deterministic coverage analysis
- qualitative review passes
- formalization
- clustering
- combined per-spec solver analysis

Primary code:

- `src/domain/claim-graph.ts`
- `src/domain/spec-forward/*`
- `src/domain/formal/*`

### Source-Backed Analysis

- identifier tracing into source
- task/source corroboration
- blind code-derived spec generation
- formalization and logic analysis of generated specs
- formal cross-side implication
- explanatory blind comparison

Primary code:

- `src/domain/code-backwards/*`
- `src/domain/tasks-analysis.ts`

### Reporting

- phase reports
- summary report
- manifest

Primary code:

- `src/domain/reporting/*`
- `src/adapters/fs.ts`

## Architecture Invariants

These are the most important things to preserve when changing the code.

### Read-Only Input Rule

- Specs, task files, and source files are analysis inputs only.
- The program may read them, parse them, and derive artifacts from them, but it must not mutate them.

### Boundary Rule

- `opencode` and `z3` are the explicit nondeterministic boundaries.
- Everything between parsing and reporting should stay inspectable and typed.
- New subprocess usage should go through `src/adapters/process.ts` or an adapter built on top of it.

### Output Confinement Rule

- All generated artifacts must stay under the configured output directory.
- Output writes should go through `src/adapters/fs.ts`.
- Manifest presence is the completion marker; manifest absence means the run is incomplete.

### Finding Preservation Rule

- Findings are append-only across phases.
- Later phases may add more evidence or new findings, but should not silently erase earlier findings.

### Provenance Rule

- Every meaningful finding should carry provenance and evidence.
- Parser modules preserve unmatched lines rather than silently dropping them.
- Unsupported conclusions should be suppressed into explicit reporting defects rather than rendered as if trustworthy.

### Blind Comparison Rule

- Original requirement text must not leak into code-derived generation or blind comparison prompts.
- Formal cross-side implication is the primary classifier.
- Blind comparison is explanatory, not authoritative when formal evidence is available.

### Thin Adapter Rule

- Adapters should own process, filesystem, and external-tool mechanics.
- Domain modules should not grow shell/protocol details inline.
- The current direct file reads in some domain modules are a tolerated implementation detail, not a pattern to extend for side-effect-heavy work.

## Cross-Cutting Concerns

### Evidence Preservation

The product is not just a verdict engine. It preserves:

- parser findings
- normalized findings
- SMT-LIB artifacts
- solver stdout/stderr
- generated specs
- report files
- manifest checksums

When in doubt, prefer preserving inspectable evidence over collapsing it into a summary.

### Bounded Work

LLM calls, solver calls, and large scans are all bounded by timeouts, retries, size limits, or pair budgets. If you add a new expensive phase, it should be visibly bounded in the same style.

### Deterministic Core

Even where the product depends on LLMs, the repository’s intent is to keep:

- parsing deterministic
- claim normalization deterministic
- coverage analysis deterministic
- report assembly deterministic
- boundary validation explicit

If a change introduces more nondeterminism, isolate it at a named boundary.

### Verification Style

The tests are intentionally split across contract, property, and integration boundaries. The important idea is not just “have tests”, but “put tests at the seams where invariants can be checked mechanically”.

The OpenSpec change and `docs/lfm.md` provide the rationale; the `test/` tree shows how that approach is applied in code.

### Distribution Parity

The project supports both the TypeScript build and the bundled `dist/spec-check.js` artifact. Packaging is part of the product contract, not an afterthought.

## Relationship To OpenSpec

This project uses spec-driven development with OpenSpec (using the [srs-driven schema](https://github.com/ohpauleez/openspec_srs-driven)) to make changes.
This repository uses OpenSpec to define the intended behavior of `spec-check` itself.

For product intent, start in `openspec/`:

- `proposal.md`: problem statement, product motivation, capability descriptions, invariants, and failure modes
- `design.md`: phase-oriented/layered architecture, state machine framing, and intended component responsibilities
- `tasks.md`: implementation history and task-level breakdown
- `specs/*`: capability-specific requirements for document parsing, claim graph construction, logical analysis, etc.

Use this `ARCHITECTURE.md` when you need to know where a change belongs in the code. Use the OpenSpec change when you need to know what behavior the code is supposed to preserve.

### spec.md

All spec.md files define the system's verifiable behavior using EARS format and RFC 2119 keywords:

| Pattern           | Template                                                               | When to use                        |
|-------------------|------------------------------------------------------------------------|------------------------------------|
| Ubiquitous        | `THE <system> SHALL <response>.`                                       | Always active                      |
| State-driven      | `WHILE <precondition>, THE <system> SHALL <response>.`                 | Active in a continuous state       |
| Event-driven      | `WHEN <trigger>, THE <system> SHALL <response>.`                       | Discrete event causes behavior     |
| Unwanted-behavior | `IF <trigger>, THEN THE <system> SHALL <response>.`                    | Error/failure handling, edge cases |
| Complex           | `WHILE <precondition>, WHEN <trigger>, THE <system> SHALL <response>.` | Both state and event required      |
| Optional          | `WHERE <feature is included>, THE <system> SHALL <response>.`          | Optional/configurable behavior     |

RFC 2119: SHALL/MUST = absolute requirement, SHOULD = recommended, MAY = optional.

Escape hatch: When a requirement has more than 3 preconditions or is mathematical/tabular, it MAY use decision tables, lists, or other formats. The requirement MUST include a justification for why EARS is insufficient.

Specs are traceable through the code and tests using [spec-traceability](docs/spec_traceability.md). Canonical identifiers are authored in brackets in spec markdown (e.g., `[TRACE-ID-SYNTAX]`), and tests declare coverage via `traceSpec(...)` calls with the bare identifier. Test tooling ensures that all specs are covered by tests.

### Existing Specs

- [catalog-and-parse](/openspec/specs/catalog-and-parse/spec.md) - Define the catalog, input resolution, and structured parsing behavior for the spec-check CLI: discovering relevant OpenSpec artifacts, resolving active capability state, parsing structured content, and producing deterministic structural findings with provenance.
- [claim-graph-and-coverage](/openspec/specs/claim-graph-and-coverage/spec.md) - Define the claim graph construction and coverage analysis behavior for the spec-check tool: normalizing parsed content into typed claims and analyzing coverage, contradiction, and semantic alignment across proposal, design, and capability specs.
- [formalization-and-logic-analysis](/openspec/specs/formalization-and-logic-analysis/spec.md) - Define the formalization and solver-backed logic analysis behavior for the spec-check tool: translating claims into formal artifacts, clustering alternate interpretations, and using solver-backed analysis to detect conflicts, gaps, and surprising behaviors.
- [source-traceability-and-code-backwards](/openspec/specs/source-traceability-and-code-backwards/spec.md) - Define the source traceability and code-backwards comparison behavior for the spec-check tool: relating requirements to source evidence, generating EARS-preferring code-derived specifications from source, formalizing code-derived specifications through the same sampling and clustering pipeline, using solver-backed cross-side implication as the primary strength classifier, and providing blind LLM comparison as the explanatory rationale layer.
- [reporting-and-evidence](/openspec/specs/reporting-and-evidence/spec.md) - Define the reporting and evidence preservation behavior for the spec-check tool: producing bounded, evidence-preserving output artifacts, final reports, and manifest-based completion records.
- [spec-traceability](/openspec/specs/spec-traceability/spec.md) - Define the OpenSpec traceability behavior for the repository's TypeScript/Vitest test harness: discovering canonical identifiers from included OpenSpec specs, validating explicit `traceSpec(...)` declarations in tests, reporting provenance-aware diagnostics, and enforcing full-catalog coverage in a dedicated full-suite mode.
