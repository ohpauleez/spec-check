---
title: CatalogAndParse
---

## Purpose

Define the catalog, input resolution, and structured parsing behavior for the spec-check CLI: discovering relevant OpenSpec artifacts, resolving active capability state, parsing structured content, and producing deterministic structural findings with provenance.

```alloy
module CatalogAndParse
open util/boolean

// --- Pipeline domain vocabulary ---

sig InputPath {}             // A CLI positional input path (file or directory)

// OpenSpec artifacts discovered from input paths
sig Artifact {
  source : one InputPath     // the input path this artifact was discovered from
}

// Subset of artifacts from archived change directories
sig ArchivedArtifact in Artifact {}

// Capability grouping for active catalog resolution
sig Capability {
  finalized : set Artifact,  // finalized spec artifacts for this capability
  inDev : set Artifact       // in-development delta artifacts
}

// Findings with source-file provenance and classification
sig Finding {
  sourceFile : one InputPath,
  kind : one FindingKind
}

abstract sig FindingKind {}
one sig StructuralViolation, ParseWarning, EarsWarning,
        IdentifierError, ParseErrorKind extends FindingKind {}

// EARS pattern classification
abstract sig EarsType {}
one sig Ubiquitous, EventDriven, StateDriven,
        UnwantedBehavior, Conditional extends EarsType {}

// Parsed document: structured representation of an input file
sig ParsedDoc {
  source : one InputPath,
  hasHeadings : one Bool,
  hasUnmatched : one Bool    // true if unparsed content lines exist
}

// Parsed requirement within a document
sig Requirement {
  doc : one ParsedDoc,
  earsType : lone EarsType,  // classified if EARS; absent if non-EARS
  escapeHatch : one Bool      // approved non-EARS escape hatch
}

// Pipeline phases in execution order
abstract sig Phase {}
one sig CliValidate, ConfigLoad, Discover, DependencyCheck,
        Parse, StructValidate, Emit extends Phase {}

// Phase ordering: immediate successor relation
fun phase_order : Phase -> Phase {
  CliValidate -> ConfigLoad +
  ConfigLoad -> Discover +
  Discover -> DependencyCheck +
  DependencyCheck -> Parse +
  Parse -> StructValidate +
  StructValidate -> Emit
}

// External dependencies required by specific analysis modes
abstract sig Dependency {}
one sig OpencodeDep, Z3Dep extends Dependency {}

// Command outcomes (semantic, not exit codes)
abstract sig Outcome {}
one sig CmdSuccess, InputError, ConfigError, DependencyError extends Outcome {}

// --- Mutable pipeline state ---

one sig RunState {
  var completedPhases : set Phase,       // phases that completed successfully
  var findings : set Finding,            // accumulating findings with provenance
  var catalog : set Artifact,            // all discovered artifacts
  var activeCatalog : set Artifact,      // active subset after resolution
  var parsedDocs : set ParsedDoc,        // successfully parsed documents
  var lastOutcome : lone Outcome         // most recent outcome
}
```

## Requirements

### Requirement: CLI Argument Validation [CAT-CLI-ARGS]
THE spec-check CLI SHALL accept positional input paths and optional `--output`, `--src`, `--caps`, `--z3`, `--config`, `--help`, and `--version` flags, and SHALL reject unrecognized flags or missing required inputs with exit code `2` before any analysis begins.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

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

#### Requirement model

```alloy
// --- CLI argument validation: pre-analysis guards ---

pred cli_informational {
  // Guard: only from initial state (--help/-h or --version/-v)
  no RunState.completedPhases
  // Effect: success, no analysis phases run, no findings produced
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = CmdSuccess
}

pred cli_rejected {
  // Guard: only from initial state (missing input, unrecognized flag, output inside src)
  no RunState.completedPhases
  // Effect: InputError, no analysis
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = InputError
}

// Note: --flag=value / --flag value equivalence [CAT-CLI-EQSYNTAX] is a
// syntactic property not expressible in Alloy's relational logic.

pred cli_validate_success {
  // Guard: at least one valid input path, recognized flags, output outside src
  no RunState.completedPhases
  // Effect: CliValidate phase completed
  RunState.completedPhases' = RunState.completedPhases + CliValidate
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
}

// Safety: CLI rejection prevents all downstream analysis
assert cli_rejection_blocks_analysis {
  always (cli_rejected implies
    RunState.completedPhases' = RunState.completedPhases)
}

// Safety: informational commands (help, version) produce no analysis output
assert informational_no_analysis {
  always (cli_informational implies (
    RunState.completedPhases' = RunState.completedPhases and
    RunState.findings' = RunState.findings and
    RunState.catalog' = RunState.catalog))
}
```

