## Motivation

The repository already uses canonical OpenSpec identifiers in `openspec/specs/**/spec.md`, but nothing in the TypeScript/Vitest test harness checks that tests refer to real identifiers or that important requirements are covered by traced tests. Today that leaves a gap between the written specification and the automated verification suite: authors can add, rename, or remove identifiers in specs without any machine-checkable connection to tests.

This change introduces a small traceability utility for the TypeScript/Vitest stack so that tests can declare which canonical identifiers they verify and the test harness can validate those declarations. It also creates a dedicated full-suite coverage mode so CI can detect uncovered identifiers without making ordinary local test runs heavier than necessary.

## Scope

### In Scope
- Discover canonical identifiers from included OpenSpec `spec.md` files in this repository.
- Validate explicit traced test declarations in Vitest test bodies.
- Fail traced tests on empty declarations, malformed identifiers, and unknown identifiers.
- Report provenance-aware diagnostics for duplicate identifiers and uncovered identifiers.
- Add a dedicated full-suite `test:trace` command that enforces canonical identifier coverage.
- Document the review-only requirement pattern for requirements that are verified by reasoning rather than executable assertions.

### Out of Scope
- Enforcing TSDoc or implementation-code traceability annotations.
- Requiring every test in the suite to participate in traceability.
- Inferring traceability from test names, file names, or source layout.
- Parsing archived change specs into the canonical catalog.
- Changing existing product requirements for box registry, remote access, instance lifecycle, or distribution behavior.

## Context

This project uses the lightweight formal methods principles described in `docs/lfm.md`.
The source code within this project adheres to the principles described in `docs/typescript_style.md`.

### Background
The repository already maintains capability specs under `openspec/specs/` using visible canonical identifiers on `Requirement` and `Scenario` headers. The test suite runs under Vitest with a minimal root configuration and currently has no traceability support module, no markdown parser dependency, and no dedicated coverage mode for spec identifiers.

The initial design work for a similar Java/JUnit system established the core product shape: canonical identifiers come from OpenSpec markdown, traced tests declare identifiers explicitly, malformed and unknown references fail the declaring test, and coverage enforcement is separate from ordinary validation. This change adapts that model to TypeScript and Vitest while preserving the repository's preference for small purpose-built tooling.

### Affected Systems and Stakeholders
- The `openspec/specs/**/spec.md` corpus, which becomes the canonical source for traceability identifiers.
- The Vitest-based test suite under `test/**/*.test.ts`.
- Developers writing or modifying specs and tests for this repository.
- CI and release verification flows that will use the full-suite trace coverage command.

### Assumptions and Dependencies
- Canonical identifiers continue to be authored in square brackets on `Requirement` and `Scenario` headers or other non-code markdown locations.
- Vitest supports enough runtime context to associate a `traceSpec(...)` call with the currently executing test.
- The repository continues to prefer minimal dependencies unless markdown edge cases force a larger parser.
- The full-suite coverage command will be run intentionally, typically in CI or as a pre-merge verification step.

### Constraints
- Ordinary `npm test` runs must remain lightweight and should validate traced declarations without requiring full global coverage.
- The utility must work with the repository's current TypeScript and Vitest setup without hidden globals as the primary public API.
- Archived change specs under `openspec/changes/archive/**` must not contribute canonical identifiers.
- Only tests are enforceably traced in this change; code-level references remain convention only.

### References
- `pasture/spec-traceability/plan.md`
- `docs/lfm.md`
- `docs/typescript_style.md`
- `pasture/spec-traceability/java_spec_traceability.md`
- `pasture/spec-traceability/java_spec.md`

## Domain Model

The traceability domain has four main concepts:

- **Canonical Identifier**: A machine-readable requirement token such as `BOX-ALIAS-FAIL`, authored in square brackets in included OpenSpec markdown.
- **Canonical Catalog Entry**: The canonical identifier together with its provenance: defining file, defining line number, and nearest `Requirement` or `Scenario` heading when available.
- **Traced Test Declaration**: An explicit `traceSpec(...)` call inside a Vitest test body declaring one or more canonical identifiers that the test verifies.
- **Coverage Record**: The run-scoped set of canonical identifiers declared by traced tests during a full-suite coverage run.

