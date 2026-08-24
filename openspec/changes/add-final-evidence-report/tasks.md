## 1. Establish Paths And Prompt Contract

- [x] 1.1 Resolve `RunConfig.output` with `path.resolve` before branding it, update TSDoc, and add config contract tests for default, CLI, config-file, parent-segment, absolute, and spaced output paths (RAE-FINAL-PATH-ABS, RAE-FINAL-PATH-SPACE)
- [x] 1.2 Update `report_prompts/prompt_f.md` with runtime path placeholders and a strict `{ "report_path", "report_markdown" }` transport while preserving the evaluated content strategy (RAE-FINAL-PROTOCOL)
- [x] 1.3 Add `src/domain/prompts/final-report.ts` with the embedded prompt, `buildFinalReportPrompt`, absolute/confined-path preconditions, unresolved-placeholder postconditions, and complete TSDoc (RAE-FINAL-PATHS, RAE-FINAL-PROTOCOL)
- [x] 1.4 Add source prompt parity tests and bundle/distribution parity tests that permit only declared runtime and transport substitutions (RAE-FINAL-PROMPT-PARITY)
- [x] 1.5 Add generated/property tests for relative, absolute, spaced, Unicode, and non-pattern shell-metacharacter path spellings to confirm exact substitution without shell interpretation; add regressions that reject OpenCode wildcard characters `*` and `?` before invocation (RAE-FINAL-PATH-SPACE, RAE-FINAL-PATH-WILDCARD)

### Establish Paths And Prompt Contract change summary

Resolved output once at configuration entry and embedded prompt F for distribution. Runtime paths are JSON-string encoded, preserving quotes, braces, backslashes, spaces, Unicode, and `$` without shell or replacement interpolation. A generated counterexample (`{{ ` in a valid path) narrowed the placeholder postcondition to the two declared tokens. OpenCode wildcard semantics exposed a design defect for literal `*`/`?`; the proposal, design, spec, implementation, and regression tests now fail that optional phase closed.

## 2. Implement Restricted OpenCode Protocol

- [x] 2.1 Add a pure transient-agent policy builder that defines `spec-check-final-report` as a read-only primary agent, allows required reads, denies edits/shell/delegation/web/interactive tools, and grants narrowly scoped external-directory reads (RAE-FINAL-AGENT, RAE-FINAL-AGENT-WRITE, RAE-FINAL-AGENT-DENY, RAE-FINAL-AGENT-TOOLS)
- [x] 2.2 Extend `runProcess` with an optional inherited child-environment override so the OpenCode adapter can supply `OPENCODE_CONFIG_CONTENT` without dropping provider credentials or other parent environment values; add process contract tests
- [x] 2.3 Add `final-report` to `OpencodePhase` and extend final-report argv construction with `--agent spec-check-final-report` and `--dir <workspace-root>`, retaining model variant, timeout, retries, telemetry, JSON event parsing, and explicitly omitting `--auto` (RAE-FINAL-PROTO-DIR)
- [x] 2.4 Validate the final-report payload as exactly non-empty `report_path` and `report_markdown` strings; reject malformed or extra fields through the adapter taxonomy (RAE-FINAL-PROTO-ACK)
- [x] 2.5 Add adapter contract tests for argv ordering, isolated environment policy, read-only permissions, output bounds, no `--auto`, unchanged existing phases, and payload validation (RAE-FINAL-AGENT-*, RAE-FINAL-PROTO-*)
- [x] 2.6 Add a guarded OpenCode integration test that attempts mutation under the read-only policy and verifies a sibling sentinel remains unchanged (RAE-FINAL-AGENT-WRITE, RAE-FINAL-AGENT-DENY)

### Implement Restricted OpenCode Protocol change summary

Added an isolated read-only agent policy with explicit read/search tools, `.env` denial, and narrow external-directory access. Final-report calls use no `--auto`, parse strict path/body JSON, bound double-escaped event transport, and reject extra fields. The provider-gated live test attempts a denied mutation.

## 3. Implement Final Report Domain And Filesystem Boundary

