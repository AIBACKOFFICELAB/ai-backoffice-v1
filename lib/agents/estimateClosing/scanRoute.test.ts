import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { isAuthorizedCron, handleScanRequest } from "./scanRoute";
import { ShadowSweepResult } from "./stalledScan";

const URL = "http://localhost/api/agents/estimate-closing/scan";

function requestWithHeaders(headers: Record<string, string> = {}) {
  return new NextRequest(URL, { headers });
}

const EMPTY_SWEEP_RESULT: ShadowSweepResult = {
  scan: { candidatesScanned: 0, stalledFound: 0, stalledCandidates: [] },
  shadowOutcomes: [],
};

describe("isAuthorizedCron", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("denies when CRON_SECRET is not configured on this deployment, even with a correct-looking header", () => {
    vi.stubEnv("CRON_SECRET", "");
    const req = requestWithHeaders({ authorization: "Bearer anything" });
    expect(isAuthorizedCron(req)).toBe(false);
  });

  it("denies a request with no auth header at all", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(requestWithHeaders())).toBe(false);
  });

  it("denies a request with the wrong secret", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(requestWithHeaders({ authorization: "Bearer wrong" }))).toBe(false);
  });

  it("accepts the standard Vercel Cron 'Authorization: Bearer <secret>' header", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(requestWithHeaders({ authorization: "Bearer s3cret" }))).toBe(true);
  });

  it("accepts the legacy 'x-cron-secret' header", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(requestWithHeaders({ "x-cron-secret": "s3cret" }))).toBe(true);
  });
});

describe("handleScanRequest — fail-closed feature gating (P1 Sprint 2 §6)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("unauthorized request is denied (401) regardless of feature flag state", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const runSweep = vi.fn();
    const res = await handleScanRequest(requestWithHeaders(), { isEnabled: () => true, runSweep });

    expect(res.status).toBe(401);
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("missing CRON_SECRET on the deployment denies the request even with a header present", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const runSweep = vi.fn();
    const res = await handleScanRequest(requestWithHeaders({ authorization: "Bearer whatever" }), { isEnabled: () => true, runSweep });

    expect(res.status).toBe(401);
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("feature flag false -> returns before any scan/read/model/event work — the sweep function is never called", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const runSweep = vi.fn();
    const res = await handleScanRequest(requestWithHeaders({ authorization: "Bearer s3cret" }), { isEnabled: () => false, runSweep });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, fired: false, reason: "estimate_closing_shadow_disabled" });
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("feature flag true -> calls the sweep exactly once and reports its result", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const runSweep = vi.fn().mockResolvedValue(EMPTY_SWEEP_RESULT);
    const res = await handleScanRequest(requestWithHeaders({ authorization: "Bearer s3cret" }), { isEnabled: () => true, runSweep });

    expect(res.status).toBe(200);
    expect(runSweep).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fired).toBe(true);
  });

  it("response is summary-only and PII-safe — only bounded counts/statuses, never recommendation detail, rationale, or customer identifiers", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const sweepResult: ShadowSweepResult = {
      scan: {
        candidatesScanned: 5,
        stalledFound: 2,
        stalledCandidates: [
          {
            tenantId: "tenant-1",
            eventId: "evt-1",
            isNewEvent: true,
            lead: { id: "lead-1", tenantId: "tenant-1", status: "Estimate Sent", estimateAmount: 4200, serviceType: "Repipe", leadSource: "Google", urgency: "This Week" },
            sequence: { id: "seq-1", tenantId: "tenant-1", leadId: "lead-1", status: "active", estimateSentAt: "2026-08-01T00:00:00.000Z", day7DueAt: "2026-08-08T00:00:00.000Z", lastReplyAt: null },
          },
          {
            tenantId: "tenant-1",
            eventId: "evt-2",
            isNewEvent: false,
            lead: { id: "lead-2", tenantId: "tenant-1", status: "Estimate Sent", estimateAmount: 900, serviceType: "Drain Cleaning", leadSource: "Referral", urgency: "Flexible" },
            sequence: { id: "seq-2", tenantId: "tenant-1", leadId: "lead-2", status: "active", estimateSentAt: "2026-08-01T00:00:00.000Z", day7DueAt: "2026-08-08T00:00:00.000Z", lastReplyAt: null },
          },
        ],
      },
      shadowOutcomes: [
        {
          emission: {
            tenantId: "tenant-1",
            eventId: "evt-1",
            isNewEvent: true,
            lead: { id: "lead-1", tenantId: "tenant-1", status: "Estimate Sent", estimateAmount: 4200, serviceType: "Repipe", leadSource: "Google", urgency: "This Week" },
            sequence: { id: "seq-1", tenantId: "tenant-1", leadId: "lead-1", status: "active", estimateSentAt: "2026-08-01T00:00:00.000Z", day7DueAt: "2026-08-08T00:00:00.000Z", lastReplyAt: null },
          },
          outcome: {
            status: "succeeded",
            agentRunId: "run-1",
            recommendationEventId: "evt-3",
            recommendation: {
              recommendation: "follow_up",
              confidence: 0.7,
              reasonCodes: ["no_response_since_sent"],
              suggestedChannel: "sms",
              suggestedTiming: "within_24_hours",
              opportunityValue: 4200,
              rationaleLength: 250,
            },
          },
        },
        {
          emission: {
            tenantId: "tenant-1",
            eventId: "evt-2",
            isNewEvent: false,
            lead: { id: "lead-2", tenantId: "tenant-1", status: "Estimate Sent", estimateAmount: 900, serviceType: "Drain Cleaning", leadSource: "Referral", urgency: "Flexible" },
            sequence: { id: "seq-2", tenantId: "tenant-1", leadId: "lead-2", status: "active", estimateSentAt: "2026-08-01T00:00:00.000Z", day7DueAt: "2026-08-08T00:00:00.000Z", lastReplyAt: null },
          },
          outcome: { status: "skipped", reason: "already_processed" },
        },
      ],
    };
    const runSweep = vi.fn().mockResolvedValue(sweepResult);
    const res = await handleScanRequest(requestWithHeaders({ authorization: "Bearer s3cret" }), { isEnabled: () => true, runSweep });
    const body = await res.json();

    expect(body).toEqual({
      ok: true,
      fired: true,
      candidatesScanned: 5,
      stalledFound: 2,
      newEventsThisSweep: 1,
      shadowAttempts: 2,
      outcomes: ["succeeded", "skipped"],
    });

    // Explicitly assert nothing customer-identifying, no rationale, and no
    // full recommendation payload leaked into the response body.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("lead-1");
    expect(serialized).not.toContain("lead-2");
    expect(serialized).not.toContain("Repipe");
    expect(serialized).not.toContain("rationale");
    expect(serialized).not.toContain("reasonCodes");
    expect(serialized).not.toContain("opportunityValue");
  });
});
