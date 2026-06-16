## 1. Project Setup and CLI Contract

- [ ] 1.1 Scaffold the root TypeScript package, strict compiler settings (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `useUnknownInCatchVariables`), eslint, vitest, fast-check, and esbuild build entrypoints.
- [ ] 1.2 Implement CLI argument parsing for positional input paths and `--output`, `--src`, `--caps`, `--z3`, `--config`, `--help`, and `--version` flags with unrecognized-flag rejection.
- [ ] 1.3 Implement help/version flag handling that prints information and exits with code `0` without running analysis.
- [ ] 1.4 Implement config file loading, JSON validation, and CLI-flag-over-config merge precedence.
- [ ] 1.5 Add the core domain types: `Result` constructors, finding shape with required fields (severity, category, provenance, description, evidence), run-state accumulator, and tagged error categories with exit-code mapping.
- [ ] 1.6 Implement JSON progress event emission on stdout with `phase`, `status`, `timestamp`, and optional `duration_ms` fields.

### Project setup and CLI contract change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision-->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 2. Catalog and Parser

- [ ] 2.1 Implement catalog discovery: resolve input paths to files, classify documents (proposal, design, spec, task), and reject unreadable paths with exit code `2`.
- [ ] 2.2 Implement active capability resolution: finalized specs plus at most one in-development delta per capability, with conflict findings for skipped deltas.
- [ ] 2.3 Implement archived-change exclusion from active catalog.
- [ ] 2.4 Implement dependency availability checks for `opencode` and `z3` before analysis begins.
- [ ] 2.5 Implement line-oriented proposal parser with section extraction (motivation, scope, context, domain model, preconditions/postconditions/invariants, failure modes, quality attributes, capabilities) and provenance.
- [ ] 2.6 Implement line-oriented design parser with section extraction and provenance.
- [ ] 2.7 Implement line-oriented spec parser with EARS-pattern recognition, bracketed identifier extraction and validation, scenario extraction, references extraction, and delta section handling.
- [ ] 2.8 Implement line-oriented task parser with task group extraction, subtask extraction, completion status, and change summary sections.
- [ ] 2.9 Implement shared parser utilities: heading detection, canonical identifier format validation (`[UPPER-KEBAB-CASE]`), and unparsed-line collection with file and line provenance.

### Catalog and parser change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision-->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 3. Claim Graph and Coverage Analysis

- [ ] 3.1 Implement typed claim extraction for requirements, scenarios, proposal/design properties, assumptions, invariants, failure modes, and task evidence with mandatory provenance attachment.
- [ ] 3.2 Implement obligation level assignment (mandatory, advisory, informational) based on EARS keywords and source structure.
- [ ] 3.3 Implement orphaned-claim detection: surface claims without provenance as analysis defects.
- [ ] 3.4 Implement proposal-to-capability mapping and missing-spec-file detection for declared capabilities.
- [ ] 3.5 Implement requirement reference validation: detect unsupported references where the cited upstream content does not support the claimed behavior.
- [ ] 3.6 Implement coverage gap detection: identify uncovered upstream claims (proposal/design) that lack corresponding downstream requirements.
- [ ] 3.7 Implement contradiction and semantic-drift detection between upstream and downstream claims with both-sides-preserved findings.
- [ ] 3.8 Implement task evidence consistency analysis: compare completed task change summaries against the claim graph.

### Claim graph and coverage analysis change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision-->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 4. Qualitative Analysis and Report Skeleton

- [ ] 4.1 Implement the `opencode` adapter: argv construction without shell interpolation, bounded timeout per call, JSON response validation against phase-specific schemas, and bounded retries (default 3).
- [ ] 4.2 Implement prompt construction with document content fencing to prevent prompt injection escalation.
- [ ] 4.3 Implement specs-forward qualitative pass packaging for independent document review and proposal/design property assessment with schema-validated findings.
- [ ] 4.4 Implement initial Markdown report rendering for `report_1.1.md` (first qualitative pass), `report_1.2.md` (second qualitative pass), `report_1.3.md` (coverage analysis).
- [ ] 4.5 Implement synthesized summary report scaffolding (`report_summary.md`) with skipped-phase explanations for disabled optional phases.

