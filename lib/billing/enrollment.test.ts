import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ENROLLMENT_FLAG_ENV, founderBetaEnrollmentGate } from "./enrollment";
import { POST as checkoutPOST } from "@/app/api/billing/checkout/route";
import { ENROLLMENT_UNAVAILABLE_MESSAGE, FounderBetaCheckoutButton } from "@/components/FounderBetaCheckoutButton";
import PricingPage from "@/app/(marketing)/pricing/page";

/**
 * Founder Beta enrollment gate (post-merge enrollment safety closeout).
 * Stripe credentials alone must never open paid enrollment: Checkout requires
 * the explicit server-side flag AND full configuration. Every Stripe
 * interaction here is a mocked fetch — no real Checkout session is created.
 */

const FULL = {
  STRIPE_SECRET_KEY: "sk_test_mock",
  STRIPE_PRICE_ID_FOUNDER_BETA: "price_mock",
  STRIPE_WEBHOOK_SECRET: "whsec_mock",
  NEXT_PUBLIC_APP_URL: "https://app.example.test",
};
const KEYS = [ENROLLMENT_FLAG_ENV, ...Object.keys(FULL)];

function setEnv(values: Record<string, string | undefined>) {
  for (const k of KEYS) vi.stubEnv(k, values[k] as string);
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ id: "cs_mock_1", url: "https://checkout.stripe.test/c/cs_mock_1" }), { status: 200, headers: { "content-type": "application/json" } })
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const stripeCalls = () => fetchSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes("api.stripe.com"));

