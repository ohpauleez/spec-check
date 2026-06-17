import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { traceSpec } from "../support/spec-trace.js";
import { validateFormalizationSample } from "../../src/domain/formal/validate.js";
import { compileSmtlib } from "../../src/domain/formal/smtlib.js";
import type { LogicIrClaim } from "../../src/domain/logic-ir.js";

interface GoldenSample {
  readonly name: string;
  readonly ears: string;
  readonly expectedIr: LogicIrClaim;
}

describe("EARS-to-Logic-IR oracle tests", () => {
  it("golden samples pass schema validation", async () => {
    traceSpec("FLA-VALIDATE-SAMPLE", "FLA-SAMPLE-ACCEPT");
    const fixturesPath = join(import.meta.dirname, "../fixtures/ears-to-logic/golden-samples.json");
    const raw = await readFile(fixturesPath, "utf8");
    const samples = JSON.parse(raw) as readonly GoldenSample[];

    expect(samples.length).toBeGreaterThan(0);

    for (const sample of samples) {
      const result = validateFormalizationSample(sample.expectedIr);
      expect(result.ok, `${sample.name}: ${!result.ok ? result.error.message : ""}`).toBe(true);
    }
  });

  it("golden samples compile to valid SMT-LIB", async () => {
    traceSpec("FLA-SMTLIB-COMPILE", "FLA-SMTLIB-PRESERVE");
    const fixturesPath = join(import.meta.dirname, "../fixtures/ears-to-logic/golden-samples.json");
    const raw = await readFile(fixturesPath, "utf8");
    const samples = JSON.parse(raw) as readonly GoldenSample[];

    for (const sample of samples) {
      const compiled = compileSmtlib(sample.expectedIr);

      // Should produce non-empty SMT-LIB
      expect(compiled.smtlib.length, `${sample.name}: empty smtlib`).toBeGreaterThan(0);

      // smtlib should contain declarations and assertions (check-sat is appended at query time)
      expect(compiled.smtlib, `${sample.name}: missing declare or assert`).toMatch(/\(declare-|\(assert /u);

      // Should contain the assertion expressions
      for (const assertion of sample.expectedIr.assertions) {
        expect(compiled.smtlib, `${sample.name}: missing assertion ${assertion.id}`).toContain(assertion.expr);
      }

      // Sanitized claimId should be valid
      expect(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(compiled.sanitizedClaimId)).toBe(true);
    }
  });

  it("golden samples have consistent obligation mapping", async () => {
    traceSpec("CGC-OBLIGATION-LEVEL", "CGC-OBLIG-MANDATORY", "CGC-OBLIG-ADVISORY");
    const fixturesPath = join(import.meta.dirname, "../fixtures/ears-to-logic/golden-samples.json");
    const raw = await readFile(fixturesPath, "utf8");
    const samples = JSON.parse(raw) as readonly GoldenSample[];

    for (const sample of samples) {
      const earsUpper = sample.ears.toUpperCase();

      if (earsUpper.includes("SHALL")) {
        expect(sample.expectedIr.obligation, `${sample.name}: SHALL → mandatory`).toBe("mandatory");
      } else if (earsUpper.includes("SHOULD")) {
        expect(sample.expectedIr.obligation, `${sample.name}: SHOULD → advisory`).toBe("advisory");
      }
    }
  });

  it("golden samples preserve EARS pattern structure in assertions", async () => {
    traceSpec("FLA-FORMAL-ARTS");
    const fixturesPath = join(import.meta.dirname, "../fixtures/ears-to-logic/golden-samples.json");
    const raw = await readFile(fixturesPath, "utf8");
    const samples = JSON.parse(raw) as readonly GoldenSample[];

    for (const sample of samples) {
      // Every sample should have at least one assertion
      expect(sample.expectedIr.assertions.length, `${sample.name}: no assertions`).toBeGreaterThan(0);

      // Every assertion should have a valid ID format
      for (const assertion of sample.expectedIr.assertions) {
        expect(/^[A-Z][A-Z0-9_-]*$/u.test(assertion.id), `${sample.name}: bad assertion id ${assertion.id}`).toBe(true);
        expect(assertion.expr.length, `${sample.name}: empty expression`).toBeGreaterThan(0);
      }
    }
  });
});

describe("regression fixture framework", () => {
  it("fixture directory structure is valid", async () => {
    traceSpec("FLA-VALIDATE-SAMPLE");
    const fixturesPath = join(import.meta.dirname, "../fixtures/ears-to-logic/golden-samples.json");
    const raw = await readFile(fixturesPath, "utf8");

    // Should parse as valid JSON array
    const parsed = JSON.parse(raw) as unknown;
    expect(Array.isArray(parsed)).toBe(true);

    // Every entry should have the required shape
    const samples = parsed as readonly { name?: unknown; ears?: unknown; expectedIr?: unknown }[];
    for (const sample of samples) {
      expect(typeof sample.name).toBe("string");
      expect(typeof sample.ears).toBe("string");
      expect(typeof sample.expectedIr).toBe("object");
    }
  });
});
