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
- Batch context file schema (schemaVersion 1), deterministic UTF-8 serialization, random temp directory (prefix `spec-check-batch-`) with fixed `batch-context.json` filename, exclusive `0600` write, and a defined cleanup lifecycle for handled success and failure paths that reach the lifecycle's `finally` block. Process termination is outside the cleanup guarantee and can leave temp artifacts.
- A dedicated file-attached prompt that treats attached JSON as untrusted data, embeds no claim bodies, and requires an explicit `index` field per returned batch entry, validated against the attached claim index (the batch response schema gains a required `index` field; array position alone is never authoritative, and `claim.id` is never used for matching).
- Failure-handling policy applied to *terminal* adapter errors (the adapter's internal retry budget is already exhausted when `callOpencode` returns an error), mapped to the existing `OpencodeError.kind` taxonomy with no new top-level public error categories; graceful per-claim degradation for model-response failures (`timeout`, `invalid_json`, `schema_validation_error`); claim-level `FormalizationError` for infrastructure failures (`spawn_error`, `invalid_files`, `invalid_timeout`); `prompt_too_large` degrades only when every per-claim inline prompt (inline template plus claim text, measured in UTF-8 bytes) fits the adapter prompt-size limit, and otherwise produces claim-level errors immediately.
- Identity and ordering: original eligible index (or claim object identity) is authoritative internally; `claim.id` is display/evidence metadata only; additional-sample merging must not rely on `claim.id` alone.
- Evidence preservation for deleted temp context files using claim-text pointers: each formalization invocation emits one `FormalizationAttemptSet` envelope with `schemaVersion`, a `claimSet` discriminator (`specs_forward`, or `generated_spec` with invocation-local `ordinal` and `capability`), and its attached attempts. Each attempt records batch key, ordered claim indexes local to that `claimSet`, claim IDs when present, provenance files, context SHA-256 over the exact serialized bytes, prompt variant/version, model, sub-batch ordinal, response/failure classification, and cleanup outcome. Reconstruction resolves indexes only within the envelope's identified `claimSet`. Claim text is *not* duplicated into evidence.
- Each `FormalizationAttemptSet` is persisted as a separate atomically finalized attempt-evidence file. Such files may survive a failed or terminated run and do not imply completion. On success, `manifest.json` remains the last-written success marker and lists each attempt-evidence file with its SHA-256 checksum.
- Additional-sample failure after a candidate exists preserves that candidate and emits a warning finding; it never creates a claim-level error. At handled completion the candidate and claim-error index sets are disjoint and their union is exactly the eligible-claim index set.
- Updates to `docs/design.md`, `ARCHITECTURE.md`, and the OpenSpec specs `formalization-and-logic-analysis`, `merged-capability-analysis`, and `reporting-and-evidence`.

### Out of Scope

- New top-level public error categories in `src/domain/errors.ts`.
- Changes to the LLM provider or adapter binary interface beyond what the attached-file transport already requires.
- Durable retention of full temp context file contents or verbatim claim text in attempt evidence (`claimSet`-scoped claim-text pointers plus the deterministic serialization contract and SHA-256 are sufficient for byte-verifiable reconstruction).
- Changes to the claim-graph and solver-input activity filters (`requirements.length > 0` in `runClaimGraphPhase` and the logic phase); `activeMergedSpecsForGrouping()` is used only for grouping-map construction.
- Support for standalone scenario claims outside requirement blocks (the scenario-only grouping clause is defensive only; the current merge domain model cannot produce such claims).
- Changes to clustering or logic-solving semantics, or to reporting semantics beyond separate atomic attempt-evidence files and manifest inclusion/checksums.
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
- Claim text is preserved on `Claim.text` from claim-graph construction through formalization, so attached context files are byte-reconstructable from the source artifacts for the `FormalizationAttemptSet.claimSet` that owns each local claim index.
- Semantic keys are compared by exact string equality; `provenance.file` is an opaque catalog-produced path string. Key equality therefore does not depend on claim-text line-ending handling.
- Capability uniqueness within the merged specs follows from the merge layer's `capabilityOrder` construction (first-occurrence deduplication by capability). This is an observed property of the merge layer, not a separately asserted postcondition; the map builder does not re-enforce it.

### Constraints

- All code MUST follow `docs/typescript_style.md`: deterministic cores, `Result`-style expected failures, explicit bounds, aggressive assertions, complete TSDoc, `tsc --strict` clean.
- Lightweight formal methods per `docs/lfm.md`: invariants first, pure deterministic helpers, effects pushed to edges, differential/property/fault-injection evidence, every counterexample becomes a regression test.
- No new public error categories; the existing `ErrorCategory` union is complete.
- Temp context files are ephemeral transport artifacts and must not be intentionally retained on handled paths; process termination can prevent cleanup.

### References

- `pasture/semantic_batching_plan.md` — engineering plan (supersedes `semantic-batching-plan.md`)
- `docs/lfm.md` — lightweight formal methods workflow
- `docs/typescript_style.md` — construction rules
- `docs/design.md` — system design, failure modes, trust boundaries
- `src/domain/errors.ts` — public error taxonomy
- OpenSpec specs: `formalization-and-logic-analysis`, `merged-capability-analysis`, `reporting-and-evidence`

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
- **Temp Context Lifecycle**: `not_created → dir_created → file_written → cleanup_succeeded | cleanup_failed` for handled paths that reach lifecycle finalization. Cleanup failure after a successful model response yields a warning `Finding` with category `formalization.temp_cleanup_failed`, not an error. Process termination may stop before finalization and leave temp artifacts.
- **Formalization Outcome**: at handled completion, every eligible claim index belongs to exactly one of two disjoint sets: candidate indexes or explicit claim-level `FormalizationError` indexes. Additional-sample failure cannot move an index from the candidate set to the error set.
- **Invocation Claim Set**: the index namespace for one formalization invocation: `specs_forward`, or `generated_spec` identified by a zero-based invocation ordinal and capability. Attempt indexes have meaning only inside this namespace.
- **Formalization Attempt Set**: one invocation envelope containing schema version, its invocation `claimSet`, and the attached attempt records for that invocation. Each attempt contains batch key, ordered `claimSet`-local indexes, claim IDs when present, provenance files, context SHA-256 over the exact serialized bytes, prompt variant/version, model, sub-batch ordinal, response/failure classification, and cleanup outcome. The envelope is one separate atomic evidence file; it is auditable but is not a completion marker.

## Preconditions, Postconditions, and Invariants

### Preconditions

- `logicalFileByCapability` is always provided in the pipeline path (it may be empty); empty map values are rejected.
- `samplesPerClaim`, `concurrency`, and `maxBatchSize` are safe integers within their domains (`>= 1`, `>= 1`, `>= 0` respectively); invalid values are rejected before processing.
- `model` and `timeoutMs` are validated by existing configuration/adapter paths.
- Merged specs supplied to the map builder have validated capabilities and non-empty logical files.

### Postconditions

- Under all handled failure modes, every eligible claim (`kind === "requirement"` or `kind === "scenario"`) reaches exactly one terminal outcome. If `E` is the set of eligible indexes, `C` the candidate indexes, and `R` the claim-error indexes, then `C ⊆ E`, `R ⊆ E`, `C ∩ R = ∅`, and `C ∪ R = E`. No eligible claim is lost to grouping, sub-batching, temp-file failure, invalid attachments, model-response failure, graceful degradation, additional-sample failure, or worker-thrown failures.
- Candidates and errors are emitted in eligible input order where practical; otherwise each output carries explicit claim/index identity and tests do not assume array order.
- Temp context cleanup is attempted after success, graceful model failure, adapter-return failure, thrown adapter failure, and partial write failure when control reaches the lifecycle's `finally` path. There is no SIGINT/SIGTERM cleanup guarantee; process termination can leave temp artifacts and the run manifest absent.
- One separate atomic `FormalizationAttemptSet` evidence file is persisted per formalization invocation. The successful manifest is written last and lists/checksums those files; an evidence file without that manifest does not imply run completion.
- Failure to obtain an additional sample for an existing candidate emits a warning finding, preserves the candidate and its collected samples, and emits no claim-level error for that failure.

### Invariants

- The semantic key is deterministic and shared by formalization and solver grouping; there is exactly one grouping path.
- Every formalizable claim appears in exactly one formalization logical group.
- Physical sub-batching preserves semantic key and claim order; when `maxBatchSize > 0`, chunk sizes are `<= maxBatchSize`; when `maxBatchSize = 0`, each logical group produces exactly one chunk regardless of size; chunk sizes always sum to the group size, and sub-batching terminates for all valid `maxBatchSize`.
- The grouping map covers every capability present on any eligible claim (defensively; the synthetic fallback guarantees a key even if a capability is unmapped).
- Attached batch context serialization is byte-deterministic.
- Original eligible index or claim object identity is authoritative internally; `claim.id` is never sufficient for internal matching unless uniqueness is proven; duplicate or missing claim IDs cannot cause samples to merge into the wrong candidate.
- Attempt indexes are local to the `FormalizationAttemptSet.claimSet`; reconstruction MUST select that claim set before resolving an index and MUST NOT resolve indexes across invocation envelopes.
- Candidate indexes and claim-error indexes form an exact disjoint partition of eligible indexes at handled completion: `C ∩ R = ∅` and `C ∪ R = E`.
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
  - **Rationale**: Context files are deleted by design on handled paths; a separate atomic `FormalizationAttemptSet` plus `claimSet`-scoped indexes and SHA-256 keeps attempts auditable and reconstructable without implying run completion.
- **Additional-sample failure corrupts the claim partition**: a claim that already has a candidate also receives a claim-level error when a later optional sample fails.
  - **Rationale**: Additional samples improve clustering confidence but do not revoke the first valid candidate; the failure is a warning-only shortfall and candidate/error membership must remain disjoint.
- **Worker-thrown failures drop unstarted claims**: a `mapBounded` worker failure silently abandons eligible claims that never started.
  - **Rationale**: The terminal-outcome invariant is the core liveness claim of formalization; silent loss is intolerable.

## Quality Attributes

- **Correctness**: every eligible claim reaches a terminal outcome; formalization and solver grouping agree on semantic keys for identical inputs.
  - **Target/Threshold**: 100% terminal outcomes under handled failure modes; grouping parity verified by property tests and an integration oracle.
  - **Influence**: Defines the trust boundary of the whole formalization pipeline.
- **Determinism**: grouping, sub-batching, and context serialization are pure and reproducible.
  - **Target/Threshold**: Identical inputs always produce identical keys, groups, chunks, and serialized bytes.
  - **Influence**: Enables differential testing, replay, and byte-level hash evidence.
- **Auditability**: every attached batch attempt preserves invocation-scoped, reconstructable evidence despite context deletion; evidence existence is distinct from run completion.
  - **Target/Threshold**: Metadata plus SHA-256 recorded for 100% of attached attempts in separate atomic `FormalizationAttemptSet` files, all listed/checksummed by the successful manifest.
  - **Influence**: Supports review, incident analysis, and the dependability case.
- **Security**: attached JSON is untrusted data; temp files are owner-only and ephemeral.
  - **Target/Threshold**: `0600` exclusive writes; cleanup attempted after every handled terminal state that reaches lifecycle finalization; prompt-injection negative tests pass.
  - **Influence**: Protects the LLM boundary from spec-text injection.
- **Reliability**: bounded retries and explicit degradation; no unbounded work.
  - **Target/Threshold**: All loops, retries, batch sizes, and in-flight work bounded; `mapBounded` worker failures cannot drop unstarted claims.
  - **Influence**: Prevents hangs, budget blowups, and silent data loss.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `formalization-and-logic-analysis`: formalization grouping moves to the solver's existing semantic logical-file grouping via one shared helper; multi-claim first-sample physical batches use attached JSON context with a dedicated prompt; attached JSON is untrusted data; batch responses carry explicit `index` fields validated against attached claim indexes; candidate and claim-error indexes form an exact disjoint partition under handled completion; additional-sample failure preserves the candidate and emits only a warning; cleanup is guaranteed only on handled paths reaching lifecycle finalization; invocation-scoped `FormalizationAttemptSet` evidence preserves local-index reconstruction; model-response failures degrade gracefully per claim; OS/process/file-attachment failures surface as explicit formalization errors; claim ID alone is not internal identity.
- `merged-capability-analysis`: merged capability logical-file keys become the shared grouping authority for requirements and scenarios; scenario-only merged specs contribute logical-file map entries (defensively — unreachable in the current domain model); solver grouping calls the shared key helper rather than duplicating capability fallback logic.
- `reporting-and-evidence`: each formalization invocation writes a separate atomic `FormalizationAttemptSet` evidence file that may survive an incomplete run without implying completion; a successful `manifest.json` remains the final success marker and lists every such evidence file with its SHA-256 checksum.
