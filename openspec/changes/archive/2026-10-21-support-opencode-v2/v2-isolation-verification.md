# OpenCode Compatibility Discovery Evidence

## Status

**Compatibility gate accepted for the tested Linux v1.19.3/v2.0.15 baseline.** Source-exclusion probes, positive/negative controls, provider-backed ordinary/report calls, approved random-token reads, restricted tool availability, denied external reads, and unchanged sentinels now have direct evidence. V2 uses private server config, explicit project-discovery exclusion, and matching cwd/PWD. The implementation and its permanent regression fixtures are present; final repository-wide validation is recorded in the tasks' completion summary.

The exclusion requirement concerns external **server-side** plugins and MCP integrations. Terminal-only/CLI plugins are outside this boundary; no new terminal-plugin exclusion control or verification requirement is introduced. Trusted built-in server plugins remain available.

The 2026-10-21 review reopened completion for process-boundary and verification gaps. Those corrections are now closed with stronger evidence in [Review Correction Evidence](#review-correction-evidence-2026-10-21); the original successful runs below are retained as history rather than treated as proof of the previously untested cases.

Subsequent change verification exposed a separate Z3 readiness gap: `EACCES` was accepted by the inherited availability helper. The bounded preflight correction and its compiled/bundled zero-analysis evidence are complete in [tasks section 8](tasks.md#8-reject-unusable-z3-before-paid-analysis). Full `make check` now passes **862 tests** with the same **3 opt-in skips**; log: `/tmp/opencode/spec-check-z3-preflight-make-check.log`. This local solver-preflight correction did not require repeating provider/isolation experiments.

## Pinned Releases

| Protocol | Release | Executable SHA-256 | Provenance |
|---|---|---|---|
| v1 | `1.19.3` | `179ca421d61eefeadfa0c50e084a6e79c1623734732f0f4593f81ccfd3ab7ee9` | `opencode-linux-x64@1.19.3`, unpacked in disposable scratch storage |
| v2 | `2.0.15` | `b8ed44e893a3307cf23b4e0c83a4bb52b2c38d580fff33d3d9ec16477efb6077` | Existing local `@opencode/cli` executable |

V1 npm archive integrity: `sha512-wz+kXi7ZkvLW04hEIocW3RoEznALJ3YGnvNlZdXFarYF0v1jyDyAwpPGZkxb4JZDrw4oy48/LDZ8wCFIQDTxhw==`.

Commands, executed on 2026-10-20:

```sh
npm view opencode-linux-x64@1.19.3 dist.tarball dist.integrity --json
npm pack opencode-linux-x64@1.19.3 --pack-destination "$SCRATCH/v1" --json
tar -xzf "$SCRATCH/v1/opencode-linux-x64-1.19.3.tgz" -C "$SCRATCH/v1"
"$V1" --version
"$V1" run --help
"$V2" --version
"$V2" run --help
sha256sum "$V1" "$V2"
```

`SCRATCH` is a disposable root under `/tmp/opencode/spec-check-v2-discovery`; `V1` and `V2` name the executables above. This does not replace or modify the user's installed binary.

## CLI Admission

| Concern | v1.19.3 help | v2.0.15 help |
|---|---|---|
| Version stdout | `1.19.3` | `opencode v2.0.15` |
| Model | `--model provider/model` | `--model provider/model#variant` |
| Separate variant | `--variant` | Not advertised |
| Plugin exclusion | `--pure`: run without external plugins | No `--pure` advertised |
| Working directory | `--dir` | No `--dir` advertised |
| Private server | Existing in-process run path | `--standalone` |
| JSON output / attachments | `--format json`, `--file` | Same |

Both releases admitted the following prompt-first attachment shape in a disposable environment with no credentials and a deliberately nonexistent provider:

```sh
"$V1" run --pure --dir "$WORK" SPEC_CHECK_PROMPT_MARKER \
  --model spec-check-nonexistent-provider/model --format json \
  --file "$WORK/attachment.txt" --print-logs
"$V2" run --standalone SPEC_CHECK_PROMPT_MARKER \
  --model spec-check-nonexistent-provider/model --format json \
  --file "$WORK/attachment.txt" --print-logs
```

Each returned exit 1 with a JSON model-unavailable error, not a prompt/file argument parsing error. V1 logged the attachment path with `mime=text/plain`; v2 started a private `serve --stdio --port 0` process with the requested working directory. These are argument-admission observations, not successful evidence reads or paid inference evidence. They establish a tested baseline, not the minimum supported release within each major.

Observed error payloads, with volatile timestamp/session fields omitted:

```json
{"type":"error","error":{"name":"UnknownError","data":{"message":"Model not found: spec-check-nonexistent-provider/model."}}}
{"type":"error","error":{"type":"provider.no-route","message":"Model unavailable: spec-check-nonexistent-provider/model"}}
```

Both retain top-level `type: "error"`; the nested error shape differs. Text/usage fixtures remain pending.

## V2 Configuration Loading: Preliminary Observations

Used a fresh disposable HOME and XDG config/data/state/cache roots. Added uniquely named agents in controlled global, ancestor direct, ancestor `.opencode`, local, extra-directory, explicit-file, and inline configs. Each probe ran:

```sh
"$V2" run --standalone MARKER --agent "$MARKER_AGENT" \
  --model spec-check-nonexistent-provider/model --format json
```

An existing marker agent reaches `provider.no-route`; an absent marker returns `Agent not found`. No model can be dispatched through this nonexistent provider. The missing-marker control returned `Agent not found` in every case.

| Overrides | Recognized agent sources |
|---|---|
| Controlled XDG roots only | Global, ancestor direct, ancestor `.opencode`, local |
| `OPENCODE_CONFIG_CONTENT` | All baseline sources plus inline |
| `OPENCODE_CONFIG` | All baseline sources plus explicit file |
| `OPENCODE_CONFIG_DIR` | Ancestor direct, ancestor `.opencode`, local, extra directory; baseline global source absent |
| All three config overrides | Ancestor direct, ancestor `.opencode`, local, extra directory, explicit file, inline; baseline global source absent |

**Conclusion:** The candidate overrides are honored, but inline/explicit config is additive, and `OPENCODE_CONFIG_DIR` does not exclude ancestor configs. Standalone execution is not exclusive configuration loading. These tests establish source membership, not the precedence of colliding fields or effective permissions.

A preliminary `debug config` attempt under isolated XDG state timed out after 30 seconds because managed-service discovery tried the occupied default port; `debug config --standalone` is rejected as an unrecognized flag. Subsequent probes use `run --standalone`, which starts and terminates its own private server normally. The existing shared service was not restarted or reconfigured.

## Original Counterexample: Ancestor Plugin Startup

### Fixture

Created a disposable tree with an ancestor `opencode.json`, child working directory, separate private config directory, fresh HOME, and separate XDG config/data/state/cache directories. The ancestor native v2 configuration named a local plugin directory:

```json
{
  "plugins": ["file://<PLUGIN_DIRECTORY>"],
  "policies": [
    {"action":"integration.use","resource":"plugin:*","effect":"allow"}
  ]
}
```

The plugin directory's `index.ts` contained this harmless module-import marker, with an absolute marker path in the disposable tree:

```ts
import { writeFileSync } from "node:fs";
writeFileSync("<DISPOSABLE_MARKER_PATH>", "PLUGIN_LOADED");
export default { id: "spec-check-marker", setup() {} };
```

The marker tests module loading, not whether this minimal export exercises all plugin APIs. Import-time execution itself is the external-plugin side effect that v1's `--pure` control is intended to exclude.

Both the private `opencode.json` and inline configuration included:

```json
{
  "policies": [
    {"action":"integration.use","resource":"plugin:*","effect":"deny"}
  ]
}
```

Set `OPENCODE_CONFIG_DIR` to the private directory, `OPENCODE_CONFIG` to that private file, and `OPENCODE_CONFIG_CONTENT` to the same policy. Invoked from the child working directory:

```sh
"$V2" run --standalone MARKER \
  --model spec-check-nonexistent-provider/model --format json --print-logs
```

### Observations

- The private server started with the requested working directory.
- The process returned exit 1 with `provider.no-route`, as expected for the nonexistent provider; no inference could be dispatched.
- The disposable plugin startup marker **existed** and contained `PLUGIN_LOADED`.
- Server logs explicitly reported `loading plugin` with the fixture's directory and `index.ts` entrypoint.
- Repeated the experiment in fresh scratch trees with the same result.
- Removed the ancestor `integration.use ... allow` statement, removed the marker, and reran with a fresh private server: the marker still appeared. Therefore this experiment does **not** establish that ancestor-policy precedence is the sole cause, nor that the inline deny prevents module import. Its root cause remains unresolved.
- An initial single-file plugin fixture was rejected with `configured plugin path must be a directory`. That initial negative result is not isolation evidence; the directory fixture above is the valid loading counterexample.
- The analogous v1.19.3 `--pure --dir` run did not create its marker. A v1 control without `--pure` timed out during startup and is inconclusive; it is not reported as a successful positive control.

The local scratch reproducer is `/tmp/opencode/spec-check-v2-discovery/probe-plugin.py`; successful counterexample runs used separate `plugin-*` roots. The fixture contents, policy, environment controls, invocation, and observations above preserve the counterexample without depending on volatile session IDs or copying credentials.

### Original Consequence

The proposed standalone/cwd/config transport, even with the tested additional inline integration-deny policy, has not demonstrated the required exclusion of ambient plugin startup. Agent tool-denial tests cannot repair or establish this property: the marker executes before provider/model selection fails.

This originally paused production implementation under `[RAE-OC-COMPAT-BLOCK]` while a supported v2 mechanism for excluding ambient server integrations was investigated. Follow-up findings below refine the cause and identify the additional control. The original transport's insufficiency remains a regression case; it does not establish that v2 isolation is impossible.

At that stage, no conclusion was drawn that every possible OpenCode v2 isolation strategy was impossible. The result falsified the original candidate's sufficiency; the follow-up below identifies and verifies the missing server-source exclusion control.

## Follow-Up: Server-Side Integration Exclusion Controls

### Documentation And Pinned-Release Differences

Consulted the current official [plugin controls](https://opencode.ai/v2/docs/plugins/) and [integration policies](https://opencode.ai/v2/docs/policies/) and inspected the official `v2.0.15` tagged implementation to diagnose the observed release's behavior:

- [`packages/cli/src/server-process.ts`](https://github.com/anomalyco/opencode/blob/v2.0.15/packages/cli/src/server-process.ts#L108-L115) explicitly reads `OPENCODE_CONFIG_PROJECT_DISABLE`, with `OPENCODE_DISABLE_PROJECT_CONFIG` as its legacy alias, and passes the resulting project-discovery setting to the server.
- [`packages/core/src/config/discovery.ts`](https://github.com/anomalyco/opencode/blob/v2.0.15/packages/core/src/config/discovery.ts#L24-L83) skips the project/ancestor config walk when that setting is false. The private global config directory and explicitly supplied config still load.
- [`packages/core/src/plugin/supervisor.ts`](https://github.com/anomalyco/opencode/blob/v2.0.15/packages/core/src/plugin/supervisor.ts#L18-L95) processes plugin add/load operations before later removal operations. ID removals control activation, not prior module-import side effects.
- [`packages/core/src/config/normalize.ts`](https://github.com/anomalyco/opencode/blob/v2.0.15/packages/core/src/config/normalize.ts#L403-L443), [`packages/schema/src/config/policy.ts`](https://github.com/anomalyco/opencode/blob/v2.0.15/packages/schema/src/config/policy.ts), and the tagged policy plugin support the older `experimental.policies` form with `provider.use` and `permission` actions, rather than the current guide's top-level `integration.use` contract.

**Correction to the initial interpretation:** The earlier inline top-level integration-deny test does not demonstrate a bypass of a supported v2.0.15 integration policy. The tested release does not retain that top-level policy in decoded configuration; its `/api/config` output omitted the supplied `policies` field. Current documentation describes a broader policy surface than this pinned release implements. Do not rely on that policy shape for the v2.0.15 compatibility path.

The native project-disable variable is implemented in the official pinned CLI and empirically effective; it is not currently enumerated in the user-facing guide. Treat it as a source-backed, pinned-release control, not a promise about every v2 build or an invented configuration key.

### Direct CLI Experiment Matrix

Used fresh per-case HOME/XDG roots, a private config directory, an ancestor-configured server plugin, and an auto-discovered ancestor `.opencode/plugins/` package. Each plugin had separate import-time and `setup()` marker writes. Every case used `run --standalone` and the nonexistent provider; no paid inference was possible.

| Additional control | Module import markers | Setup markers | Interpretation |
|---|---|---|---|
| None | Both present | Both present | Positive loading control |
| Inline `{"plugins":[]}` | Both present | Both present | Empty arrays do not clear inherited/discovered sources |
| Inline top-level `integration.use` deny | Both present | Both present | Not supported by this pinned release's decoded policy surface |
| Inline `{"plugins":["-spec-check.*"]}` | Both present | None | Setup suppression, not import exclusion |
| Inline `{"plugins":["-*"]}` | Both present | None | Also disables required built-ins; returned `Agent not found: "build"` |
| `OPENCODE_CONFIG_PROJECT_DISABLE=1` | None | None | Ancestor integration discovery excluded |
| `OPENCODE_DISABLE_PROJECT_CONFIG=1` | None | None | Legacy alias works on the pinned release |
| Native variable `0`, legacy variable `1` | Both present | Both present | Native variable takes precedence; set it explicitly |
| Native variable `1`, plugin intentionally in explicit generated config | Configured marker present | Configured marker present | Disables project discovery, not trusted explicit configuration |

The user's proposed `OPENCODE_CONFIG_CONTENT='{"plugins":[]}'` override is therefore insufficient by itself. The effective solution is to prevent the unwanted server integration sources from entering configuration discovery, not merely override the plugin list after loading them.

### Server Inventory And MCP Positive/Negative Controls

Started an owned disposable `serve --stdio --port 0` process for each case, with an ephemeral Basic-auth credential never logged. Inspected that server's own OpenAPI schema before issuing GET requests to `/api/config`, `/api/plugin`, `/api/mcp`, and `/api/agent`. A `run --server <owned-url>` request with the nonexistent provider established completed location activation before reading inventory; an initial empty registry snapshot alone would not have been valid evidence.

Fixtures included:

- Auto-discovered global server plugin in the original XDG config root.
- Configured ancestor plugin and auto-discovered ancestor plugin.
- Global and ancestor local MCP servers with a valid minimal initialization response and a startup marker.
- A hostile same-name report agent in ancestor config and a trusted generated agent in private/inline config.

| Controls | External server plugins after activation | MCP inventory | Import/setup/MCP markers | Trusted generated agent |
|---|---|---|---|---|
| Original XDG global config plus ancestor discovery | 3 active | Global and ancestor connected | Present | Retained |
| Private `OPENCODE_CONFIG_DIR` only | 2 ancestor plugins active | Ancestor connected | Present | Retained |
| Private config directory plus `OPENCODE_CONFIG_PROJECT_DISABLE=1` | None | Empty | None | Retained |

The final case retained **86 built-in server plugins** and the generated report agent. Its effective permissions ended with the generated deny-all/read exception; the hostile ancestor document was absent from configuration inventory. The inventory contained only the generated private directory/file and inline document. The original XDG global config did not re-enter through ancestor discovery. Explicitly connecting the baseline ancestor MCP confirmed the marker fixture actually executes; exclusion is not inferred from a missing marker without a positive control.

Both inventories and marker results were repeated in fresh environments, including a run supplying the ignored top-level policy to confirm its absence from decoded configuration. This is instrumentation of an owned private server, not a proposed migration of the production adapter to the server API.

### Refined Final-Report Transport

For the verified v2.0.15 baseline, extend the original candidate with:

```text
argv: opencode run --standalone ... --agent spec-check-final-report --format json
cwd: private isolated execution root
OPENCODE_CONFIG_DIR: private generated config directory
OPENCODE_CONFIG: exact generated config file
OPENCODE_CONFIG_CONTENT: generated restricted agent configuration
OPENCODE_CONFIG_PROJECT_DISABLE: 1
PWD: same private isolated execution root as subprocess cwd
```

The explicit native variable must override inherited values; relying only on the legacy alias would allow an inherited native `0` to re-enable project discovery. Keep the generated config free of external plugin/MCP entries. Keep the provider's existing data/authentication location available; these experiments used empty data roots solely to avoid real credentials and do not prove production authentication works yet. No new control is required to exclude terminal-only plugins.

This resolves the specific server-plugin/MCP discovery counterexample and supplies an evidence-backed transport refinement. The provider-backed checks below complete the tested-release runtime gate. This is not an OS sandbox or a claim about untested managed/remote configurations.

### Reproduction And Regression Cases

Scratch harnesses and captured machine-readable results:

- `/tmp/opencode/spec-check-v2-discovery/probe-v2-exclusion.py` — direct CLI controls, separate import/setup markers, legacy/native precedence, and explicit-config positive control; results under `exclusion-84voh2e3/results.json`.
- `/tmp/opencode/spec-check-v2-discovery/probe-v2-integration-sources.py` — owned private server, activation barrier, decoded config, active plugin/MCP inventories, startup markers, and same-name agent; results under `integration-sources-7e536f21/results.json` and `integration-sources-efjj_fnm/results.json`.

The permanent opt-in `test/integration/opencode-server-exclusion.integration.test.ts` now reproduces the import/setup distinction, empty-array behavior, native/legacy precedence, and actual pre-import source exclusion against the selected real v2 binary. `test/fixtures/opencode-compat/exclusion-observations.json` preserves sanitized inventory observations; contract tests check their provenance and the production transport controls. Default tests do not pretend to rerun a skipped actual-binary or paid provider check.

## Provider-Backed Checks And Transport Fixtures

Explicitly enabled provider-backed verification using `github-copilot/gpt-5.6-terra` at `high` on both pinned majors. No credential was copied into generated config. V2 used its existing authentication/data location; v1 used an isolated data directory and inherited `GITHUB_TOKEN`, because the v1 executable cannot open the existing v2 session database. An initial v1 shared-data attempt rejected that schema with `Database is not empty and has no session table`; it is not reported as a successful check. No database was manually edited or removed.

The initial `gpt-5.4` probe was rejected by the provider as unavailable. Subsequent successful checks use the project's configured default Terra model and fixed reasoning variant; the rejection is not treated as a transport success.

Permanent live checks:

```sh
SPEC_CHECK_LIVE_TESTS=1 npx vitest run test/contract/opencode.live.test.ts
SPEC_CHECK_LIVE_TESTS=1 SPEC_CHECK_OPENCODE_BINARY="$V1" \
  XDG_DATA_HOME="$V1_DATA" XDG_CONFIG_HOME="$V1_CONFIG" \
  npx vitest run test/contract/opencode.live.test.ts
SPEC_CHECK_V2_DISCOVERY=1 \
  npx vitest run test/integration/opencode-server-exclusion.integration.test.ts
```

- Both majors returned exactly `{"findings":[]}` for the ordinary adapter check.
- Both report checks read a newly generated random token from an explicitly approved evidence file. Its value was absent from the prompt and had to be obtained through the actual read tool.
- The denied external-file token was absent from the returned report, and mutation sentinel bytes remained unchanged.
- The generated restricted agent exposed read/search capabilities without mutation, shell, delegation, or web-fetch tools. A controlled same-name ancestor agent with permissive rules and an untrusted ancestor `AGENTS.md` fixture did not broaden effective report authority.
- Returned report transport passed the adapter's strict JSON text-event/path/body contract. Independent deterministic integration tests exercise full required headings/citations, trusted publication, checksums, and optional-report failure/manifest refresh.
- V2 ordinary and report tests passed, and the final report test was rerun successfully after cwd/PWD synchronization and hostile ancestor fixtures were added. V1's two live tests passed together; its report test was likewise rerun successfully with the hostile fixtures. Filtered runs' intentionally skipped unrelated tests are not counted as additional passes.

Sanitized real `text`, `error`, and `step_finish` samples are committed as `test/fixtures/opencode-v{1,2}.{events,error}.ndjson`. They omit volatile IDs/timestamps and tool/file-path payloads and redact random test tokens. The captured v2 sample lacks `tokens.total`; the existing extractor correctly marks that usage incomplete while retaining observed counts. Shared text/error decoding needs no major-specific branch for these samples.

### Cwd/PWD Regression

The first permanent integration-exclusion positive control unexpectedly inspected the repository instead of the requested temporary cwd. The tagged [`packages/cli/src/run/run.ts`](https://github.com/anomalyco/opencode/blob/v2.0.15/packages/cli/src/run/run.ts#L71-L79) explains the result: run target resolution prefers inherited `PWD` over `process.cwd()`.

Production v2 report execution now sets both subprocess cwd and `PWD` to the private root. The permanent control matrix then passed, and the real v2 report read/deny test passed again. Early scratch Python probes used clean environments without inherited `PWD`; their source-inventory results remain valid, but cwd alone is not the accepted production strategy.

## Final Gate Decision

Accept the refined transport for the pinned, locally configured Linux release baseline. Original unsupported flags, additive empty plugin arrays, setup-only removals, ignored top-level integration policies, and inherited-PWD misdirection are preserved as counterexamples/regression expectations rather than silently assumed safe.

Evidence is bounded to the exercised releases and environment. `/etc/opencode`, `/AGENTS.md`, and `/tmp/AGENTS.md` were absent in this host; controlled global/ancestor config and instruction fixtures were used without changing real global or system config. Managed/Console policy remains trusted and is not bypassed. No claim is made that every operating system, provider-specific remote configuration, or release in either major has identical behavior.

The existing run's core evidence/manifest behavior remains independent of optional report success. Actual executable replacement during a run remains unsupported. Terminal-only plugins remain outside the exclusion contract.

## Verification Scope And Residual Limits

- Successful permission/read/transport checks establish the pinned local-provider path, not universal formal verification of OpenCode.
- Empty real system/remote-config sources do not prove behavior for a separately managed deployment; investigate such a deployment if it is added to the support baseline.
- The v1 non-pure startup control remains inconclusive; v1 `--pure` availability, no-startup observation, actual read-only provider calls, and retained v1 argv are the applicable baseline evidence.
- Live and actual-binary checks remain opt-in. Default verification replays committed evidence and deterministic process fixtures without requiring external provider access.

An unchanged sentinel or model-unavailable response alone is not accepted as proof; the decision above also uses positive startup controls, approved random-token reads, strict successful transport, and preserved permission authority.

## Review Correction Evidence (2026-10-21)

### Process And Resource Boundaries

`test/contract/process-tree.test.ts` executes real parent/descendant fixtures for timeout, capture overflow, and parent exit with inherited pipes. It asserts elapsed time and validated descendant PIDs, treating a zombie as terminated work rather than a live pipe holder. The owned group is terminated. A deliberately detached descendant remains outside group ownership, but bounded local stream cleanup returns without waiting for it; the harness then kills its own escaped fixture explicitly.

`test/contract/process-settlement.test.ts` exercises output/timeout/error/close races with fake timers, proves first-cause/exactly-once settlement, clears deadline/cleanup timers, handles repeated late errors, and verifies unreferencing a process handle whose exit is not yet confirmed. Cleanup allowance is 250 ms after termination request; event-loop pauses and escaped groups are not represented as OS containment. Windows cleanup is bounded best-effort and is not certified by the Linux PID tests.

The process adapter uses `node:buffer.isUtf8` followed by one conversion per stream. Generated byte arrays agree with a strict fatal `TextDecoder` oracle; actual multibyte chunk splitting, invalid stderr, and empty streams preserve byte-validity flags. This is a correctness comparison, not a claim that a synthetic decoding benchmark establishes an end-to-end pipeline speedup.

`output_limit` now remains terminal under a larger retry budget and competing timeout metadata; adapter/degradation contracts assert a single model attempt and no inline response fallback. Actual CLI cases with 15,000-character semantic-version suffixes verify bounded success/failure presentation while a supported descriptor retains the full canonical version.

### Reporting And Production-Connected Verification

Citation contracts accept custom output/specification directories, Unicode/space-bearing paths, root files with extensions and extensionless root Markdown-link targets. They reject absolute/drive/UNC/home paths, URLs, traversal, query suffixes, control data and relative-looking fragments inside non-path tokens. Long unmatched link delimiters are a permanent regression. Inline code words alone do not satisfy artifact citation requirements. No referenced-file existence guarantee was added.

`run-cli.ts` now calls the production coordinator in `src/cli/final-report-lifecycle.ts`. The differential property test executes that same coordinator with injected effects, independently stores report/summary/manifest bytes, checks hashes and effect ordering, and compares expected histories/observed terminal facts with the reference model. It covers success, generation/validation failure, and each cleanup/marker/summary/manifest failure. The old fake event interpreter no longer substitutes for production orchestration. Existing filesystem-backed fault integrations also pass; the reference/Alloy model bodies did not change.

### Objective Permission Evidence

The strengthened live test first starts an owned disposable server with the generated policy and a random local authentication password kept out of argv/config/logs. A no-inference unavailable-model barrier completes location activation. The harness reads the actual effective agent rules through the corresponding v1/v2 API, normalizes only wire aliases, and applies an independent last-match oracle to concrete disposable edit targets, shell commands, delegation IDs, web resources and other denied capabilities. It also asserts approved-read authority and denied external-directory authority.

The real production adapter then performs the provider-backed report call. The test requires the approved random token and an actual top-level server `tool_use` event for the prohibited file with `state.status: "error"` and a denial error; the target path is removed from the error text before matching, so the word `denied` in a filename cannot manufacture evidence. A model statement, missing denied token, or unchanged sentinel alone cannot pass this check. Mutation is requested only if an edit tool is exposed, and effective permission assertions run first. No inference call is made through the inventory barrier. Startup-marker exclusion remains a separate actual-binary test.

Both pinned releases passed this stronger test. Both ordinary provider-backed payload tests and the actual v2 source-exclusion matrix also passed separately. Filtered runs' skipped unrelated tests are not counted as executed passes. The same pinned binary versions and SHA-256 hashes were rechecked.

### Telemetry And Development Dependencies

Disabled production telemetry creates no implicit collector and reads response stdout only for payload processing; explicit collection performs the additional usage read. Collection/publication enablement is captured at startup and tested against mid-run environment changes. Enabled one-pass totals, phases, scopes, duplicate logical IDs, empty groups and unattributed attempts reconcile against independent reductions over generated histories.

The fresh audit initially reported 10 affected development packages. The updated graph resolves Vitest 4.1.12, transitive-only Vite 6.4.5, esbuild 0.25.12, brace-expansion 5.0.12, nanoid 3.3.20, postcss 8.5.31 and source-map-js 1.2.2. The final `npm audit` reports zero vulnerabilities as of this check. There is no direct Vite dependency. The existing ignored-lockfile policy remains intact; manifest overrides enforce necessary patched transitive minimums. Standard `npm install` and clean `npm ci` succeeded. Initial npm 10 incremental peer resolution failed; a temporary npm 11 invocation repaired the graph, after which standard npm 10 install/ci/audit succeeded.

Vitest 4's `onTestRunEnd` now drives full-catalog trace enforcement. A deliberately incomplete child test run must exit nonzero with an uncovered-identifier diagnostic, using an isolated temporary coverage record so it cannot corrupt its parent run. This verifies the reporter itself survived the dependency upgrade.

Final acceptance: `make check` passed **842 tests** with **3 opt-in skips** across 89 passing and 2 skipped files, including full canonical trace coverage and both distribution forms. The skipped actual/provider checks were separately executed as described above. Strict OpenSpec validation, audit, and whitespace checks pass. Exact commands/results and log paths are recorded in section 7 of `tasks.md`.
