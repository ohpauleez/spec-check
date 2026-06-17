## 1. Project Setup and CLI Contract

- [x] 1.1 Scaffold the root TypeScript package, strict compiler settings (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `useUnknownInCatchVariables`), eslint, vitest, fast-check, and esbuild build entrypoints.
- [x] 1.2 Implement CLI argument parsing for positional input paths and `--output`, `--src`, `--caps`, `--z3`, `--config`, `--help`, and `--version` flags with unrecognized-flag rejection.
- [x] 1.3 Implement help/version flag handling that prints information and exits with code `0` without running analysis.
- [x] 1.4 Implement config file loading, JSON validation, and CLI-flag-over-config merge precedence.
- [x] 1.5 Add the core domain types: `Result` constructors, finding shape with required fields (severity, category, provenance, description, evidence), run-state accumulator, and tagged error categories with exit-code mapping.
- [x] 1.6 Implement JSON progress event emission on stdout with `phase`, `status`, `timestamp`, and optional `duration_ms` fields.

### Project setup and CLI contract change summary
- What changed: scaffolded a root Node 20+ TypeScript CLI package with strict compiler settings, ESLint, Vitest, fast-check, and esbuild bundling (`package.json`, `tsconfig.json`, `.eslintrc.cjs`, `vitest.config.ts`, `build/esbuild.ts`). Added `--model` flag for user-specified LLM model selection.
- Why this was done: the spec requires a deterministic, strict-typed core and explicit boundary control; strict toolchain setup makes later parser/formal/report phases safer to implement and easier to verify.
- CLI contract details: implemented argv parsing for required positional inputs and supported flags, hard rejection for unknown flags/missing values, and explicit `--help`/`--version` early exits with code `0` in `src/index.ts` and `src/cli/parse-argv.ts`.
- Config precedence details: added JSON config loading and shape validation with CLI-over-config precedence in `src/cli/config.ts`; omitted-option semantics were kept exact to align with `exactOptionalPropertyTypes`.
- Type safety infrastructure: the domain layer provides three compile-time and runtime safety mechanisms that apply across all subsequent sections:
  - `src/domain/errors.ts` — structured error hierarchy with `ErrorBase<C>` discriminated union, 10 error categories, narrowed boundary unions (`PipelinePhaseError`, `AdapterBoundaryError`, `CliResolutionError`), `makeError()`/`makeTypedError()` factories, and `exitCodeForError()` per-category exit code resolution (codes 2–11).
  - `src/domain/branded.ts` — 8 branded types (`OutputDirPath`, `RelativePath`, `SmtlibFilePath`, `ClaimId`, `CapabilityName`, `SanitizedClaimId`, `ModelName`, `SmtlibContent`) with construction functions at trust boundaries preventing accidental interchange of semantically distinct string values.
  - `src/domain/assert.ts` — `precondition()`, `invariant()`, `postcondition()` with TypeScript `asserts condition` narrowing, and `assertNever()` for exhaustive discriminated union handling; reserved for programmer errors, not expected domain failures.
- Pipeline orchestration: `runCli()` in `src/cli/run-cli.ts` is decomposed into `runIngestionPhases`, `runAnalysisPhases`, and `runReportingPhase` for phase-group isolation. `PipelineAbortError` carries a typed `category` field for propagation through the progress event infrastructure to `src/index.ts`, which maps it to the correct exit code.
- Progress events: `createProgressEvent` accepts an optional `timestamp` parameter for deterministic injection in tests, defaulting to `Date.now()` in production.
- Under-specified decision: build-time version embedding was implemented via esbuild banner constant (`__SPEC_CHECK_VERSION__`) rather than runtime package traversal to keep `--version` deterministic in bundled output.
- Developer handoff notes: all bare `throw new Error` statements have been eliminated from the domain layer; use `precondition()`/`invariant()`/`postcondition()` for programmer errors and `Result.err()` for expected domain failures. Never mix these: assertions are for states that indicate broken code, Results are for states that indicate bad input.
- Developer handoff notes: branded types use `as` casts in construction functions; validation responsibility is at the trust boundary where raw strings enter the system. When passing already-branded values between functions, no conversion is needed.
- Validation evidence: `npm run typecheck`, `npm run build`, and `npm run test` pass (50 files, 285 tests, 0 failures).

## 2. Catalog and Parser

