## 1. Catalog and Parser Foundation

- [x] 1.1 Add spec discovery and canonical catalog construction for included non-archived `spec.md` files.
- [x] 1.2 Implement the purpose-built markdown scanner for bracketed identifier extraction, code-span/code-fence exclusion, heading provenance, and cross-file duplicate detection.
- [x] 1.3 Add unit tests covering included/excluded paths, identifier extraction rules, heading provenance, duplicate handling, and empty-catalog behavior.

### Catalog and Parser Foundation change summary
- Added `test/support/spec-trace/scan.ts` and `test/support/spec-trace/catalog.ts` for deterministic `spec.md` discovery, markdown scanning, provenance capture, and duplicate detection.
- The scanner intentionally ignores inline-code and fenced-code regions instead of introducing a full markdown parser dependency.
- Evidence: `npm test -- --run test/contract/spec-trace-catalog.contract.test.ts`.

## 2. Trace Runtime Validation

- [x] 2.1 Add Vitest setup and run-scoped traceability state so traced tests validate against the full canonical catalog.
- [x] 2.2 Implement the explicit `traceSpec(...ids)` helper with empty-declaration, malformed-identifier, unknown-identifier, and per-test de-duplication behavior.
- [x] 2.3 Add runtime tests for ordinary, async, and parameterized Vitest usage plus diagnostics for malformed and unknown identifiers.

### Trace Runtime Validation change summary
- Added `test/support/spec-trace.ts`, `test/support/spec-trace/runtime.ts`, and `test/support/spec-trace.setup.ts` to validate traced identifiers against the full canonical catalog in every run.
- `traceSpec(...)` uses Vitest's active test state so ordinary, async, and `it.each(...)` tests can declare identifiers without wrapper APIs.
- Evidence: `npm test -- --run test/contract/spec-trace-runtime.contract.test.ts`.

## 3. Coverage Mode and Reporting

- [x] 3.1 Implement end-of-run coverage aggregation and uncovered-identifier reporting with provenance.
- [x] 3.2 Add the dedicated full-suite `test:trace` package script and document coverage-mode activation through configuration or environment.
- [x] 3.3 Add verification tests for uncovered identifiers, empty-catalog coverage behavior, and untraced-test non-participation.

### Coverage Mode and Reporting change summary
- Added `test/support/spec-trace.reporter.ts` and the `test:trace` package script so full-suite coverage enforcement runs in the Vitest main process.
- Coverage aggregation uses a repository-scoped temp record so traced identifiers survive worker boundaries and produce one provenance-aware uncovered report.
- Evidence: ordinary `npm test` passes, while `npm run test:trace` now fails correctly until more canonical identifiers are backfilled.

## 4. Adoption and Documentation

- [x] 4.1 Document canonical discovery scope, identifier rules, `traceSpec(...)` usage, `test:trace` expectations, and the review-only pattern.
- [x] 4.2 Backfill an initial set of traced tests against current canonical identifiers to prove the workflow end to end.
- [x] 4.3 Run the relevant test commands, confirm ordinary validation and full-suite coverage behavior, and capture any rollout notes for enabling CI later.

### Adoption and Documentation change summary
- Added `docs/spec_traceability.md` and linked repository architecture docs to the new workflow.
- Backfilled an initial set of traced tests in contract, property, and integration suites to demonstrate real end-to-end usage.
- Rollout note: keep `npm run test:trace` as an intentional verification command for now; do not enable it in CI until more existing spec identifiers are covered.
