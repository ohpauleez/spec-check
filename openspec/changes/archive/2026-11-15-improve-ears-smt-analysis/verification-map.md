# Verification Inventory and Changed Expectations

## Verification Boundary Remediation

The original requirement inventory remains below. The verified boundary repairs
add these meaningful combination checks without relying on trace counts alone:

| Finding | Direct regression evidence |
| --- | --- |
| C1 | `test/integration/generated-only-cli.integration.test.ts`: actual compiled/bundled CLI, independently observed real-Z3 executions, one-script capability ceiling, ledger/evidence equality, empty generation |
| W1 | `test/contract/formalization-predicates.test.ts`: explicit two-actor configuration, opaque identifiers, changed subject requests, batch/recovery/additional context |
| W2 | `semantic-comparison.test.ts`, `semantic-clustering.test.ts`, `gen-formal.test.ts`: either-side unstable assessment, permission baseline, no matching credit, single/stable/proposed identity, admitted metadata and generated publication |
| W3 | `source-generation.test.ts`, `semantic-pipeline.integration.test.ts`: immutable private bytes across source edits/retries, independent request hashes/raw attempts, capacity refusal, complete failure and OutputError-before-manifest |
| W4 | `typed-mapping-comments.test.ts`, `formal-preparation.test.ts`: reversible typed mapping comments, Unicode/newlines inert in real Z3, exact updated scripts and cache mutation behavior |

`models/boundary-remediation.als` supplies three positive witnesses and four
bounded assertions for one-capability charging, evidence-before-completion,
snapshot preservation and unstable contributing-artifact credit. Original
pre-refactor byte snapshots remain in `verification-evidence/`; current snapshots
explicitly include the authorized subject/context and mapping-comment changes.

[`verification-map.json`](verification-map.json) assigns every tagged requirement and scenario in the six delta specs to its nearest enclosing requirement, executable verification paths, and behavioral expectation. This selection rule maps scenario identifiers as well as requirement identifiers without maintaining a second copied identifier list. The final inventory contains 35 requirement groups covering 206 tagged headers (35 requirements and 171 scenarios). The original proposal inventory had 34 groups and 199 headers; the resolved permission policy added one requirement and five scenarios, and bounded capture added one scenario.

All referenced check paths now exist, and the full traced test suite passed. Successful trace accounting is not a proof of English-to-logic fidelity or whole-system correctness. Model/evidence paths are relative to this change; test paths are relative to the repository. Commands and bounded results are recorded in [`verification.md`](verification.md).

## Intentional Changes to Existing Expectations

| Existing identifier | Old expectation | Required new expectation |
| --- | --- | --- |
| `CAT-EARS-MATCH` | Keyword presence, including distinct generic conditional | Ordered complete grammar; one guarded IF/THEN form; optional WHERE explicitly selected |
| `CAT-EARS-WARN` | Warn and continue formalization of non-EARS prose | Retain source for review and exclude unsupported formal scope |
| `CGC-OBLIG-MANDATORY` | SHALL substring dominates | Structural SHALL and MUST own mandatory modality |
| `CGC-OBLIG-OPTIONAL` | Informational severity on a shared hard assertion | Permission is not a mandatory response |
| `FLA-FORMAL-FAIL` | Scenario names exit 2 | Existing FormalizationError category maps attempted phase-wide failure to exit 9 |
| `FLA-SAMPLE-ACCEPT` | Balanced parentheses and declaration shape | Fully resolved typed clause predicates inside admitted fragment |
| `FLA-SPEC-DANGLING-REF` | Deliberately defer undefined references to Z3 | Early dependency invalidation with preserved evidence; solver rejection only a backstop |
| `FLA-CLUSTER-STABLE` | Select a stable cluster without nonvacuity qualification | Satisfiable background/premise, evidence-quality selection, and registry-dependent qualifications |
| `FLA-CLUSTER-DIVERGE` | First representative can be analyzed as ordinary authority | Preserve alternatives and mark any representative analysis interpretation-dependent |
| `FLA-CLUSTER-QUERY` | Concatenate independently compiled declarations | Checked shared signature exactly once and prerequisite satisfiability checks |
| `FLA-LOGIC-ADVISORY` | Advisory constraints participate in the same global model | Separate advisory extension; mandatory baseline does not become inconsistent because of it |
| `FLA-PAIRWISE-CONTRA` | Test only selected implication consequents | Test the complete mandatory set under satisfiable co-active guards and attribute the sufficient core |
| `FLA-PAIRWISE-BOUND` | Nested static fan-out independent of configured pair budget | Effective pair budget plus shared actual-script/concurrency accounting and visible skipped scope |
| `FLA-COMPLETENESS-UBIQ` | Any unconditional assertion suppresses all coverage | Only relevant behavior-family guards supply coverage; unrelated invariants do not suppress checking |
| `FLA-COMPLETENESS-EXHAUST` | No gap means completeness over reachable states | Guard exhaustiveness only within explicit valuation domain/family |
| `FLA-PERSIST-SAT` | Persist a compiled declaration/assertion fragment | Persist every exact executed script including commands and any witness rerun |
| `STC-FORMAL-STABLE` | Generated claims are constructed as mandatory | Generated text goes through the same structural/modal parser and independent registry |
| `STC-IMPLY-UNCERTAIN` | Model fallback can provide a final classification | Formal uncertainty remains terminal; qualitative assessment is separate |
| `STC-IMPLY-STRONGER` | UNSAT premise can vacuously earn stronger | Inconsistent premise is reported and cannot support favorable comparison |
| `STC-COMPARE-FALLBACK` | Qualitative fallback supplies formal-style final verdict | Never promote uncertain/unmapped/incompatible/partial status to solver equivalence |
| `RAE-FORMAL-ATTEMPT-ATOMIC` | Attached-only pointer envelope | Preserve pointer namespace plus separate raw attempt evidence on every invocation path |

## Validation Method

The inventory check scans exactly `### Requirement:` and `#### Scenario:` tagged headers in the delta specs, tracks the nearest requirement, and verifies that every header has one mapped group. It also verifies that every mapping references a real requirement and that change-local model/evidence paths exist. Existing model subsection headings are not behavioral scenarios and do not receive invented identifiers.

The final inventory scan verified unique identifiers, exact requirement-group mapping, existing test/model/evidence paths, and all delta relative link targets. Executable semantic acceptance and trace coverage were checked separately with `make check`.

## Post-Completion Guideline Remediation

`alignment-characterization.test.ts` adds pre-refactor exact-history regression
evidence for source formalization and static analysis. Generated sort-directed
expressions/rename properties, timeout/partial-evidence histories and numeric
boundary fixtures extend existing canonical checks. Optimization history tests
now declare relevant trace IDs. `formal-style.test.ts` is intentionally untagged:
it enforces coding-guide size targets, not a normative capability scenario.
See verification.md for the 1,118-test acceptance result and explicit remaining
API/ownership follow-ups. Trace declarations inventory exercised contracts; they
do not prove whole-system refinement or expression/English fidelity.