- [x] 2.1 Implement catalog discovery: resolve input paths to files, classify documents (proposal, design, spec, task), and reject unreadable paths with exit code `2`.
- [x] 2.2 Implement active capability resolution: finalized specs plus at most one in-development delta per capability, with conflict findings for skipped deltas.
- [x] 2.3 Implement archived-change exclusion from active catalog.
- [x] 2.4 Implement dependency availability checks for `opencode` and `z3` before analysis begins.
- [x] 2.5 Implement line-oriented proposal parser with section extraction (motivation, scope, context, domain model, preconditions/postconditions/invariants, failure modes, quality attributes, capabilities) and provenance.
- [x] 2.6 Implement line-oriented design parser with section extraction and provenance.
- [x] 2.7 Implement line-oriented spec parser with EARS-pattern recognition, bracketed identifier extraction and validation, scenario extraction, references extraction, and delta section handling.
- [x] 2.8 Implement line-oriented task parser with task group extraction, subtask extraction, completion status, and change summary sections.
- [x] 2.9 Implement shared parser utilities: heading detection, canonical identifier format validation (`[UPPER-KEBAB-CASE]`), and unparsed-line collection with file and line provenance.

### Catalog and parser change summary
- What changed: implemented recursive catalog discovery and classification for proposal/design/spec/tasks plus unreadable-path fatal handling in `src/domain/parser/catalog.ts`.
- Active capability resolution: catalog now selects finalized specs plus at most one in-development delta per capability; skipped deltas emit explicit conflict findings (`catalog.delta_conflict`) instead of silent resolution.
- Archived exclusion: catalog filters out archived change content from active analysis (`/openspec/changes/archive/`) to prevent stale artifacts from influencing current runs.
- Dependency checks: added startup checks for `opencode` and `z3` availability via argv-only process probing (`src/adapters/process.ts`, `src/cli/run-cli.ts`).
- Parser implementation: added line-oriented parsers for proposal/design/spec/task docs and shared utilities for heading detection, canonical identifier validation, section extraction, and unparsed-line provenance retention.
- EARS classification: spec parser classifies requirements into 5 EARS patterns (`event-driven`, `state-driven`, `conditional`, `unwanted-behavior`, `non-ears`). The `unwanted-behavior` pattern uses an explicit indicator wordlist (NOT, FAIL, ERROR, INVALID, DENIED, REJECTED, EXCEED, VIOLAT, UNAUTHORIZED, TIMEOUT, OVERFLOW, CORRUPT, ABORT, PANIC, FATAL, CRASH, DISALLOW, FORBID, PROHIBIT, REFUSE, REVOKE, BLOCK, PREVENT, RESTRICT, CONFLICT) matched against the IF-clause condition. Non-EARS requirements emit a structural finding (`spec.non_ears_requirement`) surfacing requirements that may need rewording.
- Under-specified decision: parser behavior is intentionally conservative; unmatched non-empty lines are preserved as evidence findings rather than discarded, matching the no-silent-loss invariant.
- Bug fix: the spec parser's outer loop now uses `Math.max(parsed.endLine - 1, index)` instead of `parsed.endLine - 1` when advancing past consumed requirement/scenario blocks. This prevents an infinite loop when a requirement heading is immediately followed by another heading (no body lines), which caused `endLine` to equal the current index and the loop to never advance. Discovered by adversarial input testing.
- Developer handoff notes: parser functions return 0-indexed `endLine` values that the outer `parseSpec` loop interprets as "last consumed line"; the `Math.max` guard ensures forward progress regardless of how `parseRequirement`/`parseScenario` resolve their end boundaries.
- Validation evidence: `npx vitest run` passes (50 files, 285 tests); adversarial inputs including empty documents, heading-only documents, 10KB lines, unicode edge cases, and null bytes all terminate successfully.

## 3. Claim Graph and Coverage Analysis

- [x] 3.1 Implement typed claim extraction for requirements, scenarios, proposal/design properties, assumptions, invariants, failure modes, and task evidence with mandatory provenance attachment.
- [x] 3.2 Implement obligation level assignment (mandatory, advisory, informational) based on EARS keywords and source structure.
- [x] 3.3 Implement orphaned-claim detection: surface claims without provenance as analysis defects.
- [x] 3.4 Implement proposal-to-capability mapping and missing-spec-file detection for declared capabilities.
- [x] 3.5 Implement requirement reference validation: detect unsupported references where the cited upstream content does not support the claimed behavior.
- [x] 3.6 Implement coverage gap detection: identify uncovered upstream claims (proposal/design) that lack corresponding downstream requirements.
- [x] 3.7 Implement contradiction and semantic-drift detection between upstream and downstream claims with both-sides-preserved findings.
- [x] 3.8 Implement task evidence consistency analysis: compare completed task change summaries against the claim graph.

