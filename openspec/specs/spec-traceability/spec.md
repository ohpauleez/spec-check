## Purpose

Define the OpenSpec traceability behavior for the repository's TypeScript/Vitest test harness: discovering canonical identifiers from included OpenSpec specs, validating explicit `traceSpec(...)` declarations in tests, reporting provenance-aware diagnostics, and enforcing full-catalog coverage in a dedicated full-suite mode.
This spec preserves the repository's convention that canonical identifiers are authored in OpenSpec markdown while keeping ordinary test runs lightweight and leaving untraced tests unaffected.

## Requirements

### Requirement: Identifier syntax and bracket delimiters [TRACE-ID-SYNTAX]
THE spec-traceability utility SHALL treat a canonical spec identifier as an uppercase kebab-style token matching `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`, authored inside square brackets in canonical OpenSpec markdown, while traced tests SHALL declare the bare identifier without brackets.

**References:**
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#domain-model`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#preconditions-postconditions-and-invariants`
- `openspec/changes/archive/2026-06-05-spec-traceability/design.md#component-design`

#### Scenario: Bracketed identifier is extracted without brackets [TRACE-ID-EXTRACT]
WHEN an included canonical spec file contains a bracketed identifier such as `[BOX-NULL-REJECT]`, THE spec-traceability utility SHALL extract `BOX-NULL-REJECT` as the canonical identifier value.

**Postcondition:** The stored identifier excludes the surrounding brackets.

#### Scenario: Bare token without brackets is ignored [TRACE-ID-IGNORE]
WHEN an included canonical spec file contains an uppercase kebab token without surrounding brackets, THE spec-traceability utility SHALL ignore that token for canonical identifier discovery.

**Postcondition:** Only bracket-delimited identifiers contribute to the catalog.

#### Scenario: Traced test uses bare identifier form [TRACE-ID-BARE]
WHEN a traced test declares an identifier through `traceSpec(...)`, THE spec-traceability utility SHALL interpret each argument as the bare canonical identifier without brackets.

**Postcondition:** The traced declaration format matches the catalog format after extraction.

### Requirement: Canonical identifier discovery scope [TRACE-CATALOG-SCOPE]
THE spec-traceability utility SHALL discover canonical identifiers only from `openspec/specs/**/spec.md` and active `openspec/changes/**/spec.md`, and SHALL exclude `openspec/changes/archive/**` from the canonical catalog.

**References:**
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#scope`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#constraints`
- `openspec/changes/archive/2026-06-05-spec-traceability/design.md#proposed-design`

#### Scenario: Included spec paths contribute identifiers [TRACE-CATALOG-INCLUDE]
WHEN a valid bracketed identifier appears in an included non-archived `spec.md` path, THE spec-traceability utility SHALL add that identifier to the canonical catalog.

**Postcondition:** The identifier is available for traced test validation.

#### Scenario: Archived or unrelated paths are ignored [TRACE-CATALOG-EXCLUDE]
WHEN a valid-looking bracketed identifier appears outside the included discovery scope or under `openspec/changes/archive/**`, THE spec-traceability utility SHALL exclude that identifier from the canonical catalog.

**Postcondition:** Archived or unrelated markdown cannot define canonical identifiers.

### Requirement: Markdown extraction ignores code formatting [TRACE-CATALOG-CODE]
THE spec-traceability utility SHALL ignore bracketed identifier-like tokens that appear inside inline code spans or fenced code blocks while scanning canonical spec files.

**References:**
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#context`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#quality-attributes`
- `openspec/changes/archive/2026-06-05-spec-traceability/design.md#quality-attribute-tactics`

#### Scenario: Inline code identifier-looking token is ignored [TRACE-CODE-INLINE]
WHEN a canonical spec file contains a bracketed identifier-looking token inside an inline code span, THE spec-traceability utility SHALL ignore that token during catalog discovery.

**Postcondition:** Inline code spans do not create canonical identifiers.

#### Scenario: Fenced code identifier-looking token is ignored [TRACE-CODE-FENCE]
WHEN a canonical spec file contains a bracketed identifier-looking token inside a fenced code block, THE spec-traceability utility SHALL ignore that token during catalog discovery.

**Postcondition:** Fenced code blocks do not create canonical identifiers.

