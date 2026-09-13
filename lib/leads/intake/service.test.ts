import { describe, it, expect, vi } from "vitest";
import { createCanonicalLeadFromIntake, type IntakeDeps } from "./service";
import { validateIntake, validPublicSlug } from "./validation";
import { readIntakeBody } from "./http";
import { testIntake } from "./fixtures";
import { emitEvent } from "@/lib/events/service";
import { InMemoryBusinessEventStore } from "@/lib/events/store";
import type { PlumbingLead } from "@/data/leadModel";
const tenant = { id: "tenant-a", name: "Test Business", email: "owner@example.invalid" };
function setup() {
  const rows = new Map<string, PlumbingLead>();
  const events = new InMemoryBusinessEventStore();
  const deps: IntakeDeps = {
    persist: vi.fn(async (lead, id) => {
      const key = `${id}:${lead.source}:${lead.sourceRef}`;
      const found = rows.get(key);
      if (found) return { lead: found, deduped: true };
      const stored = { ...lead, id: lead.id! };
      rows.set(key, stored);
      return { lead: stored, deduped: false };
    }),
    emit: vi.fn(input => emitEvent(input, events)), notify: vi.fn(async () => {}),
  };
  return { deps, rows, events, create: (input: unknown = testIntake) => createCanonicalLeadFromIntake(input, tenant, "website_form", null, deps) };
}
describe("canonical intake domain", () => {
  it("creates a UUID New lead with zero estimate, durable provenance and a private event", async () => {
    const s = setup(); const { lead } = await s.create();
    expect(lead.id).toMatch(/^[0-9a-f-]{36}$/); expect(lead.id).not.toMatch(/^GS-/);
    expect(lead).toMatchObject({ status: "New", estimateAmount: 0, source: "website_form", sourceRef: testIntake.sourceRef, intakeSchemaVersion: 1 });
    expect(Date.parse(lead.receivedAt!)).not.toBeNaN();
    expect(s.events.all()).toHaveLength(1);
    const event = s.events.all()[0];
    expect(event.payload).toEqual({ leadId: lead.id, source: "website_form", serviceType: "Water Heater", emergency: "No", receivedAt: lead.receivedAt });
    expect(JSON.stringify(event)).not.toContain(testIntake.email);
    expect(s.deps.notify).toHaveBeenCalledOnce();
  });
  it("replays and concurrent requests yield one lead, one event and one notification attempt", async () => {
    const s = setup(); await Promise.all(Array.from({ length: 10 }, () => s.create())); await s.create();
    expect(s.rows.size).toBe(1); expect(s.events.all()).toHaveLength(1); expect(s.deps.notify).toHaveBeenCalledOnce();
  });
  it("distinct source references allow separate jobs for the same person", async () => {
    const s = setup(); await s.create(); await s.create({ ...testIntake, sourceRef: "00000000-0000-4000-8000-000000000002" }); expect(s.rows.size).toBe(2);
  });
  it("same reference is independently scoped by tenant and source", async () => {
    const s = setup(); await s.create();
    await createCanonicalLeadFromIntake(testIntake, { ...tenant, id: "tenant-b" }, "website_form", null, s.deps);
    await createCanonicalLeadFromIntake(testIntake, tenant, "manual", "user-a", s.deps);
    expect(s.rows.size).toBe(3); expect(s.events.all()[2]).toMatchObject({ actorType: "user", actorId: "user-a" });
  });
  it("does not remove a lead if notification fails", async () => {
    const s = setup(); vi.mocked(s.deps.notify).mockRejectedValue(new Error("Email offline"));
    await expect(s.create()).resolves.toMatchObject({ deduped: false }); expect(s.rows.size).toBe(1);
  });
  it("returns retryable event failure and repairs on the same identity without duplication", async () => {
    const s = setup(); vi.mocked(s.deps.emit).mockRejectedValueOnce(new Error("offline"));
    await expect(s.create()).rejects.toMatchObject({ status: 503, code: "RETRY_SUBMISSION" }); expect(s.rows.size).toBe(1);
    await expect(s.create()).resolves.toMatchObject({ deduped: true }); expect(s.events.all()).toHaveLength(1); expect(s.deps.notify).toHaveBeenCalledOnce();
  });
  it("refuses invalid input before persistence", async () => {
    const s = setup(); await expect(s.create({ ...testIntake, tenant_id: "other" })).rejects.toMatchObject({ status: 400 }); expect(s.deps.persist).not.toHaveBeenCalled();
  });
  it("requires a verified actor for manual intake", async () => {
    const s = setup(); await expect(createCanonicalLeadFromIntake(testIntake, tenant, "manual", null, s.deps)).rejects.toMatchObject({ status: 403 }); expect(s.deps.persist).not.toHaveBeenCalled();
  });
});
describe("server validation", () => {
  it.each([
    null, [], {}, { ...testIntake, customerName: " " }, { ...testIntake, phone: "abcd" }, { ...testIntake, email: "not-email" },
    { ...testIntake, propertyType: "arbitrary" }, { ...testIntake, urgency: "Whenever!" }, { ...testIntake, emergency: true },
    { ...testIntake, jobDescription: "x".repeat(4001) }, { ...testIntake, serviceAddress: "x".repeat(301) },
    { ...testIntake, source: "manual" }, { ...testIntake, status: "Estimate Sent" }, { ...testIntake, estimateAmount: 10 },
    { ...testIntake, website: "bot" }, { ...testIntake, sourceRef: "GS-1" }, { ...testIntake, phone: "1".repeat(16) },
  ])("rejects invalid payload %j", raw => expect(() => validateIntake(raw)).toThrow());
  it("normalizes intentionally and permits omitted optional values", () => {
    const input = validateIntake({ ...testIntake, customerName: " Test Customer ", phone: "+1 (555) 010-1234", email: undefined });
    expect(input.customerName).toBe("Test Customer"); expect(input.phone).toBe("+15550101234"); expect(input.email).toBe("");
  });
  it.each(["", "../tenant", "tenant?x", "a".repeat(101)])("rejects malformed slug %s", slug => expect(validPublicSlug(slug)).toBe(false));
  it("accepts stable public slugs", () => expect(validPublicSlug("5-star-plumbing")).toBe(true));
});
describe("HTTP abuse boundary", () => {
  const req = (body: string, headers: Record<string, string> = {}) => new Request("https://example.test/api/request/test", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  it("reads bounded valid JSON", async () => expect(await readIntakeBody(req(JSON.stringify(testIntake)))).toEqual(testIntake));
  it("rejects invalid JSON", async () => await expect(readIntakeBody(req("{"))).rejects.toMatchObject({ status: 400 }));
  it("rejects actual oversized body without content-length", async () => await expect(readIntakeBody(req("x".repeat(16385)))).rejects.toMatchObject({ status: 413 }));
  it("rejects oversized declared body", async () => await expect(readIntakeBody(req("{}", { "content-length": "20000" }))).rejects.toMatchObject({ status: 413 }));
  it("rejects cross-origin browser posting", async () => await expect(readIntakeBody(req("{}", { origin: "https://attacker.test" }))).rejects.toMatchObject({ status: 403 }));
  it("accepts the public Host when Next supplies an internal request hostname", async () => {
    const r = req(JSON.stringify(testIntake), { host: "public.example.test", origin: "https://public.example.test" });
    expect(await readIntakeBody(r)).toEqual(testIntake);
  });
  it("rejects an opaque origin", async () => await expect(readIntakeBody(req("{}", { origin: "null" }))).rejects.toMatchObject({ status: 403 }));
  it("requires JSON", async () => await expect(readIntakeBody(req("{}", { "content-type": "text/plain" }))).rejects.toMatchObject({ status: 415 }));
});