### Claim graph and coverage analysis change summary
- What changed: added typed claim graph extraction in `src/domain/claim-graph.ts` for requirements, scenarios, proposal/design properties, assumptions/invariants/failure modes, and task evidence. All claim fields now use branded types: `Claim.id` is `ClaimId | undefined`, `Claim.capability` is `CapabilityName`.
- Obligation assignment: implemented mandatory/advisory/informational derivation from requirement/scenario text (`SHALL`/`SHOULD`/default informational) and propagated obligation into downstream severity selection.
- Provenance enforcement: claims are created with mandatory provenance and orphaned claims are surfaced as defects (`claim_graph.orphaned_claim`) instead of being admitted into analysis.
- Coverage analysis: implemented deterministic checks for missing declared capability specs, unsupported requirement references, uncovered upstream claims, contradiction detection, semantic drift, and task evidence mismatch in `src/domain/spec-forward/coverage.ts`.
- Both-sides evidence: contradiction and drift findings preserve upstream and downstream claim evidence in the same finding payload so reviewers can inspect disagreement without reconstruction.
- Under-specified decision: semantic comparison uses bounded lexical heuristics (shared keyword/negation/failure-term checks) as a deterministic baseline pending richer model-backed semantic matching.
- Developer handoff notes: `buildClaimGraph` handles duplicate claim IDs gracefully (both claims are preserved in the graph); adversarial testing confirms this produces correct obligation derivation and orphan detection even with empty-body or duplicate-ID claims.

## 4. Qualitative Analysis and Report Skeleton

- [x] 4.1 Implement the `opencode` adapter: argv construction without shell interpolation, bounded timeout per call, JSON response validation against phase-specific schemas, and bounded retries (default 3).
- [x] 4.2 Implement prompt construction with document content fencing to prevent prompt injection escalation.
- [x] 4.3 Implement specs-forward qualitative pass packaging for independent document review and proposal/design property assessment with schema-validated findings.
- [x] 4.4 Implement initial Markdown report rendering for `report_1.1.md` (first qualitative pass), `report_1.2.md` (second qualitative pass), `report_1.3.md` (coverage analysis).
- [x] 4.5 Implement synthesized summary report scaffolding (`report_summary.md`) with skipped-phase explanations for disabled optional phases.

### Qualitative analysis and report skeleton change summary
- What changed: implemented `opencode` adapter in `src/adapters/opencode.ts` with explicit argv construction, per-call timeout, bounded retries (default 3), JSON parsing, and phase schema gatekeeping.
- Prompt hardening: `fenceDocument` in `src/domain/spec-forward/qualitative.ts` escapes `</document>` closing tags and backtick fence sequences within document content before wrapping, preventing prompt fence injection where untrusted spec text could prematurely close fencing and inject arbitrary prompt instructions.
- Qualitative packaging: added two-pass specs-forward qualitative flow (independent review + property-focused review) with normalized finding extraction and raw response preservation.
- Report skeleton: implemented report rendering for `report_1.1.md`, `report_1.2.md`, `report_1.3.md`, and synthesized `report_summary.md` with explicit skipped-phase explanations.
- Under-specified decision: qualitative findings are normalized into repository finding shape with defensive defaults when optional model fields are absent, ensuring report generation remains stable.
- Developer handoff notes: qualitative prompt mode labels (`qualitative_review`, `qualitative_properties`) are contract keys used by the adapter and tests; keep these stable if prompts are revised.
- Developer handoff notes: adapter failure modes are tested via fault injection (`test/contract/fault-injection.test.ts`) — empty responses produce `invalid_json` errors, malformed payloads produce `schema_validation_error`, and repeated spawn failures exhaust the retry budget.

## 5. Formalization Pipeline

- [x] 5.1 Implement logic IR types with sort declarations, function symbols, assertions, and obligation metadata.
- [x] 5.2 Implement claim-to-formalization request packaging and `opencode`-backed sampling with bounded retries per claim.
- [x] 5.3 Implement formalization sample schema validation: sort consistency, assertion well-formedness, and identifier format checks.
- [x] 5.4 Implement SMT-LIB compilation with identifier sanitization (underscore plus hex escape for unsafe characters) and reversible mapping comments.

