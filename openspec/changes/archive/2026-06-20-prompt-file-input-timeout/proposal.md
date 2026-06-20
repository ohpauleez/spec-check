## Motivation

`spec-check` currently fails in ways that are hard for users to understand and recover from. Archived-only inputs can be silently filtered out, leaving the pipeline to complete with vacuous results instead of explaining that no active documents survived catalog construction. Large analysis runs also remain fragile because prompt delivery, timeout behavior, and JSON extraction do not consistently match real-world LLM output patterns.

This change is needed now because the tool already supports workflows that traverse archived change trees, large specification sets, and multiple LLM-backed phases. The current behavior makes those workflows unreliable and obscures whether failures came from input selection, transport limits, timeout policy, or response parsing.

## Scope

### In Scope
- Make catalog construction explain why no active documents survived, including distinguishing between unrecognized inputs, archived-only inputs, and other policy-based filtering outcomes.
- Treat an empty recognized-document set as a catalog error surfaced to the CLI with a dedicated exit code.
- Introduce an archive override flag to `--allow-archive` and define its behavior as treating explicitly provided archived inputs as active, without changing document discovery.
- Make timeout policy universal across all external LLM calls in specs-forward and code-backwards flows, while still respecting config options.
- Change prompt delivery so large reference documents can be provided as attached files while keeping the instruction prompt bounded.
- Make JSON extraction resilient to common LLM response wrappers such as markdown fences and explanatory text.

### Out of Scope
- Changing the substantive analysis logic for qualitative review, formalization, clustering, or verification beyond the transport and failure-handling behavior needed here.
- Introducing new discovery rules for archived content beyond honoring explicitly passed archived paths.
- Redesigning the overall CLI surface area beyond the `--allow-archive` flag, timeout handling, and catalog-error reporting.
- Changing solver behavior, pair-budget semantics, or the meaning of existing findings categories beyond what is required for the new catalog diagnostics.

## Context

### Background

The current pipeline builds a document catalog, runs qualitative and formal analysis over parsed specs, and optionally derives code-backwards artifacts from source inputs.
In the present design, archived change documents are excluded by default using a path-based filter. That default is appropriate, but when every discovered document is filtered away the tool does not explain what happened.
Separately, multiple LLM-backed phases still assume short inline prompts, fixed timeout expectations, and tightly formatted JSON output.

Recent investigation identified two user-visible problem classes: archived-only inputs that produce empty downstream work without explanation, and large non-archived runs that fail because prompt transport, timeout policy, or JSON parsing is too brittle.

### Affected Systems and Stakeholders

- CLI users running `spec-check` directly against OpenSpec change directories, including archived trees.
- Engineers relying on qualitative review, formalization, and code-backwards analysis for large document sets.
- Maintainers of the catalog, opencode adapter, and CLI orchestration layers.
- The OpenSpec artifacts and Alloy-backed capability specs that define expected behavior.

### Assumptions and Dependencies

- `opencode run` supports file attachments via repeated `--file` arguments.
- Existing capability specifications remain the source of truth for behavioral contracts and can be updated through delta specs.
- The CLI can distinguish catalog errors from general runtime failures.
- All external LLM interactions continue to flow through the shared opencode adapter path.

### Constraints

- Archived documents must remain excluded by default.
- The archive override must not broaden discovery scope; it only affects explicitly provided archived inputs.
- Timeout behavior must stay bounded for liveness and must be consistent across all LLM-backed phases.
- The change must preserve the separation between instruction prompts and attached user-controlled content.
- Proposal content must remain implementation-neutral; implementation details belong in design and tasks.

### References

- `fixes_plan.md`
- `openspec/specs/catalog-and-parse/spec.md`
- `openspec/specs/formalization-and-logic-analysis/spec.md`
- `openspec/specs/source-traceability-and-code-backwards/spec.md`
- `openspec/specs/reporting-and-evidence/spec.md`

## Domain Model

- **Input Path**: A user-provided filesystem path that may resolve to OpenSpec artifacts, source files, or irrelevant content.
- **Recognized Document**: An input-derived artifact that the catalog phase classifies as a proposal, design, or spec document relevant to analysis.
- **Archived Document**: A recognized document located under archived change storage. Archived documents are recognized artifacts, but are inactive by default.
- **Catalog**: The active set of recognized documents admitted to downstream analysis.
- **Catalog Empty Reason**: A diagnostic explanation for why the catalog contains no active documents after recognition and filtering.
- **Analysis Invocation**: A single external LLM-backed step used by qualitative review, formalization, code-derived generation, cross-implication, or blind comparison.
- **Instruction Prompt**: The bounded command-line prompt text that tells the LLM what task to perform.
- **Attached Reference File**: User-controlled document content attached to an analysis invocation as a file rather than embedded inline.
- **Structured LLM Payload**: The JSON result expected back from an analysis invocation after transport- and formatting-related wrappers are removed.