### Requirement: Config Loading And Merge [CAT-CLI-CONFIG]
WHEN `--config` is provided, THE spec-check CLI SHALL load the JSON config file, validate its structure, and merge config values with CLI flags where CLI flags take precedence.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Constraints`

#### Scenario: Valid Config Merged [CAT-CONFIG-MERGE]
WHEN a valid config file is loaded and CLI flags are also present, THE spec-check CLI SHALL use CLI flag values over config file values for any overlapping settings.

**Postcondition:** The resolved run configuration reflects CLI precedence.

#### Scenario: Invalid Config Rejected [CAT-CONFIG-FAIL]
IF the `--config` file exists but contains invalid JSON or violates the expected config structure, THEN THE spec-check CLI SHALL exit with code `2` and a diagnostic message before any analysis begins.

**Postcondition:** No analysis output is produced from an invalid configuration.

#### Requirement model

```alloy
// --- Config loading and merge ---
// Config merge is a pure function: CLI flags override config file values.
// Precedence is modeled as a guard rather than tracked state.

pred config_load_success {
  // Guard: CliValidate completed
  CliValidate in RunState.completedPhases
  ConfigLoad not in RunState.completedPhases
  // Effect: ConfigLoad completed, CLI precedence applied
  RunState.completedPhases' = RunState.completedPhases + ConfigLoad
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
}

pred config_load_fail {
  // Guard: CliValidate completed, config JSON invalid or structure violated
  CliValidate in RunState.completedPhases
  ConfigLoad not in RunState.completedPhases
  // Effect: ConfigError, pipeline stops (ConfigLoad NOT added to completed)
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = ConfigError
}