### Qualitative analysis and report skeleton change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision-->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 5. Formalization Pipeline

- [ ] 5.1 Implement logic IR types with sort declarations, function symbols, assertions, and obligation metadata.
- [ ] 5.2 Implement claim-to-formalization request packaging and `opencode`-backed sampling with bounded retries per claim.
- [ ] 5.3 Implement formalization sample schema validation: sort consistency, assertion well-formedness, and identifier format checks.
- [ ] 5.4 Implement SMT-LIB compilation with identifier sanitization (underscore plus hex escape for unsafe characters) and reversible mapping comments.

### Formalization pipeline change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision-->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 6. Clustering and Logic Analysis

- [ ] 6.1 Implement the `z3` adapter: SMT-LIB piped via stdin, stdout/stderr capture, per-query timeout (default 30 seconds), and exit classification (sat/unsat/timeout/unknown/error).
- [ ] 6.2 Implement pairwise implication query generation for formalization sample clustering.
- [ ] 6.3 Implement equivalence cluster construction, stability threshold evaluation, and representative sample selection.
- [ ] 6.4 Implement ambiguity finding emission when no cluster meets the stability threshold.
- [ ] 6.5 Implement obligation-aware solver analysis passes: mandatory-obligation queries first (higher-severity findings), then advisory-obligation queries (lower-severity findings).
- [ ] 6.6 Implement solver evidence persistence: persist all SMT-LIB inputs, solver stdout/stderr, counterexamples, models, unsat cores, and inconclusive results verbatim under the output directory.
- [ ] 6.7 Implement `report_1.logic.md` generation with preserved solver evidence references.

### Clustering and logic analysis change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision-->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 7. Source Traceability and Code-Backwards Analysis

- [ ] 7.1 Implement source directory validation and scope confinement for `--src` mode.
- [ ] 7.2 Implement canonical identifier traceability scanning: search source files, test files, and verified contracts for bracketed identifiers.
- [ ] 7.3 Implement evidence hierarchy application: implementation code and verified contracts as primary, traced tests as secondary, documentation as supporting.
- [ ] 7.4 Implement traceability gap and supported-trace finding emission.
- [ ] 7.5 Implement task-to-source consistency analysis when both task summaries and source evidence are available.
- [ ] 7.6 Implement code-derived spec generation: EARS-preferring behavioral specs per capability from source evidence, blind to original requirement text, persisted to `gen_specs/` under output directory.
- [ ] 7.7 Implement code-derived formalization: apply the same formalization pipeline (LLM sampling, schema validation, equivalence clustering, representative selection) to generated specs, persist SMT-LIB artifacts to `gen_specs_smt/` under output directory.
- [ ] 7.8 Implement code-derived solver analysis: run obligation-aware Z3 on code-derived formalizations for internal consistency, produce `report_2.logic.md`.
- [ ] 7.9 Implement cross-side implication analysis: bidirectional solver-backed implication checks between original (`smt/`) and code-derived (`gen_specs_smt/`) formalizations with same/stronger/weaker/different/uncertain classification.
- [ ] 7.10 Integrate two-layer comparison: solver implication as primary classifier, blind comparison as explanatory layer providing human-readable rationale. Solver classification takes precedence when available; blind comparison serves as fallback when implication is uncertain.
- [ ] 7.11 Implement per-capability divergence summary as first-class evidence output in `report_2.compare.md`.
- [ ] 7.12 Implement blind comparison boundary enforcement: ensure original requirement text never reaches the code-derived generation or comparison side.
- [ ] 7.13 Implement code-backwards comparison with classification output (same, stronger, weaker, different, uncertain) and dual-layer evidence (formal + explanatory).
- [ ] 7.14 Implement `report_2.trace.md` and `report_2.compare.md` generation for `--src` mode.

### Source traceability and code-backwards analysis change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision-->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 8. Reporting, Manifest, and Output Integrity

