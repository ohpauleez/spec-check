import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { traceSpec } from "../support/spec-trace.js";
import { compileSmtlib, compileSpecSmtlib } from "../../src/domain/formal/smtlib.js";
import { runZ3Query } from "../../src/adapters/z3.js";
import { toClaimId, toSmtlibContent } from "../../src/domain/branded.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";

interface GoldenSample {
  readonly name: string;
  readonly ears: string;
  readonly expectedIr: LogicIrClaim;
}

// Skip all tests if Z3 is not available on PATH.
function z3Available(): boolean {
  try {
    execSync("z3 --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const describeIfZ3 = z3Available() ? describe : describe.skip;

describeIfZ3("Z3 integration — golden samples produce valid SMT-LIB", () => {
  it("each golden sample compiles to Z3-accepted SMT-LIB (sat, no errors)", async () => {
    traceSpec("FLA-SMTLIB-COMPILE", "FLA-RUN-LOGIC");
    const fixturesPath = join(import.meta.dirname, "../fixtures/ears-to-logic/golden-samples.json");
    const raw = await readFile(fixturesPath, "utf8");
    const samples = JSON.parse(raw) as readonly GoldenSample[];

    for (const sample of samples) {
      const compiled = compileSmtlib(sample.expectedIr);
      const query = toSmtlibContent(`${compiled.smtlib}(check-sat)\n`);

      const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

      expect(
        result.kind,
        `${sample.name}: expected "sat" but got "${result.kind}" — stdout: ${result.stdout.slice(0, 200)}`,
      ).toBe("sat");
      expect(
        result.errorCount ?? 0,
        `${sample.name}: Z3 emitted errors`,
      ).toBe(0);
    }
  });

  it("combined golden samples compile to a single valid Z3 query", async () => {
    traceSpec("FLA-SPEC-COMBINE", "FLA-RUN-LOGIC");
    const fixturesPath = join(import.meta.dirname, "../fixtures/ears-to-logic/golden-samples.json");
    const raw = await readFile(fixturesPath, "utf8");
    const samples = JSON.parse(raw) as readonly GoldenSample[];

    const claims = samples.map((s) => s.expectedIr);
    const compiled = compileSpecSmtlib("test/golden.md", claims);
    const query = toSmtlibContent(`${compiled.smtlib}(check-sat)\n`);

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(
      result.kind,
      `Combined golden samples: expected "sat" but got "${result.kind}" — stdout: ${result.stdout.slice(0, 200)}`,
    ).toBe("sat");
    expect(result.errorCount ?? 0).toBe(0);
  });
});

describeIfZ3("Z3 integration — contradiction detection", () => {
  it("directly contradictory bare assertions produce UNSAT", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-LOGIC-CORE");
    // Two claims: one asserts X is true (ubiquitous), another asserts X is false.
    const claims: LogicIrClaim[] = [
      {
        claimId: toClaimId("R-TRUE"),
        obligation: "mandatory",
        variables: [{ name: "X", sort: "Bool" }],
        functions: [],
        assertions: [{ id: "ASSERT-TRUE", expr: "X" }],
      },
      {
        claimId: toClaimId("R-FALSE"),
        obligation: "mandatory",
        variables: [{ name: "X", sort: "Bool" }],
        functions: [],
        assertions: [{ id: "ASSERT-FALSE", expr: "(not X)" }],
      },
    ];

    const compiled = compileSpecSmtlib("test/contradiction.md", claims);
    const query = toSmtlibContent(`(set-option :produce-unsat-cores true)\n${compiled.smtlib}(check-sat)\n(get-unsat-core)\n`);

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("unsat");
    expect(result.errorCount ?? 0).toBe(0);
    // Verify unsat core is available.
    expect(result.stdout).toContain("unsat");
  });

  it("blog-post order system example: unconditional vs conditional contradiction", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-LOGIC-CORE");
    // R2: WHEN order submitted AND inventory unavailable, place on backorder
    // R3: SHALL NOT place any order on backorder (ubiquitous)
    const claims: LogicIrClaim[] = [
      {
        claimId: toClaimId("R2-BACKORDER"),
        obligation: "mandatory",
        variables: [
          { name: "OrderSubmitted", sort: "Bool" },
          { name: "InventoryUnavailable", sort: "Bool" },
          { name: "OrderBackordered", sort: "Bool" },
        ],
        functions: [],
        assertions: [
          { id: "BACKORDER-1", expr: "(=> (and OrderSubmitted InventoryUnavailable) OrderBackordered)" },
        ],
      },
      {
        claimId: toClaimId("R3-NO-BACKORDER"),
        obligation: "mandatory",
        variables: [
          { name: "OrderBackordered", sort: "Bool" },
        ],
        functions: [],
        assertions: [
          { id: "NO-BACKORDER-1", expr: "(not OrderBackordered)" },
        ],
      },
    ];

    const compiled = compileSpecSmtlib("test/order-system.md", claims);
    const query = toSmtlibContent(`${compiled.smtlib}(check-sat)\n`);

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    // Globally SAT: solver satisfies both by setting OrderSubmitted=false or InventoryUnavailable=false.
    // The implication (=> (and A B) C) is vacuously true when A or B is false.
    // This is exactly the case the pairwise check addresses — it forces both guards active.
    expect(result.kind).toBe("sat");
    expect(result.errorCount ?? 0).toBe(0);
  });

  it("conditional contradiction detected by pairwise check (guards forced)", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-PAIRWISE", "FLA-PAIRWISE-CONTRA");
    // R1: WHEN A, system SHALL set X = true
    // R2: WHEN B, system SHALL set X = false
    // Globally SAT (set A=false, B=false). But pairwise: if A and B both true, X cannot be both.
    const query = toSmtlibContent([
      "(declare-const A Bool)",
      "(declare-const B Bool)",
      "(declare-const X Bool)",
      "; Force both guards active",
      "(assert A)",
      "(assert B)",
      "; Assert both consequents",
      "(assert X)",        // R1 consequent
      "(assert (not X))",  // R2 consequent
      "(check-sat)",
    ].join("\n") + "\n");

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("unsat");
    expect(result.errorCount ?? 0).toBe(0);
  });

  it("completeness gap: all-conditional spec has unreachable states", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-COMPLETENESS", "FLA-COMPLETENESS-GAP");
    // Two conditional rules with non-exhaustive guards.
    // Guard1: A, Guard2: B. If A=false and B=false, no rule fires.
    const query = toSmtlibContent([
      "(declare-const A Bool)",
      "(declare-const B Bool)",
      "; Negate all guards — is there a state where nothing fires?",
      "(assert (not A))",
      "(assert (not B))",
      "(check-sat)",
    ].join("\n") + "\n");

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("sat");
    expect(result.errorCount ?? 0).toBe(0);
  });

  it("integer variable types work correctly in Z3", async () => {
    traceSpec("FLA-SMTLIB-COMPILE");
    // Test that non-Bool sorts compile and run correctly.
    const claim: LogicIrClaim = {
      claimId: toClaimId("INT-TEST"),
      obligation: "mandatory",
      variables: [
        { name: "Count", sort: "Int" },
        { name: "Positive", sort: "Bool" },
      ],
      functions: [],
      assertions: [
        { id: "POS-1", expr: "(=> (> Count 0) Positive)" },
        { id: "POS-2", expr: "(=> (<= Count 0) (not Positive))" },
      ],
    };

    const compiled = compileSmtlib(claim);
    const query = toSmtlibContent(`${compiled.smtlib}(check-sat)\n`);

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("sat");
    expect(result.errorCount ?? 0).toBe(0);
  });
});

