## ADDED Requirements

### Requirement: CLI Argument Validation [CAT-CLI-ARGS]
THE spec-check CLI SHALL accept positional input paths and optional `--output`, `--src`, `--caps`, `--z3`, `--config`, `--help`, and `--version` flags, and SHALL reject unrecognized flags or missing required inputs with exit code `2` before any analysis begins.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Help Flag Prints Help And Exits [CAT-CLI-HELP]
WHEN the user invokes `spec-check --help` or `spec-check -h`, THE spec-check CLI SHALL print command overview and help information together with version information and exit with code `0` without running any analysis.

**Postcondition:** No output directory is created and no analysis phases run.

#### Scenario: Version Flag Prints Version And Exits [CAT-CLI-VERSION]
WHEN the user invokes `spec-check --version` or `spec-check -v`, THE spec-check CLI SHALL print the embedded version string and exit with code `0` without running any analysis.

**Postcondition:** No output directory is created and no analysis phases run.

#### Scenario: Missing Input Paths Rejected [CAT-CLI-NOINPUT]
IF the user invokes `spec-check` with no positional input paths and no `--help` or `--version` flag, THEN THE spec-check CLI SHALL exit with code `2` and a diagnostic message naming the missing input.

**Postcondition:** No analysis output is produced.

#### Scenario: Unrecognized Flag Rejected [CAT-CLI-BADFLAG]
IF the user supplies an unrecognized flag, THEN THE spec-check CLI SHALL exit with code `2` and a diagnostic message naming the unrecognized flag.

**Postcondition:** No analysis output is produced.

### Requirement: Config Loading And Merge [CAT-CLI-CONFIG]
WHEN `--config` is provided, THE spec-check CLI SHALL load the JSON config file, validate its structure, and merge config values with CLI flags where CLI flags take precedence.

**References:**
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Constraints`

#### Scenario: Valid Config Merged [CAT-CONFIG-MERGE]
WHEN a valid config file is loaded and CLI flags are also present, THE spec-check CLI SHALL use CLI flag values over config file values for any overlapping settings.

**Postcondition:** The resolved run configuration reflects CLI precedence.

#### Scenario: Invalid Config Rejected [CAT-CONFIG-FAIL]
IF the `--config` file exists but contains invalid JSON or violates the expected config structure, THEN THE spec-check CLI SHALL exit with code `2` and a diagnostic message before any analysis begins.

**Postcondition:** No analysis output is produced from an invalid configuration.

### Requirement: Discover And Resolve Active Analysis Inputs [CAT-DISCOVER-INPUTS]
WHEN a developer runs `spec-check` with one or more input paths, THE spec-check tool SHALL discover the referenced OpenSpec artifacts, classify proposal, design, spec, and optional task inputs, resolve active capability state from current and in-development specs, and exclude archived change specs from downstream analysis.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Resolve Active Capability Set [CAT-DISCOVER-ACTIVE]
WHEN the input set includes finalized capability specs and in-development change specs, THE spec-check tool SHALL build one active capability catalog that uses finalized specs plus at most one selected in-development delta per capability and SHALL surface skipped conflicts as findings.

**Postcondition:** The active analysis catalog identifies exactly which capability documents will be analyzed and which conflicting deltas were skipped.

#### Scenario: Reject Unreadable Input [CAT-DISCOVER-FAIL]
IF an input path does not exist or is not readable, THEN THE spec-check tool SHALL stop analysis for that run, report the specific unreadable path, and exit with code `2`.

**Postcondition:** No downstream phase runs with an incomplete or ambiguous input catalog.

#### Scenario: Exclude Archived Changes [CAT-DISCOVER-ARCHIVE]
WHEN the input set includes archived change directories, THE spec-check tool SHALL exclude their spec files from the active catalog without emitting a finding.

**Postcondition:** Archived specs do not influence active analysis.

### Requirement: Dependency Availability Check [CAT-CLI-DEPS]
WHEN analysis begins, THE spec-check tool SHALL verify that required external dependencies (`opencode` for LLM-backed phases, `z3` for solver-backed phases) are available and executable before proceeding to phases that need them.

**References:**
- `proposal.md#Assumptions and Dependencies`
- `proposal.md#Failure Modes`

#### Scenario: Missing Opencode Rejected [CAT-DEPS-OPENCODE]
IF `opencode` is required for the selected analysis mode and is not available or not executable, THEN THE spec-check tool SHALL exit with code `2` and a diagnostic message naming the missing dependency.

**Postcondition:** No LLM-backed analysis proceeds without a working `opencode` binary.

#### Scenario: Missing Z3 Rejected [CAT-DEPS-Z3]
IF `z3` is required for the selected analysis mode and is not available at the default path or the `--z3` path, THEN THE spec-check tool SHALL exit with code `2` and a diagnostic message naming the missing dependency.

**Postcondition:** No solver-backed analysis proceeds without a working `z3` binary.

### Requirement: Validate Schema Structure Deterministically [CAT-VALIDATE-STRUCT]
WHEN the spec-check tool parses an input artifact with recognizable headings, THE spec-check tool SHALL deterministically validate schema-mandated structural rules including heading shape, identifier format, scenario presence, references presence, and delta completeness, and SHALL emit structural findings with provenance for every violation.