describe("founderBetaEnrollmentGate (pure)", () => {
  it("is CLOSED by default even when every Stripe credential exists", () => {
    expect(founderBetaEnrollmentGate({ ...FULL })).toEqual({ open: false, reason: "disabled" });
  });

  it("opens only for the exact string \"true\"", () => {
    for (const v of ["TRUE", "True", "1", "yes", "on", " true", "true ", "", "false"]) {
      expect(founderBetaEnrollmentGate({ ...FULL, [ENROLLMENT_FLAG_ENV]: v }), JSON.stringify(v)).toEqual({ open: false, reason: "disabled" });
    }
    expect(founderBetaEnrollmentGate({ ...FULL, [ENROLLMENT_FLAG_ENV]: "true" }).open).toBe(true);
  });

  it("with the flag on, every missing or blank dependency keeps it closed with a specific reason", () => {
    const on = { ...FULL, [ENROLLMENT_FLAG_ENV]: "true" };
    expect(founderBetaEnrollmentGate({ ...on, STRIPE_SECRET_KEY: undefined })).toEqual({ open: false, reason: "missing_stripe_secret_key" });
    expect(founderBetaEnrollmentGate({ ...on, STRIPE_PRICE_ID_FOUNDER_BETA: "  " })).toEqual({ open: false, reason: "missing_price_id" });
    expect(founderBetaEnrollmentGate({ ...on, STRIPE_WEBHOOK_SECRET: "" })).toEqual({ open: false, reason: "missing_webhook_secret" });
    expect(founderBetaEnrollmentGate({ ...on, NEXT_PUBLIC_APP_URL: undefined })).toEqual({ open: false, reason: "invalid_app_url" });
  });

  it("requires a valid absolute app origin for Stripe redirects (no silent default domain)", () => {
    const on = { ...FULL, [ENROLLMENT_FLAG_ENV]: "true" };
    for (const bad of ["aibackoffice.app", "http://app.example.test", "javascript:alert(1)", "https://app.example.test/path", "https://app.example.test/?x=1", "https://user:pw@app.example.test", "not a url"]) {
      expect(founderBetaEnrollmentGate({ ...on, NEXT_PUBLIC_APP_URL: bad }), bad).toEqual({ open: false, reason: "invalid_app_url" });
    }
    expect(founderBetaEnrollmentGate({ ...on, NEXT_PUBLIC_APP_URL: "https://app.example.test/" })).toMatchObject({ open: true, config: { appUrl: "https://app.example.test" } });
    expect(founderBetaEnrollmentGate({ ...on, NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).toMatchObject({ open: true, config: { appUrl: "http://localhost:3000" } });
  });

  it("enabled + fully configured yields the checkout config", () => {
    expect(founderBetaEnrollmentGate({ ...FULL, [ENROLLMENT_FLAG_ENV]: "true" })).toEqual({
      open: true,
      config: { secretKey: "sk_test_mock", priceId: "price_mock", appUrl: "https://app.example.test" },
    });
  });
});

describe("POST /api/billing/checkout (direct access)", () => {
  it("disabled (default) with ALL Stripe credentials present: 503, no Stripe call, no session", async () => {
    setEnv({ ...FULL });
    const res = await checkoutPOST();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toEqual({ ok: false, reason: "enrollment-unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flag on but any configuration missing: same safe 503, never names the missing setting, no Stripe call", async () => {
    for (const missing of ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID_FOUNDER_BETA", "STRIPE_WEBHOOK_SECRET", "NEXT_PUBLIC_APP_URL"]) {
      setEnv({ ...FULL, [ENROLLMENT_FLAG_ENV]: "true", [missing]: "" });
      const res = await checkoutPOST();
      expect(res.status, missing).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ ok: false, reason: "enrollment-unavailable" });
      expect(JSON.stringify(body)).not.toMatch(/stripe|secret|price|webhook|url/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enabled + fully configured: exactly one (mocked) Stripe session request, then 303 to Checkout", async () => {
    setEnv({ ...FULL, [ENROLLMENT_FLAG_ENV]: "true" });
    const res = await checkoutPOST();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.test/c/cs_mock_1");
    expect(stripeCalls()).toHaveLength(1);
    const [url, init] = stripeCalls()[0];
    expect(String(url)).toBe("https://api.stripe.com/v1/checkout/sessions");
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(body.get("line_items[0][price]")).toBe("price_mock");
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("success_url")).toBe("https://app.example.test/welcome?checkout=complete");
    expect(body.get("cancel_url")).toBe("https://app.example.test/pricing");
    expect(body.get("subscription_data[metadata][plan]")).toBe("founder_beta_299");
  });
});

describe("public purchase CTA + pricing page presentation", () => {
  const html = () => renderToStaticMarkup(createElement(PricingPage));

  it("disabled: /pricing still shows the approved $299 Founder Beta offer, with NO purchase form", () => {
    setEnv({ ...FULL }); // credentials present, flag absent
    const page = html();
    expect(page).toContain("AI BackOffice Founder Beta");
    expect(page).toContain("$299");
    expect(page).toContain("/month");
    expect(page).toContain("$0 setup during Founder Beta · One business · Month-to-month");
    expect(page).toContain("No revenue or close-rate results are guaranteed");
    expect(page).toContain(ENROLLMENT_UNAVAILABLE_MESSAGE);
    expect(page).not.toContain("<form");
    expect(page).not.toContain("/api/billing/checkout");
    expect(page).not.toContain("Start Founder Beta");
    expect(page).not.toMatch(/<input|qualif/i); // no substitute qualification form
  });

  it("enabled + configured: the CTA renders the Checkout form", () => {
    setEnv({ ...FULL, [ENROLLMENT_FLAG_ENV]: "true" });
    const page = html();
    expect(page).toContain('action="/api/billing/checkout"');
    expect(page).toContain("Start Founder Beta — $299/month");
    expect(page).not.toContain(ENROLLMENT_UNAVAILABLE_MESSAGE);
  });

  it("the shared CTA component (also used twice on the homepage) fails closed for every variant", () => {
    setEnv({});
    for (const variant of [undefined, "primary", "secondary"] as const) {
      const out = renderToStaticMarkup(createElement(FounderBetaCheckoutButton, { variant }));
      expect(out).toContain('role="status"');
      expect(out).toContain(ENROLLMENT_UNAVAILABLE_MESSAGE);
      expect(out).not.toContain("<form");
    }
  });
});