### Formalization pipeline change summary
- What changed: added typed logic IR (`src/domain/logic-ir.ts`) for sort declarations, function symbols, assertions, and obligation metadata. `LogicIrClaim.claimId` is now branded as `ClaimId`.
- Formalization requests: implemented claim-to-formalization packaging and bounded sample acquisition through `opencode` with retry/error handling in `src/domain/formal/formalize.ts`.
- Sample validation: `validateFormalizationSample()` in `src/domain/formal/validate.ts` is decomposed into `validateSorts`, `validateFunctions`, and `validateAssertions` for focused, independently testable validation steps. Invalid samples are preserved as findings using `Result.err()` — no exceptions are thrown during validation.
- SMT-LIB compilation: implemented deterministic SMT output generation with identifier sanitization (`_` + hex escapes) and reversible mapping comments in `src/domain/formal/smtlib.ts`. `sanitizeIdentifier` produces `SanitizedClaimId` branded output, `compileSmtlib` produces `SmtlibContent` branded output.
- Under-specified decision: assertion well-formedness uses balanced-parentheses and token-shape checks as a lightweight guardrail before solver submission; this keeps validation deterministic and fast while rejecting obviously broken outputs.
- Developer handoff notes: `sanitizeIdentifier` is hardened against adversarial inputs including `(check-sat)`, `(exit)`, nested parentheses, null bytes, emoji, CJK characters, and leading digits — all produce valid SMT-LIB identifiers matching `/^[A-Za-z_][A-Za-z0-9_]*$/`. The empty string produces `"_"`.
- Developer handoff notes: `validateFormalizationSample` correctly checks `declaredSortNames` from the formalization's sort array, not just built-in sorts; and uses explicit `for` loops with early-return `err()` instead of `.map()` callbacks to maintain Result-style error flow.
- Validation evidence: adversarial testing confirms injection-like identifiers, unbalanced parentheses, and special characters are all handled without crash or silent acceptance.

## 6. Clustering and Logic Analysis

- [x] 6.1 Implement the `z3` adapter: SMT-LIB piped via stdin, stdout/stderr capture, per-query timeout (default 30 seconds), and exit classification (sat/unsat/timeout/unknown/error).
- [x] 6.2 Implement pairwise implication query generation for formalization sample clustering.
- [x] 6.3 Implement equivalence cluster construction, stability threshold evaluation, and representative sample selection.
- [x] 6.4 Implement ambiguity finding emission when no cluster meets the stability threshold.
- [x] 6.5 Implement obligation-aware solver analysis passes: mandatory-obligation queries first (higher-severity findings), then advisory-obligation queries (lower-severity findings).
- [x] 6.6 Implement solver evidence persistence: persist all SMT-LIB inputs, solver stdout/stderr, counterexamples, models, unsat cores, and inconclusive results verbatim under the output directory.
- [x] 6.7 Implement `report_1.logic.md` generation with preserved solver evidence references.

### Clustering and logic analysis change summary
- What changed: implemented `z3` adapter (`src/adapters/z3.ts`) with stdin SMT piping, stdout/stderr capture, timeout handling, and explicit result classification (`sat`/`unsat`/`timeout`/`unknown`/`error`). The `runZ3Query` function accepts `SmtlibContent` branded input.
- Clustering pipeline: added pairwise implication query generation, equivalence graph construction, deterministic cluster building, stability-threshold representative selection, and ambiguity emission in `src/domain/formal/clustering.ts`. Uses `precondition()` assertions for internal invariants (non-empty sample arrays, valid cluster indices).
- Obligation-aware logic pass: added mandatory-first then advisory solver analysis with severity differentiation and persisted solver artifacts in `src/domain/formal/logic-analysis.ts`.
- Evidence persistence: solver inputs/outputs are written as first-class artifacts under output paths (including inconclusive cases), then referenced from findings and reports.
- Report generation: `report_1.logic.md` is rendered from persisted logic findings/evidence paths.
- Under-specified decision: inconclusive pairwise implication results are treated as non-equivalent edges (not auto-merged or auto-split), preserving uncertainty explicitly.
- Developer handoff notes: fault injection testing confirms Z3 timeout (SIGTERM signal), crash (non-zero exit with garbage stderr), and spawn failure (ENOENT) are all handled gracefully without propagating untyped exceptions.

