## Context

### Current State

`spec-check` orchestrates catalog construction, specs-forward analysis, and optional code-backwards analysis across several modules. Catalog construction currently applies a hard-coded archive-path filter and can leave the pipeline with zero active documents without explaining why. LLM-backed phases share an adapter boundary, but prompt transport, timeout forwarding, and JSON extraction behavior are not consistently modeled across all call paths. In particular, some code-backwards paths still rely on default timeouts or hard-coded local values instead of the same configured policy.

### Constraints and Architecture Drivers

- Archived inputs must remain inactive by default.
- `--allow-archive` must only affect explicitly provided archived paths, not discovery scope.
- Empty catalogs must become a first-class product outcome with actionable diagnostics.
- Every external LLM call must remain bounded and must use the same configured timeout.
- Large document and source contexts must not rely on oversized inline command arguments.
- Existing phase contracts, blind-boundary rules, and finding-shape invariants must remain intact.
- All updates must be made consistent with the lightweight formal methods described in `docs/lfm.md`.
- All source code updates must adhere to the coding style guide defined in `docs/typescript_style.md`.

## Goals

- Make catalog-empty outcomes explicit, structured, and recoverable.
- Unify timeout policy across all LLM-backed phases.
- Separate instruction prompts from attached document content for large-context analysis.
- Accept common wrapped JSON payloads without weakening schema validation.
- Preserve current analysis semantics except where the user-facing contract intentionally changes.

### Non-Goals

- Reworking solver timeout behavior or pair-budget semantics.
- Changing qualitative, formal, or comparison algorithms beyond transport and failure handling.
- Expanding archived artifact discovery or introducing persistent config for archive activation.

## Architecture Decisions

### Decision: Represent empty-catalog outcomes as structured catalog diagnostics

- **Context and Objective:** The catalog layer knows why active documents disappeared, but the CLI currently only sees an empty result. The objective is to preserve cause information at the catalog boundary so the CLI can surface precise remediation and exit with a dedicated catalog error.
- **Quality Attribute Tactics and Key Results:** Reliability improves by eliminating silent success with zero active documents. Usability improves because users receive distinct messages for wrong inputs, archived-only inputs, or policy-excluded inputs.
- **Options Considered:**
  - Option A: Keep `buildCatalog` returning only the final catalog and let `run-cli` infer emptiness causes from raw inputs. Pros: smaller type change. Cons: duplicates policy reasoning outside the catalog layer and cannot explain future filters accurately.
  - Option B: Extend catalog output with a structured `emptyReason` union. Pros: preserves source-of-truth reasoning and cleanly supports new empty causes. Cons: requires return-type changes through callers.
- **Decision:** Choose Option B. `buildCatalog` returns a structured empty reason whenever the catalog is empty, and the CLI maps that to `CatalogError` with exit code 5.
- **Consequences:** Catalog semantics become more explicit and extensible. Callers must handle the richer return contract, but downstream logic becomes simpler and more honest.

### Decision: Define archive activation as an explicit admission policy, not a discovery policy

- **Context and Objective:** Introduce a new CLI flag that relaxes admission of "archived" documents. The objective is to preserve the default archive exclusion while letting explicitly provided archived inputs participate when the user opts in.
- **Quality Attribute Tactics and Key Results:** Safety is preserved because archived material never becomes active accidentally. Usability improves because the flag meaning matches what the user explicitly asked the tool to analyze.
- **Options Considered:**
  - Option A: `--allow-archive` broadens discovery to archived trees under otherwise non-archived inputs. Pros: potentially convenient. Cons: surprising scope expansion and harder reasoning about input provenance.
  - Option B: `--allow-archive` only affects explicitly passed archived inputs. Pros: narrow, predictable, and aligned with user intent. Cons: users must name archived paths deliberately.
- **Decision:** Choose Option B. Archive handling stays in the catalog admission step and does not alter file discovery behavior.
- **Consequences:** The flag remains a focused runtime control. Documentation and specs must clearly state that archived discovery scope does not expand.

### Decision: Centralize universal LLM timeout policy in run configuration

