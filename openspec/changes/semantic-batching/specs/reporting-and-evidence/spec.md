## ADDED Requirements

### Requirement: Persist Invocation-Scoped Formalization Attempt Evidence [RAE-FORMAL-ATTEMPT-SETS]
WHEN the spec-check tool records attached formalization attempts, THE spec-check tool SHALL persist one separate atomically finalized `FormalizationAttemptSet` evidence file per formalization invocation. Each envelope SHALL identify its `claimSet` as `specs_forward` or as `generated_spec` with a zero-based invocation ordinal and capability, and SHALL contain attempt indexes that are local to that claim set. Evidence files MAY survive a failed or terminated run and SHALL NOT serve as run-completion markers.

**References:**
- `openspec/changes/semantic-batching/proposal.md#Domain Model`
- `openspec/changes/semantic-batching/design.md#Data Design`
- `openspec/changes/semantic-batching/design.md#Evidence And Artifact Verification`

#### Requirement model

[`formalization-and-logic-analysis/alloy/semantic-batching.als`](../formalization-and-logic-analysis/alloy/semantic-batching.als) checks that every attached attempt reaching a terminal resolution records evidence. Invocation namespaces, atomic evidence-file persistence, failed-run survival, run-start removal, and manifest completion semantics remain reporting-contract obligations outside the model.

#### Scenario: Persist Separate Atomic File Per Invocation [RAE-FORMAL-ATTEMPT-ATOMIC]
WHEN one specs-forward or generated-spec formalization invocation produces attempt evidence, THE spec-check tool SHALL atomically finalize exactly one evidence file containing that invocation's `FormalizationAttemptSet` envelope.

**Postcondition:** A complete evidence file contains attempts from one invocation and one claim-index namespace only.

#### Scenario: Failed Run May Retain Attempt Evidence [RAE-FORMAL-ATTEMPT-FAILED-RUN]
IF a run fails or the process terminates after an attempt-set evidence file is atomically finalized, THEN THE file MAY remain while `manifest.json` is absent.

**Postcondition:** Surviving attempt evidence is auditable partial-run output and cannot be mistaken for a successful run.

## MODIFIED Requirements

### Requirement: Complete Runs With Atomic Manifest Semantics [RAE-ATOMIC-MANIFEST]
WHEN the spec-check tool writes output artifacts, THE spec-check tool SHALL atomically finalize each artifact, SHALL permit separate formalization attempt-evidence files to exist before successful completion, and SHALL write `manifest.json` last as the sole success marker for the run. The successful manifest SHALL list every produced attempt-evidence file and its SHA-256 checksum together with the other produced output files.

**References:**
- `openspec/specs/reporting-and-evidence/spec.md#Requirement-Complete-Runs-With-Atomic-Manifest-Semantics-RAE-ATOMIC-MANIFEST`
- `openspec/changes/semantic-batching/proposal.md#Preconditions-Postconditions-and-Invariants`
- `openspec/changes/semantic-batching/design.md#Data-Design`

#### Scenario: Successful Manifest Covers Attempt Evidence [RAE-MANIFEST-ATTEMPT-EVIDENCE]
WHEN a run completes successfully after producing one or more `FormalizationAttemptSet` files, THE spec-check tool SHALL write the manifest after those files and SHALL include one entry per file with its relative path and matching SHA-256 checksum.

**Postcondition:** Manifest presence marks the last successful run and mechanically binds all durable attempt evidence to it.

#### Scenario: Attempt Evidence Alone Is Not Completion [RAE-MANIFEST-ATTEMPT-INCOMPLETE]
IF attempt-evidence files exist but the run fails or terminates before `manifest.json` is written, THEN consumers SHALL treat the run as incomplete.

**Postcondition:** Atomic evidence survival does not weaken manifest-last completion semantics.

## REMOVED Requirements

## RENAMED Requirements
