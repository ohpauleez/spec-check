import { describe, expect, it } from "vitest";
import {
  exitCodeFromCategory,
  exitCodeForError,
  formatError,
  makeError,
  makeTypedError,
  renderErrorLines,
  EXIT_CODE_SUCCESS,
  EXIT_CODE_FINDINGS,
  EXIT_CODE_BY_CATEGORY,
} from "../../src/domain/errors.js";

describe("error utilities", () => {
  it("maps ArgumentError to exit code 2", () => {
    expect(exitCodeFromCategory("ArgumentError")).toBe(2);
    expect(EXIT_CODE_BY_CATEGORY.ArgumentError).toBe(2);
  });

  it("maps ConfigError to exit code 3", () => {
    expect(exitCodeFromCategory("ConfigError")).toBe(3);
  });

  it("maps DependencyError to exit code 4", () => {
    expect(exitCodeFromCategory("DependencyError")).toBe(4);
  });

  it("maps CatalogError to exit code 5", () => {
    expect(exitCodeFromCategory("CatalogError")).toBe(5);
  });

  it("maps PipelineError to exit code 10", () => {
    expect(exitCodeFromCategory("PipelineError")).toBe(10);
  });

  it("exit code success is 0", () => {
    expect(EXIT_CODE_SUCCESS).toBe(0);
  });

  it("exit code findings is 1", () => {
    expect(EXIT_CODE_FINDINGS).toBe(1);
  });

  it("formats error with category and message", () => {
    const error = makeError("PipelineError", "boom");
    const formatted = formatError(error);
    expect(formatted).toBe("[spec-check] PipelineError: boom");
  });

  it("renders error lines with details", () => {
    const error = makeError("ConfigError", "missing field", ["expected 'inputs' array"]);
    const lines = renderErrorLines(error);
    expect(lines[0]).toBe("[spec-check] ConfigError: missing field");
    expect(lines[1]).toBe("  expected 'inputs' array");
  });

  it("renders error lines without details", () => {
    const error = makeError("DependencyError", "z3 not found");
    const lines = renderErrorLines(error);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("[spec-check] DependencyError: z3 not found");
  });

  it("makeTypedError preserves category type", () => {
    const error = makeTypedError("ValidationError", "sample invalid");
    expect(error.category).toBe("ValidationError");
    expect(error.message).toBe("sample invalid");
  });

  it("exitCodeForError returns correct code for structured error", () => {
    const error = makeTypedError("FormalizationError", "all samples invalid");
    expect(exitCodeForError(error)).toBe(9);
  });
});
