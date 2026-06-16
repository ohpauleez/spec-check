# TypeScript Style Guide

A style guide for reliable, performant, evolvable TypeScript systems.

This guide takes direct inspiration from [NASA's Power of 10](https://en.wikipedia.org/wiki/The_Power_of_10:_Rules_for_Developing_Safety-Critical_Code), [TigerStyle](https://tigerstyle.dev/), Google's [TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html), [ts.dev/style](https://ts.dev/style/), with additional influence from Datadog, Firecracker, DataFusion, and FoundationDB.

The priorities are:

1. Safety
2. Performance
3. Developer experience

Style is not decoration. Style is design pressure applied early enough to prevent defects, simplify reasoning, and lower maintenance cost.

## Quick Reference

| Pattern | Rule |
|---|---|
| Design | Specify invariants, legal transitions, failures, and bounds before coding |
| System shape | Prefer deterministic systems and explicit state machines |
| Control flow | Keep control flow simple; bound loops; keep a function within 70 lines |
| Bounds | Put a bound on queues, retries, buffers, input sizes, and in-flight work |
| Error handling | Use `Result`-style tagged unions for expected failures; throw `Error` only for exceptional failures |
| Types | Prefer discriminated unions, `readonly`, branded types, and explicit boundary validation over flags and raw primitives |
| Assertions | Assert preconditions, postconditions, invariants, exhaustiveness, and bounds |
| Arithmetic | Use explicit units; never assume `number` is integral, exact, or safe from overflow |
| Verification | Design for simulation, differential testing, property testing, and fault injection |
| Async | Prefer deterministic async flows, partitioned ownership, message passing, and explicit cancellation |
| Performance | Target stable object shapes and low allocation in hot paths; avoid unnecessary copies |
| Documentation | All functions and methods need TSDoc with preconditions, postconditions, invariants, failures, and safety requirements |
| Tooling | `tsc --strict` clean; zero normalized linter debt; no ignored type errors |

## The Rules

### 1. Design around invariants first.

Before writing production code, state:

- what must always be true;
- what must never happen;
- what states exist;
- what transitions are legal;
- what failures are expected;
- what limits must hold.

For non-trivial work, start with a small design sketch, state table, or executable reference model. Prefer a lightweight model that engineers can maintain over a grand formal artifact that nobody updates.

Reason: most expensive defects are introduced in requirements and design. [Invariants](https://brooker.co.za/blog/2023/07/28/ds-testing.html) are the strongest bridge between design, implementation, testing, and verification.

### 2. Build deterministic systems, ideally as explicit state machines.

Model lifecycle and protocol behavior with discriminated unions, string literal unions, `readonly` object types, enums where runtime interop requires them, or typestate-style wrappers where the protocol itself matters.

- Illegal transitions should be impossible or difficult to express.
- State changes should be explicit, local, and compiler enforced.
- Side effects and nondeterminism should live at the edges. (`Date`, timers, randomness, I/O, environment access, feature flags)
- Core transitions should be deterministic.

Prefer designs that can be explained as "given state `S` and input `I`, produce state `S'` and output `O`".

Prefer discriminated unions over boolean flags. Use enums only when a runtime value is required for interop, wire formats, or indexing. Never use `const enum`.

Use exhaustive `switch` handling plus `assertNever(...)` to prove all cases are covered.

Reason: deterministic state machines are easier to reason about, test, replay, verify, and evolve. They also expose invariants clearly.

### 3. Use only simple, explicit control flow.

- Prefer early returns over deep nesting.
- Avoid recursion in production paths unless the bound is trivial and documented.
- Avoid clever control flow and hidden callbacks in core logic.
- Split compound boolean logic when correctness matters.
- Every loop must have a visible upper bound, or the non-termination must be explicit and justified.
- Prefer `for...of` or bounded indexed loops over `forEach(...)` in core logic and hot paths.

Hard target: keep functions within 70 lines.

Push `if`s up and loops down. Let parent functions own control flow; let helpers do pure or near-pure work.

Require braces for multi-line control flow. If a one-line `if` remains, it must stay obviously one-line after formatting.

Reason: simple control flow is easier for reviewers, static analyzers, and test harnesses to understand.

### 4. Put a bound on everything.

Bound loops, queues, retries, batch sizes, buffer sizes, input sizes, timeouts, concurrency, cache growth, and memory growth.

- Unbounded work is a bug unless proven otherwise.
- Use named constants for operational limits.
- Make bounds visible at the call site.
- Fail fast when limits are exceeded.

If a loop is intentionally unbounded, assert the surrounding invariant that makes it safe, such as "event loop processes one bounded batch per tick".

Reason: real systems have limits. Explicit bounds prevent infinite loops, latency spikes, memory blowups, and hand-wavy designs.

### 5. Use `Result`-style tagged unions for expected failures; throw `Error` only for exceptional failures.

For domain, validation, parsing, lookup, and state-transition failures, return a tagged union such as:

```ts
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

- Model `E` with a discriminated union, string literal union, or narrow error object type.
- Handle `Result` explicitly with `switch`, `if`, `map`, `flatMap`, or `fold`-style helpers.
- Do not ignore `Result` values.
- Do not hide expected failures inside thrown exceptions.

Use exceptions only for:

- broken invariants;
- impossible states;
- programmer errors;
- infrastructure failures that are truly exceptional at the current layer.

Rules:

- Throw only `Error` objects or subclasses, never strings or arbitrary values.
- Always instantiate with `new Error(...)` or a subclass.
- Catch as `unknown` and narrow before use.
- Error checking must be exhaustive.
- Normalize third-party throws near the boundary.

Reason: foreseeable production failures are part of ordinary behavior and should be represented as data. This keeps control flow explicit and makes error handling testable.

### 6. Encode semantics in types.

Use TypeScript's type system to make invalid states harder to represent.

- Use discriminated unions for algebraic domains and protocol states.
- Use `Result<T, E>` for success/failure.
- Use branded or opaque types for identifiers, units, validated inputs, and trust boundaries.
- Use `readonly` for values that should not be reassigned or mutated by default.
- Use `unknown` at trust boundaries and narrow explicitly.
- Use optional properties only when the property is truly optional in the domain.

Avoid boolean flags when the state deserves a type. Avoid reusing raw `string`, `number`, or `Record<string, unknown>` values when a semantic wrapper would prevent confusion.

Avoid `any`. If a boundary truly forces `any`, isolate it in one place and convert immediately into validated internal types.

Prefer type annotations for object literals over `as` assertions:

```ts
const config: RetryPolicy = {
  attemptsMax: 3,
  backoffMs: 50,
};
```

Not:

```ts
const config = {
  attemptsMax: 3,
  backoffMs: 50,
} as RetryPolicy;
```

Reason: types are the cheapest always-on verifier we have. In TypeScript, the main safety win comes from encoding meaning in types and validating untrusted values before they enter those types.

### 7. Assert preconditions, postconditions, and invariants aggressively.

Every important function should validate:

- inputs;
- output relationships;
- preserved invariants;
- bounds;
- assumptions at I/O and trust boundaries;
- exhaustiveness when handling closed domains.

Rules:

- Assertions must be side-effect free.
- Split compound assertions into smaller assertions.
- Assert both positive space and negative space.
- Use `assertNever(...)` for discriminated unions and exhaustive switches.
- Prefer assertion functions (`asserts value is T`) when narrowing is part of the API.
- Add startup-time sanity checks for constant relationships and configuration assumptions.

Target: two meaningful assertions per important function.

At trust boundaries, pair static types with runtime validation. A type annotation on JSON is not validation. Parse into `unknown`, validate, then convert.

Reason: assertions turn vague intent into executable truth claims. They catch programmer mistakes early and amplify the power of fuzzing, property testing, and bounded checking.

### 8. Make arithmetic and units explicit.

- Never assume arithmetic on `number` is exact, integral, or safe.
- Check for `Number.isSafeInteger(...)` when integer correctness matters.
- Use `bigint` when the domain requires integral values outside the safe integer range.
- Name units explicitly: `timeoutMs`, `sizeBytes`, `attemptsMax`.
- Distinguish index, count, size, offset, and capacity conceptually and in names.
- Make rounding behavior explicit with `Math.floor`, `Math.ceil`, `Math.trunc`, or exact integer checks.
- Parse numbers with `Number(...)` and validate the result. Do not use unary `+` as a parser.

Avoid casual mixing of counts and indices, especially in loops, slicing, retry logic, and allocation logic.

Do not treat `NaN`, `Infinity`, and imprecise floating-point results as edge cases. They are ordinary failure modes.

Reason: off-by-one, overflow, precision, and unit bugs are ordinary bugs, not curiosities.

### 9. Design for simulation, differential testing, and fault injection.

Every important subsystem should admit a small reference model and a production implementation that can be compared.

- Wrap time, randomness, storage, network, and external services behind interfaces.
- Keep core logic independent from direct I/O.
- Differential-test production code against the executable model.
- Test histories, not only single calls.
- Inject failures deliberately: retries, partial progress, reordering, timeouts, malformed inputs, corruption, crash/recovery.
- Turn every counterexample into a permanent regression test.

Suggested stack in this repo:

- Vitest for examples and regression tests
- `fast-check` for generated histories and metamorphic tests
- [LemmaScript](https://lemmascript.com/) for method-level contracts and system invariants
- fake timers for time-based logic
- lightweight model implementations for differential testing
- fuzzing at parsing and protocol boundaries where practical

Reason: the harness is the trust boundary. The model is useful only if it remains connected to the implementation.

### 10. Keep the codebase small in scope, strict in tooling, and explicit in rationale.

- Enable `tsc --strict`.
- Keep zero compiler errors and zero ignored type errors.
- Prefer a small dependency set.
- Keep files small; target 500 lines or less per file.
- Keep variables in the smallest possible scope.
- Avoid duplicate state and semantic aliases.
- Explain why in comments, not what.
- Be explicit at call sites instead of relying on dangerous defaults.
- Use ES modules only.
- Prefer named exports; do not use default exports.
- Use `import type` and `export type` for type-only symbols.
- Do not use `namespace`, `require`, `@ts-ignore`, or `// @ts-nocheck`.

Recommended compiler settings for high-assurance code include:

- `strict`
- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `noImplicitOverride`
- `noFallthroughCasesInSwitch`
- `noImplicitReturns`
- `useUnknownInCatchVariables`

Reason: safety, performance, and developer experience compound when the toolbox is small, the rules are strict, and rationale is preserved next to the code.

### 11. Async and concurrency are design decisions, not conveniences.

Do not add async work, parallelism, retries, background processing, or workers merely because the runtime makes them easy. Add them only when the ownership model, ordering rules, cancellation semantics, and invariants are explicit.

- Prefer partitioned ownership, message passing, queues, and single-writer regions over shared mutable state.
- Prefer stable partitions with one logical owner per partition when the problem permits it.
- Bound queue depth, batch size, retry count, timeout budgets, and in-flight work.
- Make ordering guarantees explicit: total order, per-key order, causal order, or intentionally unordered.
- Make cancellation explicit with `AbortSignal` or an equivalent contract.
- Do not hide asynchronous scheduling behind ordinary-looking synchronous APIs if the timing semantics matter.
- If shared mutation is unavoidable, make the ownership boundary and synchronization protocol obvious in the type and API design.

Rules:

- Every async subsystem must have a written statement of its ownership model.
- Every background task must have bounded work per unit of progress.
- Every queue must have backpressure behavior.
- Every retry loop must have a limit, budget, or explicit operator override.
- Every concurrency bug found in production or testing should become a deterministic regression test if at all possible.

When feasible, build systems so that any interleaving of truly independent events leads to the same valid end state. Where this is not possible, make the serialization point explicit.

Reason: incidental async behavior destroys local reasoning. Deterministic or carefully partitioned concurrency preserves intellectual control, simplifies verification, improves replayability, and lowers maintenance cost.

## High-Performance TypeScript

High-performance TypeScript begins with design, not micro-optimizations. The largest wins usually come from choosing the right data layout, ownership model, allocation strategy, and control flow shape before the code is written. Prefer safety, explainable behavior, and predictability first; throughput and latency usually follow.

### Core Principles

- **Allocation**: Minimize allocation and object churn. In hot paths, target low allocation; allocate during startup when possible and reuse deliberately.
- **Layout**: Design around data layout and access patterns, not only APIs. Prefer contiguous, cache-friendly layouts such as arrays, typed arrays, and struct-of-arrays where appropriate.
- **Dataflow**: Keep hot code simple and explicit so the JS engine can optimize it.
- **Bounded work**: Bound work and batch operations to amortize parsing, hashing, serialization, I/O, and scheduling overhead.
- **Hot-path isolation**: Separate hot paths from cold paths. Push dynamic behavior, validation, logging, and abstraction overhead to the edges and outside inner loops.
- **Predictability**: Optimize for stable p95 and p99 latency, not just peak throughput. Avoid unnecessary copies and move data only when the cost is justified.

### Runtime and Engine Sympathy

When deciding how to implement something, reason from the runtime upward:

- **Object shapes**: Keep object shapes stable. Initialize fields consistently. Do not add or delete properties after construction.
- **Arrays**: Avoid sparse arrays, accidental holes, and mixed element kinds in hot paths.
- **Closures**: Be aware that closures allocate and capture. Do not allocate avoidable callbacks inside hot loops.
- **Polymorphism**: Highly polymorphic call sites and shape changes can deoptimize optimized code.
- **Serialization**: `JSON.parse` and `JSON.stringify` are boundaries with real cost. Validate once, convert once, and avoid repeated shape translation.
- **Scheduling**: Promises, microtasks, timers, and worker handoffs all have cost. Reduce unnecessary hops.
- **Typed buffers**: Prefer `Uint8Array`, `ArrayBuffer`, and views for binary protocols and tight numeric kernels.

### Implementation Heuristics

- Prefer simple loops over callback-heavy iterator chains in hot paths.
- Prefer stable object literals and `readonly` data in core domain logic.
- Precompute masks, lookup tables, and exact capacities where they matter.
- Avoid unnecessary copying. Prefer slices, views, iterators, or indexes when ownership remains clear.
- Prefer explicit parsing and normalization phases at boundaries.
- Avoid getters, setters, proxies, and decorators in hot code.
- Measure before and after any optimization. Keep benchmark harnesses with the code that motivated them.

Suggested practice in this repo:

- `tinybench`, `benchmark.js`, or `node:perf_hooks` for micro-benchmarks
- Chrome DevTools, Node inspector, `0x`, or Clinic.js for CPU and allocation profiling
- production counters and histograms for tail-latency analysis

## Modern TypeScript Guidelines

### Prefer discriminated unions for closed domains.

Use discriminated unions for:

- command hierarchies;
- error types;
- protocol messages;
- parsed forms;
- state machines.

This makes `switch` handling exhaustive and forces the code to stay in sync with the domain.

### Prefer readonly values and value-oriented programming.

Prefer plain objects, tuples, and arrays wrapped in `readonly` APIs for domain data. Mutate only where mutation is part of the design and the invariants are obvious.

Favor pure functions and small deterministic transforms. Keep side effects at the edges.

### Prefer local reasoning.

Construct values close to where they are used. Avoid mutable state that survives across distant branches. Avoid temporal coupling.

### Prefer explicit ownership.

If state is shared, say so clearly. If it is confined to one module, worker, queue, or lifecycle scope, preserve that structure.

### Prefer total handling.

Every `switch` on a discriminated union or enum should feel like a proof that every case is handled.

Use `assertNever(...)` to make missed cases a compiler error.

### Prefer explicit imports and visible module dependencies.

Import the exact symbols a file depends on. Avoid barrels that hide real coupling in critical code.

Use named exports in all code. File scope is the namespace.

### Prefer TypeScript naming conventions.

Use naming that matches TypeScript's ecosystem and tooling expectations:

- use `UpperCamelCase` for types, interfaces, classes, enums, and React components;
- use `lowerCamelCase` for variables, functions, methods, parameters, and properties;
- use `CONSTANT_CASE` sparingly for true constants with process-wide or module-wide stability;
- avoid `_` prefixes and suffixes as visibility markers;
- do not encode type information into names when the type system already carries it.

Add units and qualifiers only when they clarify semantics, such as `timeoutMs`, `sizeBytes`, or `retryBudget`.

### Types and interfaces isolate implementation decisions.

Isolate the details of using specific libraries, frameworks, transports, or I/O interfaces behind interfaces, types, and adapters, such that the implementation decision can change without changing the integrated code.

These interfaces and adapters will later be used during testing to model failures, control time, and inject alternate implementations.

### Documentation

Documentation is part of the safety case. It must make the intended semantics, constraints, and trust boundaries explicit enough for reviewers, maintainers, test authors, and verification tools to work from the same mental model.

#### TSDoc requirements

All functions, methods classes, interfaces, and types must have TSDoc.

For functions and methods, TSDoc must document:

- preconditions;
- postconditions;
- preserved invariants;
- all expected failure forms;
- all exceptions that may be thrown;
- all safety requirements;
- any concurrency, ownership, ordering, or mutability assumptions;
- any bounds, units, or performance-sensitive behavior that callers must respect.

Use standard TSDoc tags where appropriate:

- `@param` for argument meaning and required properties
- `@returns` for semantic meaning of the result
- `@throws` for thrown exceptional failures
- `@remarks` for important maintainers' constraints
- `@example` for correct usage

If a function returns `Result<T, E>`, document the meaning of both success and error cases, including what invariants hold in each branch.

#### Examples

Include examples in:

- all module-level docs for non-trivial modules;
- all exported APIs;
- any function whose behavior is subtle, stateful, capability-gated, performance-sensitive, or easy to misuse.

Examples should demonstrate correct usage, not merely compile.

#### Line comments

Use line comments to explain why the code is written the way it is, not to restate what the syntax already says.

Good line comments explain:

- why an invariant matters;
- why a bound exists;
- why a data layout was chosen;
- why a synchronization or ownership choice is safe;
- why a failure mode is handled in a particular way;
- why an optimization is correct and necessary.

#### Literate style for complex algorithms

For complex algorithms, parsers, protocol handlers, state transitions, async coordination logic, and performance-critical code, use line comments in a literate-programming style. Walk through the logic in prose.

That means the code should read as a narrative:

1. state the goal of the step;
2. explain the invariant being established or preserved;
3. perform the step;
4. explain why the next step is safe.

The comment stream should help a careful reader follow the algorithm without reverse-engineering its intent from raw control flow.

#### Documentation rules

- Documentation must describe semantics, not merely surface syntax.
- Documentation must stay consistent with code, tests, and assertions.
- If a safety property matters, document it in both prose and executable form where possible.
- If a function has important preconditions or postconditions, prefer expressing them in both TSDoc and executable assertions.
- If a comment becomes stale, fix or remove it immediately.
- Public APIs without adequate TSDoc are incomplete.

Reason: documentation preserves the mental model required for safe evolution. In a correctness-oriented codebase, TSDoc, examples, and literate comments are not decoration; they are part of the executable engineering record.

## Result and Error Policy

Use this table:

| Situation | Preferred form |
|---|---|
| Validation failure | `Result<T, ValidationError>` |
| Parse failure | `Result<T, ParseError>` |
| Domain rule rejection | `Result<T, DomainError>` |
| Expected missing value | `T | undefined` or `Result<T, E>` |
| Broken invariant | assertion or thrown `Error` |
| Impossible state | thrown `Error` |
| Unexpected I/O failure at boundary | thrown `Error` near the boundary, or mapped `Result` at the boundary |

Rules:

- Do not throw to signal routine domain outcomes.
- Do not return `null` or `undefined` for failure when the failure deserves explanation.
- Do not use exceptions as hidden gotos.
- If a layer converts exceptions into `Result`, do it near the boundary and map them into domain errors.
- Catch values as `unknown` and normalize them immediately.
- Keep `try` blocks narrow so the failing operation is obvious.
- Empty `catch` blocks are forbidden unless the reason is documented and tested.

## Branded Types and Capability Policy

Use branded, opaque, or phantom-tagged types when you need a lightweight logical type without changing the runtime representation.

Examples:

- authenticated vs unauthenticated session;
- validated vs unvalidated input;
- normalized vs raw data;
- readable path vs writable path;
- admin-authorized vs ordinary user;
- typed identifiers over primitive values.

Rules:

- Prefer a brand over a comment.
- Prefer a capability token when trust must survive a boundary.
- Keep authority-minting functions local to the module that owns the trust boundary.
- Convert from untrusted input to branded internal types only after validation.
- Use runtime witnesses only when a compile-time brand is not enough to protect the boundary.

Minimal example:

```ts
type UserId = string & { readonly __brand: 'UserId' };

function parseUserId(raw: string): Result<UserId, 'invalid_user_id'> {
  if (raw.length === 0) {
    return { ok: false, error: 'invalid_user_id' };
  }

  return { ok: true, value: raw as UserId };
}
```

The unsafe cast is acceptable here only because it is hidden behind validation and never exposed as a casual pattern.

## Review Checklist

- Are the invariants stated clearly?
- Is the subsystem deterministic where possible and ideally modeled as a clear state machine?
- Are illegal states and illegal transitions hard to represent?
- Is control flow simple, explicit, and bounded?
- Are all expected failures returned as `Result`-style data?
- Are exceptions reserved for exceptional conditions?
- Are `unknown` values validated at boundaries before use?
- Are `as` assertions and non-null assertions rare, justified, and localized?
- Are preconditions, postconditions, invariants, and exhaustiveness asserted?
- Is TSDoc present and complete for functions and methods, including failures, safety requirements, and semantic constraints?
- Do line comments explain why the code is written this way, especially in subtle or performance-critical sections?
- Is arithmetic checked where precision, overflow, rounding, or off-by-one errors matter?
- Are bounds explicit everywhere?
- Is core logic isolated from direct I/O, time, randomness, and external effects?
- Can the code be simulated, replayed, differentially tested, or fault-injected?
- Are histories tested, not just individual function calls?
- Is async behavior explicit, bounded, and documented in terms of ownership, cancellation, and ordering?
- If state is shared, are the synchronization discipline and invariants obvious?
- Is the hot path low-allocation where performance matters?
- Are unnecessary copies avoided, and are object shapes and data layouts stable?
- Are named exports, visible imports, and type-only imports used consistently?
- Are all compiler and linter checks clean?
- Would this design and its implementation still be easy to evolve in a year?
