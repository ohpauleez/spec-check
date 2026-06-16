## Motivation

`spec-check` supports evidence-based dependability cases through the full software development lifecycle for projects that use OpenSpec specifications. The immediate need is to catch defects, ambiguity, contradictions, and missing assumptions in specifications before implementation begins, especially when developers are working with agents that can produce plausible code faster than they can produce trustworthy evidence.

This change introduces the initial core specification for a local command-line tool that helps developers judge whether their proposal, design, and capability specs are complete, internally coherent, formally checkable, and aligned with the implementation. The tool also supports backwards analysis from source so that developers can detect whether the implementation actually preserves the intent of the specifications.

## Scope

### In Scope

- Define the initial v1 behavior of a local TypeScript CLI that analyzes OpenSpec artifacts that use the `srs-driven` schema.
- Define a specs-forward pipeline that evaluates `proposal.md`, `design.md`, active capability `spec.md` files, and optional `tasks.md` for ambiguity, contradiction, incompleteness, and traceability gaps.
- Define a formalization pipeline that translates requirement and scenario claims into a typed logic intermediate representation and SMT-LIB artifacts for solver-backed analysis.
- Define optional source-backed behavior for traceability analysis, EARS-preferring code-derived specification generation, formalization of code-derived specifications through the same sampling and clustering pipeline, solver-backed cross-side implication analysis as the primary strength classifier, and blind LLM comparison as the explanatory layer when `--src` is provided.
- Define output artifacts, evidence preservation rules, progress signaling, failure behavior, manifest-based completion semantics, and persisted intermediate directories (`gen_specs/` for code-derived specs, `gen_specs_smt/` for code-derived formal artifacts).
- Define first-class support for canonical requirement and scenario identifiers so the tool can participate in traced verification workflows.
- Define v1 scope as small repositories with up to 10 spec files, low hundreds of requirements and scenarios total, and modest single-package or small multi-module source trees.

### Out of Scope

- Support for arbitrary Markdown conventions or arbitrary OpenSpec schemas.
- Full formal verification of the entire implementation.
- Mutation of specs, source files, or tasks as part of analysis.
- Cloud-hosted, multi-tenant, or continuously running service operation.
- Incremental resume, distributed execution, or content-addressed caching in v1.
- Monorepo-scale capacity targets or large-scale repository expansion beyond the stated v1 scope.

## Context

### Background

This change will mark the start of the project. The project follows a strict TypeScript workflow with deterministic core behavior and isolated nondeterministic boundaries. The core idea is to analyze requirements and design artifacts directly, preserve evidence for every conclusion, and then optionally compare original specification intent against code-derived guarantees.

The tool is designed to work in a workflow that treats lightweight formal methods as practical engineering discipline rather than as a separate research artifact. The product value comes from surfacing evidence, assumptions, counterexamples, and residual uncertainty early enough that developers can correct the specification or implementation before defects spread through the software development lifecycle.

### Affected Systems and Stakeholders

- Developers writing OpenSpec proposal, design, and capability specification artifacts with agent assistance.
- Developers implementing specifications and needing evidence that the implementation matches specification intent.
- Local project repositories that use the `srs-driven` OpenSpec schema and traced verification practices.

### Assumptions and Dependencies

- The analyzed project uses the `srs-driven` OpenSpec schema and follows its artifact structure.
- The `opencode` binary is available locally and can return machine-readable JSON responses for configured prompts and models.
- The `z3` binary is available locally or via the `--z3` option.
- Projects using this tool treat canonical requirement and scenario identifiers as stable references across specs, code, and tests.
- The initial implementation targets local repository analysis rather than remote or hosted execution.
- Source-backed analysis assumes a readable source directory and may use implementation plus verified contracts as primary evidence, with documentation as supporting evidence.

### Constraints

- The tool is a local read-only CLI implemented in TypeScript on Node.js 20+.
- The deterministic core must remain explainable, inspectable, and bounded even when the tool relies on LLMs or solver calls at the boundaries.
- All final conclusions must preserve provenance and supporting evidence; no final verdict may rest on an opaque unpreserved response.
- All output writes are confined to the configured output directory.
- The tool must strongly conform to the repository TypeScript style guide and its emphasis on deterministic systems, explicit invariants, bounded work, and strict tooling.

### References

