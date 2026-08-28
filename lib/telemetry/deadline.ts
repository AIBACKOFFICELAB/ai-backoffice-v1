/**
 * Compatibility telemetry deadline enforcement (P0.9 Slice C, finding
 * H-01). `emitEventSafely`/`recordOutcomeSafely` already swallow
 * rejection so a P0 orchestration/audit write can never THROW into an
 * already-working legacy module — but without a finite deadline, an
 * underlying request that merely HANGS (a stalled DB connection, a
 * network partition) could still hold the calling legacy request open
 * indefinitely, which is just as bad as a thrown error for a serverless
 * function with its own execution limit.
 *
 * This is a DIFFERENT trust boundary from the governed agent-runtime
 * audit path (lib/agents/*, lib/execution/*): that path has never been
 * made fail-open, and Slice C does not change it — only the legacy
 * COMPATIBILITY telemetry helpers (emitEventSafely, recordOutcomeSafely)
 * use this.
 */

/** Small and safe for serverless execution: well under Vercel's shortest
 * function timeout, and short enough that a hung telemetry write never
 * meaningfully delays the legacy webhook/request it's attached to. */
export const TELEMETRY_DEADLINE_MS = 3000;

export type DeadlineOutcome<T> =
  | { outcome: "resolved"; value: T }
  | { outcome: "rejected"; error: unknown }
  | { outcome: "deadline_exceeded" };

export type WithTelemetryDeadlineOpts = {
  deadlineMs?: number;
  /**
   * Called if `operation` eventually settles (resolves OR rejects) AFTER
   * this function has already given up waiting on it (deadline exceeded).
   * Exists so that outcome is still observable (for sanitized logging)
   * instead of being silently discarded — but it is fire-and-forget from
   * the caller's perspective; nothing awaits it and it can never re-open
   * the already-resolved race.
   */
  onLateSettle?: (result: { outcome: "resolved"; value: unknown } | { outcome: "rejected"; error: unknown }) => void;
};

/**
 * Races `operation` against a deadline. NEVER rejects and NEVER leaves an
 * unhandled promise rejection behind — a rejection handler is always
 * attached to `operation` itself (via `.then(onFulfilled, onRejected)`),
 * regardless of which side of the race "wins", which is what prevents
 * Node from ever reporting `operation` as an unhandled rejection even if
 * it rejects long after the deadline already elapsed.
 *
 * - `operation` settles before the deadline -> { outcome: "resolved" | "rejected", ... }
 * - the deadline elapses first -> { outcome: "deadline_exceeded" } immediately;
 *   `operation` is NOT cancelled (there is no cancellation primitive for a
 *   generic Promise) — it may still complete later, reported via
 *   `onLateSettle` if provided, never awaited by the caller.
 */
export function withTelemetryDeadline<T>(operation: Promise<T>, opts: WithTelemetryDeadlineOpts = {}): Promise<DeadlineOutcome<T>> {
  const deadlineMs = opts.deadlineMs ?? TELEMETRY_DEADLINE_MS;

  return new Promise<DeadlineOutcome<T>>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ outcome: "deadline_exceeded" });
    }, deadlineMs);
    // Never hold the process open just to fire this timer (relevant for
    // long-lived Node contexts; harmless in a fresh serverless invocation).
    if (typeof timer === "object" && "unref" in timer) (timer as { unref(): void }).unref();

    operation.then(
      (value) => {
        if (settled) {
          opts.onLateSettle?.({ outcome: "resolved", value });
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ outcome: "resolved", value });
      },
      (error) => {
        if (settled) {
          opts.onLateSettle?.({ outcome: "rejected", error });
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ outcome: "rejected", error });
      }
    );
  });
}

/** Sanitized, bounded-length log line for a telemetry failure — never logs
 * the event/outcome payload itself (which may carry whatever a caller
 * passed in), only the store/driver-level error text, truncated so a
 * pathological error message can't flood logs. */
export function sanitizeTelemetryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
