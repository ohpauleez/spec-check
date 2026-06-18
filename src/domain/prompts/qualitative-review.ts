/**
 * Qualitative review mode overlay instructions.
 *
 * @remarks
 * Adds EARS quality criteria and requirement-level analysis guidance to the
 * shared qualitative base. Derived from the spec-check concept document
 * (`pasture/concept.md`) and the AWS Requirements Analysis approach.
 *
 * This overlay is applied when the qualitative mode is `"qualitative_review"`.
 */

/**
 * Mode-specific instructions for the qualitative_review pass.
 *
 * Covers: EARS format verification, requirement quality criteria (testable,
 * solution-free, unambiguous, consistent, complete), and pattern-level checks.
 */
export const QUALITATIVE_REVIEW_INSTRUCTIONS = `\
## Focus: Requirement and scenario quality

This review pass focuses on the quality of individual requirements and \
scenarios. Apply the following criteria to every Requirement and Scenario \
section in spec.md files.

### EARS format compliance

All requirements and scenarios should use the EARS (Easy Approach to \
Requirements Syntax) format with RFC 2119 keywords (SHALL, SHOULD, MAY). \
Check that each requirement uses one of these recognized patterns correctly:

| Pattern           | Template                                               |
|-------------------|--------------------------------------------------------|
| Ubiquitous        | THE <system> SHALL <response>.                         |
| Event-driven      | WHEN <trigger>, THE <system> SHALL <response>.         |
| State-driven      | WHILE <precondition>, THE <system> SHALL <response>.   |
| Unwanted-behavior | IF <trigger>, THEN THE <system> SHALL <response>.      |
| Conditional       | IF <condition>, THEN THE <system> SHALL <response>.    |

The unwanted-behavior pattern is distinguished from the conditional pattern by \
the presence of error/failure/negative indicators in the IF-clause (e.g., \
FAIL, ERROR, INVALID, DENIED, TIMEOUT, etc.).

Flag requirements that do not follow any EARS pattern unless they include an \
explicit justification for why EARS is insufficient (escape hatch).

### Requirement quality criteria

Evaluate every requirement and scenario against these five properties:

1. **Testable**: A good requirement describes observable conditions on \
observable quantities. You should be able to name the inputs, the outputs, and \
the conditions under which the system response is as required. \
Example failure: "The system shall authenticate users" (no observable output named). \
Example pass: "When a user submits credentials that match a valid account, \
the system shall return an authenticated session token" (inputs, outputs, and \
conditions are explicit).

2. **Solution-free**: A good requirement describes what the system does, not \
how it does it (excluding tight constraints on input/output). \
Example failure: "The system shall implement soft deletion to retain records \
in the database for audit" (prescribes mechanism). \
Example pass: "When a record is marked as deleted, the system shall exclude \
it from user-facing views while retaining it for administrative access" \
(describes observable behavior).

3. **Unambiguous**: Two independent readers would formalize an unambiguous \
requirement in the same way. \
Example failure: "The system shall remove the record" (hard delete or soft \
delete?). \
Example pass: "The system shall mark the record as deleted such that it is \
no longer visible in any user-facing view" (pins down the observable outcome).

4. **Consistent**: Taken together, the requirements must admit at least one \
implementation. There must be no situation where two acceptance criteria \
require incompatible behaviors from the system.

5. **Complete**: System behavior must be specified under any input combination. \
There must be no state where the requirements do not prescribe what the system \
should do. Flag missing error handling, unspecified edge cases, and behavioral \
gaps.

### Additional checks

- Verify that requirement references point to upstream sections that actually \
support the cited behavior.
- Check that scenario postconditions are concrete and verifiable.
- Flag requirements that use vague qualifiers ("quickly", "efficiently", \
"appropriately", "gracefully") without measurable criteria.`;
