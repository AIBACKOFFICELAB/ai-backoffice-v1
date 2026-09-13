import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const state=vi.hoisted(()=>({values:[] as any[],cursor:0,refresh:vi.fn()}));
vi.mock("react",async()=>{
 const real=await vi.importActual<typeof import("react")>("react");
 return {...real,useId:()=>"synthetic-id",useState:(initial:any)=>{
   const index=state.cursor++;
   if(!(index in state.values)) state.values[index]=initial;
   return [state.values[index],(value:any)=>{state.values[index]=value;}];
 }};
});
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:state.refresh})}));
import LeadEditForm from "./LeadEditForm";
import type { PlumbingLead } from "@/data/leadModel";
const lead={id:"synthetic-lead",status:"Estimate Sent",estimateAmount:50,followUpDate:"",internalNotes:""} as PlumbingLead;
const render=()=>{state.cursor=0;return LeadEditForm({lead,followupStatus:"enabled"});};
const submit=()=>render().props.onSubmit({preventDefault(){}});
beforeEach(()=>{state.values=[];state.cursor=0;state.refresh.mockClear();vi.unstubAllGlobals();});
it("partial lifecycle failure displays actionable error and never Saved even after previous success",async()=>{
 vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({estimateLifecycleComplete:true}),{status:200}))
 .mockResolvedValueOnce(new Response(JSON.stringify({leadPersisted:true,estimateLifecycleComplete:false,error:"Estimate saved, but follow-up setup is incomplete. Save again to retry safely, or refresh to review."}),{status:503})));
 await submit();expect(renderToStaticMarkup(render())).toContain("Saved!");
 await submit();const html=renderToStaticMarkup(render());
 expect(html).toContain("follow-up setup is incomplete");expect(html).not.toContain("Saved!");expect(html).not.toContain("Changes saved");
 expect(state.refresh).toHaveBeenCalledTimes(2);
});
it("defensively handles incomplete lifecycle in a 200 response",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({leadPersisted:true,estimateLifecycleComplete:false}),{status:200})));
 await submit();const html=renderToStaticMarkup(render());expect(html).toContain("follow-up setup is incomplete");expect(html).not.toContain("Saved!");
});
it("network failure never claims saved",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("Network unavailable");}));
 await submit();const html=renderToStaticMarkup(render());expect(html).toContain("Network unavailable");expect(html).not.toContain("Saved!");
});

it("an unclassified HTTP failure does not falsely claim the lead persisted",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>new Response("",{status:500})));
 await submit();const html=renderToStaticMarkup(render());expect(html).toContain("Failed to save changes.");expect(html).not.toContain("Estimate saved");expect(html).not.toContain("Saved!");
});
