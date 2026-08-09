# spec-check -- Technical Design

> **Living document** -- maintained alongside OpenSpec artifacts, code, and tests.
> Complements [`docs/lfm.md`](docs/lfm.md) (assurance posture), [`docs/spec_traceability.md`](docs/spec_traceability.md) (traceability contract), [`docs/typescript_style.md`](docs/typescript_style.md) (implementation style), and the normative specs under [`openspec/specs/`](openspec/specs/).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Scope and Boundaries](#2-scope-and-boundaries)
3. [Architecture](#3-architecture)
4. [Domain Model](#4-domain-model)
5. [Preconditions, Postconditions, and Invariants](#5-preconditions-postconditions-and-invariants)
6. [State Machines](#6-state-machines)
7. [Interaction Protocols](#7-interaction-protocols)
8. [Failure Modes and Error Model](#8-failure-modes-and-error-model)
9. [Safety and Liveness Claims](#9-safety-and-liveness-claims)
10. [Quality Attributes](#10-quality-attributes)
11. [Verification Strategy](#11-verification-strategy)
12. [Distribution and Packaging](#12-distribution-and-packaging)
13. [Security and Trust Boundaries](#13-security-and-trust-boundaries)
14. [Operational Concerns](#14-operational-concerns)
15. [Forward Evolution](#15-forward-evolution)
16. [Pipeline and Output Summary](#16-pipeline-and-output-summary)
17. [Relationship to Other Documents](#17-relationship-to-other-documents)
18. [Maintenance Rules](#18-maintenance-rules)

---

## 1. Overview

### 1.1 What spec-check Is

`spec-check` is a local TypeScript CLI that analyzes OpenSpec specification artifacts -- proposals, designs, capability specs, and optional task files -- to catch defects, ambiguity, contradictions, and missing assumptions before implementation begins. When a source directory is provided, it optionally compares original specification intent against code-derived guarantees using solver-backed formal analysis.

This project is strongly influenced by [AWS's Requirements Analysis tool](https://kiro.dev/blog/deep-spec-analysis/) and by [Midspiral's claimcheck](https://midspiral.com/blog/claimcheck-narrowing-the-gap-between-proof-and-intent/).

### 1.2 Why It Exists

Agent-assisted development can produce plausible code faster than developers can produce trustworthy evidence. `spec-check` supports evidence-based dependability cases through the full software development lifecycle by surfacing specification defects early enough that developers can correct them before they spread. The product value comes from surfacing evidence, assumptions, counterexamples, and residual uncertainty -- not from opaque verdicts.

### 1.3 Core Design Challenge

`spec-check` is not a generic document linter and not a full formal verifier of implementation. Its design problem is to combine:

- deterministic parsing and claim normalization
- LLM-backed qualitative review and formalization sampling
- solver-backed contradiction and completeness analysis
- optional source-backed traceability and code-backwards comparison
- evidence preservation strong enough for audit and review

The central challenge is preserving trust while crossing two nondeterministic boundaries: `opencode` and `z3`.

### 1.4 Design Philosophy

This project applies **lightweight formal methods** ([`docs/lfm.md`](docs/lfm.md)): critical properties are expressed as preconditions, postconditions, and invariants in code; the verification pyramid (formal models, property-based tests, contract tests, integration tests) provides layered assurance; and the design treats lightweight formal methods as practical engineering discipline rather than a separate research artifact.

The design is centered on:

- preconditions for every pipeline phase and boundary crossing
- postconditions that describe the observable outcome after success or failure
- invariants over evidence preservation, provenance propagation, determinism, and output confinement
- failure modes that are explicit rather than hidden behind opaque summaries
- safety properties that forbid bad things from happening (false success, evidence loss, prompt injection)
- liveness properties that describe when bounded progress is expected

The goal is not a proof of the whole system. The goal is justified confidence: the design claims are explicit, mechanically checkable, traceable into the capability specs, and re-checked in tests as the system evolves.

### 1.5 Relevant Capability Specs

| Capability | Purpose |
|---|---|
| [`catalog-and-parse`](openspec/specs/catalog-and-parse/spec.md) | input discovery, CLI validation, structured parsing, EARS extraction, loss-aware evidence |
| [`claim-graph-and-coverage`](openspec/specs/claim-graph-and-coverage/spec.md) | claim normalization, obligation levels, coverage gaps, contradiction detection |
| [`formalization-and-logic-analysis`](openspec/specs/formalization-and-logic-analysis/spec.md) | formalization sampling, equivalence clustering, SMT-LIB compilation, per-spec solver analysis |
| [`source-traceability-and-code-backwards`](openspec/specs/source-traceability-and-code-backwards/spec.md) | source tracing, code-derived specs, cross-side implication, blind comparison |
| [`reporting-and-evidence`](openspec/specs/reporting-and-evidence/spec.md) | report rendering, evidence preservation, manifest semantics, output confinement |
| [`spec-traceability`](openspec/specs/spec-traceability/spec.md) | canonical identifier discovery, test harness integration, coverage enforcement |

---

## 2. Scope and Boundaries

### 2.1 In Scope

- local TypeScript CLI that analyzes OpenSpec artifacts using the `srs-driven` schema
- a specs-forward pipeline that evaluates `proposal.md`, `design.md`, active capability `spec.md` files, and optional `tasks.md` for ambiguity, contradiction, incompleteness, and traceability gaps
- a formalization pipeline that translates claims into typed logic IR and SMT-LIB artifacts for solver-backed analysis
- optional source-backed analysis: traceability, code-derived spec generation, code-derived formalization, solver-backed cross-side implication, and blind LLM comparison
- output artifacts, evidence preservation, progress signaling, failure behavior, manifest-based completion semantics
- first-class support for canonical requirement and scenario identifiers
- traceability infrastructure that keeps specs, tests, and evidence connected
- v1 targets small repositories: up to 10 spec files, low hundreds of requirements and scenarios total, modest single-package or small multi-module source trees

### 2.2 Out of Scope

- support for arbitrary Markdown conventions or arbitrary OpenSpec schemas
- full formal verification of the entire implementation
- mutation of specs, source files, or tasks as part of analysis
- cloud-hosted, multi-tenant, or continuously running service operation
- incremental resume, distributed execution, or content-addressed caching in v1
- monorepo-scale capacity targets

### 2.3 Goals and Non-Goals

#### Goals

- build a deterministic analysis pipeline that converts OpenSpec artifacts into typed claims, findings, reports, and preserved evidence
- keep nondeterminism at explicit boundaries so reviewers can distinguish deterministic processing from model- or solver-dependent behavior
- preserve enough intermediate structure that every meaningful finding can be traced back to its source artifact and supporting evidence
- support both specs-forward and optional source-backed analysis without conflating their evidence models
- make canonical spec identifiers and traced verification first-class inputs to the design

#### Non-Goals

- support arbitrary spec schemas or arbitrary Markdown conventions in v1
- build a hosted service, daemon, or multi-user workflow
- optimize for monorepo-scale scanning or very large input catalogs in the initial version
- provide incremental resume or cache-coordination semantics in v1
- turn the tool into a full formal verification system for the entire implementation

### 2.4 Source-of-Truth Boundaries

| Concern | Authoritative Source | Consequence |
|---|---|---|
| specification intent | committed OpenSpec artifacts (proposal, design, spec files) | the tool reads but never mutates specification inputs |
| capability behavior | active `openspec/specs/**/spec.md` plus at most one in-dev delta per capability; when both exist, per-capability merge produces a single merged active view by applying delta operations (ADDED/MODIFIED/REMOVED) against the finalized base | archived specs are excluded by default; explicitly provided archived inputs can be admitted with `--allow-archive` |
| code-derived guarantees | source directory and its tests/contracts | code-derived analysis is bounded to the declared `--src` scope |
| analysis conclusions | preserved evidence under the output directory | no final verdict rests on an unpreserved opaque LLM response |
| run completion | manifest file written last in output directory | manifest absence means incomplete run |
| traceability identifiers | canonical bracketed identifiers in OpenSpec specs | tests and source must align to those identifiers |

### 2.5 Nondeterministic Boundaries

| Boundary | Tool | Used By |
|---|---|---|
| qualitative review | `opencode` | qualitative pass 1 and pass 2 |
| formalization sampling | `opencode` | per-claim logic IR generation |
| code-derived spec generation | `opencode` | blind generation from source evidence |
| code-derived formalization | `opencode` | formalization of generated specs |
| blind comparison | `opencode` | explanatory rationale for cross-side classification |
| equivalence clustering | `z3` | pairwise implication checks between samples |
| per-spec logic analysis | `z3` | satisfiability, contradiction, completeness |
| code-derived logic analysis | `z3` | internal consistency of code-derived formalizations |
| cross-side implication | `z3` | bidirectional original-vs-derived classification |

All other processing between these boundaries is modeled as deterministic transformation, validation, or report assembly.

### 2.6 Thin-Wrapper Boundaries

- `opencode` is used for qualitative analysis, formalization, code-derived generation, and blind comparison
- `z3` is used for implication, satisfiability, contradiction, and completeness checks
- the filesystem adapter owns output confinement, atomic writes, and checksums

---

## 3. Architecture

### 3.1 High-Level Architecture Diagram

```mermaid
graph TD
    User([User / Terminal])

    subgraph CLI["CLI Layer (src/cli/)"]
        Entry["src/index.ts<br/>argv parsing + dispatch"]
        Argv["src/cli/parse-argv.ts<br/>Hand-rolled arg parser"]
        Config["src/cli/config.ts<br/>Three-tier config merge"]
        Runner["src/cli/run-cli.ts<br/>Phase orchestration"]
        PhaseRunner["src/cli/phase-runner.ts<br/>Progress event decoration"]
        Helpers["src/cli/pipeline-helpers.ts<br/>Phase composition"]
    end

    subgraph Domain["Domain Core (src/domain/)"]
        Catalog["parser/catalog.ts<br/>Input discovery + classification"]
        Parser["parser/spec.ts, proposal.ts,<br/>design.ts, task.ts<br/>Structured parsing"]
        Merge["parser/merge.ts<br/>Per-capability delta merge"]
        Claims["claim-graph.ts<br/>Normalization + obligation"]
        Coverage["spec-forward/coverage.ts<br/>Gap and contradiction detection"]
        Qualitative["spec-forward/qualitative.ts<br/>LLM-backed review passes"]
        Formalize["formal/formalize.ts +<br/>findings/evidence modules<br/>Semantic batching + sampling"]
        Validate["formal/validate.ts<br/>Schema validation"]
        Cluster["formal/clustering.ts<br/>Equivalence clustering"]
        Identifiers["formal/identifiers.ts<br/>Injective identifier sanitization"]
        SmtLib["formal/smtlib.ts<br/>SMT-LIB compilation"]
        Logic["formal/logic-analysis.ts<br/>Per-spec solver analysis"]
        Trace["code-backwards/trace.ts<br/>Source traceability"]
        Derive["code-backwards/derive.ts<br/>Code-derived spec generation"]
        GenFormal["code-backwards/gen-formal.ts<br/>Code-derived formalization"]
        CrossImpl["code-backwards/cross-implication.ts<br/>Bidirectional solver comparison"]
        Blind["code-backwards/blind-compare.ts<br/>Explanatory LLM rationale"]
        Reports["reporting/render.ts<br/>Report synthesis"]
        Manifest["reporting/manifest.ts<br/>Completion manifest"]
        Types["model.ts, branded.ts, errors.ts,<br/>result.ts, assert.ts, logic-ir.ts<br/>Domain primitives"]
    end

    subgraph Adapters["Adapter Layer (src/adapters/)"]
        FS["fs.ts<br/>Confined writes + checksums"]
        Proc["process.ts<br/>Safe subprocess execution"]
        OpenCode["opencode.ts<br/>LLM subprocess integration"]
        Z3["z3.ts<br/>Solver subprocess integration"]
        Conc["concurrency.ts<br/>Bounded parallel map"]
    end

    subgraph External["External Systems"]
        SpecFiles[("OpenSpec files")]
        SrcFiles[("Source tree")]
        OCmd[("opencode")]
        ZCmd[("z3")]
        OutDir[("Output directory")]
    end

    User --> Entry
    Entry --> Argv
    Argv --> Config
    Config --> Runner
    Runner --> PhaseRunner
    Runner --> Helpers
    Helpers --> Catalog
    Catalog --> Parser
    Parser --> Merge
    Merge --> Claims
    Claims --> Coverage
    Claims --> Qualitative
    Claims --> Formalize
    Formalize --> Validate
    SmtLib --> Identifiers
    Validate --> Cluster
    Formalize --> SmtLib
    Cluster --> SmtLib
    SmtLib --> Logic
    Claims --> Trace
    Trace --> Derive
    Derive --> GenFormal
    GenFormal --> CrossImpl
    CrossImpl --> Blind
    Coverage --> Reports
    Qualitative --> Reports
    Logic --> Reports
    Blind --> Reports
    Reports --> Manifest
    Domain -.->|"types only"| Adapters
    FS --> OutDir
    OpenCode --> OCmd
    Z3 --> ZCmd
    Catalog --> SpecFiles
    Trace --> SrcFiles
```

### 3.2 Pipeline Architecture

```mermaid
flowchart TD
    A[argv + config] --> B[catalog]
    B --> C[structured parse]
    C --> CM[per-capability merge]
    CM --> D[claim graph]
    D --> E[qualitative review]
    D --> F[coverage analysis]
    D --> G[formalization sampling]
    G --> H[clustering]
    H --> I[SMT-LIB compilation]
    I --> J[solver analysis]
    D --> K[source traceability]
    K --> L[code-derived spec generation]
    L --> M[code-derived formalization]
    M --> N[code-derived logic analysis]
    N --> O[cross-side implication]
    O --> P[blind comparison rationale]
    E --> Q[report synthesis]
    F --> Q
    J --> Q
    K --> Q
    N --> Q
    O --> Q
    P --> Q
    Q --> R[manifest]
```

The core architectural split is deliberate:

- The **CLI layer** parses argv, loads config, validates paths, selects modes, and coordinates exit behavior.
- The **domain layer** owns deterministic reasoning: parsing, claim normalization, coverage analysis, formalization validation, clustering, logic analysis coordination, report assembly, and all type definitions.
- The **adapter layer** owns side effects: filesystem operations, `opencode` subprocess execution, `z3` subprocess execution, and child-process management.

This split matters for assurance. The more the decision logic is isolated from the side-effecting mechanics, the easier it is to express invariants, encode state machines, and mechanically test the behavior that matters. The domain depends on the adapter layer only through types, never through calls.

### 3.3 Component Descriptions

| Component | Responsibility | Key Invariant |
|---|---|---|
| **Entry point** ([`src/index.ts`](src/index.ts)) | Parse argv into typed `CliArgs`, dispatch to pipeline or informational output, write stdout/stderr, set exit code | No business logic; only routing and I/O |
| **Argument parser** ([`src/cli/parse-argv.ts`](src/cli/parse-argv.ts)) | Hand-rolled argv parsing with `Result<CliArgs, ArgError>` return | Pure function; exhaustive `FlagKey` switch + `assertNever`; never throws |
| **Config resolver** ([`src/cli/config.ts`](src/cli/config.ts)) | Three-tier merge: CLI flags > config file > built-in defaults | Resolved `RunConfig` is immutable once analysis begins |
| **Pipeline orchestrator** ([`src/cli/run-cli.ts`](src/cli/run-cli.ts)) | Run-start output invalidation followed by phase-group decomposition into ingestion, analysis, source, reporting | Before any phase work, invalidates the stale manifest and then removes the prior `formalization_evidence/` tree; pipeline progresses in ordered phases only; `PipelineAbortError` for unrecoverable failures |
| **Phase runner** ([`src/cli/phase-runner.ts`](src/cli/phase-runner.ts)) | Progress event decoration: exactly one `started` and one `completed`/`failed` event per phase | Generic decorator; no phase-specific knowledge |
| **Catalog** ([`src/domain/parser/catalog.ts`](src/domain/parser/catalog.ts)) | Resolve input set, classify documents, handle delta/final conflicts | Deterministic given the same inputs; at most one finalized + one delta spec per capability |
| **Structured parsers** ([`src/domain/parser/`](src/domain/parser/)) | Line-oriented parsing for proposal, design, spec, and task documents | Every input line is either classified or preserved as unparsed evidence |
| **Per-capability merge** ([`src/domain/parser/merge.ts`](src/domain/parser/merge.ts)) | Merge finalized and delta specs per capability; apply ADDED/MODIFIED/REMOVED semantics; emit merge findings | Output is deterministic; every skipped operation produces exactly one finding; no silent discard of base items |
| **Claim graph builder** ([`src/domain/claim-graph.ts`](src/domain/claim-graph.ts)) | Normalize parsed content into typed claims with provenance and obligation | No claim exists without provenance; extraction is deterministic |
| **Qualitative analysis** ([`src/domain/spec-forward/qualitative.ts`](src/domain/spec-forward/qualitative.ts)) | Package parsed content for LLM-backed review passes; validate response schemas | `opencode` responses are schema-validated before acceptance; exactly 2 passes on success |
| **Coverage analysis** ([`src/domain/spec-forward/coverage.ts`](src/domain/spec-forward/coverage.ts)) | Compare proposal/design claims against capability specs | Deterministic given the same claim graph; no LLM or solver dependency |
| **Formalization** ([`src/domain/formal/formalize.ts`](src/domain/formal/formalize.ts), [`formalization-findings.ts`](src/domain/formal/formalization-findings.ts), [`batch-evidence.ts`](src/domain/formal/batch-evidence.ts)) | Group eligible requirement and scenario claims by the shared semantic logical-file key; request LLM-backed samples; validate against logic IR schema; orchestration (`formalize.ts`) is split from pure finding/error builders and response matching (`formalization-findings.ts`) and from immutable attempt-evidence staging (`batch-evidence.ts`) | Formalization and solver grouping use the same key helper and map; candidate and claim-error indexes are disjoint and exhaust eligible indexes under handled completion; additional-sample failure preserves its candidate and emits only a warning; original eligible index, not `claim.id`, is authoritative identity |
| **Validation** ([`src/domain/formal/validate.ts`](src/domain/formal/validate.ts)) | Structural validation of untrusted LLM-produced formalization samples | Deterministic, side-effect free; validates variables, functions, sorts, and assertion syntax; rejects same-claim raw variable/function overlap and duplicate same-kind declarations by sanitized symbol |
| **Clustering** ([`src/domain/formal/clustering.ts`](src/domain/formal/clustering.ts)) | Solver-backed pairwise implication to group equivalent formalizations | Pair enumeration is deterministic; BFS-based connected components; ambiguity is a finding |
| **Identifier sanitization** ([`src/domain/formal/identifiers.ts`](src/domain/formal/identifiers.ts)) | Encode untrusted identifiers into injective SMT-LIB-safe symbols | Fixed-width-6 `_HHHHHH` escapes are uniquely decodable and preserve non-collision guarantees |
| **SMT-LIB compilation** ([`src/domain/formal/smtlib.ts`](src/domain/formal/smtlib.ts)) | Compile logic IR into solver-ready SMT-LIB text | Output never includes `(check-sat)` -- caller appends; merge exclusion authority is `compiled.claimIds` |
| **Logic analysis** ([`src/domain/formal/logic-analysis.ts`](src/domain/formal/logic-analysis.ts)) | Per-spec combined solver analysis with two-phase approach | Solver inputs and outputs persisted verbatim; default 30s timeout per query |
| **Source traceability** ([`src/domain/code-backwards/trace.ts`](src/domain/code-backwards/trace.ts)) | Scan source tree for canonical identifiers; relate to claim graph | Scanning confined to declared source directory; 1 MiB per-file limit |
| **Code-derived generation** ([`src/domain/code-backwards/derive.ts`](src/domain/code-backwards/derive.ts)) | EARS-preferring specs per capability from source evidence, blind to original text | Original requirement text never crosses the generation boundary |
| **Code-derived formalization** ([`src/domain/code-backwards/gen-formal.ts`](src/domain/code-backwards/gen-formal.ts)) | Same formalization pipeline applied to code-derived specs | Same schema validation and clustering as specs-forward; artifacts written to `gen_specs_smt/` |
| **Cross-side implication** ([`src/domain/code-backwards/cross-implication.ts`](src/domain/code-backwards/cross-implication.ts)) | Bidirectional solver-backed implication between original and code-derived formalizations | Primary strength classifier; greedy matching is deterministic; all queries persisted |
| **Blind comparison** ([`src/domain/code-backwards/blind-compare.ts`](src/domain/code-backwards/blind-compare.ts)) | Explanatory LLM rationale for formal classification | Code-derived side never receives original requirement text |
| **Report rendering** ([`src/domain/reporting/render.ts`](src/domain/reporting/render.ts)) | Render Markdown reports; replace malformed findings with `reporting.unsupported_verdict` defects | Reports never contain findings without provenance; untrusted evidence text neutralized into inert Markdown via `neutralizeMarkdownInline()` (`RAE-EVID-RENDER-SAFE`) |
| **Manifest** ([`src/domain/reporting/manifest.ts`](src/domain/reporting/manifest.ts)) | Build entries with SHA-256 checksums, including separate formalization attempt-set evidence files; write atomically; invalidate stale manifests as the first run-start cleanup step | Manifest is the final file written and the sole success marker; attempt evidence alone does not mark completion |
| **Filesystem adapter** ([`src/adapters/fs.ts`](src/adapters/fs.ts)) | Path confinement, atomic writes (temp + rename), SHA-256 checksums | All writes confined to configured output directory; `precondition` throws on traversal |
| **Process adapter** ([`src/adapters/process.ts`](src/adapters/process.ts)) | Generic `execFile` wrapper with argv arrays, timeout handling, stdin piping | No shell interpolation; `shell: false`; ENOENT on spawn rejects the promise |
| **`opencode` adapter** ([`src/adapters/opencode.ts`](src/adapters/opencode.ts)) | `opencode` subprocess with NDJSON event stream parsing, optional `--file` attachments, bounded retries | Bounded retries (default 3); invalid responses consume a retry; universal timeout comes from run config (default 300s) |
| **`z3` adapter** ([`src/adapters/z3.ts`](src/adapters/z3.ts)) | SMT-LIB piped via stdin, stdout/stderr capture, exit classification | Results classified as sat/unsat/timeout/unknown/error; error lines override any verdict; default 30s timeout |
| **Concurrency adapter** ([`src/adapters/concurrency.ts`](src/adapters/concurrency.ts)) | Bounded-concurrency parallel map with deterministic output ordering | `precondition(concurrency >= 1)`; first-error semantics; results preserve input order |

### 3.4 Design Principles

- Make important invariants explicit.
- Keep the core deterministic and push nondeterminism to the edges.
- Reject invalid input before crossing LLM, solver, or filesystem boundaries.
- Bound all waits and surface timeouts explicitly.
- Treat parser loss, unsupported references, and provenance gaps as surfaced defects rather than invisible degradation.
- Preserve evidence for every conclusion; no final verdict rests on an opaque unpreserved response.
- Keep packaging and traceability in the product contract.

---

## 4. Domain Model

### 4.1 Conceptual Entity-Relationship Diagram

```mermaid
erDiagram
    Document ||--o{ Claim : produces
    Document ||--o{ Finding : "structural findings"
    Capability ||--o{ Claim : groups
    Capability ||--|| MergedCapabilitySpec : "merged view"
    MergedCapabilitySpec ||--o{ Claim : "spec claims"
    MergedCapabilitySpec ||--o{ Finding : "merge findings"
    Claim ||--o{ FormalizationSample : "formalization"
    FormalizationAttemptSet ||--o{ BatchAttemptEvidence : contains
    FormalizationSample ||--o{ EquivalenceCluster : "clustering"
    EquivalenceCluster ||--|| SolverArtifact : "compiled"
    Claim ||--o{ Finding : "analysis findings"
    Finding ||--o{ Report : "rendered in"
    Report ||--|| Manifest : "recorded by"
    SourceCode ||--o{ CodeDerivedSpec : produces
    CodeDerivedSpec ||--o{ Claim : "code-derived claims"
    Claim }o--o{ CrossSideImplication : compared
```

### 4.2 Primary Domain Entities

| Entity | Meaning | Authority | Key Invariants |
|---|---|---|---|
| Document | A proposal, design, capability spec, or task file | input filesystem | read-only; never mutated by analysis; classified by basename |
| Capability | A logical behavior group represented by one spec file and its purpose | active catalog | resolved from finalized specs plus at most one in-development delta; lexicographically first delta wins on conflict |
| Merged Capability Spec | The active merged view of a capability after applying delta operations against the finalized base | merge phase | produced per capability; contains merged requirements, scenarios, findings, and provenance-preserving source file links |
| Requirement | A capability-level behavioral obligation in EARS format | parsed spec file | must carry a canonical bracketed identifier; classified into one of 8 EARS types |
| Scenario | A concrete, testable behavioral case that refines a requirement | parsed spec file | must carry a canonical bracketed identifier |
| Claim | A normalized statement derived from requirements, scenarios, properties, or code | claim graph builder | always carries provenance, obligation level, and capability; extraction from merged specs is deterministic |
| Finding | An analysis result with severity, rationale, provenance, and evidence | analysis phases | never exists without provenance; never silently removed; category is dot-separated hierarchical |
| Formalization Sample | One candidate formal encoding of a claim as logic IR | LLM-backed formalization | schema-validated before acceptance; variables, functions, sorts, and assertion syntax all checked |
| Formalization Attempt Set | Durable evidence envelope for one formalization invocation | formalization and reporting phases | `claimSet` is `specs_forward` or `generated_spec` with invocation-local ordinal/capability; attempt indexes are local to that claim set; stored as one separate atomic file |
| Equivalence Cluster | A group of mutually implying formalization samples | solver-backed clustering | BFS-based connected components; represents one interpretation of a claim |
| Solver Artifact | Generated SMT-LIB file, model, unsat core, timeout result, or error diagnostic | solver analysis | persisted verbatim under the output directory |
| Code-Derived Specification | EARS-preferring behavioral spec generated from source evidence, blind to original text | code-derived generation | persisted as Markdown in `gen_specs/` |
| Cross-Side Implication Result | Solver-backed classification (same, stronger, weaker, different, uncertain) | cross-side analysis | primary strength classifier; queries persisted verbatim |
| Report | Human-readable Markdown artifact summarizing one analysis pass | reporting phase | never contains findings without provenance; malformed findings replaced with defect markers |
| Manifest | Completion record listing all produced output files, including attempt-set evidence files, with SHA-256 checksums | reporting phase | written last; stale manifest removed before the prior formalization-evidence tree at run start; presence marks completed run; surviving evidence files alone do not |
| Traceability Identifier | Canonical bracketed identifier linking claims to tests and source evidence | spec files and test harness | `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+` format |

### 4.3 Conceptual Relationships

```text
Document ──────────────────────────────────────────┐
  (proposal, design, spec, task)                   │
       │                                           │
       v                                           │
  Structured Parser ──> Unparsed Lines (evidence)  │
       │                                           │
       v                                           │
  Per-Capability Merge                             │
  (finalized base + delta operations = merged view)│
       │                                           │
       v                                           │
     Claim ───────────────────────────────┐        │
  (requirement, scenario, property,       │        │
   assumption, invariant, failure mode)   │        │
       │                                  │        │
       ├──> Formalization Sample ─────────┤        │
       │        │                         │        │
       │        v                         │        │
       │   Equivalence Cluster            │        │
       │        │                         │        │
       │        v                         │        │
       │   Solver Artifact                │        │
       │        │                         │        │
       v        v                         v        │
     Finding <────────────────────────────┘        │
       │                                           │
       v                                           │
     Report <──────────────────────────────────────┘
       │
       v
    Manifest

Source Code ─────────────────────────────────────────────────┐
  (implementation, verified contracts, traced tests)         │
       │                                                     │
       v                                                     │
  Code-Derived Specification ─────────────────────────┐      │
  (EARS-preferring, per capability, blind to specs)   │      │
       │                                              │      │
       v                                              │      │
  Code-Derived Formalization ─────────────────────────┤      │
  (same pipeline: sampling, validation, clustering)   │      │
       │                                              │      │
       v                                              │      │
  Cross-Side Implication ─────────────────────────────┤      │
  (bidirectional solver checks: original vs derived)  │      │
       │                                              v      │
       v                                                     │
     Finding <───────────────────────────────────────────────┘
  (same, stronger, weaker, different, uncertain)
       │
       v
     Report
```

### 4.4 EARS Requirement Format

All spec.md files define verifiable behavior using EARS format and RFC 2119 keywords:

| Pattern | Template | When to use |
|---|---|---|
| Ubiquitous | `THE <system> SHALL <response>.` | Always active |
| State-driven | `WHILE <precondition>, THE <system> SHALL <response>.` | Active in a continuous state |
| Event-driven | `WHEN <trigger>, THE <system> SHALL <response>.` | Discrete event causes behavior |
| Unwanted-behavior | `IF <trigger>, THEN THE <system> SHALL <response>.` | Error/failure mitigation with Negation qualifier |
| Complex | `WHILE <precondition>, WHEN <trigger>, THE <system> SHALL <response>.` | Both state and event required |
| Optional | `WHERE <feature is included>, THE <system> SHALL <response>.` | Optional/configurable behavior |
| Conditional | `IF <condition>, THEN THE <system> SHALL <response>.` | Conditional without unwanted behavior / Negation qualifier |
| Non-EARS | Free-form with justification | When EARS is insufficient (> 3 preconditions, mathematical, tabular) |

RFC 2119: SHALL/MUST = absolute requirement (mandatory), SHOULD = recommended (advisory), MAY = optional (informational).

EARS classification priority in the parser: complex before event/state-driven; unwanted-behavior before conditional; optional before ubiquitous. This ordering prevents ambiguous matches.

Relevant code: [`src/domain/parser/spec.ts`](src/domain/parser/spec.ts)

### 4.5 Claim Kinds and Obligation Derivation

The claim graph builder extracts claims from parsed artifacts in a fixed order: proposal, then design, then specs, then tasks.

| Claim Kind | Source | Obligation Derivation |
|---|---|---|
| `requirement` | spec requirements | RFC 2119 keyword: SHALL → mandatory, SHOULD → advisory, MAY → informational |
| `scenario` | spec scenarios | always mandatory |
| `proposal_property` | proposal sections | mapped by section heading (e.g., Preconditions → mandatory, Context → informational) |
| `design_property` | design sections | informational |
| `assumption` | proposal sections | informational |
| `invariant` | proposal sections | mandatory |
| `failure_mode` | proposal sections | advisory |
| `task_evidence` | completed task items only | informational |

Relevant code: [`src/domain/claim-graph.ts`](src/domain/claim-graph.ts)

### 4.6 Branded Types and Encoding Constraints

The domain uses compile-time branded types to prevent accidental interchange of semantically distinct values that share the same runtime representation:

| Type | Brand | Validation Rule | Construction |
|---|---|---|---|
| `OutputDirPath` | `"OutputDirPath"` | Absolute directory path | `toOutputDirPath()` |
| `RelativePath` | `"RelativePath"` | No `/` prefix, no `..` traversal | `toRelativePath()` |
| `SmtlibFilePath` | `"SmtlibFilePath"` | Relative path with `.smt2` extension | `toSmtlibFilePath()` |
| `ClaimId` | `"ClaimId"` | `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+` | `toClaimId()` |
| `CapabilityName` | `"CapabilityName"` | Lowercase kebab-case, non-empty | `toCapabilityName()` |
| `SanitizedClaimId` | `"SanitizedClaimId"` | `^[A-Za-z_][A-Za-z0-9_]*$` (SMT-LIB safe) | `sanitizeIdentifier()` |
| `ModelName` | `"ModelName"` | Non-empty string | `toModelName()` |
| `SmtlibContent` | `"SmtlibContent"` | SMT-LIB formula text (not a path) | `toSmtlibContent()` |

Branded values are constructed only through validated construction functions at trust boundaries. Interior code passes branded values through without casting. The `as` casts are confined to `to*()` factory functions.

**Encoding:** Input artifacts are read as UTF-8 text with line ending normalization to LF. Logic artifacts are emitted as ASCII-safe SMT-LIB files with injective fixed-width-6 sanitized identifiers (implemented in `identifiers.ts`) and reversible mapping comments. The manifest is UTF-8 JSON.

Relevant code: [`src/domain/branded.ts`](src/domain/branded.ts)

### 4.7 Evidence Model

Every durable conclusion is evidence-backed. Evidence may include:

- original source snippets and headings with `LineProvenance` (file + 1-based line number)
- parser-preserved unmatched lines
- raw `opencode` responses (both valid and invalid)
- validated logic IR samples
- compiled SMT-LIB text
- solver stdout/stderr, models, unsat cores, and timeouts
- source trace links with evidence level classification (primary, secondary, supporting)
- cross-side implication queries and results
- blind comparison rationale
- invocation-scoped `FormalizationAttemptSet` files with local claim indexes and exact attached-context hashes

The evidence contract is stronger than "explainability"; it is preservation. Every finding carries mandatory `evidence` alongside `provenance`, `rationale`, `severity`, `category`, and `description`.

Relevant code: [`src/domain/findings.ts`](src/domain/findings.ts)

### 4.8 Data Invariants

| ID | Invariant | Enforced By | Failure Mode |
|----|-----------|-------------|--------------|
| **D-1** | Every claim has provenance linking it to a source file and heading | Claim graph builder; `detectOrphanClaims()` | Orphan finding emitted |
| **D-2** | Claims carry obligation level (mandatory, advisory, informational) | EARS keyword extraction + section-heading mapping | Derived from SHALL/SHOULD/MAY or section policy |
| **D-3** | Canonical identifiers follow `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+` format | `parseCanonicalIdentifier()` in shared parser | Structural finding |
| **D-4** | Findings include severity, category, provenance, description, rationale, and evidence | Finding shape definition; report rendering validation | Malformed findings replaced with `reporting.unsupported_verdict` defects |
| **D-5** | Findings are never silently removed by later phases | `addFindings()` postcondition in `RunState` | Monotonic accumulation; length postcondition check |
| **D-6** | SMT-LIB identifiers use injective fixed-width-6 sanitization and satisfy `^[A-Za-z_][A-Za-z0-9_]*$` | `sanitizeIdentifier()` in `identifiers.ts` | Distinct raw identifiers cannot alias to one solver symbol |
| **D-7** | Parser output is deterministic given the same input content | Module-level invariant; no I/O-dependent state | Property tests |
| **D-8** | The manifest is the last file written; at the next run start the stale manifest is invalidated before the prior `formalization_evidence/` tree is removed and before any new pipeline work | `runCli()` output preparation; `invalidateStaleManifest()`; `removeOutputTree()`; `writeManifest()` at run end | Manifest absence signals incomplete run; cleanup failure aborts before new analysis evidence is produced |
| **D-9** | Compiled SMT-LIB never includes `(check-sat)` | `compileSmtlib()` and `compileSpecSmtlib()` | Caller appends solver commands at query time |
| **D-10** | Claim extraction order is deterministic: proposal → design → specs → tasks | `buildClaimGraph()` iteration order | Property tests |
| **D-11** | Per-capability merge output is deterministic given the same parsed inputs | `mergeSpecsByCapability()` module-level invariant | Property and determinism tests |
| **D-12** | Merged active view preserves every base requirement unless a matching REMOVED operation or duplicate-base exclusion finding exists | Merge layer postcondition | Contract and property tests |
| **D-13** | Every skipped merge operation produces exactly one finding; no silent discard | Merge finding completeness invariant | Property tests |
| **D-14** | `compiled.claimIds` is the authoritative surviving-claim set for downstream checks | `compileSpecSmtlib()` + logic-analysis inclusion filtering | Conflict evidence cannot disagree with emitted inclusion set |
| **D-15** | Compile groups that are structurally invalid — duplicate raw/sanitized claim IDs, or size beyond `CLAIMS_PER_GROUP_MAX` / `DECLARATIONS_PER_CLAIM_MAX` — are rejected before compile, artifact write, or solver work | `preflightGroupBounds()` composed bounds-first with `preflightGroupClaimIds()` in logic analysis | Invalid compile groups emit a group-scoped `logic.invalid_group` finding and perform zero solver work; oversized groups degrade gracefully instead of aborting the run, and `compileSpecSmtlib()` size `precondition` guards remain as unreachable backstops |
| **D-16** | Every eligible requirement or scenario claim has one deterministic semantic key: mapped merged `logicalFile` for a capability, `<merged-spec/{capability}>` when unmapped, or verbatim `provenance.file` when capability-less | `selectClaimLogicalFile()` and the shared `logicalFileByCapability` map | Formalization and solver grouping cannot drift; historical file grouping is not a separate mode |
| **D-17** | Original zero-based eligible index or claim object identity is authoritative through grouping, physical sub-batching, response matching, and additional sampling; `claim.id` is informational only | Indexed formalization work items and explicit attached response `index` validation | Missing or duplicate claim IDs cannot merge samples into the wrong candidate |
| **D-18** | Physical sub-batches preserve semantic key and eligible order; context JSON serialization is byte-deterministic and does not mutate claim provenance | Pure stable slicing; schema-v1 serializer with fixed field order, UTF-8, LF, and one trailing newline | Context SHA-256 and claim-set-scoped pointer evidence can reconstruct deleted attached context bytes |
| **D-19** | At handled formalization completion, candidate indexes `C` and claim-error indexes `R` exactly and disjointly partition eligible indexes `E`: `C ∩ R = ∅` and `C ∪ R = E` | Indexed outcome assembly and postcondition checks | Additional-sample failure preserves an existing candidate, emits a warning, and never creates a claim error for that failure |
| **D-20** | Each formalization invocation owns one `FormalizationAttemptSet`; its indexes resolve only within its `claimSet` (`specs_forward` or generated-spec ordinal/capability) | Invocation envelope construction and claim-set-scoped reconstruction | Index collisions between invocations cannot reconstruct the wrong context |
| **D-21** | Separate atomically finalized attempt-set files may survive a failed or terminated current run and do not imply completion; they survive only until the next run removes the entire prior `formalization_evidence/` tree; the successful manifest is written last and lists/checksums all current-run files | Run-start output preparation, reporting persistence, and manifest construction | Partial evidence remains auditable between runs without impersonating a successful run or contaminating the next run |

**Spec references:** [`catalog-and-parse`](openspec/specs/catalog-and-parse/spec.md) -- `[CAT-PARSE-DETERMINISM]`, `[CAT-PRESERVE-LOSS]`; [`claim-graph-and-coverage`](openspec/specs/claim-graph-and-coverage/spec.md); [`reporting-and-evidence`](openspec/specs/reporting-and-evidence/spec.md) -- `[RAE-FINDING-SHAPE]`, `[RAE-FINDINGS-IMMUTABLE]`, `[RAE-ATOMIC-MANIFEST]`.

---

## 5. Preconditions, Postconditions, and Invariants

### 5.1 System-Wide Invariants

| ID | Invariant | How Maintained |
|----|-----------|----------------|
| **I-1** | Input specs, task files, and source files are never mutated | Read-only access throughout all phases |
| **I-2** | No final verdict relies on a single opaque LLM response without preserved evidence | Schema validation at boundaries; full response preservation |
| **I-3** | Every LLM response used by the system is schema-validated before it influences downstream phases | Adapter-level validation with bounded retries; `validateFormalizationSample()` for logic IR |
| **I-4** | Solver inputs and outputs are persisted verbatim | Adapter-level persistence via `writeOutputAtomic()` |
| **I-5** | Findings are never silently erased by later phases | `addFindings()` in `RunState` with monotonic length postcondition |
| **I-6** | Re-running with identical inputs and fixed/cached LLM responses produces identical outputs | Deterministic core between nondeterministic boundaries; deterministic extraction order |
| **I-7** | All writes remain confined to the configured output directory | `resolveConfinedOutputPath()` with `precondition` assertion in filesystem adapter |
| **I-8** | No shell interpolation in subprocess calls | `shell: false` in `process.ts`; argv-based `execFile`, never `exec` |
| **I-9** | Prompt construction keeps analyzed content in data position; attached batch JSON and every claim-text field are untrusted data, never instructions, and attached claim bodies do not appear in the prompt body | `sanitizeForCodeFence()` for inline content; dedicated attached-context prompt and file transport for multi-claim formalization |
| **I-10** | The resolved run configuration is immutable once analysis begins | CLI layer freezes `RunConfig` before pipeline starts |

### 5.2 Per-Phase Contracts

| Phase | Preconditions | Postconditions | Error Outcomes |
|-------|---------------|----------------|----------------|
| CLI validation | Process can read argv | Valid args produce resolved `RunConfig`; invalid args exit with code `2` | `ArgumentError`, `ConfigError` |
| Dependency check | Resolved config available | `opencode` and `z3` confirmed on PATH | `DependencyError` |
| Catalog | At least one input path resolves to readable artifacts | Catalog identifies every document and its classification; archived specs excluded; delta conflicts surfaced as findings | `CatalogError` |
| Structured parsing | Cataloged documents are readable UTF-8 | Each document produces a typed model; all lines classified or preserved as unparsed evidence | Structural findings with provenance |
| Per-capability merge | Parsed specs available; catalog identifies finalized and delta documents per capability | Merged capability specs produced with deterministic output; merge findings emitted for skipped operations and structural issues; no capability has more than one delta | `PipelineAbortError` on sanitized artifact-key collisions or internal merge exceptions |
| Claim graph | At least one document parsed with recognizable structure | Every recognized element normalized into a typed claim with provenance | Orphaned claims surfaced as defects |
| Qualitative analysis | Claim graph has at least one claim; `opencode` available | Schema-validated findings from exactly 2 LLM passes with severity, rationale, provenance, and evidence | `QualitativeError` after bounded retries |
| Coverage analysis | Claims from proposal/design and at least one spec | Missing coverage, contradictions, unsupported references, and task inconsistencies reported | Deterministic; no external dependencies |
| Formalization | Eligible claims (requirements and scenarios) exist; `opencode` available | Candidate and claim-error indexes form an exact disjoint partition under handled outcomes; additional-sample failure is warning-only; attached attempts preserve invocation-scoped reconstructable evidence | `FormalizationError` only when no candidate exists for the affected claim after bounded first-sample/degradation work or handled transport failure |
| Clustering | Formalization samples exist; `z3` available | Equivalence clusters with representative selection; ambiguity surfaced as findings | `AdapterError` on solver failure |
| Logic analysis | Representative formalizations exist; `z3` available | Obligation-aware contradiction, completeness, and gap detection; evidence persisted verbatim | `AdapterError` on solver failure |
| Source traceability | `--src` provided and readable | Each claim traced to source evidence or gap finding emitted; evidence levels classified | `CatalogError` on unreadable source |
| Code-derived generation | Source evidence available per capability | EARS-preferring specs generated blind to original text; written to `gen_specs/` | `AdapterError` on LLM failure |
| Code-derived formalization | Generated specs available | Formalized claims with SMT-LIB artifacts written to `gen_specs_smt/` | `FormalizationError`, `AdapterError` |
| Code-derived logic analysis | Code-derived formalizations available; `z3` available | Internal consistency check of code-derived formalizations | `AdapterError` on solver failure |
| Cross-side implication | Both original and code-derived formalizations available; `z3` available | Bidirectional solver-backed classification per matched pair; greedy matching with deterministic tiebreaking | `AdapterError` on solver failure |
| Blind comparison | Cross-side results available; `opencode` available | Explanatory rationale for each classification; blind boundary preserved | `AdapterError` on LLM failure |
| Reporting | At least one phase completed | Phase reports and separate attempt-set evidence files atomically finalized; successful manifest written last with their paths/checksums | `OutputError` on write failure; finalized evidence may remain without a manifest and does not imply completion |

### 5.3 Global Preconditions

- At least one input specification artifact exists and is readable.
- The analyzed project follows the `srs-driven` artifact conventions closely enough to admit structured parsing.
- Required local dependencies for the selected analysis mode are available: `opencode` for LLM-backed phases and `z3` for solver-backed phases.
- When `--src` is used, the source directory is readable, within the intended project scope, and not a parent of the output directory.

### 5.4 Global Postconditions

- The tool produces a bounded, evidence-preserving set of reports and intermediate artifacts under the output directory.
- Every surfaced finding includes provenance and enough supporting evidence for a reviewer to inspect the basis of the conclusion.
- When analysis completes successfully, a manifest is written last and identifies the produced artifacts with SHA-256 checksums.
- When source-backed analysis is requested, the output includes traceability or comparison results that explain the relationship between spec intent and code-derived guarantees.
- Successful runs exit with code `0` (no findings) or `1` (findings present).
- Skipped optional phases are explained in reporting.
- Manifest presence indicates a complete run; manifest absence indicates incomplete output.
- Atomic formalization attempt-evidence files may remain after failure or process termination until the next run starts; they are partial-run audit evidence, not completion markers. The next run invalidates any stale manifest first and then removes the entire prior `formalization_evidence/` tree before other pipeline work.

**Spec references:** [`catalog-and-parse`](openspec/specs/catalog-and-parse/spec.md), [`claim-graph-and-coverage`](openspec/specs/claim-graph-and-coverage/spec.md), [`formalization-and-logic-analysis`](openspec/specs/formalization-and-logic-analysis/spec.md), [`reporting-and-evidence`](openspec/specs/reporting-and-evidence/spec.md).

---

## 6. State Machines

State machines are implemented using discriminated unions with exhaustive switch statements and `assertNever` guards.

### 6.1 Top-Level Run Lifecycle

Relevant code: [`src/index.ts`](src/index.ts), [`src/cli/run-cli.ts`](src/cli/run-cli.ts)

```mermaid
stateDiagram-v2
    [*] --> ParseInvocation
    ParseInvocation --> PrintHelp: --help
    ParseInvocation --> PrintVersion: --version
    ParseInvocation --> ResolveConfig: analysis run
    ParseInvocation --> FatalExit: invalid argv
    ResolveConfig --> InvalidateStaleManifest: config valid
    ResolveConfig --> FatalExit: invalid config
    InvalidateStaleManifest --> RemovePriorFormalizationEvidence: manifest absent
    InvalidateStaleManifest --> FatalExit: invalidation failure
    RemovePriorFormalizationEvidence --> ValidateInputs: prior evidence tree absent
    RemovePriorFormalizationEvidence --> FatalExit: removal failure
    ValidateInputs --> RunIngestion: inputs valid
    ValidateInputs --> FatalExit: unreadable path or missing dependency
    RunIngestion --> RunAnalysis: ingestion succeeded
    RunIngestion --> FatalExit: catalog or parse failure
    RunAnalysis --> RunSourceBacked: --src enabled
    RunAnalysis --> RunReporting: no --src
    RunSourceBacked --> RunReporting
    RunReporting --> WriteManifest: all outputs finalized
    WriteManifest --> SuccessExit: no findings
    WriteManifest --> FindingsExit: findings present
    FatalExit --> [*]
    PrintHelp --> [*]
    PrintVersion --> [*]
    SuccessExit --> [*]
    FindingsExit --> [*]
```

#### Decision Table

| Invocation Shape | Action | Side Effects |
|---|---|---|
| `--help` | print help text to stdout | none; exit `0` |
| `--version` | print version to stdout | none; exit `0` |
| valid inputs | run full analysis pipeline | output directory populated |
| invalid argv | report error to stderr | exit `2` |
| invalid config | report error to stderr | exit `3` |
| missing dependency | report error to stderr | exit `4` |
| prior run output exists | invalidate `manifest.json`, then recursively remove `formalization_evidence/` | begin with no prior completion marker or formalization attempt evidence |
| run-start output cleanup fails | abort before dependency, ingestion, LLM, solver, or new evidence work | no new run output is trusted as complete |

#### Invariants

| ID | Invariant |
|---|---|
| TL-1 | Help and version do not run analysis or contact external tools |
| TL-2 | Invalid arguments produce exit code `2` before any output is written |
| TL-3 | CLI flags take precedence over config file values |
| TL-4 | `PipelineAbortError` carries `ErrorCategory` for exit code mapping |
| TL-5 | Run-start output cleanup is ordered: invalidate stale `manifest.json`, remove the prior `formalization_evidence/` tree, then begin pipeline work |
| TL-6 | Attempt evidence from a failed or terminated current run may remain for audit only until the next run starts; it never coexists with a successful current-run manifest unless that manifest lists and checksums it |

#### Safety and Liveness

- Safety: informational commands never cross LLM, solver, or filesystem boundaries.
- Liveness: informational commands terminate immediately on local process success paths.

**Spec reference:** [`catalog-and-parse`](openspec/specs/catalog-and-parse/spec.md) -- `[CAT-CLI-ARGS]`, `[CAT-CLI-CONFIG]`.

### 6.2 Ingestion Pipeline

Relevant code: [`src/cli/run-cli.ts`](src/cli/run-cli.ts) (`runIngestionPhases`), [`src/domain/parser/`](src/domain/parser/)

```mermaid
stateDiagram-v2
    [*] --> CheckDependencies
    CheckDependencies --> FatalExit: opencode or z3 missing
    CheckDependencies --> BuildCatalog: dependencies available
    BuildCatalog --> FatalExit: unreadable input
    BuildCatalog --> ParseDocuments: catalog valid
    ParseDocuments --> MergePerCapability: all documents parsed
    MergePerCapability --> FatalExit: artifact-key collision or internal error
    MergePerCapability --> IngestionComplete: merge succeeded
    IngestionComplete --> [*]
    FatalExit --> [*]
```

#### Decision Table

| Condition | Action | Outcome |
|---|---|---|
| `opencode` not on PATH | `DependencyError` | exit `4` |
| `z3` not on PATH | `DependencyError` | exit `4` |
| input path unreadable | `CatalogError` | exit `5` |
| multiple deltas for same capability | surface finding; keep lexicographically first | catalog with conflict findings |
| document parsed successfully | typed model + structural findings | proceed to merge |
| merge produces sanitized artifact-key collision | `PipelineAbortError` | exit with error |
| merge completes with findings | merged capability specs + merge findings | proceed to claim graph |

#### Invariants

| ID | Invariant |
|---|---|
| ING-1 | Dependency check runs before any external tool invocation |
| ING-2 | Catalog is deterministic given the same input paths and filesystem state |
| ING-3 | Delta conflict resolution is deterministic: lexicographically first delta wins |
| ING-4 | Every input line is either classified into a typed model or preserved as unparsed evidence |
| ING-5 | Per-capability merge is deterministic and produces exactly one finding per skipped operation |
| ING-6 | No capability receives more than one delta spec (runtime precondition assertion) |

### 6.3 Specs-Forward Analysis Pipeline

Relevant code: [`src/cli/run-cli.ts`](src/cli/run-cli.ts) (`runAnalysisPhases`), [`src/cli/pipeline-helpers.ts`](src/cli/pipeline-helpers.ts)

```mermaid
stateDiagram-v2
    [*] --> BuildClaimGraph
    note right of BuildClaimGraph: consumes merged capability specs
    BuildClaimGraph --> RunQualitative: claims available
    RunQualitative --> RunCoverage: qualitative complete
    RunQualitative --> FatalExit: zero valid responses after retries
    RunCoverage --> RunFormalization: coverage complete
    RunFormalization --> RunClustering: candidates available
    RunFormalization --> FatalExit: zero valid candidates phase-wide
    RunClustering --> RunLogicAnalysis: representatives selected
    RunLogicAnalysis --> AnalysisComplete
    AnalysisComplete --> [*]
    FatalExit --> [*]
```

#### Decision Table

| Phase | Success Condition | Failure Condition | Failure Contract |
|---|---|---|---|
| claim graph | at least one claim extracted | no recognizable structure | findings emitted |
| qualitative pass 1 | schema-valid LLM response | exhausted retries | `QualitativeError` |
| qualitative pass 2 | schema-valid LLM response | exhausted retries | `QualitativeError` |
| coverage | always succeeds (deterministic) | -- | -- |
| formalization | candidate and claim-error indexes exactly and disjointly partition eligible indexes, with at least one candidate phase-wide; additional-sample failures are warnings only | zero candidates phase-wide after semantic batching and bounded first-sample/degradation work | `FormalizationError` |
| clustering | representative selected from largest stable cluster | stability threshold not met | ambiguity finding emitted |
| logic: group preflight | claims have unique raw + sanitized IDs and fit size bounds | duplicate IDs, or size beyond `CLAIMS_PER_GROUP_MAX` / `DECLARATIONS_PER_CLAIM_MAX` | `logic.invalid_group`; zero compile/solver/write work (D-15) |
| logic: spec-combine | claim declarations are mutually compatible | variable-sort, symbol-kind, or function-signature conflict | `logic.merge_conflict`; conflicting claim excluded, survivors are `compiled.claimIds` (D-14) |
| logic: global check-sat | `sat` — globally consistent | `unsat`, solver error, or `timeout`/`unknown` | `logic.contradiction`, `logic.solver_error`, or `logic.inconclusive` |
| logic: deeper checks | pairwise and completeness sub-checks definitive | contradiction, gap, or inconclusive sub-check | `logic.conditional_contradiction`, `logic.completeness_gap`, aggregated `logic.inconclusive` |

#### Invariants

| ID | Invariant |
|---|---|
| SF-1 | Qualitative passes execute sequentially; pass 2 starts only after pass 1 succeeds |
| SF-2 | Coverage analysis is purely deterministic; no LLM or solver dependency |
| SF-3 | Formalization groups requirements and scenarios only by the shared semantic logical-file key, stably slices each logical group into physical first-sample batches, uses attached JSON for multi-claim batches and inline transport for single claims, degrades eligible terminal model-response failures to bounded per-claim inline calls, and performs additional sampling per eligible index; additional-sample failure preserves the candidate and emits a warning, never a claim error |
| SF-9 | At handled completion candidate indexes `C` and claim-error indexes `R` satisfy `C ∩ R = ∅` and `C ∪ R = E`, where `E` is the eligible-index set |
| SF-10 | Each formalization invocation emits one `FormalizationAttemptSet` whose local indexes are scoped to `specs_forward` or to a generated-spec ordinal/capability; separate atomic evidence files do not imply completion |
| SF-4 | Clustering pair enumeration is deterministic (left < right) |
| SF-5 | Logic analysis two-phase approach: satisfiability first, unsat-core extraction only on contradiction |
| SF-6 | Deeper pairwise guard-activation and completeness sub-checks aggregate `timeout`/`unknown` verdicts into a single `logic.inconclusive` finding, consistent with the query-level inconclusive flow |
| SF-7 | Structurally invalid compile groups (duplicate raw or sanitized claim IDs, or size beyond `CLAIMS_PER_GROUP_MAX` / `DECLARATIONS_PER_CLAIM_MAX`) are rejected before any compile, artifact write, or solver query — zero solver work (D-15) |
| SF-8 | Merge conflicts exclude the conflicting claim rather than aborting the group; the authoritative surviving-claim set for all downstream checks is `compiled.claimIds` (D-14) |

#### Safety and Liveness

- Safety: no invalid formalization sample enters clustering or solver analysis.
- Safety: formalization and solver analysis derive grouping keys with the same helper and shared map, so a merged capability spanning provenance files remains one semantic group in both phases.
- Safety: attached claim text remains untrusted data, and explicit eligible indexes prevent missing or duplicate claim IDs from misattributing responses or additional samples.
- Safety: temp context cleanup is attempted for handled terminal paths that reach lifecycle finalization; cleanup failure after success is reported without discarding candidates. Process termination has no cleanup guarantee and may leave artifacts with no manifest.
- Safety: candidate and claim-error indexes are disjoint and exhaustive; additional-sample failure cannot turn an existing candidate into a claim error.
- Safety: attempt-set evidence files can survive failure but cannot signal completion without the last-written manifest.
- Safety: inconclusive solver results are preserved as findings, not treated as success.
- Safety: structurally invalid or oversized compile groups perform zero solver work; they degrade to a `logic.invalid_group` finding instead of aborting the run.
- Safety: spec-combine merge conflicts surface `logic.merge_conflict` findings while surviving claims continue to analysis; no conflicting declaration silently overwrites another (first-wins).
- Liveness: each LLM call is bounded by retry count (default 3) and universal per-call timeout from run config (default 300s).
- Liveness: formalization concurrency is bounded — worst-case in-flight adapter calls are `concurrency × INLINE_FALLBACK_CONCURRENCY (2)` on the degradation path, because fallback workers execute inside slots of the outer `mapBounded(batches, concurrency)` pool, and `concurrency` otherwise; the bound is a fixed multiple of the configured concurrency and never scales with batch size.
- Liveness: stable physical sub-batching terminates for every valid `maxBatchSize`, and every eligible claim reaches exactly one candidate-or-error partition member under handled adapter outcomes.
- Liveness: each solver query is bounded by per-query timeout (default 30s).
- Liveness: deeper-check solver fan-out is bounded — pairwise checks cap at `PAIRWISE_SOLVER_CONCURRENCY` (3) plus one completeness query (per-group peak 4; global peak `concurrency × 4`).

**Spec references:** [`formalization-and-logic-analysis`](openspec/specs/formalization-and-logic-analysis/spec.md), [`claim-graph-and-coverage`](openspec/specs/claim-graph-and-coverage/spec.md).

### 6.4 Source-Backed Analysis Pipeline

Relevant code: [`src/cli/run-cli.ts`](src/cli/run-cli.ts) (`runSourcePhases`), [`src/domain/code-backwards/`](src/domain/code-backwards/)

```mermaid
stateDiagram-v2
    [*] --> TraceClaimsToSource
    TraceClaimsToSource --> GenerateDerivedSpecs: traces available
    TraceClaimsToSource --> FatalExit: unreadable source
    GenerateDerivedSpecs --> FormalizeDerivedSpecs: specs generated
    FormalizeDerivedSpecs --> AnalyzeDerivedLogic: formalizations available
    AnalyzeDerivedLogic --> RunCrossSideImplication: logic analysis complete
    RunCrossSideImplication --> RunBlindComparison: classifications available
    RunBlindComparison --> SourceAnalysisComplete
    SourceAnalysisComplete --> [*]
    FatalExit --> [*]
```

#### Decision Table

| Phase | Success Condition | Failure Condition | Failure Contract |
|---|---|---|---|
| source traceability | source directory scanned | unreadable source directory | `CatalogError` |
| code-derived generation | at least one capability generates specs | LLM failure for all capabilities | error findings emitted |
| code-derived formalization | at least one claim formalized | all formalizations fail | error findings emitted |
| code-derived logic analysis | solver returns results | solver failures | findings preserved |
| aggregate implication | 2 Z3 calls per matched capability | solver failures | `uncertain` classification |
| pairwise implication | N*M within pair budget | budget exceeded | skip pairwise, keep aggregate |
| blind comparison | LLM provides rationale | LLM failure | error findings emitted |

#### Invariants

| ID | Invariant |
|---|---|
| SB-1 | Source scanning is confined to the declared `--src` directory |
| SB-2 | Per-file size limit of 1 MiB prevents unbounded memory consumption |
| SB-3 | Original requirement text never crosses into code-derived generation or blind comparison input |
| SB-4 | Cross-side implication operates on formal artifacts only, not mixed claim text |
| SB-5 | Greedy matching for pairwise results is deterministic: sorted by classification score, then lexicographic claim ID |
| SB-6 | Partial results are preserved: one capability's failure does not affect others |

#### Safety and Liveness

- Safety: the blind boundary is structurally enforced; original spec text never reaches the code-derived side.
- Safety: cross-side implication queries are persisted verbatim for audit.
- Liveness: source-backed analysis proceeds capability-by-capability even when individual generated claims are ambiguous or partially unsupported.
- Liveness: pairwise comparison is bounded by `--pair-budget` (default 200).

**Spec reference:** [`source-traceability-and-code-backwards`](openspec/specs/source-traceability-and-code-backwards/spec.md) -- `[STC-GEN-SPECS]`, `[STC-CROSS-IMPLY]`, `[STC-BLIND-COMPARE]`.

### 6.5 Reporting and Manifest Lifecycle

Relevant code: [`src/cli/run-cli.ts`](src/cli/run-cli.ts), [`src/adapters/fs.ts`](src/adapters/fs.ts), [`src/domain/reporting/render.ts`](src/domain/reporting/render.ts), [`src/domain/reporting/manifest.ts`](src/domain/reporting/manifest.ts)

```mermaid
stateDiagram-v2
    [*] --> InvalidateStaleManifest
    InvalidateStaleManifest --> RemovePriorFormalizationEvidence
    RemovePriorFormalizationEvidence --> RunPipeline
    RunPipeline --> RenderPhaseReports
    RenderPhaseReports --> RenderSummary: per-phase reports written
    RenderPhaseReports --> FatalExit: write failure
    RenderSummary --> WriteArtifacts: summary rendered
    WriteArtifacts --> ComputeChecksums
    ComputeChecksums --> WriteManifest
    WriteManifest --> Complete: manifest written last
    WriteManifest --> FatalExit: manifest write failure
    Complete --> [*]
    FatalExit --> [*]
```

#### Decision Table

| Condition | Action | Outcome |
|---|---|---|
| stale manifest exists from prior run | remove before new output | clean slate |
| no stale manifest | no-op | proceed |
| prior `formalization_evidence/` tree exists | remove recursively after manifest invalidation and before pipeline work | prior successful or failed-run attempt evidence cannot contaminate the new run |
| run-start cleanup fails | abort before pipeline work | no current-run attempt evidence or reports are produced |
| finding has valid shape | render normally | included in report |
| finding has malformed shape | replace with `reporting.unsupported_verdict` defect | defect visible in report |
| all phase reports written | compute SHA-256 checksums | manifest entries ready |
| formalization attempt sets available | atomically finalize one evidence file per invocation | files may exist before completion and are included in checksum input |
| all checksums computed | write `manifest.json` atomically | run marked complete |

#### Invariants

| ID | Invariant |
|---|---|
| RP-1 | Run start first removes stale `manifest.json`, then removes the entire prior `formalization_evidence/` tree, before any other pipeline work or new output |
| RP-2 | Manifest is the final file written in the output directory |
| RP-3 | Report writes are atomic (temp + rename) |
| RP-4 | Manifest checksums match the content written to disk |
| RP-5 | Malformed findings are never silently dropped; they are replaced with defect markers |
| RP-6 | Every successful manifest lists/checksums each separate current-run `FormalizationAttemptSet` evidence file; evidence files without a manifest do not mark completion and survive a failed or terminated run only until the next run-start cleanup |

#### Safety and Liveness

- Safety: no partial run leaves a valid final manifest.
- Safety: manifest checksums enable post-run integrity verification.
- Liveness: reporting completes once all upstream phase results are available and writes succeed.

**Spec reference:** [`reporting-and-evidence`](openspec/specs/reporting-and-evidence/spec.md) -- `[RAE-ATOMIC-MANIFEST]`, `[RAE-OUTPUT-ATOMIC]`.

### 6.6 Adapter Layer

Relevant code: [`src/adapters/`](src/adapters/)

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> ResolvingPath: fs request
    Idle --> SpawningProcess: external tool request
    ResolvingPath --> ReadingOrWriting: path validated
    ResolvingPath --> AdapterFailure: path traversal or unsafe path
    ReadingOrWriting --> Idle: operation complete
    ReadingOrWriting --> AdapterFailure: I/O failure
    SpawningProcess --> WaitingForResult: argv launched
    SpawningProcess --> AdapterFailure: spawn failure (ENOENT)
    WaitingForResult --> ValidatingResponse: process exit received
    WaitingForResult --> AdapterFailure: timeout exceeded
    ValidatingResponse --> RetryOrAccept: response shape checked
    RetryOrAccept --> Idle: response accepted
    RetryOrAccept --> SpawningProcess: retry eligible
    RetryOrAccept --> AdapterFailure: retries exhausted or schema invalid
    AdapterFailure --> [*]
```

#### Decision Table -- `opencode` Adapter

| Condition | Action | Outcome |
|---|---|---|
| process exits with valid NDJSON events containing `type: "text"` | concatenate text fragments, parse as JSON | `ok` result if schema-valid |
| `type: "error"` event detected | treat as failure | consume a retry |
| JSON parse failure on concatenated text | `invalid_json` error | consume a retry |
| schema validation failure | `schema_validation_error` | consume a retry |
| retries exhausted | return last error | `err` result |
| timeout exceeded | kill process | `timeout` error |

#### Decision Table -- `z3` Adapter

| Condition | Action | Outcome |
|---|---|---|
| stdout contains `(error ...)` lines | classify as `error` | error overrides any verdict |
| stdout contains exact `sat` | classify as `sat` | consistent |
| stdout contains exact `unsat` | classify as `unsat` | contradictory |
| stdout contains exact `unknown` | classify as `unknown` | inconclusive |
| no recognizable verdict | classify as `error` | malformed output |
| timeout exceeded | kill process | `timeout` result |

#### Invariants

| ID | Invariant |
|---|---|
| AD-1 | All subprocess calls use argv arrays via `execFile` with `shell: false` |
| AD-2 | `opencode` retries are bounded (default 3); each invalid response consumes one retry |
| AD-3 | `z3` error-line detection overrides any subsequent verdict (errors make verdicts unreliable) |
| AD-4 | Path confinement in the filesystem adapter uses `precondition()` assertion |
| AD-5 | Atomic writes use temp file + rename; cleanup on rename failure |
| AD-6 | `z3` adapter never rejects; all failures resolve with a classified `Z3Result` |

---

## 7. Interaction Protocols

### 7.1 Pipeline Orchestration Flow

Relevant code: [`src/cli/run-cli.ts`](src/cli/run-cli.ts), [`src/cli/phase-runner.ts`](src/cli/phase-runner.ts)

The pipeline is decomposed into `runIngestionPhases`, `runAnalysisPhases`, `runSourcePhases`, and `runReportingPhase` for phase-group isolation. `PipelineAbortError` is used for typed error propagation between phase groups.

```mermaid
sequenceDiagram
    participant U as User
    participant I as index.ts
    participant C as run-cli.ts
    participant Cat as Catalog
    participant P as Parser
    participant MG as Merge
    participant CG as Claim Graph
    participant A as Analysis Phases
    participant S as Source Phases
    participant R as Reporting
    participant M as Manifest

    U->>I: argv
    I->>I: parseArgv + resolveRunConfig
    alt --help or --version
        I-->>U: stdout + exit 0
    else invalid argv/config
        I-->>U: stderr + exit 2-3
    end
    I->>C: runCli(config)
    C->>C: invalidate stale manifest
    C->>C: remove prior formalization_evidence tree
    C->>C: checkDependencies
    C->>Cat: discover and classify documents
    Cat-->>C: typed catalog + conflict findings
    C->>P: parse each cataloged document
    P-->>C: typed models + structural findings
    C->>MG: merge per capability (finalized + delta)
    MG-->>C: merged capability specs + merge findings
    C->>CG: normalize into claim graph (from merged specs)
    CG-->>C: typed claims with provenance + capability
    C->>A: qualitative, coverage, formalization, clustering, logic
    A-->>C: analysis findings with evidence
    alt --src enabled
        C->>S: traceability, derive, formalize, cross-imply, blind compare
        S-->>C: source-backed findings
    end
    C->>R: render reports and write artifacts
    R->>M: write manifest last
    C-->>I: RunState
    alt no findings
        I-->>U: exit 0
    else findings present
        I-->>U: exit 1
    else fatal error
        I-->>U: exit 2-11
    end
```

Protocol rules:

- validation occurs before any external tool invocation
- run-start output cleanup occurs before dependency and phase work: invalidate the stale manifest first, then remove the prior `formalization_evidence/` tree; abort if either operation fails
- phase groups execute in strict order: ingestion → analysis → source → reporting
- `PipelineAbortError` bridges domain `ErrorCategory` into the exception world for progress-event infrastructure compatibility
- each phase emits exactly one `started` event and one `completed`/`failed` event

### 7.2 Formalization and Solver Sequence

Relevant code: [`src/domain/formal/formalize.ts`](src/domain/formal/formalize.ts), [`src/domain/formal/clustering.ts`](src/domain/formal/clustering.ts), [`src/domain/formal/smtlib.ts`](src/domain/formal/smtlib.ts), [`src/domain/formal/logic-analysis.ts`](src/domain/formal/logic-analysis.ts)

```mermaid
sequenceDiagram
    participant C as run-cli.ts
    participant CG as Claim Graph
    participant F as Formalize
    participant T as Temp Context
    participant V as Validate
    participant OC as opencode
    participant CL as Clustering
    participant SM as SMT-LIB Compiler
    participant Z as z3
    participant LA as Logic Analysis
    participant FS as Output Dir

    C->>C: build active capability-to-logical-file map once
    C->>F: eligible claims + shared map
    F->>F: select semantic keys; stable physical sub-batches
    alt multi-claim first-sample batch
        F->>T: create private temp dir; write deterministic batch-context.json
        F->>OC: dedicated prompt + attached untrusted JSON
        OC-->>F: indexed raw JSON entries
        F->>T: record hash evidence; cleanup in finally on handled path
    else single-claim first sample
        F->>OC: inline fenced claim prompt
        OC-->>F: raw JSON candidate
    end
    F->>V: validate each sample against logic IR schema
    alt valid
        V-->>F: LogicIrClaim
    else invalid
        V-->>F: validation error (consume retry)
    end
    F->>OC: bounded per-claim degradation for eligible terminal failures
    OC-->>F: additional raw samples
    F->>V: validate retried samples
    F->>F: additional-sample failure => preserve candidate + warning only
    F->>F: assert disjoint exhaustive candidate/error partition
    F-->>C: attached attempt records
    C->>C: wrap invocation records in FormalizationAttemptSet claimSet
    F-->>CL: FormalizationCandidates (valid samples per claim)
    CL->>SM: compile pairwise implication queries
    SM-->>CL: SMT-LIB for left ⇒ right and right ⇒ left
    CL->>Z: run implication checks (bounded concurrency)
    Z-->>CL: sat/unsat/timeout/unknown/error per pair
    CL->>CL: BFS connected components on mutual implication
    CL-->>C: representative per claim from largest stable cluster
    C->>LA: representatives + same shared map after solver-specific filtering
    LA->>LA: select the same semantic keys
    LA->>SM: compile per-semantic-group combined SMT-LIB
    SM-->>LA: merged assertions with named labels
    LA->>Z: Phase 1 -- check-sat
    alt sat
        Z-->>LA: consistent
        LA->>Z: guard-activation contradiction checks
        Z-->>LA: per-pair results
        LA->>Z: completeness gap detection
        Z-->>LA: per-assertion results
    else unsat
        Z-->>LA: contradictory
        LA->>Z: Phase 2 -- unsat-core extraction
        Z-->>LA: conflicting claim identifiers
    else timeout/unknown/error
        Z-->>LA: inconclusive
    end
    LA->>FS: persist .smt2, .stdout.txt, .stderr.txt
    LA-->>CG: findings + report markdown
```

Protocol rules:

- `run-cli.ts` builds the capability-to-logical-file map once and passes the same map instance to formalization and solver grouping; solver-specific exclusions occur before grouping
- formalization and solver grouping call the same semantic key helper; exact key equality defines groups, and source provenance is preserved rather than used as the grouping identity for capability-bearing claims
- first-sample physical sub-batches never cross semantic groups and preserve eligible order; `maxBatchSize=0` means one unbounded chunk per logical group
- multi-claim first-sample batches use deterministic attached JSON marked as untrusted data; single-claim and additional-sample calls remain inline
- attached responses are matched by required original eligible `index`, never by array position or `claim.id`; unknown, duplicate, or missing indexes are schema failures
- attached temp directories use the `spec-check-batch-` prefix and fixed `batch-context.json`; evidence is recorded and cleanup is attempted in `finally` before claim outcomes are assigned on handled paths; process termination may bypass cleanup
- every invocation's attempt envelope declares `claimSet` as `specs_forward` or `generated_spec` with local ordinal/capability; attempt indexes resolve only within that claim set
- each attempt set is persisted as a separate atomic evidence file; such files may survive failure, while the last-written manifest alone marks success and lists/checksums them
- terminal `timeout`, `invalid_json`, and `schema_validation_error` failures degrade to bounded per-claim inline calls; infrastructure failures become claim errors without redundant fallback
- once a candidate exists, additional-sample failure preserves it and emits a warning finding only; at handled completion candidate and claim-error indexes are disjoint and exhaust eligible indexes
- compiled SMT-LIB excludes solver commands until query execution time
- implication queries contain exactly one `(check-sat)`
- per-spec logic analysis uses a two-phase strategy: satisfiability first, unsat-core extraction only on contradiction
- deeper checks (guard-activation contradiction and completeness-gap detection) run under bounded solver concurrency, not serially
- solver stdout/stderr, timeout, unknown, and error diagnostics are persisted verbatim

### 7.3 Code-Backwards Sequence

Relevant code: [`src/domain/code-backwards/`](src/domain/code-backwards/), [`src/cli/pipeline-helpers.ts`](src/cli/pipeline-helpers.ts)

```mermaid
sequenceDiagram
    participant CG as Claim Graph
    participant T as Trace
    participant SRC as Source Tree
    participant D as Derive
    participant OC as opencode
    participant GF as Gen-Formal
    participant Z as z3
    participant CI as Cross-Implication
    participant BC as Blind Compare
    participant FS as Output Dir

    CG->>T: claims with identifiers
    T->>SRC: scan for canonical identifiers (bounded concurrency)
    SRC-->>T: file matches per identifier
    T-->>T: classify evidence levels (primary/secondary/supporting)
    T-->>CG: traces + gap findings
    CG->>D: source evidence + capability name suggestions (NO original req text)
    D->>OC: generation prompt (blind to original specs)
    OC-->>D: EARS-preferring capability specs
    D->>FS: write gen_specs/*.md
    D-->>GF: DerivedCapabilitySpecs
    GF->>OC: formalize code-derived claims (1 sample each)
    OC-->>GF: logic IR samples
    GF->>Z: cluster + compile SMT-LIB
    Z-->>GF: representatives
    GF->>FS: write gen_specs_smt/*.smt2
    GF-->>CI: GeneratedFormalizations
    CI->>CI: Tier 1 -- aggregate comparison (2 Z3 calls per capability)
    CI->>Z: forward + reverse aggregate implication
    Z-->>CI: capability-level classification
    CI->>CI: Tier 2 -- pairwise comparison (bounded by pair-budget)
    CI->>Z: N*M*2 pairwise implication queries
    Z-->>CI: per-pair classification
    CI->>CI: greedy bipartite matching (score-sorted, lexicographic tiebreak)
    CI->>FS: persist implication query artifacts
    CI-->>BC: CrossImplicationResults
    BC->>OC: blind prompt (code-derived artifacts only, NO original text)
    OC-->>BC: explanatory rationale
    BC-->>CG: comparison findings
```

Protocol rules:

- code-derived generation receives source-scoped evidence and capability-name suggestions only; no original requirement text, proposal text, or design text
- cross-side implication operates on formal artifacts, not mixed claim text
- blind comparison provides explanatory rationale; solver implication remains the primary classifier
- tiered comparison strategy: aggregate first (always runs, cheap), pairwise second (budget-bounded, expensive)

### 7.4 Core to `opencode` Boundary

Relevant code: [`src/adapters/opencode.ts`](src/adapters/opencode.ts)

Protocol rules:

- prompts are fenced so analyzed content is not promoted to instruction position
- the `opencode` adapter builds argv (`opencode run <prompt> --model <name> --format json`) and parses newline-delimited JSON event output; the prompt must be the first positional argument after `run`, because `opencode` interprets trailing positional arguments as file paths
- source evidence is passed as file attachments via repeated `--file <path>` arguments appended after the prompt; attachments are validated before transport — symlinks are rejected and each path must resolve to a readable regular file, otherwise the call fails with `invalid_files`
- because the prompt travels as an argv positional, prompts exceeding 32,768 UTF-8 bytes (`PROMPT_ARG_MAX_BYTES`) fail immediately with `prompt_too_large` and are never retried
- the per-call timeout defaults to 300s and is validated to the range [30s, 15min]; an out-of-range value fails with `invalid_timeout`
- `type: "text"` event payloads are concatenated and parsed as the final JSON response; payload recovery is a deterministic cascade (direct parse → strip markdown fences → extract first balanced JSON value), and a single non-delimited JSON value is also accepted
- `type: "error"` events are treated as failures
- `opencode` responses must be schema-valid before entering the core model
- invalid responses consume bounded retries (default 3); retries are sequential, with no concurrent subprocess overlap within a single call
- terminal failures are classified into a closed taxonomy: `spawn_error`, `timeout`, `invalid_json`, `invalid_timeout`, `schema_validation_error`, `prompt_too_large`, `invalid_files`
- all valid and invalid samples are preserved as evidence

### 7.5 Core to `z3` Boundary

Relevant code: [`src/adapters/z3.ts`](src/adapters/z3.ts)

Protocol rules:

- SMT-LIB content is piped via stdin (`-in` flag), not temp files
- compiled SMT-LIB excludes solver commands until query execution time
- the adapter classifies exit into sat/unsat/timeout/unknown/error
- the adapter always resolves and never rejects; spawn failures surface as `error` with `exitCode: null`
- error lines (`(error ...)`) override any verdict (verdicts after errors are unreliable); `errorCount` reports how many `(error ...)` lines were observed
- solver stdout/stderr, timeout, unknown, and error diagnostics are persisted verbatim
- per-query timeout default is 30s, enforced by killing the child process with SIGKILL

---

## 8. Failure Modes and Error Model

### 8.1 Error Categories and Exit Codes

Relevant code: [`src/domain/errors.ts`](src/domain/errors.ts)

The domain defines a structured error hierarchy using a generic `ErrorBase<C>` discriminated union pattern with plain readonly objects (no class inheritance):

| Exit Code | Category | Meaning |
|---|---|---|
| 0 | -- | Analysis completed without findings |
| 1 | FindingsPresent | Analysis completed and surfaced one or more findings |
| 2 | ArgumentError | CLI argument parsing failure |
| 3 | ConfigError | Configuration loading or validation failure |
| 4 | DependencyError | Missing external binary dependency |
| 5 | CatalogError | Input document discovery or reading failure |
| 6 | AdapterError | External process adapter failure |
| 7 | ValidationError | Schema or structure validation failure |
| 8 | QualitativeError | LLM-backed qualitative review failure |
| 9 | FormalizationError | LLM-backed formalization failure |
| 10 | PipelineError | Pipeline phase orchestration failure |
| 11 | OutputError | File or manifest output failure |

**Invariant:** Exit codes 2-11 correspond to the `ErrorCategory` discriminated union. Exit code mapping is deterministic and stable across versions. Fatal errors in any category prevent the tool from producing a trustworthy evidence set.

Narrowed boundary unions (`PipelinePhaseError`, `AdapterBoundaryError`, `CliResolutionError`) constrain which error categories can appear at specific subsystem boundaries, providing compile-time safety.

### 8.2 Stderr and Stdout Formats

**Stderr:** Diagnostic and error output. Fatal errors follow this format:
```
[spec-check] <Category>: <concise message>
```
Details, when present, are indented on subsequent lines.

**Stdout:** Structured JSON progress events. Each event is a single JSON line with at least:
- `phase`: the pipeline phase name
- `status`: one of `started`, `completed`, `failed`, `skipped`
- `timestamp`: ISO-8601 UTC timestamp

Phase completion events include `duration_ms` and summary counts where applicable.

### 8.3 Failure Mode Analysis

| Failure Mode | Detection | Impact | Mitigation |
|---|---|---|---|
| **False negative analysis** | Missed by tool | Undermines core product value | Multi-layer analysis (qualitative + formal + coverage) |
| **Nondeterministic material divergence** | Repeated runs surface different findings | Weakens trust in dependability cases | Deterministic core; nondeterminism isolated at boundaries |
| **Evidence loss** | Reports omit provenance or evidence | Weakens findings even when correct | Provenance propagation; evidence preservation invariants |
| **`opencode` unavailable** | Adapter timeout or spawn failure (ENOENT) | Critical phases cannot complete | Fail fast with `QualitativeError` or `FormalizationError` |
| **`z3` unavailable** | Binary absent or non-executable | Solver phases cannot complete | Fail fast with `DependencyError` at dependency check phase |
| **Solver timeout/unknown** | No definitive sat/unsat result within 30s | Incomplete formal analysis | Preserve as findings; classify as `uncertain` or `logic.inconclusive` |
| **Solver error diagnostic** | `(error ...)` lines in Z3 output | Malformed SMT-LIB from formalization | Surface as `logic.solver_error` finding; error overrides any verdict |
| **Invalid LLM response** | Schema validation failure at adapter boundary | Retry consumed | Bounded retries (default 3); fail hard after exhaustion |
| **Prompt injection** | Analyzed text elevated to system position | Distorted analysis | `sanitizeForCodeFence()` + fenced prompt construction in all LLM-backed phases |
| **Semantic grouping key drift** | Formalization and solver groups differ for the same eligible claims | Solver conclusions no longer correspond to formalization evidence | One shared key helper and one map instance; solver filtering occurs before grouping |
| **Attached response misattribution** | Missing, duplicate, or unknown response index; optional/duplicate claim IDs used as identity | Candidate or additional sample assigned to the wrong claim | Original eligible index is authoritative; explicit response-index validation; `claim.id` is informational only |
| **Cross-invocation evidence reconstruction** | The same local index is resolved against the wrong specs-forward or generated-spec claim array | Reconstructed context does not match what was sent | `FormalizationAttemptSet.claimSet` selects the only valid index namespace; generated specs include invocation-local ordinal and capability |
| **Temp context leak or unauditable deletion** | Partial write, adapter failure, cleanup failure, or process termination leaves claim text behind or removes the only evidence | Confidentiality loss or unreviewable LLM attempt | Private exclusive context write; cleanup in `finally` on handled paths; invocation-scoped pointer metadata and SHA-256; process termination may leave temp artifacts and no manifest |
| **Attached prompt injection** | Instruction-like claim text in attached JSON influences model control flow | Distorted formalization | Dedicated prompt declares attached JSON untrusted data and contains no claim bodies; adversarial prompt tests |
| **Additional-sample failure creates dual outcome** | A later optional sample fails after a valid candidate exists | Same eligible index appears as both candidate and claim error | Preserve candidate and prior samples; emit warning only; enforce `C ∩ R = ∅` and `C ∪ R = E` |
| **Eligible claim loss during batching** | Worker, transport, or degradation failure leaves a claim with no terminal result | Silent analysis gap | Physical-batch failures normalize to claim-level errors only where no candidate exists; candidate/error indexes exactly partition eligible indexes under handled outcomes |
| **SMT-LIB syntax collision** | User-derived identifiers with reserved chars | Malformed solver inputs | `sanitizeIdentifier()` with hex escaping; reversible mapping comments |
| **Report Markdown injection** | Untrusted evidence text contains Markdown control syntax | Findings spoof report structure, links, or emphasis | `neutralizeMarkdownInline()` neutralizes links, emphasis, code spans, table pipes, headings, block quotes, list items, and table-cell breakout (`RAE-EVID-RENDER-SAFE`) |
| **Blind boundary violation** | Original text exposed to code-derived side | Undermines comparison methodology | Structural enforcement; violations surfaced as analysis defects |
| **Manifest written prematurely** | Manifest before all outputs finalized | Partial output trusted as complete | Invalidate stale `manifest.json` as the first run-start cleanup operation; write the current manifest last |
| **Prior attempt evidence contaminates a rerun** | A previous successful, failed, or terminated run left `formalization_evidence/` files | Current evidence is attributed to the wrong run | After stale-manifest invalidation, recursively remove the entire prior evidence tree before any pipeline work; abort on cleanup failure |
| **Attempt evidence mistaken for completion** | Atomic attempt-set files survive a failed or terminated current run until the next run starts | Partial run trusted as successful | Evidence files are not completion markers; only manifest presence marks success, and the manifest lists/checksums every current-run attempt-set file |
| **Output write failure** | Filesystem error during atomic write | Incomplete evidence set | Exit with `OutputError`; no manifest written; temp file cleaned up |
| **Conflicting in-development deltas** | Multiple deltas modify same capability | Hidden coordination failure | Surface as findings, not silent resolution; lexicographically first wins |
| **Parser loss** | Unrecognized content silently dropped | Missing requirements or constraints | Loss-aware parser: unmatched lines preserved as evidence and findings |
| **Path traversal** | Output path escapes configured directory | Filesystem overreach | `resolveConfinedOutputPath()` with `precondition` assertion |

### 8.4 Failure Taxonomy

**Unsafe inputs:** Malformed identifiers, missing sections, unreadable files, invalid config, malformed task content, output directory inside source directory.

**Fragile formats:** OpenSpec files are close to structured prose. Minor heading or identifier drift can silently distort meaning unless the parser is loss-aware and validates structure explicitly.

**Inadequate control actions:** Continuing after invalid LLM responses, missing solver binaries, or provenance-free claims would create misleading output.

**Process model flaws:** False negatives, nondeterministic divergence between runs, and blind trust in opaque heuristics.

**Coordination failures:** Timeouts, retries, and optional phases can produce confusing results unless phase boundaries and skipped-scope reporting are explicit.

### 8.5 Control and Recovery

- Validate early: reject invalid paths, malformed config, missing dependencies, and empty input conditions before deeper processing.
- Retry bounded external calls with explicit timeouts and fail hard when required evidence-producing phases remain unavailable.
- Preserve inconclusive states (timeouts, unknown solver responses) as findings rather than treating them as success.
- Treat parser loss, unsupported references, and provenance gaps as surfaced defects rather than invisible degradation.
- Use atomic writes plus manifest-last semantics so interrupted runs cannot impersonate complete output.
- No automatic retry policy at the pipeline level: individual phases control their own retry behavior.

### 8.6 Result Type and Assertion Utilities

**Result type:** All error paths in domain code are expressed as `Result<T, E>` values with typed error unions. Adapter code catches system exceptions and wraps them into `Result` before returning.

```typescript
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

Factory functions `ok()` and `err()` use `never` in the unused branch for type-safe composition. No methods; pure data.

**Assertion utilities:** Runtime invariant enforcement uses four assertion functions for programmer errors (not expected domain failures):

| Function | Purpose |
|---|---|
| `precondition()` | Asserts caller contract obligations at function boundaries |
| `invariant()` | Asserts structural invariants within functions or modules |
| `postcondition()` | Asserts guaranteed outcomes before returning |
| `assertNever()` | Asserts exhaustive handling in discriminated union switches |

All four use TypeScript's `asserts condition` return type for control-flow narrowing. `assertNever` leverages the `never` type -- adding a new union variant causes a compile error at all call sites.

Relevant code: [`src/domain/result.ts`](src/domain/result.ts), [`src/domain/errors.ts`](src/domain/errors.ts), [`src/domain/assert.ts`](src/domain/assert.ts)

### 8.7 Process Termination

- Cleanup is guaranteed only for handled execution paths that reach their lifecycle `finally` blocks.
- No SIGINT or SIGTERM temp-cleanup guarantee is part of the contract. Process termination can leave temp context artifacts and atomically finalized attempt-set evidence files.
- If termination occurs before `manifest.json` is written last, the manifest is absent and the run is incomplete. Surviving current-run evidence audits attempted work but does not imply completion and may remain only until the next run removes the prior `formalization_evidence/` tree.

---

## 9. Safety and Liveness Claims

### 9.1 Safety Properties

| Claim | Mechanism | Verification |
|-------|-----------|--------------|
| **No analysis proceeds with incomplete catalog** | Catalog validation before deeper phases; `PipelineAbortError` on failure | Contract tests; integration tests |
| **No claim enters the graph without provenance** | Claim graph builder validation; `detectOrphanClaims()` | Property tests; orphaned-claim detection |
| **No formalization sample enters clustering without schema validation** | `validateFormalizationSample()` with structural checks on variables, functions, sorts, assertions | Contract tests |
| **No grouping-key drift between formalization and solver analysis** | One `selectClaimLogicalFile()` helper and one capability-to-logical-file map instance; solver filtering precedes grouping | Contract/property parity tests; integration oracle; Alloy check |
| **No eligible claim is lost or assigned two outcomes** | Candidate/error indexes satisfy `C ∩ R = ∅` and `C ∪ R = E`; stable slicing; worker failures normalized only where no candidate exists | Property and fault-injection tests; Alloy checks |
| **No attached claim text is treated as instructions** | Dedicated attached prompt declares JSON untrusted and excludes claim bodies | Negative prompt-content and adversarial injection tests |
| **No missing or duplicate claim ID corrupts attribution** | Original eligible index or object identity is authoritative; response indexes validated explicitly | Contract and property identity tests |
| **No handled attached attempt intentionally retains temp context** | Cleanup in `finally` after success and failure when lifecycle finalization is reached; cleanup failure surfaced without discarding candidates | Handled-path lifecycle fault-injection tests; Alloy checks; no process-termination guarantee |
| **No additional-sample failure revokes a candidate** | Existing candidate and samples preserved; warning finding emitted; no claim error | Contract and partition property tests |
| **No cross-claim-set evidence reconstruction** | `FormalizationAttemptSet.claimSet` scopes all local indexes | Envelope and reconstruction tests |
| **No solver conclusion from unvalidated formalization** | Pipeline ordering enforced by domain types; clustering only accepts validated `LogicIrClaim` | Integration tests |
| **No blind comparison exposes original requirement text** | Structural boundary enforcement in `derive.ts` and `blind-compare.ts` | Property tests; boundary violation detection |
| **No code-derived generation exposes original requirement text** | Generation receives only source evidence and capability name suggestions | Property tests |
| **No manifest written before all outputs finalized** | `invalidateStaleManifest()` at start; `writeManifest()` as final I/O | Integration tests |
| **No attempt-evidence file implies completion** | Separate atomic files are partial evidence; successful manifest lists/checksums them and is written last | Failure/termination and manifest contract tests |
| **No prior formalization evidence enters a new run** | Ordered run-start cleanup invalidates the stale manifest, then removes the prior `formalization_evidence/` tree before pipeline work | Run-start ordering and recursive-removal integration tests |
| **No unsupported verdict reaches final report** | Report rendering replaces malformed findings with `reporting.unsupported_verdict` defects | Contract tests |
| **No shell injection** | Argv-based `execFile` only with `shell: false`; no `exec` in codebase | Codebase invariant |
| **No writes outside output directory** | `resolveConfinedOutputPath()` with `precondition` assertion | Contract tests |
| **Solver inputs/outputs always persisted** | Adapter-level persistence via `writeOutputAtomic()` | Integration tests |
| **Findings never silently removed** | Monotonic `addFindings()` in `RunState` with length postcondition | Property tests |
| **No archived spec participates in active analysis** | Catalog classification excludes archived paths | Contract tests |
| **Parser never silently drops content** | Unmatched lines become unparsed evidence and structural findings | Property tests |

### 9.2 Liveness Properties

| Claim | Mechanism | Bound |
|-------|-----------|-------|
| **Qualitative analysis completes** | If `opencode` responds with valid output within retry bounds | Bounded retries (default 3) with universal per-call timeout (default 300s) |
| **Formalization reaches terminal outcomes** | Under handled adapter outcomes, candidate and claim-error indexes exactly and disjointly partition eligible indexes; sibling physical batches continue after localized failure | Bounded adapter retries (3); worst-case in-flight adapter calls are `concurrency × INLINE_FALLBACK_CONCURRENCY (2)` on the degradation path and `concurrency` otherwise |
| **Physical sub-batching terminates** | Pure stable slicing advances through each finite logical group | Every valid `maxBatchSize`; `0` produces one chunk and positive values bound chunk size |
| **Attached temp cleanup is attempted** | Every handled attached terminal path that reaches lifecycle finalization enters `finally`; directory-creation failure owes no cleanup | After success, model failure, adapter-return failure, thrown failure, or partial write; excludes process termination |
| **Solver analysis completes** | If `z3` responds within per-query timeout | Per-query timeout (default 30s) |
| **Cross-side implication completes** | If `z3` responds within per-query timeout | Per-query timeout; pair budget bounds total work (default 200) |
| **Pairwise deeper-check completes** | If `z3` sub-check queries respond within per-query timeout; bounded fan-out via `mapBounded` | `PAIRWISE_SOLVER_CONCURRENCY` (3) plus one completeness query per group (per-group solver peak 4; global peak `concurrency × 4`); sub-check `timeout`/`unknown` surfaces one aggregated `logic.inconclusive` warning |
| **Code-derived generation completes** | If `opencode` responds within timeout | Bounded retries per capability; per-call timeout (default 300s) |
| **Code-derived formalization completes** | If `opencode` responds within retry bounds | Bounded retries per capability |
| **Manifest is written** | If all required phases complete without fatal error | Pipeline completion triggers manifest write |
| **Source scanning completes** | Files bounded by 1 MiB limit and concurrency limit | Default 16 concurrent file reads |
| **Clustering terminates** | Pairwise queries bounded by sample count | Default 30s per Z3 query; default concurrency 4 |

---

## 10. Quality Attributes

| Attribute | Target | How Achieved |
|-----------|--------|--------------|
| **Reliability** | Never silently drop findings or evidence; hard-fail when required external-tool responses are unavailable | Fail-fast at boundaries; monotonic findings accumulation; preserved intermediate artifacts |
| **Observability** | Every finding includes provenance; every run emits progress; every successful run writes a manifest | Structured JSON progress events; manifest-based completion; preserved solver and model artifacts |
| **Security** | Argv-only subprocesses; write-confinement to `--output`; prompt fencing | Subprocess adapter design; `resolveConfinedOutputPath()`; `sanitizeForCodeFence()`; `sanitizeIdentifier()` |
| **Bounded responsiveness** | All external calls bounded by timeout and retry policy | `opencode`: run-config timeout (`timeoutMs`, default 300s) and 3 retries; `z3`: 30s timeout; pairwise: `--pair-budget` cap |
| **Determinism** | Identical inputs and cached LLM responses produce byte-identical outputs | Deterministic core; nondeterminism isolated at boundaries; deterministic claim graph, parser, coverage, clustering pair enumeration |
| **Maintainability** | Changes localized by pipeline phase and architecture layer | Phase-based specs; three-layer architecture; deterministic domain-core design; isolated adapter boundaries |
| **Testability** | All domain logic testable without external tools | Domain/adapter separation; injectable adapters; pure domain functions |

---

## 11. Verification Strategy

The project follows the **verification pyramid** from [`docs/lfm.md`](docs/lfm.md):

```mermaid
graph BT
    Claims[Explicit Claims and Invariants] --> Models[Spec Models and Checkable Kernels]
    Models --> PBT[Property-Based Tests]
    PBT --> CT[Unit / Contract Tests]
    CT --> IT[Integration and Determinism Tests]
    IT --> Trace[Traceability and CI Re-checking]
```

### 11.1 Claims and Evidence Sources

| Layer | Focus | Primary Sources |
|---|---|---|
| capability requirements | normative behavior | [`openspec/specs/`](openspec/specs/) |
| design claims | architecture, sequencing, invariants, safety, liveness | this document |
| implementation structure | where behavior lives and architectural boundaries | code map in [section 3](#3-architecture) and [section 14.4](#144-repository-layout) |
| executable evidence | tests and traceability runs | `test/contract/`, `test/property/`, `test/integration/`, `test/determinism/` |

### 11.2 Evidence Layers

| Layer | Coverage Focus |
|---|---|
| **External formal models** | Merge-structure safety invariants (`openspec/changes/variable-claim-conflict/specs/formalization-and-logic-analysis/alloy/merge.als`) and semantic grouping, batch lifecycle, and claim-partition invariants (`openspec/changes/semantic-batching/specs/formalization-and-logic-analysis/alloy/semantic-batching.als`) checked in Alloy via Analyzer runs |
| **Property-based tests** | Parser invariants, claim extraction invariants, clustering determinism, implication classification symmetry, blind boundary enforcement, manifest integrity, run-state monotonicity, temp-lifecycle histories, attached-response matching, degradation decision machine, outcome determinism under shuffled completion, evidence isolation across concurrent invocations |
| **Contract tests** | CLI argument handling, config merge precedence, parser structural checks, EARS classification, LLM schema validation, SMT-LIB sanitization, manifest semantics, boundary violation detection, obligation-aware severity |
| **Integration tests** | End-to-end analyses with fixture specs plus fake `opencode` and fake `z3` adapters |
| **Determinism tests** | Re-run with fixed inputs and cached responses, then diff outputs byte-for-byte |
| **Invariant tests** | Repository-wide safety and liveness rules |
| **Fault injection tests** | Graceful degradation when adapters fail or timeout; atomic-write rename failure with temp-orphan cleanup |
| **Adversarial input tests** | Malformed, hostile, or boundary-case inputs handled without crash or misleading results |
| **Oracle/golden tests** | Expected logic encodings and parser outputs as permanent fixtures |
| **Regression fixtures** | Every discovered ambiguity pattern, counterexample, and parser-loss issue as a permanent fixture |

### 11.3 Key Test Categories

**Contract tests** validate per-spec requirements:
- CLI argv parsing accepts valid flags and rejects invalid arguments
- Config loading and merge with CLI precedence
- Catalog discovery, classification, archived exclusion, delta conflict detection
- Parser EARS extraction, identifier validation, loss-aware capture
- Claim graph provenance attachment, obligation levels, orphaned-claim detection
- Coverage gap, contradiction, unsupported reference, and task inconsistency detection
- `opencode` adapter schema validation and bounded retries
- `z3` adapter timeout handling and exit classification
- SMT-LIB identifier sanitization
- Formalization sample validation (variables, functions, sorts, assertion syntax)
- Clustering stability threshold and ambiguity findings
- Logic analysis obligation-aware severity and evidence persistence
- Source traceability gap findings and scope confinement
- Code-derived generation blind boundary enforcement
- Cross-side implication classification (same/stronger/weaker/different/uncertain)
- Blind comparison boundary enforcement
- Report rendering, manifest checksums, manifest-last ordering

**Property-based tests** exercise invariants over generated inputs:
- Parser: every input line is classified or preserved as unparsed evidence
- Claim graph: every claim has provenance; no orphaned claims
- Clustering: deterministic representative selection; symmetry invariant
- SMT-LIB compilation: valid syntax after sanitization for arbitrary identifiers
- Manifest: every listed file exists and has correct checksum
- Run-state: findings never removed by later phases
- Blind boundary: original requirement text never exposed to code-derived side
- Cross-side classification: deterministic and symmetric
- Greedy matching: deterministic given same classification scores
- Temp lifecycle: cleanup is attempted iff a directory was created; evidence `cleanup` classification matches the terminal lifecycle state, and cleanup failure never masks the attempt outcome
- Attached response matching: the envelope fails iff the entry count differs or an index is unsafe, unknown, or duplicated; on success the matched key set equals the claim index set; extra model-hallucinated entry fields are tolerated
- Degradation: the decision depends only on (terminal error kind, inline-prompt fit); `maxBatchSize = 0` and `Number.MAX_SAFE_INTEGER` each yield one chunk
- Metamorphic formalization: terminal candidate/error index sets and finding categories are identical under shuffled completion order; attempt evidence stays isolated between concurrent invocations

**Spec traceability:** Every testable requirement in `openspec/specs/` carries a bracketed identifier (e.g., `[CAT-PARSE-EARS]`). Contract tests reference these identifiers via `traceSpec(...)`, and the traceability tooling validates coverage.

**Spec reference:** [`spec-traceability`](openspec/specs/spec-traceability/spec.md)

---

## 12. Distribution and Packaging

| Artifact | Format | Target |
|----------|--------|--------|
| npm package | Standard npm tarball | `npm install -g` or `npx` |
| `dist/spec-check.js` | Single-file ESM bundle (esbuild) | Node >= 20 |

**Build invariants:**
- The bundle is a single `.js` file with no external dependencies at runtime.
- `#!/usr/bin/env node` shebang is prepended.
- Source maps are excluded from the distribution artifact.
- The bundled artifact passes the same integration tests as the source tree.
- Both distribution forms preserve the same help/version surface, output contracts, and exit-code behavior.

**Parity requirement:** help/version behavior, outputs, exit codes, and command contracts match across supported forms.

**Build commands:**

| Command | Purpose |
|---|---|
| `npm run build` | TypeScript compilation (`tsc`) |
| `npm run bundle` | Single-file bundle creation (`esbuild`) |
| `npm run smoke:parity` | Build + bundle + parity verification |

Relevant code: [`build/esbuild.ts`](build/esbuild.ts), [`package.json`](package.json)

---

## 13. Security and Trust Boundaries

The tool has no end-user authentication or authorization model because it is a local CLI, but it has meaningful security boundaries:

| Concern | Design Constraint | Implementation |
|---|---|---|
| subprocess invocation | argv-based execution via `execFile`; no shell interpolation | `shell: false` in [`src/adapters/process.ts`](src/adapters/process.ts) |
| prompt injection | inline document content is fenced; attached batch JSON and claim text are explicitly untrusted data, never instructions; multi-claim prompt bodies contain no claim text | `sanitizeForCodeFence()` in [`src/domain/fence.ts`](src/domain/fence.ts); dedicated attached-context prompt and transport in formalization modules |
| attached formalization context | full claim text exists temporarily outside `--output`; it must be owner-only and auditable after deletion, but process termination can prevent cleanup | fresh `spec-check-batch-` temp directory; exclusive `0600` `batch-context.json`; cleanup in `finally` on handled paths; invocation `claimSet` plus local pointers and SHA-256 persisted |
| formalization attempt evidence | atomic evidence may survive a failed or terminated current run until the next run, and local indexes can collide across invocations | one `FormalizationAttemptSet` file per invocation; `claimSet` scopes reconstruction; only the last-written manifest marks success and lists/checksums current-run evidence; ordered next-run cleanup removes the prior evidence tree |
| filesystem overreach | all writes confined to `--output` directory; output paths resolved and validated up front | `resolveConfinedOutputPath()` with `precondition` in [`src/adapters/fs.ts`](src/adapters/fs.ts) |
| SMT-LIB identifier injection | user-derived identifiers sanitized before writing SMT-LIB artifacts with injective fixed-width-6 escapes | `sanitizeIdentifier()` in [`src/domain/formal/identifiers.ts`](src/domain/formal/identifiers.ts) |
| report rendering injection | untrusted spec-derived finding text (descriptions, provenance, evidence values, related claim IDs) rendered as inert Markdown data; cannot break out of list/table context or inject links, emphasis, code spans, or block structure | `neutralizeMarkdownInline()` in [`src/domain/reporting/render.ts`](src/domain/reporting/render.ts) (`RAE-EVID-RENDER-SAFE`) |
| blind comparison boundary | original requirement text never crosses to the code-derived comparison or generation side | Structural enforcement in [`src/domain/code-backwards/derive.ts`](src/domain/code-backwards/derive.ts) and [`src/domain/code-backwards/blind-compare.ts`](src/domain/code-backwards/blind-compare.ts) |
| subprocess output | captured via stdout/stderr arrays; no ambient shell risk | Chunked accumulation in [`src/adapters/process.ts`](src/adapters/process.ts) |
| evidence integrity | solver inputs/outputs persisted verbatim; LLM responses preserved with full content | Adapter-level persistence in analysis modules |
| output-inside-source prevention | output directory must not be inside source directory | `[CAT-CLI-OUTSRC]` check in [`src/cli/config.ts`](src/cli/config.ts) |

---

## 14. Operational Concerns

### 14.1 Observability

| Concern | Design Choice |
|---|---|
| phase progress | structured JSON events on stdout with phase name, status, timestamp, optional duration_ms |
| human diagnostics | normalized first-line stderr in the form `[spec-check] <Category>: <message>` with optional indented details |
| evidence visibility | per-phase reports preserved; provenance, identifiers, and evidence references visible |
| intermediate artifacts | solver files, clustering inputs, formalization samples, comparison artifacts preserved under output directory |
| run completion | manifest presence is the atomic completion marker; run start removes the stale manifest first and the prior `formalization_evidence/` tree second, before pipeline work |

### 14.2 Deployment and Rollout

| Concern | Design Choice |
|---|---|
| primary release path | standard npm package installation |
| additional artifact | bundled `dist/spec-check.js` |
| rollback model | version-based; no persistent mutable state in v1 |
| feature flags | none required in v1; rollout is repository-local |

### 14.3 Capacity and Scaling

`spec-check` is a local single-user CLI. Scaling concerns are bounded-work and subprocess-behavior concerns rather than server-side throughput.

| Concern | Design Choice |
|---|---|
| v1 capacity targets | up to 10 spec files, low hundreds of requirements/scenarios total, modest source trees |
| LLM call cost | proportional to document count and claim count; bounded retries per call (default 3) |
| formalization cost | multiplied by sample count per claim; bounded by capability count |
| solver cost | per-query timeout (default 30s); pairwise pair budget (default 200) |
| cross-side cost | 2 Z3 calls per matched capability (aggregate) + bounded pairwise |
| source scanning | 1 MiB per-file limit; default 16 concurrent file reads |
| evidence volume | disk output grows with preserved artifacts; cost accepted because retained evidence is central to product value |

### 14.4 Repository Layout

```text
src/
  index.ts                      entrypoint, argv dispatch, exit code mapping
  version.ts                    version constant
  cli/
    run-cli.ts                  phase-group orchestration
    parse-argv.ts               hand-rolled argument parser
    config.ts                   three-tier config resolution
    phase-runner.ts             progress event decoration
    pipeline-helpers.ts         phase composition and helpers
    pipeline-types.ts           PipelineAbortError, context types
  domain/
    model.ts                    core domain types (Document, Claim, Parsed*)
    branded.ts                  phantom-branded types and factories
    errors.ts                   error hierarchy and exit code mapping
    result.ts                   Result<T,E> type
    assert.ts                   precondition/invariant/postcondition/assertNever
    logic-ir.ts                 logic IR types (sorts, variables, assertions)
    claim-graph.ts              claim extraction and normalization
    findings.ts                 finding shape types
    progress.ts                 progress event protocol
    run-state.ts                immutable append-only run state
    fence.ts                    prompt fencing utility
    tasks-analysis.ts           task analysis utilities
    parser/
      catalog.ts                input discovery and classification
      spec.ts                   spec parsing with EARS classification
      merge.ts                  per-capability delta merge (ADDED/MODIFIED/REMOVED)
      proposal.ts               proposal section parsing
      design.ts                 design section parsing
      task.ts                   task document parsing
      shared.ts                 heading, section, identifier utilities
    spec-forward/
      qualitative.ts            LLM-backed review passes (2 sequential)
      coverage.ts               deterministic coverage analysis (5 sub-analyses)
    formal/
      formalize.ts              orchestration: semantic grouping, physical batching, bounded degradation and sampling
      formalization-types.ts    shared candidate/error/output/result types
      formalization-findings.ts pure finding/error builders and attached response matching
      batch-evidence.ts         immutable attempt-evidence staging (metadata, draft, finalize)
      validate.ts               logic IR schema validation
      clustering.ts             solver-backed equivalence clustering (BFS)
      smtlib.ts                 SMT-LIB compilation and sanitization
      logic-analysis.ts         per-spec solver analysis (2-phase)
      logic-analysis-sexpr.ts   s-expression parsing utilities
      logic-analysis-checks.ts  guard-activation and completeness checks
    code-backwards/
      trace.ts                  source traceability scanning
      derive.ts                 code-derived spec generation (blind)
      gen-formal.ts             code-derived formalization
      gen-logic.ts              code-derived logic analysis
      cross-implication.ts      bidirectional solver comparison
      cross-implication-smt.ts  cross-implication SMT query construction
      cross-implication-types.ts  cross-implication type definitions
      blind-compare.ts          blind LLM comparison (explanatory)
    reporting/
      render.ts                 report rendering and defect replacement
      manifest.ts               manifest construction and integrity
    prompts/
      formalization.ts          formalization prompt templates
      informalize.ts            informalization prompt templates
      blind-compare.ts          blind comparison prompt templates
      qualitative-base.ts       qualitative review prompt base
      qualitative-properties.ts qualitative properties prompt
      qualitative-review.ts     qualitative review prompt
  adapters/
    fs.ts                       confined writes, atomic temp+rename, checksums
    process.ts                  safe execFile wrapper, no shell
    opencode.ts                 LLM subprocess with NDJSON parsing, retries
    z3.ts                       solver subprocess with stdin piping, classification
    concurrency.ts              bounded parallel map with deterministic ordering
test/
  contract/                     per-spec requirement tests
  property/                     invariant tests over generated inputs
  invariant/                    repository-wide safety rules
  integration/                  multi-phase pipeline tests
  determinism/                  stable output tests
  oracle/                       expected logic encodings
  fixtures/                     test input fixtures
  support/                      test helpers and spec traceability
openspec/
  specs/
    catalog-and-parse/
    claim-graph-and-coverage/
    formalization-and-logic-analysis/
    source-traceability-and-code-backwards/
    reporting-and-evidence/
    spec-traceability/
```

---

## 15. Forward Evolution

### 15.1 Evolution Paths

- The parser is specialized to the current schema but isolated enough that future schema support could be introduced behind new parser and catalog branches.
- The claim graph creates a stable internal model that can support richer analyses later without rewriting input parsing.
- Report synthesis is separated from analysis phases so new evidence types can be added with additive report sections.
- Source-backed analysis is optional and bounded so future capability growth can happen without complicating the base specs-forward pipeline.
- The formalization and clustering pipeline can support richer logic (e.g., quantifiers, richer sorts) by extending the logic IR without changing the compilation boundary.

### 15.2 Risks and Mitigations

| Risk | Mitigation |
|---|---|
| LLM dependence can block required phases | Bound retries, validate schemas, fail hard when evidence-producing phases cannot complete |
| Strict failure posture may frustrate users who want partial results | Preserve intermediate diagnostics and make failure causes explicit so reruns are actionable |
| Specialized parsing may need maintenance as schema evolves | Keep parser logic modular and loss-aware so drift is surfaced early |
| Evidence preservation increases disk output | Accept the cost because retained evidence is central to product value |
| Source-backed comparison can overstate confidence if evidence boundaries are loose | Keep declared source scope explicit and enforce the blind-comparison boundary |
| Code-derived formalization doubles LLM and solver cost with `--src` | Symmetric formal pipeline is necessary for solver-backed classification; cost bounded by capability and claim count |
| Cross-side implication may be inconclusive for complex claims | Preserve uncertainty honestly and fall back to blind comparison as the explanatory layer |

### 15.3 Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Generic Markdown AST first | Schema is constrained; product needs deterministic, loss-aware structural extraction more than generic Markdown completeness |
| LLM-heavy end-to-end analysis | Would weaken determinism, auditability, and failure isolation |
| Single-pass formalization without clustering | Ambiguity in formalization is itself useful evidence and must be surfaced rather than hidden |
| Best-effort partial success when critical phases fail | Incomplete evidence could be mistaken for a trustworthy result |
| Temp-file piping for Z3 instead of stdin | Stdin piping is simpler, avoids temp-file cleanup, and avoids path-safety concerns |

---

## 16. Pipeline and Output Summary

### 16.1 Specs-Forward Pipeline

| Step | Output | Description |
|---|---|---|
| Qualitative review (pass 1) | `report_1.1.md` | Independent evaluation of proposal, design, and spec files for inconsistencies, contradictions, ambiguity |
| Qualitative review (pass 2) | `report_1.2.md` | Rigorous assessment ensuring proposal and design capture all preconditions, postconditions, invariants, failure modes |
| Coverage analysis | `report_1.3.md` | Cross-artifact coverage, contradiction, and semantic alignment |
| Formalization | `smt/` directory | SMT-LIB artifacts from formalized claims |
| Solver analysis | `report_1.logic.md` | Z3 evaluation including counterexamples |
| Source traceability | `report_1.src.md` | Requirement/scenario tracing to code (when `--src` provided) |
| Tasks analysis | `report_1.tasks.md` | Task consistency with specs (when `tasks.md` provided) |
| Synthesized summary | `report_1.md` | Combined findings from all specs-forward passes |

### 16.2 Code-Backwards Pipeline (when `--src` provided)

| Step | Output | Description |
|---|---|---|
| Code-derived spec generation | `gen_specs/` directory | EARS-preferring specs per capability from source evidence |
| Code-derived formalization | `gen_specs_smt/` directory | SMT-LIB artifacts from code-derived specs |
| Code-derived solver analysis | `report_2.logic.md` | Internal consistency of code-derived formalizations |
| Cross-side implication | persisted queries | Solver-backed classification (same/stronger/weaker/different/uncertain) |
| Blind comparison | `report_2.compare.md` | Explanatory rationale with dual-layer evidence |
| Synthesized summary | `report_2.md` | Combined findings from all code-backwards passes |

### 16.3 Completion

| Artifact | Description |
|---|---|
| `report_summary.md` | Synthesized summary across all phases with category counts and skipped-phase reporting |
| `manifest.json` | Completion record listing all produced files with SHA-256 checksums; written last |

### 16.4 CLI Interface

```
spec-check [OPTIONS] [INPUT FILES]
```

| Flag | Purpose | Default |
|---|---|---|
| `--output` | Output directory for reports and evidence | `./build/spec-check` |
| `--src` | Source code directory (enables code-backwards mode) | not set |
| `--caps` | Capability listing file | inferred from input files |
| `--z3` | Path to Z3 binary | `z3` on PATH |
| `--config` | JSON configuration file for model and prompt settings | not set |
| `--timeout-ms` | Universal timeout for all external LLM calls (`30_000..900_000`) | `300_000` |
| `--allow-archive` | Admit explicitly provided archived OpenSpec inputs into active catalog | `false` |
| `--pair-budget` | Maximum N*M pairwise comparisons per capability | `200` |
| `--model` | LLM model identifier for `opencode` | adapter default |
| `--help` | Print help and exit | -- |
| `--version` | Print version and exit | -- |

### 16.5 Cross-Side Implication Tiering

| Tier | When | Cost | Output |
|---|---|---|---|
| Tier 1 (Aggregate) | Always for matched capabilities | 2 Z3 calls per matched capability | `capability_aggregate` classification |
| Tier 2 (Pairwise) | When N*M within `--pair-budget` | Up to N*M*2 Z3 calls | `cross_implication` per matched pair; `unmatched_original` and `unmatched_generated` for surplus |

Classification rules: both directions hold = same; only code->original = stronger; only original->code = weaker; neither = different; any inconclusive = uncertain.

Greedy matching is deterministic: sorted by classification score (same=4, stronger=3, uncertain=2, weaker=1, different=0), with lexicographic claim ID as tiebreaker.

Per-capability divergence detection: when >50% of pairs classify as different or weaker, a `high_divergence` error finding is emitted.

---

## 17. Relationship to Other Documents

| Document | Relationship |
|---|---|
| [`openspec/specs/`](openspec/specs/) | Defines the normative behavior for each capability; this document explains the design that ties those specs to the implementation |
| [`docs/lfm.md`](docs/lfm.md) | Explains the assurance posture and evidence model |
| [`docs/spec_traceability.md`](docs/spec_traceability.md) | Explains the traceability contract between specs, tests, and identifiers |
| [`docs/typescript_style.md`](docs/typescript_style.md) | Explains how the implementation should embody the design |
| Archived core change under [`openspec/changes/archive/2026-06-18-spec-check-core/`](openspec/changes/archive/2026-06-18-spec-check-core/) | Historical source material for the initial design baseline |
| [`pasture/concept.md`](pasture/concept.md) | Original concept document; useful background, but where it differs from current specs or code, the active specs and implementation win |

### 17.1 Normative vs Explanatory

- The normative behavioral contract lives in [`openspec/specs/`](openspec/specs/).
- This document explains the design that ties those specs to the current implementation and test strategy.
- Where archived concept/design text conflicts with current code or active specs, the active specs and implementation win.

---

## 18. Maintenance Rules

This is a living document.

Update it when:

- pipeline phases or analysis modes change
- state machines change
- evidence preservation or output format rules change
- invariants or source-of-truth boundaries change
- failure contracts or exit codes change
- safety or liveness guarantees change
- verification expectations change
- new capabilities are added or existing capabilities are modified
- the CLI interface changes
- new branded types, error categories, or assertion patterns are introduced

Maintenance guidance:

- Summarize durable design intent rather than copying every requirement from the specs verbatim.
- Keep capability-specific sections linked to the relevant OpenSpec specs.
- Prefer stable module links over line-number-heavy implementation commentary.
- Ensure new code, tests, and specs continue to support the claims made in this document.
- Keep the numbered section structure when adding new sections.
- Preserve the separation between design intent here and normative behavior in the capability specs.
- When the repository layout changes, update section 14.4 alongside the code change.
- Keep numbered invariant IDs stable across revisions; add new IDs at the end of each series.
