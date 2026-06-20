## ADDED Requirements

### Requirement: Surface Catalog Empty Cause [CAT-CATALOG-EMPTY]
WHEN catalog construction completes with zero active documents, THE spec-check tool SHALL classify the empty result as exactly one of: no recognized OpenSpec documents, archived-only recognized documents, or all recognized documents excluded by policy.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Domain Model`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`

#### Scenario: No Recognized Documents [CAT-EMPTY-NODOCS]
WHEN the provided input paths yield zero recognized proposal, design, or spec documents, THE spec-check tool SHALL classify the empty catalog result as `no_recognized_docs`.

**Postcondition:** The CLI can distinguish irrelevant or incorrect inputs from archive-policy filtering.

#### Scenario: Archived-Only Recognized Documents [CAT-EMPTY-ARCHIVE]
WHILE archived inputs are not explicitly allowed, WHEN all recognized documents are archived, THE spec-check tool SHALL classify the empty catalog result as `all_archived`.

**Postcondition:** The CLI can recommend `--allow-archive` as a remediation only when it is actually relevant.

#### Scenario: Policy-Excluded Recognized Documents [CAT-EMPTY-FILTERED]
IF recognized documents are present but another admission or filtering policy removes all of them from the active catalog, THEN THE spec-check tool SHALL classify the empty catalog result as `all_filtered` and SHALL preserve the filtering rationale.

**Postcondition:** Empty-catalog reporting remains extensible to future filtering policies without collapsing into a generic message.

## MODIFIED Requirements

### Requirement: CLI Argument Validation [CAT-CLI-ARGS]
THE spec-check CLI SHALL accept positional input paths and optional `--output`, `--src`, `--caps`, `--z3`, `--config`, `--timeout-ms`, `--allow-archive`, `--help`, and `--version` flags, and SHALL reject unrecognized flags or missing required inputs with exit code `2` before any analysis begins.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Define archive activation as an explicit admission policy, not a discovery policy`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`

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

#### Scenario: Flag Value With Equals Syntax Accepted [CAT-CLI-EQSYNTAX]
WHEN the user supplies a flag using `--flag=value` syntax, THE spec-check CLI SHALL accept the value as equivalent to `--flag value` syntax for all recognized value-bearing flags.

**Postcondition:** Both `--flag value` and `--flag=value` syntaxes are accepted interchangeably.

#### Scenario: Output Directory Inside Source Directory Rejected [CAT-CLI-OUTSRC]
IF the resolved `--output` directory is a descendant of or equal to the resolved `--src` directory, THEN THE spec-check CLI SHALL exit with code `2` and a diagnostic message explaining that the output directory must not reside within the source directory.

**Postcondition:** The read-only source guarantee and output confinement constraints cannot conflict.

#### Scenario: Timeout Flag Accepted [CAT-CLI-TIMEOUT]
WHEN the user supplies `--timeout-ms` with an integer value within the configured allowed range, THE spec-check CLI SHALL accept the value as the universal timeout for all external LLM calls in the run.

**Postcondition:** A single validated timeout policy is available to every LLM-backed phase.

#### Scenario: Config File Timeout Accepted [CAT-CLI-TIMEOUT-CONFIG]
WHEN the user supplies a JSON config file containing a valid numeric `timeoutMs` field and no CLI `--timeout-ms` override, THE spec-check CLI SHALL accept that value as the universal timeout for all external LLM calls in the run.

**Postcondition:** Runtime timeout policy can be sourced from either CLI or config file, with CLI taking precedence.

#### Scenario: Archive Admission Flag Accepted [CAT-CLI-ALLOW-ARCH]
WHEN the user supplies `--allow-archive`, THE spec-check CLI SHALL enable admission of explicitly provided archived documents into the active catalog.

**Postcondition:** Archive admission changes only for explicitly provided archived inputs.

### Requirement: Discover And Resolve Active Analysis Inputs [CAT-DISCOVER-INPUTS]
WHEN a developer runs `spec-check` with one or more input paths, THE spec-check tool SHALL discover the referenced OpenSpec artifacts, classify proposal, design, spec, and optional task inputs, resolve active capability state from current and in-development specs, and exclude archived change specs from downstream analysis unless the run explicitly allows archived inputs for those provided paths.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Represent empty-catalog outcomes as structured catalog diagnostics`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Define archive activation as an explicit admission policy, not a discovery policy`

#### Scenario: Resolve Active Capability Set [CAT-DISCOVER-ACTIVE]
WHEN the input set includes finalized capability specs and in-development change specs, THE spec-check tool SHALL build one active capability catalog that uses finalized specs plus at most one selected in-development delta per capability and SHALL surface skipped conflicts as findings.

**Postcondition:** The active analysis catalog identifies exactly which capability documents will be analyzed and which conflicting deltas were skipped.

#### Scenario: Reject Unreadable Input [CAT-DISCOVER-FAIL]
IF an input path does not exist or is not readable, THEN THE spec-check tool SHALL stop analysis for that run, report the specific unreadable path, and exit with code `2`.

**Postcondition:** No downstream phase runs with an incomplete or ambiguous input catalog.

#### Scenario: Exclude Archived Changes By Default [CAT-DISCOVER-ARCHIVE]
WHILE archived inputs are not explicitly allowed, WHEN the input set includes archived change directories, THE spec-check tool SHALL exclude their recognized documents from the active catalog.

**Postcondition:** Archived documents do not influence active analysis unless the user opts in for the provided archived inputs.

#### Scenario: Allow Explicit Archived Inputs [CAT-DISCOVER-ALLOW-ARCH]
WHERE archive admission is enabled, WHEN a recognized document comes from an explicitly provided archived input path, THE spec-check tool SHALL treat that document as eligible for the active catalog under the same capability-resolution rules as non-archived inputs.

**Postcondition:** Explicitly requested archived content participates in analysis without changing discovery scope.

#### Scenario: Empty Catalog Stops Analysis [CAT-DISCOVER-EMPTY]
IF no active documents survive recognition and catalog admission, THEN THE spec-check tool SHALL stop the run before downstream analysis begins and SHALL surface the classified empty-catalog reason to the CLI.

**Postcondition:** No qualitative, formal, or reporting phase runs against a vacuous active catalog.

## REMOVED Requirements

## RENAMED Requirements
