## MODIFIED Requirements

### Requirement: Dependency Availability Check [CAT-CLI-DEPS]
WHEN analysis begins after run-start output cleanup, THE spec-check tool SHALL verify that required external dependencies (`opencode` for LLM-backed phases, `z3` for solver-backed phases) are available and executable before proceeding to phases that need them, and SHALL resolve a supported OpenCode release through the bounded version probe before any analysis invocation.

**References:**
- `openspec/changes/support-opencode-v2/proposal.md#Constraints`
- `openspec/changes/support-opencode-v2/design.md#Runtime-Resolution`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Assumptions and Dependencies`
- `openspec/changes/archive/2026-06-18-spec-check-core/proposal.md#Failure Modes`

#### Scenario: Missing Opencode Rejected [CAT-DEPS-OPENCODE]
IF `opencode` is required for the selected analysis mode and is not available or not executable, THEN THE spec-check tool SHALL exit with code `4` and a diagnostic message naming the missing dependency.

**Postcondition:** No LLM-backed analysis proceeds without a working `opencode` binary.

##### Evidence
- Existing implementation baseline: [pipeline-helpers.ts:58 checkDependencies()](/src/cli/pipeline-helpers.ts#L58), [process.ts:44 isCommandAvailable()](/src/adapters/process.ts#L44). New bounded detection evidence is produced by the change tasks.

#### Scenario: Missing Z3 Rejected [CAT-DEPS-Z3]
IF `z3` is required for the selected analysis mode and its default PATH command or configured `--z3` command cannot execute successfully, THEN THE spec-check tool SHALL exit with code `4` during the dependency phase, emit a bounded inert diagnostic identifying the command, failure reason, and corrective checks, and SHALL NOT begin any LLM analysis or solver query.

**Postcondition:** Exactly one argv-only `z3 --version` preflight is attempted after successful OpenCode detection, with a fixed `5000` ms timeout and `16384`-byte combined capture limit plus the process adapter's `250` ms cleanup allowance, subject to event-loop scheduling. Only a signal-free zero exit without spawn error, timeout or overflow succeeds. Missing commands, `EACCES`/`EPERM`, other spawn failures, nonzero exit, signal, timeout and overflow are dependency failures, not warnings that permit paid work. No Z3 version policy or SMT query is introduced. Preflight consumes no model retry budget or telemetry attempt. Failed runs publish no new completion manifest; help/version remain dependency-free.

##### Evidence
- Implementation: [checkDependencies()](/src/cli/pipeline-helpers.ts), [probeZ3Dependency()](/src/adapters/z3.ts), and [runProcess()](/src/adapters/process.ts).
- Regression evidence: [z3-preflight.test.ts](/test/contract/z3-preflight.test.ts), [process.test.ts](/test/contract/process.test.ts), [z3-preflight.integration.test.ts](/test/integration/z3-preflight.integration.test.ts), and successful compiled/bundled one-probe pipelines in [opencode-runtime.integration.test.ts](/test/integration/opencode-runtime.integration.test.ts).

#### Requirement model

```alloy
// --- Dependency availability check ---
// Failure modes: opencode missing/non-executable, z3 missing/non-executable.

pred deps_check_success {
  // Guard: Discover completed, all required deps available, no prior fatal outcome
  Discover in RunState.completedPhases
  DependencyCheck not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: DependencyCheck completed
  RunState.completedPhases' = RunState.completedPhases + DependencyCheck
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = RunState.lastOutcome
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred deps_missing_opencode {
  // Guard: Discover completed, opencode not available or not executable, no prior outcome
  Discover in RunState.completedPhases
  DependencyCheck not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: DependencyError, pipeline stops
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = DependencyError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

pred deps_missing_z3 {
  // Guard: Discover completed, z3 not available at default or --z3 path, no prior outcome
  Discover in RunState.completedPhases
  DependencyCheck not in RunState.completedPhases
  no RunState.lastOutcome
  // Effect: DependencyError, pipeline stops
  RunState.completedPhases' = RunState.completedPhases
  RunState.findings' = RunState.findings
  RunState.catalog' = RunState.catalog
  RunState.activeCatalog' = RunState.activeCatalog
  RunState.parsedDocs' = RunState.parsedDocs
  RunState.lastOutcome' = DependencyError
  RunState.emptyCatalogReason' = RunState.emptyCatalogReason
}

// Composite: any dependency missing
pred deps_missing [d : Dependency] {
  (d = OpencodeDep and deps_missing_opencode)
  or (d = Z3Dep and deps_missing_z3)
}

// Safety: no LLM-backed analysis without opencode
assert no_llm_without_opencode {
  always (deps_missing_opencode implies
    Parse not in RunState.completedPhases')
}

// Safety: no solver-backed analysis without z3
assert no_solver_without_z3 {
  always (deps_missing_z3 implies
    Parse not in RunState.completedPhases')
}

// Safety: dependency failure always produces DependencyError outcome
assert dep_failure_outcome {
  always ((deps_missing_opencode or deps_missing_z3) implies
    RunState.lastOutcome' = DependencyError)
}
```

## ADDED Requirements

### Requirement: Detect Supported OpenCode Release [CAT-OC-VERSION]
WHEN checking OpenCode for an analysis run, THE spec-check tool SHALL invoke the selected binary with `--version` using argv-only execution, a fixed `5000` ms process timeout, and a `16384`-byte combined stdout/stderr capture limit, and SHALL accept only successful strict-UTF-8 stdout matching the release grammar below with major `1` or `2`.

**References:**
- `openspec/changes/support-opencode-v2/proposal.md#Constraints`
- `openspec/changes/support-opencode-v2/design.md#Release-Encoding`

**Format justification:** A grammar and validity rules express the accepted encoding more precisely than a separate EARS statement for each character constraint.

```text
VERSION_LINE := ["opencode "] ["v"] CORE ["-" PRERELEASE] ["+" BUILD]
CORE         := NUMBER "." NUMBER "." NUMBER
NUMBER       := "0" | [1-9][0-9]*
PRERELEASE   := IDENTIFIER ("." IDENTIFIER)*
BUILD        := IDENTIFIER ("." IDENTIFIER)*
IDENTIFIER   := [0-9A-Za-z-]+
```

THE spec-check tool SHALL normalize CRLF to LF, trim outer whitespace, require exactly one nonempty stdout line matching the entire grammar, reject numeric prerelease identifiers with leading zeroes and unsafe-integer core components, match prefixes case-sensitively, and store the version without the optional `opencode ` and `v` prefixes. Successful stderr diagnostics SHALL NOT supply the parsed version.

#### Scenario: Accept Supported Release [CAT-OC-VERSION-ACCEPT]
WHEN a successful probe emits `1.2.3`, `v1.2.3`, `opencode v2.0.15`, or `opencode v2.0.15-rc.1+build.7`, THE spec-check tool SHALL resolve the corresponding canonical semantic version and major and emit one concise detected-version/protocol diagnostic on stderr.

#### Scenario: Bound Version Presentation [CAT-OC-VERSION-PREVIEW]
WHEN a valid semantic version has a long suffix, THE spec-check tool SHALL retain its complete canonical version when minting a supported runtime descriptor and SHALL restrict the version presentation in both success and unsupported-major diagnostics to at most 300 inert characters.

#### Scenario: Reject Invalid Or Unsupported Probe [CAT-OC-VERSION-REJECT]
IF the probe cannot spawn, exits nonzero, receives a signal, times out, exceeds the capture limit, emits malformed UTF-8 or invalid/multiple stdout lines, or reports an unsupported major, THEN THE spec-check tool SHALL fail with `DependencyError` exit `4`, a bounded inert diagnostic, and zero analysis invocations.

**Postcondition:** Detection causes are classified as `spawn_error`, `timeout`, `output_limit`, `invalid_version`, or `unsupported_major`. A signal or nonzero exit without timeout/output overflow is `spawn_error`. No assumed version or cross-major fallback is used.

#### Scenario: Preserve Informational Fast Paths [CAT-OC-VERSION-INFO]
WHEN invoked with `--help` or `--version`, THE spec-check tool SHALL produce its existing informational output without probing OpenCode or contacting other external dependencies.

### Requirement: Preserve Run Protocol Identity [CAT-OC-RUNTIME]
WHILE an analysis run is active, THE spec-check tool SHALL use its single immutable resolved OpenCode runtime for every model invocation, retry, and optional final-report call, without sharing that runtime with concurrent runs or persisting it between CLI invocations.

**References:**
- `openspec/changes/support-opencode-v2/proposal.md#Invariants`
- `openspec/changes/support-opencode-v2/design.md#Runtime-Resolution`

#### Scenario: Reuse Run Runtime [CAT-OC-RUNTIME-REUSE]
WHEN a valid run executes multiple phases and retries, THE spec-check tool SHALL perform exactly one OpenCode version probe for that run and retain the same binary/version/major descriptor through final reporting.

#### Scenario: Isolate Concurrent Runs [CAT-OC-RUNTIME-ISOLATE]
WHEN two analysis runs with different resolved binaries execute concurrently, THE spec-check tool SHALL encode each run's invocations using only its own runtime descriptor.

#### Scenario: Resolve Direct Adapter Call [CAT-OC-RUNTIME-DIRECT]
WHEN a valid direct adapter call executes, THE OpenCode adapter SHALL select an explicit runtime override first, otherwise a matching scoped runtime, otherwise one bounded detection outside a scope, and SHALL resolve that selection before the retry loop.

#### Scenario: Reject Mismatched Runtime [CAT-OC-RUNTIME-MISMATCH]
IF a selected binary conflicts with its explicit descriptor or a call without an explicit override conflicts with the scoped descriptor, THEN THE OpenCode adapter SHALL return a non-retryable `runtime_error` before any probe or analysis spawn.

#### Scenario: Reject Direct Detection Failure [CAT-OC-RUNTIME-FAIL]
IF direct-call runtime detection fails, THEN THE OpenCode adapter SHALL return a non-retryable `runtime_error` containing the detection cause without consuming model retries or triggering formalization model-response degradation.

**Postcondition:** Runtime resolution does not pin executable bytes. Executable replacement during a run has no compatibility guarantee.

### Requirement: Normalize OpenCode Model Selection [CAT-OC-MODEL]
WHEN resolving an effective model setting, THE spec-check tool SHALL normalize it into a base model and optional variant, enforce Luna=`max` and Terra=`high` for the existing `github-copilot/gpt-5.6-*` fixed-policy models, and use that same semantic selection for invocation and telemetry.

**References:**
- `openspec/changes/support-opencode-v2/proposal.md#Invariants`
- `openspec/changes/support-opencode-v2/design.md#Model-Encoding`

#### Scenario: Preserve Bare Model Selection [CAT-OC-MODEL-BARE]
WHEN the effective model contains no `#` and satisfies existing nonempty-model validation, THE spec-check tool SHALL preserve its base value, apply the fixed variant for Luna/Terra, and leave other models without a forced variant.

#### Scenario: Accept Explicit Variant [CAT-OC-MODEL-EXPLICIT]
WHEN the effective model has exactly one `#`, no whitespace, a nonempty provider before the first `/`, a nonempty model after it, and a nonempty variant, THE spec-check tool SHALL preserve component case and additional model `/` characters and accept the explicit variant unless it conflicts with the fixed policy.

**Postcondition:** A matching fixed suffix is accepted. OpenCode, not `spec-check`, validates catalog availability for other models and variants.

#### Scenario: Reject Invalid Model Selection [CAT-OC-MODEL-INVALID]
IF the effective model is malformed or its explicit suffix conflicts case-sensitively with a fixed variant, THEN THE spec-check tool SHALL return `ConfigError` exit `3` before dependency work, and THE adapter for an equivalent invalid direct call SHALL return non-retryable `invalid_model` before any probe or analysis spawn.

**Postcondition:** Empty/whitespace-only components, an empty suffix, extra `#` separators, and whitespace in explicit references are rejected without silently trimming or changing case. Existing prompt/file/timeout request-shape failures likewise remain pre-spawn failures.

### Requirement: Encode Version Appropriate Model Calls [CAT-OC-INVOKE]
WHEN invoking OpenCode with a normalized model selection, THE OpenCode adapter SHALL encode the selected variant as separate `--model <base> --variant <variant>` arguments for v1 and as `--model <base>#<variant>` for v2, omit variant syntax when absent, and retain argv-only prompts, JSON output, validated attachments, and existing per-call timeout/retry budgets.

**References:**
- `openspec/changes/support-opencode-v2/proposal.md#Scope`
- `openspec/changes/support-opencode-v2/design.md#Invocation-Protocol`

#### Scenario: Invoke Both Protocol Families [CAT-OC-INVOKE-FAMILY]
WHEN the same Terra model selection is invoked against v1 and v2 fixtures, THE adapter SHALL respectively pass `--model github-copilot/gpt-5.6-terra --variant high` and `--model github-copilot/gpt-5.6-terra#high`, preserving prompt and repeated-file identities under each verified argument ordering.

#### Scenario: Preserve Protocol Across Retries [CAT-OC-INVOKE-RETRY]
IF an invocation fails and existing policy permits a retry, THEN THE adapter SHALL reuse the same resolved runtime and normalized model selection without re-probing or trying another major's arguments.

### Requirement: Bound Owned Subprocess Termination [CAT-PROCESS-BOUND]
WHEN an external call reaches its timeout or capture limit, THE process adapter SHALL request termination of its owned process tree and SHALL finalize its own streams/result exactly once within a fixed 250 ms cleanup allowance after that request, without waiting indefinitely for descendant-held pipes, subject to Node event-loop scheduling.

**References:**
- `openspec/changes/support-opencode-v2/design.md#Review-Correction-Contracts`

**Ownership:** POSIX invocations own a newly created process group. Timeout/overflow terminates descendants that remain in that group, including when the immediate parent has already exited. Deliberately detached process groups and existing shared OpenCode services are outside this ownership. Windows uses bounded best-effort tree termination; Linux evidence does not establish Windows cleanup success.

#### Scenario: Terminate Owned Descendants [CAT-PROCESS-DESCENDANTS]
IF an owned descendant retains inherited stdout/stderr after timeout or capture overflow, THEN THE process adapter SHALL terminate the owned group and return the corresponding failure flags within the cleanup bound, including after immediate-parent exit.

#### Scenario: Bound Escaped Pipe Holders [CAT-PROCESS-PIPE-CLEANUP]
IF an out-of-group descendant retains a pipe after termination is requested, THEN THE process adapter SHALL destroy its own stream handles and settle within the cleanup allowance without claiming that the escaped process was contained or terminated.
