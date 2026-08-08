## ADDED Requirements

### Requirement: Shared Semantic Logical-File Grouping [FLA-SEMANTIC-GROUPING]
WHEN the spec-check tool groups formalizable claims (claims with `kind` equal to `requirement` or `scenario`) for formalization or for solver analysis, THE spec-check tool SHALL derive each claim's semantic grouping key from one shared key helper, where a capability-bearing claim keys to the mapped merged capability `logicalFile` or to the synthetic fallback `<merged-spec/{capability}>` when unmapped, and a capability-less claim keys to its `claim.provenance.file`. Semantic keys SHALL be compared by exact string equality without normalization, logical groups SHALL be ordered by first occurrence of the semantic key in eligible-claim order, and claims within each logical group SHALL preserve eligible input order.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Domain Model`
- `openspec/changes/semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/semantic-batching/design.md#Interface Contracts`

#### Scenario: Mapped Capability Groups By Logical File [FLA-SEMGRP-MAPPED]
WHEN a formalizable claim carries a capability that is present in the logical-file map, THE spec-check tool SHALL group that claim under the mapped `logicalFile` value.

**Postcondition:** The claim's semantic key equals the mapped `logicalFile` string exactly.

#### Scenario: Capability-Less Claim Groups By Provenance File [FLA-SEMGRP-PROVENANCE]
WHEN a formalizable claim has no capability, THE spec-check tool SHALL group that claim under its `claim.provenance.file` string, stored verbatim without normalization or resolution.

**Postcondition:** The claim's semantic key equals its provenance file string exactly.

#### Scenario: Unmapped Capability Uses Synthetic Fallback [FLA-SEMGRP-FALLBACK]
WHEN a formalizable claim carries a capability that is absent from the logical-file map (including when the map is empty), THE spec-check tool SHALL group that claim under the synthetic key `<merged-spec/{capability}>`.

**Postcondition:** Capability-bearing claims never fall back to provenance-file grouping merely because the map lacks an entry.

#### Scenario: Historical File Grouping Is Emergent Only [FLA-SEMGRP-EMERGENT]
WHEN the semantic keys of the input claims equal their provenance files, THE spec-check tool SHALL produce groups identical to historical file grouping as an emergent outcome, and SHALL NOT provide file grouping as a selectable mode.

**Postcondition:** There is exactly one production grouping path; legacy-style grouping is an output equivalence, not a configuration.

#### Scenario: Requirements And Scenarios Share Grouping Semantics [FLA-SEMGRP-KINDS]
WHEN a logical group contains both requirement claims and scenario claims, THE spec-check tool SHALL compute their semantic keys with the same shared key helper and SHALL place them in the same logical group when their keys are equal.

**Postcondition:** Requirement and scenario claims with equal semantic keys are never split into separate logical groups by kind.

#### Scenario: Grouping Map Covers All Eligible Capabilities [FLA-SEMGRP-COVERAGE]
WHEN the grouping map is constructed from active merged specs and an eligible claim carries a capability, THE map SHALL contain an entry for that capability, or the claim SHALL receive the synthetic fallback key `<merged-spec/{capability}>`.

**Postcondition:** No capability-bearing claim ever fails to obtain a deterministic semantic key.

#### Scenario: Solver And Formalization Grouping Parity [FLA-SEMGRP-PARITY]
WHEN solver grouping and formalization grouping process the same claims after the same explicit pre-grouping filtering, THE spec-check tool SHALL produce the same semantic key for the same claim inputs in both phases.

**Postcondition:** No key drift exists between formalization groups and solver groups.

#### Scenario: Deterministic Group And Claim Ordering [FLA-SEMGRP-ORDER]
WHEN the spec-check tool forms logical groups, THE groups SHALL be ordered by first occurrence of each semantic key in eligible-claim order, and the claims inside each group SHALL preserve eligible input order.

**Postcondition:** Identical eligible inputs always produce identically ordered groups and group members.