Relationships:

```text
Input Paths -> Recognized Documents -> Catalog -> Downstream Analysis
                    |
                    +-> Archived Documents (inactive by default, active only when explicitly allowed)

Analysis Invocation -> Instruction Prompt + Attached Reference Files -> Structured LLM Payload
```

## Preconditions, Postconditions, and Invariants

- **Preconditions**
  - The user provides one or more input paths for analysis.
  - OpenSpec documents, when present, remain classifiable into known artifact types.
  - External LLM-backed phases are invoked through the shared adapter boundary.
- **Postconditions**
  - A successful run has at least one active catalog document.
  - An empty recognized-document outcome is surfaced as a catalog error with a specific user-facing explanation.
  - Every external LLM invocation uses the configured universal timeout.
  - Large reference content is transported as attached files rather than by unbounded inline prompt growth.
  - Structured LLM responses are accepted when wrapped in common formatting noise, or rejected with a diagnostic parsing failure.
- **Invariants**
  - Archived documents are not active unless the user explicitly allows archived inputs.
  - Allowing archived inputs does not expand filesystem discovery scope.
  - Every external LLM call remains positively and finitely bounded.
  - Instruction text and attached user-controlled content remain distinct transport channels.
  - Catalog diagnostics identify why no active documents survived whenever the catalog is empty.

## Failure Modes

- **No recognized OpenSpec documents**: Provided inputs do not contain any recognized proposal, design, or spec documents.
  - **Rationale**: Users need to know the difference between pointing at the wrong files and the tool failing later in analysis.
- **Archived-only recognized inputs without explicit allowance**: All recognized documents are archived and remain inactive under the default policy.
  - **Rationale**: This is recoverable if surfaced clearly, but confusing if it looks like a successful no-op run.
- **All recognized documents excluded by policy**: Recognition succeeds, but additional filtering leaves no active catalog.
  - **Rationale**: Users need a direct explanation of which policy prevented analysis, not an empty downstream result.
- **Large-context invocation exceeds transport expectations**: Reference content is too large for reliable inline prompt delivery.
  - **Rationale**: Large projects are a supported use case, so transport limits must degrade into explicit handling rather than opaque failures.
- **LLM invocation exceeds configured timeout**: An external analysis step does not complete within the configured universal budget.
  - **Rationale**: Timeout outcomes must be predictable and consistent across phases so users can tune runs coherently.
- **LLM response contains wrapped or prefixed JSON**: A structurally valid payload is surrounded by formatting noise.
  - **Rationale**: Rejecting common wrappers reduces usability and creates false negatives unrelated to the underlying analysis result.

## Quality Attributes

- **Reliability**:
  - **Target/Threshold**: Catalog construction never succeeds silently with zero active documents.
  - **Influence**: The change must surface empty-catalog causes explicitly and consistently.
- **Usability**:
  - **Target/Threshold**: User-facing catalog failures are distinguishable and actionable without code inspection.
  - **Influence**: Diagnostics and exit behavior must map failure causes to direct remediation guidance.
- **Performance**:
  - **Target/Threshold**: External LLM calls remain bounded by a universal timeout in the range of configured policy.
  - **Influence**: The system must preserve liveness while still supporting large-context runs.
- **Scalability**:
  - **Target/Threshold**: Large specification and source contexts can be analyzed without relying on oversized inline command arguments.
  - **Influence**: Prompt transport must separate bounded instructions from attached file content.
- **Robustness**:
  - **Target/Threshold**: Common markdown-fenced or prefixed JSON responses are accepted when they contain a valid payload.
  - **Influence**: Response parsing must tolerate realistic LLM formatting variation.
- **Observability**:
  - **Target/Threshold**: Catalog-empty conditions and timeout-related outcomes are classifiable at the CLI boundary.
  - **Influence**: Error categories and reporting contracts must remain explicit.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `catalog-and-parse`: Change catalog behavior so archived inputs remain inactive by default, `--allow-archive` can activate explicitly passed archived documents, and empty catalogs report a structured reason that surfaces as a catalog error.
- `formalization-and-logic-analysis`: Change analysis invocation behavior so all LLM-backed formalization paths use a universal configured timeout and resilient JSON payload extraction.
- `source-traceability-and-code-backwards`: Change code-backwards generation and comparison flows so all external LLM calls use the universal timeout and large-context source inputs can be transported via attached files.
- `reporting-and-evidence`: Change CLI-visible reporting so catalog-empty outcomes produce a distinct error category and exit code with cause-specific remediation.