Relationships:

- A canonical spec file defines zero or more canonical identifiers.
- A canonical identifier has exactly one defining provenance location across the included catalog, or catalog construction fails.
- A traced test declaration references one or more canonical identifiers.
- Multiple traced tests may reference the same canonical identifier.
- A full-suite coverage run compares the set of canonical identifiers to the set of declared identifiers observed during the run.

## Preconditions, Postconditions, and Invariants

- **Preconditions**
  - Included spec files exist under `openspec/specs/**/spec.md` and optionally active `openspec/changes/**/spec.md`.
  - Traced tests declare identifiers using the bare identifier form without brackets.
  - The dedicated coverage command is run as a full-suite command when global coverage enforcement is desired.
- **Postconditions**
  - Traced tests fail immediately when declarations are empty, malformed, or unknown.
  - Duplicate canonical identifiers across included spec files fail catalog construction before trace validation proceeds.
  - The full-suite coverage command fails if any canonical identifier is uncovered and passes trivially for an empty catalog.
- **Invariants**
  - Canonical identifiers are authoritative only when discovered from included non-archived OpenSpec `spec.md` files.
  - Tests without `traceSpec(...)` are unaffected by validation and coverage accounting.
  - Unknown or malformed trace declarations fail only the declaring test.
  - Coverage enforcement is separate from ordinary reference validation.
  - TSDoc or implementation-code references are not part of the enforced traceability contract.

## Failure Modes

- **Duplicate canonical identifier**: Two included spec files define the same canonical identifier and catalog construction fails before traced tests run.
  - **Rationale**: The system must preserve one authoritative definition site per identifier or provenance-based diagnostics become misleading.
- **Malformed traced identifier**: A traced test declares an identifier that does not match the canonical identifier format.
  - **Rationale**: Format failures should be explicit and local so authors can distinguish typo-shaped mistakes from missing catalog entries.
- **Unknown traced identifier**: A traced test declares a well-formed identifier that is not present in the canonical catalog.
  - **Rationale**: This catches stale tests, renamed requirements, and invented identifiers without disrupting unrelated tests.
- **Uncovered canonical identifier**: A full-suite coverage run completes without any traced test declaring a canonical identifier.
  - **Rationale**: The dedicated coverage command exists specifically to expose gaps between written requirements and the verification suite.
- **Empty catalog with traced declarations**: No canonical identifiers are discovered, but traced tests still declare identifiers and therefore fail as unknown references.
  - **Rationale**: An empty catalog must not silently make arbitrary identifiers appear valid.

## Quality Attributes

- **Correctness**
  - **Target/Threshold**: All traced declarations are validated against the full canonical catalog in every run.
  - **Influence**: The design prioritizes deterministic catalog construction, strict identifier validation, and provenance-aware diagnostics.
- **Developer Ergonomics**
  - **Target/Threshold**: Trace declarations are visible and require only an explicit helper call within ordinary, async, and parameterized Vitest tests.
  - **Influence**: The public API favors `traceSpec(...)` over wrappers or monkey-patching and keeps ordinary local runs lightweight.
- **Reliability**
  - **Target/Threshold**: Invalid traced declarations fail only the declaring test; duplicate catalog errors fail early before test validation proceeds.
  - **Influence**: The product experience must isolate local test mistakes while still failing fast on global catalog ambiguity.
- **Maintainability**
  - **Target/Threshold**: The parsing and validation design should remain small enough to unit test thoroughly without introducing a heavy markdown-processing stack by default.
  - **Influence**: The implementation should prefer a purpose-built scanner and minimal runtime machinery unless complexity proves otherwise.

## Capabilities

### New Capabilities
- `spec-traceability`: Canonical OpenSpec identifier discovery, explicit traced Vitest declarations, reference validation, and dedicated full-suite coverage enforcement.

### Modified Capabilities
- None.
