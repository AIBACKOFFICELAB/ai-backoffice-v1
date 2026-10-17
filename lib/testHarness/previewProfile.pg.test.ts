import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPgTestUrl, getPgTestPool, withRollback, insertTenant, insertMembership, insertLead, setRole } from "./pgTestDb";

// The shared DB acceptance profile is Preview + SEC-01 + H001 028. F01's
// historical-upgrade suite deliberately creates its own canonical-only DB.
const suite = getPgTestUrl() ? describe : describe.skip;
afterAll(async () => { if (getPgTestUrl()) await getPgTestPool().end(); });

suite("Preview SEC-01 acceptance profile (real PostgreSQL 17)", () => {
  it("pins the actual sanitized 008, frozen SEC-01, and exact ordered migration inputs", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "db/test_profiles/preview/manifest.json"), "utf8"));
    const stages = Array.from({ length: 28 }, (_, i) => String(i + 1).padStart(3, "0"));
    stages.splice(8, 0, "SEC-01");
    expect(manifest.sequence.map((x: { stage: string }) => x.stage)).toEqual(stages);
    expect(manifest.sequence.find((x: { stage: string }) => x.stage === "008").sha256).toBe("0cb39ece06fef17daaae9374aae2c6e74099738ab16ab903d7edcf22ed29e268");
    expect(manifest.sequence.find((x: { stage: string }) => x.stage === "SEC-01").sha256).toBe("99f84ab33f522edd3ed2c97be20a36bcec182d943d4aecf196a9fc0cd8a2b041");
    for (const input of [...manifest.scaffold, ...manifest.sequence]) {
      expect(createHash("sha256").update(readFileSync(join(process.cwd(), input.file))).digest("hex"), input.file).toBe(input.sha256);
    }
  });

  it("requires PostgreSQL 17, SEC-01 SELECT-only client grants, RLS, and service access", () => withRollback(async c => {
    expect(Math.floor(Number((await c.query("SHOW server_version_num")).rows[0].server_version_num) / 10000)).toBe(17);
    const { rows } = await c.query(`SELECT relname,relrowsecurity,
      has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') anon_any,
      has_table_privilege('authenticated',oid,'SELECT') member_read,
      has_table_privilege('authenticated',oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') member_write,
      has_table_privilege('service_role',oid,'INSERT') service_insert,
      has_table_privilege('service_role',oid,'UPDATE') service_update
      FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN
      ('revenue_desk_settings','revenue_desk_calls','revenue_desk_bookings','revenue_desk_intake_receipts','billing_subscriptions') ORDER BY relname`);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row).toMatchObject({ relrowsecurity:true, anon_any:false, member_read:true, member_write:false, service_insert:true, service_update:true });
  }));

  it("reproduces direct default EXECUTE grants and proves PUBLIC-only revoke is insufficient", () => withRollback(async c => {
    const name = `r02_probe_${randomUUID().replaceAll("-", "")}`;
    await c.query(`CREATE FUNCTION public.${name}() RETURNS integer LANGUAGE sql SECURITY INVOKER AS 'SELECT 1'`);
    const privilege = async (role: string) => (await c.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role,`public.${name}()`])).rows[0].ok;
    expect(await privilege("anon")).toBe(true);
    expect(await privilege("authenticated")).toBe(true);
    await c.query(`REVOKE EXECUTE ON FUNCTION public.${name}() FROM PUBLIC`);
    expect(await privilege("anon")).toBe(true);
    expect(await privilege("authenticated")).toBe(true);
    await c.query(`REVOKE EXECUTE ON FUNCTION public.${name}() FROM anon,authenticated`);
    expect(await privilege("anon")).toBe(false);
    expect(await privilege("authenticated")).toBe(false);
    expect(await privilege("service_role")).toBe(true);
    // The probe and every grant above roll back with the fixture transaction.
  }));

  it("keeps all H001 functions closed to clients despite the direct default grants", () => withRollback(async c => {
    const { rows } = await c.query(`SELECT proname,prosecdef,
      has_function_privilege('anon',oid,'EXECUTE') anon_execute,
      has_function_privilege('authenticated',oid,'EXECUTE') member_execute,
      has_function_privilege('service_role',oid,'EXECUTE') service_execute,
      EXISTS(SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee=0) public_grant
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'revenue_desk_%'`);
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row).toMatchObject({ prosecdef:false,anon_execute:false,member_execute:false,service_execute:true,public_grant:false });
  }));

  it("distinguishes exact permission denial from RLS zero rows, while preserving a positive owner write", () => withRollback(async c => {
    const a = await insertTenant(c), b = await insertTenant(c), user = randomUUID();
    await insertMembership(c, a, user);
    const own = await insertLead(c,a), foreign = await insertLead(c,b);
    await c.query("INSERT INTO revenue_desk_settings(tenant_id) VALUES($1)", [a]);
    const before = (await c.query("SELECT * FROM leads WHERE id=$1",[foreign])).rows;
    await setRole(c,"authenticated",user);
    // SEC-01 preserved lead UPDATE for membership-governed RLS, so this is
    // an actual filtered zero-row result, not an exception accepted as one.
    expect((await c.query("UPDATE leads SET customer_notes='forbidden' WHERE id=$1",[foreign])).rowCount).toBe(0);
    expect((await c.query("UPDATE leads SET customer_notes='owner update' WHERE id=$1",[own])).rowCount).toBe(1);
    await c.query("SAVEPOINT permission_denied");
    await expect(c.query("UPDATE revenue_desk_settings SET enabled=true WHERE tenant_id=$1",[a])).rejects.toMatchObject({code:"42501"});
    await c.query("ROLLBACK TO SAVEPOINT permission_denied");
    await c.query("RESET ROLE");
    expect((await c.query("SELECT * FROM leads WHERE id=$1",[foreign])).rows).toEqual(before);
    expect((await c.query("SELECT customer_notes FROM leads WHERE id=$1",[own])).rows[0].customer_notes).toBe("owner update");
    expect((await c.query("SELECT enabled FROM revenue_desk_settings WHERE tenant_id=$1",[a])).rows[0].enabled).toBe(false);
  }));
});
