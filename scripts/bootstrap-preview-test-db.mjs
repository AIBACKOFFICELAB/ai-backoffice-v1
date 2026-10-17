// Local disposable fixture bootstrap ONLY. Never uses hosted credentials,
// migration ledgers, Supabase CLI synchronization, or a destructive reset.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = "db/test_profiles/preview/";

async function main() {
  const raw = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!raw) throw new Error("Set DATABASE_URL to a fresh disposable localhost aibo_test_* database.");
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^\/aibo_test_[a-z0-9_]+$/.test(url.pathname)
    || url.search || url.hash) {
    throw new Error("Refusing target: requires localhost, aibo_test_* database and no URL query options.");
  }
  const manifest = JSON.parse(await readFile(path.join(root, profile, "manifest.json"), "utf8"));
  const expected = [...Array(28)].map((_, i) => String(i + 1).padStart(3, '0'));
  expected.splice(8, 0, 'SEC-01');
  if (JSON.stringify(manifest.sequence.map(x => x.stage)) !== JSON.stringify(expected)) {
    throw new Error("Unexpected migration profile sequence.");
  }
  // Verify every frozen input before connecting or executing any SQL.
  const inputs = [...manifest.scaffold, ...manifest.sequence];
  const sql = [];
  for (const item of inputs) {
    const bytes = await readFile(path.join(root, item.file));
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
      throw new Error(`Fixture checksum mismatch: ${item.file}`);
    }
    sql.push(bytes.toString('utf8'));
  }
  const client = new pg.Client({ connectionString: raw, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const { rows: [server] } = await client.query("SELECT current_user, current_setting('server_version_num')::int AS version");
    if (server.current_user !== 'postgres' || Math.floor(server.version / 10000) !== 17) {
      throw new Error("Requires PostgreSQL 17 and disposable migration owner postgres.");
    }
    const { rows: [state] } = await client.query(`SELECT
      (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S','f')) AS relations,
      to_regclass('auth.users') IS NOT NULL AS auth_users`);
    if (state.relations !== 0 || state.auth_users) throw new Error("Refusing nonempty database; create a fresh disposable database instead of resetting it.");
    for (let i = 0; i < sql.length; i++) {
      await client.query(sql[i]);
      console.log(`Applied local fixture: ${inputs[i].file}`);
    }
    console.log(`PASS: ${manifest.profile}, PostgreSQL ${server.version}, 001–027 + sanitized 008 + SEC-01 + local 028.`);
  } finally {
    await client.end();
  }
}

main().catch(error => {
  // Avoid logging the URL, connection object, or any credentials.
  console.error(`Preview test bootstrap failed: ${error.message}`);
  process.exitCode = 1;
});