- **Context and Objective:** LLM-backed phases currently rely on defaults or local overrides, creating inconsistent behavior for large runs. The objective is one user-configurable timeout that applies to every external LLM call path.
- **Quality Attribute Tactics and Key Results:** Liveness remains bounded because every call is subject to the same validated range. Operability improves because users can tune one knob instead of reasoning about hidden per-phase behavior.
- **Options Considered:**
  - Option A: Keep per-phase floors or hard-coded overrides. Pros: allows tailored local heuristics. Cons: inconsistent behavior, hidden policy, and incomplete propagation risk.
  - Option B: Use one validated `timeoutMs` value everywhere. Pros: consistent, testable, and easier to document. Cons: less flexibility for future per-phase tuning.
- **Decision:** Choose Option B. `RunConfig.timeoutMs` becomes the single source of timeout policy for every `callOpencode` path.
- **Consequences:** All direct and indirect LLM call sites must accept and forward `timeoutMs`, including specs-forward formalization, code-derived generation, code-derived formalization, cross-implication, and blind comparison.

### Decision: Deliver large analysis context through file attachments

- **Context and Objective:** Large qualitative and code-derived prompts currently embed too much content in a single command argument. The objective is to keep prompts bounded and deliver user-controlled content as files.
- **Quality Attribute Tactics and Key Results:** Scalability improves by removing command-line argument growth as the main content transport. Security posture improves because the instruction channel stays distinct from attached untrusted content.
- **Options Considered:**
  - Option A: Continue serializing content inline with larger budgets. Pros: fewer interface changes. Cons: fragile transport and continued argument-size risk.
  - Option B: Add adapter-level `files` attachments and keep the prompt instruction-only. Pros: scales with content size and matches the desired trust boundary. Cons: requires prompt-builder refactors.
- **Decision:** Choose Option B.
- **Consequences:** Qualitative review and code-derived generation prompt builders must produce instruction text plus file lists. The adapter must enforce an explicit instruction-prompt byte bound.

### Decision: Make JSON extraction tolerant but keep schema validation strict

- **Context and Objective:** LLMs often wrap valid JSON in markdown fences or explanatory prose. The objective is to accept structurally recoverable payloads without weakening downstream schema validation.
- **Quality Attribute Tactics and Key Results:** Robustness improves because common response wrappers no longer cause false parse failures. Correctness is preserved because the extracted payload still passes existing schema validators.
- **Options Considered:**
  - Option A: Keep direct `JSON.parse` only. Pros: simple. Cons: brittle in realistic LLM output conditions.
  - Option B: Add a deterministic extraction cascade before schema validation. Pros: accepts realistic wrappers while keeping validation downstream. Cons: slightly more adapter complexity.
- **Decision:** Choose Option B.
- **Consequences:** The adapter gains deterministic extraction helpers, while caller contracts and schema validation remain unchanged.

## Component Design

### Key Components

- **CLI argument and config resolution**: Parses `--allow-archive` and `--timeout-ms`, validates timeout bounds, and materializes runtime policy into `RunConfig`.
- **Catalog builder**: Discovers files, classifies recognized OpenSpec documents, applies archive admission policy, resolves active capabilities, and produces `CatalogEmptyReason` when no active documents survive.
- **CLI orchestration**: Threads catalog diagnostics and universal timeout through specs-forward and code-backwards flows, and maps catalog-empty outcomes to exit code 5.
- **Opencode adapter**: Builds `opencode run` argv with optional `--file` attachments, enforces bounded instruction-prompt size, runs the subprocess with the configured timeout, and extracts JSON via a deterministic cascade.
- **Prompt builders**: Produce instruction-only prompts plus file attachment lists for qualitative review and code-derived generation.
- **Code-backwards orchestration**: Ensures indirect LLM paths such as `formalizeGeneratedSpecs`, code-derived generation, and blind comparison receive the same timeout contract.

### Data Design

- **`allowArchive`**: Boolean runtime policy value. Default `false`. Valid only as an invocation-time option, not a persisted project setting.
- **`timeoutMs`**: Positive integer in `[30_000, 900_000]`. Stored in `RunConfig` and used unchanged for every external LLM call.
- **`CatalogEmptyReason`**: Discriminated union with stable kinds:
  - `no_recognized_docs`
  - `all_archived`
  - `all_filtered`
