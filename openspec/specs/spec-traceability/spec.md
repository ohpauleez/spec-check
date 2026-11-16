## Purpose

Define the OpenSpec traceability behavior for the repository's TypeScript/Vitest test harness: discovering canonical identifiers from included OpenSpec specs, validating explicit `traceSpec(...)` declarations in tests, reporting provenance-aware diagnostics, and enforcing full-catalog coverage in a dedicated full-suite mode.
This spec preserves the repository's convention that canonical identifiers are authored in OpenSpec markdown while keeping ordinary test runs lightweight and leaving untraced tests unaffected.

## Requirements

### Requirement: Identifier syntax and bracket delimiters [TRACE-ID-SYNTAX]
THE spec-traceability utility SHALL treat a canonical spec identifier as an uppercase kebab-style token matching `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`, authored inside square brackets in canonical OpenSpec markdown, while traced tests SHALL declare the bare identifier without brackets.

#### Scenario: Bracketed identifier is extracted without brackets [TRACE-ID-EXTRACT]
WHEN an included canonical spec file contains a bracketed identifier such as `[BOX-NULL-REJECT]`, THE spec-traceability utility SHALL extract `BOX-NULL-REJECT` as the canonical identifier value.

**Postcondition:** The stored identifier excludes the surrounding brackets.

