import { afterEach, describe, expect, it, vi } from "vitest";
import { checkOutboundAllowed } from "./outboundGuard";
import { sendSms } from "@/lib/sms/twilio";
import { sendEmail } from "@/lib/email/resend";

const T = "11111111-1111-1111-1111-111111111111";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("outbound guard — Founder Beta server-authoritative no-send boundary", () => {
  it("denies when allowlist unset (fail closed)", () => {
    expect(checkOutboundAllowed({ tenantId: T })).toEqual({ allowed: false, reason: "outbound-denied" });
  });
  it("denies when tenant missing, even if an allowlist exists", () => {
    vi.stubEnv("AIBO_OUTBOUND_ALLOWED_TENANT_IDS", T);
    expect(checkOutboundAllowed({}).allowed).toBe(false);
    expect(checkOutboundAllowed(undefined).allowed).toBe(false);
  });
  it("denies tenants not on the allowlist; allows only listed tenants (case-insensitive)", () => {
    vi.stubEnv("AIBO_OUTBOUND_ALLOWED_TENANT_IDS", ` ${T.toUpperCase()} , other `);
    expect(checkOutboundAllowed({ tenantId: T }).allowed).toBe(true);
    expect(checkOutboundAllowed({ tenantId: "22222222-2222-2222-2222-222222222222" }).allowed).toBe(false);
  });
  it("sendSms is denied before any network call, even with Twilio fully configured", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1"); vi.stubEnv("TWILIO_AUTH_TOKEN", "x"); vi.stubEnv("TWILIO_PHONE_NUMBER", "+15550000000");
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    expect(await sendSms("+15551112222", "hi", { tenantId: T })).toEqual({ ok: false, skipped: true, reason: "outbound-denied" });
    expect(await sendSms("+15551112222", "hi")).toMatchObject({ reason: "outbound-denied" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("tenant-controlled flags cannot re-enable it: only env allowlist matters", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1"); vi.stubEnv("TWILIO_AUTH_TOKEN", "x"); vi.stubEnv("TWILIO_PHONE_NUMBER", "+15550000000");
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sid: "SM1" }) }); vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("AIBO_OUTBOUND_ALLOWED_TENANT_IDS", T);
    expect((await sendSms("+15551112222", "hi", { tenantId: T })).ok).toBe(true);
    expect((await sendSms("+15551112222", "hi", { tenantId: "22222222-2222-2222-2222-222222222222" })).ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it("sendEmail is denied by default, except fixed-content ownerNotice", async () => {
    vi.stubEnv("RESEND_API_KEY", "k"); vi.stubEnv("EMAIL_FROM", "a@b.c");
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetchSpy);
    expect(await sendEmail("x@y.z", "s", "b", { tenantId: T })).toMatchObject({ reason: "outbound-denied" });
    expect(await sendEmail("x@y.z", "s", "b")).toMatchObject({ reason: "outbound-denied" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await sendEmail("x@y.z", "s", "b", { tenantId: T, ownerNotice: true })).ok).toBe(true);
  });
});
