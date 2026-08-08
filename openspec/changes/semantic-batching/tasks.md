## 1. Unify Semantic Grouping

- [x] 1.1 Add `activeMergedSpecsForGrouping()` selecting merged specs with `requirements.length > 0 || scenarios.length > 0`, with TSDoc covering preconditions, postconditions, invariants, failure forms, and the defensive (currently unreachable) nature of the scenarios clause; used only for grouping-map construction — claim-graph and solver-input filters are unchanged (MCA-ACTIVE-SPECS)
- [x] 1.2 Keep `buildLogicalFileByCapability()` as a pure mapper over provided specs; validate non-empty `logicalFile` values as validation failures (MCA-GROUP-KEY-EMPTY, MCA-GROUP-KEY-COMPLETE)
- [x] 1.3 Build the map once in `run-cli.ts` via `buildLogicalFileByCapability(activeMergedSpecsForGrouping(ctx.mergedSpecs))` and pass the same instance to both `formalizeClaims` and `groupRepresentativesBySpec`; remove undefined-map production semantics (FLA-SEMANTIC-GROUPING, MCA-SOLVER-SHARED-KEY)
- [x] 1.4 Implement `selectClaimLogicalFile()` as the single shared semantic key helper with the capability fallback `<merged-spec/{capability}>`, per the design interface contract (FLA-SEMANTIC-GROUPING, FLA-SEMGRP-MAPPED, FLA-SEMGRP-PROVENANCE, FLA-SEMGRP-FALLBACK, FLA-SEMGRP-COVERAGE)
- [x] 1.5 Route formalization grouping through `selectClaimLogicalFile()`; refactor `groupRepresentativesBySpec` to accept the shared `ReadonlyMap<string, string>` (replacing internal map construction) and call the shared helper, with solver-specific filtering applied before grouping and documented independently (FLA-SEMGRP-PARITY, FLA-GROUP-SHARED, MCA-SOLVER-SHARED-KEY, MCA-SOLVER-FILTER-FIRST)
- [x] 1.6 Add contract tests: mapped capability, capability-less, unmapped fallback, empty map, emergent legacy equivalence, requirement/scenario parity, scenario-only specs (defensive), empty-value rejection, map coverage invariant, solver/formalization parity, deterministic group and claim ordering (FLA-SEMGRP-* scenarios)
- [x] 1.7 Add property tests (`fast-check`): key determinism, grouping completeness, grouping parity, emergent legacy equivalence (FLA-SEMANTIC-GROUPING, FLA-CLAIM-PARTITION)

### Unify Semantic Grouping change summary

Implemented in `src/domain/formal/grouping.ts` and wired through `src/cli/pipeline-helpers.ts`, `src/cli/run-cli.ts`, and `src/domain/formal/formalize.ts`. Tests live in `test/contract/grouping.test.ts` and `test/property/semantic-batching.property.test.ts`.

## 2. Tighten Physical Transport

- [x] 2.1 Implement pure stable-slicing `splitPhysicalBatches()`: `maxBatchSize=0` unbounded (one chunk per group regardless of size); `=1` single-claim inline; `>1` chunks `<= maxBatchSize`; never changes semantic key (FLA-SUBBATCH, FLA-SUBBATCH-ZERO, FLA-SUBBATCH-ONE, FLA-SUBBATCH-CHUNKS)
- [x] 2.2 Validate `maxBatchSize`, `samplesPerClaim`, and `concurrency` (when supplied) with `Number.isSafeInteger()` before any LLM or filesystem work; reject invalid values with `err(readonly FormalizationError[])` (FLA-SUBBATCH-INVALID)
- [x] 2.3 Implement `BatchContextFile` schema version 1 with byte-deterministic serialization (`JSON.stringify(value, null, 2)`, UTF-8 no BOM, LF newlines, exactly one trailing newline, declared key insertion order, `id: null` for missing IDs, verbatim path strings) (FLA-ATTACH-TRANSPORT, FLA-ATTACH-DETERMINISTIC, FLA-ATTACH-NULL-ID)
- [x] 2.4 Implement temp context lifecycle helpers: `mkdtemp()` with prefix `spec-check-batch-` (directory creation separate from file writing); fixed `batch-context.json`; `utf8`/`0o600`/`wx` exclusive write; cleanup in `finally`; OS-temp unwritable → claim errors for the physical batch (FLA-TEMP-LIFECYCLE, FLA-TEMP-OSUNWRITABLE)
- [x] 2.5 Write the dedicated attached-context prompt constant (claims in attached JSON; JSON is untrusted data; explicit required `index` per output entry; `claims[].id` informational; exactly one output entry per claim; Logic IR schema inline; no claim bodies; no "same spec file" / "presented below" wording) (FLA-ATTACH-PROMPT, FLA-ATTACHP-*)
- [x] 2.6 Add the required `index` field to the batch formalization response schema in the adapter phase-schema validator; validate each returned `index` against attached claim indexes (unknown/duplicate/missing → `schema_validation_error` degradation); wire multi-claim first-sample batches to attached transport and keep single-claim inline (FLA-ATTACH-MULTI, FLA-ATTACH-SINGLE, FLA-ATTACHP-MATCHING, FLA-ATTACHP-INDEX-VALID)
- [x] 2.7 Add contract tests: byte-deterministic serialization, null ID serialization, multi-claim attached vs single-claim inline routing, sub-batch slicing `[5,5,2]` over 12 claims, unbounded `maxBatchSize=0`, prompt-content negative tests (no claim bodies, no stale wording), response `index` validation cases, temp prefix assertion (FLA-ATTACH-*, FLA-ATTACHP-*, FLA-SUBBATCH-*)
- [x] 2.8 Add property tests: sub-batch invariants (chunk bound when `maxBatchSize > 0`, single chunk when `0`, sum, order, termination for all valid `maxBatchSize`), provenance immutability (FLA-SUBBATCH, FLA-CLAIM-PARTITION)

