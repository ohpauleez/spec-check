# spec-check

`spec-check` is a TypeScript CLI that analyzes OpenSpec specifications for defects, ambiguity, contradictions, and missing assumptions before implementation begins, and optionally compares specification intent against code-derived guarantees.

It is intentionally narrow: `spec-check` is a read-only analysis tool, not a code generator or specification editor. Specifications are the source of truth for intended behavior, source code is the source of truth for implemented behavior, and SMT-backed formal analysis bridges the two.

Canonical project docs:
- [Technical design](docs/design.md)
- [Architecture codemap](ARCHITECTURE.md)
- [Lightweight formal methods](docs/lfm.md)
- [TypeScript style guide](docs/typescript_style.md)
- [OpenSpec capability specs](openspec/specs/)

## Overview

`spec-check` exists to catch specification defects early enough that developers can correct them before defects spread through the software development lifecycle. It is designed for projects that use the [`srs-driven`](https://github.com/ohpauleez/openspec_srs-driven) OpenSpec schema and treat lightweight formal methods as practical engineering discipline.

At a high level it supports:
- **specs-forward analysis**: qualitative review, coverage analysis, formalization, and solver-backed logic checks across `proposal.md`, `design.md`, and active `spec.md` files
- **formalization pipeline**: translates requirement and scenario claims into typed logic IR, clusters alternate interpretations, and generates SMT-LIB artifacts for Z3 analysis
- **optional source-backed analysis**: traces requirements to source evidence, generates EARS-preferring code-derived specifications, formalizes them through the same pipeline, and uses solver-backed cross-side implication as the primary strength classifier
- **evidence-preserving reports**: bounded Markdown reports with provenance, intermediate artifacts, and manifest-based completion semantics

For the full design rationale, see [docs/design.md](docs/design.md).

## Runtime And Tooling

Runtime requirements:
- Node.js `>= 20` ([package.json](package.json))
- `npm`
- `opencode` binary configured locally for LLM-backed analysis phases
- `z3` binary for solver-backed analysis phases

Notes:
- `spec-check` does not manage `opencode` or `z3` configuration for you.
- All output writes are confined to the configured output directory (default `./build/spec-check`).

Build and packaging:
- compiled CLI entrypoint: `dist/src/index.js`
- bundled single-file artifact: `dist/spec-check.js`
- See the [docs/design.md](docs/design.md) or individual [capability specs](openspec/specs/) for more details

## Usage

Basic form:

```sh
spec-check [OPTIONS] [INPUT FILES...]
```

### Example

```sh
node dist/spec-check.js \
  openspec/changes/spec-check-core/proposal.md \
  openspec/changes/spec-check-core/design.md \
  openspec/changes/spec-check-core/specs/claim-graph-and-coverage/spec.md \
  openspec/changes/spec-check-core/specs/claim-graph-and-coverage/spec.md \
  openspec/changes/spec-check-core/specs/formalization-and-logic-analysis/spec.md \
  openspec/changes/spec-check-core/specs/reporting-and-evidence/spec.md \
  openspec/changes/spec-check-core/specs/source-traceability-and-code-backwards/spec.md \
  openspec/changes/spec-check-core/proposal.md \
  openspec/changes/spec-check-core/design.md \
  --src src
```

### Options

| Option | Purpose |
|---|---|
| `--output <dir>` | Output directory for reports and artifacts (default `./build/spec-check`) |
| `--src <dir>` | Source directory; enables code-backwards analysis |
| `--caps <file>` | Capability listing file; inferred from inputs by default |
| `--z3 <path>` | Path to the Z3 binary (default: `z3` on PATH) |
| `--config <file>` | JSON configuration file for model and prompt settings |
| `--pair-budget <n>` | Maximum pairwise comparisons for cross-side implication (default 200) |
| `--help` | Show help |
| `--version` | Show version |

### Exit Codes

| Code | Meaning |
|---|---|
| 0 | Analysis completed without findings |
| 1 | Analysis completed and surfaced one or more findings |
| 2-11 | Fatal error prevented successful analysis (see [proposal](openspec/changes/archive/2026-06-18-spec-check-core/proposal.md) for full table) |

## Makefile

The top-level [Makefile](Makefile) is the main convenience entrypoint.
The default target is `check`, so plain `make` runs the full local verification pipeline.

| Target | What it does |
|---|---|
| `make tooling` | Download additional verification tooling to `./tooling/` |
| `make format` | Force uniform style / lint fixes |
| `make check` | Run lint, build, and all tests (with spec-tracing enabled) |
| `make test` | Run the test suite (with spec-tracing disabled) |
| `make dist` | Build all distribution artifacts |
| `make run [args...]` | Run the compiled CLI via `node ./dist/src/index.js` |
| `make clean` | Remove `./dist` |

## Architecture

The main repository areas are:
- [src/](src/) - implementation code
- [src/index.ts](src/index.ts) - CLI entrypoint and exit code mapping
- [src/cli/](src/cli/) - argv parsing, config loading, pipeline orchestration
- [src/domain/](src/domain/) - deterministic domain logic, parsers, claim graph, formalization, findings, and errors
- [src/domain/parser/](src/domain/parser/) - line-oriented parsers for proposal, design, spec, and task documents
- [src/domain/spec-forward/](src/domain/spec-forward/) - qualitative review and coverage analysis
- [src/domain/formal/](src/domain/formal/) - formalization sampling, validation, clustering, SMT-LIB compilation, and solver analysis
- [src/domain/code-backwards/](src/domain/code-backwards/) - source traceability, code-derived spec generation, cross-side implication, and blind comparison
- [src/domain/reporting/](src/domain/reporting/) - report rendering and manifest generation
- [src/adapters/](src/adapters/) - filesystem, subprocess, `opencode`, and `z3` boundaries
- [test/](test/) - contract, property, integration, determinism, invariant, and oracle tests
- [build/](build/) - build and bundling scripts
- [openspec/](openspec/) - proposals, tasks, and normative capability specs
- [docs/](docs/) - design and engineering guidance

The architectural rule of thumb is:
- `src/domain/` owns rules and invariants
- `src/adapters/` owns side effects
- `src/cli/` composes the two

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full codemap and architectural boundaries.

## Lightweight Formal Methods

This project explicitly uses lightweight formal methods to increase confidence without aiming for a proof of the whole system.

In practice that means:
- identifying critical properties and invariants first
- translating requirement and scenario claims into typed logic IR and SMT-LIB artifacts
- using solver-backed analysis (Z3) to detect contradictions, completeness gaps, and cross-side implication
- clustering formalization samples to surface genuine ambiguity
- keeping the core deterministic and pushing nondeterminism to the edges
- using layered evidence: specs, models, property tests, contract tests, integration tests, and traceability

Relevant references:
- [docs/lfm.md](docs/lfm.md)
- [docs/design.md](docs/design.md)
- [spec traceability](docs/spec_traceability.md)

## Style Guide

Code in this repository follows the guidance in [docs/typescript_style.md](docs/typescript_style.md).

Key expectations include:
- invariants-first design
- deterministic systems and explicit state machines
- simple, bounded control flow
- `Result`-style error handling for expected failures
- strong boundary validation
- strict TypeScript and zero normalized lint debt
- complete TSDoc for public code

## Canonical Documents

Start here depending on what you need:
- product and behavior overview: [docs/design.md](docs/design.md)
- code layout and change boundaries: [ARCHITECTURE.md](ARCHITECTURE.md)
- assurance and verification posture: [docs/lfm.md](docs/lfm.md)
- coding rules and review expectations: [docs/typescript_style.md](docs/typescript_style.md)
- normative requirements: [openspec/specs/](openspec/specs/)

Primary capability specs:
- [catalog-and-parse](openspec/specs/catalog-and-parse/spec.md)
- [claim-graph-and-coverage](openspec/specs/claim-graph-and-coverage/spec.md)
- [formalization-and-logic-analysis](openspec/specs/formalization-and-logic-analysis/spec.md)
- [source-traceability-and-code-backwards](openspec/specs/source-traceability-and-code-backwards/spec.md)
- [reporting-and-evidence](openspec/specs/reporting-and-evidence/spec.md)
- [spec-traceability](openspec/specs/spec-traceability/spec.md)

### License

<sup>
Licensed under either of <a href="LICENSE-APACHE">Apache License, Version
2.0</a> or <a href="LICENSE-MIT">MIT license</a> at your option.
</sup>

<br>

<sub>
Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project by you, as defined in the Apache-2.0 license, shall
be dual licensed as above, without any additional terms or conditions.
</sub>