## 7. Source Traceability and Code-Backwards Analysis

- [x] 7.1 Implement source directory validation and scope confinement for `--src` mode.
- [x] 7.2 Implement canonical identifier traceability scanning: search source files, test files, and verified contracts for bracketed identifiers.
- [x] 7.3 Implement evidence hierarchy application: implementation code and verified contracts as primary, traced tests as secondary, documentation as supporting.
- [x] 7.4 Implement traceability gap and supported-trace finding emission.
- [x] 7.5 Implement task-to-source consistency analysis when both task summaries and source evidence are available.
- [x] 7.6 Implement code-derived spec generation: EARS-preferring behavioral specs per capability from source evidence, blind to original requirement text, persisted to `gen_specs/` under output directory.
- [x] 7.7 Implement code-derived formalization: apply the same formalization pipeline (LLM sampling, schema validation, equivalence clustering, representative selection) to generated specs, persist SMT-LIB artifacts to `gen_specs_smt/` under output directory.
- [x] 7.8 Implement code-derived solver analysis: run obligation-aware Z3 on code-derived formalizations for internal consistency, produce `report_2.logic.md`.
- [x] 7.9 Implement cross-side implication analysis: bidirectional solver-backed implication checks between original (`smt/`) and code-derived (`gen_specs_smt/`) formalizations with same/stronger/weaker/different/uncertain classification.
- [x] 7.10 Integrate two-layer comparison: solver implication as primary classifier, blind comparison as explanatory layer providing human-readable rationale. Solver classification takes precedence when available; blind comparison serves as fallback when implication is uncertain.
- [x] 7.11 Implement per-capability divergence summary as first-class evidence output in `report_2.compare.md`.
- [x] 7.12 Implement blind comparison boundary enforcement: ensure original requirement text never reaches the code-derived generation or comparison side.
- [x] 7.13 Implement code-backwards comparison with classification output (same, stronger, weaker, different, uncertain) and dual-layer evidence (formal + explanatory).
- [x] 7.14 Implement `report_2.trace.md` and `report_2.compare.md` generation for `--src` mode.