##### Evidence
- Implementation: [scan.ts:37 scanSpecMarkdown()](/test/support/spec-trace/scan.ts#L37)
- Test: [spec-trace.test.ts:21 bracketed identifiers are extracted without brackets](/test/contract/spec-trace.test.ts#L21)

#### Scenario: Bare token without brackets is ignored [TRACE-ID-IGNORE]
WHEN an included canonical spec file contains an uppercase kebab token without surrounding brackets, THE spec-traceability utility SHALL ignore that token for canonical identifier discovery.

**Postcondition:** Only bracket-delimited identifiers contribute to the catalog.

##### Evidence
- Implementation: [scan.ts:37 scanSpecMarkdown()](/test/support/spec-trace/scan.ts#L37)
- Test: [spec-trace.test.ts:28 bare token without brackets is ignored by scanner](/test/contract/spec-trace.test.ts#L28)

#### Scenario: Traced test uses bare identifier form [TRACE-ID-BARE]
WHEN a traced test declares an identifier through `traceSpec(...)`, THE spec-traceability utility SHALL interpret each argument as the bare canonical identifier without brackets.

**Postcondition:** The traced declaration format matches the catalog format after extraction.

##### Evidence
- Implementation: [spec-trace.ts:17 traceSpec()](/test/support/spec-trace.ts#L17), [runtime.ts:117 recordTraceDeclaration()](/test/support/spec-trace/runtime.ts#L117)
- Test: [spec-trace.test.ts:34 traceSpec accepts bare identifier form (no brackets needed)](/test/contract/spec-trace.test.ts#L34)

### Requirement: Canonical identifier discovery scope [TRACE-CATALOG-SCOPE]
THE spec-traceability utility SHALL discover canonical identifiers only from `openspec/specs/**/spec.md` and active `openspec/changes/**/spec.md`, and SHALL exclude `openspec/changes/archive/**` from the canonical catalog.

#### Scenario: Included spec paths contribute identifiers [TRACE-CATALOG-INCLUDE]
WHEN a valid bracketed identifier appears in an included non-archived `spec.md` path, THE spec-traceability utility SHALL add that identifier to the canonical catalog.

**Postcondition:** The identifier is available for traced test validation.

##### Evidence
- Implementation: [catalog.ts:61 discoverCanonicalSpecFiles()](/test/support/spec-trace/catalog.ts#L61), [catalog.ts:82 buildCanonicalCatalogFromFiles()](/test/support/spec-trace/catalog.ts#L82)
- Test: [spec-trace.test.ts:43 discovers spec files from openspec/ directories](/test/contract/spec-trace.test.ts#L43)

#### Scenario: Archived or unrelated paths are ignored [TRACE-CATALOG-EXCLUDE]
WHEN a valid-looking bracketed identifier appears outside the included discovery scope or under `openspec/changes/archive/**`, THE spec-traceability utility SHALL exclude that identifier from the canonical catalog.

**Postcondition:** Archived or unrelated markdown cannot define canonical identifiers.

##### Evidence
- Implementation: [catalog.ts:61 discoverCanonicalSpecFiles()](/test/support/spec-trace/catalog.ts#L61), [catalog.ts:162 collectSpecFiles()](/test/support/spec-trace/catalog.ts#L162)
- Test: [spec-trace.test.ts:50 excludes archived changes from catalog](/test/contract/spec-trace.test.ts#L50)

### Requirement: Markdown extraction ignores code formatting [TRACE-CATALOG-CODE]
THE spec-traceability utility SHALL ignore bracketed identifier-like tokens that appear inside inline code spans or fenced code blocks while scanning canonical spec files.

#### Scenario: Inline code identifier-looking token is ignored [TRACE-CODE-INLINE]
WHEN a canonical spec file contains a bracketed identifier-looking token inside an inline code span, THE spec-traceability utility SHALL ignore that token during catalog discovery.

**Postcondition:** Inline code spans do not create canonical identifiers.

##### Evidence
- Implementation: [scan.ts:37 scanSpecMarkdown()](/test/support/spec-trace/scan.ts#L37), [scan.ts:171 stripInlineCode()](/test/support/spec-trace/scan.ts#L171)
- Test: [spec-trace.test.ts:60 ignores inline code spans containing identifier-like tokens](/test/contract/spec-trace.test.ts#L60)

#### Scenario: Fenced code identifier-looking token is ignored [TRACE-CODE-FENCE]
WHEN a canonical spec file contains a bracketed identifier-looking token inside a fenced code block, THE spec-traceability utility SHALL ignore that token during catalog discovery.

**Postcondition:** Fenced code blocks do not create canonical identifiers.

##### Evidence
- Implementation: [scan.ts:37 scanSpecMarkdown()](/test/support/spec-trace/scan.ts#L37), [scan.ts:125 readFenceBoundary()](/test/support/spec-trace/scan.ts#L125), [scan.ts:154 isFenceBoundary()](/test/support/spec-trace/scan.ts#L154)
- Test: [spec-trace.test.ts:67 ignores fenced code blocks containing identifier-like tokens](/test/contract/spec-trace.test.ts#L67)

### Requirement: Canonical catalog provenance and uniqueness [TRACE-CATALOG-PROVENANCE]
THE spec-traceability utility SHALL record, for each discovered canonical identifier, the defining file, defining line number, and nearest `Requirement` or `Scenario` heading when available, and SHALL reject duplicate identifiers that are defined in more than one included spec file.

#### Scenario: Identifier on heading keeps heading provenance [TRACE-PROVENANCE-HEADING]
WHEN a canonical identifier appears on a `Requirement` or `Scenario` heading, THE spec-traceability utility SHALL retain that heading as provenance context without the bracketed identifier token in the stored heading text.

**Postcondition:** Diagnostics can point to a human-readable requirement or scenario context.

##### Evidence
- Implementation: [scan.ts:37 scanSpecMarkdown()](/test/support/spec-trace/scan.ts#L37), [scan.ts:95 parseHeading()](/test/support/spec-trace/scan.ts#L95)
- Test: [spec-trace.test.ts:76 identifier on heading keeps heading provenance](/test/contract/spec-trace.test.ts#L76)

#### Scenario: Cross-file duplicate identifier fails catalog construction [TRACE-DUPE-CROSSFILE]
IF the same canonical identifier is discovered in more than one included spec file, THEN THE spec-traceability utility SHALL fail catalog construction before traced test validation proceeds.

**Postcondition:** No traced test validation runs against an ambiguous catalog.

##### Evidence
- Implementation: [catalog.ts:45 loadCanonicalCatalog()](/test/support/spec-trace/catalog.ts#L45), [catalog.ts:200 mergeScannedEntries()](/test/support/spec-trace/catalog.ts#L200)
- Test: [spec-trace.test.ts:84 cross-file duplicate identifier fails catalog construction](/test/contract/spec-trace.test.ts#L84)

#### Scenario: Repeated identifier within one file keeps first occurrence [TRACE-DUPE-SAMEFILE]
WHEN one included spec file repeats the same canonical identifier multiple times, THE spec-traceability utility SHALL keep the first occurrence for provenance and SHALL NOT treat the repetition as a cross-file duplicate error.

**Postcondition:** Single-file repetition does not block catalog construction.

##### Evidence
- Implementation: [catalog.ts:82 buildCanonicalCatalogFromFiles()](/test/support/spec-trace/catalog.ts#L82), [catalog.ts:200 mergeScannedEntries()](/test/support/spec-trace/catalog.ts#L200)

### Requirement: Traced test declarations are explicit and validated [TRACE-TEST-DECL]
WHEN a Vitest test calls `traceSpec(...)`, THE spec-traceability utility SHALL require at least one identifier argument, SHALL validate each identifier against the canonical format, and SHALL validate each well-formed identifier against the full canonical catalog.

#### Scenario: Empty trace declaration fails declaring test [TRACE-TEST-EMPTY]
IF a Vitest test calls `traceSpec()` with no identifiers, THEN THE spec-traceability utility SHALL fail the declaring test with an error indicating that at least one identifier is required.

**Postcondition:** The test run records a local declaration failure for that test.

##### Evidence
- Implementation: [runtime.ts:117 recordTraceDeclaration()](/test/support/spec-trace/runtime.ts#L117)
- Test: [spec-trace.test.ts:118 empty trace declaration fails](/test/contract/spec-trace.test.ts#L118)

#### Scenario: Malformed identifier fails declaring test [TRACE-TEST-MALFORMED]
IF a traced test declares an identifier that does not match `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`, THEN THE spec-traceability utility SHALL fail the declaring test with a format diagnostic distinct from an unknown-identifier error.

**Postcondition:** The failure reports the offending identifier and the expected pattern.

##### Evidence
- Implementation: [runtime.ts:117 recordTraceDeclaration()](/test/support/spec-trace/runtime.ts#L117)
- Test: [spec-trace.test.ts:124 malformed identifier fails](/test/contract/spec-trace.test.ts#L124)

#### Scenario: Unknown identifier fails declaring test [TRACE-TEST-UNKNOWN]
IF a traced test declares a well-formed identifier that is not present in the canonical catalog, THEN THE spec-traceability utility SHALL fail only the declaring test with an unknown-reference diagnostic.

**Postcondition:** Other tests in the run continue executing normally.

##### Evidence
- Implementation: [spec-trace.ts:17 traceSpec()](/test/support/spec-trace.ts#L17), [runtime.ts:117 recordTraceDeclaration()](/test/support/spec-trace/runtime.ts#L117)
- Test: [spec-trace.test.ts:131 unknown identifier fails](/test/contract/spec-trace.test.ts#L131)

#### Scenario: Repeated identifier in one test is de-duplicated for accounting [TRACE-TEST-DEDUPE]
WHEN the same canonical identifier is declared more than once within one traced test, THE spec-traceability utility SHALL record it once for coverage accounting.

**Postcondition:** Coverage accounting is based on the unique identifiers declared by that test.

##### Evidence
- Implementation: [runtime.ts:117 recordTraceDeclaration()](/test/support/spec-trace/runtime.ts#L117), [runtime.ts:215 getOrCreateIdentifiersForTest()](/test/support/spec-trace/runtime.ts#L215)
- Test: [spec-trace.test.ts:138 repeated identifier in one test is de-duplicated for accounting](/test/contract/spec-trace.test.ts#L138)

### Requirement: Untraced tests are unaffected [TRACE-TEST-UNTRACED]
THE spec-traceability utility SHALL allow tests without `traceSpec(...)` declarations to execute normally without traceability validation or coverage accounting.

#### Scenario: Untraced test runs without traceability checks [TRACE-UNTRACED-PASS]
WHEN a Vitest test does not call `traceSpec(...)`, THE spec-traceability utility SHALL leave that test outside traceability validation and coverage accounting.

**Postcondition:** The absence of trace declarations does not change the test's ordinary execution behavior.

##### Evidence
- Implementation: [spec-trace.ts:17 traceSpec()](/test/support/spec-trace.ts#L17), [runtime.ts:117 recordTraceDeclaration()](/test/support/spec-trace/runtime.ts#L117)
- Test: [spec-trace.test.ts:149 untraced test runs without traceability checks](/test/contract/spec-trace.test.ts#L149)

### Requirement: Reference validation uses the full catalog for every run [TRACE-RUN-VALIDATE]
THE spec-traceability utility SHALL validate traced identifiers against the full canonical catalog during ordinary test runs and subset runs.

#### Scenario: Subset run still uses full catalog [TRACE-RUN-SUBSET]
WHEN a developer runs one test file or a filtered subset of traced tests, THE spec-traceability utility SHALL validate those traced declarations against the full canonical catalog for the repository.

**Postcondition:** Subset runs still catch malformed and unknown identifiers relative to the full spec set.

##### Evidence
- Implementation: [runtime.ts:59 getOrCreateTraceRuntimeState()](/test/support/spec-trace/runtime.ts#L59), [catalog.ts:45 loadCanonicalCatalog()](/test/support/spec-trace/catalog.ts#L45)
- Test: [spec-trace.test.ts:159 subset run still uses full catalog for validation](/test/contract/spec-trace.test.ts#L159)
- Test (integration): [trace-reporter.integration.test.ts:8 enforces full-catalog coverage through the installed Vitest reporter callback](/test/integration/trace-reporter.integration.test.ts#L8)

### Requirement: Coverage enforcement is a dedicated full-suite mode [TRACE-RUN-COVERAGE]
WHEN the dedicated `test:trace` command runs as a full-suite command with `SPEC_TRACE_COVERAGE` enabled, THE spec-traceability utility SHALL enforce that every canonical identifier is declared by at least one traced test in the run, while ordinary test runs SHALL validate traced references without requiring full coverage.

#### Scenario: Ordinary test run validates without coverage enforcement [TRACE-COVERAGE-OFF]
WHEN the ordinary Vitest test command runs without coverage mode enabled, THE spec-traceability utility SHALL validate traced identifiers but SHALL NOT fail the run for uncovered canonical identifiers.

**Postcondition:** Local validation remains lightweight while still rejecting invalid declarations.

##### Evidence
- Implementation: [runtime.ts:203 isTraceCoverageEnabled()](/test/support/spec-trace/runtime.ts#L203), [spec-trace.reporter.ts:37 onTestRunEnd()](/test/support/spec-trace.reporter.ts#L37), [runtime.ts:117 recordTraceDeclaration()](/test/support/spec-trace/runtime.ts#L117)
- Test: [spec-trace.test.ts:169 ordinary test run validates without coverage enforcement](/test/contract/spec-trace.test.ts#L169)

#### Scenario: Full-suite coverage run fails on uncovered identifier [TRACE-COVERAGE-FAIL]
WHEN the dedicated full-suite trace coverage command runs and one or more canonical identifiers are not declared by any traced test in that run, THE spec-traceability utility SHALL fail the run and report the uncovered identifiers with provenance.

**Postcondition:** The run exposes the gap between canonical requirements and traced verification.

##### Evidence
- Implementation: [spec-trace.reporter.ts:37 onTestRunEnd()](/test/support/spec-trace.reporter.ts#L37), [runtime.ts:178 finalizeTraceCoverage()](/test/support/spec-trace/runtime.ts#L178)
- Test: [spec-trace.test.ts:181 coverage run fails on uncovered identifier](/test/contract/spec-trace.test.ts#L181)
- Test (integration): [trace-reporter.integration.test.ts:8 enforces full-catalog coverage through the installed Vitest reporter callback](/test/integration/trace-reporter.integration.test.ts#L8)

#### Scenario: Empty catalog coverage run passes trivially [TRACE-COVERAGE-EMPTY]
WHEN the dedicated full-suite trace coverage command runs against an empty canonical catalog, THE spec-traceability utility SHALL pass coverage enforcement trivially.

**Postcondition:** The run reports no missing coverage because there are no canonical identifiers to cover.

##### Evidence
- Implementation: [runtime.ts:154 computeUncoveredCatalogEntries()](/test/support/spec-trace/runtime.ts#L154), [spec-trace.reporter.ts:37 onTestRunEnd()](/test/support/spec-trace.reporter.ts#L37)
- Test: [spec-trace.test.ts:190 empty catalog coverage run passes trivially](/test/contract/spec-trace.test.ts#L190)

### Requirement: Diagnostics are provenance-aware [TRACE-DIAG-PROVENANCE]
WHEN the spec-traceability utility reports duplicate canonical identifiers or uncovered canonical identifiers, THE diagnostic SHALL include the identifier together with defining file, defining line number, and nearest heading context when available.

#### Scenario: Duplicate identifier diagnostic includes both definitions [TRACE-DIAG-DUPE]
WHEN duplicate canonical identifiers are discovered across included spec files, THE spec-traceability utility SHALL report both defining files, both defining line numbers, and nearest heading context when available.

**Postcondition:** Authors can locate and resolve the ambiguity without manual catalog inspection.

##### Evidence
- Implementation: [catalog.ts:200 mergeScannedEntries()](/test/support/spec-trace/catalog.ts#L200), [catalog.ts:107 createCanonicalCatalog()](/test/support/spec-trace/catalog.ts#L107), [catalog.ts:135 formatCatalogEntry()](/test/support/spec-trace/catalog.ts#L135)
- Test: [spec-trace.test.ts:199 duplicate identifier diagnostic includes both definitions](/test/contract/spec-trace.test.ts#L199)

#### Scenario: Uncovered identifier diagnostic includes provenance [TRACE-DIAG-UNCOVERED]
WHEN a full-suite coverage run finds an uncovered canonical identifier, THE spec-traceability utility SHALL report the identifier together with its defining file, line number, and nearest heading context when available.

**Postcondition:** Authors can locate the uncovered requirement directly from the coverage report.

##### Evidence
- Implementation: [runtime.ts:178 finalizeTraceCoverage()](/test/support/spec-trace/runtime.ts#L178), [catalog.ts:135 formatCatalogEntry()](/test/support/spec-trace/catalog.ts#L135)
- Test: [spec-trace.test.ts:213 uncovered identifier diagnostic includes provenance](/test/contract/spec-trace.test.ts#L213)

### Requirement: Review-only requirements remain traceable [TRACE-REVIEW-ONLY]
WHEN a requirement is better verified by reasoning, review, or cited documentation than by executable assertions, THE spec-traceability utility SHALL allow that requirement to remain covered by a passing traced test that includes an explanatory comment.

#### Scenario: Review-only traced test satisfies traceability relationship [TRACE-REVIEW-PASS]
WHEN a traced test documents why an identifier is review-only and passes with a trivial assertion, THE spec-traceability utility SHALL count that traced declaration for validation and coverage purposes.

**Postcondition:** Review-only requirements remain visible in the traceability model.

##### Evidence
- Implementation: [spec-trace.ts:17 traceSpec()](/test/support/spec-trace.ts#L17), [runtime.ts:117 recordTraceDeclaration()](/test/support/spec-trace/runtime.ts#L117)
- Test: [spec-trace.test.ts:227 review-only traced test satisfies traceability relationship](/test/contract/spec-trace.test.ts#L227)