- **`OpencodeCallOptions.files`**: Ordered list of readable filesystem paths attached as repeated `--file` flags.
- **Instruction prompt bound**: Measured in UTF-8 bytes via `Buffer.byteLength(prompt, "utf8")`; exceeded bounds are adapter errors rather than partial subprocess execution.

### Interface Contracts

- `parseArgv()` accepts `--allow-archive` as a boolean flag and `--timeout-ms` as a value-bearing flag.
- `resolveRunConfig()` returns validated `allowArchive` and universal `timeoutMs`.
- `buildCatalog(inputs, options)` returns catalog output plus `emptyReason` when active documents are empty.
- `runCli()` maps empty catalog outcomes to `CatalogError` and exit code 5.
- `callOpencode(options)` accepts `files?: readonly string[]` and always runs with the provided timeout or validated default.
- `runQualitativePasses()`, `formalizeClaims()`, `deriveSpecsFromSource()`, `formalizeGeneratedSpecs()`, and `runBlindComparison()` all accept or receive forwarded `timeoutMs`.

### Code Map

- `src/cli/parse-argv.ts`: add `--allow-archive`, `--timeout-ms` parsing.
- `src/cli/config.ts`: validate and expose `allowArchive`, `timeoutMs`.
- `src/index.ts`: map `CatalogError` to exit code 5.
- `src/domain/parser/catalog.ts`: emit structured empty-catalog diagnostics and apply archive admission policy.
- `src/cli/run-cli.ts`: surface catalog-empty errors and thread timeout policy.
- `src/cli/pipeline-helpers.ts`: forward timeout through code-backwards orchestration.
- `src/adapters/opencode.ts`: add file attachments, prompt bound enforcement, universal timeout use, resilient JSON extraction.
- `src/domain/spec-forward/qualitative.ts`: build instruction prompt bundles with files.
- `src/domain/formal/formalize.ts`: accept and forward universal timeout.
- `src/domain/code-backwards/derive.ts`: attach source files and forward timeout.
- `src/domain/code-backwards/gen-formal.ts`: forward timeout into indirect formalization path.
- `src/domain/code-backwards/blind-compare.ts`: forward timeout.

## Failure and Reliability

### Failure Mode Analysis

- **Unsafe inputs:** Users may pass unrelated directories, unreadable paths, or archived-only change trees. The catalog must distinguish unreadable-input rejection from recognized-but-inactive outcomes.
- **Fragile formats:** LLM payloads may arrive as plain JSON, fenced JSON, or prefixed/suffixed JSON text. The adapter must recover the payload deterministically or fail descriptively.
- **Inadequate control actions:** A timeout configured at some but not all call sites would create inconsistent runtime behavior. The design removes local timeout autonomy and requires end-to-end forwarding.
- **Process model flaws:** Treating an empty catalog as success causes the tool’s model of “completed analysis” to diverge from user reality. Structured empty reasons align internal and external state.
- **Coordination failures:** Code-backwards analysis contains indirect and repeated LLM paths. Missing timeout propagation in any LLM-backed path would violate the universal-timeout invariant.

### Control and Recovery

- Catalog construction classifies empty outcomes before downstream phases run.
- The CLI converts classified empty outcomes into `CatalogError` with exit code 5 and cause-specific messages.
- Timeout validation happens once at config resolution and then propagates unchanged.
- Adapter prompt-size guards fail before process spawn when the instruction prompt is too large.
- JSON extraction falls through a deterministic cascade and surfaces the original parse failure with diagnostic context when recovery is impossible.

## Operational Concerns

### Observability

- Catalog-empty causes become explicit structured outcomes at the CLI boundary.
- Timeout values are controlled centrally, simplifying debugging of long-running analysis.
- Adapter parse failures retain raw-preview diagnostics without exposing whole large payloads.

### Deployment and Rollout

- No migration of persisted data is required.
- Rollout is code-only and can ship atomically with updated CLI help and architecture/design docs.
- Regression risk is concentrated in call-site propagation and prompt-builder refactors, so rollout relies on contract and integration coverage rather than staged infrastructure deployment.

### Capacity and Scaling

