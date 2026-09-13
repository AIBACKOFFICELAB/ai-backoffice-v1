/** Test-only adapter for the small Supabase query subset used by lead intake.
 * Executes real SQL over the repository's fresh PostgreSQL harness. This tests
 * production store mappings/filters/constraint handling, not PostgREST transport.
 */
import { getPgTestPool } from "./pgTestDb";
const identifier = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("Invalid test SQL identifier");
  return `"${name}"`;
};
export function pgSupabaseAdapter(query = (sql: string, params: unknown[]) => getPgTestPool().query(sql, params)) {
  return { from(table: string) {
    let operation = "select";
    let values: Record<string, unknown> = {};
    let selected = "*";
    let singular = false;
    let ordering = "";
    let rowLimit: number | undefined;
    let dueAt: string | undefined;
    const filters: [string, unknown][] = [];
    const builder = {
      insert(row: Record<string, unknown>) { operation = "insert"; values = row; return builder; },
      update(row: Record<string, unknown>) { operation = "update"; values = row; return builder; },
      select(columns = "*") { selected = columns; return builder; },
      eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
      order(column: string, options: { ascending?: boolean } = {}) { ordering = ` ORDER BY ${identifier(column)} ${options.ascending === false ? "DESC" : "ASC"}`; return builder; },
      limit(n: number) { if (!Number.isInteger(n) || n < 0) throw new Error("Invalid limit"); rowLimit = n; return builder; },
      or(expression: string) {
        // Only the fixed due-followup predicate used by the production service.
        const match = expression.match(/^and\(day1_sent_at.is.null,day1_due_at.lte.(.+)\),and\(day3_sent_at.is.null,day3_due_at.lte.\1\),and\(day7_sent_at.is.null,day7_due_at.lte.\1\)$/);
        if (!match || !Number.isFinite(Date.parse(match[1]))) throw new Error("Unsupported test predicate");
        dueAt = match[1]; return builder;
      },
      single() { singular = true; return builder; },
      maybeSingle() { singular = true; return builder; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return execute().then(resolve, reject);
      },
    };
    async function execute() {
      const params: unknown[] = [];
      const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
      const joined = selected === "*, leads:lead_id (customer_name, service_type, phone, status)";
      const cols = joined ? "*": selected === "*" ? "*" : selected.split(",").map(c => identifier(c.trim())).join(",");
      const entries = Object.entries(values).filter(([, v]) => v !== undefined);
      let sql: string;
      if (operation === "insert") sql = `INSERT INTO public.${identifier(table)} (${entries.map(([k]) => identifier(k)).join(",")}) VALUES (${entries.map(([, v]) => bind(v)).join(",")})`;
      else if (operation === "update") sql = `UPDATE public.${identifier(table)} SET ${entries.map(([k, v]) => `${identifier(k)} = ${bind(v)}`).join(",")}`;
      else sql = `SELECT ${cols} FROM public.${identifier(table)}`;
      if (filters.length) sql += ` WHERE ${filters.map(([k, v]) => `${identifier(k)} = ${bind(v)}`).join(" AND ")}`;
      if (dueAt) {
        const value = bind(dueAt);
        sql += `${filters.length ? " AND " : " WHERE "}(${[1,3,7].map(day => `(day${day}_sent_at IS NULL AND day${day}_due_at <= ${value})`).join(" OR ")})`;
      }
      if (operation === "select") sql += ordering + (rowLimit === undefined ? "" : ` LIMIT ${rowLimit}`);
      if (operation !== "select") sql += ` RETURNING ${cols}`;
      try {
        const result = await query(sql, params);
        if (joined) {
          for (const row of result.rows) {
            const lead = await query("SELECT customer_name, service_type, phone, status FROM public.leads WHERE id=$1 AND tenant_id=$2", [row.lead_id, row.tenant_id]);
            row.leads = lead.rows[0] ?? null;
          }
        }
        // JSON transport normalizes PostgreSQL Date objects to ISO strings.
        const rows = JSON.parse(JSON.stringify(result.rows));
        return { data: singular ? rows[0] ?? null : rows, error: null };
      } catch (error) { return { data: null, error }; }
    }
    return builder;
  } };
}
