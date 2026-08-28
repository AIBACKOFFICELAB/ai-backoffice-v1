import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTelemetryDeadline, sanitizeTelemetryError } from "./deadline";

/**
 * Compatibility telemetry deadline (P0.9 Slice C, finding H-01). Uses fake
 * timers throughout — no wall-clock waiting, so these are not flaky.
 */
describe("withTelemetryDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the operation's value when it settles before the deadline", async () => {
    const promise = withTelemetryDeadline(Promise.resolve("ok"), { deadlineMs: 1000 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    expect(result).toEqual({ outcome: "resolved", value: "ok" });
  });

  it("resolves with the rejection reason when the operation rejects before the deadline", async () => {
    const promise = withTelemetryDeadline(Promise.reject(new Error("db exploded")), { deadlineMs: 1000 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    expect(result.outcome).toBe("rejected");
    expect((result as { error: unknown }).error).toBeInstanceOf(Error);
  });

  it("scenario: operation never resolves -> resolves 'deadline_exceeded' after the bounded deadline, not indefinitely", async () => {
    const neverResolves = new Promise(() => {});
    const promise = withTelemetryDeadline(neverResolves, { deadlineMs: 3000 });

    await vi.advanceTimersByTimeAsync(2999);
    // Not yet — still within the deadline.
    let settledEarly = false;
    promise.then(() => {
      settledEarly = true;
    });
    await Promise.resolve(); // flush microtasks
    expect(settledEarly).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const result = await promise;
    expect(result).toEqual({ outcome: "deadline_exceeded" });
  });

  it("a late resolution after the deadline is reported via onLateSettle, not the already-resolved promise", async () => {
    let resolveOp!: (value: string) => void;
    const op = new Promise<string>((resolve) => {
      resolveOp = resolve;
    });
    const lateSettles: unknown[] = [];
    const promise = withTelemetryDeadline(op, { deadlineMs: 1000, onLateSettle: (s) => lateSettles.push(s) });

    await vi.advanceTimersByTimeAsync(1001);
    const result = await promise;
    expect(result).toEqual({ outcome: "deadline_exceeded" });

    resolveOp("finally landed");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateSettles).toEqual([{ outcome: "resolved", value: "finally landed" }]);
  });

  it("scenario: no unhandled promise rejection — a late rejection after the deadline is caught, not thrown into the void", async () => {
    let rejectOp!: (error: unknown) => void;
    const op = new Promise<string>((_resolve, reject) => {
      rejectOp = reject;
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const lateSettles: unknown[] = [];
      const promise = withTelemetryDeadline(op, { deadlineMs: 1000, onLateSettle: (s) => lateSettles.push(s) });

      await vi.advanceTimersByTimeAsync(1001);
      const result = await promise;
      expect(result).toEqual({ outcome: "deadline_exceeded" });

      rejectOp(new Error("landed late and failed"));
      // Give the rejection handler(s) a chance to run.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(lateSettles).toHaveLength(1);
      expect((lateSettles[0] as { outcome: string }).outcome).toBe("rejected");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toHaveLength(0);
  });

  it("uses the default deadline (TELEMETRY_DEADLINE_MS) when none is specified", async () => {
    const neverResolves = new Promise(() => {});
    const promise = withTelemetryDeadline(neverResolves);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await promise).toEqual({ outcome: "deadline_exceeded" });
  });
});

describe("sanitizeTelemetryError", () => {
  it("extracts an Error's message", () => {
    expect(sanitizeTelemetryError(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(sanitizeTelemetryError("plain string failure")).toBe("plain string failure");
  });

  it("truncates a pathologically long message", () => {
    const long = "x".repeat(1000);
    const sanitized = sanitizeTelemetryError(new Error(long));
    expect(sanitized.length).toBeLessThan(320);
    expect(sanitized.endsWith("…")).toBe(true);
  });
});
