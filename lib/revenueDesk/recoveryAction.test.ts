import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ tenant:vi.fn(), load:vi.fn(), store:vi.fn(), reconcile:vi.fn(), refresh:vi.fn(), emit:vi.fn() }));
vi.mock("@/lib/tenant",()=>({getTenantContext:mocks.tenant}));
vi.mock("@/lib/revenueDesk/store.server",()=>({createBookingStore:mocks.store,getBookingForReconciliation:mocks.load,createRevenueDeskStore:()=>({emit:mocks.emit})}));
vi.mock("@/lib/revenueDesk/booking",()=>({reconcileBooking:mocks.reconcile}));
vi.mock("@/lib/revenueDesk/calendar/google",()=>({GoogleCalendarProvider:class {}}));
vi.mock("next/cache",()=>({revalidatePath:mocks.refresh}));
import { checkBookingEvidence } from "@/app/(app)/revenue-desk/actions";

describe("H001 owner reconciliation authorization",()=>{
  const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const form=()=>{const f=new FormData();f.set("bookingId",id);f.set("tenantId","forged");return f;};
  beforeEach(()=>{vi.resetAllMocks();mocks.tenant.mockResolvedValue({tenantId:"trusted",role:"owner",userId:"owner"});mocks.reconcile.mockResolvedValue({confirmed:false,statusUnknown:true});});
  it.each([null,{tenantId:"trusted",role:"staff"}])("refuses unauthorized actor %s before privileged access",async tenant=>{
    mocks.tenant.mockResolvedValue(tenant);await checkBookingEvidence(form());expect(mocks.load).not.toHaveBeenCalled();expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("uses session tenant only and cannot reconcile an absent/foreign booking",async()=>{
    mocks.load.mockResolvedValue(null);await checkBookingEvidence(form());expect(mocks.load).toHaveBeenCalledWith("trusted",id);expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("checks one pending booking and refreshes owner evidence",async()=>{
    const b={id,tenantId:"trusted",callId:"call",status:"pending"};mocks.load.mockResolvedValue(b);
    await checkBookingEvidence(form());expect(mocks.reconcile).toHaveBeenCalledTimes(1);expect(mocks.reconcile.mock.calls[0][1]).toBe(b);expect(mocks.refresh).toHaveBeenCalledWith("/revenue-desk/call");
  });
  it("settled rows are not acted on",async()=>{
    mocks.load.mockResolvedValue({id,status:"confirmed"});await checkBookingEvidence(form());expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("audit failure prevents privileged reconciliation",async()=>{
    mocks.load.mockResolvedValue({id,callId:"call",status:"pending"});mocks.emit.mockRejectedValue(new Error("audit down"));
    await checkBookingEvidence(form());expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