- File attachments shift large-content transport away from argv size limits.
- Universal timeout keeps all LLM phases bounded even for large-context analysis.
- Cross-implication remains bounded by existing pair-budget behavior; this design does not widen comparison scope.

## Security

- Attached files are treated as untrusted document content; instruction prompts must explicitly separate command intent from attached content.
- The archive admission override is opt-in and limited to explicit user inputs, reducing accidental inclusion of stale or archived material.
- No new authentication or authorization concerns are introduced.

## Risks / Trade-offs

- [Richer catalog diagnostics widen return contracts] -> Mitigation: keep the new diagnostic shape small, discriminated, and localized to catalog/CLI boundaries.
- [Universal timeout removes local per-phase tuning flexibility] -> Mitigation: validate a generous range and document the single timeout knob clearly.
- [File-attachment transport depends on `opencode --file` behavior] -> Mitigation: add adapter contract tests that verify argv construction and phase-level usage.
- [JSON extraction fallbacks may hide malformed wrappers if over-broad] -> Mitigation: keep the cascade deterministic, preserve original parse errors, and retain schema validation unchanged.

## Migration Plan

1. Introduce CLI/config surface changes for `--allow-archive`, `timeoutMs`, and `CatalogError` exit semantics.
2. Update catalog output and CLI orchestration to surface structured empty-catalog diagnostics.
3. Update the opencode adapter for attachments, prompt bound enforcement, timeout propagation, and JSON extraction.
4. Thread timeout through every specs-forward and code-backwards LLM call path.
5. Refactor prompt builders to use attached files where required.
6. Update affected capability specs, Alloy models within those specs, tests, and supporting documentation (`ARCHITECTURE.md`, `docs/design.md`, etc.)
7. Roll back by reverting the code change set as a unit if regressions appear; there is no persistent state migration to unwind.

## Verification Strategy

- Contract tests for CLI parsing/config validation of `--allow-archive`, `--timeout-ms`, and exit-code mapping.
- Catalog tests covering `no_recognized_docs`, `all_archived`, `all_filtered`, and non-empty success with `--allow-archive`.
- Adapter contract tests for `--file` argv construction, prompt byte-limit enforcement, timeout forwarding, and JSON extraction cases.
- Unit/contract tests ensuring timeout reaches `formalizeClaims`, `formalizeGeneratedSpecs`, and `runBlindComparison`. (Note: `runCrossImplication` uses only Z3 solver calls and is excluded from LLM timeout scope per the "Constants, Bounds, And Defaults" section.)
- Integration tests for archived-only inputs, large-context qualitative review, and code-backwards flows.
- Alloy updates and checks for the catalog-and-parse archive admission invariant.

## Implementation details

### Concrete Type And Interface Changes

- `src/cli/parse-argv.ts`
  - Add `allowArchive: boolean` to `CliArgs`.
  - Add `timeoutMs?: string` to `CliArgs`.
  - Treat `--allow-archive` as a boolean flag.
  - Add `--timeout-ms` to the value-bearing `FlagKey` union.
- `src/cli/config.ts`
  - Add `allowArchive: boolean` and `timeoutMs: number` to `RunConfig`.
  - Extend `ConfigFileShape` with `timeoutMs?: number` and `allowArchive: boolean`.
- `src/domain/parser/catalog.ts`
  - Change `buildCatalog()` to accept `options?: { readonly allowArchive?: boolean }`.
  - Extend `CatalogBuildOutput` so it may include `emptyReason?: CatalogEmptyReason`.
- `src/adapters/opencode.ts`
  - Extend `OpencodeCallOptions` with `files?: readonly string[]`.
- `src/domain/spec-forward/qualitative.ts`
  - Replace the prompt-only return shape with:

```typescript
export interface ReviewPromptBundle {
  readonly prompt: string;
  readonly files: readonly string[];
}
```

- `src/domain/code-backwards/gen-formal.ts`
  - Extend `formalizeGeneratedSpecs()` input with `timeoutMs: number` and forward it into `formalizeClaims()`.
- `src/domain/code-backwards/cross-implication.ts`
  - Z3-only module; does not invoke external LLM calls. No `timeoutMs` parameter needed for LLM timeout scope. (Existing Z3 solver timeout is hardcoded and out of scope per "Constants, Bounds, And Defaults" section.)