// Safety: invalid config blocks all downstream phases
assert invalid_config_blocks_downstream {
  always (config_load_fail implies (
    Discover not in RunState.completedPhases' and
    Parse not in RunState.completedPhases'))
}
```

### Requirement: Discover And Resolve Active Analysis Inputs [CAT-DISCOVER-INPUTS]
WHEN a developer runs `spec-check` with one or more input paths, THE spec-check tool SHALL discover the referenced OpenSpec artifacts, classify proposal, design, spec, and optional task inputs, resolve active capability state from current and in-development specs, and exclude archived change specs from downstream analysis.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Resolve Active Capability Set [CAT-DISCOVER-ACTIVE]
WHEN the input set includes finalized capability specs and in-development change specs, THE spec-check tool SHALL build one active capability catalog that uses finalized specs plus at most one selected in-development delta per capability and SHALL surface skipped conflicts as findings.

**Postcondition:** The active analysis catalog identifies exactly which capability documents will be analyzed and which conflicting deltas were skipped.

#### Scenario: Reject Unreadable Input [CAT-DISCOVER-FAIL]
IF an input path does not exist or is not readable, THEN THE spec-check tool SHALL stop analysis for that run, report the specific unreadable path, and exit with code `2`.

**Postcondition:** No downstream phase runs with an incomplete or ambiguous input catalog.

#### Scenario: Exclude Archived Changes [CAT-DISCOVER-ARCHIVE]
WHEN the input set includes archived change directories, THE spec-check tool SHALL exclude their spec files from the active catalog without emitting a finding.

**Postcondition:** Archived specs do not influence active analysis.

#### Requirement model

```alloy
// --- Discover and resolve active analysis inputs ---
// Constraints on discovered/active sets are expressed directly on primed/"next" state.

pred discover_success {
  // Guard: ConfigLoad completed
  ConfigLoad in RunState.completedPhases
  Discover not in RunState.completedPhases
  // Postcondition: active catalog excludes archived artifacts
  no (RunState.activeCatalog' & ArchivedArtifact)
  // Postcondition: active catalog is a subset of full catalog
  RunState.activeCatalog' in RunState.catalog'
  // Postcondition: at most one in-dev delta per capability
  all c : Capability | lone (c.inDev & RunState.activeCatalog')
  // New findings: provenance not from archived sources
  all f : RunState.findings' - RunState.findings |
    f.sourceFile not in ArchivedArtifact.source
  // Findings monotonic
  RunState.findings in RunState.findings'
  // Effect
  RunState.completedPhases' = RunState.completedPhases + Discover
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
}

pred discover_reject_unreadable [p : InputPath] {
  // Guard: ConfigLoad completed, input path not readable
  ConfigLoad in RunState.completedPhases
  Discover not in RunState.completedPhases
  // Effect: InputError, pipeline stops
  RunState.completedPhases' = RunState.completedPhases
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.findings' = RunState.findings
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = InputError
}

// Safety: archived artifacts never appear in active catalog
assert archived_never_active {
  always (no (RunState.activeCatalog & ArchivedArtifact))
}

// Safety: unreadable input stops the entire run
assert unreadable_stops_run {
  always (all p : InputPath |
    discover_reject_unreadable[p] implies
      Parse not in RunState.completedPhases')
}

// Safety: at most one in-development delta per capability in active catalog
assert at_most_one_delta_per_capability {
  always (all c : Capability | lone (c.inDev & RunState.activeCatalog))
}
```

### Requirement: Dependency Availability Check [CAT-CLI-DEPS]
WHEN analysis begins, THE spec-check tool SHALL verify that required external dependencies (`opencode` for LLM-backed phases, `z3` for solver-backed phases) are available and executable before proceeding to phases that need them.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Assumptions and Dependencies`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Missing Opencode Rejected [CAT-DEPS-OPENCODE]
IF `opencode` is required for the selected analysis mode and is not available or not executable, THEN THE spec-check tool SHALL exit with code `2` and a diagnostic message naming the missing dependency.

**Postcondition:** No LLM-backed analysis proceeds without a working `opencode` binary.

#### Scenario: Missing Z3 Rejected [CAT-DEPS-Z3]
IF `z3` is required for the selected analysis mode and is not available at the default path or the `--z3` path, THEN THE spec-check tool SHALL exit with code `2` and a diagnostic message naming the missing dependency.

**Postcondition:** No solver-backed analysis proceeds without a working `z3` binary.

#### Requirement model

```alloy
// --- Dependency availability check ---

pred deps_check_success {
  // Guard: Discover completed, all required deps available
  Discover in RunState.completedPhases
  DependencyCheck not in RunState.completedPhases
  // Effect: DependencyCheck completed
  RunState.completedPhases' = RunState.completedPhases + DependencyCheck
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
}

pred deps_missing [d : Dependency] {
  // Guard: Discover completed, dependency d not available or not executable
  Discover in RunState.completedPhases
  DependencyCheck not in RunState.completedPhases
  // Effect: DependencyError, pipeline stops
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = DependencyError
}

// Safety: no LLM-backed analysis without opencode
assert no_llm_without_opencode {
  always (deps_missing[OpencodeDep] implies
    Parse not in RunState.completedPhases')
}

// Safety: no solver-backed analysis without z3
assert no_solver_without_z3 {
  always (deps_missing[Z3Dep] implies
    Parse not in RunState.completedPhases')
}
```

### Requirement: Validate Schema Structure Deterministically [CAT-VALIDATE-STRUCT]
WHEN the spec-check tool parses an input artifact with recognizable headings, THE spec-check tool SHALL deterministically validate schema-mandated structural rules including heading shape, identifier format, scenario presence, references presence, and delta completeness, and SHALL emit structural findings with provenance for every violation.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`

#### Scenario: Report Structural Violation [CAT-STRUCT-REPORT]
WHEN a requirement or scenario header violates the canonical identifier format or required section structure, THE spec-check tool SHALL emit a structural finding that names the violated rule, the source file, and the exact line or heading where the violation occurred.

**Postcondition:** Reviewers can identify the failing structural rule without re-parsing the document manually.

#### Scenario: Reject Content With No Headings [CAT-STRUCT-FAIL]
IF an input file contains no recognizable headings, THEN THE spec-check tool SHALL emit a parse-error finding for that file and SHALL exclude that file from downstream phases unless no parseable inputs remain.

**Postcondition:** Downstream phases receive only inputs with minimally recognizable structure.

#### Scenario: Validate Canonical Identifier Format [CAT-STRUCT-IDFORMAT]
WHEN a requirement or scenario declares a bracketed identifier, THE spec-check tool SHALL validate that the identifier matches the canonical format: uppercase letters, digits, and hyphens enclosed in square brackets (e.g., `[UPPER-KEBAB-123]`).

**Postcondition:** Malformed identifiers are surfaced as structural findings before downstream phases use them for traceability.

#### Requirement model

```alloy
// --- Structural validation: deterministic schema checks ---
// Note: Canonical identifier regex validation (^[A-Z0-9][A-Z0-9-]*$) is a
// syntactic property not fully expressible in Alloy's relational logic.
// The model captures the structural invariant that violations produce findings.
// Refactored to eliminate set-valued parameters.

pred struct_validate_phase {
  // Guard: Parse completed
  Parse in RunState.completedPhases
  StructValidate not in RunState.completedPhases
  let headless = { d : RunState.parsedDocs | d.hasHeadings = False },
      headed = { d : RunState.parsedDocs | d.hasHeadings = True } | {
    // Headless documents produce parse-error findings
    all d : headless |
      (some f : RunState.findings' - RunState.findings |
        f.sourceFile = d.source and f.kind = ParseErrorKind)
    // If headed docs exist, exclude headless; otherwise keep all
    (some headed) implies RunState.parsedDocs' = RunState.parsedDocs - headless
    (no headed) implies RunState.parsedDocs' = RunState.parsedDocs
  }
  // New findings have provenance in the parsed document set
  all f : RunState.findings' - RunState.findings |
    f.sourceFile in RunState.parsedDocs.source
  // Findings monotonic
  RunState.findings in RunState.findings'
  // Effect
  RunState.completedPhases' = RunState.completedPhases + StructValidate
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.lastOutcome' = RunState.lastOutcome
}

// Safety: structural violations always produce findings with provenance
assert violations_produce_findings {
  always (StructValidate in RunState.completedPhases implies
    all d : RunState.findings | some d.sourceFile)
}

// Safety: after structural validation, if headed docs existed, only headed remain
assert headless_excluded_from_downstream {
  always (StructValidate in RunState.completedPhases implies
    (some d : RunState.parsedDocs | d.hasHeadings = True) implies
      (all d : RunState.parsedDocs | d.hasHeadings = True))
}
```

### Requirement: Spec Parser EARS Pattern Recognition [CAT-PARSE-EARS]
WHEN the spec-check tool parses a capability spec file, THE spec-check tool SHALL recognize EARS-pattern requirement text using the documented keyword patterns (WHEN/THE...SHALL, IF/THEN THE...SHALL, WHILE/THE...SHALL) and SHALL flag requirements that do not follow an EARS pattern or an approved escape-hatch format.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Domain Model`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Scope`

#### Scenario: EARS Requirement Recognized [CAT-EARS-MATCH]
WHEN a requirement body follows a recognized EARS pattern, THE spec-check tool SHALL classify it with the appropriate EARS type (ubiquitous, event-driven, state-driven, unwanted-behavior, conditional).

**Postcondition:** The parsed requirement carries its EARS classification for downstream analysis.

#### Scenario: Non-EARS Requirement Flagged [CAT-EARS-WARN]
IF a requirement body does not match any recognized EARS pattern and is not marked as an approved escape-hatch, THEN THE spec-check tool SHALL emit a structural finding recommending EARS conformance.

**Postcondition:** Reviewers are alerted to requirements that may lack testable behavioral structure.

#### Requirement model

```alloy
// --- EARS pattern recognition and parse phase ---
// EARS keyword matching (WHEN/THE...SHALL, IF/THEN, WHILE/THE...SHALL) is a
// syntactic property; the model captures the obligation that non-conforming
// requirements produce findings.
// Refactored to eliminate set-valued parameters.

pred parse_phase {
  // Guard: DependencyCheck completed
  DependencyCheck in RunState.completedPhases
  Parse not in RunState.completedPhases
  // Every active catalog file produces exactly one parsed doc
  RunState.parsedDocs'.source = RunState.activeCatalog.source
  all p : InputPath | lone { d : RunState.parsedDocs' | d.source = p }
  // New findings have provenance in the active catalog
  all f : RunState.findings' - RunState.findings |
    f.sourceFile in RunState.activeCatalog.source
  // EARS: non-EARS, non-escape-hatch requirements produce EarsWarning findings
  all r : Requirement | (r.doc in RunState.parsedDocs' and no r.earsType and r.escapeHatch = False)
    implies (some f : RunState.findings' | f.sourceFile = r.doc.source and f.kind = EarsWarning)
  // Unparsed content surfaced as ParseWarning (enforces no_silent_parser_loss)
  all d : RunState.parsedDocs' | d.hasUnmatched = True implies
    (some f : RunState.findings' | f.sourceFile = d.source and f.kind = ParseWarning)
  // Findings monotonic
  RunState.findings in RunState.findings'
  // Effect
  RunState.completedPhases' = RunState.completedPhases + Parse
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.lastOutcome' = RunState.lastOutcome
}

// Safety: every non-EARS, non-escape-hatch requirement produces a finding
assert non_ears_produces_finding {
  always (Parse in RunState.completedPhases implies
    all r : Requirement | (r.doc in RunState.parsedDocs and no r.earsType and r.escapeHatch = False)
      implies (some f : RunState.findings | f.sourceFile = r.doc.source and f.kind = EarsWarning))
}
```

### Requirement: Preserve Unparsed Source Content As Evidence [CAT-PRESERVE-LOSS]
WHEN the parser encounters input lines that do not match any recognized pattern, THE spec-check tool SHALL preserve those lines with file and line provenance and SHALL surface them as parse-warning findings instead of silently dropping them.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Motivation`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Preserve Unparsed Lines [CAT-PRESERVE-LINES]
WHEN a document contains extra content outside recognized fields, THE spec-check tool SHALL record the unmatched lines in parser output and SHALL include provenance for each unmatched fragment in the resulting findings.

**Postcondition:** Analysts can inspect every parser loss boundary as part of the evidence set.

#### Scenario: Prevent Silent Parser Loss [CAT-PRESERVE-FAIL]
IF the parser cannot classify a line of otherwise parseable content, THEN THE spec-check tool SHALL retain the line as evidence and SHALL NOT silently omit it from the analysis record.

**Postcondition:** Parser loss cannot reduce evidence without an explicit surfaced warning.

#### Requirement model

```alloy
// --- Preserve unparsed source content as evidence ---
// The parser must never silently drop content. Unmatched lines produce
// ParseWarning findings with source-file provenance.

// Safety: every parsed document with unmatched content has a ParseWarning finding
assert no_silent_parser_loss {
  always (Parse in RunState.completedPhases implies
    all d : RunState.parsedDocs | d.hasUnmatched = True implies
      (some f : RunState.findings | f.sourceFile = d.source and f.kind = ParseWarning))
}

// Safety: findings only accumulate, never shrink
assert findings_monotonic {
  always (RunState.findings in RunState.findings')
}
```

### Requirement: Parser Determinism [CAT-PARSE-DETERMINISM]
WHEN the spec-check tool parses the same input content on separate runs, THE spec-check tool SHALL produce identical parsed output.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Preconditions, Postconditions, and Invariants`

#### Scenario: Identical Input Produces Identical Parse [CAT-DETERM-SAME]
WHEN the same document content is parsed on two separate runs, THE spec-check tool SHALL produce byte-identical parsed models.

**Postcondition:** Parser output is a deterministic function of input content.

#### Requirement model

```alloy
// --- Parser determinism: functional refinement ---
// Since Alloy atoms represent identity, two InputPaths with the same
// content are the same atom. Determinism means each InputPath produces
// at most one ParsedDoc in any completed parse phase.

pred parse_is_functional {
  all p : InputPath |
    lone { d : RunState.parsedDocs | d.source = p }
}

// Safety: parse output is a deterministic function of input content
assert parse_deterministic {
  always (Parse in RunState.completedPhases implies parse_is_functional)
}
```

### Requirement: Progress Event Emission [CAT-CLI-PROGRESS]
WHEN the spec-check tool begins or completes a pipeline phase, THE spec-check tool SHALL emit a JSON progress event on stdout containing at least `phase`, `status`, and `timestamp` fields.

**References:**
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Quality Attributes`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Error Format and Exit Codes`

#### Scenario: Phase Start And Completion Events [CAT-PROGRESS-EVENTS]
WHEN a pipeline phase starts, THE spec-check tool SHALL emit a progress event with `status: "started"`, and WHEN the phase completes, SHALL emit a progress event with `status: "completed"` and a `duration_ms` field.

**Postcondition:** Operators can observe pipeline progress in real time.

#### Scenario: Phase Failure Event [CAT-PROGRESS-FAIL]
IF a pipeline phase fails fatally, THEN THE spec-check tool SHALL emit a progress event with `status: "failed"` before exiting.

**Postcondition:** The failing phase is identified in the progress stream.

#### Requirement model

```alloy
// --- Progress event emission and pipeline lifecycle ---
// Progress events are modeled as obligations on phase transitions
// rather than tracked state. The key properties are:
// - Every phase transition produces an event (safety)
// - A valid pipeline eventually reaches completion (liveness)

pred emit_phase {
  // Guard: StructValidate completed
  StructValidate in RunState.completedPhases
  Emit not in RunState.completedPhases
  // Effect: pipeline complete
  RunState.completedPhases' = RunState.completedPhases + Emit
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = CmdSuccess
}

// Safety: completed phases monotonically grow (no phase un-completes)
assert completed_phases_monotonic {
  always (RunState.completedPhases in RunState.completedPhases')
}

// Safety: phase ordering is always respected
assert phase_ordering_respected {
  always (all p1, p2 : Phase |
    (p1 -> p2) in ^phase_order and p2 in RunState.completedPhases
      implies p1 in RunState.completedPhases)
}

// Liveness: if CLI validation succeeds and no phase fails fatally,
// the pipeline eventually reaches the Emit phase.
// Strong fairness: each phase's success transition eventually fires
// when its guard holds, modeling a cooperative environment (valid
// inputs, valid config, available dependencies).
// Note: the original formulation used `no X & Y` instead of `X not in Y`
// so that absent lastOutcome (lone field) was correctly handled as
// non-error; the restructured assertion uses fairness as a premise
// instead, making that idiom unnecessary.
pred pipeline_fairness {
  // If CLI validation is enabled (initial state), it eventually succeeds
  always (no RunState.completedPhases implies
    eventually cli_validate_success)
  // If config loading is enabled, it eventually succeeds
  always ((CliValidate in RunState.completedPhases and
           ConfigLoad not in RunState.completedPhases) implies
    eventually config_load_success)
  // If discovery is enabled, it eventually succeeds
  always ((ConfigLoad in RunState.completedPhases and
           Discover not in RunState.completedPhases) implies
    eventually discover_success)
  // If dependency check is enabled, it eventually succeeds
  always ((Discover in RunState.completedPhases and
           DependencyCheck not in RunState.completedPhases) implies
    eventually deps_check_success)
  // If parsing is enabled, it eventually succeeds
  always ((DependencyCheck in RunState.completedPhases and
           Parse not in RunState.completedPhases) implies
    eventually parse_phase)
  // If structural validation is enabled, it eventually succeeds
  always ((Parse in RunState.completedPhases and
           StructValidate not in RunState.completedPhases) implies
    eventually struct_validate_phase)
  // If emit is enabled, it eventually fires
  always ((StructValidate in RunState.completedPhases and
           Emit not in RunState.completedPhases) implies
    eventually emit_phase)
}

assert pipeline_progress_liveness {
  pipeline_fairness implies eventually (Emit in RunState.completedPhases)
}
```

### State machine and invariant checks
```alloy
// --- Transition system ---

pred stutter {
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
}

pred init_state {
  no RunState.completedPhases
  no RunState.findings
  no RunState.catalog
  no RunState.activeCatalog
  no RunState.parsedDocs
  no RunState.lastOutcome
}

fact transitions {
  init_state and always (
    // CLI validation
    cli_informational
    or cli_rejected
    or cli_validate_success
    // Config
    or config_load_success
    or config_load_fail
    // Discovery (no set-valued quantification)
    or discover_success
    or (some p : InputPath | discover_reject_unreadable[p])
    // Dependencies
    or deps_check_success
    or (some d : Dependency | deps_missing[d])
    // Parse (no set-valued quantification)
    or parse_phase
    // Structural validation (no set-valued quantification)
    or struct_validate_phase
    // Emit
    or emit_phase
    // Stutter
    or stutter
  )
}

// --- Commands ---

run show_spec_check {} for 3 InputPath, 4 Artifact, 2 Capability, 5 Finding, 3 ParsedDoc, 2 Requirement, 8 steps

run scenario_full_pipeline {
  eventually (Emit in RunState.completedPhases)
} for 3 InputPath, 4 Artifact, 2 Capability, 5 Finding, 3 ParsedDoc, 2 Requirement, 10 steps

run scenario_config_failure_stops_pipeline {
  eventually (RunState.lastOutcome = ConfigError)
} for 2 InputPath, 2 Artifact, 1 Capability, 2 Finding, 2 ParsedDoc, 1 Requirement, 5 steps

check cli_rejection_blocks_analysis for 3 InputPath, 3 Artifact, 2 Capability, 3 Finding, 3 ParsedDoc, 2 Requirement, 10 steps expect 0
check informational_no_analysis for 3 InputPath, 3 Artifact, 2 Capability, 3 Finding, 3 ParsedDoc, 2 Requirement, 10 steps expect 0
check invalid_config_blocks_downstream for 3 InputPath, 3 Artifact, 2 Capability, 3 Finding, 3 ParsedDoc, 2 Requirement, 10 steps expect 0
check archived_never_active for 3 InputPath, 4 Artifact, 2 Capability, 3 Finding, 3 ParsedDoc, 2 Requirement, 15 steps expect 0
check at_most_one_delta_per_capability for 3 InputPath, 4 Artifact, 2 Capability, 3 Finding, 3 ParsedDoc, 2 Requirement, 15 steps expect 0
check no_llm_without_opencode for 3 InputPath, 3 Artifact, 2 Capability, 3 Finding, 3 ParsedDoc, 2 Requirement, 10 steps expect 0
check no_solver_without_z3 for 3 InputPath, 3 Artifact, 2 Capability, 3 Finding, 3 ParsedDoc, 2 Requirement, 10 steps expect 0
check violations_produce_findings for 3 InputPath, 4 Artifact, 2 Capability, 5 Finding, 3 ParsedDoc, 2 Requirement, 10 steps expect 0
check headless_excluded_from_downstream for 3 InputPath, 4 Artifact, 2 Capability, 5 Finding, 3 ParsedDoc, 2 Requirement, 10 steps expect 0
check non_ears_produces_finding for 3 InputPath, 4 Artifact, 2 Capability, 5 Finding, 3 ParsedDoc, 2 Requirement, 10 steps expect 0
check no_silent_parser_loss for 3 InputPath, 4 Artifact, 2 Capability, 5 Finding, 3 ParsedDoc, 2 Requirement, 10 steps expect 0
check findings_monotonic for 3 InputPath, 4 Artifact, 2 Capability, 5 Finding, 3 ParsedDoc, 2 Requirement, 15 steps expect 0
check parse_deterministic for 3 InputPath, 4 Artifact, 2 Capability, 3 Finding, 3 ParsedDoc, 2 Requirement, 10 steps expect 0
check completed_phases_monotonic for 3 InputPath, 3 Artifact, 2 Capability, 3 Finding, 3 ParsedDoc, 2 Requirement, 15 steps expect 0
check phase_ordering_respected for 3 InputPath, 3 Artifact, 2 Capability, 3 Finding, 3 ParsedDoc, 2 Requirement, 15 steps expect 0
check pipeline_progress_liveness for 3 InputPath, 4 Artifact, 2 Capability, 5 Finding, 3 ParsedDoc, 2 Requirement, 20 steps expect 0
```
