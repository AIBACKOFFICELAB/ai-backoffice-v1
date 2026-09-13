import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ db: vi.fn(), sheets: vi.fn() }));
vi.mock("@/lib/leads/supabase", () => ({ fetchLeadsFromDb: mocks.db }));
vi.mock("@/lib/leads/googleSheets", () => ({ fetchGoogleSheetLeads: mocks.sheets }));
import { getLeads } from "@/lib/leads/repository";
beforeEach(() => vi.resetAllMocks());
describe("legacy bootstrap cutover boundary", () => {
  it("canonical Supabase data wins without querying or merging Sheets", async () => {
    mocks.db.mockResolvedValue([{ id: "canonical" }]); expect(await getLeads("tenant")).toEqual({ leads: [{ id: "canonical" }], source: "supabase" }); expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it("retains legacy reader after a confirmed empty DB read", async () => {
    mocks.db.mockResolvedValue([]); mocks.sheets.mockResolvedValue([{ id: "GS-1" }]); expect((await getLeads("tenant")).source).toBe("google-sheets");
  });
  it("DB failure cannot replace canonical truth with Sheets", async () => {
    mocks.db.mockRejectedValue(new Error("offline")); expect(await getLeads("tenant")).toMatchObject({ leads: [], source: "supabase", error: true }); expect(mocks.sheets).not.toHaveBeenCalled();
  });
});