### Requirement: Deterministic Physical Sub-Batching [FLA-SUBBATCH]
WHILE `maxBatchSize` is an internal test-only control, WHEN the spec-check tool forms first-sample physical batches from one logical group, THE spec-check tool SHALL split the group by pure, deterministic, stable slicing such that `maxBatchSize` of `0` yields exactly one physical batch per logical group regardless of group size (unbounded), `maxBatchSize` of `1` yields single-claim inline batches, and `maxBatchSize` greater than `1` yields chunks of size at most `maxBatchSize`, and sub-batching SHALL never change a claim's semantic key.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Scope`
- `openspec/changes/semantic-batching/design.md#Component Design`

#### Scenario: Default Disables Splitting [FLA-SUBBATCH-ZERO]
WHEN `maxBatchSize` is `0` (the default), THE spec-check tool SHALL issue exactly one first-sample physical batch per logical group regardless of how many claims the group contains.

**Postcondition:** No physical sub-batching occurs by default, and the single chunk is unbounded in size.

#### Scenario: Single-Claim Batches When Size One [FLA-SUBBATCH-ONE]
WHEN `maxBatchSize` is `1`, THE spec-check tool SHALL issue every first-sample physical batch as a single-claim inline call.

**Postcondition:** No multi-claim attached batches are issued.

#### Scenario: Stable Chunk Sizes [FLA-SUBBATCH-CHUNKS]
WHEN `maxBatchSize` is `5` and a logical group contains 12 claims, THE spec-check tool SHALL produce physical sub-batches of sizes `[5, 5, 2]` in stable claim order.

**Postcondition:** Chunk sizes never exceed `maxBatchSize`, chunk sizes sum to the group size, and claim order is preserved.

#### Scenario: Invalid Batch Size Rejected [FLA-SUBBATCH-INVALID]
IF `maxBatchSize`, `samplesPerClaim`, or `concurrency` is not a safe integer within its domain (`maxBatchSize >= 0`; `samplesPerClaim >= 1`; `concurrency >= 1`), THEN THE spec-check tool SHALL reject the input with `err(readonly FormalizationError[])` before any LLM or filesystem work.

**Postcondition:** Negative, `NaN`, infinite, or fractional control values never reach grouping, sub-batching, or `mapBounded`.

### Requirement: File-Attached Batch Context Transport [FLA-ATTACH-TRANSPORT]
WHEN a first-sample physical batch contains two or more claims, THE spec-check tool SHALL attach a deterministic JSON context file to the LLM invocation instead of embedding claim bodies in the prompt, and WHEN a first-sample attempt contains exactly one claim, THE spec-check tool SHALL use the inline prompt path. The context file SHALL be schema version 1 with fields `schemaVersion`, `batchKey`, and an ordered `claims` array of `{ index, id, obligation, provenance: { file }, text }`, SHALL serialize with `JSON.stringify(value, null, 2)` as UTF-8 without BOM with LF newlines and exactly one trailing newline, SHALL represent a missing claim ID as `null` while permitting duplicate IDs, and SHALL store provenance path strings verbatim.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Domain Model`
- `openspec/changes/semantic-batching/design.md#Data Design`

#### Scenario: Multi-Claim Batch Uses Attachment [FLA-ATTACH-MULTI]
WHEN a first-sample physical batch contains two or more claims, THE spec-check tool SHALL write the batch context JSON to a temp file and SHALL attach that file to the LLM invocation.

**Postcondition:** The prompt body contains no claim text; claim content travels only in the attached file.

#### Scenario: Single-Claim Batch Stays Inline [FLA-ATTACH-SINGLE]
WHEN a first-sample attempt covers exactly one claim, THE spec-check tool SHALL use the inline prompt path and SHALL NOT create an attached context file.

**Postcondition:** Single-claim formalization behavior matches the existing inline path.

#### Scenario: Byte-Deterministic Serialization [FLA-ATTACH-DETERMINISTIC]
WHEN the spec-check tool serializes a batch context file, THE output SHALL be byte-identical for identical logical content, using UTF-8 without BOM, LF newlines, exactly one trailing newline, and declared key insertion order.

**Postcondition:** The SHA-256 context hash is reproducible from the serialized bytes.

