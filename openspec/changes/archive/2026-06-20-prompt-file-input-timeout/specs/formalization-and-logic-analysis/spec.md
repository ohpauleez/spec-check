## ADDED Requirements

### Requirement: Extract Recoverable JSON Payloads [FLA-JSON-RECOVER]
WHEN an external LLM call returns text that contains a valid JSON payload wrapped in markdown fences or explanatory text, THE spec-check tool SHALL recover the payload deterministically before schema validation.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Failure Modes`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Make JSON extraction tolerant but keep schema validation strict`

#### Scenario: Accept Markdown-Fenced JSON [FLA-JSON-FENCE]
WHEN an external LLM response wraps a valid JSON payload in markdown code fences, THE spec-check tool SHALL strip the outer fence markers and SHALL parse the enclosed JSON payload.

**Postcondition:** Common markdown formatting does not cause an otherwise valid payload to be rejected.

#### Scenario: Accept Prefixed Or Suffixed JSON [FLA-JSON-WRAP]
WHEN an external LLM response contains explanatory text before or after a valid JSON object or array, THE spec-check tool SHALL extract the first balanced JSON value and SHALL parse it.

**Postcondition:** Recoverable wrapper text does not prevent downstream schema validation.

#### Scenario: Reject Irrecoverable JSON [FLA-JSON-FAIL]
IF an external LLM response does not contain a recoverable valid JSON payload, THEN THE spec-check tool SHALL reject the response with a diagnostic parse error.

**Postcondition:** Malformed payloads are surfaced explicitly rather than accepted silently.

## MODIFIED Requirements

### Requirement: Formalize Requirement And Scenario Claims Into Logic Artifacts [FLA-FORMALIZE-CLAIMS]
WHEN requirement and scenario claims are available for formal analysis, THE spec-check tool SHALL translate each claim into a typed logic representation and generated SMT-LIB artifacts that preserve the claim identifier, source provenance, obligation level, and supporting declarations needed for solver analysis, and SHALL use the run-configured universal timeout for every external LLM formalization invocation.

**References:**
- `openspec/changes/prompt-file-input-timeout/proposal.md#Scope`
- `openspec/changes/prompt-file-input-timeout/proposal.md#Preconditions, Postconditions, and Invariants`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Centralize universal LLM timeout policy in run configuration`
- `openspec/changes/prompt-file-input-timeout/design.md#Decision: Make JSON extraction tolerant but keep schema validation strict`

#### Scenario: Generate Inspectable Logic Artifacts [FLA-FORMAL-ARTS]
WHEN a claim is selected for formalization, THE spec-check tool SHALL emit inspectable logic and SMT artifacts that let a reviewer trace the formal result back to the originating requirement or scenario.

**Postcondition:** Formal analysis inputs are available as reviewable evidence linked to their source claims.

#### Scenario: Abort On Complete Formalization Failure [FLA-FORMAL-FAIL]
IF no formalization candidates are produced for the entire phase after bounded retries, THEN THE spec-check tool SHALL abort the run with exit code `2` rather than continue with zero formal evidence.

**Postcondition:** No solver conclusion is produced when the formalization phase yields zero candidates.

#### Scenario: Continue With Partial Formalization Results [FLA-FORMAL-PARTIAL]
IF some claims fail formalization but at least one claim succeeds, THEN THE spec-check tool SHALL continue with the successful candidates, SHALL collect per-claim failures as errors in the formalization output, and SHALL let callers decide severity based on the ratio of successes to failures.

**Postcondition:** Partial formalization results are preserved and downstream phases proceed with available candidates.

#### Scenario: Universal LLM Timeout For Formalization [FLA-FORMAL-TIMEOUT]
WHEN the spec-check tool invokes an external LLM to formalize a claim or claim batch, THE spec-check tool SHALL use the run-configured universal timeout budget for that invocation.

**Postcondition:** Formalization timeout behavior is consistent with every other LLM-backed phase in the same run.

## REMOVED Requirements

## RENAMED Requirements
