## MODIFIED Requirements

### Requirement: Persist Invocation-Scoped Formalization Attempt Evidence [RAE-FORMAL-ATTEMPT-SETS]
WHEN discovery or formalization attempts execute, THE spec-check tool SHALL preserve invocation-scoped pointer metadata and separately stored raw response evidence across attached, inline, retry, fallback, and complete-failure paths before their outcomes are published.

**References:**
- [Design: Interface Contracts](../../design.md#interface-contracts)
- [Design: Resource bounds and encoding](../../design.md#resource-bounds-and-encoding)

#### Scenario: Persist Separate Atomic File Per Invocation [RAE-FORMAL-ATTEMPT-ATOMIC]
WHEN one specs-forward or generated-spec formalization invocation produces attempt evidence, THE spec-check tool SHALL atomically finalize one `FormalizationAttemptSet` index with its existing `claimSet` namespace and local claim indexes plus references to separate bounded raw response artifacts.

**Postcondition:** Pointer metadata does not duplicate attached claim bodies; raw attempts and normalized samples remain independently inspectable and checksummed.

#### Scenario: Failed Run May Retain Attempt Evidence [RAE-FORMAL-ATTEMPT-FAILED-RUN]
IF a run fails or terminates after evidence finalization, THEN THE spec-check tool SHALL permit finalized partial evidence to remain with no successful current core manifest.

#### Scenario: Inline And Rejected Attempts Are Durable [RAE-ATTEMPT-ALL-PATHS]
WHEN inline, additional-sample, rejected-schema, invalid-expression, or all-invalid attempts occur, THE spec-check tool SHALL retain each captured response, attribution, validation outcome, and failure status even if no candidate survives.

#### Scenario: Transport Overflow Is Not A Complete Response [RAE-ATTEMPT-OVERFLOW]
IF a process exceeds its existing capture limit, THEN THE spec-check tool SHALL preserve captured evidence with terminal overflow classification rather than claim a complete raw response or retry beyond the existing overflow policy.

#### Scenario: Every Model Phase Has A Capture Bound [RAE-ATTEMPT-BOUND]
WHEN a model attempt executes, THE spec-check tool SHALL enforce an 8-MiB combined stdout/stderr capture ceiling for analysis phases as well as final reporting so admission-time evidence reservation has a finite upper bound.

#### Requirement model

The [analysis lifecycle model](../../models/analysis-lifecycle.als) checks evidence-before-completion and candidate preservation. Attempt capture, invocation-local indexes, raw responses, and handled persistence failures require production-coordinator fault-injection tests as well.

## ADDED Requirements

### Requirement: Bind Conclusions To Exact Analysis Evidence [RAE-SEMANTIC-EVIDENCE]
WHEN a formal conclusion is published, THE spec-check tool SHALL link it to selected source hashes, structured source mappings, disposition, registry and resolution evidence, normalized semantic artifacts, effective configuration, prompt/compiler fingerprints, and exact solver-query evidence.

**References:**
- [Proposal: Preconditions, Postconditions, and Invariants](../../proposal.md#preconditions-postconditions-and-invariants)
- [Design: Resource bounds and encoding](../../design.md#resource-bounds-and-encoding)

#### Scenario: Every Executed Script Has Replay Evidence [RAE-QUERY-EXACT]
WHEN any primary, deeper, clustering, comparison, model, or core script executes, THE spec-check tool SHALL preserve exact commands including `check-sat`, raw captured stdout/stderr, solver version/options, status, source attribution, and stable query identity.

#### Scenario: Failed Auxiliary Extraction Remains Auditable [RAE-QUERY-AUX-FAIL]
IF a model or core extraction fails, THEN THE spec-check tool SHALL preserve both the primary verdict and auxiliary failure evidence with decoding or attribution explicitly unavailable.

#### Scenario: Content Fingerprints Identify In-Place Semantics [RAE-EVIDENCE-IDENTITY]
WHEN new evidence is serialized, THE spec-check tool SHALL retain current version identifiers while recording exact source/configuration/prompt/compiler/registry identity so historical outputs are not represented as the same current analysis contract.

### Requirement: Report Actual Formal Scope And Strength [RAE-FORMAL-STRENGTH]
WHEN reports or the optional final assessment summarize analysis, THE spec-check tool SHALL distinguish analyzed scope, interpretation dependence, assumption authority, and query result strength rather than equate completed execution with correctness.

**References:**
- [Design: Observability](../../design.md#observability)
- [Design: Static query contracts](../../design.md#static-query-contracts)

#### Scenario: Scope Ledger Accounts For Every Statement And Check [RAE-SCOPE-LEDGER]
WHEN analysis completes or degrades, THE spec-check tool SHALL report extracted, eligible, excluded, candidate, failed, and unstable claim counts alongside planned, executed, blocked, skipped, and inconclusive checks with reasons and evidence references.

**Postcondition:** Planned checks partition into executed, blocked, and skipped counts. Executed checks partition into SAT, UNSAT, and inconclusive outcomes; blocked/skipped checks do not count as inconclusive solver executions. An explicitly named unestablished aggregate may include all three nondefinitive categories. Compact ledger records retain their multiplicity and reasons rather than silently dropping dependent pair/equivalence scope.

#### Scenario: Valuations Are Not Reachable States [RAE-STRENGTH-STATIC]
WHEN a static query is SAT or UNSAT, THE spec-check tool SHALL describe its valuation or entailment meaning without claiming executable reachability, temporal safety, all-input realizability, or response completeness beyond the query contract.

#### Scenario: Partial Comparison Is Not Whole-Capability Alignment [RAE-STRENGTH-PARTIAL]
WHEN excluded, unmapped, incompatible, or unstable artifacts limit a comparison, THE spec-check tool SHALL retain that qualification in phase reports, summaries, divergence calculations, and final-assessment input rather than count the capability as fully aligned.

#### Scenario: Model Interpretation Remains Conditional [RAE-STRENGTH-INTENT]
WHEN a conclusion depends on model-proposed concept alignment or a selected interpretation, THE spec-check tool SHALL state that dependency rather than imply solver validity proves natural-language fidelity or implemented behavior.

### Requirement: Enforce Evidence Admission And Completion [RAE-EVIDENCE-ADMISSION]
WHEN evidence-producing analysis is scheduled, THE spec-check tool SHALL reserve bounded capture/persistence capacity and SHALL finalize required evidence before any successful core completion marker.

**References:**
- [Design: Control and Recovery](../../design.md#control-and-recovery)
- [Design: Resource bounds and encoding](../../design.md#resource-bounds-and-encoding)

#### Scenario: Exhausted Evidence Capacity Skips New Work Visibly [RAE-EVIDENCE-BUDGET]
IF the effective evidence capacity of 256 MiB per run by default cannot admit new work, THEN THE spec-check tool SHALL skip that work with an explicit scope limitation instead of executing unrecordable queries or silently truncating evidence.

#### Scenario: Required Write Failure Prevents Completion [RAE-EVIDENCE-WRITE]
IF required attempt or query evidence cannot be atomically written, THEN THE spec-check tool SHALL fail with `OutputError` exit 11 and SHALL leave no successful current-run core manifest.

#### Scenario: New Artifacts Join Existing Cleanup And Manifest Rules [RAE-EVIDENCE-MANAGED]
WHEN discovery, registry, typed IR, alignment, or query evidence paths are introduced, THE spec-check tool SHALL include them in ordered run-start cleanup and successful manifest checksums under the configured output boundary.

**Postcondition:** Before each core manifest publication, recorded semantic evidence is reconciled with the on-disk tree: expected files must exist as regular files with matching checksums, and unexpected files (including temporary artifacts), symlinks, and unsupported types are rejected. Core manifest paths are unique and retain recorder phase provenance. Reconciliation, enumeration, report, and manifest publication failures are required output failures, not successful degraded completion or model errors.

#### Scenario: Optional Final Report Retains Its Lifecycle [RAE-EVIDENCE-FINAL]
WHEN core evidence completes, THE spec-check tool SHALL preserve the existing post-manifest optional `report.md` lifecycle and SHALL keep that derivative report outside the core manifest.

### Requirement: Verify The Static Semantic Contract [RAE-SEMANTIC-VERIFY]
WHEN this analysis change is accepted for release, THE verification harness SHALL record independent semantic-oracle, real-Z3, bounded Alloy, traceability, distribution-parity, and fixed-corpus evaluation evidence.

**References:**
- [Design: Verification Strategy](../../design.md#verification-strategy)

#### Scenario: Independent Oracle Checks Meaning [RAE-VERIFY-ORACLE]
WHEN Boolean and enum query cases are evaluated, THE harness SHALL compare production outcomes with a finite-domain evaluator independent of the production compiler and query planner rather than rely only on Z3 syntax acceptance.

#### Scenario: Analyzer Models Have Positive Witnesses [RAE-VERIFY-MODEL]
WHEN analyzer lifecycle invariants are checked in Alloy, THE harness SHALL run satisfiable witness commands as well as explicit-scope assertions and SHALL record bounded results without claiming a whole-system proof.

#### Scenario: Fixed Corpus Reports Cost And Coverage [RAE-VERIFY-CORPUS]
WHEN the discovery pre-pass is evaluated, THE harness SHALL record corpus identity, model/prompt/configuration/solver identity, token cost, latency, formal coverage, and inconclusive rate without equating higher acceptance with semantic accuracy.