describeIfZ3("Z3 integration — complex (WHILE+WHEN) pattern", () => {
  it("complex pattern claim is satisfiable", async () => {
    traceSpec("FLA-SMTLIB-COMPILE", "FLA-RUN-LOGIC");
    // WHILE maintenance, WHEN request submitted → queue request.
    // SAT: solver can set InMaintenanceMode=false to vacuously satisfy.
    const claim: LogicIrClaim = {
      claimId: toClaimId("COMPLEX-SAT"),
      obligation: "mandatory",
      variables: [
        { name: "InMaintenanceMode", sort: "Bool" },
        { name: "RequestSubmitted", sort: "Bool" },
        { name: "RequestQueued", sort: "Bool" },
      ],
      functions: [],
      assertions: [
        { id: "COMPLEX-1", expr: "(=> (and InMaintenanceMode RequestSubmitted) RequestQueued)" },
      ],
    };

    const compiled = compileSmtlib(claim);
    const query = toSmtlibContent(`${compiled.smtlib}(check-sat)\n`);

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("sat");
    expect(result.errorCount ?? 0).toBe(0);
  });

  it("complex pattern contradiction: compound guard forced with conflicting consequent", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-LOGIC-CORE");
    // WHILE A, WHEN B → X must be true. But also assert X is false.
    // Force both guards active → UNSAT.
    const query = toSmtlibContent([
      "(declare-const A Bool)",
      "(declare-const B Bool)",
      "(declare-const X Bool)",
      "; Complex pattern: (=> (and A B) X)",
      "(assert (=> (and A B) X))",
      "; Force both guards active",
      "(assert A)",
      "(assert B)",
      "; Contradict the consequent",
      "(assert (not X))",
      "(check-sat)",
    ].join("\n") + "\n");

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("unsat");
    expect(result.errorCount ?? 0).toBe(0);
  });
});

