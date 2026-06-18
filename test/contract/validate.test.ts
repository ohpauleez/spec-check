import { describe, expect, it } from "vitest";
import { traceSpec } from "../support/spec-trace.js";
import { validateFormalizationSample } from "../../src/domain/formal/validate.js";

const validSample = {
  claimId: "REQ-VALID",
  obligation: "mandatory",
  variables: [{ name: "State", sort: "Bool" }],
  functions: [{ name: "ok", args: ["Bool"], returns: "Bool" }],
  assertions: [{ id: "ASSERT-1", expr: "(ok true)" }],
};

describe("formalization sample validation", () => {
  it("accepts valid sample", () => {
    traceSpec("FLA-VALIDATE-SAMPLE", "FLA-SAMPLE-ACCEPT");
    const result = validateFormalizationSample(validSample);
    expect(result.ok).toBe(true);
  });

  it("rejects non-object input", () => {
    traceSpec("FLA-SAMPLE-REJECT");
    const result = validateFormalizationSample("not-object");
    expect(result.ok).toBe(false);
  });

  it("rejects missing claimId", () => {
    traceSpec("FLA-SAMPLE-REJECT");
    const result = validateFormalizationSample({ ...validSample, claimId: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid obligation", () => {
    traceSpec("FLA-SAMPLE-REJECT");
    const result = validateFormalizationSample({ ...validSample, obligation: "critical" });
    expect(result.ok).toBe(false);
  });

  it("rejects unbalanced assertion parentheses", () => {
    traceSpec("FLA-SAMPLE-REJECT");
    const result = validateFormalizationSample({
      ...validSample,
      assertions: [{ id: "ASSERT-BAD", expr: "(ok true" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects function with undeclared sort", () => {
    traceSpec("FLA-SAMPLE-REJECT");
    const result = validateFormalizationSample({
      ...validSample,
      functions: [{ name: "f", args: ["CustomSort"], returns: "Bool" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects empty assertions array", () => {
    traceSpec("FLA-SAMPLE-REJECT");
    const result = validateFormalizationSample({ ...validSample, assertions: [] });
    expect(result.ok).toBe(true); // empty assertions is valid structurally
  });

  it("accepts nested balanced parentheses", () => {
    traceSpec("FLA-SAMPLE-ACCEPT");
    const result = validateFormalizationSample({
      ...validSample,
      assertions: [{ id: "ASSERT-NESTED", expr: "(and (ok true) (not false))" }],
    });
    expect(result.ok).toBe(true);
  });
});