#### Scenario: Missing Claim ID Serializes As Null [FLA-ATTACH-NULL-ID]
WHEN an attached claim has no `claim.id`, THE spec-check tool SHALL serialize its `id` field as `null`.

**Postcondition:** Missing IDs are explicit in the context file and never fabricated.

### Requirement: Dedicated Attached-Context Prompt [FLA-ATTACH-PROMPT]
WHEN the spec-check tool issues a multi-claim file-attached formalization attempt, THE spec-check tool SHALL use a dedicated attached-context prompt that states claims are in the attached JSON file, states the attached JSON is untrusted data rather than instructions, states that each output entry SHALL carry an explicit `index` field matching an attached claim index, states that `claims[].id` is informational and may be `null` or duplicated, requires exactly one output entry per attached claim, and keeps the Logic IR schema inline, and the prompt SHALL NOT embed claim bodies, SHALL NOT state that claims come from the same spec file, and SHALL NOT state that claims are presented below.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Scope`
- `openspec/changes/semantic-batching/design.md#Component Descriptions`
- `openspec/changes/semantic-batching/design.md#Security`

#### Scenario: Prompt References Attached Context [FLA-ATTACHP-REFERENCES]
WHEN a multi-claim attached batch is issued, THE prompt SHALL state that claims are in the attached JSON context file and SHALL contain no claim bodies inline.

**Postcondition:** The model's only source of claim text is the attached file.

#### Scenario: Attached JSON Marked Untrusted [FLA-ATTACHP-UNTRUSTED]
WHEN a multi-claim attached batch is issued, THE prompt SHALL state that the attached JSON content is untrusted data and not instructions.

**Postcondition:** Spec text attached for formalization is never elevated into instruction position.

#### Scenario: No Stale Same-File Language [FLA-ATTACHP-NO-STALE]
WHEN a multi-claim attached batch is issued, THE prompt SHALL NOT contain the phrases "same spec file" or "presented below" or equivalent stale inline-batch wording.

**Postcondition:** Prompt wording is accurate for semantic groups that can span multiple provenance files.

#### Scenario: Response Matching Authority Stated [FLA-ATTACHP-MATCHING]
WHEN a multi-claim attached batch is issued, THE prompt SHALL state that each output entry must carry an explicit `index` field matching an attached claim index.

**Postcondition:** Response-to-claim attribution is explicit; array position alone and `claim.id` are never authoritative.

#### Scenario: Response Index Validated [FLA-ATTACHP-INDEX-VALID]
IF a returned batch entry carries an `index` that is missing, duplicated, or does not match any attached claim index for that physical batch, THEN THE spec-check tool SHALL treat the response as a `schema_validation_error` failure and SHALL degrade to per-claim inline retry.

**Postcondition:** Misattributed responses become detectable schema failures, never silent corruption.

### Requirement: Temp Context File Lifecycle [FLA-TEMP-LIFECYCLE]
WHILE a multi-claim attached batch is in flight, THE spec-check tool SHALL manage the temp context file through the explicit lifecycle `not_created`, `dir_created`, `file_written`, `cleanup_succeeded`, or `cleanup_failed`, SHALL create the directory with `mkdtemp()` using the prefix `spec-check-batch-` separately from file writing, SHALL write the fixed filename `batch-context.json` with UTF-8 encoding, mode `0o600`, and exclusive flag `wx`, and SHALL attempt cleanup after success, graceful model failure, adapter-return failure, thrown adapter failure, and partial write failure.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Domain Model`
- `openspec/changes/semantic-batching/proposal.md#Failure Modes`
- `openspec/changes/semantic-batching/design.md#Key Components`

#### Scenario: Successful Batch Cleans Up [FLA-TEMP-SUCCESS]
WHEN an attached batch attempt completes successfully, THE spec-check tool SHALL remove the temp context directory before returning results.

**Postcondition:** No temp context directory survives a successful attempt.