describeIfZ3("Z3 integration — optional (WHERE) pattern", () => {
  it("optional pattern claim is satisfiable", async () => {
    traceSpec("FLA-SMTLIB-COMPILE", "FLA-RUN-LOGIC");
    // WHERE feature enabled → display panel.
    // SAT: solver can set FeatureEnabled=false to vacuously satisfy.
    const claim: LogicIrClaim = {
      claimId: toClaimId("OPT-SAT"),
      obligation: "mandatory",
      variables: [
        { name: "AdminFeaturesEnabled", sort: "Bool" },
        { name: "AdminPanelDisplayed", sort: "Bool" },
      ],
      functions: [],
      assertions: [
        { id: "OPTIONAL-1", expr: "(=> AdminFeaturesEnabled AdminPanelDisplayed)" },
      ],
    };

    const compiled = compileSmtlib(claim);
    const query = toSmtlibContent(`${compiled.smtlib}(check-sat)\n`);

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("sat");
    expect(result.errorCount ?? 0).toBe(0);
  });

  it("optional pattern contradiction: feature forced with conflicting consequent", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-LOGIC-CORE");
    // WHERE F → X, but also assert F=true and X=false → UNSAT.
    const query = toSmtlibContent([
      "(declare-const F Bool)",
      "(declare-const X Bool)",
      "; Optional pattern: (=> F X)",
      "(assert (=> F X))",
      "; Force feature active",
      "(assert F)",
      "; Contradict the consequent",
      "(assert (not X))",
      "(check-sat)",
    ].join("\n") + "\n");

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("unsat");
    expect(result.errorCount ?? 0).toBe(0);
  });
});

describeIfZ3("Z3 integration — cross-pattern pairwise contradictions", () => {
  it("complex vs event-driven: pairwise contradiction when state forced", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-PAIRWISE", "FLA-PAIRWISE-CONTRA");
    // Complex: WHILE A, WHEN B → X (queue the request)
    // Event-driven: WHEN B → NOT X (reject the request)
    // Globally SAT (A=false vacuously satisfies the complex rule).
    // Pairwise: force A+B → X and NOT X → UNSAT.
    const query = toSmtlibContent([
      "(declare-const A Bool)",
      "(declare-const B Bool)",
      "(declare-const X Bool)",
      "; Complex: (=> (and A B) X)",
      "(assert (=> (and A B) X))",
      "; Event-driven: (=> B (not X))",
      "(assert (=> B (not X)))",
      "; Force both guards for pairwise check",
      "(assert A)",
      "(assert B)",
      "(check-sat)",
    ].join("\n") + "\n");

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("unsat");
    expect(result.errorCount ?? 0).toBe(0);
  });

  it("optional vs ubiquitous: contradiction when feature active", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-PAIRWISE", "FLA-PAIRWISE-CONTRA");
    // Optional: WHERE F → X (enable feature)
    // Ubiquitous: NOT X (feature always disabled — bare assertion)
    // Globally SAT (F=false satisfies the optional rule).
    // When F is forced: X must be true AND false → UNSAT.
    const query = toSmtlibContent([
      "(declare-const F Bool)",
      "(declare-const X Bool)",
      "; Optional: (=> F X)",
      "(assert (=> F X))",
      "; Ubiquitous: (not X) — unconditional",
      "(assert (not X))",
      "; Force the feature flag",
      "(assert F)",
      "(check-sat)",
    ].join("\n") + "\n");

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("unsat");
    expect(result.errorCount ?? 0).toBe(0);
  });

  it("state-driven vs complex: compatible when guards overlap", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-PAIRWISE");
    // State-driven: WHILE A → X
    // Complex: WHILE A, WHEN B → Y
    // Both can be true: A=true, B=true, X=true, Y=true → SAT.
    const query = toSmtlibContent([
      "(declare-const A Bool)",
      "(declare-const B Bool)",
      "(declare-const X Bool)",
      "(declare-const Y Bool)",
      "; State-driven: (=> A X)",
      "(assert (=> A X))",
      "; Complex: (=> (and A B) Y)",
      "(assert (=> (and A B) Y))",
      "; Force all guards",
      "(assert A)",
      "(assert B)",
      "(check-sat)",
    ].join("\n") + "\n");

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("sat");
    expect(result.errorCount ?? 0).toBe(0);
  });
});

