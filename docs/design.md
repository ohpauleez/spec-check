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
| [`formalization-and-logic-analysis`](openspec/specs/formalization-and-logic-analysis/spec.md) | formalization sampling, equivalence clustering, SMT-LIB compilation, per-logical-group solver analysis |
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
| formalization sampling | `opencode` | semantic-group first samples plus bounded per-claim fallback and additional samples |
| code-derived spec generation | `opencode` | blind generation from source evidence |
| code-derived formalization | `opencode` | formalization of generated specs |
| blind comparison | `opencode` | explanatory rationale for cross-side classification |
| equivalence clustering | `z3` | pairwise implication checks between samples |
| logical-group logic analysis | `z3` | satisfiability, contradiction, completeness |
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
        Formalize["formal/formalize.ts<br/>LLM-backed sampling"]
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
| **Pipeline orchestrator** ([`src/cli/run-cli.ts`](src/cli/run-cli.ts)) | Phase-group decomposition into ingestion, analysis, source, reporting | Pipeline progresses in ordered phases only; `PipelineAbortError` for unrecoverable failures |
| **Phase runner** ([`src/cli/phase-runner.ts`](src/cli/phase-runner.ts)) | Progress event decoration: exactly one `started` and one `completed`/`failed` event per phase | Generic decorator; no phase-specific knowledge |
| **Catalog** ([`src/domain/parser/catalog.ts`](src/domain/parser/catalog.ts)) | Resolve input set, classify documents, handle delta/final conflicts | Deterministic given the same inputs; at most one finalized + one delta spec per capability |
| **Structured parsers** ([`src/domain/parser/`](src/domain/parser/)) | Line-oriented parsing for proposal, design, spec, and task documents | Every input line is either classified or preserved as unparsed evidence |
| **Per-capability merge** ([`src/domain/parser/merge.ts`](src/domain/parser/merge.ts)) | Merge finalized and delta specs per capability; apply ADDED/MODIFIED/REMOVED semantics; emit merge findings | Output is deterministic; every skipped operation produces exactly one finding; no silent discard of base items |
| **Claim graph builder** ([`src/domain/claim-graph.ts`](src/domain/claim-graph.ts)) | Normalize parsed content into typed claims with provenance and obligation | No claim exists without provenance; extraction is deterministic |
| **Qualitative analysis** ([`src/domain/spec-forward/qualitative.ts`](src/domain/spec-forward/qualitative.ts)) | Package parsed content for LLM-backed review passes; validate response schemas | `opencode` responses are schema-validated before acceptance; exactly 2 passes on success |
| **Coverage analysis** ([`src/domain/spec-forward/coverage.ts`](src/domain/spec-forward/coverage.ts)) | Compare proposal/design claims against capability specs | Deterministic given the same claim graph; no LLM or solver dependency |
| **Semantic grouping** ([`src/domain/formal/grouping.ts`](src/domain/formal/grouping.ts)) | Select active merged specs for grouping, build the shared capability/logical-file map, select semantic keys, group eligible claims, and split physical batches | The map is built once and shared by formalization and solver; the grouping activity filter includes requirements or scenarios, while solver-specific filtering remains separate |
| **Formalization** ([`src/domain/formal/formalize.ts`](src/domain/formal/formalize.ts)) | Request LLM-backed formalization samples for semantic groups; validate against the Logic IR schema; assemble indexed candidates and errors | Every eligible claim reaches a candidate or claim-level error; single-claim attempts are inline and multi-claim first samples use attached context; `samplesPerClaim > 1` adds bounded per-claim samples |
| **Attached batch transport** ([`src/domain/formal/batch-transport.ts`](src/domain/formal/batch-transport.ts)) | Serialize, hash, write, clean up, and record metadata for ephemeral multi-claim context files | Context bytes are deterministic; files are owner-only and cleaned in `finally`; durable evidence stores pointers and a hash, never claim text |
| **Formalization degradation** ([`src/domain/formal/degradation.ts`](src/domain/formal/degradation.ts)) | Map terminal adapter error kinds to bounded per-claim fallback or claim-level errors | Model-response failures may degrade; infrastructure failures do not receive a second fallback path; no new public error category |
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
| **Manifest** ([`src/domain/reporting/manifest.ts`](src/domain/reporting/manifest.ts)) | Build entries with SHA-256 checksums; persist formalization `batchAttempts`; write atomically; invalidate stale manifests at run start | Manifest is the final file written; batch-attempt records retain pointer/hash evidence and cleanup outcomes without claim text |
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
| Capability | A logical behavior identity with a merged active view and one semantic logical-file key | active catalog | resolved from finalized specs plus at most one in-development delta; lexicographically first delta wins on conflict; claims may retain multiple provenance files |
| Merged Capability Spec | The active merged view of a capability after applying delta operations against the finalized base | merge phase | produced per capability; contains merged requirements, scenarios, findings, source-file links, and a non-empty semantic `logicalFile` |
| Requirement | A capability-level behavioral obligation in EARS format | parsed spec file | must carry a canonical bracketed identifier; classified into one of 8 EARS types |
| Scenario | A concrete, testable behavioral case that refines a requirement | parsed spec file | must carry a canonical bracketed identifier |
| Claim | A normalized statement derived from requirements, scenarios, properties, or code | claim graph builder | always carries provenance and obligation level; capability and ID are optional metadata; extraction from merged specs is deterministic |
| Finding | An analysis result with severity, rationale, provenance, and evidence | analysis phases | never exists without provenance; never silently removed; category is dot-separated hierarchical |
| Formalization Sample | One candidate formal encoding of a claim as logic IR | LLM-backed formalization | schema-validated before acceptance; variables, functions, sorts, and assertion syntax all checked |
| Semantic Group | Eligible requirement and scenario claims sharing one exact semantic grouping key | shared grouping helper | groups are first-key ordered; members preserve eligible input order; capability claims use mapped logical files or synthetic fallbacks |
| Physical Claim Batch | One first-sample LLM attempt cut from one semantic group | formalization transport | stable slicing preserves key, eligible indexes, and order; `maxBatchSize=0` produces one unbounded batch per group |
| Batch Attempt Evidence | Metadata for one attached context attempt after its temp file is deleted | formalization and reporting | records indexes, IDs, provenance files, context hash, prompt/model metadata, outcome, and cleanup; never duplicates claim text |
| Equivalence Cluster | A group of mutually implying formalization samples | solver-backed clustering | BFS-based connected components; represents one interpretation of a claim |
| Solver Artifact | Generated SMT-LIB file, model, unsat core, timeout result, or error diagnostic | solver analysis | persisted verbatim under the output directory |
| Code-Derived Specification | EARS-preferring behavioral spec generated from source evidence, blind to original text | code-derived generation | persisted as Markdown in `gen_specs/` |
| Cross-Side Implication Result | Solver-backed classification (same, stronger, weaker, different, uncertain) | cross-side analysis | primary strength classifier; queries persisted verbatim |
| Report | Human-readable Markdown artifact summarizing one analysis pass | reporting phase | never contains findings without provenance; malformed findings replaced with defect markers |
| Manifest | Completion record listing all produced output files with SHA-256 checksums | reporting phase | written last; stale manifest removed at run start; presence marks completed run |
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
- attached batch-attempt metadata: semantic key, ordered eligible indexes, claim IDs, provenance files, prompt/model metadata, outcome, cleanup status, and exact-context SHA-256; claim text remains pointer-based
- compiled SMT-LIB text
- solver stdout/stderr, models, unsat cores, and timeouts
- source trace links with evidence level classification (primary, secondary, supporting)
- cross-side implication queries and results
- blind comparison rationale

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
| **D-8** | The manifest is the last file written | `invalidateStaleManifest()` at run start; `writeManifest()` at run end | Manifest absence signals incomplete run |
| **D-9** | Compiled SMT-LIB never includes `(check-sat)` | `compileSmtlib()` and `compileSpecSmtlib()` | Caller appends solver commands at query time |
| **D-10** | Claim extraction order is deterministic: proposal → design → specs → tasks | `buildClaimGraph()` iteration order | Property tests |
| **D-11** | Per-capability merge output is deterministic given the same parsed inputs | `mergeSpecsByCapability()` module-level invariant | Property and determinism tests |
| **D-12** | Merged active view preserves every base requirement unless a matching REMOVED operation or duplicate-base exclusion finding exists | Merge layer postcondition | Contract and property tests |
| **D-13** | Every skipped merge operation produces exactly one finding; no silent discard | Merge finding completeness invariant | Property tests |
| **D-14** | `compiled.claimIds` is the authoritative surviving-claim set for downstream checks | `compileSpecSmtlib()` + logic-analysis inclusion filtering | Conflict evidence cannot disagree with emitted inclusion set |
| **D-15** | Compile groups that are structurally invalid — duplicate raw/sanitized claim IDs, or size beyond `CLAIMS_PER_GROUP_MAX` / `DECLARATIONS_PER_CLAIM_MAX` — are rejected before compile, artifact write, or solver work | `preflightGroupBounds()` composed bounds-first with `preflightGroupClaimIds()` in logic analysis | Invalid compile groups emit a group-scoped `logic.invalid_group` finding and perform zero solver work; oversized groups degrade gracefully instead of aborting the run, and `compileSpecSmtlib()` size `precondition` guards remain as unreachable backstops |
| **D-16** | Formalization and solver grouping derive keys from one shared semantic selector: mapped `logicalFile`, synthetic `<merged-spec/{capability}>` fallback, or verbatim provenance file for capability-less claims | `selectClaimLogicalFile()`; map construction in `run-cli.ts` | Key drift or selectable batch-per-file behavior is impossible in the production path; keys use exact string equality without normalization |
| **D-17** | Every eligible requirement or scenario claim occurs exactly once in semantic grouping; groups are first-key ordered and members preserve eligible input order | `groupFormalizationClaims()` and `splitPhysicalBatches()` | Claims are not lost or duplicated; physical chunks preserve the semantic key and terminate for every valid `maxBatchSize` |
| **D-18** | The zero-based original eligible index is authoritative for internal response matching and additional-sample merging; claim IDs are display/evidence metadata only | indexed formalization claims; `matchAttachedBatchResponse()`; index-keyed sample merge | Missing or duplicate IDs cannot cross-merge samples or misattribute a response |
| **D-19** | Multi-claim context is schema-versioned JSON serialized as deterministic UTF-8 bytes, with explicit indexes, `null` for missing IDs, and verbatim provenance paths | `BatchContextFile`; `serializeBatchContext()` | The exact bytes can be hashed and reconstructed; source claims and provenance are not mutated |
| **D-20** | Attached context follows `not_created -> dir_created -> file_written -> cleanup_succeeded or cleanup_failed`; durable batch evidence contains pointers and the context hash but no claim text | `batch-transport.ts`; `FormalizationOutput.batchAttempts`; manifest writer | Cleanup is attempted for every created directory; cleanup failure after success warns without discarding candidates |

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
| **I-7** | All durable output writes remain confined to the configured output directory; ephemeral attached batch context is the explicit OS-temp exception and is cleaned by its own lifecycle | `resolveConfinedOutputPath()` with `precondition` assertion in filesystem adapter; `batch-transport.ts` lifecycle |
| **I-8** | No shell interpolation in subprocess calls | `shell: false` in `process.ts`; argv-based `execFile`, never `exec` |
| **I-9** | Prompt construction treats all analyzed document content and attached batch JSON as untrusted data; no spec text is elevated into instruction position, and attached multi-claim prompts contain no claim bodies | `sanitizeForCodeFence()` in `fence.ts`; fenced inline prompts and `ATTACHED_BATCH_FORMALIZATION_PROMPT` |
| **I-10** | The resolved run configuration is immutable once analysis begins | CLI layer freezes `RunConfig` before pipeline starts |
| **I-11** | Formalization and solver grouping use the same semantic key and the same map instance, with solver-specific filtering applied before grouping | `run-cli.ts`; `selectClaimLogicalFile()`; `groupFormalizationClaims()` and `groupRepresentativesBySpec()` |
| **I-12** | Every eligible claim reaches one terminal formalization outcome: a candidate or an explicit claim-level error | indexed physical-batch results, fallback handling, and worker-failure normalization |
| **I-13** | Attached context cleanup is attempted after every handled path that creates a temp directory; cleanup failure after successful formalization does not discard candidates | `formalizeAttachedBatch()` `finally` path and `formalization.temp_cleanup_failed` warning |
| **I-14** | The grouping map includes merged specs with requirements or scenarios, but this broader activity filter is used only for map construction; claim-graph and solver-input filters remain narrower | `activeMergedSpecsForGrouping()`; `run-cli.ts`; solver filtering before `groupRepresentativesBySpec()` |

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
| Formalization | Eligible claims (requirements and scenarios) exist; the shared logical-file map is validated; `opencode` is available | Semantic groups produce indexed candidates or claim-level errors; attached-attempt metadata is available to reporting; successful candidates proceed to clustering | Terminal model-response failures may degrade per claim; infrastructure failures become claim errors; zero candidates aborts with `FormalizationError` |
| Clustering | Formalization samples exist; `z3` available | Equivalence clusters with representative selection; ambiguity surfaced as findings | `AdapterError` on solver failure |
| Logic analysis | Representative formalizations exist; `z3` available | Obligation-aware contradiction, completeness, and gap detection; evidence persisted verbatim | `AdapterError` on solver failure |
| Source traceability | `--src` provided and readable | Each claim traced to source evidence or gap finding emitted; evidence levels classified | `CatalogError` on unreadable source |
| Code-derived generation | Source evidence available per capability | EARS-preferring specs generated blind to original text; written to `gen_specs/` | `AdapterError` on LLM failure |
| Code-derived formalization | Generated specs available | Formalized claims with SMT-LIB artifacts written to `gen_specs_smt/` | `FormalizationError`, `AdapterError` |
| Code-derived logic analysis | Code-derived formalizations available; `z3` available | Internal consistency check of code-derived formalizations | `AdapterError` on solver failure |
| Cross-side implication | Both original and code-derived formalizations available; `z3` available | Bidirectional solver-backed classification per matched pair; greedy matching with deterministic tiebreaking | `AdapterError` on solver failure |
| Blind comparison | Cross-side results available; `opencode` available | Explanatory rationale for each classification; blind boundary preserved | `AdapterError` on LLM failure |
| Reporting | At least one phase completed | Phase reports, synthesized summary, and manifest written atomically | `OutputError` on write failure |

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
    ResolveConfig --> ValidateInputs: config valid
    ResolveConfig --> FatalExit: invalid config
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

