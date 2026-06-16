## Motivation

<!-- What problem does this solve? What is the business or technical need? Why now? -->

## Scope

### In Scope
<!-- What's changing? Detail the concrete boundaries of this change -->

### Out of Scope
<!-- What is explicitly excluded -->

## Context

### Background
<!-- Relevant history, prior decisions, current state -->

### Affected Systems and Stakeholders
<!-- Systems, teams, and users impacted by this change -->

### Assumptions and Dependencies
<!-- What must be true for this change to succeed? External dependencies? -->

### Constraints
<!-- Technical, organizational, regulatory, or timeline constraints -->

### References
<!-- Links to related documents, RFCs, prior art, external standards -->

## Domain Model

<!-- Implementation-neutral description of the data domain.
     Define entities and relationships.
     No database schemas, class diagrams, or implementation types.
     This is a conceptual model of the problem domain. -->

## Preconditions, Postconditions, and Invariants

<!-- Preconditions: What must be true before this change can take effect?
     Postconditions: What must be true after this change is complete?
     Invariants: What must remain true at all times during and after this change?
     Collectively, what must be true for this system to be correct? -->

## Failure Modes

<!-- Document failure modes that shape the product experience or core functionality.
     Each failure mode must include a rationale explaining why it matters.
     Focus on product-level failures, not implementation-level errors.

     Format:
     - **<Failure mode name>**: <Description>
       - **Rationale**: <Why this matters to the product> -->

## Quality Attributes

<!-- Important quality attributes with targets/thresholds and their influence.

     Format:
     - **<Attribute>** (e.g., Performance, Security, Reliability, Availability, Observability):
       - **Target/Threshold**: <Measurable target>
       - **Influence**: <How this shapes the product> -->

## Capabilities

### New Capabilities
<!-- Capabilities being introduced. Replace <name> with kebab-case identifier.
     Each creates specs/<name>/spec.md -->
- `<name>`: <brief description of what this capability covers>

### Modified Capabilities
<!-- Existing capabilities whose REQUIREMENTS are changing (not just implementation).
     Only list here if spec-level behavior changes. Each needs a delta spec file.
     Use existing spec names from openspec/specs/. Leave empty if no requirement changes. -->
- `<existing-name>`: <what requirement is changing>
