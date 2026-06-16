# Spec Traceability

`spec-traceability` connects canonical OpenSpec identifiers to TypeScript and Vitest tests.

## Canonical spec files

- Canonical identifiers are discovered only from `openspec/specs/**/spec.md` and active change specs under `openspec/changes/**/spec.md`.
- Archived change specs under `openspec/changes/archive/**` are excluded.
- Identifiers must appear in square brackets in markdown, for example `[BOX-NULL-REJECT]`.
- Identifiers should be placed on `Scenario` or `Requirement` headers.
- The extracted identifier excludes the brackets and must match `[A-Z][A-Z0-9]*(-[A-Z0-9]+)+` and should be less than 30 characters.
- Bare uppercase kebab tokens without brackets are ignored.
- Bracketed tokens inside inline code spans or fenced code blocks are ignored.
- Diagnostics keep the defining file, line number, and nearest `Requirement` or `Scenario` heading when available.

### Identifier style

Identifiers should be semantic, not implementation-specific.

- Good: `BOX-NULL-REJECT`
- Worse: `BOX-USE-OBJECTS-REQUIRE-NON-NULL`

Identifiers work best when each one names a single observable behavior or obligation.

Prefer identifiers that are:
- behavior-oriented
- stable even if implementation details change
- small enough to map naturally to one or a few traced tests

Avoid identifiers that:
- encode implementation choices
- bundle many unrelated behaviors together
- describe internal refactorings rather than externally visible guarantees

For best results with agent-assisted development, write `Requirement` and `Scenario` text so each tagged header clearly states:
- the condition or input
- the expected outcome
- any important edge case or failure mode

## Declaring traced tests

Declare each traced test explicitly by calling `traceSpec(...)` from `test/support/spec-trace.ts` inside the currently executing Vitest test body.

```ts
import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";

describe("parseAlias", () => {
  it("rejects duplicate aliases", () => {
    traceSpec("BOX-ALIAS-FAIL");

    expect(true).toBe(true);
  });

  it.each(["DIST-VERSION-PARITY", "DIST-HELP-PARITY"])(
    "supports traced parameterized tests for %s",
    (identifier) => {
      traceSpec(identifier);
      expect(identifier.startsWith("DIST-")).toBe(true);
    },
  );
});
```

- `traceSpec()` with no identifiers is an error.
- Malformed identifiers in `traceSpec(...)` fail with a format error.
- Unknown identifiers fail only the declaring test.
- Repeated identifiers inside one test are de-duplicated for accounting.
- Tests without `traceSpec(...)` are unaffected.
- The helper works in ordinary, async, and `it.each(...)` Vitest tests.

## Coverage behavior

- Reference validation for traced tests always runs.
- Coverage enforcement runs only when `DEVBOX_TRACE_COVERAGE=1` or `DEVBOX_TRACE_COVERAGE=true`.
- `npm run test:trace` enables coverage mode and runs the full Vitest suite.
- `npm test` leaves coverage disabled for lightweight local runs.
- When coverage is enabled, every canonical identifier must be declared by at least one traced test in the run.
- An empty catalog trivially passes coverage.
- Coverage mode is intended for full-suite verification, not filtered subset runs.

## Diagnostics

Diagnostics include provenance for canonical definitions when available:

- defining file
- defining line number
- nearest `Requirement` or `Scenario` heading

Cross-file duplicate identifiers fail catalog building before traced tests run. Repeated identifiers within a single spec file are allowed and keep the first occurrence for provenance.

## Review-only requirements

If a requirement is verified by reasoning rather than executable assertions, use a traced passing test with a short comment that explains the review-only reasoning.
Ensure the `name` of the test starts with `REVIEW: `.
```ts
it("REVIEW: keeps strict mode enabled", () => {
  traceSpec("TRACE-REVIEW-PASS");

  // Review-only requirement: the important assurance comes from keeping this
  // repository-wide configuration visible and checked in one place.
  expect(compilerOptions.strict).toBe(true);
});
```

## Recommended workflow

For new work, add canonical identifiers to important `Requirement` and `Scenario` headers before implementation begins.

Use identifiers to keep the spec authoritative and to give implementation, tests, and review a shared reference point.

By convention, keep `traceSpec(...)` calls close to the assertion or property that actually exercises the requirement.

A final review pass should still confirm that:
- identifier granularity is appropriate
- split identifiers when one tag covers too much behavior
- merge identifiers when multiple tags describe the same obligation
- traced tests match the intended requirements
- some requirements are marked as review-only when executable assertions are not the right verification mechanism

For existing or legacy specs, adding identifiers during review is a reasonable retrofit step. For new changes, prefer tagging the spec early.