**References:**
- `proposal.md#Scope`
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Quality Attributes`

#### Scenario: Report Structural Violation [CAT-STRUCT-REPORT]
WHEN a requirement or scenario header violates the canonical identifier format or required section structure, THE spec-check tool SHALL emit a structural finding that names the violated rule, the source file, and the exact line or heading where the violation occurred.

**Postcondition:** Reviewers can identify the failing structural rule without re-parsing the document manually.

#### Scenario: Reject Content With No Headings [CAT-STRUCT-FAIL]
IF an input file contains no recognizable headings, THEN THE spec-check tool SHALL emit a parse-error finding for that file and SHALL exclude that file from downstream phases unless no parseable inputs remain.

**Postcondition:** Downstream phases receive only inputs with minimally recognizable structure.

#### Scenario: Validate Canonical Identifier Format [CAT-STRUCT-IDFORMAT]
WHEN a requirement or scenario declares a bracketed identifier, THE spec-check tool SHALL validate that the identifier matches the canonical format: uppercase letters, digits, and hyphens enclosed in square brackets (e.g., `[UPPER-KEBAB-123]`).

**Postcondition:** Malformed identifiers are surfaced as structural findings before downstream phases use them for traceability.

### Requirement: Spec Parser EARS Pattern Recognition [CAT-PARSE-EARS]
WHEN the spec-check tool parses a capability spec file, THE spec-check tool SHALL recognize EARS-pattern requirement text using the documented keyword patterns (WHEN/THE...SHALL, IF/THEN THE...SHALL, WHILE/THE...SHALL) and SHALL flag requirements that do not follow an EARS pattern or an approved escape-hatch format.

**References:**
- `proposal.md#Domain Model`
- `proposal.md#Scope`

#### Scenario: EARS Requirement Recognized [CAT-EARS-MATCH]
WHEN a requirement body follows a recognized EARS pattern, THE spec-check tool SHALL classify it with the appropriate EARS type (event-driven, state-driven, unwanted-behavior, conditional).

**Postcondition:** The parsed requirement carries its EARS classification for downstream analysis.

#### Scenario: Non-EARS Requirement Flagged [CAT-EARS-WARN]
IF a requirement body does not match any recognized EARS pattern and is not marked as an approved escape-hatch, THEN THE spec-check tool SHALL emit a structural finding recommending EARS conformance.

**Postcondition:** Reviewers are alerted to requirements that may lack testable behavioral structure.

### Requirement: Preserve Unparsed Source Content As Evidence [CAT-PRESERVE-LOSS]
WHEN the parser encounters input lines that do not match any recognized pattern, THE spec-check tool SHALL preserve those lines with file and line provenance and SHALL surface them as parse-warning findings instead of silently dropping them.

**References:**
- `proposal.md#Motivation`
- `proposal.md#Preconditions, Postconditions, and Invariants`
- `proposal.md#Failure Modes`

#### Scenario: Preserve Unparsed Lines [CAT-PRESERVE-LINES]
WHEN a document contains extra content outside recognized fields, THE spec-check tool SHALL record the unmatched lines in parser output and SHALL include provenance for each unmatched fragment in the resulting findings.

**Postcondition:** Analysts can inspect every parser loss boundary as part of the evidence set.

#### Scenario: Prevent Silent Parser Loss [CAT-PRESERVE-FAIL]
IF the parser cannot classify a line of otherwise parseable content, THEN THE spec-check tool SHALL retain the line as evidence and SHALL NOT silently omit it from the analysis record.

**Postcondition:** Parser loss cannot reduce evidence without an explicit surfaced warning.

### Requirement: Parser Determinism [CAT-PARSE-DETERMINISM]
WHEN the spec-check tool parses the same input content on separate runs, THE spec-check tool SHALL produce identical parsed output.

**References:**
- `proposal.md#Quality Attributes`
- `proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Identical Input Produces Identical Parse [CAT-DETERM-SAME]
WHEN the same document content is parsed on two separate runs, THE spec-check tool SHALL produce byte-identical parsed models.

**Postcondition:** Parser output is a deterministic function of input content.

### Requirement: Progress Event Emission [CAT-CLI-PROGRESS]
WHEN the spec-check tool begins or completes a pipeline phase, THE spec-check tool SHALL emit a JSON progress event on stdout containing at least `phase`, `status`, and `timestamp` fields.

**References:**
- `proposal.md#Quality Attributes`
- `proposal.md#Error Format and Exit Codes`

#### Scenario: Phase Start And Completion Events [CAT-PROGRESS-EVENTS]
WHEN a pipeline phase starts, THE spec-check tool SHALL emit a progress event with `status: "started"`, and WHEN the phase completes, SHALL emit a progress event with `status: "completed"` and a `duration_ms` field.

**Postcondition:** Operators can observe pipeline progress in real time.

#### Scenario: Phase Failure Event [CAT-PROGRESS-FAIL]
IF a pipeline phase fails fatally, THEN THE spec-check tool SHALL emit a progress event with `status: "failed"` before exiting.

**Postcondition:** The failing phase is identified in the progress stream.

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements
