## Motivation

`spec-check` produces detailed phase reports, raw evidence, a summary, and a completion manifest. Engineers must still perform a separate synthesis pass before they can decide what to fix. The evaluated `report_prompts/prompt_f.md` prompt performs that synthesis well, but it is not part of the normal command. This leaves the most decision-oriented artifact dependent on a manual, inconsistently configured agent invocation.

This change adds a bounded final-report step that reads a completed evidence bundle and writes `report.md`. The report is deliberately a post-completion derivative rather than evidence used to establish pipeline completion. A report-generation failure therefore does not invalidate successful analysis. It removes any partial report and records a warning in the checksummed core bundle.

## Scope

### In Scope

- Generate `report.md` after the phase reports, `report_summary.md`, and the core `manifest.json` establish that analysis completed.
- Use the evaluated prompt F with runtime-bound absolute paths for the configured evidence directory and exact report destination.
- Give the final-report agent read-only access to the workspace and evidence bundle and deny all file mutation tools.
- Require the agent to return the destination and complete Markdown in one strict JSON payload.
- Validate the payload path and Markdown, then atomically publish `report.md` through the trusted filesystem adapter and independently validate the resulting file.
- Keep `report.md` outside `manifest.json` because the report is produced after core completion and derives from the manifested evidence.
- Invalidate the prior manifest first, then remove stale tool-owned reports, metrics, and raw evidence before a new run starts.
- Treat generation and validation failures as nonfatal: remove any partial or invalid report, append a `reporting.final_report_failed` warning, rewrite `report_summary.md`, and refresh `manifest.json` so its checksum remains valid. Surface cleanup or warning-persistence failures as fatal `OutputError` results.
- Resolve the configured output directory to an absolute path before it enters the pipeline.
- Preserve prompt parity between the repository prompt and the prompt embedded in the bundled distribution.
- Extend the reporting lifecycle model and verification evidence for report success, failure, cleanup, permissions, path confinement, and manifest exclusion.
- Update user-facing and architecture documentation for the new artifact and its completion semantics.

### Out of Scope

- Making `report.md` mandatory for a successful analysis run.
- Adding `report.md` to `manifest.json` or using it as evidence for its own generation.
- Changing the content strategy selected by the prompt evaluation, beyond runtime paths and structured report transport.
- Changing existing analysis phases, phase reports, solver behavior, or source-backed analysis behavior.
- Adding a CLI flag to disable final-report generation or select a separate report model.
- Rerunning the report-prompt evaluation.
- Guaranteeing cleanup after uncatchable process termination such as `SIGKILL` or host failure.

## Context

### Background

The reporting phase currently writes phase reports and `report_summary.md`, then writes `manifest.json` last as the sole core-run completion marker. Prompt F requires the reviewer to read `manifest.json` first, inventory the evidence directory, and distinguish manifested evidence from integrity-unverified artifacts. It therefore cannot run correctly before the manifest exists.

Evaluations in `pasture/report_prompts_eval*` selected prompt F as a strong decision-oriented report prompt. A production run then disproved the direct-write design: all retries used the custom final-report agent, but OpenCode denied `apply_patch` because path-granular edit rules do not match the patch envelope resource. One retry falsely acknowledged success after failed writes. The corrected protocol returns the report body as structured data and leaves atomic publication to `spec-check`, matching existing report generation.

### Affected Systems and Stakeholders

- Engineers who consume `spec-check` output and need prioritized remediation guidance.
- The reporting lifecycle and manifest completion contract.
- The OpenCode adapter and its process, permission, acknowledgment, and timeout boundary.
- Prompt construction and bundled-distribution parity.
- Filesystem confinement and stale-output cleanup.
- Maintainers of `README.md`, `ARCHITECTURE.md`, `docs/design.md`, and the `reporting-and-evidence` capability specification.

### Assumptions and Dependencies

- Core reporting has completed and a readable `manifest.json` exists before final-report generation starts.
- OpenCode supports a non-interactive agent with workspace reads and explicit denial of mutation tools.
- OpenCode `--pure` suppresses external plugins for this invocation; managed administrator policy may still deny required access but cannot be bypassed.
- The workspace root supplied to OpenCode contains the analyzed specifications and, when configured, source files.
- The configured evidence directory and report path can be represented as absolute filesystem paths, including paths containing spaces.
- The selected model returns a strict payload with the requested report body; the implementation validates it before any write.
- The operating system provides regular-file and symbolic-link metadata needed to validate the generated file.
- The existing timeout remains the bound for the final-report invocation.

### Constraints

- `manifest.json` remains the completion marker for the core evidence bundle.
- `report.md` is intentionally absent from that manifest in both success and failure states.
- Existing input documents and source files remain read-only.
- The agent must not receive unrestricted build permissions and must not run with `--auto`.
- Expected generation and validation failures are represented as data and degrade to a warning. Cleanup and warning-persistence failures are fatal `OutputError` results because no safe handled postcondition can be claimed.
- Report validation is independent of the model acknowledgment.
- The report is bounded to at most 1,048,576 bytes to limit resource use and accidental output amplification.
- Because OpenCode permission paths treat `*` and `?` as wildcards, an output path containing either character cannot express exact single-file authority and degrades final-report generation to a warning.
- New code follows `docs/typescript_style.md`; verification follows the invariant-first, model-backed, layered approach in `docs/lfm.md`.

### References

- `plan_b.md` - selected engineering plan
- `report_prompts/prompt_f.md` - evaluated report prompt
- `pasture/report_prompts_eval*` - prompt evaluation evidence
- `docs/lfm.md` - lightweight formal methods workflow
- `docs/typescript_style.md` - implementation and contract guidance
- `docs/design.md` - pipeline and completion design
- `ARCHITECTURE.md` - code and boundary map
- `openspec/specs/reporting-and-evidence/spec.md` - current reporting contract

## Domain Model

- **Core Evidence Bundle**: The phase reports, summary, raw evidence, and manifest produced by a successful analysis. Manifest presence marks core completion.
- **Completion Manifest**: The checksummed inventory of core output artifacts. It does not include the final report.
- **Final Report Request**: The evaluated instructions plus the absolute evidence-directory path, absolute destination path, model, timeout, and workspace root.
- **Restricted Report Agent**: A transient read-only OpenCode agent that may inspect the workspace and evidence bundle but cannot modify files.
- **Report Payload**: A strict JSON object whose `report_path` equals the designated destination and whose `report_markdown` contains the complete assessment.
- **Final Report**: A post-completion Markdown derivative named `report.md`. A valid report is a non-symlink regular UTF-8 file, is at most 1 MiB, contains every prompt-required section and a repository-relative citation, and gives every numbered prioritized finding its own artifact citation.
- **Report Failure Warning**: A warning finding with category `reporting.final_report_failed` that describes a terminal report-generation or validation failure and records its failure kind.
- **Final Report Outcome**: Exactly one terminal result for an attempted report: `valid_report`, `warning_without_report`, or fatal `output_failure`. The third result means cleanup or warning persistence could not establish a safe handled outcome.

```mermaid
flowchart LR
    E[Core evidence artifacts] --> M[Completion manifest]
    M --> A[Restricted report agent]
    A --> K[JSON report payload]
    K --> V[Path and content validation]
    V -->|valid| P[Atomic trusted publication]
    P --> R[Optional report.md]
    V -->|failure| C[Remove candidate]
    C --> W[Persist warning in summary]
    W --> X[Refresh core manifest]
```

## Preconditions, Postconditions, and Invariants

### Preconditions

- Core reporting completed successfully and `manifest.json` exists before the final-report agent starts.
- The output directory, workspace root, and report destination are absolute paths.
- The report destination resolves exactly to `report.md` directly under the configured output directory.
- The model and timeout passed to the adapter have already passed configuration validation.

### Postconditions

- Every attempted final-report generation reaches exactly one terminal result: one validated `report.md`; no `report.md` plus one persisted `reporting.final_report_failed` warning; or a fatal `OutputError` without a claim that either handled postcondition holds.
- On success, `report.md` meets the strict UTF-8, required-heading, citation, regular-file, and 1 MiB rules and is absent from `manifest.json`.
- On handled failure, the designated report path is absent, the refreshed summary contains the warning, every manifest checksum still matches its core file, and the run remains complete.
- A new run invalidates the prior manifest before it removes all tool-owned output. If cleanup fails, analysis does not start and the CLI returns `OutputError` without claiming a current completed bundle.
- Prompt source and bundled prompt content remain equivalent after the defined runtime substitutions.

### Invariants

- **Core-completion monotonicity**: once the core manifest exists, final-report success or handled failure does not turn the run into a failed analysis.
- **Manifest exclusion**: `report.md` is never a manifest entry.
- **Terminal partition**: after an attempted report step, exactly one of `ValidReport`, `WarningWithoutReport`, and `OutputFailure` holds.
- **No invalid residue**: a failed report step leaves no file, symlink, directory, empty file, whitespace-only file, or oversized file at the designated path.
- **Single-writer confinement**: the agent cannot modify files; only the trusted filesystem adapter may atomically publish the exact report destination.
- **Path agreement**: the requested path, acknowledgment path, and validated path are equal absolute paths inside the configured output directory.
- **Validation authority**: payload and post-write filesystem validation together determine report success.
- **Bounded work**: one final-report invocation uses the configured timeout, bounded adapter retries, a bounded acknowledgment, and a 1 MiB report limit.
- **Warning integrity**: if a warning changes `report_summary.md`, the manifest is refreshed after the summary write so its checksum matches the final summary bytes.
- **Prompt parity**: the editable canonical prompt and embedded distribution prompt differ only by declared runtime substitutions.

## Failure Modes

- **Agent or model failure**: OpenCode cannot start, times out, exits unsuccessfully, or returns invalid protocol output.
  - **Rationale**: Report synthesis is nondeterministic and externally dependent; it must not erase a completed analysis or leave ambiguous output.
- **Missing report body**: The payload names a path but omits valid Markdown.
  - **Rationale**: A path assertion cannot substitute for the report body.
- **Invalid report object**: The destination is a symlink, directory, special file, empty or whitespace-only file, or exceeds 1 MiB.
  - **Rationale**: Following links can escape confinement, and malformed or unbounded output is unsafe to publish as a report.
- **Path disagreement**: The acknowledgment names a path other than the exact configured destination.
  - **Rationale**: A path mismatch indicates protocol failure or an attempted write outside the intended single-writer region.
- **Unrepresentable permission path**: The configured output path contains `*` or `?`, so OpenCode would interpret the report path as a wildcard rule.
  - **Rationale**: Broadening an edit rule would violate the single-writer invariant; safe degradation is preferable to ambiguous authority.
- **Unauthorized mutation attempt**: The agent attempts to modify a core artifact, input, source file, or another workspace path.
  - **Rationale**: `spec-check` is read-only with respect to analyzed material, and the core bundle must remain trustworthy while it is reviewed.
- **Atomic publication failure**: Valid Markdown is returned but trusted atomic publication fails.
  - **Rationale**: The run must surface degradation without exposing a partially published final path.
- **Warning persistence failure**: Generation fails but the summary or refreshed manifest does not record the warning consistently.
  - **Rationale**: Silent degradation hides loss of the engineer-facing artifact. The old marker is invalidated before summary mutation, so persistence failure leaves no stale checksum manifest.
- **Stale report contamination**: A prior run's report remains when a new run begins or when current generation fails.
  - **Rationale**: The report could be falsely attributed to the current evidence bundle.
- **Process termination after core completion**: The process ends after the manifest is written but before report success or handled cleanup.
  - **Rationale**: Core completion remains truthful, but `report.md` may be absent or partial; the next run's stale-report cleanup is required to restore a clean attempt boundary.
- **Run-start cleanup failure**: The prior manifest is invalidated, but one or more managed output paths cannot be removed.
  - **Rationale**: The CLI returns `OutputError` before ingestion. Residue can remain, but no current manifest may attest it as the new run.

## Quality Attributes

- **Correctness**:
  - **Target/Threshold**: 100% of handled report attempts satisfy the terminal partition and no-invalid-residue invariants; 100% of report paths agree across request, acknowledgment, and validation.
  - **Influence**: Makes report presence unambiguous and keeps failure separate from analysis completion.
- **Security**:
  - **Target/Threshold**: The agent has no mutation permission; only the confined atomic adapter writes `report.md`; no invocation uses `--auto`.
  - **Influence**: Preserves the read-only product boundary and limits agent effects.
- **Reliability**:
  - **Target/Threshold**: Every handled OpenCode, protocol, and filesystem validation failure degrades nonfatally and removes the report candidate.
  - **Influence**: A convenience artifact cannot invalidate costly completed analysis.
- **Integrity**:
  - **Target/Threshold**: `report.md` appears in zero manifest entries; after warning persistence, 100% of manifest checksums match core artifact bytes.
  - **Influence**: Keeps the completion record mechanically truthful despite post-completion work.
- **Boundedness**:
  - **Target/Threshold**: At most one logical report call with adapter-bounded retries; configured timeout per attempt; accepted Markdown at most 1 MiB; payload contains only path and report body.
  - **Influence**: Limits latency, token use, memory use, and output amplification.
- **Portability**:
  - **Target/Threshold**: Absolute paths, relative CLI output paths, and paths containing spaces produce the same runtime path binding without shell interpolation.
  - **Influence**: Makes invocation independent of the caller's current path spelling and safe across common workspace layouts.
- **Auditability**:
  - **Target/Threshold**: Every handled failure is represented by one warning with a stable category and failure kind; prompt parity and permission policy are mechanically tested.
  - **Influence**: Lets reviewers distinguish a missing optional report from an unattempted or incomplete analysis.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `reporting-and-evidence`: add optional post-completion `report.md` generation, restricted agent permissions, independent file validation, manifest exclusion, stale/partial cleanup, nonfatal warning persistence, and the final-report lifecycle model.