- [ ] 8.1 Implement atomic output writes using temp-file-plus-rename for all output artifacts.
- [ ] 8.2 Implement output directory confinement: reject any write path that resolves outside the configured output directory.
- [ ] 8.3 Implement manifest JSON generation with per-file SHA-256 checksums and originating phase metadata.
- [ ] 8.4 Implement manifest-last completion semantics: write the manifest only after all other output files are finalized.
- [ ] 8.5 Implement finding immutability enforcement: ensure later phases never remove prior findings.
- [ ] 8.6 Implement unsupported-verdict suppression: reject findings that lack required provenance or evidence.

### Reporting, manifest, and output integrity change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision-->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 9. Verification and Evidence

- [ ] 9.1 Add contract tests for CLI argument handling: valid flags, invalid flags, help/version exit behavior, config loading, and exit code mapping.
- [ ] 9.2 Add contract tests for parser structural checks: heading validation, identifier format, EARS pattern recognition, unparsed-line preservation, and deterministic parse output.
- [ ] 9.3 Add contract tests for `opencode` adapter: argv construction, schema validation, retry behavior, and timeout handling.
- [ ] 9.4 Add contract tests for `z3` adapter: SMT-LIB piping, exit classification, per-query timeout, and evidence persistence.
- [ ] 9.5 Add contract tests for manifest semantics: checksum correctness, manifest-last ordering, and interrupted-run behavior.
- [ ] 9.6 Add property-based tests for parser invariants (no silent line loss, determinism), claim graph invariants (provenance attachment, obligation assignment), clustering determinism and symmetry, and SMT-LIB sanitization safety.
- [ ] 9.7 Add integration tests with fixture specs: end-to-end specs-forward analysis, structural violation fixtures, coverage gap fixtures, contradiction fixtures, and formalization with fake adapters.
- [ ] 9.8 Add determinism tests: re-run with cached `opencode` and `z3` responses, then byte-diff outputs.
- [ ] 9.9 Add formalization oracle tests: compare known EARS-to-logic fixtures against generated logic and solver equivalence checks.
- [ ] 9.10 Add traceability tests: verify canonical identifier handling, traced-test linkage, unknown-identifier failure behavior, and blind-comparison boundary enforcement.
- [ ] 9.11 Add contract tests for code-derived spec generation: EARS conformance checking, blind generation boundary enforcement (no original requirement text in prompts), per-capability output structure, and insufficient-evidence limitation findings.
- [ ] 9.12 Add property tests for cross-side implication: classification determinism with same solver results, classification symmetry (swapping directions produces inverse strength label), proper handling of timeout/unknown as uncertain, and implication evidence persistence.
- [ ] 9.13 Add integration tests for full code-backwards formal pipeline: generation through formalization through cross-side implication with fake `opencode` and fake `z3` adapters, producing `gen_specs/`, `gen_specs_smt/`, `report_2.logic.md`, and `report_2.compare.md`.
- [ ] 9.14 Add determinism tests for code-derived outputs: code-derived generation, formalization, and cross-side implication produce identical results across runs with cached responses.
- [ ] 9.15 Add distribution parity checks: verify `npm`-installed CLI and bundled `dist/spec-check.js` both produce help/version output and handle basic analysis correctly.

### Verification and evidence change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision-->
<!-- Important information to pass on to other developers about the implementation of this task -->

## 10. Packaging and Distribution

- [ ] 10.1 Implement package metadata and build configuration supporting standard `npm` installation of the `spec-check` CLI.
- [ ] 10.2 Implement bundled output generation for `dist/spec-check.js` with `#!/usr/bin/env node` shebang and Node.js 20+ runtime contract.
- [ ] 10.3 Implement build-time version embedding from `package.json`.

### Packaging and distribution change summary
<!-- Full audit trail about what changed, **why** it was changed, and evidence that the tasks were successfully completed -->
<!-- Details about decisions made that weren't in the spec or under-specified in the spec, and a rationale for the decision-->
<!-- Important information to pass on to other developers about the implementation of this task -->
