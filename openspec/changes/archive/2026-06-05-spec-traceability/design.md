## Context

### Current State
The repository has canonical OpenSpec specs under `openspec/specs/` and a TypeScript/Vitest test suite under `test/`, but no mechanism that connects the two at runtime. Identifiers already exist in current spec headers, the root `vitest.config.ts` is intentionally minimal, and `package.json` currently offers only ordinary test commands. There is no markdown parser dependency and no established test-support module for shared traceability utilities.

### Constraints and Architecture Drivers
- Ordinary local test runs must stay lightweight while still rejecting invalid trace declarations.
- The catalog must be built from included non-archived OpenSpec spec files only.
- The public API should stay explicit in test source rather than relying on hidden globals or widespread wrapper functions.
- The implementation should preserve provenance for diagnostics and fail fast on cross-file duplicate identifiers.
- The repository favors the smallest correct design and minimal dependencies.
- This project uses the lightweight formal methods principles described in `docs/lfm.md`.
- The code must adhere to the principles described in `docs/typescript_style.md`.

## Goals

- Build a deterministic canonical identifier catalog from included OpenSpec spec files.
- Expose an explicit `traceSpec(...ids)` helper for traced Vitest tests.
- Validate malformed and unknown identifiers against the full catalog in every run.
- Add a dedicated full-suite coverage mode that reports uncovered canonical identifiers with provenance.
- Keep the implementation small enough to unit test and reason about without a full markdown-processing stack.

### Non-Goals
- Enforcing TSDoc or production-code traceability annotations.
- Requiring every test to declare identifiers.
- Introducing a general-purpose markdown AST pipeline unless the simpler scanner proves insufficient.
- Changing existing product capabilities outside the new traceability capability.

## Proposed Design

### System Model

```mermaid
flowchart TD
  A[OpenSpec spec.md files] --> B[Catalog scanner]
  B --> C[Canonical catalog]
  C --> D[Vitest setup state]
  D --> E[traceSpec(...)]
  E --> F[Per-test validation]
  E --> G[Run coverage record]
  G --> H[Coverage enforcement in test:trace]
```

The design has four runtime layers:

1. A catalog scanner reads the included `openspec/specs/**/spec.md` and active `openspec/changes/**/spec.md` files, ignoring archived changes.
2. A canonical catalog stores identifiers and provenance.
3. Vitest setup initializes shared traceability state for the run.
4. The explicit `traceSpec(...)` API validates declarations immediately and contributes to run-scoped coverage accounting when coverage mode is enabled.

### Component Descriptions
- **Catalog scanner**: Walks included spec files, tracks fenced-code and inline-code exclusion state, extracts valid bracketed identifiers, records nearest heading context, and rejects cross-file duplicates.
- **Canonical catalog**: In-memory mapping from identifier to provenance, plus a stable identifier set used for coverage comparison.
- **Trace runtime state**: Run-scoped state exposed through the Vitest setup path, containing the catalog, current coverage-mode flag, and seen identifiers for the run.
- **`traceSpec(...)` helper**: Explicit import used inside test bodies to validate declarations and associate identifiers with the current test execution.
- **Coverage finalizer**: End-of-run comparison of catalog identifiers to traced identifiers observed during the full-suite coverage command.

### System Invariant Tactics
- Build the catalog from the full included spec set before traced validation begins so every traced test sees the same canonical universe.
- Reject cross-file duplicates during catalog construction so all later diagnostics refer to one authoritative provenance location per identifier.
- Normalize identifiers to the bare token format at the boundary between markdown extraction and runtime validation.
- Treat untraced tests as out of scope by requiring explicit `traceSpec(...)` opt-in rather than implicit discovery.
- Keep coverage enforcement behind a dedicated full-suite flag so ordinary validation and global coverage remain separate invariants.

### Quality Attribute Tactics
- **Correctness**: Use one identifier regex and one catalog source of truth for both scanner and runtime validation.
- **Developer ergonomics**: Fail inside the declaring test body so authors see local, familiar Vitest failures instead of detached post-processing errors for malformed and unknown references.
- **Reliability**: De-duplicate repeated identifiers within one test before coverage accounting so repeated declarations do not skew the coverage set.
- **Maintainability**: Use a purpose-built scanner with explicit states for fenced code, inline code, and heading tracking rather than a generic markdown AST stack.

