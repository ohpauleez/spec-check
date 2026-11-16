# Formal Analysis Preparation Optimizations

## Scope

This pass implements the preparation, indexing and construction optimizations
identified while reviewing `optimize-report.md`. It preserves solver query order,
actual script accounting, admission rules, expression limits and evidence formats.
Solver-result reuse and parallel scheduling remain separate follow-up work because
they change which checks can run under tight script/evidence budgets. Lexer
whitespace semantics are unchanged.

## Implementation

- `formal/immutable.ts` checks complete frozen plain-data graphs, not just root
  freezes. Accessors, mutable nested objects, Map/Set containers and cycles are
  ineligible for persistent caching. Eligibility is run/work-unit scoped.
- `ExpressionValidationContext` builds checked symbol, enum-constructor and unit
  indexes once per immutable signature. Mutable inputs are revalidated and
  reindexed on each call. Duplicate declarations still fail before indexing.
- `SignaturePreparation` reuses declaration text and the existing JSON signature
  fingerprint. Fingerprints are computed lazily when evidence needs them. Rendering
  a valid single signature does not require merging/copying it again.
- `PredicatePreparation` shares typed background and coverage predicates across
  samples of an immutable registry. Foreground predicates retain their configured
  byte/node/depth checks and existing validation error order.
- `ExpressionRenderer` caches only requested expression roots, within an 8-MiB
  rendered-string budget per instance. Cache reset/eviction affects performance
  only. It does not retain every overlapping subtree string.
- `FragmentClassifier` caches immutable subtree size, height and features. Query
  bounds still count every occurrence of a shared node, not just unique objects.
- `QueryExecutor` reuses prepared declarations, predicate rendering and fingerprints
  while writing the same scripts and evidence. Witness values are decoded once
  and shared with static witness reporting. Solver calls and ledger ordinals are
  unchanged.
- Static/clustering/compilation background comparisons hoist their baseline JSON
  and use a same-array fast path. Differing arrays still undergo actual content
  comparison; registry-hash equality is not used to ignore mismatched assumptions.
- Core-label maps preserve first-occurrence indexes and mandatory-before-background
  precedence. Core token membership uses a Set; solver/core semantics are unchanged.
- Dependency construction uses union-by-size/path compression and compares the
  smaller component set without allocating an array on every pair.
- Alignment indexes normalized definitions into candidate lists, preserving
  ambiguity and order. Joint-signature indexes do not snapshot mutable name maps.
- Concept reconciliation indexes source identities while preserving first-source
  selection and separate namespace checks.
- Discovery contexts serialize individual records and shared framing, then size
  chunks incrementally in UTF-8 bytes. JSON indentation, source/fallback ordinals,
  chunk boundaries, skipped records and request order remain identical.
- Evidence reservations maintain a running total, including consumption, unused
  release and failed writes. Descendant-aware scope indexes preserve the original
  literal-colon prefix predicate and sorted path results.

The new helper participates in runtime code fingerprints. Numeric versions are
unchanged; compiler fingerprints change because implementation code changed.

## Verification

`make check` passed with 1,023 tests across 114 passing files, including full canonical
trace coverage, strict TypeScript/ESLint, real-Z3 integration and compiled/bundled
CLI checks. Three opt-in tests in two files remained skipped.

`test/contract/formal-preparation.test.ts` covers nested mutations, accessors,
containers/cycles, private signature indexes, bounded rendering resets, shared
authored predicates, occurrence/depth limits, live alignment maps and exact query/
evidence bytes with unchanged actual execution counts.

`test/property/formal-optimization.property.test.ts` compares chunk packing to the
original serialization algorithm across Unicode/escaping/byte boundaries and mixed
source/fallback identities. Generated reservation histories compare admission to a
sum-based reference model; descendant lookup is compared to the original predicate.
Failed ticketed and unticketed writes retain their original capacity charges.

## Reproducible CPU Probes

```sh
npm run build
node --expose-gc build/benchmark-formal.mjs
```

The same harness was run against the existing pre-optimization compiled modules
before rebuilding, then against the optimized build. It reports warm median CPU
batch times and allocation growth, with no provider, Z3 or filesystem writes.
The 64-query workloads construct a fresh executor per sample; evidence workloads
serialize/hash artifacts into an in-memory writer. Script counts, context chunk
counts and all resulting byte hashes matched before and after.

Measured on Node 22.23.2; times are milliseconds:

| Workload | Symbols | Before | After |
| --- | ---: | ---: | ---: |
| 200 expression validations, 128 late-symbol references each | 32 | 34.77 | 10.16 |
| Same validation batch | 512 | 343.48 | 9.97 |
| Same validation batch | 2,048 | 1,288.62 | 10.13 |
| 64 query preparations, no evidence I/O | 32 | 14.50 | 1.78 |
| Same query batch | 512 | 28.13 | 4.16 |
| Same query batch | 2,048 | 82.37 | 10.78 |
| 64 query preparations with in-memory evidence | 32 | 29.79 | 7.01 |
| Same evidence batch | 512 | 50.55 | 10.35 |
| Same evidence batch | 2,048 | 115.82 | 18.36 |

| Discovery preparation, in-memory invoker | Before | After |
| --- | ---: | ---: |
| 128 statements | 5.47 | 0.40 |
| 256 statements | 21.96 | 0.66 |
| 512 statements | 69.93 | 1.41 |
| 1,024 statements | 300.03 | 2.35 |

Allocation growth is not peak or retained heap, and garbage-collection timing can
make individual small cases noisier or larger after optimization. The harness
reports it separately rather than claiming universally lower memory usage. Caches
are run/work-unit scoped, and rendered strings have an explicit per-instance cap.

These are synthetic preparation improvements, not end-to-end throughput claims.
The earlier live four-statement corpus spent most of its time in model calls; its
solver-analysis phase was about 1.7% of core elapsed time. That provider measurement
has not been rerun or represented as a measurement of this optimization pass.