#### Invariants

| ID | Invariant |
|---|---|
| TL-1 | Help and version do not run analysis or contact external tools |
| TL-2 | Invalid arguments produce exit code `2` before any output is written |
| TL-3 | CLI flags take precedence over config file values |
| TL-4 | `PipelineAbortError` carries `ErrorCategory` for exit code mapping |

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
    RunFormalization --> RunClustering: candidates available; indexed batch evidence collected
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
| formalization | each eligible claim reaches a valid candidate or an explicit claim-level error | zero valid candidates phase-wide after bounded batch, fallback, and additional work | `FormalizationError` at the CLI boundary; partial candidates and per-claim errors continue |
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
| SF-3 | Formalization uses semantic grouping and stable physical batching: multi-claim first samples use attached JSON context, single-claim attempts use the inline path, model-response failures degrade to bounded per-claim inline calls, and additional samples are bounded per-claim calls |
| SF-4 | Clustering pair enumeration is deterministic (left < right) |
| SF-5 | Logic analysis two-phase approach: satisfiability first, unsat-core extraction only on contradiction |
| SF-6 | Deeper pairwise guard-activation and completeness sub-checks aggregate `timeout`/`unknown` verdicts into a single `logic.inconclusive` finding, consistent with the query-level inconclusive flow |
| SF-7 | Structurally invalid compile groups (duplicate raw or sanitized claim IDs, or size beyond `CLAIMS_PER_GROUP_MAX` / `DECLARATIONS_PER_CLAIM_MAX`) are rejected before any compile, artifact write, or solver query — zero solver work (D-15) |
| SF-8 | Merge conflicts exclude the conflicting claim rather than aborting the group; the authoritative surviving-claim set for all downstream checks is `compiled.claimIds` (D-14) |