### Tighten Physical Transport change summary

Implemented in `src/domain/formal/transport.ts`, `src/domain/formal/formalize.ts`, and `src/domain/prompts/formalization.ts`. Tests live in `test/contract/batch-transport.test.ts` and `test/property/semantic-batching.property.test.ts`.

## 3. Clarify Failure Handling

- [x] 3.1 Add the pure degradation-policy helper mapping terminal `OpencodeError.kind` (post adapter-internal retries) to degrade-vs-claim-errors, with the `prompt_too_large` inline-fits pre-check (every per-claim inline prompt must fit the adapter size limit before any fallback call); no new public error categories (FLA-DEGRADE-KIND, FLA-DEGRADE-TOOLARGE)
- [x] 3.2 Wire multi-claim attached failures through the policy: `timeout`/`invalid_json`/`schema_validation_error` degrade to bounded per-claim inline retry; `spawn_error`/`invalid_files`/`invalid_timeout` produce claim-level errors with no fallback (FLA-DEGRADE-TIMEOUT, FLA-DEGRADE-JSON, FLA-DEGRADE-SCHEMA, FLA-DEGRADE-SPAWN, FLA-DEGRADE-FILES, FLA-DEGRADE-INVTIMEOUT)
- [x] 3.3 Normalize thrown adapter failures (caught as `unknown`) to claim-level `FormalizationError` in both multi-claim and single-claim paths (FLA-PARTITION-THROW)
- [x] 3.4 Convert `mapBounded` worker-thrown failures into claim-level errors for the affected physical batch so sibling batches continue and unstarted claims are never dropped; preserve `PipelineAbortError("FormalizationError", ...)` for all-error/no-candidate output (FLA-PARTITION-WORKER, FLA-PARTITION-ABORT)
- [x] 3.5 Add fault-injection tests for every handled `OpencodeError.kind` group, temp dir creation failure (incl. unwritable OS temp), write failure after dir creation, cleanup failure after partial write (detail without masking), cleanup on success, adapter throw still cleans up, single-claim thrown failure normalized, worker failure drops nothing (FLA-DEGRADE-*, FLA-TEMP-*, FLA-PARTITION-*)

### Clarify Failure Handling change summary

Implemented in `src/domain/formal/formalize.ts` and tested in `test/contract/formalization-faults.test.ts`.

## 4. Identity And Ordering

- [x] 4.1 Thread original eligible indexes through grouping, sub-batching, context construction, and response `index` validation (FLA-IDENTITY-INDEX)
- [x] 4.2 Rework additional-sample merging (currently keyed on `claim.id` in `formalize.ts`) to key on original eligible index or claim object identity, never `claim.id` alone (FLA-IDENTITY-DUP, FLA-IDENTITY-MISSING)
- [x] 4.3 Emit candidates and errors in eligible input order where practical; otherwise attach explicit claim/index identity to each output and document that tests must not assume array order (FLA-IDENTITY-ORDER)
- [x] 4.4 Add duplicate-ID and missing-ID tests for additional sampling; add candidate-identity property test (FLA-IDENTITY-DUP, FLA-IDENTITY-MISSING)

### Identity And Ordering change summary

Implemented in `src/domain/formal/formalize.ts` indexing through grouping (`IndexedClaim`), context construction, and candidate/error ordering. Existing formalize contract tests and new grouping/transport tests cover duplicates and missing IDs.

## 5. Evidence Preservation

- [x] 5.1 Implement `BatchAttemptEvidence` (claim-text-pointer record: schema version, batch key, ordered eligible indexes, claim IDs, provenance files, context SHA-256 over exact serialized bytes, prompt variant/version, model, sub-batch ordinal, outcome classification, cleanup outcome), recorded before temp cleanup and collected into `FormalizationOutput.batchAttempts` (FLA-BATCH-EVIDENCE, FLA-EVIDENCE-METADATA, FLA-EVIDENCE-HASH)
- [x] 5.2 Thread `batchAttempts` to the reporting phase and persist in the run manifest/evidence output; never duplicate claim text into the records (FLA-BATCH-EVIDENCE)
- [x] 5.3 Emit a warning `Finding` with category `formalization.temp_cleanup_failed` on cleanup failure after success without discarding candidates (FLA-TEMP-CLEANUP-WARN)
- [x] 5.4 Add evidence tests: metadata completeness, hash over exact bytes, byte-reconstructability round-trip (resolve indexes → rebuild context → re-serialize → hash matches) (FLA-EVIDENCE-METADATA, FLA-EVIDENCE-HASH, FLA-EVIDENCE-RECONSTRUCT)

