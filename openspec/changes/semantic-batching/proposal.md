## Motivation

Formalization and solver analysis in `spec-check` must group formalizable claims identically, or downstream logic analysis drifts from the evidence produced during formalization. Today the two phases already group differently: solver grouping (`groupRepresentativesBySpec`) keys claims by capability → merged `logicalFile` with synthetic fallback, while formalization (`formalizeClaims`) still groups by `claim.provenance.file`. With merged capability specs, a capability's claims can originate from multiple provenance files (base plus deltas), so formalization's file-based grouping splits the semantic unit the solver reasons about as one group. The physical transport for multi-claim batches also lacks a precise, auditable contract (prompt wording, temp-file lifecycle, error taxonomy, identity and ordering rules), and additional-sample merging currently keys on `claim.id`, which may be missing or duplicated.

This change moves formalization onto the solver's existing capability/`logicalFile` grouping semantics, extracts one shared key helper used by both phases, and tightens the file-attached batch transport so that grouping, batching, failure handling, identity, and evidence preservation are deterministic, bounded, and auditable — consistent with the lightweight formal methods workflow in `docs/lfm.md`.

## Scope

### In Scope

- Semantic logical-file grouping as the only production grouping path for formalization and solver analysis, covering both requirement and scenario claims.
- One shared semantic key helper (`selectClaimLogicalFile`) used by both formalization grouping and solver grouping; solver-specific filtering happens before grouping and is documented independently.
- `buildLogicalFileByCapability` contract, plus a dedicated `activeMergedSpecsForGrouping()` filter used only for grouping-map construction. Its activity rule (at least one requirement **or** at least one scenario) is deliberately broader than the claim-graph and solver-input filters (at least one requirement); the scenario clause is *defensive*: standalone scenario claims cannot occur in the current merge domain model (merged scenarios derive from requirement blocks only), so the clause should be unreachable in practice but keeps the helper correct if the domain model ever changes.
- Physical sub-batching semantics: `maxBatchSize=0` (default, **unbounded**: one first-sample physical batch per logical group regardless of size), `maxBatchSize=1` (single-claim inline), `maxBatchSize>1` (stable slicing into chunks of size `<= maxBatchSize`); `maxBatchSize` is internal/test-only.
- File-attached JSON context transport for all multi-claim first-sample physical batches; single-claim first-sample attempts remain inline; additional sampling for `samplesPerClaim > 1` issues bounded per-claim calls and is not additional physical sub-batching.
- Batch context file schema (schemaVersion 1), deterministic UTF-8 serialization, random temp directory (prefix `spec-check-batch-`) with fixed `batch-context.json` filename, exclusive `0600` write, and a defined cleanup lifecycle for success, model failure, adapter-return failure, thrown adapter failure, and partial write failure.
- A dedicated file-attached prompt that treats attached JSON as untrusted data, embeds no claim bodies, and requires an explicit `index` field per returned batch entry, validated against the attached claim index (the batch response schema gains a required `index` field; array position alone is never authoritative, and `claim.id` is never used for matching).
- Failure-handling policy applied to *terminal* adapter errors (the adapter's internal retry budget is already exhausted when `callOpencode` returns an error), mapped to the existing `OpencodeError.kind` taxonomy with no new top-level public error categories; graceful per-claim degradation for model-response failures (`timeout`, `invalid_json`, `schema_validation_error`); claim-level `FormalizationError` for infrastructure failures (`spawn_error`, `invalid_files`, `invalid_timeout`); `prompt_too_large` degrades only when every per-claim inline prompt (inline template plus claim text, measured in UTF-8 bytes) fits the adapter prompt-size limit, and otherwise produces claim-level errors immediately.
- Identity and ordering: original eligible index (or claim object identity) is authoritative internally; `claim.id` is display/evidence metadata only; additional-sample merging must not rely on `claim.id` alone.
- Evidence preservation for deleted temp context files using claim-text pointers: each attached attempt records schema version, batch key, ordered claim original eligible indexes, claim IDs when present, provenance files, context SHA-256 over the exact serialized bytes, prompt variant/version, model, sub-batch ordinal, and response/failure classification (including cleanup outcome). Records are collected in a new `batchAttempts` field on `FormalizationOutput`, recorded before temp cleanup (so cleanup classification can be included), threaded to the reporting phase, and persisted in the existing run manifest/evidence output. The deleted context is byte-reconstructable by resolving the recorded claim indexes against preserved source artifacts (claim text) and re-serializing deterministically; the recorded SHA-256 verifies byte-equality of any reconstruction. Claim text is *not* duplicated into the evidence record.
- Updates to `docs/design.md`, `ARCHITECTURE.md`, and the OpenSpec specs `formalization-and-logic-analysis` and `merged-capability-analysis`.

### Out of Scope

- New top-level public error categories in `src/domain/errors.ts`.
- Changes to the LLM provider or adapter binary interface beyond what the attached-file transport already requires.
- Durable retention of full temp context file contents or verbatim claim text in batch attempt evidence (claim-text pointers plus the deterministic serialization contract and SHA-256 are sufficient for byte-verifiable reconstruction).
- Changes to the claim-graph and solver-input activity filters (`requirements.length > 0` in `runClaimGraphPhase` and the logic phase); `activeMergedSpecsForGrouping()` is used only for grouping-map construction.
- Support for standalone scenario claims outside requirement blocks (the scenario-only grouping clause is defensive only; the current merge domain model cannot produce such claims).
- Changes to clustering, logic solving, or reporting semantics beyond consuming the unified grouping.
- Normalization or resolution of `claim.provenance.file` paths (stored verbatim).

## Context

### Background

`spec-check` formalizes spec claims into Logic IR candidates and then runs solver analysis grouped by logical file. The two phases already diverge: `formalizeClaims` groups claims by `claim.provenance.file`, while `groupRepresentativesBySpec` already groups by `Claim.capability` → merged `logicalFile` with the synthetic fallback `<merged-spec/{capability}>`. With merged capability specs, a capability's claims can originate from multiple provenance files (base plus deltas), so formalization batches split what the solver analyzes as one group. The prior plan (`semantic-batching-plan.md`) is superseded by `pasture/semantic_batching_plan.md`, which incorporates review feedback on error taxonomy, identity, ordering, temp-file lifecycle, evidence preservation, data-domain encoding, and verification.

### Affected Systems and Stakeholders

- Formalization phase (`formalizeClaims`, batch transport, prompt construction).
- Solver/grouping phase (shared semantic key helper, pre-grouping filtering).
- Pipeline orchestration (`run-cli.ts` abort behavior for all-error/no-candidate output).
- Maintainers and reviewers who rely on `docs/design.md`, `ARCHITECTURE.md`, and OpenSpec specs as the dependability case.

### Assumptions and Dependencies

- `OpencodeError.kind` remains the local discriminated union for adapter boundary failures, and `callOpencode` returns errors only after its internal retry budget (default 3 attempts) is exhausted; batch-level policy decisions apply to those terminal errors.
- `CapabilityName` and `ClaimId` branded types and their validators already exist.
- The adapter supports file attachments and performs prompt-size checks in UTF-8 bytes.
- Claim text is preserved on `Claim.text` from claim-graph construction through formalization, so attached context files are byte-reconstructable from preserved source artifacts.
- Semantic keys are compared by exact string equality; `provenance.file` is an opaque catalog-produced path string. Key equality therefore does not depend on claim-text line-ending handling.
- Capability uniqueness within the merged specs follows from the merge layer's `capabilityOrder` construction (first-occurrence deduplication by capability). This is an observed property of the merge layer, not a separately asserted postcondition; the map builder does not re-enforce it.

### Constraints

- All code MUST follow `docs/typescript_style.md`: deterministic cores, `Result`-style expected failures, explicit bounds, aggressive assertions, complete TSDoc, `tsc --strict` clean.
- Lightweight formal methods per `docs/lfm.md`: invariants first, pure deterministic helpers, effects pushed to edges, differential/property/fault-injection evidence, every counterexample becomes a regression test.
- No new public error categories; the existing `ErrorCategory` union is complete.
- Temp context files are ephemeral transport artifacts and must not be intentionally retained.

### References

- `pasture/semantic_batching_plan.md` — engineering plan (supersedes `semantic-batching-plan.md`)
- `docs/lfm.md` — lightweight formal methods workflow
- `docs/typescript_style.md` — construction rules
- `docs/design.md` — system design, failure modes, trust boundaries
- `src/domain/errors.ts` — public error taxonomy
- OpenSpec specs: `formalization-and-logic-analysis`, `merged-capability-analysis`

## Domain Model

Entities and relationships (implementation-neutral):

- **Claim**: a formalizable statement from a spec. Has a kind (`requirement` or `scenario`), optional capability, optional claim ID (display/evidence metadata), provenance (including a file string stored verbatim), and text.
- **Capability**: a validated lowercase kebab-case name identifying a merged capability.
- **Merged Capability Spec**: the merged specification for one capability; has a non-empty logical file and zero or more requirements and scenarios. It is *active for grouping* when it has at least one requirement or at least one scenario. In the current merge domain model, merged scenarios derive only from requirement blocks, so a scenario-only merged spec cannot occur; the scenario clause is defensive against future domain evolution (e.g., standalone scenario claims).
- **Logical File**: the semantic grouping identity for a capability, or a synthetic fallback `<merged-spec/{capability}>` when a capability has no mapped logical file.
- **Semantic Key**: the exact string grouping key for a claim: the mapped logical file for capability-bearing claims (with synthetic fallback), otherwise the claim's provenance file. Compared by exact string equality; never normalized.
- **Logical Group**: all eligible claims sharing one semantic key. Ordered by first occurrence of the key in eligible-claim order; claims within a group preserve eligible input order.
- **Physical Sub-Batch**: one first-sample LLM attempt over a chunk of one logical group. Chunking is pure, deterministic, stable slicing: `maxBatchSize > 0` bounds chunk size at `maxBatchSize`; `maxBatchSize = 0` means unbounded (one chunk per logical group). It never changes the semantic key.
- **Batch Context File**: an ephemeral JSON document (schemaVersion 1) carrying the batch key and the ordered claims of one physical sub-batch; serialized byte-deterministically (UTF-8, no BOM, LF newlines, exactly one trailing newline, `JSON.stringify(value, null, 2)`).
- **Temp Context Lifecycle**: `not_created → dir_created → file_written → cleanup_succeeded | cleanup_failed`. Cleanup failure after a successful model response yields a warning `Finding` with category `formalization.temp_cleanup_failed`, not an error.
- **Formalization Outcome**: under all handled failure modes, every eligible claim reaches exactly one terminal outcome — a candidate, or an explicit claim-level `FormalizationError`.
- **Batch Attempt Evidence**: durable metadata for an attached batch attempt — schema version, batch key, ordered original eligible indexes, claim IDs when present, provenance files, context SHA-256 over the exact serialized bytes, prompt variant/version, model, sub-batch ordinal, and response/failure classification (including cleanup outcome). Evidence uses claim-text pointers: the recorded indexes resolve claim text from preserved source artifacts, and the deterministic serialization contract plus SHA-256 make the deleted context byte-verifiable on reconstruction.

## Preconditions, Postconditions, and Invariants

### Preconditions

- `logicalFileByCapability` is always provided in the pipeline path (it may be empty); empty map values are rejected.
- `samplesPerClaim`, `concurrency`, and `maxBatchSize` are safe integers within their domains (`>= 1`, `>= 1`, `>= 0` respectively); invalid values are rejected before processing.
- `model` and `timeoutMs` are validated by existing configuration/adapter paths.
- Merged specs supplied to the map builder have validated capabilities and non-empty logical files.

### Postconditions

- Under all handled failure modes, every eligible claim (`kind === "requirement"` or `kind === "scenario"`) reaches a terminal outcome: candidate or claim-level error. No eligible claim is lost to grouping, sub-batching, temp-file failure, invalid attachments, model-response failure, graceful degradation, or worker-thrown failures. (`candidates.length + errors.length <= eligibleClaims.length` always; equality holds when every claim reaches a terminal outcome.)
- Candidates and errors are emitted in eligible input order where practical; otherwise each output carries explicit claim/index identity and tests do not assume array order.
- Temp context directories are cleaned after success, graceful model failure, adapter-return failure, thrown adapter failure, and partial write failure. SIGINT/SIGTERM handlers also attempt temp cleanup; under `SIGKILL` no cleanup occurs (no handler can run), consistent with the existing signal model in `docs/design.md`.
- Batch attempt evidence (claim-text-pointer metadata and context hash) is recorded for every attached attempt and persisted via the run manifest/evidence output.

### Invariants

- The semantic key is deterministic and shared by formalization and solver grouping; there is exactly one grouping path.
- Every formalizable claim appears in exactly one formalization logical group.
- Physical sub-batching preserves semantic key and claim order; when `maxBatchSize > 0`, chunk sizes are `<= maxBatchSize`; when `maxBatchSize = 0`, each logical group produces exactly one chunk regardless of size; chunk sizes always sum to the group size, and sub-batching terminates for all valid `maxBatchSize`.
- The grouping map covers every capability present on any eligible claim (defensively; the synthetic fallback guarantees a key even if a capability is unmapped).
- Attached batch context serialization is byte-deterministic.
- Original eligible index or claim object identity is authoritative internally; `claim.id` is never sufficient for internal matching unless uniqueness is proven; duplicate or missing claim IDs cannot cause samples to merge into the wrong candidate.
- Input `Claim` objects and `claim.provenance` are never mutated.
- Attached JSON content is treated as untrusted data, never elevated into instruction position; no attached claim text appears in the prompt body.
- Historical file grouping is not a mode; it emerges only when semantic keys equal provenance files.

## Failure Modes

- **Grouping key drift between formalization and solver**: the two phases group the same claims differently, so solver results no longer correspond to formalization evidence. (This drift exists today: formalization groups by `provenance.file` while the solver groups by capability → `logicalFile`.)
  - **Rationale**: Drift silently invalidates the link between formalized candidates and solver verdicts, undermining the dependability case; one shared helper plus parity tests eliminate it.
- **(Defensive) Scenario-only claims would lose their semantic key**: *if* a merged spec with scenarios but no requirements were ever produced, a requirements-only activity filter would exclude it from the logical-file map, falling those claims back to provenance-file grouping. The current merge model cannot produce such specs — merged scenarios derive only from requirement blocks — so this failure mode is documented as unreachable today and handled defensively rather than as a motivating bug.
  - **Rationale**: Scenario-level claims are formalizable; if the domain model ever admits standalone scenario claims, the broader activity rule keeps their grouping correct without a code change.
- **Stale prompt language for attached batches**: the prompt says claims are "from the same spec file" or "presented below" when they are attached JSON.
  - **Rationale**: Inaccurate prompts confuse the model and weaken the untrusted-data boundary that protects against prompt injection.
- **Temp context leak on partial write or adapter failure**: a temp directory survives a handled terminal state.
  - **Rationale**: Temp files contain full claim text; leaking them is a hygiene and confidentiality risk and signals lifecycle bugs.
- **Retrying true infrastructure failures**: per-claim fallback after a *terminal* `spawn_error`, `invalid_files`, or `invalid_timeout` (i.e., after the adapter's internal retry budget is already exhausted).
  - **Rationale**: Repeating the same failed OS/process/validation boundary per claim wastes time and budget without any chance of recovery.
- **Duplicate or missing claim IDs corrupt additional-sample merging**: samples for one claim merge into another claim's candidate. (This bug exists today: additional-sample merging matches by `claim.id` in `formalize.ts`.)
  - **Rationale**: IDs are optional and not guaranteed unique; treating them as identity silently corrupts evidence.
- **Deleted temp context defeats auditability**: no durable record of what was sent.
  - **Rationale**: Context files are deleted by design; preserved metadata plus SHA-256 keeps attempts auditable and reconstructable.
- **Worker-thrown failures drop unstarted claims**: a `mapBounded` worker failure silently abandons eligible claims that never started.
  - **Rationale**: The terminal-outcome invariant is the core liveness claim of formalization; silent loss is intolerable.

## Quality Attributes

- **Correctness**: every eligible claim reaches a terminal outcome; formalization and solver grouping agree on semantic keys for identical inputs.
  - **Target/Threshold**: 100% terminal outcomes under handled failure modes; grouping parity verified by property tests and an integration oracle.
  - **Influence**: Defines the trust boundary of the whole formalization pipeline.
- **Determinism**: grouping, sub-batching, and context serialization are pure and reproducible.
  - **Target/Threshold**: Identical inputs always produce identical keys, groups, chunks, and serialized bytes.
  - **Influence**: Enables differential testing, replay, and byte-level hash evidence.
- **Auditability**: every attached batch attempt preserves reconstructable evidence despite context deletion.
  - **Target/Threshold**: Metadata plus SHA-256 recorded for 100% of attached attempts.
  - **Influence**: Supports review, incident analysis, and the dependability case.
- **Security**: attached JSON is untrusted data; temp files are owner-only and ephemeral.
  - **Target/Threshold**: `0600` exclusive writes; cleanup attempted after every handled terminal state; prompt-injection negative tests pass.
  - **Influence**: Protects the LLM boundary from spec-text injection.
- **Reliability**: bounded retries and explicit degradation; no unbounded work.
  - **Target/Threshold**: All loops, retries, batch sizes, and in-flight work bounded; `mapBounded` worker failures cannot drop unstarted claims.
  - **Influence**: Prevents hangs, budget blowups, and silent data loss.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `formalization-and-logic-analysis`: formalization grouping moves to the solver's existing semantic logical-file grouping via one shared helper; multi-claim first-sample physical batches use attached JSON context with a dedicated prompt; attached JSON is untrusted data; batch responses carry explicit `index` fields validated against attached claim indexes; claim partition is preserved under all handled failure modes (every eligible claim becomes a candidate or explicit error); temp context cleanup and pointer-based evidence preservation are required; model-response failures degrade gracefully per claim; OS/process/file-attachment failures surface as explicit formalization errors; claim ID alone is not internal identity.
- `merged-capability-analysis`: merged capability logical-file keys become the shared grouping authority for requirements and scenarios; scenario-only merged specs contribute logical-file map entries (defensively — unreachable in the current domain model); solver grouping calls the shared key helper rather than duplicating capability fallback logic.
