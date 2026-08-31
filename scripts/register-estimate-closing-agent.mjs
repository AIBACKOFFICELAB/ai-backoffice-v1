#!/usr/bin/env node
/**
 * P1 Sprint 2 — OPERATOR-ONLY script for the future production activation
 * of the Estimate Closing Agent (see
 * lib/agents/estimateClosing/featureFlag.ts's "ACTIVATION PROCEDURE" doc
 * comment — this covers step 1 of 3 remaining after this sprint).
 *
 * WHAT THIS DOES, and nothing more:
 *   - registers exactly one estimate_closing agent row for ONE explicit
 *     tenant id you pass on the command line
 *   - the row is always created with status: 'inactive'
 *   - idempotent: safe to run more than once for the same tenant — it will
 *     never create a duplicate (relies on the database's own
 *     uq_agents_tenant_builtin_type uniqueness constraint, migration 017,
 *     exactly like lib/agents/estimateClosing/registration.ts's
 *     ensureEstimateClosingAgent(), which this script mirrors — kept in
 *     sync manually since a plain Node ESM script cannot import a
 *     TypeScript module from this codebase without a build step)
 *   - never touches any other agent row (no dev_test, no supervisor, no
 *     other tenant)
 *   - never writes to leads, estimate_followup_sequences, business_events,
 *     agent_runs, outcomes, or any other table
 *
 * WHAT THIS NEVER DOES:
 *   - never sets status to 'active' — that is a separate, explicit,
 *     owner-authorized step this script does not perform
 *   - never sets or reads ESTIMATE_CLOSING_SHADOW_ENABLED
 *   - never sends any customer communication
 *   - never generates a synthetic business event or outcome
 *
 * USAGE:
 *   SUPABASE_SERVICE_ROLE_KEY=... NEXT_PUBLIC_SUPABASE_URL=... \
 *     node scripts/register-estimate-closing-agent.mjs --tenant-id=<uuid>
 *
 * Fails clearly and exits non-zero if:
 *   - --tenant-id is missing or not a syntactically valid UUID
 *   - NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is unset
 *
 * No production tenant id, Supabase secret, email address, or customer
 * identifier is embedded in this file — every credential and every tenant
 * id must be supplied by the operator at run time. This script was NOT
 * executed against production as part of this sprint.
 */

import { createClient } from "@supabase/supabase-js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseTenantId(argv) {
  const arg = argv.find((a) => a.startsWith("--tenant-id="));
  if (!arg) {
    return null;
  }
  return arg.slice("--tenant-id=".length).trim();
}

function fail(message) {
  console.error(`[register-estimate-closing-agent] ERROR: ${message}`);
  process.exit(1);
}

async function main() {
  const tenantId = parseTenantId(process.argv.slice(2));
  if (!tenantId) {
    fail("missing required --tenant-id=<uuid> argument. Refusing to guess a target tenant.");
  }
  if (!UUID_RE.test(tenantId)) {
    fail(`--tenant-id value does not look like a UUID: "${tenantId}"`);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    fail("NEXT_PUBLIC_SUPABASE_URL is not set in the environment. Refusing to run without explicit credentials.");
  }
  if (!serviceRoleKey) {
    fail("SUPABASE_SERVICE_ROLE_KEY is not set in the environment. Refusing to run without explicit credentials.");
  }

  console.log(`[register-estimate-closing-agent] target project: ${new URL(supabaseUrl).host}`);
  console.log(`[register-estimate-closing-agent] target tenant:  ${tenantId}`);
  console.log("[register-estimate-closing-agent] registering estimate_closing agent (status: inactive) — nothing else...");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Mirrors lib/agents/estimateClosing/registration.ts::ensureEstimateClosingAgent
  // field-for-field. Keep these two in sync if that function's fields ever
  // change.
  const insertRow = {
    tenant_id: tenantId,
    agent_type: "estimate_closing",
    name: "Estimate Closing Agent",
    purpose:
      "Analyzes stalled estimates (no reply since the automated Day 1/3/7 follow-up sequence completed) and produces a structured, privacy-safe recommendation in Shadow Mode. Cannot contact a customer, change lead/estimate state, or execute any tool.",
    status: "inactive",
    allowed_tools: [],
    read_scopes: ["leads", "estimate_followup_sequences"],
    write_scopes: [],
    approval_policy: {},
    model_policy: { reason: { complexity: "medium" } },
    system_instructions: null,
  };

  const insertResult = await supabase.from("agents").insert(insertRow).select("id, agent_type, status").single();

  if (!insertResult.error) {
    const row = insertResult.data;
    console.log("[register-estimate-closing-agent] created a new row:");
    console.log(JSON.stringify({ id: row.id, agentType: row.agent_type, status: row.status }, null, 2));
    return;
  }

  // 23505 = unique_violation — the row already exists for this tenant
  // (uq_agents_tenant_builtin_type). Idempotent: look it up and report it,
  // exactly like AgentStore.createIfAbsent's conflict-handling path.
  if (insertResult.error.code === "23505") {
    const existing = await supabase
      .from("agents")
      .select("id, agent_type, status")
      .eq("tenant_id", tenantId)
      .eq("agent_type", "estimate_closing")
      .maybeSingle();

    if (existing.error || !existing.data) {
      fail(`insert hit a unique-violation but the existing row could not be re-read: ${existing.error?.message ?? "not found"}`);
    }

    const row = existing.data;
    console.log("[register-estimate-closing-agent] already registered — idempotent no-op. Existing row:");
    console.log(JSON.stringify({ id: row.id, agentType: row.agent_type, status: row.status }, null, 2));
    return;
  }

  fail(`insert failed: ${insertResult.error.message}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