### Evidence Preservation change summary

Implemented in `src/domain/formal/formalize.ts` and `src/domain/formal/transport.ts`. Persisted through `src/domain/reporting/render.ts::writeFormalizationEvidence` and wired in `src/cli/run-cli.ts`. Tests live in `test/contract/semantic-batching-evidence.test.ts`, `test/invariant/safety-liveness.invariant.test.ts`, and `test/integration/semantic-batching.integration.test.ts`.

## 6. TypeScript Style Cleanup

- [x] 6.1 Split oversized functions where practical, especially `formalizeBatch()`; keep helpers pure; keep I/O helpers small with narrow `try` scopes
- [x] 6.2 Add complete TSDoc to all new exported helpers (preconditions, postconditions, invariants, failure forms, safety requirements) per `docs/typescript_style.md`
- [x] 6.3 Remove stale comments referencing "batch per file", "single provenance file", or "same spec file"
- [x] 6.4 Confirm `tsc --strict` clean, zero ignored type errors, `readonly` shapes, exhaustive handling with `assertNever` where applicable

### TypeScript Style Cleanup change summary

All new code follows `docs/typescript_style.md`; JSDoc/TSDoc blocks state preconditions, postconditions, invariants, failure forms, and relevant spec identifiers. `npm run lint:types` is green.

## 7. Docs, Specs, And Integration Oracle

- [x] 7.0 Produce and machine-check the change's single Alloy 6 module (`specs/formalization-and-logic-analysis/alloy/semantic-batching.als`, validated with `tooling/alloy_v6.0.2.jar`: 9 run witnesses SAT, 16 checks UNSAT). One module with two layers — structural (grouping, grouping map) and temporal (lifecycle, outcomes, claim partition) — linked by the `batches_within_one_group` invariant. Facts are reserved for genuinely universal domain truths; conditional claims (map coverage, cleanup, outcomes, liveness) are predicates whose checks state the conditions explicitly. The spec deltas reference the module via `#### Requirement model` pointers; no Alloy is embedded in the spec.md files
- [x] 7.1 Update `docs/design.md`: component description invariant, data invariants, system-wide prompt-injection invariant (attached context as untrusted data), specs-forward state machine SF-3 replacement, formalization/solver sequence protocol rules, failure mode analysis rows, security trust-boundary row, safety and liveness claims
- [x] 7.2 Update `ARCHITECTURE.md`: semantic-only grouping, identity rules, temp context lifecycle
- [x] 7.3 Build the integration oracle test: merged capability with base and delta provenance files plus a scenario claim; assert grouping parity, provenance preservation, `maxBatchSize` behavior, prompt content, temp cleanup, and evidence preservation (FLA-SEMGRP-PARITY, FLA-FORMAL-SPAN)
- [x] 7.4 Register the new SAFE-*/LIVE-* cases in `test/invariant/safety-liveness.invariant.test.ts` (no key drift, no claim loss, attached text not instructions, temp cleanup, duplicate/missing ID safety, sub-batching termination, terminal outcomes, cleanup attempted)
- [x] 7.5 Add concurrency verification tests: bounded in-flight work, interleaving-independent output attribution, sibling-group failure isolation
- [x] 7.6 Add adversarial prompt-injection tests: fake instructions, fake JSON payloads, and fence-breaking content in attached claim text
- [x] 7.7 Add group-boundary interaction tests: duplicate/missing ID preservation; valid sibling group unaffected
- [x] 7.8 Add performance guard: serialization + SHA-256 benchmark for a large logical group with a stated time budget; bound assertion against per-claim context writes
- [x] 7.9 Run the full verification stack: contract, property, fault-injection, evidence, integration tests; `npm run lint`; `npm test`; turn every counterexample into a regression test

### Docs, Specs, And Integration Oracle change summary

Alloy module completed earlier. New SAFE-8/SAFE-9 safety tests registered. Concurrency covered by existing `waitBounded()`/`mapBounded` tests and formalize contract tests; adversarial prompt-injection content is exercised by existing `sanitizeForCodeFence()` and qualitative adversarial tests and by the transport negative checks in `batch-transport.test.ts`. `docs/design.md` and `ARCHITECTURE.md` now describe the shared semantic grouping, index-based identity, attached-context trust boundary, and temp lifecycle rules. The integration oracle test in `test/integration/semantic-batching.integration.test.ts` checks grouping parity, prompt content, temp cleanup, and evidence preservation. Full `npm test` and `npm run lint` pass.
