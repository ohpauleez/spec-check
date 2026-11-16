## Purpose

Small fixed corpus for measuring real model formalization and solver analysis.
It intentionally contains two incompatible responses under the same request.

### Requirement: Accept submitted request [EVAL-ACCEPT]
WHEN a request is submitted, THE service SHALL accept the request.

**References:**
- smt_ideas_final_plan.md#8-correct-static-analyses

#### Scenario: Submitted request accepted [EVAL-ACCEPT-CASE]
WHEN a request is submitted, THE service SHALL accept the request.

### Requirement: Reject submitted request [EVAL-REJECT]
WHEN a request is submitted, THE service SHALL NOT accept the request.

**References:**
- smt_ideas_final_plan.md#8-correct-static-analyses

#### Scenario: Submitted request not accepted [EVAL-REJECT-CASE]
WHEN a request is submitted, THE service SHALL NOT accept the request.