#### Safety and Liveness

- Safety: no invalid formalization sample enters clustering or solver analysis.
- Safety: formalization and solver analysis use one shared semantic grouping key; a merged capability may span multiple provenance files without splitting its logical group.
- Safety: original eligible indexes, not optional or duplicate claim IDs, control attached response matching and additional-sample merging.
- Safety: attached JSON is untrusted data and contains claim text only in the ephemeral context file, never in the attached prompt body or instruction position.
- Safety: every handled formalization failure produces a candidate or an explicit claim-level error for each affected eligible claim; no worker failure drops unstarted claims.
- Safety: attached-attempt evidence contains metadata and a context hash, not duplicated claim text; deleted context remains byte-verifiable from preserved claim pointers.
- Safety: inconclusive solver results are preserved as findings, not treated as success.
- Safety: structurally invalid or oversized compile groups perform zero solver work; they degrade to a `logic.invalid_group` finding instead of aborting the run.
- Safety: spec-combine merge conflicts surface `logic.merge_conflict` findings while surviving claims continue to analysis; no conflicting declaration silently overwrites another (first-wins).
- Liveness: each LLM call is bounded by retry count (default 3) and universal per-call timeout from run config (default 300s).
- Liveness: each physical batch reaches a terminal lifecycle state; a created temp directory is cleaned after success, model failure, adapter failure, thrown adapter failure, or partial write failure.
- Liveness: `timeout`, `invalid_json`, and `schema_validation_error` on an attached batch receive bounded per-claim inline degradation; `spawn_error`, `invalid_files`, and `invalid_timeout` become claim errors without futile fallback; `prompt_too_large` degrades only when every inline prompt fits the adapter limit.
- Liveness: `maxBatchSize=0` terminates as one unbounded physical batch per semantic group; positive bounds use terminating stable slices.
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