- `pasture/plan.md`
- `docs/lfm.md`
- `docs/typescript_style.md`
- `docs/spec_traceability.md`
- [AWS Requirements Analysis tool](https://kiro.dev/blog/deep-spec-analysis/)
- [claimcheck](https://github.com/metareflection/claimcheck)

## Domain Model

The domain consists of specification artifacts, derived claims, analysis evidence, and final reports.

- **Document**: A proposal, design, capability spec, or task file that contributes source intent.
- **Capability**: A logical behavior group represented by one capability spec file and its purpose.
- **Requirement**: A capability-level behavioral obligation expressed in EARS or an approved escape-hatch format.
- **Scenario**: A concrete, testable behavioral case that refines a requirement expressed in EARS or an approved escape-hatch format.
- **Claim**: A normalized statement derived from a requirement, scenario, proposal section, design section, task summary, or code-derived guarantee.
- **Finding**: An analysis result with severity, rationale, provenance, and supporting evidence.
- **Formalization Sample**: One candidate formal encoding of a claim produced during the formalization process.
- **Equivalence Cluster**: A group of mutually implying formalization samples that represent one interpretation of a claim.
- **Solver Artifact**: A generated logic file, solver query, model, unsat core, timeout result, or other persisted formal-analysis artifact.
- **Traceability Identifier**: A canonical bracketed identifier that links requirements and scenarios to tests, reviews, or source-backed evidence.
- **Code-Derived Specification**: An EARS-preferring behavioral specification generated from source evidence for one capability, blind to original requirement text, and persisted as a Markdown file in `gen_specs/`.
- **Cross-Side Implication Result**: A solver-backed classification of the formal relationship between an original claim formalization and its code-derived counterpart, expressing same, stronger, weaker, different, or uncertain.
- **Report**: A human-readable Markdown artifact summarizing one analysis pass or a synthesized result.
- **Manifest**: The completion record listing all produced output files and checksums.

Conceptual relationships:

```text
Document ──────────────────────────────────────────┐
  (proposal, design, spec, task)                   │
       │                                           │
       ▼                                           │
  Structured Parser ──▶ Unparsed Lines (evidence)  │
       │                                           │
       ▼                                           │
     Claim ───────────────────────────────┐        │
  (requirement, scenario, property,       │        │
   assumption, invariant, failure mode)   │        │
       │                                  │        │
       ├──▶ Formalization Sample ─────────┤        │
       │        │                         │        │
       │        ▼                         │        │
       │   Equivalence Cluster            │        │
       │        │                         │        │
       │        ▼                         │        │
       │   Solver Artifact                │        │
       │   (SMT-LIB, model,              │        │
       │    unsat core, timeout)          │        │
       │        │                         │        │
       ▼        ▼                         ▼        │
     Finding ◀────────────────────────────┘        │
  (severity, rationale, provenance,                │
   evidence references)                            │
       │                                           │
       ▼                                           │
     Report ◀──────────────────────────────────────┘
  (phase report, synthesized summary)
       │
       ▼
    Manifest
  (completion record, checksums)

Source Code ─────────────────────────────────────────────────┐
  (implementation, verified contracts, traced tests)         │
       │                                                     │
       ▼                                                     │
  Code-Derived Specification ─────────────────────────┐      │
  (EARS-preferring, per capability, blind to specs)   │      │
       │                                              │      │
       ▼                                              │      │
  Code-Derived Formalization ─────────────────────────┤      │
  (same pipeline: sampling, validation, clustering)   │      │
       │                                              │      │
       ▼                                              │      │
  Cross-Side Implication ─────────────────────────────┤      │
  (bidirectional solver checks: original vs derived)  │      │
       │                                              │      │
       ▼                                              ▼      │
     Finding ◀────────────────────────────────────────┘      │
  (same, stronger, weaker, different, uncertain)             │
       │                                                     │
       ▼                                                     │
     Report ◀────────────────────────────────────────────────┘
  (report_2.logic.md, report_2.compare.md)

Traceability Identifier links Claims to tests, reviews, and source evidence.
Capability groups Claims and their associated Findings by behavioral scope.
Solver implication is the primary strength classifier;
  blind LLM comparison is the explanatory layer.
```

Conceptually, documents produce claims, claims produce findings and formal artifacts, and findings are synthesized into evidence-preserving reports.

## Preconditions, Postconditions, and Invariants

### Global

Preconditions:
- At least one input specification artifact exists and is readable.
- The analyzed project follows the `srs-driven` artifact conventions closely enough to admit structured parsing.
- Required local dependencies for the selected analysis mode are available: `opencode` for LLM-backed phases and `z3` for solver-backed phases.
- When `--src` is used, the source directory is readable and within the intended project scope.

Postconditions:
- The tool produces a bounded, evidence-preserving set of reports and intermediate artifacts under the output directory.
- Every surfaced finding includes provenance and enough supporting evidence for a reviewer to inspect the basis of the conclusion.
- When analysis completes successfully, a manifest is written last and identifies the produced artifacts.
- When source-backed analysis is requested, the output includes traceability or comparison results that explain the relationship between spec intent and code-derived guarantees.

Invariants:
- Input specs, task files, and source files are never mutated.
- No final verdict relies on a single opaque LLM response without preserved evidence.
- Every LLM response used by the system is schema-validated before it influences downstream phases.
- Solver inputs and outputs are persisted verbatim.
- Findings are never silently erased by later phases; later phases may add evidence or add findings, but not remove prior conclusions without surfacing that change.
- Re-running with identical inputs and fixed or cached LLM responses produces identical outputs.
- Uncached runs may differ in wording or supporting samples, but they should surface materially similar findings for the same underlying issues.
- All writes remain confined to the configured output directory and use completion semantics that prevent partial final artifacts from being mistaken for a complete run.

### CLI and Configuration

Preconditions:
- The process can execute and read its own argv.
- When `--config` is provided, the config file exists and is readable JSON.

Postconditions:
- Valid arguments produce a fully resolved run configuration before any analysis phase begins.
- Invalid arguments, unreadable input paths, or missing required dependencies produce a fatal error with exit code `2` before any analysis output is written.
- `--help` and `--version` print the requested information and exit with code `0` without running analysis.

Invariants:
- CLI validation is a local, deterministic operation that never contacts external tools or writes output artifacts.
- The resolved run configuration is immutable once analysis begins.

### Catalog and Input Resolution

Preconditions:
- At least one input path resolves to a readable file or directory containing OpenSpec artifacts.
- When the input includes a directory, the `srs-driven` schema conventions are recognizable enough to classify proposal, design, spec, and optional task inputs.

Postconditions:
- The catalog identifies every document that will be analyzed and its classification (proposal, design, spec, task).
- Active capability state is resolved: finalized specs plus at most one in-development delta per capability.
- Archived change specs are excluded from downstream analysis.
- Conflicting in-development deltas for the same capability are surfaced as findings rather than silently resolved.

Invariants:
- The catalog is deterministic given the same input paths and filesystem state.
- No downstream phase receives an input document that was not explicitly cataloged.

### Structured Parsing

Preconditions:
- Cataloged documents are readable UTF-8 text files.

Postconditions:
- Each parsed document produces a typed model with recognized sections, extracted identifiers, and structural metadata.
- Lines that do not match any recognized pattern are preserved with file and line provenance as unparsed evidence.
- Structural violations (missing headings, malformed identifiers, incomplete delta sections) produce findings with provenance.

Invariants:
- The parser never silently drops input content; every line is either classified or preserved as unparsed evidence.
- Parser output is deterministic given the same input content.
- The parser does not mutate input files.

### Claim Graph Construction

Preconditions:
- At least one document has been successfully parsed with recognizable structure.

Postconditions:
- Every recognized requirement, scenario, proposal property, design property, assumption, invariant, failure mode, and task summary is normalized into a typed claim with provenance.
- Claims carry obligation level (mandatory, advisory, informational) where the source structure supports classification.
- No claim exists without provenance linking it to a source file and heading.

Invariants:
- Claim extraction is deterministic given the same parsed input.
- Claims with insufficient provenance are surfaced as analysis defects rather than admitted into the graph.

### Qualitative Analysis

Preconditions:
- The claim graph contains at least one claim from a parsed document.
- The `opencode` binary is available and responds to the configured model.

Postconditions:
- Each qualitative pass produces schema-validated findings with severity, rationale, provenance, and evidence.
- Invalid or unusable `opencode` responses after bounded retries cause the run to fail with fatal analysis behavior rather than producing an incomplete evidence set.

Invariants:
- `opencode` responses are schema-validated before they influence downstream phases.
- Qualitative findings preserve the full response content as evidence.
- Prompt construction fences document content so analyzed spec text is never elevated into system-level instruction position.

### Coverage Analysis

Preconditions:
- The claim graph contains claims from at least a proposal or design document and at least one capability spec.

Postconditions:
- Missing coverage between upstream intent (proposal/design claims) and downstream requirements (capability specs) is reported with both sides identified.
- Contradictions or semantic mismatches between upstream and downstream claims are reported with evidence from both sources.
- Missing spec files for declared capabilities are reported.
- Unsupported or broken requirement references are reported.

Invariants:
- Coverage analysis is deterministic given the same claim graph.
- Coverage analysis does not remove or modify claims from the graph.

### Formalization

Preconditions:
- The claim graph contains requirement or scenario claims eligible for formal analysis.
- The `opencode` binary is available for formalization sampling.

Postconditions:
- Each formalized claim produces one or more typed logic representations and compiled SMT-LIB artifacts.
- Formalization samples are schema-validated before acceptance.
- Accepted samples are clustered by semantic equivalence using solver-backed implication checks.
- When one equivalence cluster meets the configured stability threshold, its highest-confidence sample is selected as the representative interpretation.
- When no cluster meets the threshold, an ambiguity finding is emitted with all distinct surviving interpretations preserved.

Invariants:
- Formalization output preserves claim identifiers and source provenance.
- Invalid formalization samples are rejected, not silently admitted into clustering or solver analysis.
- SMT-LIB identifiers derived from user content are sanitized to prevent solver syntax collisions.

### Solver Analysis

Preconditions:
- At least one formalized claim has a selected representative interpretation with compiled SMT-LIB artifacts.
- The `z3` binary is available locally or via the `--z3` option.

Postconditions:
- Obligation-aware solver passes classify contradictions and gaps with severity appropriate to the obligation level (mandatory claims produce higher-severity findings than advisory claims).
- Counterexamples, models, unsat cores, timeout results, and unknown results are persisted verbatim as evidence.
- Inconclusive solver results (timeout, unknown) are preserved as findings rather than treated as success.

Invariants:
- Solver inputs and outputs are persisted verbatim under the output directory.
- No solver conclusion is produced from an unvalidated formalization step.
- Solver timeouts are bounded per query.

### Source Traceability

Preconditions:
- The `--src` flag is provided and the source directory is readable.
- The claim graph contains requirement or scenario claims with canonical traceability identifiers.

Postconditions:
- Each requirement and scenario claim is traced to relevant source artifacts (implementation, traced tests, verified contracts).
- Traced claims report the linked source evidence and the claim identifier.
- Untraced claims produce traceability gap findings.

Invariants:
- Source scanning is confined to the declared source directory scope.
- Source files are never mutated.
- Source traceability does not overwrite or remove findings from earlier phases.

### Code-Backwards Comparison

Preconditions:
- Source traceability has completed and source-backed evidence is available.
- The claim graph contains capability-aligned requirement claims for comparison.
- Code-derived specifications have been generated for capabilities with sufficient source evidence.
- Code-derived specifications have been formalized through the same pipeline (sampling, validation, clustering) and SMT-LIB artifacts are available in `gen_specs_smt/`.

Postconditions:
- Code-derived specifications are generated per capability using implementation and verified contracts as primary evidence and are persisted in `gen_specs/` under the output directory.
- Code-derived specifications are formalized and persisted in `gen_specs_smt/` under the output directory.
- Internal consistency of code-derived formalizations is checked via solver analysis and reported in `report_2.logic.md`.
- Cross-side implication checks between original and code-derived formalizations produce the primary strength classification (same, stronger, weaker, different, uncertain).
- Blind LLM comparison provides explanatory rationale for each classification.
- Each comparison preserves both the formal implication evidence and the blind comparison rationale.
- The blind comparison boundary is maintained: the code-derived side receives only code-derived artifacts and supporting metadata, not original requirement text.

Invariants:
- Original requirement text never crosses the blind comparison boundary into the code-derived comparison side or the code-derived generation side.
- Code-derived guarantees are bounded to declared source scope and visible evidence.
- Solver implication is the primary strength classifier; blind LLM comparison is the explanatory layer.
- Cross-side implication queries and results are persisted verbatim.

### Reporting and Manifest

Preconditions:
- At least one analysis phase has completed and produced findings or evidence.

Postconditions:
- Phase-specific reports are written for each completed analysis pass.
- A synthesized summary report aggregates findings across phases.
- Skipped phases are explained in the synthesized report rather than omitted silently.
- The manifest is written last and lists all produced output files with checksums.
- An interrupted or failed run does not leave a manifest that implies completed output.

Invariants:
- All report writes are confined to the configured output directory.
- Reports never contain findings without provenance.
- The manifest is the last file written and serves as the atomic completion marker.

## Failure Modes

### Global

- **False negative analysis**: The tool fails to report a real contradiction, ambiguity, missing requirement, or implementation gap.
  - **Rationale**: This undermines the core value of the product because users may trust a flawed specification or implementation and carry defects deeper into the lifecycle.
- **Nondeterministic material divergence**: Repeated runs on the same inputs surface materially different findings without corresponding input changes.
  - **Rationale**: Developers cannot build a trustworthy dependability case if the analytical conclusions shift unpredictably between runs.
- **Evidence loss**: Reports or findings omit provenance, supporting artifacts, counterexamples, or rationale needed to justify a conclusion.
  - **Rationale**: The product is intended to support evidence-based dependability cases; missing evidence weakens trust even when a finding is correct.
- **External dependency unavailability**: Required local dependencies such as `opencode` or `z3` are unavailable or return unusable output.
  - **Rationale**: The tool must fail explicitly rather than imply that analysis was complete when critical phases could not run correctly.

### CLI and Configuration

- **Invalid arguments or unreadable config**: CLI arguments are malformed, required flags are missing, or `--config` points to invalid JSON.
  - **Rationale**: Invalid run configuration must be rejected before analysis begins so no output artifacts are produced under ambiguous settings.
- **Missing required dependency at startup**: The `opencode` or `z3` binary is absent or non-executable when the selected analysis mode requires it.
  - **Rationale**: Dependency checks must fail fast rather than producing partial output that lacks critical evidence-producing phases.

### Catalog and Input Resolution

- **Unreadable input path**: A specified input path does not exist, is not readable, or does not contain recognizable OpenSpec artifacts.
  - **Rationale**: The analysis must not proceed with an incomplete input set because missing documents could hide contradictions or coverage gaps that would otherwise be detected.
- **Conflicting in-development deltas**: Multiple in-development changes modify the same capability and the tool cannot select one unambiguously.
  - **Rationale**: Silently choosing one delta over another would hide a real project-level coordination failure that the user needs to resolve.
- **Schema convention mismatch**: Input artifacts do not follow `srs-driven` conventions closely enough for structured parsing to succeed.
  - **Rationale**: Attempting to analyze unrecognizable artifacts would produce misleading structural findings or false negatives from malformed input.

### Structured Parsing

- **No recognizable headings**: An input file contains no headings that the parser can classify.
  - **Rationale**: A file without recognizable structure cannot contribute meaningful typed content; processing it would inject noise into the claim graph.
- **Structural violation**: A recognizable heading violates schema-mandated rules (malformed identifier, missing scenario, missing references, incomplete delta section).
  - **Rationale**: Structural violations indicate specification defects that must be surfaced deterministically rather than hidden behind downstream analysis.
- **Silent parser loss**: Input content is dropped without being classified or preserved as unparsed evidence.
  - **Rationale**: Silent loss undermines the conservative evidence model because reviewers cannot know what content was ignored.

### Claim Graph and Coverage Analysis

- **Orphaned claim**: A claim is derived without sufficient provenance to trace it back to a source artifact and heading.
  - **Rationale**: Untraceable claims cannot support evidence-based findings and would corrupt the provenance chain that downstream phases depend on.
- **Missing spec file for declared capability**: The proposal declares a capability but no corresponding active spec file exists in the catalog.
  - **Rationale**: This is a specification gap that must be surfaced because the tool cannot analyze requirements that do not exist.
- **Unsupported requirement reference**: A requirement references an upstream section whose content does not support the cited behavior.
  - **Rationale**: Decorative references that do not actually support a requirement weaken the traceability contract and must be surfaced.

### Qualitative Analysis

- **`opencode` unavailable or unusable**: The `opencode` binary is unavailable, times out, or returns a response that fails schema validation after bounded retries.
  - **Rationale**: Qualitative analysis is a required evidence-producing phase; continuing without it would create a false impression of completed analysis.
- **Prompt injection risk**: Analyzed document content could be elevated into system-level instruction position in the prompt.
  - **Rationale**: The tool processes untrusted specification text and must fence it to prevent prompt manipulation that could distort analysis conclusions.

### Formalization

- **All formalization samples invalid**: No schema-valid formalization sample is produced for a claim after bounded retries.
  - **Rationale**: Solver analysis depends on validated formalizations; proceeding with invalid or absent formalizations would produce meaningless solver results.
- **Clustering instability**: No equivalence cluster meets the configured stability threshold for a claim.
  - **Rationale**: Unstable formalization indicates genuine ambiguity in the claim that must be surfaced rather than hidden behind an arbitrary sample selection.

### Solver Analysis

- **`z3` unavailable**: The `z3` binary is absent, non-executable, or fails to start.
  - **Rationale**: Solver analysis is a required evidence-producing phase when formalization is enabled; missing solver results would create an incomplete evidence set.
- **Solver timeout or unknown result**: The solver does not produce a definitive result (sat/unsat) within the per-query timeout.
  - **Rationale**: Inconclusive results must be preserved as evidence and surfaced as findings rather than silently treated as success.
- **SMT-LIB syntax collision**: User-derived identifiers contain characters that conflict with SMT-LIB syntax.
  - **Rationale**: Unsanitized identifiers could produce malformed solver inputs that yield incorrect or unparseable results.

### Source Traceability and Code-Backwards

- **Unreadable source directory**: The `--src` path does not exist, is not readable, or contains no recognizable source artifacts.
  - **Rationale**: Source-backed analysis must fail explicitly rather than produce empty traceability results that could be mistaken for full coverage.
- **Evidence outside declared scope**: A candidate code-derived guarantee depends on evidence from outside the provided source directory.
  - **Rationale**: Admitting out-of-scope evidence would overstate confidence in code-backed guarantees and weaken the comparison boundary.
- **Blind comparison boundary violation**: Original requirement text is exposed to the code-derived comparison side or the code-derived generation side.
  - **Rationale**: The blind comparison design exists to prevent the code-derived side from simply restating requirements; violating the boundary would undermine the entire comparison methodology.
- **Insufficient source evidence for capability**: A declared capability lacks sufficient source-scoped evidence to generate meaningful code-derived specifications.
  - **Rationale**: Generating specifications from insufficient evidence would produce misleading guarantees that could create false confidence in comparisons.
- **Code-derived formalization failure**: All formalization samples for a code-derived claim are invalid after bounded retries.
  - **Rationale**: Cross-side implication analysis depends on valid formalizations on both sides; proceeding without valid code-derived formalizations would produce meaningless comparison results.
- **Cross-side implication inconclusive**: The solver returns timeout or unknown for implication checks between original and code-derived formalizations.
  - **Rationale**: Inconclusive cross-side results must be preserved as honest uncertainty rather than silently treated as alignment or treated as failure.

### Reporting and Manifest

- **Output write failure**: A report or intermediate artifact cannot be written to the configured output directory.
  - **Rationale**: Incomplete output without a clear failure signal would leave reviewers unable to distinguish partial from complete analysis.
- **Manifest written before all outputs finalized**: The manifest is written before all selected artifacts are complete.
  - **Rationale**: Consumers rely on manifest presence as the completion marker; premature manifests would cause partial output to be trusted as complete.
- **Finding without provenance in report**: A finding reaches report rendering without provenance or supporting evidence.
  - **Rationale**: Unsupported conclusions in reports directly undermine the product's evidence-preservation contract.

## Error Format and Exit Codes

### Exit Code Table

| Code | Category | Meaning |
|------|----------|---------|
| 0 | — | Analysis completed without findings |
| 1 | FindingsPresent | Analysis completed and surfaced one or more findings |
| 2 | FatalError | Fatal error prevented successful analysis completion |

Exit code `2` covers invalid arguments, unreadable inputs, unavailable required dependencies, invalid external-tool output after retries, unrecoverable output failure, and any condition that prevents the tool from producing a trustworthy evidence set.

### Stderr Format

Diagnostic and error output is written to stderr. Fatal errors follow this format on the first line:
```
[spec-check] <Category>: <concise message>
```

Subsequent lines may contain indented detail from external tool stderr when useful for diagnosis.

Examples:
```
[spec-check] FatalError: opencode returned invalid JSON after 3 retries (phase: qualitative-review)
[spec-check] FatalError: z3 binary not found at /usr/bin/z3
[spec-check] FatalError: output directory not writable: ./spec-check-output
```

### Stdout Format

Stdout carries structured JSON progress events during analysis. Each event is a single JSON line with at least:
- `phase`: the pipeline phase name
- `status`: one of `started`, `completed`, `failed`, `skipped`
- `timestamp`: ISO-8601 UTC timestamp

Phase completion events include `duration_ms` and summary counts where applicable.

### Signal Handling

- During LLM or solver calls: SIGINT/SIGTERM immediately abort the current external call and exit without writing the manifest. Intermediate artifacts already written remain under the output directory.
- During report writing: If killed between artifact write and manifest write, intermediate artifacts may be present but the manifest is absent, signaling an incomplete run.
- The tool does not trap SIGKILL. Under SIGKILL, no cleanup occurs and manifest absence is the only indicator of incompleteness.

### Version Source

The CLI version is read from `package.json` at build time and embedded as a constant. The `--version` flag prints this value.

## Quality Attributes

- **Reliability**
  - **Target/Threshold**: The tool SHALL never silently drop findings or evidence. It SHALL hard-fail when required external-tool responses are unavailable, invalid, or unusable after bounded retries.
  - **Influence**: Reliability drives fail-fast handling at external boundaries, explicit failure policy, preserved intermediate artifacts, and bounded execution behavior.
- **Observability**
  - **Target/Threshold**: Every finding SHALL include provenance. Every run SHALL emit phase progress information and SHALL write a manifest that lists produced artifacts and checksums.
  - **Influence**: Observability drives structured progress events, manifest-based completion semantics, report synthesis, and preserved solver and model artifacts.
- **Security**
  - **Target/Threshold**: The tool SHALL use explicit argv-based subprocess invocation only, SHALL write only under `--output`, and SHALL fence prompt content so analyzed spec text is never elevated into system-level instruction position.
  - **Influence**: Security drives subprocess adapter design, output-path confinement, prompt-construction rules, identifier sanitization, and filesystem safety semantics.
- **Bounded Responsiveness**
  - **Target/Threshold**: LLM-backed phases SHALL use bounded retries (default 3 attempts per call) with configurable per-call timeout. Solver queries SHALL use a per-query timeout (default 30 seconds). The overall pipeline SHALL not hang indefinitely on any single external call.
  - **Influence**: Bounded responsiveness drives explicit timeout handling in adapters, retry constants, and non-blocking failure outcomes for both `opencode` and `z3` calls.
- **Determinism**
  - **Target/Threshold**: Re-running with identical inputs and fixed or cached LLM responses SHALL produce byte-identical outputs. Uncached runs SHALL surface materially similar findings for the same underlying issues.
  - **Influence**: Determinism drives the separation of deterministic core processing from nondeterministic boundary phases, parser design, claim graph construction, coverage analysis, and report rendering.
- **Maintainability**
  - **Target/Threshold**: The specification and code map are structured so future changes can localize behavior by pipeline phase and architecture layer.
  - **Influence**: Encourages phase-based specs, explicit code maps, deterministic domain-core design, and isolated adapter boundaries.

## Capabilities

### New Capabilities
- `catalog-and-parse`: Discover relevant OpenSpec artifacts, resolve active capability state, parse structured content, and produce deterministic structural findings with provenance.
- `claim-graph-and-coverage`: Normalize parsed content into typed claims and analyze coverage, contradiction, and semantic alignment across proposal, design, and capability specs.
- `formalization-and-logic-analysis`: Translate claims into formal artifacts, cluster alternate interpretations, and use solver-backed analysis to detect conflicts, gaps, and surprising behaviors.
- `source-traceability-and-code-backwards`: Relate requirements to source evidence, generate EARS-preferring code-derived specifications from source, formalize code-derived specifications through the same sampling and clustering pipeline, use solver-backed cross-side implication as the primary strength classifier, and provide blind LLM comparison as the explanatory rationale layer.
- `reporting-and-evidence`: Produce bounded, evidence-preserving output artifacts, final reports, and manifest-based completion records.

### Modified Capabilities
- None.
