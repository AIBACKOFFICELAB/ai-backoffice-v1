import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ db: vi.fn(), sheets: vi.fn() }));
vi.mock("@/lib/leads/supabase", () => ({ fetchLeadsFromDb: mocks.db }));
vi.mock("@/lib/leads/googleSheets", () => ({ fetchGoogleSheetLeads: mocks.sheets }));
import { getLeads } from "@/lib/leads/repository";
beforeEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
describe("legacy bootstrap cutover boundary", () => {
  it("canonical Supabase data wins without querying or merging Sheets", async () => {
    mocks.db.mockResolvedValue([{ id: "canonical" }]); expect(await getLeads("tenant")).toEqual({ leads: [{ id: "canonical" }], source: "supabase" }); expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it("empty tenant gets an empty result, NEVER the global Sheet (paid-tenant isolation)", async () => {
    mocks.db.mockResolvedValue([]); mocks.sheets.mockResolvedValue([{ id: "GS-1" }]);
    expect(await getLeads("tenant")).toEqual({ leads: [], source: "supabase" }); expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it("allowlist unset or other tenant listed -> still no Sheet", async () => {
    vi.stubEnv("AIBO_LEGACY_SHEET_TENANT_IDS", "11111111-1111-1111-1111-111111111111");
    mocks.db.mockResolvedValue([]); mocks.sheets.mockResolvedValue([{ id: "GS-1" }]);
    expect((await getLeads("22222222-2222-2222-2222-222222222222")).leads).toEqual([]); expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it("retains legacy reader after a confirmed empty DB read ONLY for an explicitly allowlisted pilot tenant", async () => {
    vi.stubEnv("AIBO_LEGACY_SHEET_TENANT_IDS", "TENANT");
    mocks.db.mockResolvedValue([]); mocks.sheets.mockResolvedValue([{ id: "GS-1" }]); expect((await getLeads("tenant")).source).toBe("google-sheets");
  });
  it("DB failure cannot replace canonical truth with Sheets", async () => {
    mocks.db.mockRejectedValue(new Error("offline")); expect(await getLeads("tenant")).toMatchObject({ leads: [], source: "supabase", error: true }); expect(mocks.sheets).not.toHaveBeenCalled();
  });
});