Relevant code: [`src/domain/reporting/render.ts`](src/domain/reporting/render.ts), [`src/domain/reporting/manifest.ts`](src/domain/reporting/manifest.ts)

```mermaid
stateDiagram-v2
    [*] --> InvalidateStaleManifest
    InvalidateStaleManifest --> RenderPhaseReports
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
| finding has valid shape | render normally | included in report |
| finding has malformed shape | replace with `reporting.unsupported_verdict` defect | defect visible in report |
| all phase reports written | compute SHA-256 checksums | manifest entries ready |
| all checksums computed | write `manifest.json` atomically | run marked complete |

#### Invariants

| ID | Invariant |
|---|---|
| RP-1 | Stale manifest is removed at run start before any new output is written |
| RP-2 | Manifest is the final file written in the output directory |
| RP-3 | Report writes are atomic (temp + rename) |
| RP-4 | Manifest checksums match the content written to disk |
| RP-5 | Malformed findings are never silently dropped; they are replaced with defect markers |

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
- phase groups execute in strict order: ingestion → analysis → source → reporting
- `PipelineAbortError` bridges domain `ErrorCategory` into the exception world for progress-event infrastructure compatibility
- each phase emits exactly one `started` event and one `completed`/`failed` event

### 7.2 Formalization and Solver Sequence

Relevant code: [`src/domain/formal/formalize.ts`](src/domain/formal/formalize.ts), [`src/domain/formal/clustering.ts`](src/domain/formal/clustering.ts), [`src/domain/formal/smtlib.ts`](src/domain/formal/smtlib.ts), [`src/domain/formal/logic-analysis.ts`](src/domain/formal/logic-analysis.ts)

```mermaid
sequenceDiagram
    participant CG as Claim Graph
    participant F as Formalize
    participant V as Validate
    participant OC as opencode
    participant CL as Clustering
    participant SM as SMT-LIB Compiler
    participant Z as z3
    participant LA as Logic Analysis
    participant FS as Output Dir

    CG->>F: eligible claims (requirements + scenarios)
    F->>F: build shared semantic groups and stable physical batches
    alt one claim in physical batch
        F->>OC: inline formalization prompt
    else multiple claims in physical batch
        F->>F: serialize indexed BatchContextFile and hash exact bytes
        F->>F: mkdtemp(spec-check-batch-) and write batch-context.json (wx, 0600)
        F->>OC: dedicated attached-context prompt + JSON file
    end
    OC-->>F: raw JSON with explicit response indexes
    F->>V: validate phase schema, indexes, and Logic IR entries
    alt attached model-response failure
        F->>F: terminal-kind policy; bounded per-claim inline degradation when allowed
    else attached infrastructure or transport failure
        F->>F: claim-level errors; no futile fallback
    else valid
        V-->>F: index-keyed LogicIrClaim results
    end
    F->>F: cleanup temp directory in finally; assemble pointer/hash evidence with terminal cleanup outcome
    F->>OC: bounded inline calls for additional samples when requested
    F-->>CL: indexed FormalizationCandidates, errors, findings, and batchAttempts
    CL->>SM: compile pairwise implication queries
    SM-->>CL: SMT-LIB for left ⇒ right and right ⇒ left
    CL->>Z: run implication checks (bounded concurrency)
    Z-->>CL: sat/unsat/timeout/unknown/error per pair
    CL->>CL: BFS connected components on mutual implication
    CL-->>LA: representative per claim from largest stable cluster
    LA->>SM: compile one semantic logical-group SMT-LIB
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
    LA-->>CG: findings + report markdown; batchAttempts -> reporting manifest