- [x] 3.1 Add `src/domain/reporting/final-report.ts` with `FINAL_REPORT_PATH`, the 1 MiB bound, closed error kinds, typed `Result` interfaces, and complete precondition/postcondition/invariant TSDoc (RAE-FINAL-REPORT, RAE-FINAL-VALIDATE)
- [x] 3.2 Implement `generateFinalReport` to derive one confined destination, invoke the read-only agent, validate exact path/body, atomically publish through `writeOutputAtomic`, and validate read-back output (RAE-FINAL-PATH-MISMATCH, RAE-FINAL-SAVE)
- [x] 3.3 Implement independent `lstat`-first validation that accepts only a non-symlink regular file, rejects files over 1,048,576 bytes before read, and requires non-whitespace UTF-8 content (RAE-FINAL-VALID-FILE, RAE-FINAL-MISSING, RAE-FINAL-SYMLINK, RAE-FINAL-NOT-REGULAR, RAE-FINAL-EMPTY, RAE-FINAL-OVERSIZED)
- [x] 3.4 Implement idempotent confined removal for stale, partial, symlink, directory, and invalid report destinations, and ensure inability to establish absence surfaces as an output failure (RAE-FINAL-CLEANUP, RAE-FINAL-CLEAN-ERROR)
- [x] 3.5 Add contract tests for atomic publication and each error kind, including wrong path, missing/empty/oversized body, symlink, directory, unreadable, and cleanup-failure output (RAE-FINAL-VALIDATE, RAE-FINAL-CLEANUP)

### Implement Final Report Domain And Filesystem Boundary change summary

Added a closed Result boundary and injectable effects. The body is bounded before `writeOutputAtomic`, then read back with `lstat`, symlink/non-file rejection, byte bounds, fatal UTF-8 decoding, and non-whitespace validation. Atomic write cleanup now covers both write and rename failures.

## 4. Wire Post-Completion Lifecycle

- [x] 4.1 Remove stale `report.md` with the other run-start cleanup before ingestion and add ordering/idempotence tests that precreate stale and partial reports (RAE-FINAL-CLEAN-STALE)
- [x] 4.2 Refactor reporting descriptors so `runReportingPhase` can write the core manifest, then invoke final-report generation without ever converting `report.md` into a manifest entry (RAE-FINAL-AFTER-CORE, RAE-MANIFEST-NO-FINAL)
- [x] 4.3 On successful validation, preserve `report.md`, complete the named progress phase, retain core run state, and leave the core manifest unchanged (RAE-FINAL-SAVE, RAE-FINAL-OPTIONAL)
- [x] 4.4 On handled generation or validation failure, remove the candidate, append exactly one well-formed `reporting.final_report_failed` warning with stable failure-kind evidence, rerender `report_summary.md`, replace its descriptor, and atomically refresh `manifest.json` after the summary (RAE-FINAL-WARNING, RAE-FINAL-WARN-KIND, RAE-FINAL-WARN-HASH)
- [x] 4.5 Preserve nonfatal core completion for report errors while allowing the existing findings-present exit behavior; propagate cleanup, summary-write, or manifest-refresh failures because the safe warning terminal postcondition cannot be established (RAE-FINAL-WARN-COMPLETE, RAE-FINAL-CLEAN-ERROR)
- [x] 4.6 Add integration tests for valid report success, every adapter/validation degradation class, stale-report replacement, partial-output cleanup, warning persistence, checksum repair, manifest exclusion, sentinel immutability, and core-completion preservation (RAE-FINAL-REPORT, RAE-FINAL-WARNING, RAE-ATOMIC-MANIFEST)

### Wire Post-Completion Lifecycle change summary

Run start clears stale report output. Reporting now retains descriptors, writes the core manifest, then runs an optional phase whose expected error emits failed progress without throwing. Success preserves the report and core manifest. Failure cleans output, appends one warning, renders warning detail into the summary, and refreshes checksums. Cleanup and persistence failures surface `OutputError`; integration tests cover stale replacement, warning integrity, exclusion, and cleanup failure.

## 5. Connect Formal Model And Executable Oracle

- [x] 5.1 Re-run `specs/reporting-and-evidence/alloy/final-report.als` after implementation with the repository Alloy tool: all four witnesses SAT and all twelve safety/progress-qualified liveness checks UNSAT within their declared scopes; compare with the proposal baseline and record bounded results and assumptions (RAE-FINAL-REPORT, RAE-ATOMIC-MANIFEST)
- [x] 5.2 Implement the pure `reduceFinalReportLifecycle` reference model with the Alloy states, guarded events, terminal stuttering, and invalid-transition rejection; add initiation and transition-preservation contracts
- [x] 5.3 Add `fast-check` history tests for core-completion monotonicity, exclusive/exhaustive handled outcomes, report validity on success, no residue plus current summary/manifest on warning, and eventual terminal progress under generated non-stuttering handled histories (RAE-FINAL-OPTIONAL, RAE-FINAL-CLEAN-FAILED, RAE-FINAL-WARN-HASH)
- [x] 5.4 Add differential tests that run generated adapter/filesystem outcomes through both the pure lifecycle oracle and a fake-boundary orchestration harness, comparing terminal state, report presence, warning presence, and manifest contents after every history
- [x] 5.5 Register final-report SAFE/LIVE cases in the invariant suite and convert every Alloy, property, differential, or fault-injection counterexample into a deterministic regression test