#### Scenario: Directory Creation Failure Yields Claim Errors [FLA-TEMP-DIRFAIL]
IF temp directory creation fails for a physical batch, THEN THE spec-check tool SHALL return claim-level `FormalizationError` values for every claim in that physical batch.

**Postcondition:** The failure surfaces as claim errors; no claim is silently dropped.

#### Scenario: Write Failure After Directory Creation Cleans Up [FLA-TEMP-WRITEFAIL]
IF the context file write fails after the temp directory was created, THEN THE spec-check tool SHALL attempt cleanup of the created directory before returning claim-level `FormalizationError` values for the physical batch.

**Postcondition:** A `dir_created` state never leaks when writing fails.

#### Scenario: Cleanup Failure After Partial Write Does Not Mask [FLA-TEMP-WRITEFAIL-CLEANUP]
IF cleanup after a partial write failure also fails, THEN THE spec-check tool SHALL include the cleanup failure detail without masking the original write failure.

**Postcondition:** The primary failure remains the reported cause.

#### Scenario: Thrown Adapter Failure Still Cleans Up [FLA-TEMP-THROW]
IF `callOpencode()` throws during an attached batch attempt, THEN THE spec-check tool SHALL attempt temp directory cleanup in a `finally` path and SHALL normalize the thrown failure to claim-level `FormalizationError` values.

**Postcondition:** Temp cleanup does not depend on the adapter returning normally.

#### Scenario: Cleanup Failure After Success Is A Warning [FLA-TEMP-CLEANUP-WARN]
IF cleanup fails after a successful model response, THEN THE spec-check tool SHALL record a warning `Finding` with category `formalization.temp_cleanup_failed` (provenance: batch key and sub-batch ordinal; evidence: cleanup error detail and context hash) and SHALL NOT discard the successful candidates.

**Postcondition:** Successful formalization evidence is never discarded due to cleanup failure, and the failure is diagnosable.

#### Scenario: OS Temp Unwritable Yields Claim Errors [FLA-TEMP-OSUNWRITABLE]
IF the OS temp directory is not writable and `mkdtemp()` fails, THEN THE spec-check tool SHALL return claim-level `FormalizationError` values for every claim in the physical batch.

**Postcondition:** Environment failures surface as ordinary claim errors, not crashes.

#### Scenario: Outcomes Assigned After Cleanup Terminal State [FLA-TEMP-ORDER]
WHEN an attached batch attempt resolves (success, model failure, or infrastructure failure), THE spec-check tool SHALL assign claim outcomes only after the temp lifecycle reaches a terminal cleanup state (`cleanup_succeeded` or `cleanup_failed`). IF no temp directory was created (directory creation failure), THEN claim errors MAY be assigned immediately since no cleanup is owed.

**Postcondition:** The temp lifecycle always precedes outcome assignment when a directory exists; the evidence record may outlive outcome assignment only under process kill, which is acceptable because the record audits what was sent, not what resolved.

