import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlumbingLead } from "@/data/leadModel";
import { testIntake } from "./fixtures";
const mocks = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/leads/repository", () => ({ getLeadById: mocks.read, updateLead: mocks.update, deleteLead: mocks.remove }));
vi.mock("@/lib/api-auth", () => ({ checkAuth: async () => ({ authenticated: true }) }));
vi.mock("@/lib/tenant", () => ({ getTenantContext: async () => ({ tenantId: "member-tenant", userId: "member" }) }));
import { PUT, DELETE } from "@/app/api/leads/[id]/route";
import { LeadInboxList } from "@/components/LeadInboxList";
const lead: PlumbingLead = { ...testIntake, id: "GS-existing", date: "2026-09-13", photosUploaded: "No", status: "New", estimateAmount: 0, followUpDate: "", reviewRequestStatus: "Not Ready", internalNotes: "" };
const params = { params: Promise.resolve({ id: lead.id }) };
beforeEach(() => vi.resetAllMocks());
describe("storage source governs legacy access", () => {
  it("allows deleting a GS-prefixed record that is already in canonical storage", async () => {
    mocks.read.mockResolvedValue({ lead, source: "supabase" }); mocks.remove.mockResolvedValue(true);
    expect((await DELETE(new NextRequest("https://example.test/api/leads/GS-existing", { method: "DELETE" }), params)).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith(lead.id, "member-tenant");
  });
  it("rejects deleting a Sheet-only record without canonical writes", async () => {
    mocks.read.mockResolvedValue({ lead, source: "google-sheets" });
    expect((await DELETE(new NextRequest("https://example.test/api/leads/GS-existing", { method: "DELETE" }), params)).status).toBe(409);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("never shadow-writes an edited Sheet-only record", async () => {
    mocks.update.mockResolvedValue(null); mocks.read.mockResolvedValue({ lead, source: "google-sheets" });
    expect((await PUT(new NextRequest("https://example.test/api/leads/GS-existing", { method: "PUT", body: JSON.stringify({ status: "Contacted" }) }), params)).status).toBe(409);
  });
  it("canonical GS-prefixed rows retain status controls", () => {
    expect(renderToStaticMarkup(createElement(LeadInboxList, { leads: [lead], readOnly: false }))).not.toContain("Legacy · read-only");
  });
  it("Sheet-only rows display a read-only indicator", () => {
    expect(renderToStaticMarkup(createElement(LeadInboxList, { leads: [lead], readOnly: true }))).toContain("Legacy · read-only");
  });
});