### Connect Formal Model And Executable Oracle change summary

The full-snapshot reducer mirrors Alloy guards, mutable report/warning/summary/manifest state, and terminal stuttering, and production terminal branches call it as an executable postcondition oracle. Generated histories include stuttering, missing-file validation, generation failure, and output failure at cleanup, invalidation, summary, or refresh. Fresh review split the overcompressed persistence transition into cleanup, marker invalidation, summary rewrite, and manifest refresh. Final bounded results: four SAT witnesses and twelve UNSAT checks within four atoms/twelve steps.

## 6. Complete Fault, Security, And Integrity Evidence

- [x] 6.1 Inject every terminal `OpencodeError.kind`, malformed event stream, malformed acknowledgment, path mismatch, missing output, metadata/read error, partial write, invalid filesystem object, and report-size boundary; assert expected degradation and cleanup (RAE-FINAL-OPTIONAL, RAE-FINAL-VALIDATE)
- [x] 6.2 Inject cleanup failure, summary rewrite failure, and manifest refresh failure; assert the pipeline does not falsely claim `warning_without_report` or retain a stale checksum (RAE-FINAL-CLEAN-ERROR, RAE-FINAL-WARN-HASH)
- [x] 6.3 Add manifest metamorphic/property tests showing report success never changes core entries, `report.md` is excluded for all generated descriptor sets, and warning-summary byte changes always change and then match the refreshed checksum (RAE-MANIFEST-NO-FINAL, RAE-FINAL-WARN-HASH)
- [x] 6.4 Add adversarial permission and prompt tests using path-like instructions, fake acknowledgments, Markdown fences, sibling paths, parent traversal strings, and evidence content requesting unauthorized edits; assert the exact write boundary remains authoritative (RAE-FINAL-AGENT-DENY, RAE-FINAL-PATH-MISMATCH)
- [x] 6.5 Add the 1 MiB capacity guard and timeout/retry assertions to prevent unbounded report reads or invocation work; verify telemetry labels the new OpenCode phase without recording report content (RAE-FINAL-OVERSIZED, RAE-FINAL-PROTO-DIR)

### Complete Fault, Security, And Integrity Evidence change summary

Contract and integration faults cover the complete adapter union, strict acknowledgment parsing, thrown boundaries, path mismatch, missing/invalid/oversized/non-UTF-8 files, read/metadata failures, stale/partial output, and cleanup failure. Manifest metamorphic tests establish report exclusion and summary checksum sensitivity. Telemetry records phase and size/usage metadata but no prompt/report body. Summary/manifest write failures share existing filesystem fault coverage and the explicit `OutputError` orchestration boundary.

## 7. Documentation And Release Verification

- [x] 7.1 Update `README.md` with automatic `report.md` generation, optional/unmanifested semantics, warning behavior, and the distinction between core completion and final-report availability
- [x] 7.2 Update `ARCHITECTURE.md` and `docs/design.md` with the post-completion lifecycle, restricted-agent boundary, exact-path write invariant, validation rules, manifest exclusion, failure recovery, Alloy model, and verification evidence
- [x] 7.3 Update any help, artifact inventory, state-machine, and failure-mode text that still states the manifest is the last physical write rather than the final core-evidence write
- [x] 7.4 Run `npm run lint`, `npm run build`, `npm test`, `npm run test:trace`, `npm run bundle`, and distribution contract tests; preserve all outputs needed for review
- [x] 7.5 Run the Alloy checks and `openspec validate add-final-evidence-report --strict`; review claims, assumptions, model scope, contracts, tests, and counterexamples together as the change's dependability case

### Documentation And Release Verification change summary

Production debugging found that all retries used `spec-check-final-report`, not the default Plan agent. OpenCode denied `apply_patch` because exact path edit rules do not match patch-envelope permission resources; one retry then falsely acknowledged success. The final protocol now keeps the agent read-only, requires the complete Markdown in strict JSON, and uses trusted atomic publication like every other report. Verification evidence and counts are refreshed after this correction.