### Requirement: Canonical catalog provenance and uniqueness [TRACE-CATALOG-PROVENANCE]
THE spec-traceability utility SHALL record, for each discovered canonical identifier, the defining file, defining line number, and nearest `Requirement` or `Scenario` heading when available, and SHALL reject duplicate identifiers that are defined in more than one included spec file.

**References:**
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#domain-model`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#failure-modes`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#preconditions-postconditions-and-invariants`
- `openspec/changes/archive/2026-06-05-spec-traceability/design.md#interaction-protocols`

#### Scenario: Identifier on heading keeps heading provenance [TRACE-PROVENANCE-HEADING]
WHEN a canonical identifier appears on a `Requirement` or `Scenario` heading, THE spec-traceability utility SHALL retain that heading as provenance context without the bracketed identifier token in the stored heading text.

**Postcondition:** Diagnostics can point to a human-readable requirement or scenario context.

#### Scenario: Cross-file duplicate identifier fails catalog construction [TRACE-DUPE-CROSSFILE]
IF the same canonical identifier is discovered in more than one included spec file, THEN THE spec-traceability utility SHALL fail catalog construction before traced test validation proceeds.

**Postcondition:** No traced test validation runs against an ambiguous catalog.

#### Scenario: Repeated identifier within one file keeps first occurrence [TRACE-DUPE-SAMEFILE]
WHEN one included spec file repeats the same canonical identifier multiple times, THE spec-traceability utility SHALL keep the first occurrence for provenance and SHALL NOT treat the repetition as a cross-file duplicate error.

**Postcondition:** Single-file repetition does not block catalog construction.

### Requirement: Traced test declarations are explicit and validated [TRACE-TEST-DECL]
WHEN a Vitest test calls `traceSpec(...)`, THE spec-traceability utility SHALL require at least one identifier argument, SHALL validate each identifier against the canonical format, and SHALL validate each well-formed identifier against the full canonical catalog.

**References:**
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#scope`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#quality-attributes`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#preconditions-postconditions-and-invariants`
- `openspec/changes/archive/2026-06-05-spec-traceability/design.md#interface-contracts`

#### Scenario: Empty trace declaration fails declaring test [TRACE-TEST-EMPTY]
IF a Vitest test calls `traceSpec()` with no identifiers, THEN THE spec-traceability utility SHALL fail the declaring test with an error indicating that at least one identifier is required.

**Postcondition:** The test run records a local declaration failure for that test.

#### Scenario: Malformed identifier fails declaring test [TRACE-TEST-MALFORMED]
IF a traced test declares an identifier that does not match `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+`, THEN THE spec-traceability utility SHALL fail the declaring test with a format diagnostic distinct from an unknown-identifier error.

**Postcondition:** The failure reports the offending identifier and the expected pattern.

#### Scenario: Unknown identifier fails declaring test [TRACE-TEST-UNKNOWN]
IF a traced test declares a well-formed identifier that is not present in the canonical catalog, THEN THE spec-traceability utility SHALL fail only the declaring test with an unknown-reference diagnostic.

**Postcondition:** Other tests in the run continue executing normally.

#### Scenario: Repeated identifier in one test is de-duplicated for accounting [TRACE-TEST-DEDUPE]
WHEN the same canonical identifier is declared more than once within one traced test, THE spec-traceability utility SHALL record it once for coverage accounting.

**Postcondition:** Coverage accounting is based on the unique identifiers declared by that test.

### Requirement: Untraced tests are unaffected [TRACE-TEST-UNTRACED]
THE spec-traceability utility SHALL allow tests without `traceSpec(...)` declarations to execute normally without traceability validation or coverage accounting.

**References:**
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#scope`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#preconditions-postconditions-and-invariants`
- `openspec/changes/archive/2026-06-05-spec-traceability/design.md#system-invariant-tactics`

#### Scenario: Untraced test runs without traceability checks [TRACE-UNTRACED-PASS]
WHEN a Vitest test does not call `traceSpec(...)`, THE spec-traceability utility SHALL leave that test outside traceability validation and coverage accounting.

**Postcondition:** The absence of trace declarations does not change the test's ordinary execution behavior.