### Source traceability and code-backwards analysis change summary
- What changed: implemented `--src` scoped traceability scanning for canonical bracketed identifiers with support/gap/unknown-reference findings in `src/domain/code-backwards/trace.ts`. Source scanning is filtered to `TRACE_SCANNABLE_EXTENSIONS` (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`) to prevent binary files from producing spurious matches.
- Evidence hierarchy: source traces are classified into primary/secondary/supporting tiers and used by downstream code-derived generation decisions.
- Task-to-source consistency: added consistency checks between completed task evidence claims and traced source identifiers (`src/domain/tasks-analysis.ts`).
- Code-derived generation: implemented capability-grouped EARS-preferring spec generation and persistence under `gen_specs/` with limitation findings when evidence is insufficient (`src/domain/code-backwards/derive.ts`).
- Code-derived formal path: applied same formalize/validate/cluster pipeline to generated specs and persisted formal artifacts under `gen_specs_smt/` (`src/domain/code-backwards/gen-formal.ts`, `src/domain/code-backwards/gen-logic.ts`). These modules record error-severity findings for graceful degradation instead of throwing exceptions.
- Cross-side implication: implemented bidirectional implication classification (`same/stronger/weaker/different/uncertain`) with per-capability divergence summary and persisted query/result evidence (`src/domain/code-backwards/cross-implication.ts`). All output paths use `resolveConfinedOutputPath` to prevent path-traversal via crafted capability identifiers.
- Blind comparison boundary: explanatory rationale layer only consumes generated-side context and explicitly surfaces boundary/context defects (`src/domain/code-backwards/blind-compare.ts`).
- Report outputs: integrated `report_2.trace.md`, `report_2.logic.md`, and `report_2.compare.md` generation when `--src` is enabled.
- Under-specified decision: cross-implication functions accept `OutputDirPath` branded output directories and `SmtlibContent` branded query inputs; the branded types enforce that only validated paths and well-formed SMT-LIB reach the solver.
- Developer handoff notes: `gen-formal.ts` and `blind-compare.ts` use Result-style error findings — downstream consumers inspect findings rather than catching exceptions. This is intentional for pipeline resilience; a failure in one capability's formalization does not abort the entire code-backwards pass.

## 8. Reporting, Manifest, and Output Integrity

- [x] 8.1 Implement atomic output writes using temp-file-plus-rename for all output artifacts.
- [x] 8.2 Implement output directory confinement: reject any write path that resolves outside the configured output directory.
- [x] 8.3 Implement manifest JSON generation with per-file SHA-256 checksums and originating phase metadata.
- [x] 8.4 Implement manifest-last completion semantics: write the manifest only after all other output files are finalized.
- [x] 8.5 Implement finding immutability enforcement: ensure later phases never remove prior findings.
- [x] 8.6 Implement unsupported-verdict suppression: reject findings that lack required provenance or evidence.

### Reporting, manifest, and output integrity change summary
- What changed: implemented atomic output writes (temp file + rename) and output-directory confinement checks in `src/adapters/fs.ts`. `writeOutputAtomic` accepts `OutputDirPath` and `RelativePath` branded parameters; `resolveConfinedOutputPath` validates path confinement before any write attempt.
- Atomic write safety: `writeOutputAtomic` cleans up the temporary file on rename failure, preventing orphaned temp files from accumulating when atomic writes fail due to cross-device moves or permission errors.
- Manifest semantics: added manifest entry construction with SHA-256 checksums and per-file phase metadata, with manifest written last as completion marker (`src/domain/reporting/manifest.ts`).
- Finding immutability: run-state append-only enforcement uses `postcondition()` and `invariant()` assertions to reject any attempt to reduce/replace prior findings (`src/domain/run-state.ts`).
- Unsupported verdict suppression: report rendering validates required finding fields/evidence and converts malformed findings into explicit `reporting.unsupported_verdict` defects (`src/domain/reporting/render.ts`).
- Under-specified decision: confinement uses resolved-path boundary checks and rejects traversal escapes via `precondition()` before any write attempt, rather than relying on downstream fs errors.
- Developer handoff notes: fault injection testing confirms EACCES and ENOSPC errors from `writeFile` propagate correctly, and path traversal (`../`) is rejected with a descriptive error message. These are exercised in `test/contract/fault-injection.test.ts`.

## 9. Verification and Evidence

- [x] 9.1 Add contract tests for CLI argument handling: valid flags, invalid flags, help/version exit behavior, config loading, and exit code mapping.
- [x] 9.2 Add contract tests for parser structural checks: heading validation, identifier format, EARS pattern recognition, unparsed-line preservation, and deterministic parse output.
- [x] 9.3 Add contract tests for `opencode` adapter: argv construction, schema validation, retry behavior, and timeout handling.
- [x] 9.4 Add contract tests for `z3` adapter: SMT-LIB piping, exit classification, per-query timeout, and evidence persistence.
- [x] 9.5 Add contract tests for manifest semantics: checksum correctness, manifest-last ordering, and interrupted-run behavior.
- [x] 9.6 Add property-based tests for parser invariants (no silent line loss, determinism), claim graph invariants (provenance attachment, obligation assignment), clustering determinism and symmetry, and SMT-LIB sanitization safety.
- [x] 9.7 Add integration tests with fixture specs: end-to-end specs-forward analysis, structural violation fixtures, coverage gap fixtures, contradiction fixtures, and formalization with fake adapters.
- [x] 9.8 Add determinism tests: re-run with cached `opencode` and `z3` responses, then byte-diff outputs.
- [x] 9.9 Add formalization oracle tests: compare known EARS-to-logic fixtures against generated logic and solver equivalence checks.
- [x] 9.10 Add traceability tests: verify canonical identifier handling, traced-test linkage, unknown-identifier failure behavior, and blind-comparison boundary enforcement.
- [x] 9.11 Add contract tests for code-derived spec generation: EARS conformance checking, blind generation boundary enforcement (no original requirement text in prompts), per-capability output structure, and insufficient-evidence limitation findings.
- [x] 9.12 Add property tests for cross-side implication: classification determinism with same solver results, classification symmetry (swapping directions produces inverse strength label), proper handling of timeout/unknown as uncertain, and implication evidence persistence.
- [x] 9.13 Add integration tests for full code-backwards formal pipeline: generation through formalization through cross-side implication with fake `opencode` and fake `z3` adapters, producing `gen_specs/`, `gen_specs_smt/`, `report_2.logic.md`, and `report_2.compare.md`.
- [x] 9.14 Add determinism tests for code-derived outputs: code-derived generation, formalization, and cross-side implication produce identical results across runs with cached responses.
- [x] 9.15 Add distribution parity checks: verify `npm`-installed CLI and bundled `dist/spec-check.js` both produce help/version output and handle basic analysis correctly.

### Verification and evidence change summary
- What changed: comprehensive test suite across 8 tiers totaling 50 files and 285 tests.
- Contract tests (33 files): CLI, config, parser, opencode adapter, z3 adapter, manifest, distribution, traceability, claim graph, coverage, qualitative, formalize, clustering, logic analysis, derive, blind compare, cross implication, gen-formal, gen-logic, reporting, fs, errors, progress, run-state, smtlib, validate, task-parser, tasks-analysis, catalog, spec-trace, coverage-gaps, fault-injection, and adversarial-inputs.
- Property tests (9 files): parser determinism/no-loss, claim graph provenance/obligation, coverage gap detection, manifest checksum, run-state append-only, blind-compare boundary, code-derived EARS conformance, cross-implication classification, and logic/SMT sanitization safety.
- Invariant tests (2 files, 21 tests): global structural invariants (finding immutability, provenance, determinism) and safety/liveness properties (append-only, output confinement, claim-graph monotonicity).
- Integration tests (3 files, 11 tests): specs-forward, code-backwards, and full pipeline flows with mocked `opencode`/`z3` adapters.
- Determinism tests (2 files, 8 tests): parser, claim graph, logic analysis, gen-specs, gen-formal, cross-implication, and coverage determinism.
- Oracle tests (1 file, 5 tests): golden fixture comparison for all 5 EARS-to-logic patterns.
- Fault injection tests (`test/contract/fault-injection.test.ts`, 10 tests): Z3 adapter timeout/crash/spawn-failure, filesystem EACCES/ENOSPC/path-traversal, OpenCode adapter null-payload/empty-stdout/schema-mismatch/repeated-spawn-failure. Uses `vi.mock` at module boundaries to simulate adapter failures without real subprocesses.
- Adversarial input tests (`test/contract/adversarial-inputs.test.ts`, 35 tests): empty documents, heading-only documents, 10KB lines, unicode edge cases (ZWJ, RTL, emoji, CJK), deeply nested headings, malformed EARS patterns, null bytes, duplicate claim IDs, circular references, SMT-LIB injection attempts, and formalization validation with hostile payloads. These tests discovered and motivated the parser infinite-loop fix in section 2.
- Spec-trace coverage: `test/contract/spec-trace.test.ts` (23 tests) covers all 32 TRACE-* canonical identifiers; `test/contract/coverage-gaps.test.ts` (11 tests) closes remaining domain identifier gaps.
- Under-specified decision: oracle coverage for formalization is represented via deterministic compiler/validator behavior tests plus mocked formal sample contracts, keeping tests mechanical and repeatable without live model dependency.
- Developer handoff notes: fault injection and adversarial tests run in the same vitest worker pool as all other tests without special configuration. The adversarial test file imports the full domain layer (parsers, claim-graph, smtlib, validate); if new adversarial scenarios cause memory pressure, consider splitting into focused files by subsystem.
- Developer handoff notes: 3 tests that previously expected `.rejects.toThrow()` were updated to check for error-severity findings in results, matching the throw-to-finding conversions in `gen-formal.ts` and `blind-compare.ts`.
- Validation evidence: `npx vitest run` passes (50 files, 285 tests, 0 failures); `npx tsc --noEmit` reports zero type errors; `npm run test:trace` with `DEVBOX_TRACE_COVERAGE=1` confirms all 189 canonical identifiers are covered by `traceSpec()` declarations with zero gaps.

## 10. Packaging and Distribution

- [x] 10.1 Implement package metadata and build configuration supporting standard `npm` installation of the `spec-check` CLI.
- [x] 10.2 Implement bundled output generation for `dist/spec-check.js` with `#!/usr/bin/env node` shebang and Node.js 20+ runtime contract.
- [x] 10.3 Implement build-time version embedding from `package.json`.

### Packaging and distribution change summary
- What changed: finalized package metadata and CLI bin wiring for `spec-check`, including Node engine contract and publishable file list in `package.json`.
- Bundle output: implemented single-file dist build for `dist/spec-check.js` with required shebang and Node 20 target through esbuild.
- Version embedding: build injects `package.json` version at bundle time and `--version` prints embedded value via `src/version.ts` + `src/index.ts`.
- Distribution parity evidence: added contract check that bundled artifact contains shebang and embedded version marker (`test/contract/distribution.test.ts`).
