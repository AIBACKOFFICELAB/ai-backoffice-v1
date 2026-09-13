import { afterEach, expect, it, vi } from "vitest";
const actor={tenantId:"tenant-a",userId:"user-a",tenantName:"Test"};
vi.mock("server-only",()=>({}));
vi.mock("@/lib/tenant",()=>({getTenantContext:async()=>({tenantId:"tenant-a",userId:"user-a"})}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
  from:(table:string)=>{
    const b={select:()=>b,eq:()=>b,maybeSingle:async()=>({error:null,data:table==="leads"?{id:"lead-a",status:"Estimate Sent",estimate_amount:50}:{id:"sequence-a"}})};
    return b;
  },
})}));
import { emitEstimateSentEvent } from "./estimateLifecycleEvent.server";
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it("private event SDK sends service Authorization without request cookies and a fixed bounded event",async()=>{
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL","https://event-repro.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-service-key");
  let payload:any;let headers:Headers;
  vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{
    headers=new Headers(init.headers);payload=JSON.parse(init.body);
    return new Response(JSON.stringify({...payload,id:"synthetic-event"}),{headers:{"content-type":"application/json"}});
  }));
  await emitEstimateSentEvent({...actor,actorUserId:actor.userId,leadId:"lead-a",estimateAmount:999,sequenceCreated:false});
  expect(headers!.get("authorization")).toBe("Bearer synthetic-service-key");
  expect(headers!.get("cookie")).toBeNull();
  expect(payload).toMatchObject({tenant_id:"tenant-a",event_type:"estimate.sent",entity_id:"lead-a",idempotency_key:"estimate.sent:lead-a",payload:{estimateAmount:50,sequenceCreated:false}});
});