### Requirement: Reference validation uses the full catalog for every run [TRACE-RUN-VALIDATE]
THE spec-traceability utility SHALL validate traced identifiers against the full canonical catalog during ordinary test runs and subset runs.

**References:**
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#constraints`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#quality-attributes`
- `openspec/changes/archive/2026-06-05-spec-traceability/design.md#interface-contracts`

#### Scenario: Subset run still uses full catalog [TRACE-RUN-SUBSET]
WHEN a developer runs one test file or a filtered subset of traced tests, THE spec-traceability utility SHALL validate those traced declarations against the full canonical catalog for the repository.

**Postcondition:** Subset runs still catch malformed and unknown identifiers relative to the full spec set.

### Requirement: Coverage enforcement is a dedicated full-suite mode [TRACE-RUN-COVERAGE]
WHEN the dedicated `test:trace` command runs as a full-suite command, THE spec-traceability utility SHALL enforce that every canonical identifier is declared by at least one traced test in the run, while ordinary test runs SHALL validate traced references without requiring full coverage.

**References:**
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#motivation`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#scope`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#preconditions-postconditions-and-invariants`
- `openspec/changes/archive/2026-06-05-spec-traceability/design.md#operational-concerns`

#### Scenario: Ordinary test run validates without coverage enforcement [TRACE-COVERAGE-OFF]
WHEN the ordinary Vitest test command runs without coverage mode enabled, THE spec-traceability utility SHALL validate traced identifiers but SHALL NOT fail the run for uncovered canonical identifiers.

**Postcondition:** Local validation remains lightweight while still rejecting invalid declarations.

#### Scenario: Full-suite coverage run fails on uncovered identifier [TRACE-COVERAGE-FAIL]
WHEN the dedicated full-suite trace coverage command runs and one or more canonical identifiers are not declared by any traced test in that run, THE spec-traceability utility SHALL fail the run and report the uncovered identifiers with provenance.

**Postcondition:** The run exposes the gap between canonical requirements and traced verification.

#### Scenario: Empty catalog coverage run passes trivially [TRACE-COVERAGE-EMPTY]
WHEN the dedicated full-suite trace coverage command runs against an empty canonical catalog, THE spec-traceability utility SHALL pass coverage enforcement trivially.

**Postcondition:** The run reports no missing coverage because there are no canonical identifiers to cover.

### Requirement: Diagnostics are provenance-aware [TRACE-DIAG-PROVENANCE]
WHEN the spec-traceability utility reports duplicate canonical identifiers or uncovered canonical identifiers, THE diagnostic SHALL include the identifier together with defining file, defining line number, and nearest heading context when available.

**References:**
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#failure-modes`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#quality-attributes`
- `openspec/changes/archive/2026-06-05-spec-traceability/design.md#observability`

#### Scenario: Duplicate identifier diagnostic includes both definitions [TRACE-DIAG-DUPE]
WHEN duplicate canonical identifiers are discovered across included spec files, THE spec-traceability utility SHALL report both defining files, both defining line numbers, and nearest heading context when available.

**Postcondition:** Authors can locate and resolve the ambiguity without manual catalog inspection.

#### Scenario: Uncovered identifier diagnostic includes provenance [TRACE-DIAG-UNCOVERED]
WHEN a full-suite coverage run finds an uncovered canonical identifier, THE spec-traceability utility SHALL report the identifier together with its defining file, line number, and nearest heading context when available.

**Postcondition:** Authors can locate the uncovered requirement directly from the coverage report.

### Requirement: Review-only requirements remain traceable [TRACE-REVIEW-ONLY]
WHEN a requirement is better verified by reasoning, review, or cited documentation than by executable assertions, THE spec-traceability utility SHALL allow that requirement to remain covered by a passing traced test that includes an explanatory comment.

**References:**
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#scope`
- `openspec/changes/archive/2026-06-05-spec-traceability/proposal.md#quality-attributes`
- `openspec/changes/archive/2026-06-05-spec-traceability/design.md#operational-concerns`

#### Scenario: Review-only traced test satisfies traceability relationship [TRACE-REVIEW-PASS]
WHEN a traced test documents why an identifier is review-only and passes with a trivial assertion, THE spec-traceability utility SHALL count that traced declaration for validation and coverage purposes.

**Postcondition:** Review-only requirements remain visible in the traceability model.