```

Protocol rules:

- formalization uses one semantic grouping path: build the capability/logical-file map once, group requirements and scenarios by the shared exact-string key, and apply solver-specific filtering only before solver grouping
- first-sample physical batches preserve semantic keys and eligible input order; `maxBatchSize=0` is one unbounded batch per semantic group, while positive values use stable slices
- single-claim first samples stay inline; multi-claim first samples use a deterministic attached JSON context with explicit original eligible indexes; the prompt body contains no claim bodies
- terminal attached `timeout`, `invalid_json`, and `schema_validation_error` failures degrade to bounded per-claim inline calls; `spawn_error`, `invalid_files`, and `invalid_timeout` become claim-level errors; `prompt_too_large` degrades only after an all-inline-prompts-fit pre-check
- the original eligible index is authoritative for response matching and additional-sample merging; `claim.id` is display/evidence metadata only
- attached context is cleaned in `finally`; attempt evidence includes the terminal cleanup outcome and is persisted to the reporting manifest as pointer/hash metadata without claim text
- compiled SMT-LIB excludes solver commands until query execution time
- implication queries contain exactly one `(check-sat)`
- per-logical-group logic analysis uses a two-phase strategy: satisfiability first, unsat-core extraction only on contradiction
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
| **Semantic grouping drift** | Formalization and solver derive different keys, or a merged capability is split by provenance file | Solver conclusions no longer correspond to formalization evidence | Build the map once; use `selectClaimLogicalFile()` in both paths; preserve exact key semantics and verify parity |
| **Claim identity drift** | Response matching or additional-sample merging uses optional or duplicate `claim.id` | Samples or formalizations can be assigned to the wrong claim | Thread original eligible indexes through grouping, context, response validation, and sample merging |
| **Attached context prompt injection** | Claim text or JSON content is interpreted as instructions | Model behavior and formalization attribution can be manipulated | Dedicated prompt marks attached JSON as untrusted; prompt contains no claim bodies; response indexes are explicit and validated |
| **Batch context leak** | Temp context survives a handled success, failure, or partial write | Full claim text remains on disk and evidence becomes hard to audit | Fresh `mkdtemp` directory, exclusive `0600` write, cleanup in `finally`, and cleanup warning/error classification |
| **Unreconstructable batch evidence** | Deleted context has no durable identity or byte hash | Reviewers cannot verify what an attached attempt contained | Record ordered eligible indexes, IDs, provenance files, prompt/model metadata, outcome, cleanup, and SHA-256 over exact serialized bytes; do not duplicate claim text |
| **False negative analysis** | Missed by tool | Undermines core product value | Multi-layer analysis (qualitative + formal + coverage) |
| **Nondeterministic material divergence** | Repeated runs surface different findings | Weakens trust in dependability cases | Deterministic core; nondeterminism isolated at boundaries |
| **Evidence loss** | Reports omit provenance or evidence | Weakens findings even when correct | Provenance propagation; evidence preservation invariants |
| **`opencode` unavailable** | Adapter timeout or spawn failure (ENOENT) | Critical phases cannot complete | Fail fast with `QualitativeError` or `FormalizationError` |
| **`z3` unavailable** | Binary absent or non-executable | Solver phases cannot complete | Fail fast with `DependencyError` at dependency check phase |
| **Solver timeout/unknown** | No definitive sat/unsat result within 30s | Incomplete formal analysis | Preserve as findings; classify as `uncertain` or `logic.inconclusive` |
| **Solver error diagnostic** | `(error ...)` lines in Z3 output | Malformed SMT-LIB from formalization | Surface as `logic.solver_error` finding; error overrides any verdict |
| **Invalid LLM response** | Schema validation failure at adapter boundary, including unknown, duplicate, missing, or non-integer attached response indexes | Batch result cannot be safely attributed | Bounded adapter retries; terminal attached `invalid_json`/`schema_validation_error`/`timeout` failures degrade per claim; unmatched indexes never fall through silently |
| **Terminal infrastructure failure** | Attached call returns `spawn_error`, `invalid_files`, or `invalid_timeout` after adapter retries; temp creation/write fails; adapter throws | A physical batch cannot be safely retried through the same boundary | Return claim-level `FormalizationError` values for affected claims; do not issue futile per-claim fallback; normalize thrown values as `unknown` |
| **Prompt too large** | Adapter measures instruction prompt over 32,768 UTF-8 bytes | Attached attempt or inline fallback cannot be sent | Degrade only if every per-claim inline prompt fits the same limit; otherwise return claim-level errors without fallback calls |
| **Prompt injection** | Inline claim text or attached JSON is elevated to system position | Distorted analysis or response attribution | `sanitizeForCodeFence()` for inline content; dedicated attached prompt identifies JSON as untrusted data and excludes claim bodies |
| **SMT-LIB syntax collision** | User-derived identifiers with reserved chars | Malformed solver inputs | `sanitizeIdentifier()` with hex escaping; reversible mapping comments |
| **Report Markdown injection** | Untrusted evidence text contains Markdown control syntax | Findings spoof report structure, links, or emphasis | `neutralizeMarkdownInline()` neutralizes links, emphasis, code spans, table pipes, headings, block quotes, list items, and table-cell breakout (`RAE-EVID-RENDER-SAFE`) |
| **Blind boundary violation** | Original text exposed to code-derived side | Undermines comparison methodology | Structural enforcement; violations surfaced as analysis defects |
| **Manifest written prematurely** | Manifest before all outputs finalized | Partial output trusted as complete | `invalidateStaleManifest()` at run start; manifest written last |
| **Output write failure** | Filesystem error during atomic write | Incomplete evidence set | Exit with `OutputError`; no manifest written; temp file cleaned up |
| **Conflicting in-development deltas** | Multiple deltas modify same capability | Hidden coordination failure | Surface as findings, not silent resolution; lexicographically first wins |
| **Parser loss** | Unrecognized content silently dropped | Missing requirements or constraints | Loss-aware parser: unmatched lines preserved as evidence and findings |
| **Path traversal** | Output path escapes configured directory | Filesystem overreach | `resolveConfinedOutputPath()` with `precondition` assertion |

### 8.4 Failure Taxonomy

**Unsafe inputs:** Malformed identifiers, missing sections, unreadable files, invalid config, malformed task content, output directory inside source directory.

**Fragile formats:** OpenSpec files are close to structured prose. Minor heading or identifier drift can silently distort meaning unless the parser is loss-aware and validates structure explicitly.

**Inadequate control actions:** Continuing after invalid LLM responses, missing solver binaries, or provenance-free claims would create misleading output.

**Process model flaws:** False negatives, nondeterministic divergence between runs, and blind trust in opaque heuristics.

**Coordination failures:** Timeouts, retries, physical batches, and optional phases can produce confusing results unless phase boundaries, identity attribution, terminal outcomes, and skipped-scope reporting are explicit.

### 8.5 Control and Recovery

- Validate early: reject invalid paths, malformed config, missing dependencies, and empty input conditions before deeper processing.
- Validate `samplesPerClaim`, optional `concurrency`, `maxBatchSize`, and shared logical-file map values before any LLM or filesystem work.
- Apply the adapter error policy only after terminal adapter retries: degrade attached model-response failures (`timeout`, `invalid_json`, `schema_validation_error`) per claim, reject infrastructure failures (`spawn_error`, `invalid_files`, `invalid_timeout`) as claim errors, and pre-check all inline prompts before `prompt_too_large` fallback.
- Retry bounded external calls with explicit timeouts and fail hard when required evidence-producing phases remain unavailable.
- Preserve inconclusive states (timeouts, unknown solver responses) as findings rather than treating them as success.
- Preserve partial formalization: a failed physical batch becomes claim-level errors while sibling batches continue; zero candidates still aborts at the CLI boundary with `PipelineAbortError("FormalizationError", ...)`.
- Attempt cleanup in `finally`, then persist attached batch evidence with the terminal cleanup outcome; cleanup failure after successful candidates becomes `formalization.temp_cleanup_failed` without discarding those candidates.
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

### 8.7 Signal Handling

- During LLM or solver calls: SIGINT/SIGTERM immediately abort the current external call and exit without writing the manifest. Intermediate artifacts already written remain under the output directory.
- During report writing: If killed between artifact write and manifest write, intermediate artifacts may be present but the manifest is absent, signaling an incomplete run.
- The tool does not trap SIGKILL. Under SIGKILL, no cleanup occurs and manifest absence is the only indicator of incompleteness.

---

## 9. Safety and Liveness Claims

### 9.1 Safety Properties

| Claim | Mechanism | Verification |
|-------|-----------|--------------|
| **No analysis proceeds with incomplete catalog** | Catalog validation before deeper phases; `PipelineAbortError` on failure | Contract tests; integration tests |
| **No claim enters the graph without provenance** | Claim graph builder validation; `detectOrphanClaims()` | Property tests; orphaned-claim detection |
| **No key drift between formalization and solver** | One `logicalFileByCapability` map is built in `run-cli.ts`; both paths call `selectClaimLogicalFile()`; solver filtering occurs before grouping | Semantic-group contract/property tests; integration oracle; Alloy `parity_by_shared_key` check |
| **No claim loss in formalization** | Eligible requirement/scenario claims are indexed, grouped once, physically sliced without changing keys, and converted to candidate or claim-level error on every handled path | Grouping completeness, fault-injection, worker-failure, and Alloy `all_claims_reach_terminal_outcome` checks |
| **No claim-ID identity confusion** | Original eligible index is authoritative for attached response matching and additional-sample merging; IDs are informational metadata | Duplicate-ID and missing-ID contract/property tests |
| **Attached claim text is never instruction authority** | Inline text is fenced; attached JSON is explicitly untrusted and absent from the prompt body; required response indexes are validated | Prompt negative and adversarial injection tests; Alloy/data-boundary review |
| **No temp context survives without classification** | Fresh temp directory, exclusive `0600` fixed-file write, cleanup in `finally`, and explicit cleanup outcome in evidence | Lifecycle fault-injection tests; Alloy `cleanup_attempted_after_handled_terminal_states` check |
| **Attached attempt remains auditable after deletion** | Evidence records ordered indexes, IDs, provenance, prompt/model metadata, outcome, cleanup, and SHA-256 over exact serialized bytes; claim text is pointer-based | Evidence metadata/hash/reconstruction tests; Alloy `evidence_recorded_for_every_attached_attempt` check |
| **No formalization sample enters clustering without schema validation** | `validateFormalizationSample()` with structural checks on variables, functions, sorts, assertions | Contract tests |
| **No solver conclusion from unvalidated formalization** | Pipeline ordering enforced by domain types; clustering only accepts validated `LogicIrClaim` | Integration tests |
| **No blind comparison exposes original requirement text** | Structural boundary enforcement in `derive.ts` and `blind-compare.ts` | Property tests; boundary violation detection |
| **No code-derived generation exposes original requirement text** | Generation receives only source evidence and capability name suggestions | Property tests |
| **No manifest written before all outputs finalized** | `invalidateStaleManifest()` at start; `writeManifest()` as final I/O | Integration tests |
| **No unsupported verdict reaches final report** | Report rendering replaces malformed findings with `reporting.unsupported_verdict` defects | Contract tests |
| **No shell injection** | Argv-based `execFile` only with `shell: false`; no `exec` in codebase | Codebase invariant |
| **No durable writes outside output directory** | `resolveConfinedOutputPath()` with `precondition` assertion; ephemeral attached context is created only in a fresh OS-temp directory and is not a durable output artifact | Contract and lifecycle tests |
| **Solver inputs/outputs always persisted** | Adapter-level persistence via `writeOutputAtomic()` | Integration tests |
| **Findings never silently removed** | Monotonic `addFindings()` in `RunState` with length postcondition | Property tests |
| **No archived spec participates in active analysis** | Catalog classification excludes archived paths | Contract tests |
| **Parser never silently drops content** | Unmatched lines become unparsed evidence and structural findings | Property tests |

### 9.2 Liveness Properties

| Claim | Mechanism | Bound |
|-------|-----------|-------|
| **Qualitative analysis completes** | If `opencode` responds with valid output within retry bounds | Bounded retries (default 3) with universal per-call timeout (default 300s) |
| **Formalization reaches terminal outcomes** | If each adapter/worker call returns or throws within its bounds | Semantic groups, stable physical batches, bounded adapter retries, bounded per-claim degradation, and claim-level normalization of handled failures |
| **Attached context reaches cleanup terminal state** | If the process is not forcibly killed after a temp directory is created | `mkdtemp`/write/attach lifecycle followed by `finally` cleanup; cleanup failure is classified and surfaced |
| **Formalization degrades without futile work** | If a model-response batch failure occurs and every inline fallback prompt fits | `timeout`, `invalid_json`, and `schema_validation_error` degrade per claim; infrastructure kinds do not; `prompt_too_large` uses an explicit UTF-8 pre-check |
| **Batch evidence remains reconstructable** | If preserved source claims and reporting output remain available | Pointer-based metadata plus deterministic serialization and SHA-256; temp file itself is intentionally ephemeral |
| **Solver analysis completes** | If `z3` responds within per-query timeout | Per-query timeout (default 30s) |
| **Cross-side implication completes** | If `z3` responds within per-query timeout | Per-query timeout; pair budget bounds total work (default 200) |
| **Pairwise deeper-check completes** | If `z3` sub-check queries respond within per-query timeout; bounded fan-out via `mapBounded` | `PAIRWISE_SOLVER_CONCURRENCY` (3) plus one completeness query per group (per-group solver peak 4; global peak `concurrency × 4`); sub-check `timeout`/`unknown` surfaces one aggregated `logic.inconclusive` warning |
| **Code-derived generation completes** | If `opencode` responds within timeout | Bounded retries per capability; per-call timeout (default 300s) |
| **Code-derived formalization completes** | If `opencode` responds within retry bounds | Bounded retries per capability |
| **Manifest is written** | If all required phases complete without fatal error | Pipeline completion triggers manifest write |
| **Signal handlers fire cleanup** | Process-level SIGINT/SIGTERM listeners | Immediate (kernel delivery) |
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
| **External formal model** | Semantic grouping, physical batching, lifecycle, and claim-partition invariants checked in the single Alloy module [`openspec/changes/semantic-batching/specs/formalization-and-logic-analysis/alloy/semantic-batching.als`](../openspec/changes/semantic-batching/specs/formalization-and-logic-analysis/alloy/semantic-batching.als) via the repository-pinned Alloy 6.0.2 tool |
| **Property-based tests** | Parser invariants, claim extraction invariants, clustering determinism, implication classification symmetry, blind boundary enforcement, manifest integrity, run-state monotonicity |
| **Contract tests** | CLI argument handling, config merge precedence, parser structural checks, EARS classification, LLM schema validation, SMT-LIB sanitization, manifest semantics, boundary violation detection, obligation-aware severity |
| **Integration tests** | End-to-end analyses with fixture specs plus fake `opencode` and fake `z3` adapters |
| **Determinism tests** | Re-run with fixed inputs and cached responses, then diff outputs byte-for-byte |
| **Invariant tests** | Repository-wide safety and liveness rules |
| **Fault injection tests** | Graceful degradation when adapters fail or timeout |
| **Adversarial input tests** | Malformed, hostile, or boundary-case inputs handled without crash or misleading results |
| **Oracle/golden tests** | Expected logic encodings and parser outputs as permanent fixtures |
| **Regression fixtures** | Every discovered ambiguity pattern, counterexample, and parser-loss issue as a permanent fixture |

### 11.3 Key Test Categories

**Contract tests** validate capability and logical-group requirements:
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
| prompt injection and attached data boundary | Inline document content is fenced; multi-claim attached JSON is explicitly untrusted data, contains the only claim bodies, and is never elevated into instruction position; the dedicated prompt contains no claim bodies | `sanitizeForCodeFence()` in [`src/domain/fence.ts`](src/domain/fence.ts); `ATTACHED_BATCH_FORMALIZATION_PROMPT` in [`src/domain/prompts/formalization.ts`](src/domain/prompts/formalization.ts) |
| filesystem overreach | Durable output writes are confined to `--output`; ephemeral attached context is the explicit fresh-OS-temp exception, with fixed naming, exclusive mode, and cleanup | `resolveConfinedOutputPath()` with `precondition` in [`src/adapters/fs.ts`](src/adapters/fs.ts); [`src/domain/formal/batch-transport.ts`](src/domain/formal/batch-transport.ts) |
| SMT-LIB identifier injection | user-derived identifiers sanitized before writing SMT-LIB artifacts with injective fixed-width-6 escapes | `sanitizeIdentifier()` in [`src/domain/formal/identifiers.ts`](src/domain/formal/identifiers.ts) |
| report rendering injection | untrusted spec-derived finding text (descriptions, provenance, evidence values, related claim IDs) rendered as inert Markdown data; cannot break out of list/table context or inject links, emphasis, code spans, or block structure | `neutralizeMarkdownInline()` in [`src/domain/reporting/render.ts`](src/domain/reporting/render.ts) (`RAE-EVID-RENDER-SAFE`) |
| blind comparison boundary | original requirement text never crosses to the code-derived comparison or generation side | Structural enforcement in [`src/domain/code-backwards/derive.ts`](src/domain/code-backwards/derive.ts) and [`src/domain/code-backwards/blind-compare.ts`](src/domain/code-backwards/blind-compare.ts) |
| subprocess output | captured via stdout/stderr arrays; no ambient shell risk | Chunked accumulation in [`src/adapters/process.ts`](src/adapters/process.ts) |
| evidence integrity | Solver inputs/outputs and model responses are preserved; attached attempts persist claim-text pointers, exact-context SHA-256, prompt/model metadata, outcome, and cleanup status without duplicating claim text | `BatchAttemptEvidence` in [`src/domain/formal/batch-transport.ts`](src/domain/formal/batch-transport.ts); `writeManifest()` in [`src/domain/reporting/manifest.ts`](src/domain/reporting/manifest.ts) |
| temp context hygiene | Attached context is ephemeral, created in a fresh `spec-check-batch-` directory, written as `batch-context.json` with exclusive `0600` permissions, and removed after every handled terminal state | [`src/domain/formal/batch-transport.ts`](src/domain/formal/batch-transport.ts); `finally` cleanup in [`src/domain/formal/formalize.ts`](src/domain/formal/formalize.ts) |
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
| formalization batch attempts | semantic batch key, ordered eligible indexes, IDs, provenance files, prompt/model metadata, outcome, cleanup outcome, and exact-context SHA-256 persisted in the manifest; claim text is reconstructable by pointer and not duplicated | `FormalizationOutput.batchAttempts` -> `writeManifest()` |
| run completion | manifest presence is the atomic completion marker; stale manifests removed at run start |

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
      grouping.ts                shared semantic grouping and physical-batch slicing
      formalize.ts               LLM-backed semantic-group sampling and degradation
      batch-transport.ts         attached context serialization, cleanup, and evidence
      degradation.ts             terminal adapter-error degradation policy
      validate.ts                logic IR schema validation
      clustering.ts              solver-backed equivalence clustering (BFS)
      smtlib.ts                  SMT-LIB compilation and sanitization
      logic-analysis.ts          per-logical-group solver analysis (2-phase)
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
   contract/                     per-capability and logical-group contract tests
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