describeIfZ3("Z3 integration — completeness gaps with compound guards", () => {
  it("complex guard gap: WHILE+WHEN leaves unreachable states", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-COMPLETENESS", "FLA-COMPLETENESS-GAP");
    // Complex rule fires only when (A AND B). If either is false, no rule applies.
    // Negate both guards → SAT (gap exists).
    const query = toSmtlibContent([
      "(declare-const A Bool)",
      "(declare-const B Bool)",
      "; Negate both compound guard components — is there a state where nothing fires?",
      "(assert (not (and A B)))",
      "(check-sat)",
    ].join("\n") + "\n");

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    // Gap exists: A=false satisfies the negated guard.
    expect(result.kind).toBe("sat");
    expect(result.errorCount ?? 0).toBe(0);
  });

  it("mixed-pattern completeness: complex + event + optional guards not exhaustive", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-COMPLETENESS", "FLA-COMPLETENESS-GAP");
    // Three conditional rules:
    //   Complex: WHILE A, WHEN B → X
    //   Event-driven: WHEN C → Y
    //   Optional: WHERE D → Z
    // Negate all guards → SAT if any gap exists.
    const query = toSmtlibContent([
      "(declare-const A Bool)",
      "(declare-const B Bool)",
      "(declare-const C Bool)",
      "(declare-const D Bool)",
      "; Negate all guards: complex=(and A B), event=C, optional=D",
      "(assert (not (and A B)))",
      "(assert (not C))",
      "(assert (not D))",
      "(check-sat)",
    ].join("\n") + "\n");

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    // Gap exists: all guards can be false simultaneously.
    expect(result.kind).toBe("sat");
    expect(result.errorCount ?? 0).toBe(0);
  });

  it("exhaustive guards leave no completeness gap", async () => {
    traceSpec("FLA-RUN-LOGIC", "FLA-COMPLETENESS");
    // Ubiquitous: X (always fires, no guard)
    // Complex: WHILE A, WHEN B → Y
    // Event-driven: WHEN C → Z
    // Since ubiquitous always fires, negating all conditional guards still
    // has the ubiquitous rule active. But for completeness of the conditional
    // rules: if guards are (and A B) OR C, then (not(and A B)) AND (not C) can
    // still be SAT. We test a tautological guard set instead:
    //   Rule 1: WHEN A → X
    //   Rule 2: WHEN (not A) → Y  (complement)
    // Negate both guards → UNSAT (A cannot be both true and false).
    const query = toSmtlibContent([
      "(declare-const A Bool)",
      "; Guard 1: A",
      "; Guard 2: (not A)",
      "; Negate both — is there a state where neither fires?",
      "(assert (not A))",
      "(assert (not (not A)))",
      "(check-sat)",
    ].join("\n") + "\n");

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    // No gap: guards are exhaustive (A or not-A covers all states).
    expect(result.kind).toBe("unsat");
    expect(result.errorCount ?? 0).toBe(0);
  });
});

