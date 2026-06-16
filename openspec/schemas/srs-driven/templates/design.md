## Context

### Current State
<!-- Background and current state of the system -->

### Constraints and Architecture Drivers
<!-- Technical constraints, quality attribute drivers, and forces shaping the design -->

## Goals

<!-- What this design aims to achieve -->

### Non-Goals
<!-- What is explicitly out of scope for this design -->

<!-- ============================================================
     Choose ONE of the following two sections and DELETE the other:
     - "Proposed Design" for a single coherent design
     - "Architecture Decisions" for multiple independent decisions
     ============================================================ -->

## Proposed Design

### System Model
<!-- High-level architecture: components, boundaries, data flow. Use a mermaid diagram where appropriate -->

### Component Descriptions
<!-- Purpose and responsibility of each component -->

### System Invariant Tactics
<!-- **How** system invariants from the proposal are maintained. Be specific and detail oriented. -->

### Quality Attribute Tactics
<!-- Architectural tactics for achieving quality attribute targets; **How** targets are ensured. -->

### Interaction Protocols
<!-- How components communicate: APIs, events, protocols. What rules and invariants must hold for communication to work correctly? -->

### Forward Evolution
<!-- How this design accommodates future changes and extensions -->

### Costs
<!-- Resource, infrastructure, or operational cost implications -->

### Alternatives Considered
<!-- Other approaches evaluated and why they were rejected -->

## Architecture Decisions

<!-- Use this section instead of Proposed Design when the change involves
     multiple independent decisions. This is most common with an update to an existing spec or "delta spec".
     Repeat the block below for each decision. -->

### Decision: <!-- title -->

- **Context and Objective:** <!-- What situation drives this decision? -->
- **Quality Attribute Tactics and Key Results:** <!-- Which quality attributes does this address? How does it address them? -->
- **Options Considered:**
  <!-- - Option A: description, pros, cons -->
  <!-- - Option B: description, pros, cons -->
- **Decision:** <!-- Which option was chosen and why -->
- **Consequences:** <!-- What follows from this decision — positive and negative -->

## Component Design

### Key Components
<!-- Detailed design of significant logical components -->

### Data Design
<!-- Data models, storage, schemas, encoding formats, data validation rules, migrations -->

### Interface Contracts
<!-- API contracts, message formats, protocol details -->

### Code Map
<!-- Provide an overview where key logic lives or will live in the codebase: file paths, modules, layers -->

## Failure and Reliability

### Failure Mode Analysis
<!-- Systematically consider:
     - Unsafe inputs: What invalid or malicious inputs could cause harm?
     - Fragile formats: How is data encoded and what happens if an invalid byte is found?
     - Inadequate control actions: What control actions could fail or be insufficient?
     - Process model flaws: Where could the system's internal model diverge from reality?
     - Coordination failures: Where could timing, ordering, or concurrency cause issues? -->

### Control and Recovery
<!-- How the system detects failures, mitigates impact, and recovers.
     Include circuit breakers, retries, fallbacks, alerting, supervisors. -->

## Operational Concerns

### Observability
<!-- Logging, metrics, tracing, dashboards, alerting -->

### Deployment and Rollout
<!-- Deployment strategy, feature flags, canary/blue-green, rollback plan -->

### Capacity and Scaling
<!-- Expected load, scaling strategy, resource planning -->

## Security

<!-- Authentication, authorization, data protection, threat model considerations -->

## Risks / Trade-offs

<!-- Known limitations and trade-offs.
     Format: [Risk] -> Mitigation -->

## Migration Plan

<!-- Steps to deploy the change. Rollback strategy. Data migration if applicable. -->

## Verification Strategy

<!-- How to verify the design meets spec requirements.
     Testing approach, integration tests, load tests, property-based tests, etc. -->

## Open Questions

<!-- Outstanding decisions or unknowns to resolve before or during implementation -->
