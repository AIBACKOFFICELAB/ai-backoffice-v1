import { describe, it, expect } from "vitest";
import { computeOverallStatus } from "./service";

/**
 * Missed Call Recovery (P0.9 Slice C). `executeMissedCallRecovery` itself
 * is not dependency-injected (it calls createServerSupabaseClient()
 * directly, matching every other legacy module in this codebase — see
 * lib/modules/estimateFollowup/service.ts) and Slice C explicitly forbids
 * rewriting either module, so it cannot be unit-tested end-to-end without a
 * live Postgres, same limitation this module already had before Slice C.
 *
 * What IS covered here, honestly:
 *   - computeOverallStatus: the pure legacy status-vocabulary helper
 *     extracted for regression testing (finding H-03 — this behavior is
 *     UNCHANGED by Slice C; only what gets emitted/recorded AFTER this
 *     status is computed changed).
 *   - The event-contract PII rules this module's new event-emission calls
 *     must satisfy — see lib/events/contracts.test.ts, which proves
 *     call.missed/lead.created/recovery.sms_sent all reject a payload
 *     carrying a raw callerPhone.
 *   - emitEventSafely's fail-open + deadline-bounded behavior (the
 *     mechanism this module's compatibility calls rely on) — see
 *     lib/events/service.test.ts and lib/telemetry/deadline.test.ts.
 *
 * The DB-coupled integration (settings lookup, SMS/email sends, lead
 * creation, History writes, actual event/outcome calls with real
 * correlation/causation chaining) is IMPLEMENTED BUT NOT INDEPENDENTLY
 * EXECUTED here — it is exercised only by reading the source directly.
 * Slice D is the phase responsible for a real database/integration
 * acceptance pass.
 */
describe("computeOverallStatus — legacy status vocabulary (unchanged by H-03)", () => {
  it("SMS sent successfully -> 'recovered' (legacy meaning: SMS sent, NOT a verified business outcome)", () => {
    expect(computeOverallStatus({ ok: true, skipped: false, sid: "SM123" })).toBe("recovered");
  });

  it("SMS skipped (Twilio not configured) -> 'skipped'", () => {
    expect(computeOverallStatus({ ok: false, skipped: true, reason: "missing-env" })).toBe("skipped");
  });

  it("SMS send failed -> 'failed'", () => {
    expect(computeOverallStatus({ ok: false, skipped: false, reason: "twilio-error", status: 500 })).toBe("failed");
  });
});
