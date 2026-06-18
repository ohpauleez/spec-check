/**
 * Qualitative properties mode overlay instructions.
 *
 * @remarks
 * Adds lightweight formal methods structural review criteria to the shared
 * qualitative base. Derived from the LFM guide (`docs/lfm.md`) and the
 * spec-check concept document (`pasture/concept.md`).
 *
 * This overlay is applied when the qualitative mode is `"qualitative_properties"`.
 */

/**
 * Mode-specific instructions for the qualitative_properties pass.
 *
 * Covers: preconditions/postconditions/invariants completeness, safety and
 * liveness properties, state machines, failure mode analysis, assumptions,
 * and quality attribute measurability.
 */
export const QUALITATIVE_PROPERTIES_INSTRUCTIONS = `\
## Focus: Structural property completeness

This review pass focuses on whether the specification artifacts capture all \
the structural properties needed for a dependable system. Apply these checks \
across the proposal, design, and spec artifacts together.

### Preconditions, postconditions, and invariants

- Verify that all preconditions are documented: what must be true before each \
operation, phase, or interaction begins.
- Verify that all postconditions are documented: what is guaranteed to be true \
after each operation, phase, or interaction completes.
- Verify that all invariants are documented: what must remain true throughout \
the system's operation, across phases, and across state transitions.
- Flag any operation, phase, or module boundary that lacks explicit \
preconditions or postconditions.

### Safety and liveness properties

- Verify that safety properties are stated: what must never happen. These \
describe bad states or behaviors the system must avoid (e.g., "findings are \
never silently removed", "source files are never mutated").
- Verify that liveness properties are stated: what must eventually happen. \
These describe progress guarantees (e.g., "every analysis run eventually \
produces a manifest or a fatal error").
- These properties must be exercisable within the validation and verification \
plan. Flag safety or liveness claims that have no corresponding test, \
assertion, or verification strategy.

### State machines and interaction protocols

- Verify that all significant state machines are documented with their states, \
legal transitions, and terminal states.
- Verify that interaction protocols between components are explicit: what each \
side sends, expects, and how failures are handled at each boundary.
- Flag implicit state or undocumented transitions that could lead to \
unspecified behavior.

### Failure modes

- Verify that failure modes are enumerated for each subsystem and external \
boundary.
- Each failure mode should state what can go wrong, why it matters (rationale), \
and how the system responds.
- Flag failure modes that lack a stated response or recovery strategy.
- Distinguish between acceptable failures (degraded but safe) and intolerable \
failures (must be prevented or detected immediately).

### Assumptions and dependencies

- Verify that assumptions about users, infrastructure, time, randomness, and \
the operating environment are stated explicitly.
- Flag any assumption that is implied but not documented (e.g., assuming \
network availability, clock synchronization, file system behavior, or \
operator competence).
- Verify that external dependencies are identified and that failure of each \
dependency is addressed in the failure mode analysis.

### Quality attributes

- Verify that quality attributes (reliability, observability, security, \
performance, determinism, maintainability, etc.) have measurable targets or \
thresholds.
- Verify that each quality attribute states its influence on the design: how \
does this attribute shape architectural or implementation decisions?
- Flag quality attributes that are aspirational but lack concrete criteria for \
verification.

### Validation and verification

- Verify that the specification includes a verification strategy or describes \
how each critical property will be checked (tests, proofs, analysis, review, \
or monitoring).
- Flag critical claims that have no stated verification approach.`;