### Interaction Protocols
- **Catalog build protocol**
  - Input: included `spec.md` paths.
  - Output: canonical catalog entries `{ identifier, file, line, heading? }`.
  - Failure: duplicate identifier aborts catalog construction with provenance for both definitions.
- **Trace declaration protocol**
  - Input: `traceSpec(...ids: string[])` from a currently running Vitest test.
  - Validation order: non-empty declaration, identifier format, identifier existence in catalog.
  - Effect: record unique identifiers for the current test and for run-scoped coverage accounting.
- **Coverage enforcement protocol**
  - Input: canonical identifier set and run-scoped observed identifier set.
  - Trigger: dedicated `test:trace` full-suite command only.
  - Failure: uncovered identifiers reported with provenance.

### Forward Evolution
- The scanner and catalog can later support code-level or documentation-only conventions without changing the v1 enforcement boundary.
- Similarity hints for unknown identifiers can be added later on top of the catalog without changing the external API.
- If Vitest runtime constraints make in-memory run aggregation unreliable, the design can evolve toward a run-scoped artifact without changing the product contract.

### Alternatives Considered
- **Full markdown parser dependency**: Rejected for v1 because the current specs are regular enough that a purpose-built scanner is smaller, easier to test, and more in line with repository norms.
- **Wrapped `itTrace(...)` or monkey-patched Vitest APIs**: Rejected because they hide the identifier declaration or force a broader test-authoring pattern change.
- **Coverage enforcement in every `npm test` run**: Rejected because it would make lightweight local runs more expensive and would punish partial authoring workflows.

## Component Design

### Key Components
- **Spec discovery module**
  - Expands included glob paths.
  - Excludes archived change specs.
  - Produces stable path ordering for deterministic diagnostics.
- **Spec scanner module**
  - Reads file contents linearly.
  - Tracks current heading context and code-formatting suppression state.
  - Emits zero or more candidate identifiers with provenance.
- **Catalog builder module**
  - Validates extracted identifiers.
  - Records first same-file occurrence and rejects cross-file duplicates.
- **Trace helper module**
  - Exposes `traceSpec(...ids)`.
  - Obtains the currently running test context from Vitest-supported runtime hooks.
  - Throws normal assertion-like failures for local declaration errors.
- **Coverage/reporting module**
  - Tracks observed identifiers for the run.
  - Compares observed identifiers to catalog identifiers in coverage mode.
  - Produces provenance-aware uncovered reports.

### Data Design
- **Identifier format**: bare uppercase kebab token matching `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`.
- **Catalog entry**:
  - `identifier`
  - `file`
  - `line`
  - `heading` optional, with bracket token removed when the identifier appears in the heading itself
- **Run state**:
  - `catalog`
  - `coverageEnabled`
  - `seenIdentifiers` as a set
- **Per-test declaration semantics**:
  - empty declaration is invalid
  - malformed identifiers are rejected before catalog lookup
  - repeated identifiers are collapsed to one unique set contribution for accounting

### Interface Contracts
- **`traceSpec(...ids: string[])`**
  - Callable only from within a currently executing Vitest test body.
  - Throws a test failure on empty declarations, malformed identifiers, and unknown identifiers.
  - Returns no value; success means the declaration has been accepted and recorded.
- **Vitest setup contract**
  - Initializes shared traceability state before tests execute.
  - Makes the catalog and run-scoped accounting available to the helper and end-of-run coverage finalizer.
- **Coverage command contract**
  - `npm run test:trace` enables coverage mode and runs the full suite.
  - Filtered or subset runs are supported for validation only, not as the intended coverage enforcement workflow.

### Code Map
- `test/support/spec-trace/scan.ts` or similar: spec discovery and scanning logic.
- `test/support/spec-trace/catalog.ts`: catalog building and duplicate detection.
- `test/support/spec-trace.ts`: explicit public helper imported by traced tests.
- `test/support/spec-trace.setup.ts`: Vitest setup initialization and end-of-run coverage hook.
- `vitest.config.ts`: setup registration.
- `package.json`: dedicated `test:trace` script and coverage-mode environment variable.
- `test/**`: new contract/integration tests for scanner behavior and runtime validation.

