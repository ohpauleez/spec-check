import { describe, expect, it, vi } from "vitest";
import { traceSpec } from "../support/spec-trace.js";
import { createProgressEvent, emitProgressEvent } from "../../src/domain/progress.js";

describe("progress event contracts", () => {
  it("creates event with phase, status, and ISO timestamp", () => {
    traceSpec("CAT-CLI-PROGRESS", "CAT-PROGRESS-EVENTS");
    const event = createProgressEvent("parse", "started");
    expect(event.phase).toBe("parse");
    expect(event.status).toBe("started");
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(event).not.toHaveProperty("duration_ms");
  });

  it("includes duration_ms for completed events", () => {
    traceSpec("CAT-PROGRESS-EVENTS");
    const event = createProgressEvent("parse", "completed", 150);
    expect(event.duration_ms).toBe(150);
  });

  it("emits JSON line to stdout", () => {
    traceSpec("CAT-PROGRESS-EVENTS");
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const event = createProgressEvent("parse", "started");
    emitProgressEvent(event);
    expect(spy).toHaveBeenCalledOnce();
    const written = spy.mock.calls[0]?.[0] as string;
    expect(written.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(parsed.phase).toBe("parse");
    spy.mockRestore();
  });

  it("creates failed event for phase failures", () => {
    traceSpec("CAT-PROGRESS-FAIL");
    const event = createProgressEvent("formalization", "failed");
    expect(event.status).toBe("failed");
  });
});