- `src/domain/code-backwards/blind-compare.ts`
  - Extend `runBlindComparison()` input with `timeoutMs: number`.

### Catalog Empty Reason Shape And UX Mapping

The catalog layer owns emptiness classification. The concrete discriminated union is:

```typescript
export type CatalogEmptyReason =
  | { readonly kind: "no_recognized_docs"; readonly inputCount: number }
  | { readonly kind: "all_archived"; readonly archivedCount: number }
  | { readonly kind: "all_filtered"; readonly filterReason: string; readonly filteredCount: number };
```

`run-cli` maps each reason to exit code `5` and a specific user-facing message:

| Kind | Exit code | Message |
|---|---:|---|
| `no_recognized_docs` | 5 | `No OpenSpec documents found in the provided inputs. Ensure input paths contain proposal, design, or spec documents.` |
| `all_archived` | 5 | `All N discovered documents are in archived change directories. Use --allow-archive to treat them as active inputs.` |
| `all_filtered` | 5 | `All N discovered documents were excluded by policy: {filterReason}.` |

This mapping is part of the intended user contract, not just an implementation accident.

### Constants, Bounds, And Defaults

- Prompt bound:

```typescript
const PROMPT_ARG_MAX_BYTES = 32_768;
```

  - Measured using `Buffer.byteLength(prompt, "utf8")`.
  - Applies to the instruction prompt only.
  - Exceeding the bound returns an adapter error instead of spawning the subprocess.
- Timeout defaults and validation:

```typescript
const DEFAULT_TIMEOUT_MS = 300_000;
const TIMEOUT_MIN_MS = 30_000;
const TIMEOUT_MAX_MS = 900_000;
```

  - `timeoutMs` must be a safe integer in `[30_000, 900_000]`.
  - The timeout is universal across external LLM calls.
- Existing `SOURCE_CONTENT_BUDGET_BYTES` checks in code-derived generation must also use UTF-8 byte counting via `Buffer.byteLength(..., "utf8")` for consistency with the prompt bound.

### Prompt Transport Details

- `callOpencode()` must construct argv in this form:

```typescript
const args: string[] = ["run", options.prompt, "--model", options.model, "--format", "json"];
for (const filePath of options.files ?? []) {
  args.push("--file", filePath);
}
```

> **Note:** The prompt is the first positional argument after `run`, per the `opencode` CLI convention. Earlier revisions of this design incorrectly placed the prompt last; corrected in tasks.md section 6.

- `options.files` paths must exist and be readable at call time.
- The argv must preserve the order of attached files.
- Qualitative review changes semantics as well as transport:
  - attach raw proposal/design/spec files
  - do not serialize a normalized projection into the prompt
  - explicitly tell the model that attached files are untrusted user documents
- Code-derived generation must also attach source files rather than embedding large source bodies inline.
- Phases that remain inline-prompt only:
  - specs-forward formalization, because claim text is already small and structured
  - blind comparison, because the comparison context is expected to remain small

### JSON Extraction Algorithm And Limits

`extractJsonPayload(raw)` uses a deterministic four-step cascade:

1. direct `JSON.parse(trimmed)`
2. strip outer markdown code fences and retry parse
3. extract the first brace-balanced JSON object or array and retry parse
4. throw with the original parse error plus a preview of the raw input

Helper behavior is part of the implementation contract:

- `stripMarkdownFences(text)` removes only outer fences like `````json` ... ``` `` or ````` ... ``` ``.
- `extractFirstJsonValue(text)` scans once, tracks nesting depth, ignores braces inside quoted strings, and handles escapes.
- `extractJsonPayload()` returns any valid JSON value, including primitives, not only objects and arrays.
- The throw-vs-`Result` boundary stays at `callOpencode()`: parsing helpers throw internally and `callOpencode()` converts those failures into `OpencodeError` with `kind: "invalid_json"`.

Known limitation that must remain documented:

- Structured extraction considers only the first candidate `{` or `[` start position.
- It does not iterate through multiple candidate JSON regions.
- Property tests for prefixed text must therefore exclude `{`, `[`, `}`, and `]` from generated prefixes.

### Universal Timeout Propagation Map

All `callOpencode()` call paths must receive `timeoutMs` without exception:

- `src/domain/spec-forward/qualitative.ts`
  - qualitative review
  - qualitative properties/invariants
- `src/domain/formal/formalize.ts`
  - batch formalization
  - per-claim sampling and retries
- `src/domain/code-backwards/derive.ts`
  - code-derived generation
- `src/domain/code-backwards/gen-formal.ts` -> `src/domain/formal/formalize.ts`
  - indirect code-derived formalization
- `src/domain/code-backwards/blind-compare.ts`
  - blind comparison rationale generation

No phase-specific timeout floor or `Math.max(...)` override is part of this design.

This design does not modify solver-side Z3 timeout policy. Existing Z3 timeout behavior remains out of scope for the universal LLM timeout requirement.

### Clustering And Formalization Details

- Specs-forward clustering and code-derived clustering should both use the same explicit threshold value selected by the implementation for this change.
- The implementation derived from `fixes_plan.md` uses `0.6` for the clustering stability threshold at the call sites that invoke `clusterFormalizationSamples()`.
- Code-derived formalization continues to reuse the same formalization pipeline as specs-forward, with `samplesPerClaim: 1` in the current design scope.

### Verification Matrix

The implementation should include targeted automated coverage for the concrete contracts above.

| Area | Representative tests |
|---|---|
| CLI/config | parse `--allow-archive`; parse `--timeout-ms`; reject out-of-range and non-integer timeout values; default timeout is `300_000` |
| Catalog | archive excluded by default; archive included with flag; no-recognized-docs empty reason; all-archived empty reason; all-filtered empty reason; CLI exits with code `5` on empty catalog |
| Opencode adapter | emits ordered `--file` pairs; omits `--file` when absent; enforces prompt bound; forwards timeout to subprocess |
| JSON extraction | direct parse; fenced JSON; prefixed/suffixed JSON; nested braces inside strings; escaped quotes; no JSON present; truncated JSON |
| Property tests | fenced round-trip; prefix-plus-JSON round-trip with prefix excluding brace/bracket characters |
| Timeout propagation | qualitative, formalization, code-derived generation, generated formalization, and blind comparison all receive the configured timeout |
| Prompt transport | qualitative prompt bundle contains only instructions plus file paths; code-derived generation attaches only in-budget source files |

### Recommended Implementation Order

To minimize integration risk, implementation should proceed in this order:

1. JSON extraction cascade
2. `--allow-archive` and empty-catalog diagnostics
3. universal timeout plumbing
4. `--file` transport refactors

This order preserves a working adapter boundary early and reduces debugging complexity for later transport changes.

### Documentation And Style Requirements

- New and modified exported functions must carry complete TSDoc with:
  - `@param`
  - `@returns`
  - `@throws` where applicable
  - `@remarks` covering preconditions, postconditions, invariants, bounds, failure modes, and safety
  - `@example` where the behavior is subtle
- Important functions should add meaningful assertions, especially:
  - prompt byte bound enforcement
  - `files` list sanity
  - timeout integer/range validation
  - `extractJsonPayload()` postcondition that the result is not `undefined`

### Documentation Update Checklist

Implementation is expected to leave user and architecture docs coherent with the new behavior. At minimum:

- `ARCHITECTURE.md`
  - add `--allow-archive` and `--timeout-ms`
  - update adapter argv description for `--file`
  - document archive admission override and new default timeout
- `docs/design.md`
  - update CLI interface, timeout defaults, adapter boundary description, and catalog-empty behavior

### Alloy Model Impact

This design requires an explicit Alloy update for catalog/archive behavior.

- `catalog-and-parse/spec.md`
  - the unconditional `archived_never_active` assertion must be weakened to depend on config
  - the model should add:

```alloy
one sig Config {
  allowArchive : one Bool
}

assert archived_never_active {
  always (Config.allowArchive = False implies
    no (RunState.activeCatalog & ArchivedArtifact))
}
```

  - the `discover_success` predicate must also allow archived artifacts only when `Config.allowArchive = True`

No corresponding Alloy changes are required for:
- prompt/file transport
- timeout value configurability
- JSON extraction resilience

Those remain below the abstraction layer of the relevant behavioral specs.