### Requirement: Graceful Degradation By Adapter Error Kind [FLA-DEGRADE-KIND]
WHEN a multi-claim attached batch attempt fails with a terminal adapter error (an `OpencodeError.kind` returned after the adapter's internal retry budget is exhausted), THE spec-check tool SHALL select per-claim handling from the existing taxonomy without introducing new public error categories: `timeout`, `invalid_json`, and `schema_validation_error` SHALL degrade to bounded per-claim inline retry; `spawn_error`, `invalid_files`, and `invalid_timeout` SHALL produce claim-level `FormalizationError` values for the affected physical batch with no per-claim fallback; and `prompt_too_large` SHALL degrade only when every per-claim inline prompt (inline template plus claim text, measured in UTF-8 bytes) fits the adapter prompt-size limit, and SHALL otherwise produce claim-level errors immediately.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Scope`
- `openspec/changes/semantic-batching/design.md#Interface Contracts`
- `openspec/changes/semantic-batching/design.md#Failure Mode Analysis`

#### Scenario: Batch Timeout Degrades Per Claim [FLA-DEGRADE-TIMEOUT]
IF an attached batch attempt fails with `timeout`, THEN THE spec-check tool SHALL retry each claim of that physical batch individually through the inline path.

**Postcondition:** Smaller work is attempted before claims are declared failed.

#### Scenario: Invalid JSON Degrades Per Claim [FLA-DEGRADE-JSON]
IF an attached batch attempt fails with `invalid_json`, THEN THE spec-check tool SHALL retry each claim of that physical batch individually through the inline path.

**Postcondition:** Model response failures consume the existing bounded retry budget per claim.

#### Scenario: Schema Validation Error Degrades Per Claim [FLA-DEGRADE-SCHEMA]
IF an attached batch attempt fails with `schema_validation_error`, THEN THE spec-check tool SHALL retry each claim of that physical batch individually through the inline path.

**Postcondition:** Model response failures consume the existing bounded retry budget per claim.

#### Scenario: Spawn Error Does Not Degrade [FLA-DEGRADE-SPAWN]
IF an attached batch attempt fails with `spawn_error`, THEN THE spec-check tool SHALL produce claim-level `FormalizationError` values for every claim in the physical batch and SHALL NOT attempt per-claim fallback.

**Postcondition:** OS/process boundary failures are not retried per claim.

#### Scenario: Invalid Files Does Not Degrade [FLA-DEGRADE-FILES]
IF an attached batch attempt fails with `invalid_files`, THEN THE spec-check tool SHALL produce claim-level `FormalizationError` values for every claim in the physical batch and SHALL NOT attempt per-claim fallback.

**Postcondition:** Attachment validation failures surface immediately as claim errors.

#### Scenario: Invalid Timeout Does Not Degrade [FLA-DEGRADE-INVTIMEOUT]
IF an attached batch attempt fails with `invalid_timeout`, THEN THE spec-check tool SHALL produce claim-level `FormalizationError` values for every claim in the physical batch and SHALL NOT attempt per-claim fallback.

**Postcondition:** Invalid invocation options are never retried.

#### Scenario: Prompt Too Large Degrades Conditionally [FLA-DEGRADE-TOOLARGE]
IF an attached batch attempt fails with `prompt_too_large`, THEN THE spec-check tool SHALL degrade to per-claim inline calls only when every per-claim inline prompt (inline template plus that claim's text, measured in UTF-8 bytes) fits the adapter prompt-size limit, and SHALL otherwise produce claim-level `FormalizationError` values for the physical batch without attempting any fallback call.

**Postcondition:** Fallback is attempted only when it can succeed; no budget is spent on fallback calls guaranteed to fail.

### Requirement: Claim Partition And Terminal Outcomes [FLA-CLAIM-PARTITION]
UNDER all handled failure modes, THE spec-check tool SHALL deliver every eligible claim (claims with `kind` equal to `requirement` or `scenario`) to exactly one terminal formalization outcome: a candidate or an explicit claim-level `FormalizationError`. No eligible claim shall be lost because of grouping, sub-batching, temp-file failure, invalid attachments, model-response failure, graceful degradation, or worker-thrown failures.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/semantic-batching/design.md#Failure Mode Analysis`

#### Scenario: Worker Failure Drops No Claims [FLA-PARTITION-WORKER]
IF a `mapBounded` worker throws while processing a physical batch, THEN THE spec-check tool SHALL convert the failure into claim-level errors for every claim of the affected physical batch, and sibling physical batches SHALL continue processing.

**Postcondition:** Every eligible claim in the failed batch reaches a terminal outcome, and one batch's failure never abandons unstarted claims in other batches.

#### Scenario: Single-Claim Thrown Adapter Failure Normalized [FLA-PARTITION-THROW]
IF the adapter throws during a single-claim inline attempt, THEN THE spec-check tool SHALL catch the thrown value as `unknown` and SHALL normalize it to a claim-level `FormalizationError`.

**Postcondition:** Thrown infrastructure failures become ordinary claim outcomes.

#### Scenario: All-Error Output Aborts Pipeline [FLA-PARTITION-ABORT]
IF formalization returns zero candidates and one or more errors, THEN THE spec-check tool SHALL abort the run with `PipelineAbortError("FormalizationError", ...)` at the CLI boundary.

**Postcondition:** Existing abort behavior for total formalization failure is preserved.

### Requirement: Original Eligible Index Is Authoritative Identity [FLA-IDENTITY-INDEX]
THE spec-check tool SHALL use the original eligible index (the stable zero-based index of a formalizable claim in eligible-claim order) or claim object identity as the authoritative internal identity for grouping, sub-batching, response matching, and additional-sample merging, and SHALL NOT use `claim.id` alone as internal identity because IDs can be missing or duplicated.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/semantic-batching/design.md#Interface Contracts`

#### Scenario: Duplicate IDs Do Not Merge Samples [FLA-IDENTITY-DUP]
WHEN two distinct claims share the same `claim.id` and `samplesPerClaim` is greater than `1`, THE spec-check tool SHALL merge additional samples per claim using original eligible index or object identity so that samples never merge into the wrong candidate.

**Postcondition:** Duplicate IDs cannot corrupt candidate identity.

#### Scenario: Missing IDs Do Not Merge Samples [FLA-IDENTITY-MISSING]
WHEN one or more claims lack `claim.id` and `samplesPerClaim` is greater than `1`, THE spec-check tool SHALL merge additional samples per claim using original eligible index or object identity.

**Postcondition:** Missing IDs are ordinary input, not an identity hazard.

#### Scenario: Output Carries Claim Attribution [FLA-IDENTITY-ORDER]
WHEN formalization emits candidates and errors, THE spec-check tool SHALL emit them in eligible input order where practical, and SHALL otherwise attach explicit claim/index identity to each output so downstream consumers and tests never assume array order.

**Postcondition:** Output attribution is always recoverable independent of emission order.

### Requirement: Batch Attempt Evidence Preservation [FLA-BATCH-EVIDENCE]
WHEN the spec-check tool completes or fails an attached batch attempt whose temp context file is deleted, THE spec-check tool SHALL record a batch attempt evidence entry containing: schema version, batch key, ordered original eligible indexes, claim IDs when present, claim provenance files, the SHA-256 hash over the exact serialized UTF-8 context bytes, prompt variant/version, model, the physical sub-batch ordinal within the logical group, the response/failure classification, and the cleanup outcome. Evidence records SHALL use claim-text pointers (original eligible indexes resolved against preserved source artifacts) and SHALL NOT duplicate claim text; records SHALL be created before temp cleanup, collected into the formalization output, and persisted via the run manifest/evidence output.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Domain Model`
- `openspec/changes/semantic-batching/proposal.md#Failure Modes`
- `openspec/changes/semantic-batching/design.md#Data Design`

#### Scenario: Attempt Metadata Is Complete [FLA-EVIDENCE-METADATA]
WHEN an attached batch attempt terminates in any handled state, THE preserved evidence SHALL include schema version, batch key, ordered claim indexes, claim IDs when present, provenance files, context SHA-256, prompt variant/version, model, sub-batch ordinal, response/failure classification, and cleanup outcome.

**Postcondition:** Every attached attempt is auditable without the temp file.

#### Scenario: Hash Covers Exact Serialized Bytes [FLA-EVIDENCE-HASH]
WHEN the spec-check tool computes the context hash, THE hash SHALL be SHA-256 over the exact UTF-8 serialized bytes of the context file.

**Postcondition:** The hash is reproducible from the deterministic serialization.

#### Scenario: Deleted Context Is Byte-Reconstructable [FLA-EVIDENCE-RECONSTRUCT]
WHEN a temp context file has been deleted, resolving the recorded claim indexes against preserved source artifacts (claim text), rebuilding the context object, and re-serializing deterministically SHALL yield bytes whose SHA-256 equals the recorded context hash.

**Postcondition:** Auditability survives temp-file deletion by design, without duplicating claim text in durable output.

## MODIFIED Requirements

### Requirement: Formalize Requirement And Scenario Claims Into Logic Artifacts [FLA-FORMALIZE-CLAIMS]
WHEN requirement and scenario claims are available for formal analysis, THE spec-check tool SHALL translate each claim into a typed logic representation and generated SMT-LIB artifacts that preserve the claim identifier, source provenance, obligation level, and supporting declarations needed for solver analysis, SHALL use the run-configured universal timeout for every external LLM formalization invocation, and SHALL group claims into formalization batches using the shared semantic logical-file grouping rather than raw source-spec file paths.

**References:**
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- `openspec/changes/archive/2026-06-20-prompt-file-input-timeout/design.md#Decision: Make JSON extraction tolerant but keep schema validation strict`
- `openspec/changes/semantic-batching/proposal.md#Scope`
- `openspec/changes/semantic-batching/design.md#Proposed Design`

#### Scenario: Generate Inspectable Logic Artifacts [FLA-FORMAL-ARTS]
WHEN a claim is selected for formalization, THE spec-check tool SHALL emit inspectable logic and SMT artifacts that let a reviewer trace the formal result back to the originating requirement or scenario.

**Postcondition:** Formal analysis inputs are available as reviewable evidence linked to their source claims.

##### Evidence
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154), [formalize.ts:476 buildFormalizationPrompt()](/src/domain/formal/formalize.ts#L476)
- Test: [formalize.test.ts:45 formalizeClaims produces valid candidates from mock responses](/test/contract/formalize.test.ts#L45), [formalize.test.ts:159 buildFormalizationPrompt fences claim text as untrusted](/test/contract/formalize.test.ts#L159), [safety-liveness.invariant.test.ts:177 LIVE-11: if opencode responds with valid output, formalization completes](/test/invariant/safety-liveness.invariant.test.ts#L177)

#### Scenario: Abort On Complete Formalization Failure [FLA-FORMAL-FAIL]
IF no formalization candidates are produced for the entire phase after bounded retries, THEN THE spec-check tool SHALL abort the run with exit code `2` rather than continue with zero formal evidence.

**Postcondition:** No solver conclusion is produced when the formalization phase yields zero candidates.

##### Evidence
- Implementation: [formalize.ts:402 sampleFormalizationsForClaim()](/src/domain/formal/formalize.ts#L402)
- Test: [formalize.test.ts:90 returns error when all samples invalid after max attempts](/test/contract/formalize.test.ts#L90), [formalize.test.ts:113 returns error when callOpencode fails fatally](/test/contract/formalize.test.ts#L113)

#### Scenario: Continue With Partial Formalization Results [FLA-FORMAL-PARTIAL]
IF some claims fail formalization but at least one claim succeeds, THEN THE spec-check tool SHALL continue with the successful candidates, SHALL collect per-claim failures as errors in the formalization output, and SHALL let callers decide severity based on the ratio of successes to failures.

**Postcondition:** Partial formalization results are preserved and downstream phases proceed with available candidates.

##### Evidence
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154)
- Test: [formalize.test.ts:169 returns successful candidates alongside errors on partial failure](/test/contract/formalize.test.ts#L169)

#### Scenario: Universal LLM Timeout For Formalization [FLA-FORMAL-TIMEOUT]
WHEN the spec-check tool invokes an external LLM to formalize a claim or claim batch, THE spec-check tool SHALL use the run-configured universal timeout budget for that invocation.

**Postcondition:** Formalization timeout behavior is consistent with every other LLM-backed phase in the same run.

##### Evidence
- Implementation: [formalize.ts:154 formalizeClaims()](/src/domain/formal/formalize.ts#L154), [opencode.ts:86 callOpencode()](/src/adapters/opencode.ts#L86), [timeout.ts:16 DEFAULT_TIMEOUT_MS](/src/domain/timeout.ts#L16)
- Test: [formalize.test.ts:45 formalizeClaims produces valid candidates from mock responses](/test/contract/formalize.test.ts#L45), [opencode.test.ts:403 retries on timeout up to retry limit then returns timeout error](/test/contract/opencode.test.ts#L403)

#### Scenario: Semantic Groups May Span Provenance Files [FLA-FORMAL-SPAN]
WHEN a merged capability's claims originate from more than one provenance file, THE spec-check tool SHALL place all such claims in one formalization logical group under the shared semantic key.

**Postcondition:** Formalization batches reflect the merged capability structure, not raw file layout.

### Requirement: Group Specs-Forward Logic By Merged Capability [FLA-GROUP-MERGED]
WHEN the spec-check tool prepares specs-forward logical analysis, THE spec-check tool SHALL group spec-derived claims by merged capability identity rather than by raw source-spec file path, SHALL use the merged capability `logicalFile` as the artifact-naming and report-grouping key, SHALL exclude non-spec claims from this capability-grouped logic path, and SHALL derive grouping keys from the same shared semantic key helper that formalization grouping uses.

**References:**
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/proposal.md#Postconditions`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Provenance And Grouping Contract`
- `openspec/changes/archive/2026-06-22-merge-delta-spec-logic/design.md#Verification Strategy`
- `openspec/changes/semantic-batching/proposal.md#Scope`
- `openspec/changes/semantic-batching/design.md#Interface Contracts`

#### Scenario: One Logic Group Per Merged Capability [FLA-GROUP-ONE]
WHEN one capability has finalized-plus-delta inputs that merge into one active capability view, THE spec-check tool SHALL produce exactly one specs-forward logical-analysis group for that capability.

**Postcondition:** Base and delta files for the same capability are no longer analyzed as separate solver groups.

##### Evidence
- Implementation: [pipeline-helpers.ts:345 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L345)
- Test: [pipeline-helpers.test.ts:77 produces one logic group per non-empty merged capability with no omissions](/test/contract/pipeline-helpers.test.ts#L77), [merge-logic-routing.test.ts:35 runs one logic group per merged capability and detects contradictions in one run](/test/contract/merge-logic-routing.test.ts#L35)

#### Scenario: Synthetic Logical Key Drives Artifact Naming [FLA-GROUP-LOGICAL]
WHEN the spec-check tool persists solver artifacts or reports for a merged capability logic group, THE spec-check tool SHALL derive those artifact names from the merged capability `logicalFile` key rather than from the original base or delta source file paths.

**Postcondition:** Capability-scoped logic artifacts align with merged capability semantics while original claim provenance remains unchanged.

##### Evidence
- Implementation: [pipeline-helpers.ts:345 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L345), [pipeline-helpers.ts:403 sanitizeLogicalFileForArtifacts()](/src/cli/pipeline-helpers.ts#L403), [logic-analysis.ts:414 artifactBase computation in analyzeSpecGroup()](/src/domain/formal/logic-analysis.ts#L414)
- Test: [pipeline-helpers.test.ts:126 groups by Claim.capability instead of provenance.file](/test/contract/pipeline-helpers.test.ts#L126), [merge-logic-routing.test.ts:57 writes logic artifacts under synthetic merged logicalFile artifact key](/test/contract/merge-logic-routing.test.ts#L57)

#### Scenario: Sanitized Logical Key Collision Aborts Pipeline [FLA-GROUP-COLLISION]
IF two merged capability logical keys would sanitize to the same artifact-path key, THEN THE spec-check tool SHALL abort the pipeline before writing any logic artifacts.

**Postcondition:** Persisted solver evidence remains deterministic and collision-free.

##### Evidence
- Implementation: [pipeline-helpers.ts:386 groupRepresentativesBySpec()](/src/cli/pipeline-helpers.ts#L386), [pipeline-helpers.ts:403 sanitizeLogicalFileForArtifacts()](/src/cli/pipeline-helpers.ts#L403)
- Test: [pipeline-helpers.test.ts:150 fails on sanitized logicalFile collisions](/test/contract/pipeline-helpers.test.ts#L150)

#### Scenario: Solver Grouping Uses Shared Key Helper [FLA-GROUP-SHARED]
WHEN the spec-check tool groups claims for solver analysis, THE solver grouping path SHALL call the shared semantic key helper and SHALL NOT duplicate capability fallback logic locally.

**Postcondition:** Any solver-specific filtering happens before grouping and is documented independently of the key function.

## REMOVED Requirements

## RENAMED Requirements
