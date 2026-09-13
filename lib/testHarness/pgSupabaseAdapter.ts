/** Test-only adapter for the small Supabase query subset used by lead intake.
 * Executes real SQL over the repository's fresh PostgreSQL harness. This tests
 * production store mappings/filters/constraint handling, not PostgREST transport.
 */
import { getPgTestPool } from "./pgTestDb";
const identifier = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("Invalid test SQL identifier");
  return `"${name}"`;
};
export function pgSupabaseAdapter() {
  return { from(table: string) {
    let operation = "select";
    let values: Record<string, unknown> = {};
    let selected = "*";
    let singular = false;
    const filters: [string, unknown][] = [];
    const builder = {
      insert(row: Record<string, unknown>) { operation = "insert"; values = row; return builder; },
      update(row: Record<string, unknown>) { operation = "update"; values = row; return builder; },
      select(columns = "*") { selected = columns; return builder; },
      eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
      single() { singular = true; return builder; },
      maybeSingle() { singular = true; return builder; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return execute().then(resolve, reject);
      },
    };
    async function execute() {
      const params: unknown[] = [];
      const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
      const cols = selected === "*" ? "*" : selected.split(",").map(c => identifier(c.trim())).join(",");
      const entries = Object.entries(values).filter(([, v]) => v !== undefined);
      let sql: string;
      if (operation === "insert") sql = `INSERT INTO public.${identifier(table)} (${entries.map(([k]) => identifier(k)).join(",")}) VALUES (${entries.map(([, v]) => bind(v)).join(",")})`;
      else if (operation === "update") sql = `UPDATE public.${identifier(table)} SET ${entries.map(([k, v]) => `${identifier(k)} = ${bind(v)}`).join(",")}`;
      else sql = `SELECT ${cols} FROM public.${identifier(table)}`;
      if (filters.length) sql += ` WHERE ${filters.map(([k, v]) => `${identifier(k)} = ${bind(v)}`).join(" AND ")}`;
      if (operation !== "select") sql += ` RETURNING ${cols}`;
      try {
        const result = await getPgTestPool().query(sql, params);
        // JSON transport normalizes PostgreSQL Date objects to ISO strings.
        const rows = JSON.parse(JSON.stringify(result.rows));
        return { data: singular ? rows[0] ?? null : rows, error: null };
      } catch (error) { return { data: null, error }; }
    }
    return builder;
  } };
}
