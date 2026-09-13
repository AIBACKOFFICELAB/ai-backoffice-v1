import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const jar = vi.hoisted(() => ({ values: [] as {name:string;value:string}[] }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll:()=>jar.values, set:()=>{} }) }));
import { createServerSupabaseClient } from "@/lib/supabase/server";
afterEach(()=> {vi.unstubAllGlobals();vi.unstubAllEnvs();jar.values=[];});
describe("actual installed SSR SDK authorization behavior",()=>{
  it.each([true,false])("session cookie present=%s selects the effective Authorization role",async(hasCookie)=>{
    const user=randomUUID();
    const token=["eyJhbGciOiJIUzI1NiJ9",Buffer.from(JSON.stringify({sub:user,role:"authenticated",exp:Math.floor(Date.now()/1000)+3600})).toString("base64url"),"synthetic"].join(".");
    if(hasCookie) jar.values=[{name:"sb-auth-repro-auth-token",value:JSON.stringify({
      access_token:token,refresh_token:"synthetic",expires_at:Math.floor(Date.now()/1000)+3600,
      token_type:"bearer",user:{id:user},
    })}];
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL","https://auth-repro.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-service-key");
    let authorization:string|null=null;
    vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{
      authorization=new Headers(init.headers).get("authorization");
      return new Response("[]",{headers:{"content-type":"application/json"}});
    }));
    await (await createServerSupabaseClient()).from("estimate_followup_sequences").select("*");
    expect(authorization).toBe(`Bearer ${hasCookie?token:"synthetic-service-key"}`);
  });
});
