## MODIFIED Requirements

### Requirement: Restrict Final Report Agent [RAE-FINAL-AGENT]
WHEN the spec-check tool invokes the final-report agent, THE spec-check tool SHALL use the detected major's verified isolated execution protocol and a transient primary-agent policy that permits required reads, denies all file mutation, shell execution, and delegation, and does not enable OpenCode auto-approval.

**References:**
- `openspec/changes/support-opencode-v2/proposal.md#Constraints`
- `openspec/changes/support-opencode-v2/design.md#Final-Report-Compatibility`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Constraints`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/design.md#Security`

#### Scenario: Allow Designated Write [RAE-FINAL-AGENT-WRITE]
WHEN a valid report payload is returned, THE spec-check tool SHALL atomically publish its Markdown through the confined filesystem adapter at the exact designated `report.md`.

**Postcondition:** The agent remains read-only and trusted code produces the requested artifact.

##### Evidence
- Existing implementation: [final-report.ts:257 generateFinalReport()](/src/domain/reporting/final-report.ts#L257), [fs.ts:83 writeOutputAtomic()](/src/adapters/fs.ts#L83), [final-report.ts:214 buildFinalReportAgentConfig()](/src/domain/prompts/final-report.ts#L214).
- Existing tests: [final-report.test.ts](/test/contract/final-report.test.ts), [safety-liveness.invariant.test.ts](/test/invariant/safety-liveness.invariant.test.ts). Version-specific coverage is added by the change tasks.

#### Scenario: Deny Other Mutation [RAE-FINAL-AGENT-DENY]
IF the report agent attempts to modify any file, THEN THE transient policy SHALL deny that action.

**Postcondition:** Final-report agent execution has no writable path.

##### Evidence
- Existing implementation: [final-report.ts:214 buildFinalReportAgentConfig()](/src/domain/prompts/final-report.ts#L214).
- Existing tests: [final-report.test.ts](/test/contract/final-report.test.ts), [safety-liveness.invariant.test.ts](/test/invariant/safety-liveness.invariant.test.ts).

#### Scenario: Deny Shell And Delegation [RAE-FINAL-AGENT-TOOLS]
IF the report agent attempts shell execution, task delegation, web access, or another denied capability, THEN THE transient policy SHALL deny that action.

**Postcondition:** The report cannot bypass read-only policy through a more powerful tool.

##### Evidence
- Existing implementation: [final-report.ts:214 buildFinalReportAgentConfig()](/src/domain/prompts/final-report.ts#L214).
- Existing tests: [final-report.test.ts](/test/contract/final-report.test.ts), [opencode.test.ts](/test/contract/opencode.test.ts), [safety-liveness.invariant.test.ts](/test/invariant/safety-liveness.invariant.test.ts).

#### Requirement model

```alloy
// --- Restricted agent capability model ---
abstract sig AgentCapability {}
one sig ReadCapability, SearchCapability, EditCapability, BashCapability,
  DelegateCapability, WebCapability, SkillCapability, QuestionCapability,
  TodoCapability, AutoApprovalCapability extends AgentCapability {}
one sig FinalAgentPolicy {
  configuredAllowed : set AgentCapability,
  admitted : one Bool
}
one sig FinalAgentInvocation {
  requestedCapabilities : set AgentCapability,
  effectiveCapabilities : set AgentCapability
}

fun allowedAgentCapabilities : set AgentCapability {
  ReadCapability + SearchCapability
}

fun deniedAgentCapabilities : set AgentCapability {
  EditCapability + BashCapability + DelegateCapability + WebCapability
  + SkillCapability + QuestionCapability + TodoCapability + AutoApprovalCapability
}

fact final_agent_policy_admission {
  FinalAgentPolicy.admitted = True iff
    FinalAgentPolicy.configuredAllowed = allowedAgentCapabilities
}

fact configured_final_agent_policy {
  FinalAgentPolicy.configuredAllowed in allowedAgentCapabilities
  FinalAgentPolicy.admitted = True implies
    FinalAgentPolicy.configuredAllowed = allowedAgentCapabilities
}

fact final_agent_invocation_enforces_policy {
  FinalAgentInvocation.effectiveCapabilities
    = FinalAgentInvocation.requestedCapabilities & FinalAgentPolicy.configuredAllowed
}

// Invariant: the agent is read-only; trusted publication is not an agent capability.
assert agent_policy_is_read_only {
  FinalAgentPolicy.admitted = True implies {
    FinalAgentPolicy.configuredAllowed = ReadCapability + SearchCapability
    no (FinalAgentPolicy.configuredAllowed & deniedAgentCapabilities)
  }
}

// A denied mutation/tool attempt is a handled agent failure, never a report success.
assert denied_agent_action_cannot_publish {
  no (FinalAgentInvocation.effectiveCapabilities & deniedAgentCapabilities)
  FinalAgentInvocation.requestedCapabilities & deniedAgentCapabilities
    in AgentCapability - FinalAgentInvocation.effectiveCapabilities
}
```

### Requirement: Use File And Acknowledgment Protocol [RAE-FINAL-PROTOCOL]
WHEN the final-report phase invokes OpenCode with `--format json`, THE spec-check tool SHALL decode stdout as strict UTF-8 newline-delimited OpenCode events, concatenate `part.text` only from top-level `type: "text"` events, and parse that text as one JSON object with the exact `report_path` and complete `report_markdown` strings.

**References:**
- `openspec/changes/support-opencode-v2/design.md#Final-Report-Compatibility`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/proposal.md#Scope`
- `openspec/changes/archive/2026-08-24-add-final-evidence-report/design.md#Interaction-Protocols`

#### Scenario: Invoke In Workspace [RAE-FINAL-PROTO-DIR]
WHEN OpenCode is started for the final-report phase, THE spec-check tool SHALL use the verified v1 `--pure` and `--dir <isolated-root>` invocation for its tested v1 baseline or the verified v2 standalone invocation with subprocess `cwd` and environment `PWD` set to the isolated execution/configuration root, private generated server configuration, and explicit `OPENCODE_CONFIG_PROJECT_DISABLE=1`, select the restricted agent with `--agent`, request JSON output with `--format json`, and omit `--auto`; the analyzed workspace SHALL be named in the prompt and granted explicit read-only external-directory access.

**Postcondition:** The agent can inspect workspace evidence under the declared permission boundary. V2 receives no `--pure`, `--dir`, or separate `--variant`; v1 receives no v2-only flags. If discovery requires a different supported isolation transport, the design and this protocol scenario must be revised before accepting compatibility.

##### Evidence
- Existing v1-shaped implementation baseline: [opencode.ts:293 buildOpencodeArgs()](/src/adapters/opencode.ts#L293), [final-report.ts:257 generateFinalReport()](/src/domain/reporting/final-report.ts#L257), [final-report.ts:214 buildFinalReportAgentConfig()](/src/domain/prompts/final-report.ts#L214).
- Existing tests: [opencode.test.ts](/test/contract/opencode.test.ts), [final-report.test.ts](/test/contract/final-report.test.ts), [distribution.test.ts](/test/contract/distribution.test.ts). Pinned-release verification is pending; these references do not establish v2 compatibility.

#### Scenario: Validate Acknowledgment Shape [RAE-FINAL-PROTO-ACK]
IF final-report stdout does not decode to exactly the required non-empty `report_path` and `report_markdown` fields, THEN THE spec-check tool SHALL classify the attempt as failed.

**Postcondition:** Malformed UTF-8, malformed event lines, error events, raw payloads outside text events, missing text payloads, Markdown fences, prose wrappers, extra payload fields, and invalid field values are rejected. Non-text status and usage events are ignored.

##### Evidence
- Existing implementation: [opencode.ts](/src/adapters/opencode.ts), [final-report.ts:416 parseAcknowledgment()](/src/domain/reporting/final-report.ts#L416).
- Existing tests: [opencode.test.ts](/test/contract/opencode.test.ts), [process-output.test.ts](/test/contract/process-output.test.ts).

#### Scenario: Preserve Prompt Parity [RAE-FINAL-PROMPT-PARITY]
WHEN bundled artifacts are built, THE spec-check verification harness SHALL confirm that the distributed final-report prompt and builders match the authoritative `FINAL_REPORT_PROMPT` and builders in `src/domain/prompts/final-report.ts` before declared runtime placeholder substitution.

**Postcondition:** Source and distributed CLIs use the same authoritative evaluated content strategy without depending on an external prompt file.

##### Evidence
- Existing implementation: [final-report.ts:21 FINAL_REPORT_PROMPT](/src/domain/prompts/final-report.ts#L21), [final-report.ts:173 buildFinalReportPrompt()](/src/domain/prompts/final-report.ts#L173).
- Existing test: [distribution.test.ts](/test/contract/distribution.test.ts).

#### Requirement model

The existing abstract `pureMode` field below denotes the verified isolation property, not the presence of a literal `--pure` flag on v2. Its v1/v2 realization is established by the compatibility gate and executable fixtures; this preserved model does not prove external configuration loading behavior.

```alloy
// --- Strict OpenCode event and acknowledgment protocol ---
one sig ReportProtocol {
  agentSucceeded : one Bool,
  strictUtf8 : one Bool,
  linesAreJsonEvents : one Bool,
  errorEventAbsent : one Bool,
  textFromTopLevelEventsOnly : one Bool,
  exactPayloadFields : one Bool,
  pathNonempty : one Bool,
  markdownNonempty : one Bool,
  noWrapperOrFence : one Bool,
  pureMode : one Bool,
  isolatedDir : one Bool,
  restrictedAgentSelected : one Bool,
  autoOmitted : one Bool
}

abstract sig PromptArtifact {}
one sig SourcePrompt, BundledPrompt extends PromptArtifact {}
one sig PromptInstruction {}
one sig PromptBuild {
  normalizedInstructions : PromptArtifact -> PromptInstruction,
  accepted : one Bool
}

// Build admission is the modeled trust boundary. Runtime placeholders are
// normalized before this equality check; executable distribution tests compare bytes.
fact prompt_bundle_admission {
  PromptBuild.accepted = True iff
    SourcePrompt.(PromptBuild.normalizedInstructions)
      = BundledPrompt.(PromptBuild.normalizedInstructions)
}

fact distributed_prompt_is_admitted {
  PromptBuild.accepted = True implies
    some SourcePrompt.(PromptBuild.normalizedInstructions)
}

pred protocol_preconditions {
  ReportProtocol.pureMode = True
  ReportProtocol.isolatedDir = True
  ReportProtocol.restrictedAgentSelected = True
  ReportProtocol.autoOmitted = True
}

fact final_report_invocation_controls {
  protocol_preconditions
}

pred acknowledgment_valid {
  ReportProtocol.strictUtf8 = True
  ReportProtocol.linesAreJsonEvents = True
  ReportProtocol.errorEventAbsent = True
  ReportProtocol.textFromTopLevelEventsOnly = True
  ReportProtocol.exactPayloadFields = True
  ReportProtocol.pathNonempty = True
  ReportProtocol.markdownNonempty = True
  ReportProtocol.noWrapperOrFence = True
}

assert validating_requires_strict_protocol {
  always (Run.finalStage = Validating implies
    (protocol_preconditions and ReportProtocol.agentSucceeded = True))
}

assert malformed_protocol_never_validates {
  always (not acknowledgment_valid implies Run.finalStage != ReportAvailable)
}

assert accepted_bundle_has_prompt_parity {
  PromptBuild.accepted = True implies
    SourcePrompt.(PromptBuild.normalizedInstructions)
      = BundledPrompt.(PromptBuild.normalizedInstructions)
}
```

## ADDED Requirements

### Requirement: Verify Release Compatibility Boundary [RAE-OC-COMPAT]
WHEN accepting OpenCode v2 compatibility, THE spec-check verification harness SHALL establish the pinned v1/v2 invocation and isolation baseline and record sanitized empirical evidence in `openspec/changes/support-opencode-v2/v2-isolation-verification.md` before the v2 final-report path is enabled or compatibility is declared complete.

**References:**
- `openspec/changes/support-opencode-v2/proposal.md#Assumptions and Dependencies`
- `openspec/changes/support-opencode-v2/design.md#Compatibility-Discovery-Gate`

#### Scenario: Verify Configuration And Credential Loading [RAE-OC-COMPAT-CONFIG]
WHEN exercising disposable compatibility environments, THE verification harness SHALL establish config-source and environment-override precedence, actual evidence/source reads, usable configured-provider authentication, and report generation without copying credentials into generated config or changing the user's real global configuration.

**Postcondition:** Evidence covers `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, ancestor direct and `.opencode` configs, global/system config, and ambient instructions. Private-server execution alone is not accepted as proof of config isolation.

#### Scenario: Exclude Ambient Server Integrations [RAE-OC-COMPAT-EXCLUDE]
WHEN verifying the v2 final-report transport on the supported release baseline, THE verification harness SHALL establish that a private generated server config directory combined with explicit `OPENCODE_CONFIG_PROJECT_DISABLE=1` excludes external server-plugin imports/setup and ambient MCP startup from the tested global/ancestor sources, while retaining required built-in server plugins and the generated restricted report agent.

**Postcondition:** Native project-discovery exclusion overrides inherited native/legacy values. Terminal-only/CLI plugins are outside this exclusion obligation. An empty plugin array or setup-only removal is not accepted as proof of module-import exclusion. Credential/permission/report-transport obligations still require separate evidence.

#### Scenario: Verify Ambient Authority Does Not Escape [RAE-OC-COMPAT-AUTHORITY]
WHEN conflicting same-name agent, permissive mutation-policy, instruction-marker, and harmless plugin/MCP startup-marker fixtures are present, THE verification harness SHALL establish that the accepted transport preserves the required restricted-agent authority and isolation baseline, denies mutation/shell/delegation/web and unapproved external-directory actions, and leaves mutation sentinel bytes unchanged.

**Postcondition:** Startup markers are inspected separately from tool-permission results; an unchanged sentinel alone does not prove plugins or MCP integrations were excluded.

#### Scenario: Block Unverified Compatibility [RAE-OC-COMPAT-BLOCK]
IF the required isolation or credential-loading contract cannot be established, THEN THE change implementer SHALL record the blocker and revise the invocation design/specification before enabling the v2 final-report path or marking the change complete.

**Postcondition:** The existing handled final-report warning/manifest-refresh lifecycle remains in force at runtime and does not satisfy this release acceptance gate by itself. Published documentation names tested releases and any discovered minimum release requirement.

### Requirement: Preserve OpenCode Event Meaning [RAE-OC-EVENTS]
WHEN consuming output from either supported major, THE OpenCode adapter SHALL preserve accepted text/error semantics, phase-schema validation, nonzero-exit precedence, and usage-completeness accounting, with version-specific decoding only for demonstrated fixture differences.

**References:**
- `openspec/changes/support-opencode-v2/design.md#Event-and-Telemetry-Protocol`

#### Scenario: Ignore Unknown Event Types [RAE-OC-EVENTS-UNKNOWN]
WHEN an otherwise valid stream includes an unrecognized event type, THE adapter SHALL ignore that event without treating it as response text or proof of successful completion.

#### Scenario: Preserve Invalid Transport Failure [RAE-OC-EVENTS-INVALID]
IF output violates the existing phase-specific transport/schema contract or its process exits nonzero or by signal, THEN THE adapter SHALL reject the attempt even if partial valid response text was emitted.

#### Scenario: Preserve Incomplete Usage [RAE-OC-EVENTS-USAGE]
IF usage fields are missing or malformed under the existing completeness rules, THEN THE adapter SHALL retain incomplete usage attribution rather than fabricate complete zero usage.

### Requirement: Attribute Normalized Runtime Metrics [RAE-OC-METRICS]
WHEN recording a new OpenCode model attempt, THE spec-check tool SHALL record its normalized base `model`, resolved `variant` or `null`, and detected `opencodeMajor` (`1` or `2`) while preserving existing opt-in metrics and core-manifest snapshot semantics.

**References:**
- `openspec/changes/support-opencode-v2/proposal.md#Postconditions`
- `openspec/changes/support-opencode-v2/design.md#Event-and-Telemetry-Protocol`

#### Scenario: Preserve Schema V1 Compatibility [RAE-OC-METRICS-SCHEMA]
WHEN serializing new attempts or handling existing schema-v1 snapshots, THE metrics code SHALL retain `schemaVersion: 1`, serialize the additive optional `opencodeMajor` when present, and continue to accept snapshots without that field.

#### Scenario: Keep Probes Out Of Model Usage [RAE-OC-METRICS-PROBE]
WHEN OpenCode version detection executes, THE spec-check tool SHALL attribute it to dependency work without recording it as a model attempt or token-bearing call.

#### Scenario: Preserve Snapshot And Privacy [RAE-OC-METRICS-SNAPSHOT]
WHEN core metrics are persisted, THE spec-check tool SHALL preserve the existing totals and pre-manifest checksum rules, omit full argv and credentials from new compatibility metadata, and retain post-completion report attempts only in memory without rewriting the core metrics snapshot.

### Requirement: Make Capture Overflow Terminal [RAE-OC-OUTPUT-LIMIT]
WHEN a model call exceeds its process-output capture limit, THE OpenCode adapter SHALL return terminal `output_limit`, SHALL perform no further model attempt for that logical call, and SHALL prohibit formalization model-response degradation for that infrastructure limit.

**References:**
- `openspec/changes/support-opencode-v2/design.md#Review-Correction-Contracts`

#### Scenario: Preserve The Capture Budget [RAE-OC-OUTPUT-ONCE]
IF capture overflow is reported with a retry budget larger than one or a competing timeout flag, THEN THE OpenCode adapter SHALL retain output-limit classification and SHALL record at most the single attempted model call rather than retry an oversized response.

### Requirement: Collect Telemetry Only On Request [RAE-OC-COLLECTION]
WHEN a production run starts without `SPEC_CHECK_TELEMETRY=1` and without an explicitly injected collector, THE spec-check tool SHALL avoid creating a telemetry collector, parsing model usage, or retaining attempt records.

**References:**
- `openspec/changes/support-opencode-v2/design.md#Review-Correction-Contracts`

#### Scenario: Preserve Explicit Collection [RAE-OC-COLLECTION-EXPLICIT]
WHEN a verification caller explicitly binds a collector or a production run enables telemetry, THE spec-check tool SHALL retain phase/attempt attribution, reconcile totals and logical calls, and preserve existing metrics/manifest snapshot semantics.

### Requirement: Admit Safe Relative Citations [RAE-RELATIVE-CITATIONS]
WHEN validating global and per-finding final-report citations, THE spec-check tool SHALL accept syntactically safe repository-relative artifact paths independently of their directory names, including custom output/specification directories and explicitly formatted root filenames.

**References:**
- `openspec/changes/support-opencode-v2/design.md#Review-Correction-Contracts`

#### Scenario: Admit Custom Artifact Locations [RAE-CITATION-CUSTOM]
WHEN an otherwise valid report cites `analysis-output/report_summary.md`, `requirements/spec.md`, or an explicitly formatted root artifact, THE final-report validator SHALL accept those paths without a built-in directory allowlist.

#### Scenario: Reject Nonrelative Or Traversing Citations [RAE-CITATION-UNSAFE]
IF a citation is a URL, absolute/drive/UNC/home path, contains dot traversal or control characters, or appears only inside a fenced/comment block, THEN THE final-report validator SHALL reject that candidate without recovering an apparently relative substring from it.

### Requirement: Verify Production Lifecycle Coordination [RAE-LIFECYCLE-PRODUCTION]
WHEN generating verification evidence for optional-report persistence, THE verification harness SHALL execute the same coordinator used by production orchestration with injected effects and SHALL compare independent effect observations and failure histories to the reference lifecycle model.

**References:**
- `openspec/changes/support-opencode-v2/design.md#Review-Correction-Contracts`

#### Scenario: Reconcile Effect Failure Histories [RAE-LIFECYCLE-EFFECTS]
WHEN generated histories cover report success, generation/validation failure, and cleanup/marker/summary/manifest failures, THE verification harness SHALL compare actual coordinator transitions and independently stored report/summary/manifest bytes to the model, including preservation of the preexisting core bundle before marker invalidation.