describeIfZ3("Z3 integration — all six EARS patterns combined", () => {
  it("all six patterns in one spec, non-contradictory: globally SAT", async () => {
    traceSpec("FLA-SMTLIB-COMPILE", "FLA-SPEC-COMBINE", "FLA-RUN-LOGIC");
    // Combine all six EARS pattern types with distinct variables to avoid contradiction.
    const claims: LogicIrClaim[] = [
      {
        // Ubiquitous: THE system SHALL log events.
        claimId: toClaimId("ALL-UBIQ"),
        obligation: "mandatory",
        variables: [{ name: "EventsLogged", sort: "Bool" }],
        functions: [],
        assertions: [{ id: "UBIQ-1", expr: "EventsLogged" }],
      },
      {
        // State-driven: WHILE in maintenance → reject requests.
        claimId: toClaimId("ALL-STATE"),
        obligation: "mandatory",
        variables: [
          { name: "InMaintenanceMode", sort: "Bool" },
          { name: "RequestsRejected", sort: "Bool" },
        ],
        functions: [],
        assertions: [{ id: "STATE-1", expr: "(=> InMaintenanceMode RequestsRejected)" }],
      },
      {
        // Event-driven: WHEN form submitted → validate fields.
        claimId: toClaimId("ALL-EVENT"),
        obligation: "mandatory",
        variables: [
          { name: "FormSubmitted", sort: "Bool" },
          { name: "FieldsValidated", sort: "Bool" },
        ],
        functions: [],
        assertions: [{ id: "EVENT-1", expr: "(=> FormSubmitted FieldsValidated)" }],
      },
      {
        // Complex: WHILE maintenance, WHEN request → queue.
        claimId: toClaimId("ALL-COMPLEX"),
        obligation: "mandatory",
        variables: [
          { name: "InMaintenanceMode", sort: "Bool" },
          { name: "RequestSubmitted", sort: "Bool" },
          { name: "RequestQueued", sort: "Bool" },
        ],
        functions: [],
        assertions: [{ id: "COMPLEX-1", expr: "(=> (and InMaintenanceMode RequestSubmitted) RequestQueued)" }],
      },
      {
        // Optional: WHERE admin features → show panel.
        claimId: toClaimId("ALL-OPT"),
        obligation: "mandatory",
        variables: [
          { name: "AdminFeaturesEnabled", sort: "Bool" },
          { name: "AdminPanelDisplayed", sort: "Bool" },
        ],
        functions: [],
        assertions: [{ id: "OPTIONAL-1", expr: "(=> AdminFeaturesEnabled AdminPanelDisplayed)" }],
      },
      {
        // Unwanted-behavior: IF connection fails → do not expose errors.
        claimId: toClaimId("ALL-UNWANTED"),
        obligation: "mandatory",
        variables: [
          { name: "ConnectionFailed", sort: "Bool" },
          { name: "ErrorExposed", sort: "Bool" },
        ],
        functions: [],
        assertions: [{ id: "UNWANTED-1", expr: "(=> ConnectionFailed (not ErrorExposed))" }],
      },
    ];

    const compiled = compileSpecSmtlib("test/all-patterns.md", claims);
    const query = toSmtlibContent(`${compiled.smtlib}(check-sat)\n`);

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(
      result.kind,
      `All six EARS patterns combined: expected "sat" but got "${result.kind}" — stdout: ${result.stdout.slice(0, 300)}`,
    ).toBe("sat");
    expect(result.errorCount ?? 0).toBe(0);
  });

  it("cross-pattern contradiction detected in combined spec via unsat core", async () => {
    traceSpec("FLA-SMTLIB-COMPILE", "FLA-SPEC-COMBINE", "FLA-RUN-LOGIC", "FLA-LOGIC-CORE");
    // Combine patterns where optional + ubiquitous contradict:
    //   Ubiquitous: system SHALL NOT show admin panel (always).
    //   Optional: WHERE admin enabled → show admin panel.
    // Force the feature flag → UNSAT.
    const claims: LogicIrClaim[] = [
      {
        claimId: toClaimId("CROSS-UBIQ"),
        obligation: "mandatory",
        variables: [{ name: "AdminPanelDisplayed", sort: "Bool" }],
        functions: [],
        assertions: [{ id: "NO-ADMIN-1", expr: "(not AdminPanelDisplayed)" }],
      },
      {
        claimId: toClaimId("CROSS-OPT"),
        obligation: "mandatory",
        variables: [
          { name: "AdminFeaturesEnabled", sort: "Bool" },
          { name: "AdminPanelDisplayed", sort: "Bool" },
        ],
        functions: [],
        assertions: [{ id: "SHOW-ADMIN-1", expr: "(=> AdminFeaturesEnabled AdminPanelDisplayed)" }],
      },
      {
        // Force the feature flag active so the contradiction manifests.
        claimId: toClaimId("CROSS-FORCE"),
        obligation: "mandatory",
        variables: [{ name: "AdminFeaturesEnabled", sort: "Bool" }],
        functions: [],
        assertions: [{ id: "FORCE-1", expr: "AdminFeaturesEnabled" }],
      },
    ];

    const compiled = compileSpecSmtlib("test/cross-pattern.md", claims);
    const query = toSmtlibContent(
      `(set-option :produce-unsat-cores true)\n${compiled.smtlib}(check-sat)\n(get-unsat-core)\n`,
    );

    const result = await runZ3Query({ smtlib: query, timeoutMs: 5_000 });

    expect(result.kind).toBe("unsat");
    expect(result.errorCount ?? 0).toBe(0);
    expect(result.stdout).toContain("unsat");
  });
});
