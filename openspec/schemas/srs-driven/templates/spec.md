<!-- EARS Pattern Reference:
     Ubiquitous:        THE <system> SHALL <response>.
     State-driven:      WHILE <precondition>, THE <system> SHALL <response>.
     Event-driven:      WHEN <trigger>, THE <system> SHALL <response>.
     Unwanted-behavior: IF <trigger>, THEN THE <system> SHALL <response>.
     Complex:           WHILE <precondition>, WHEN <trigger>, THE <system> SHALL <response>.
     Optional:          WHERE <feature is included>, THE <system> SHALL <response>.

     RFC 2119: SHALL/MUST = absolute requirement, SHOULD = recommended, MAY = optional.

     Escape hatch: When a requirement has >3 preconditions or is mathematical/tabular,
     it MAY use decision tables, lists, or other formats. Include a justification for
     why EARS is insufficient. -->

## ADDED Requirements

### Requirement: <!-- name --> [<!-- DOMAIN-REQ-ID -->]
<!-- Select EARS pattern: Ubiquitous | State-driven | Event-driven | Unwanted-behavior | Complex | Optional -->
<!-- EARS requirement statement using RFC 2119 keywords -->

**References:**
- <!-- File and section where this requirement, precondition, postcondition, or invariant is detailed -->

#### Scenario: <!-- name --> [<!-- DOMAIN-SCENARIO-ID -->]
<!-- EARS statement for this scenario -->

**Postcondition:** <!-- what must be true after this scenario occurs -->

#### Scenario: <!-- failure case name --> [<!-- DOMAIN-FAIL-ID -->]
<!-- Use Unwanted-behavior pattern for failure scenarios -->
IF <!-- undesired trigger or error condition -->, THEN THE <!-- system --> SHALL <!-- recovery/mitigation response -->.

**Postcondition:** <!-- what must be true after this failure scenario -->

## MODIFIED Requirements
<!-- Same structure as ADDED. Full requirement must be reproduced. -->

## REMOVED Requirements

### Requirement: <!-- name -->
**Reason:** <!-- why this requirement is being removed -->
**Migration:** <!-- how consumers should adapt -->

## RENAMED Requirements
<!-- - FROM: `### Requirement: <old-name>`
     - TO: `### Requirement: <new-name>` -->