The public helper lives under `test/support/` because v1 enforcement is test-only. The scanner and catalog logic live under `test/support/spec-trace/`.

## Failure and Reliability

### Failure Mode Analysis
- **Unsafe inputs**: malformed `traceSpec(...)` identifiers, empty declarations, malformed-looking markdown tokens, and duplicate identifiers across spec files.
- **Fragile formats**: markdown code fences and inline code can contain identifier-like text that must not leak into the catalog.
- **Inadequate control actions**: if coverage mode is accidentally enabled for a subset run, uncovered failures will reflect missing suite coverage rather than local test validity.
- **Process model flaws**: runtime state may diverge from the actual current test context if Vitest hooks are misused or unsupported in some test shapes.
- **Coordination failures**: parallel workers or per-file isolation could make end-of-run aggregation incomplete if state is stored in the wrong place.

### Control and Recovery
- Fail fast during catalog construction for duplicate identifiers so runtime validation never proceeds against an ambiguous catalog.
- Validate `traceSpec(...)` arguments immediately so authors get local failures with clear cause separation.
- Keep coverage accounting de-duplicated and run-scoped to reduce cross-test interference.
- Gate coverage enforcement behind an explicit environment-controlled `test:trace` command so accidental local failures are easier to interpret.
- Add tests for ordinary, async, and parameterized Vitest usage to validate the runtime-context strategy before wide adoption.

## Operational Concerns

### Observability
- Diagnostics are the primary observability surface.
- Duplicate and uncovered failures should report identifier plus provenance.
- Malformed and unknown declaration failures should report test file, test title, and offending identifier.

### Deployment and Rollout
- Introduce the scanner and runtime validation first.
- Add the dedicated `test:trace` script after coverage aggregation is working.
- Backfill traced tests incrementally across existing specs.
- Enable the full-suite coverage command in CI only after sufficient traced coverage exists to avoid blocking the repository prematurely.

### Capacity and Scaling
- The spec corpus is small, so a per-run catalog build is acceptable for v1.
- If the spec set grows materially or worker duplication becomes costly, the design can evolve toward a cached shared artifact.

## Security

This change has low direct security impact because it does not introduce external network calls, credentials, or authorization boundaries. The main security-relevant concern is defensive parsing: the scanner should treat spec markdown as untrusted text, avoid code execution, and operate with conservative tokenization rules.

## Risks / Trade-offs

- [Vitest runtime context may be awkward to access for `traceSpec(...)`] -> Validate the approach with ordinary, async, and `it.each(...)` tests before relying on it broadly.
- [Purpose-built scanner may miss obscure markdown edge cases] -> Cover real repository patterns first and expand tests if edge cases appear.
- [Coverage mode could be run against subsets by mistake] -> Document and script `test:trace` explicitly as a full-suite command.
- [Incremental adoption may leave many uncovered identifiers at first] -> Delay CI enforcement until enough traced coverage exists.

## Migration Plan

1. Add scanner, catalog, and runtime helper modules.
2. Register Vitest setup and add the `test:trace` script.
3. Add tests for scanner behavior, local declaration validation, and coverage reporting.
4. Backfill traced tests for existing canonical identifiers incrementally.
5. Enable `npm run test:trace` in CI once the repository has sufficient traced coverage.

Rollback is straightforward: remove the setup wiring and helper usage, and the existing test suite returns to ordinary Vitest behavior.

## Verification Strategy

- Unit tests for spec discovery, code-span/code-fence exclusion, heading provenance, and duplicate detection.
- Runtime tests covering empty declarations, malformed identifiers, unknown identifiers, repeated identifiers, and successful declarations.
- Coverage-mode tests covering uncovered identifier reporting and empty-catalog behavior.
- Tests for ordinary, async, and parameterized Vitest cases to validate the helper-context strategy.
- A final full-suite `npm run test:trace` verification once enough traced tests exist.

